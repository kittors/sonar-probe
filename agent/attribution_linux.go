//go:build linux

package main

import (
	"bufio"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

/*
流量归因

Linux 没有现成的"每进程用了多少流量"接口，这里靠三张表拼出来：

  /proc/net/nf_conntrack   每条连接的双向字节数（需要开 nf_conntrack_acct）
  /proc/net/{tcp,udp}*     本地端口 → socket inode
  /proc/<pid>/fd/*         socket inode → 进程

把 conntrack 里的本地端口顺着 inode 找到进程，就得到了进程级流量；
按对端地址聚合，就得到了 IP 级流量。两者是同一份数据的两个视角，总量相等。

前置条件：
  sysctl -w net.netfilter.nf_conntrack_acct=1     # 否则 bytes 恒为 0
  agent 需要 root 才能读其他进程的 /proc/<pid>/fd
两个条件任一不满足时返回空结果，不影响基础指标采集。
*/

type ctFlow struct {
	localPort int
	peerIP    string
	peerPort  int
	rx        uint64 // 本机收到
	tx        uint64 // 本机发出
}

/*
端口 → 进程的短期缓存

conntrack 会在连接关闭后继续保留条目一段时间（TCP 默认 120 秒），
但那时 /proc/net/tcp 里的 socket 早没了，顺着 inode 也就找不到进程 ——
这部分流量只能记成 unknown。实测一台机器上 393 条 conntrack 里
有近 180 条属于这种"连接已关闭但还没过期"的状态。

所以把见过的映射留一会儿：连接关掉了，它的归属仍然查得到。
TTL 取 5 分钟，比 conntrack 的超时宽裕，又不至于让端口复用后张冠李戴。
*/
type cachedProc struct {
	ref  procRef
	seen time.Time
}

const portCacheTTL = 5 * time.Minute

// 归属查不到时用的统一名字。前后端都认这个值，别改。
const closedConnLabel = "已结束的连接"

var portCache = map[int]cachedProc{}

func rememberPorts(live map[int]procRef) {
	now := time.Now()
	for port, ref := range live {
		portCache[port] = cachedProc{ref: ref, seen: now}
	}
	for port, c := range portCache {
		if now.Sub(c.seen) > portCacheTTL {
			delete(portCache, port)
		}
	}
}

// lookupPort 先查当前活跃的 socket，查不到再回退到缓存。
func lookupPort(live map[int]procRef, port int) (procRef, bool) {
	if r, ok := live[port]; ok {
		return r, true
	}
	if c, ok := portCache[port]; ok && time.Since(c.seen) <= portCacheTTL {
		return c.ref, true
	}
	return procRef{}, false
}

func collectAttribution() ([]ServiceTraffic, []PeerTraffic) {
	flows := readConntrack()
	if len(flows) == 0 {
		return nil, nil
	}

	portToProcess := mapPortsToProcesses()
	rememberPorts(portToProcess)

	type svcAgg struct {
		rx, tx uint64
		conns  int
		ports  map[int]struct{}
		pids   map[int]struct{}
	}
	type peerAgg struct {
		rx, tx uint64
		conns  int
		ports  map[int]struct{}
	}

	services := map[string]*svcAgg{}
	peers := map[string]*peerAgg{}

	for _, f := range flows {
		// —— 服务视角
		// 查不到进程说明连接已经关闭了。
		// 名字里不塞状态（"(已结束的连接)" 这种），状态由 category 表达，
		// 前端才好用标签把它和真实服务区分开。
		name := closedConnLabel
		pid := 0
		if p, ok := lookupPort(portToProcess, f.localPort); ok {
			name, pid = p.name, p.pid
		}
		s := services[name]
		if s == nil {
			s = &svcAgg{ports: map[int]struct{}{}, pids: map[int]struct{}{}}
			services[name] = s
		}
		s.rx += f.rx
		s.tx += f.tx
		s.conns++
		s.ports[f.localPort] = struct{}{}
		if pid > 0 {
			s.pids[pid] = struct{}{}
		}

		// —— 对端视角
		p := peers[f.peerIP]
		if p == nil {
			p = &peerAgg{ports: map[int]struct{}{}}
			peers[f.peerIP] = p
		}
		p.rx += f.rx
		p.tx += f.tx
		p.conns++
		p.ports[f.localPort] = struct{}{}
	}

	svcOut := make([]ServiceTraffic, 0, len(services))
	for name, s := range services {
		category := categoryOf(name)
		if name == closedConnLabel {
			category = "closed"
		}
		svcOut = append(svcOut, ServiceTraffic{
			Service:  name,
			Category: category,
			Rx:       s.rx,
			Tx:       s.tx,
			Conns:    s.conns,
			Ports:    sortedPorts(s.ports, 8),
			PIDs:     sortedPIDs(s.pids, 6),
		})
	}
	sort.Slice(svcOut, func(i, j int) bool {
		return svcOut[i].Rx+svcOut[i].Tx > svcOut[j].Rx+svcOut[j].Tx
	})

	peerOut := make([]PeerTraffic, 0, len(peers))
	for ip, p := range peers {
		peerOut = append(peerOut, PeerTraffic{
			IP:    ip,
			Rx:    p.rx,
			Tx:    p.tx,
			Conns: p.conns,
			Ports: sortedPorts(p.ports, 8),
		})
	}
	sort.Slice(peerOut, func(i, j int) bool {
		return peerOut[i].Rx+peerOut[i].Tx > peerOut[j].Rx+peerOut[j].Tx
	})
	// 对端可能成千上万，只上报最重的一批，其余对面板没有意义
	if len(peerOut) > 200 {
		peerOut = peerOut[:200]
	}

	return svcOut, peerOut
}

// readConntrack 解析 /proc/net/nf_conntrack。
//
// 每行有两组 src/dst/sport/dport/bytes：前一组是原始方向，后一组是回复方向。
// 靠本机 IP 集合判断哪一侧是自己，从而分清收发。
func readConntrack() []ctFlow {
	return readConntrackFrom("/proc/net/nf_conntrack", localAddresses())
}

// readConntrackFrom 是可测版本：路径和本机地址都从外面传进来，
// 这样解析逻辑不用依赖真实内核状态就能验证。
func readConntrackFrom(path string, local map[string]bool) []ctFlow {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	out := make([]ctFlow, 0, 256)

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())

		var (
			srcs, dsts   []string
			sports, dpts []int
			byteCounts   []uint64
		)
		for _, kv := range fields {
			key, val, ok := strings.Cut(kv, "=")
			if !ok {
				continue
			}
			switch key {
			case "src":
				srcs = append(srcs, val)
			case "dst":
				dsts = append(dsts, val)
			case "sport":
				n, _ := strconv.Atoi(val)
				sports = append(sports, n)
			case "dport":
				n, _ := strconv.Atoi(val)
				dpts = append(dpts, n)
			case "bytes":
				n, _ := strconv.ParseUint(val, 10, 64)
				byteCounts = append(byteCounts, n)
			}
		}

		// 缺少回复方向的条目（比如刚建立的连接）直接跳过
		if len(srcs) < 2 || len(dsts) < 2 || len(sports) < 2 || len(dpts) < 2 || len(byteCounts) < 2 {
			continue
		}

		origSrc, origDst := srcs[0], dsts[0]
		origSport, origDport := sports[0], dpts[0]
		origBytes, replyBytes := byteCounts[0], byteCounts[1]

		var flow ctFlow
		switch {
		case local[origSrc]:
			// 出站：原始方向是本机发出的
			flow = ctFlow{localPort: origSport, peerIP: origDst, peerPort: origDport, tx: origBytes, rx: replyBytes}
		case local[origDst]:
			// 入站：原始方向是对方发过来的
			flow = ctFlow{localPort: origDport, peerIP: origSrc, peerPort: origSport, rx: origBytes, tx: replyBytes}
		default:
			// 转发流量，不是本机自己的连接
			continue
		}

		if flow.rx == 0 && flow.tx == 0 {
			// 全零通常意味着没开 nf_conntrack_acct，留着只会污染统计
			continue
		}
		out = append(out, flow)
	}
	return out
}

// localAddresses 收集本机所有网卡地址，用于判断连接方向。
func localAddresses() map[string]bool {
	set := map[string]bool{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return set
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok {
				set[ipnet.IP.String()] = true
			}
		}
	}
	return set
}

type procRef struct {
	pid  int
	name string
}

// mapPortsToProcesses 建立"本地端口 → 进程"的映射。
func mapPortsToProcesses() map[int]procRef {
	inodeToPort := map[uint64]int{}
	for _, p := range []string{"/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp", "/proc/net/udp6"} {
		readSocketTable(p, inodeToPort)
	}
	if len(inodeToPort) == 0 {
		return nil
	}

	out := map[int]procRef{}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}

	for _, e := range entries {
		if !e.IsDir() || !isAllDigits(e.Name()) {
			continue
		}
		pid, _ := strconv.Atoi(e.Name())
		fdDir := "/proc/" + e.Name() + "/fd"
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			// 非 root 时读不到别人的 fd，跳过即可
			continue
		}

		var name string
		for _, fd := range fds {
			link, err := os.Readlink(fdDir + "/" + fd.Name())
			if err != nil || !strings.HasPrefix(link, "socket:[") {
				continue
			}
			inode, err := strconv.ParseUint(strings.TrimSuffix(link[8:], "]"), 10, 64)
			if err != nil {
				continue
			}
			port, ok := inodeToPort[inode]
			if !ok {
				continue
			}
			if name == "" {
				name = processName(e.Name())
			}
			out[port] = procRef{pid: pid, name: name}
		}
	}
	return out
}

// readSocketTable 解析 /proc/net/{tcp,udp}，取出本地端口和 socket inode。
func readSocketTable(path string, into map[uint64]int) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Scan() // 跳过表头
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 {
			continue
		}
		// local_address 形如 0100007F:1F90，冒号后是十六进制端口
		_, portHex, ok := strings.Cut(fields[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseUint(portHex, 16, 32)
		if err != nil {
			continue
		}
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil || inode == 0 {
			continue
		}
		into[inode] = int(port)
	}
}

// processName 优先读 comm；它被截断到 15 字符，所以对 comm 为空的情况回退到 cmdline。
func processName(pid string) string {
	if comm := strings.TrimSpace(readFileString("/proc/" + pid + "/comm")); comm != "" {
		return comm
	}
	raw := readFileString("/proc/" + pid + "/cmdline")
	if raw == "" {
		return "unknown"
	}
	first, _, _ := strings.Cut(raw, "\x00")
	if idx := strings.LastIndex(first, "/"); idx >= 0 {
		first = first[idx+1:]
	}
	if first == "" {
		return "unknown"
	}
	return first
}
