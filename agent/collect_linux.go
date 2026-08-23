//go:build linux

package main

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// procCollector 从 /proc 与 /sys 采集。
// 速率类指标（CPU 占用、网络吞吐、磁盘 IO）都是累计计数器，
// 必须保留上一次的值做差分，所以采集器是有状态的。
type procCollector struct {
	prevCPUIdle  uint64
	prevCPUTotal uint64
	prevNetRx    uint64
	prevNetTx    uint64
	prevDiskRead uint64
	prevDiskWr   uint64
	prevAt       time.Time

	services []ServiceTraffic
	peers    []PeerTraffic
}

func newCollector() Collector { return &procCollector{} }

// —————————————————————————————————————————————————————————
// 静态信息
// —————————————————————————————————————————————————————————

func (c *procCollector) Static() (NodeInfo, error) {
	host, _ := os.Hostname()
	memTotal, swapTotal := readMemTotals()
	diskTotal, _ := readDiskUsage("/")

	return NodeInfo{
		Hostname:     host,
		Name:         host,
		IP:           primaryPublicIP(),
		OS:           readOSName(),
		Platform:     "linux",
		Arch:         runtime.GOARCH,
		Kernel:       strings.TrimSpace(readFileString("/proc/sys/kernel/osrelease")),
		CPUModel:     readCPUModel(),
		CPUCores:     runtime.NumCPU(),
		MemTotal:     memTotal,
		SwapTotal:    swapTotal,
		DiskTotal:    diskTotal,
		AgentVersion: version,
		BootTime:     readBootTime(),
		Tags:         []string{},
	}, nil
}

func readOSName() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return "Linux"
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "PRETTY_NAME="); ok {
			return strings.Trim(v, `"`)
		}
	}
	return "Linux"
}

func readCPUModel() string {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return "unknown"
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		// x86 用 "model name"，ARM 上通常只有 "Hardware" 或什么都没有
		for _, key := range []string{"model name", "Model", "Hardware"} {
			if strings.HasPrefix(line, key) {
				if _, v, ok := strings.Cut(line, ":"); ok {
					return strings.TrimSpace(v)
				}
			}
		}
	}
	return runtime.GOARCH
}

func readBootTime() int64 {
	up := strings.Fields(readFileString("/proc/uptime"))
	if len(up) == 0 {
		return time.Now().UnixMilli()
	}
	secs, _ := strconv.ParseFloat(up[0], 64)
	return time.Now().Add(-time.Duration(secs) * time.Second).UnixMilli()
}

// —————————————————————————————————————————————————————————
// 实时采样
// —————————————————————————————————————————————————————————

func (c *procCollector) Sample() (Metric, error) {
	now := time.Now()
	elapsed := now.Sub(c.prevAt).Seconds()
	if c.prevAt.IsZero() || elapsed <= 0 {
		elapsed = 0
	}

	memTotal, swapTotal := readMemTotals()
	memAvail, swapFree := readMemAvailable()
	diskTotal, diskFree := readDiskUsage("/")
	l1, l5, l15 := readLoadAvg()
	rxTotal, txTotal := readNetTotals()
	readTotal, writeTotal := readDiskIOTotals()
	tcpConns, udpConns := countConnections()

	m := Metric{
		TS:         now.UnixMilli(),
		CPU:        c.cpuPercent(),
		MemUsed:    saturatingSub(memTotal, memAvail),
		SwapUsed:   saturatingSub(swapTotal, swapFree),
		DiskUsed:   saturatingSub(diskTotal, diskFree),
		Load1:      l1,
		Load5:      l5,
		Load15:     l15,
		NetRxTotal: rxTotal,
		NetTxTotal: txTotal,
		TCPConns:   tcpConns,
		UDPConns:   udpConns,
		Processes:  countProcesses(),
		Uptime:     readUptimeSeconds(),
		TempC:      readTemperature(),
	}

	// 首次采样没有基准，速率一律留 0，不要拿累计值当速率报上去
	if elapsed > 0 {
		m.NetRx = uint64(float64(saturatingSub(rxTotal, c.prevNetRx)) / elapsed)
		m.NetTx = uint64(float64(saturatingSub(txTotal, c.prevNetTx)) / elapsed)
		m.DiskRead = uint64(float64(saturatingSub(readTotal, c.prevDiskRead)) / elapsed)
		m.DiskWrite = uint64(float64(saturatingSub(writeTotal, c.prevDiskWr)) / elapsed)
	}

	c.prevNetRx, c.prevNetTx = rxTotal, txTotal
	c.prevDiskRead, c.prevDiskWr = readTotal, writeTotal
	c.prevAt = now

	// 流量归因比较重，和指标采样一起做，结果缓存到下次上报
	c.services, c.peers = collectAttribution()

	return m, nil
}

// cpuPercent 用 /proc/stat 的 jiffies 差分算占用率。
func (c *procCollector) cpuPercent() float64 {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return 0
	}
	fields := strings.Fields(sc.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0
	}

	var total uint64
	var idle uint64
	for i, raw := range fields[1:] {
		v, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			continue
		}
		total += v
		// idle 是第 4 项，iowait 是第 5 项，两者都算作没在干活
		if i == 3 || i == 4 {
			idle += v
		}
	}

	prevTotal, prevIdle := c.prevCPUTotal, c.prevCPUIdle
	c.prevCPUTotal, c.prevCPUIdle = total, idle
	if prevTotal == 0 || total <= prevTotal {
		return 0
	}

	dTotal := float64(total - prevTotal)
	dIdle := float64(saturatingSub(idle, prevIdle))
	pct := (1 - dIdle/dTotal) * 100
	return clampFloat(pct, 0, 100)
}

func readMemTotals() (mem, swap uint64) {
	return readMeminfoKeys("MemTotal:", "SwapTotal:")
}

func readMemAvailable() (avail, swapFree uint64) {
	return readMeminfoKeys("MemAvailable:", "SwapFree:")
}

func readMeminfoKeys(k1, k2 string) (v1, v2 uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, k1):
			v1 = parseKB(line)
		case strings.HasPrefix(line, k2):
			v2 = parseKB(line)
		}
	}
	return
}

// meminfo 的单位是 kB，转成字节。
func parseKB(line string) uint64 {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	v, _ := strconv.ParseUint(fields[1], 10, 64)
	return v * 1024
}

func readDiskUsage(path string) (total, free uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	bs := uint64(st.Bsize)
	// 用 Bavail 而不是 Bfree：后者含保留给 root 的块，普通用户其实用不到
	return st.Blocks * bs, st.Bavail * bs
}

func readLoadAvg() (l1, l5, l15 float64) {
	fields := strings.Fields(readFileString("/proc/loadavg"))
	if len(fields) < 3 {
		return
	}
	l1, _ = strconv.ParseFloat(fields[0], 64)
	l5, _ = strconv.ParseFloat(fields[1], 64)
	l15, _ = strconv.ParseFloat(fields[2], 64)
	return
}

// readNetTotals 汇总物理网卡的收发字节。
// 跳过环回和各种虚拟设备，否则容器流量会被重复计入。
func readNetTotals() (rx, tx uint64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if isVirtualInterface(name) {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		rx += r
		tx += t
	}
	return
}

var virtualPrefixes = []string{"lo", "veth", "docker", "br-", "virbr", "tun", "tap", "cni", "flannel", "kube"}

func isVirtualInterface(name string) bool {
	for _, p := range virtualPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// readDiskIOTotals 汇总真实块设备的读写字节。扇区固定 512 字节。
func readDiskIOTotals() (read, write uint64) {
	f, err := os.Open("/proc/diskstats")
	if err != nil {
		return 0, 0
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 {
			continue
		}
		name := fields[2]
		// 只统计整盘，跳过分区和各种映射设备，避免重复计数
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") ||
			strings.HasPrefix(name, "dm-") || isPartition(name) {
			continue
		}
		rs, _ := strconv.ParseUint(fields[5], 10, 64)
		ws, _ := strconv.ParseUint(fields[9], 10, 64)
		read += rs * 512
		write += ws * 512
	}
	return
}

// isPartition 判断 sda1 / nvme0n1p1 这类分区名。
func isPartition(name string) bool {
	if strings.HasPrefix(name, "nvme") {
		return strings.Contains(name, "p") && name[len(name)-1] >= '0' && name[len(name)-1] <= '9' &&
			strings.LastIndex(name, "p") > strings.Index(name, "n")
	}
	if len(name) == 0 {
		return false
	}
	last := name[len(name)-1]
	return last >= '0' && last <= '9' && (strings.HasPrefix(name, "sd") || strings.HasPrefix(name, "vd") || strings.HasPrefix(name, "hd"))
}

func countProcesses() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() && isAllDigits(e.Name()) {
			n++
		}
	}
	return n
}

func countConnections() (tcp, udp int) {
	tcp = countLines("/proc/net/tcp") + countLines("/proc/net/tcp6")
	udp = countLines("/proc/net/udp") + countLines("/proc/net/udp6")
	return
}

// countLines 数除表头以外的行数。
func countLines(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	n := -1
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		n++
	}
	if n < 0 {
		return 0
	}
	return n
}

func readUptimeSeconds() int64 {
	fields := strings.Fields(readFileString("/proc/uptime"))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return int64(v)
}

// readTemperature 取第一个能读到的热区。VPS 上多半读不到，返回 nil 让面板显示"不可用"。
func readTemperature() *float64 {
	zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
	for _, z := range zones {
		raw := strings.TrimSpace(readFileString(z))
		if raw == "" {
			continue
		}
		milli, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			continue
		}
		c := milli / 1000
		// 明显不合理的读数直接跳过，有些虚拟化环境会返回 0 或几万
		if c > 0 && c < 130 {
			return &c
		}
	}
	return nil
}

func (c *procCollector) Services() []ServiceTraffic {
	if c.services == nil {
		return []ServiceTraffic{}
	}
	return c.services
}

func (c *procCollector) Peers() []PeerTraffic {
	if c.peers == nil {
		return []PeerTraffic{}
	}
	return c.peers
}

// —————————————————————————————————————————————————————————
// 小工具
// —————————————————————————————————————————————————————————

func readFileString(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// saturatingSub 防止计数器回绕（重启网卡、32 位溢出）时算出天文数字。
func saturatingSub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}

func clampFloat(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
