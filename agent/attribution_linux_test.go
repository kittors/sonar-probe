//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 真实 /proc/net/nf_conntrack 的样本。
// 每行有两组 src/dst/sport/dport/bytes：先原始方向，后回复方向。
const conntrackSample = `ipv4     2 tcp      6 431996 ESTABLISHED src=10.0.2.15 dst=104.16.132.229 sport=51234 dport=443 packets=42 bytes=5120 src=104.16.132.229 dst=10.0.2.15 sport=443 dport=51234 packets=88 bytes=204800 [ASSURED] mark=0 use=1
ipv4     2 tcp      6 299 ESTABLISHED src=45.129.14.207 dst=10.0.2.15 sport=59122 dport=22 packets=9 bytes=612 src=10.0.2.15 dst=45.129.14.207 sport=22 dport=59122 packets=7 bytes=1024 [ASSURED] mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=10.0.2.15 dst=104.16.132.229 sport=51999 dport=443 packets=10 bytes=1024 src=104.16.132.229 dst=10.0.2.15 sport=443 dport=51999 packets=20 bytes=51200 [ASSURED] mark=0 use=1
ipv4     2 udp      17 29 src=10.0.2.15 dst=119.29.29.29 sport=41234 dport=53 packets=2 bytes=140 src=119.29.29.29 dst=10.0.2.15 sport=53 dport=41234 packets=2 bytes=260 mark=0 use=1
ipv4     2 tcp      6 120 SYN_SENT src=10.0.2.15 dst=1.2.3.4 sport=52000 dport=8080 packets=1 bytes=60 [UNREPLIED] src=1.2.3.4 dst=10.0.2.15 sport=8080 dport=52000 packets=0 bytes=0 mark=0 use=1
ipv4     2 tcp      6 431900 ESTABLISHED src=172.20.1.5 dst=172.20.1.9 sport=40000 dport=5432 packets=3 bytes=300 src=172.20.1.9 dst=172.20.1.5 sport=5432 dport=40000 packets=3 bytes=400 mark=0 use=1
`

func writeSample(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "nf_conntrack")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatalf("写样本失败: %v", err)
	}
	return p
}

func TestReadConntrackDirection(t *testing.T) {
	local := map[string]bool{"10.0.2.15": true}
	flows := readConntrackFrom(writeSample(t, conntrackSample), local)

	// 6 行里应该保留 5 条，只丢掉最后那条 172.20.1.5 → 172.20.1.9 ——
	// 两端都不是本机，属于经过本机的转发流量，不该记到自己账上。
	//
	// 那条 SYN_SENT/UNREPLIED 是保留的：它只有 60 字节的 SYN 包，量小，
	// 但大量未回应连接正是端口扫描和爆破的特征，丢掉反而看不见攻击。
	if len(flows) != 5 {
		t.Fatalf("期望 5 条流，实际 %d 条: %+v", len(flows), flows)
	}

	// 出站连接：本机是 src，原始方向的字节数算作 tx
	out := flows[0]
	if out.peerIP != "104.16.132.229" {
		t.Errorf("对端应为 104.16.132.229，实际 %s", out.peerIP)
	}
	if out.localPort != 51234 {
		t.Errorf("本地端口应为 51234，实际 %d", out.localPort)
	}
	if out.tx != 5120 || out.rx != 204800 {
		t.Errorf("出站方向搞反了：tx=%d rx=%d，期望 tx=5120 rx=204800", out.tx, out.rx)
	}

	// 入站连接：本机是 dst，原始方向的字节数算作 rx
	in := flows[1]
	if in.peerIP != "45.129.14.207" {
		t.Errorf("对端应为 45.129.14.207，实际 %s", in.peerIP)
	}
	if in.localPort != 22 {
		t.Errorf("入站应取 dport 作为本地端口，期望 22，实际 %d", in.localPort)
	}
	if in.rx != 612 || in.tx != 1024 {
		t.Errorf("入站方向搞反了：rx=%d tx=%d，期望 rx=612 tx=1024", in.rx, in.tx)
	}
}

func TestReadConntrackSkipsUnaccounted(t *testing.T) {
	// 没开 nf_conntrack_acct 时所有 bytes 都是 0，这类条目必须全部丢弃，
	// 否则面板上会出现一堆"有连接但零流量"的噪声。
	const zeroed = `ipv4     2 tcp      6 431999 ESTABLISHED src=10.0.2.15 dst=8.8.8.8 sport=51234 dport=443 packets=0 bytes=0 src=8.8.8.8 dst=10.0.2.15 sport=443 dport=51234 packets=0 bytes=0 mark=0 use=1
`
	flows := readConntrackFrom(writeSample(t, zeroed), map[string]bool{"10.0.2.15": true})
	if len(flows) != 0 {
		t.Fatalf("零字节条目应被丢弃，实际保留了 %d 条", len(flows))
	}
}

func TestReadConntrackMissingFile(t *testing.T) {
	// 内核没加载 nf_conntrack 时文件不存在，必须安静返回空而不是 panic
	flows := readConntrackFrom("/nonexistent/nf_conntrack", map[string]bool{})
	if flows != nil {
		t.Fatalf("文件不存在时应返回 nil，实际 %+v", flows)
	}
}

func TestIsPartition(t *testing.T) {
	cases := map[string]bool{
		"sda":       false,
		"sda1":      true,
		"vda":       false,
		"vda2":      true,
		"nvme0n1":   false,
		"nvme0n1p1": true,
		"xvda":      false,
	}
	for name, want := range cases {
		if got := isPartition(name); got != want {
			t.Errorf("isPartition(%q) = %v，期望 %v", name, got, want)
		}
	}
}

func TestSaturatingSub(t *testing.T) {
	// 计数器回绕时不能算出天文数字
	if got := saturatingSub(5, 10); got != 0 {
		t.Errorf("回绕时应返回 0，实际 %d", got)
	}
	if got := saturatingSub(10, 4); got != 6 {
		t.Errorf("正常差值应为 6，实际 %d", got)
	}
}
