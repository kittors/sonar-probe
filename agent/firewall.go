package main

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"strings"
	"time"
)

/*
封禁执行

两条硬规则：

1. **不执行面板下发的命令字符串。** 面板给的 Commands 只用于展示和审计，
   agent 拿到 target 和 ttl 后自己重新构造 exec 参数。否则面板一旦被攻破，
   下发一条 "nft ...; rm -rf /" 就直接在所有机器上执行了。

2. **agent 自己再跑一遍守卫检查。** 面板已经检查过一次，这里再检查一次是纵深防御 ——
   两边独立判断，任何一边认为危险就不执行。
*/

const (
	nftTable = "sonar"
	setV4    = "blocklist4"
	setV6    = "blocklist6"
)

// 无论面板说什么都不会封的网段。和面板侧那份保持一致。
var hardGuards = []string{
	"127.0.0.0/8",
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"169.254.0.0/16",
	"100.64.0.0/10",
	"0.0.0.0/8",
	"224.0.0.0/4",
}

// guardTarget 返回拒绝执行的理由；返回空串表示可以执行。
func guardTarget(target string, extraAllow []string) string {
	ip, ipnet, err := parseTarget(target)
	if err != nil {
		return fmt.Sprintf("目标 %q 解析失败: %v", target, err)
	}

	// 网段太宽就拒绝。/24 是个经验值：够覆盖一个 C 段，又不至于一条规则打掉整个 ASN。
	if ipnet != nil {
		ones, bits := ipnet.Mask.Size()
		if bits == 32 && ones < 24 {
			return fmt.Sprintf("/%d 覆盖范围过大，超出 /24 的安全上限", ones)
		}
		if bits == 128 && ones < 48 {
			return fmt.Sprintf("/%d 覆盖范围过大，超出 /48 的安全上限", ones)
		}
	}

	for _, g := range hardGuards {
		_, gnet, err := net.ParseCIDR(g)
		if err != nil || gnet == nil {
			continue
		}
		if ip != nil && gnet.Contains(ip) {
			return fmt.Sprintf("命中保留网段 %s", g)
		}
	}

	// 本机地址：封了自己等于把自己关在门外
	if ip != nil && localAddressSet()[ip.String()] {
		return "这是本机地址"
	}

	for _, a := range extraAllow {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if a == target {
			return fmt.Sprintf("命中白名单 %s", a)
		}
		if _, anet, err := net.ParseCIDR(a); err == nil && anet != nil && ip != nil && anet.Contains(ip) {
			return fmt.Sprintf("命中白名单 %s", a)
		}
	}

	return ""
}

func parseTarget(target string) (net.IP, *net.IPNet, error) {
	if strings.Contains(target, "/") {
		ip, ipnet, err := net.ParseCIDR(target)
		return ip, ipnet, err
	}
	ip := net.ParseIP(target)
	if ip == nil {
		return nil, nil, fmt.Errorf("不是合法 IP")
	}
	return ip, nil, nil
}

func localAddressSet() map[string]bool {
	set := map[string]bool{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return set
	}
	for _, iface := range ifaces {
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok {
				set[ipnet.IP.String()] = true
			}
		}
	}
	return set
}

// Firewall 负责把封禁意图落成 nftables 规则。
type Firewall struct {
	// Enforce 为 false 时只打印将要执行的命令，不真的改防火墙。默认 false。
	Enforce bool
	// Allowlist 是额外的保护名单，来自 -allow 参数。
	Allowlist []string

	bootstrapped bool
}

// nftArgs 构造 nft 的参数切片。注意是分好词的参数，不经过 shell，
// 所以 target 里就算带了分号引号也只是一个普通字符串。
func (f *Firewall) bootstrapArgs() [][]string {
	return [][]string{
		{"add", "table", "inet", nftTable},
		{"add", "set", "inet", nftTable, setV4, "{", "type", "ipv4_addr;", "flags", "interval,timeout;", "}"},
		{"add", "set", "inet", nftTable, setV6, "{", "type", "ipv6_addr;", "flags", "interval,timeout;", "}"},
		{"add", "chain", "inet", nftTable, "input", "{", "type", "filter", "hook", "input", "priority", "-10;", "policy", "accept;", "}"},
		{"add", "rule", "inet", nftTable, "input", "ip", "saddr", "@" + setV4, "counter", "drop"},
		{"add", "rule", "inet", nftTable, "input", "ip6", "saddr", "@" + setV6, "counter", "drop"},
	}
}

func setNameFor(target string) string {
	if strings.Contains(target, ":") {
		return setV6
	}
	return setV4
}

// Apply 执行一条面板指令。
func (f *Firewall) Apply(cmd Command) CommandResult {
	res := CommandResult{ID: cmd.ID}

	if why := guardTarget(cmd.Target, f.Allowlist); why != "" {
		res.Skipped = true
		res.Output = "agent 拒绝执行：" + why
		return res
	}

	// 面板说是 dry-run，或者 agent 没开 enforce —— 任一为真就只打印
	if cmd.Mode != "enforced" || !f.Enforce {
		res.Skipped = true
		reason := "面板下发的是 dry-run"
		if f.Enforce && cmd.Mode == "enforced" {
			reason = ""
		}
		if !f.Enforce {
			reason = "agent 未启用 -enforce"
		}
		res.Output = fmt.Sprintf("dry-run（%s），将执行：\n%s", reason, strings.Join(f.preview(cmd), "\n"))
		return res
	}

	var outputs []string
	if !f.bootstrapped {
		for _, args := range f.bootstrapArgs() {
			// 表/集合/链可能已经存在，重复创建报错是正常的，不当失败处理
			out, _ := runNft(args)
			if out != "" {
				outputs = append(outputs, out)
			}
		}
		f.bootstrapped = true
	}

	args := f.actionArgs(cmd)
	out, err := runNft(args)
	if err != nil {
		res.OK = false
		res.Output = fmt.Sprintf("nft %s 失败: %v %s", strings.Join(args, " "), err, out)
		return res
	}

	res.OK = true
	res.Output = fmt.Sprintf("已执行 nft %s", strings.Join(args, " "))
	if len(outputs) > 0 {
		res.Output += "\n" + strings.Join(outputs, "\n")
	}
	return res
}

func (f *Firewall) actionArgs(cmd Command) []string {
	set := setNameFor(cmd.Target)
	elem := cmd.Target
	if cmd.Kind == "unblock" {
		return []string{"delete", "element", "inet", nftTable, set, "{", elem, "}"}
	}
	if cmd.TTL > 0 {
		// TTL 交给内核：面板挂了、网络断了，到点照样自动解封
		return []string{"add", "element", "inet", nftTable, set, "{", elem, "timeout", fmt.Sprintf("%ds", cmd.TTL), "}"}
	}
	return []string{"add", "element", "inet", nftTable, set, "{", elem, "}"}
}

func (f *Firewall) preview(cmd Command) []string {
	lines := make([]string, 0, 7)
	if !f.bootstrapped {
		for _, args := range f.bootstrapArgs() {
			lines = append(lines, "nft "+strings.Join(args, " "))
		}
	}
	lines = append(lines, "nft "+strings.Join(f.actionArgs(cmd), " "))
	return lines
}

func runNft(args []string) (string, error) {
	// 加超时：nft 在极端情况下会卡住，不能让采集主循环跟着一起卡死
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "nft", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}
