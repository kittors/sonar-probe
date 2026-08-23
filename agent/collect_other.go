//go:build !linux

package main

import (
	"os"
	"runtime"
	"time"
)

/*
非 Linux 平台的占位实现。

存在的意义只有一个：让 agent 能在 macOS 上编译通过，方便本机改代码时跑 go build 和 go vet。
真实采集只在 Linux 上实现 —— /proc、conntrack、nftables 都是 Linux 特有的，
在别的系统上没有等价物值得为探针场景去适配。
*/

type stubCollector struct {
	start time.Time
}

func newCollector() Collector {
	return &stubCollector{start: time.Now()}
}

func (c *stubCollector) Static() (NodeInfo, error) {
	host, _ := os.Hostname()
	return NodeInfo{
		Hostname:     host,
		Name:         host,
		OS:           runtime.GOOS,
		Platform:     runtime.GOOS,
		Arch:         runtime.GOARCH,
		CPUCores:     runtime.NumCPU(),
		AgentVersion: version,
		BootTime:     c.start.UnixMilli(),
		Tags:         []string{},
	}, nil
}

func (c *stubCollector) Sample() (Metric, error) {
	return Metric{
		TS:     time.Now().UnixMilli(),
		Uptime: int64(time.Since(c.start).Seconds()),
	}, nil
}

func (c *stubCollector) Services() []ServiceTraffic { return []ServiceTraffic{} }
func (c *stubCollector) Peers() []PeerTraffic       { return []PeerTraffic{} }

// 归因逻辑同样只在 Linux 上有实现。
func collectAttribution() ([]ServiceTraffic, []PeerTraffic) { return nil, nil }
