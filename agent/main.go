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
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const version = "0.2.1"

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
	sshKeys  bool
	stateDir string
	secret   string
}

func main() {
	var (
		panel  = flag.String("panel", envOr("SONAR_PANEL", "http://127.0.0.1:8787"), "面板地址")
		nodeID = flag.String("id", envOr("SONAR_NODE_ID", ""), "节点 ID，需与面板登记一致")
		name   = flag.String("name", envOr("SONAR_NODE_NAME", ""), "面板上显示的名字，留空则用主机名")
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
		/*
		 * SSH 密钥的读和写是分开的两件事，所以是两个概念而不是一个开关：
		 *
		 *   读（上报实况）—— 一直开着，零风险，只读几个文件
		 *   写（增删 authorized_keys）—— 由 -ssh-keys 控制，**默认关闭**
		 *
		 * 不加这个参数时，面板下发的密钥指令只会打印不会执行，
		 * 和 -enforce 对封禁的关系完全一致。
		 */
		sshKeys = flag.Bool("ssh-keys", false, "允许面板远程增删 authorized_keys。不加这个参数时密钥指令只打印不执行")
		/*
		 * 每机密钥存 /var/lib 而不是 /etc。
		 *
		 * 它是机器自己生成的状态，不是人写的配置 —— 按 FHS 就该在 /var/lib。
		 * 更实际的理由是 systemd 的 ProtectSystem=strict 会让 /etc 只读，
		 * 而 StateDirectory= 正好为 /var/lib 这条路径准备了可写的开口。
		 */
		stateDir = flag.String("state-dir", envOr("SONAR_STATE_DIR", "/var/lib/sonar"), "存放每机密钥的目录")
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
		sshKeys:  *sshKeys,
		stateDir: *stateDir,
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
	ssh := &SSHApplier{Enable: cfg.sshKeys}

	if cfg.enforce {
		log.Printf("⚠️  enforce 已启用：封禁指令会真正写入 nftables")
	} else {
		log.Printf("dry-run 模式：封禁指令只会打印，加 -enforce 才会真正执行")
	}
	if cfg.sshKeys {
		log.Printf("⚠️  ssh-keys 已启用：面板可以远程增删本机的 authorized_keys")
	} else {
		log.Printf("SSH 密钥为只读：会上报实况，但面板下发的增删指令只打印，加 -ssh-keys 才执行")
	}
	if len(cfg.allow) > 0 {
		log.Printf("白名单：%s", strings.Join(cfg.allow, ", "))
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// 先读本地缓存的密钥，注册成功后会被换发的新值覆盖
	cfg.secret = loadSecret(cfg.stateDir)
	if err := register(ctx, &cfg, collector); err != nil {
		log.Printf("注册失败（将继续尝试上报）：%v", err)
	}

	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()

	/*
	 * 到期清理独立于上报节奏，也独立于面板。
	 *
	 * 面板挂了、网络断了、agent 与面板永久失联，临时授权照样按时失效 ——
	 * 和封禁把 TTL 交给 nftables 内核是同一个道理：绝不能出现
	 * "面板没了，临时权限变成永久"。
	 */
	pruner := time.NewTicker(10 * time.Minute)
	defer pruner.Stop()

	log.Printf("sonar-agent v%s 已启动，上报到 %s，间隔 %s", version, cfg.panel, cfg.interval)

	for {
		select {
		case <-ctx.Done():
			log.Println("收到退出信号，停止上报")
			return

		case <-pruner.C:
			if n := ssh.pruneExpired(); n > 0 {
				log.Printf("清理了 %d 条已过期的 SSH 授权", n)
			}

		case <-ticker.C:
			cmds, err := reportOnce(ctx, cfg, collector)
			if err != nil {
				// 上报失败不退出：面板重启、网络抖动都是常态，下一拍继续试
				log.Printf("上报失败：%v", err)
				continue
			}
			for _, cmd := range cmds {
				var res CommandResult
				switch cmd.Kind {
				case "ssh_grant", "ssh_revoke":
					res = ssh.Apply(cmd)
				default:
					res = fw.Apply(cmd)
				}
				log.Printf("指令 %s → skipped=%v ok=%v\n%s", cmd.Kind, res.Skipped, res.OK, res.Output)
				if err := ackCommand(ctx, cfg, res); err != nil {
					log.Printf("回执失败：%v", err)
				}
			}
		}
	}
}

// —————————————————————————————————————————————————————————
// 每机密钥
// —————————————————————————————————————————————————————————

/*
面板的 SONAR_AGENT_TOKEN 是全机队共享的，任何一台机器上都读得到。
在"只上报数据"的年代这不算致命，但通道能反向下发密钥变更之后，同一个 token
让任何一台被攻破的机器可以拉取别台机器的待办指令、甚至替它们发回执 ——
后者会让面板显示一个虚假的"已撤销"，而那把钥匙还在机器上。

所以注册时面板会换发一把只属于这台机器的密钥，落盘 0600，之后上报带上它。
拿不到密钥的 agent 一切照旧，只是收不到指令 —— 这道闸门让升级是自愿且可回滚的。
*/

func secretPath(dir string) string { return filepath.Join(dir, "agent.secret") }

func loadSecret(dir string) string {
	data, err := os.ReadFile(secretPath(dir))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func saveSecret(dir, secret string) {
	if secret == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("无法创建状态目录 %s：%v（下发通道将不可用）", dir, err)
		return
	}
	if err := os.WriteFile(secretPath(dir), []byte(secret), 0o600); err != nil {
		log.Printf("无法保存机器密钥：%v（下发通道将不可用）", err)
	}
}

// runOnce 打印一次采集结果，用来确认机器上的数据源是否可用。
func runOnce(collector Collector) {
	info, err := collector.Static()
	if err != nil {
		log.Fatalf("采集静态信息失败：%v", err)
	}
	/*
	 * 速率和归因都需要两次采样才有意义，这里先热身一拍。
	 *
	 * 窗口取 3 秒而不是 1 秒：归因报的是**两拍之间的增量**，窗口太短时
	 * 一台空闲机器很可能一个字节都没走，打出一片 0，看的人会以为归因坏了。
	 */
	if _, err := collector.Sample(); err != nil {
		log.Fatalf("采集失败：%v", err)
	}
	const window = 3 * time.Second
	time.Sleep(window)
	m, err := collector.Sample()
	if err != nil {
		log.Fatalf("采集失败：%v", err)
	}

	services := collector.Services()
	out, _ := json.MarshalIndent(map[string]any{
		"node":     info,
		"metric":   m,
		"services": services,
		"peers":    collector.Peers(),
	}, "", "  ")
	fmt.Println(string(out))

	fmt.Fprintf(os.Stderr, "\n注：services / peers 里的 rx、tx 是这 %s 内新增的流量，不是累计值。\n", window)
	if len(services) == 0 {
		fmt.Fprintln(os.Stderr, "服务与对端流量为空。先确认这两点，都满足的话就是这几秒里确实没有流量：")
		fmt.Fprintln(os.Stderr, "  1. sysctl -w net.netfilter.nf_conntrack_acct=1")
		fmt.Fprintln(os.Stderr, "  2. agent 以 root 运行（否则读不到其他进程的 /proc/<pid>/fd）")
	}
}

func register(ctx context.Context, cfg *config, collector Collector) error {
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

	var resp struct {
		Secret string `json:"secret"`
	}
	body := map[string]any{"token": cfg.token, "node": info}
	if err := postJSON(ctx, cfg.panel+"/api/agent/register", body, &resp); err != nil {
		return err
	}

	// 面板每次注册都换发一把新密钥，落盘后下一拍上报就能拿到指令了
	if resp.Secret != "" {
		cfg.secret = resp.Secret
		saveSecret(cfg.stateDir, resp.Secret)
	}
	return nil
}

// sshFactsInterval 控制多久采一次 SSH 实况。
//
// 不跟着每拍走：指标是 2 秒一次，而 authorized_keys 几天都不会变一次，
// 每拍都去遍历所有用户的家目录纯属浪费。一分钟一次对"删除前确认实况新鲜度"
// 已经足够（面板那边的过期阈值是 10 分钟）。
const sshFactsInterval = time.Minute

var lastSSHFacts time.Time

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
		Secret:   cfg.secret,
		Metric:   m,
		Services: collector.Services(),
		Peers:    collector.Peers(),
		// 告诉面板这批归因是增量，可以累加。见 Report.AttributionDelta
		AttributionDelta: true,
	}

	if time.Since(lastSSHFacts) >= sshFactsInterval {
		facts := collectSSHFacts()
		// 采不到就整块省略 —— 面板据此区分"没有钥匙"和"这个平台采不到"，
		// 后者绝不能显示成 0 把，那是最危险的误判
		if facts.SSHDVersion != "" || len(facts.Keys) > 0 || len(facts.HostKeys) > 0 {
			payload.SSH = &facts
		}
	}

	var resp struct {
		Commands []Command `json:"commands"`
	}
	if err := postJSON(ctx, cfg.panel+"/api/agent/report", payload, &resp); err != nil {
		// 这批归因增量留在队列里，跟下一拍并起来重发。
		// 清早了就是真丢数据 —— 增量不像累计值，下一拍补不回来。
		return nil, err
	}
	collector.CommitReported()

	// SSH 实况同理：上报成功了才推进计时，否则一次失败就要再等满一分钟
	if payload.SSH != nil {
		lastSSHFacts = time.Now()
	}
	return resp.Commands, nil
}

func ackCommand(ctx context.Context, cfg config, res CommandResult) error {
	return postJSON(ctx, cfg.panel+"/api/agent/ack", map[string]any{
		"nodeId": cfg.nodeID,
		"token":  cfg.token,
		"secret": cfg.secret,
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
