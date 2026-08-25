package main

// 与面板共享的数据契约，字段名对应 apps/server/src/types.ts。
// 改这里就要同步改那边，否则上报会被静默丢弃。

type NodeInfo struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Hostname     string   `json:"hostname"`
	IP           string   `json:"ip"`
	CountryCode  string   `json:"countryCode"`
	Region       string   `json:"region"`
	Provider     string   `json:"provider"`
	OS           string   `json:"os"`
	Platform     string   `json:"platform"`
	Arch         string   `json:"arch"`
	Kernel       string   `json:"kernel"`
	CPUModel     string   `json:"cpuModel"`
	CPUCores     int      `json:"cpuCores"`
	MemTotal     uint64   `json:"memTotal"`
	SwapTotal    uint64   `json:"swapTotal"`
	DiskTotal    uint64   `json:"diskTotal"`
	Tags         []string `json:"tags"`
	AgentVersion string   `json:"agentVersion"`
	BootTime     int64    `json:"bootTime"`
}

type Metric struct {
	NodeID     string   `json:"nodeId"`
	TS         int64    `json:"ts"`
	CPU        float64  `json:"cpu"`
	MemUsed    uint64   `json:"memUsed"`
	SwapUsed   uint64   `json:"swapUsed"`
	DiskUsed   uint64   `json:"diskUsed"`
	Load1      float64  `json:"load1"`
	Load5      float64  `json:"load5"`
	Load15     float64  `json:"load15"`
	NetRx      uint64   `json:"netRx"`
	NetTx      uint64   `json:"netTx"`
	NetRxTotal uint64   `json:"netRxTotal"`
	NetTxTotal uint64   `json:"netTxTotal"`
	TCPConns   int      `json:"tcpConns"`
	UDPConns   int      `json:"udpConns"`
	Processes  int      `json:"processes"`
	Uptime     int64    `json:"uptime"`
	TempC      *float64 `json:"tempC"`
	DiskRead   uint64   `json:"diskRead"`
	DiskWrite  uint64   `json:"diskWrite"`
}

type ServiceTraffic struct {
	Service  string `json:"service"`
	Category string `json:"category"`
	Rx       uint64 `json:"rx"`
	Tx       uint64 `json:"tx"`
	Conns    int    `json:"conns"`
	Ports    []int  `json:"ports"`
	PIDs     []int  `json:"pids"`
}

type PeerTraffic struct {
	IP    string `json:"ip"`
	Rx    uint64 `json:"rx"`
	Tx    uint64 `json:"tx"`
	Conns int    `json:"conns"`
	Ports []int  `json:"ports"`
}

// Report 是一次上报的完整载荷。
type Report struct {
	NodeID   string           `json:"nodeId"`
	Token    string           `json:"token"`
	Metric   Metric           `json:"metric"`
	Services []ServiceTraffic `json:"services,omitempty"`
	Peers    []PeerTraffic    `json:"peers,omitempty"`
	// 每机独立密钥。注册时由面板下发，没带就只能上报、拿不到下发指令
	Secret string `json:"secret,omitempty"`
	// SSH 实况。采不到时整块省略，面板据此区分"没有钥匙"和"采不到"
	SSH *SSHFacts `json:"ssh,omitempty"`
}

// Command 是面板下发的指令。
//
// **agent 不执行 Commands 里的字符串**，那只是给人看的展示文本。
// 真正被执行的是下面这些结构化字段，agent 拿它们自己构造操作 ——
// 面板一旦被攻破，也没法借下发在机器上跑任意命令。
type Command struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // block | unblock | ssh_grant | ssh_revoke

	// —— 封禁
	Target string `json:"target,omitempty"`
	TTL    int    `json:"ttlSeconds,omitempty"`
	Mode   string `json:"mode,omitempty"` // dry-run | enforced

	// —— SSH
	RemoteUser  string `json:"remoteUser,omitempty"`
	PublicKey   string `json:"publicKey,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Comment     string `json:"comment,omitempty"`
	ExpiresAt   int64  `json:"expiresAt,omitempty"`

	// 仅供展示与存档
	Commands []string `json:"commands,omitempty"`
}

type CommandResult struct {
	ID      string `json:"id"`
	OK      bool   `json:"ok"`
	Output  string `json:"output"`
	Skipped bool   `json:"skipped"`
}
