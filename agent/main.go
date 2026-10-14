package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	removed := false
	if err := register(ctx, &cfg, collector); err != nil {
		if isRemoved(err) {
			removed = true
			noteRemoved(err)
		} else {
			log.Printf("注册失败（将继续尝试上报）：%v", err)
		}
	}

	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()

	/*
	 * 被面板删除之后的复查。
	 *
	 * 删除不等于卸载：面板删了这台机器，机器上的 agent 并不知道，它会继续两秒一次
	 * 地上报、一次次被拒，日志一天攒下四万多行同一句话。收到 410 之后停掉上报，
	 * 改成隔一阵问一次面板"我能回来了吗" —— 有人在面板上允许它重新接入，
	 * 它就自己恢复，不用登上机器重启。
	 */
	recheck := time.NewTicker(removedRecheck)
	defer recheck.Stop()

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

		// 被删除之后也照常清理：临时授权按时失效这件事不能依赖面板还认不认这台机器
		case <-pruner.C:
			if n := ssh.pruneExpired(); n > 0 {
				log.Printf("清理了 %d 条已过期的 SSH 授权", n)
			}

		case <-recheck.C:
			if !removed {
				continue
			}
			if err := register(ctx, &cfg, collector); err != nil {
				if !isRemoved(err) {
					log.Printf("复查能否重新接入失败：%v", err)
				}
				continue
			}
			removed = false
			/*
			 * 休眠期间攒下的归因增量不能补报。
			 *
			 * 面板那边这台机器是从零开始的，账本的第一拍不计增量；归因却一次带上
			 * 几天的量，两边就永远对不上了。先采一拍推进基线，再把积压整个丢掉。
			 */
			if _, err := collector.Sample(); err == nil {
				collector.CommitReported()
			}
			log.Printf("面板已允许这台机器重新接入，恢复上报")

		case <-ticker.C:
			if removed {
				continue
			}
			cmds, err := reportOnce(ctx, cfg, collector)
			if err != nil {
				if isRemoved(err) {
					removed = true
					noteRemoved(err)
					continue
				}
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

// removedRecheck 是被面板删除之后，多久问一次"能不能回来了"。
//
// 被删的机器多半就不回来了，问得勤只是给面板添噪音；而真被误删、
// 在面板上点了"允许重新接入"的人，等十分钟也能接受。
const removedRecheck = 10 * time.Minute

// noteRemoved 只在状态切换时打一次。被删的机器上这句话每两秒刷一遍，
// 就是一天四万多行 —— 而真正有用的信息只有第一行。
func noteRemoved(err error) {
	log.Printf("面板拒绝了这台机器，停止上报，之后每 %s复查一次能否重新接入。面板的说明：%v",
		spokenDuration(removedRecheck), err)
}

// spokenDuration 把间隔说成人话。不整分钟的按秒说 —— 按分钟取整的话，
// 90 秒会被说成"每 1 分钟"，15 秒会被说成"每 0 分钟"。
func spokenDuration(d time.Duration) string {
	if d >= time.Minute && d%time.Minute == 0 {
		return fmt.Sprintf(" %d 分钟", int(d/time.Minute))
	}
	return fmt.Sprintf(" %d 秒", int(d/time.Second))
}

// httpError 是面板回的非 2xx。留着状态码，调用方才分得清"等等再试"和"别再来了"。
type httpError struct {
	code   int
	status string
	msg    string
}

func (e *httpError) Error() string {
	if e.msg != "" {
		return fmt.Sprintf("%s: %s", e.status, e.msg)
	}
	return e.status
}

// isRemoved 判断面板是不是在说"这台机器已经被删了"。
//
// 只认 410：400、401、5xx 都可能是一时的（token 配错了正在改、面板在重启），
// 把它们当成被删会让 agent 进入十分钟一次的慢节奏，白白丢掉一段数据。
func isRemoved(err error) bool {
	var he *httpError
	return errors.As(err, &he) && he.code == http.StatusGone
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
		return &httpError{code: resp.StatusCode, status: resp.Status, msg: msg.Error}
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
