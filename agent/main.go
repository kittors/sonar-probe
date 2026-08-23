package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const version = "0.1.0"

type config struct {
	panel    string
	nodeID   string
	name     string
	country  string
	region   string
	provider string
	tags     []string
	token    string
	interval time.Duration
	enforce  bool
	allow    []string
	once     bool
}

func main() {
	var (
		panel    = flag.String("panel", envOr("SONAR_PANEL", "http://127.0.0.1:8787"), "面板地址")
		nodeID   = flag.String("id", envOr("SONAR_NODE_ID", ""), "节点 ID，需与面板登记一致")
		name     = flag.String("name", envOr("SONAR_NODE_NAME", ""), "面板上显示的名字，留空则用主机名")
		// 这几项采集不到 —— 机房位置和厂商是账务信息，机器自己并不知道
		country  = flag.String("country", envOr("SONAR_NODE_COUNTRY", ""), "两位国家代码，如 HK")
		region   = flag.String("region", envOr("SONAR_NODE_REGION", ""), "地区名，如 Hong Kong")
		provider = flag.String("provider", envOr("SONAR_NODE_PROVIDER", ""), "服务商名")
		tags     = flag.String("tags", envOr("SONAR_NODE_TAGS", ""), "标签，逗号分隔")
		token    = flag.String("token", envOr("SONAR_TOKEN", ""), "上报鉴权 token")
		interval = flag.Duration("interval", 2*time.Second, "采集与上报间隔")
		enforce  = flag.Bool("enforce", false, "允许真正修改防火墙。不加这个参数时封禁指令只会打印不会执行")
		allow    = flag.String("allow", envOr("SONAR_ALLOWLIST", ""), "额外的免封白名单，逗号分隔，支持 CIDR")
		once     = flag.Bool("once", false, "只采集一次并打印结果，用于排查采集是否正常")
	)
	flag.Parse()

	cfg := config{
		panel:    strings.TrimRight(*panel, "/"),
		nodeID:   *nodeID,
		name:     *name,
		country:  *country,
		region:   *region,
		provider: *provider,
		tags:     splitCSV(*tags),
		token:    *token,
		interval: *interval,
		enforce:  *enforce,
		allow:    splitCSV(*allow),
		once:     *once,
	}

	collector := newCollector()

	if cfg.once {
		runOnce(collector)
		return
	}

	if cfg.nodeID == "" {
		log.Fatal("必须用 -id 指定节点 ID（或设置 SONAR_NODE_ID）")
	}

	fw := &Firewall{Enforce: cfg.enforce, Allowlist: cfg.allow}

	if cfg.enforce {
		log.Printf("⚠️  enforce 已启用：封禁指令会真正写入 nftables")
	} else {
		log.Printf("dry-run 模式：封禁指令只会打印，加 -enforce 才会真正执行")
	}
	if len(cfg.allow) > 0 {
		log.Printf("白名单：%s", strings.Join(cfg.allow, ", "))
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := register(ctx, cfg, collector); err != nil {
		log.Printf("注册失败（将继续尝试上报）：%v", err)
	}

	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()

	log.Printf("sonar-agent v%s 已启动，上报到 %s，间隔 %s", version, cfg.panel, cfg.interval)

	for {
		select {
		case <-ctx.Done():
			log.Println("收到退出信号，停止上报")
			return
		case <-ticker.C:
			cmds, err := reportOnce(ctx, cfg, collector)
			if err != nil {
				// 上报失败不退出：面板重启、网络抖动都是常态，下一拍继续试
				log.Printf("上报失败：%v", err)
				continue
			}
			for _, cmd := range cmds {
				res := fw.Apply(cmd)
				log.Printf("指令 %s(%s) → skipped=%v ok=%v\n%s", cmd.Kind, cmd.Target, res.Skipped, res.OK, res.Output)
				if err := ackCommand(ctx, cfg, res); err != nil {
					log.Printf("回执失败：%v", err)
				}
			}
		}
	}
}

// runOnce 打印一次采集结果，用来确认机器上的数据源是否可用。
func runOnce(collector Collector) {
	info, err := collector.Static()
	if err != nil {
		log.Fatalf("采集静态信息失败：%v", err)
	}
	// 速率类指标需要两次采样才有意义，这里先热身一拍
	if _, err := collector.Sample(); err != nil {
		log.Fatalf("采集失败：%v", err)
	}
	time.Sleep(time.Second)
	m, err := collector.Sample()
	if err != nil {
		log.Fatalf("采集失败：%v", err)
	}

	out, _ := json.MarshalIndent(map[string]any{
		"node":     info,
		"metric":   m,
		"services": collector.Services(),
		"peers":    collector.Peers(),
	}, "", "  ")
	fmt.Println(string(out))

	if len(collector.Services()) == 0 {
		fmt.Fprintln(os.Stderr, "\n提示：服务与对端流量为空。请确认以下两点：")
		fmt.Fprintln(os.Stderr, "  1. sysctl -w net.netfilter.nf_conntrack_acct=1")
		fmt.Fprintln(os.Stderr, "  2. agent 以 root 运行（否则读不到其他进程的 /proc/<pid>/fd）")
	}
}

func register(ctx context.Context, cfg config, collector Collector) error {
	info, err := collector.Static()
	if err != nil {
		return err
	}
	info.ID = cfg.nodeID
	// 主机名往往是云厂商生成的一串乱码（ecsKYgx 之类），面板上不好认
	if cfg.name != "" {
		info.Name = cfg.name
	}
	info.CountryCode = cfg.country
	info.Region = cfg.region
	info.Provider = cfg.provider
	if len(cfg.tags) > 0 {
		info.Tags = cfg.tags
	}
	body := map[string]any{"token": cfg.token, "node": info}
	return postJSON(ctx, cfg.panel+"/api/agent/register", body, nil)
}

// reportOnce 上报一拍，返回面板下发的待执行指令。
func reportOnce(ctx context.Context, cfg config, collector Collector) ([]Command, error) {
	m, err := collector.Sample()
	if err != nil {
		return nil, err
	}
	m.NodeID = cfg.nodeID

	payload := Report{
		NodeID:   cfg.nodeID,
		Token:    cfg.token,
		Metric:   m,
		Services: collector.Services(),
		Peers:    collector.Peers(),
	}

	var resp struct {
		Commands []Command `json:"commands"`
	}
	if err := postJSON(ctx, cfg.panel+"/api/agent/report", payload, &resp); err != nil {
		return nil, err
	}
	return resp.Commands, nil
}

func ackCommand(ctx context.Context, cfg config, res CommandResult) error {
	return postJSON(ctx, cfg.panel+"/api/agent/ack", map[string]any{
		"nodeId": cfg.nodeID,
		"token":  cfg.token,
		"result": res,
	}, nil)
}

var httpClient = &http.Client{Timeout: 10 * time.Second}

func postJSON(ctx context.Context, url string, body any, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		var msg struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&msg)
		if msg.Error != "" {
			return fmt.Errorf("%s: %s", resp.Status, msg.Error)
		}
		return fmt.Errorf("%s", resp.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func splitCSV(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
