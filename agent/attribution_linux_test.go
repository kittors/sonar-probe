//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
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

// —————————————————————————————————————————————————————————
// 流级差分
//
// 这组测试守着面板上"流量都被谁吃了"的正确性。改坏了不会报错，
// 只会让那张排行榜安静地少算 —— 上线前实测过一次：覆盖率只有真实流量的 4%。
// —————————————————————————————————————————————————————————

func flowsAt(rx, tx uint64) []ctFlow {
	return []ctFlow{{key: "tcp|a:1>b:2", localPort: 1, peerIP: "b", rx: rx, tx: tx}}
}

func TestFlowTrackerPrimesWithoutEmitting(t *testing.T) {
	tr := newFlowTracker()

	// 第一拍只建基线。conntrack 里的连接可能已经跑了几小时，
	// 把那份历史累计量当成增量，agent 每次重启都会凭空多报一大笔。
	if got := tr.delta(flowsAt(1_000_000, 2_000_000)); len(got) != 0 {
		t.Fatalf("首拍应只建基线，实际产出了 %d 条: %+v", len(got), got)
	}

	got := tr.delta(flowsAt(1_000_500, 2_000_300))
	if len(got) != 1 {
		t.Fatalf("第二拍应产出 1 条增量，实际 %d 条", len(got))
	}
	if got[0].rx != 500 || got[0].tx != 300 {
		t.Errorf("增量应为 rx=500 tx=300，实际 rx=%d tx=%d", got[0].rx, got[0].tx)
	}
}

func TestFlowTrackerCountsNewFlowInFull(t *testing.T) {
	tr := newFlowTracker()
	tr.delta(nil) // 建基线

	// 基线之后才出现的连接，它的累计值整个都是这段时间新增的
	got := tr.delta(flowsAt(4096, 8192))
	if len(got) != 1 || got[0].rx != 4096 || got[0].tx != 8192 {
		t.Fatalf("新流应全量计入，实际 %+v", got)
	}
}

func TestFlowTrackerHandlesPortReuse(t *testing.T) {
	tr := newFlowTracker()
	tr.delta(flowsAt(900_000, 900_000))

	// 计数器往回走，说明这个四元组已经被复用成另一条连接。
	// 记 0 会把新连接走过的量整个吞掉，全量计入才接近事实。
	got := tr.delta(flowsAt(1500, 700))
	if len(got) != 1 || got[0].rx != 1500 || got[0].tx != 700 {
		t.Fatalf("端口复用应按新连接全量计入，实际 %+v", got)
	}
}

func TestFlowTrackerSurvivesConntrackReadGap(t *testing.T) {
	/*
	 * 这条守着整个归因最贵的一个坑。
	 *
	 * /proc/net/nf_conntrack 是 seq_file，遍历过程中表被并发增删就会漏读条目 ——
	 * 一条挂着的长连接会在某一拍"消失"、下一拍又"出现"。没有宽限期的话，
	 * 重现时它不在跟踪表里，就被当成新流把累计量整个再计一遍。
	 *
	 * 实测一台中转机：3 秒一拍时归因是真实流量的 35 倍，其中 96% 来自这个。
	 */
	tr := newFlowTracker()
	tr.delta(flowsAt(1_000_000, 1_000_000)) // 建基线
	tr.delta(flowsAt(1_000_100, 1_000_100)) // 正常增长

	tr.delta(nil) // 这一拍被漏读了

	got := tr.delta(flowsAt(1_000_300, 1_000_300))
	if len(got) != 1 {
		t.Fatalf("重现的流应产出增量，实际 %d 条", len(got))
	}
	if got[0].rx != 200 || got[0].tx != 200 {
		t.Errorf(
			"漏读一拍之后应接着上次的基线算（期望 200/200），实际 rx=%d tx=%d —— "+
				"把累计值当成增量报上去，一条 1 GB 的长连接每漏读一次就多算 1 GB",
			got[0].rx, got[0].tx,
		)
	}
}

func TestFlowTrackerForgetsAfterGracePeriod(t *testing.T) {
	tr := newFlowTracker()
	tr.delta(flowsAt(100, 100))

	// 宽限期是为了扛漏读，不是永久记忆 —— 否则跟踪表只增不减
	for i := 0; i < flowForgetTicks+2; i++ {
		tr.delta(nil)
	}
	if len(tr.seen) != 0 {
		t.Errorf("超过宽限期的流该被忘掉，实际还留着 %d 条", len(tr.seen))
	}

	// 忘掉之后同一个四元组就是一条全新的连接了
	got := tr.delta(flowsAt(60, 40))
	if len(got) != 1 || got[0].rx != 60 || got[0].tx != 40 {
		t.Fatalf("重现的四元组应按新连接计入，实际 %+v", got)
	}
}

func TestReadConntrackSkipsLoopback(t *testing.T) {
	/*
	 * 两端都是本机的连接一个字节都没过物理网卡，而 readNetTotals 跳过了 lo。
	 * 计进归因的话，一台把 nginx 反代到本地端口的机器会把同一份数据记两遍，
	 * 「谁吃了流量」的总和就会超过实际流量。
	 */
	const sample = `ipv4     2 tcp      6 431999 ESTABLISHED src=127.0.0.1 dst=127.0.0.1 sport=59944 dport=7444 packets=10 bytes=8192 src=127.0.0.1 dst=127.0.0.1 sport=7444 dport=59944 packets=10 bytes=4096 mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=10.0.2.15 dst=10.0.2.15 sport=40000 dport=8080 packets=3 bytes=300 src=10.0.2.15 dst=10.0.2.15 sport=8080 dport=40000 packets=3 bytes=400 mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=10.0.2.15 dst=1.2.3.4 sport=51234 dport=443 packets=42 bytes=5120 src=1.2.3.4 dst=10.0.2.15 sport=443 dport=51234 packets=88 bytes=204800 mark=0 use=1
`
	local := map[string]bool{"127.0.0.1": true, "10.0.2.15": true}
	flows := readConntrackFrom(writeSample(t, sample), local)

	if len(flows) != 1 {
		t.Fatalf("只该留下那条真正出网的连接，实际 %d 条: %+v", len(flows), flows)
	}
	if flows[0].peerIP != "1.2.3.4" {
		t.Errorf("留下的应该是出网那条，实际对端 %s", flows[0].peerIP)
	}
}

func TestFlowTrackerSkipsIdleFlows(t *testing.T) {
	tr := newFlowTracker()
	tr.delta(flowsAt(5000, 5000))

	// 这一拍一个字节都没走的连接不必上报，否则排行榜里全是 0
	if got := tr.delta(flowsAt(5000, 5000)); len(got) != 0 {
		t.Fatalf("无增量的流不该产出，实际 %+v", got)
	}
	// 但基线要留着，下一拍才减得对
	if len(tr.seen) != 1 {
		t.Errorf("无增量不代表流消失了，跟踪表应保留，实际 %d 条", len(tr.seen))
	}
}

func TestFlowTrackerCapsMemory(t *testing.T) {
	tr := newFlowTracker()
	tr.delta(nil)

	over := make([]ctFlow, maxTrackedFlows+500)
	for i := range over {
		over[i] = ctFlow{key: "tcp|a:" + strconv.Itoa(i) + ">b:2", rx: 10, tx: 10}
	}
	got := tr.delta(over)

	// 超出上限的流既不跟踪也不计入 —— 宁可少算，也不能把某条流的
	// 历史累计量当成增量报上去
	if len(tr.seen) > maxTrackedFlows {
		t.Errorf("跟踪表应封顶在 %d，实际 %d", maxTrackedFlows, len(tr.seen))
	}
	if len(got) > maxTrackedFlows {
		t.Errorf("产出也应封顶在 %d，实际 %d", maxTrackedFlows, len(got))
	}
}

func TestFlowKeyDistinguishesDirection(t *testing.T) {
	// 键必须取原始方向。用"本地端口 + 对端"当键的话，同一台机器上
	// 一进一出两条连接会撞成一条，其中一条的流量就被另一条吃掉了。
	a := flowKey("tcp", "10.0.0.1", 5000, "1.2.3.4", 443)
	b := flowKey("tcp", "1.2.3.4", 443, "10.0.0.1", 5000)
	if a == b {
		t.Errorf("两个方向的键不该相同：%q", a)
	}
	// 协议也要进键：TCP 和 UDP 用同一个四元组是合法的
	if flowKey("tcp", "a", 1, "b", 2) == flowKey("udp", "a", 1, "b", 2) {
		t.Error("TCP 和 UDP 的同一四元组不该撞键")
	}
}

func TestProtocolOf(t *testing.T) {
	cases := map[string]string{
		"ipv4     2 tcp      6 431999 ESTABLISHED src=a": "tcp",
		"ipv4     2 udp      17 29 src=a":                "udp",
		// 有的内核不输出 L3 前缀，不能按下标取
		"tcp      6 120 SYN_SENT src=a": "tcp",
		// 认不出协议也不该丢流，四元组本身还区分得开
		"weird 1 2 src=a": "?",
	}
	for line, want := range cases {
		if got := protocolOf(strings.Fields(line)); got != want {
			t.Errorf("protocolOf(%q) = %q，期望 %q", line, got, want)
		}
	}
}

func TestMergeInts(t *testing.T) {
	// 攒批时端口要取并集：一次采样只看得见当时活跃的那几个，
	// 直接覆盖会让界面上的端口列表随每拍跳动
	got := mergeInts([]int{443, 80}, []int{80, 8080}, 8)
	if len(got) != 3 || got[0] != 80 || got[1] != 443 || got[2] != 8080 {
		t.Errorf("并集应为 [80 443 8080]，实际 %v", got)
	}
	if len(mergeInts([]int{1, 2, 3}, []int{4, 5, 6}, 4)) != 4 {
		t.Error("应截到 limit 个")
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
