package main

import (
	"net"
	"sort"
)

/**
 * 找本机的公网 IP。
 *
 * 不能指望面板那边用连接的来源地址：agent 和面板同机时走的是回环，
 * 面板只会看到 127.0.0.1，然后把它当成这台机器的地址显示出来。
 * 拿不到公网地址时返回空串，让面板回退到来源地址。
 */
func primaryPublicIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var fallback string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() || !ip.IsGlobalUnicast() {
				continue
			}
			if v4 := ip.To4(); v4 != nil {
				if v4.IsPrivate() {
					// NAT 后面的机器只有内网地址，先记下来兜底
					if fallback == "" {
						fallback = v4.String()
					}
					continue
				}
				return v4.String()
			}
		}
	}
	return fallback
}

// Collector 是平台相关的采集接口。
// Linux 走 /proc 与 conntrack；其他平台目前只提供够跑起来的最小实现。
type Collector interface {
	// Static 返回开机后基本不变的机器画像，注册时上报一次。
	Static() (NodeInfo, error)
	// Sample 返回一次实时采样。相邻两次之间的差值由实现自己维护。
	Sample() (Metric, error)
	// Services 按进程聚合流量。取不到时返回空切片而不是报错 ——
	// 这项依赖 conntrack accounting，不是所有机器都开着，但不该因此让整个采集失败。
	Services() []ServiceTraffic
	// Peers 按对端 IP 聚合流量。
	Peers() []PeerTraffic
}

// 进程名 → 展示分类。面板用它上色和分组。
var serviceCategory = map[string]string{
	"nginx": "web", "caddy": "web", "httpd": "web", "apache2": "web", "traefik": "web",
	"haproxy": "web", "envoy": "web",

	"mysqld": "database", "mariadbd": "database", "postgres": "database",
	"redis-server": "database", "mongod": "database", "clickhouse-serv": "database",
	"etcd": "database", "influxd": "database",

	"dockerd": "container", "containerd": "container", "buildkitd": "container",
	"podman": "container", "k3s": "container", "kubelet": "container", "runc": "container",

	"rsync": "transfer", "restic": "transfer", "minio": "transfer", "smbd": "transfer",
	"vsftpd": "transfer", "sftp-server": "transfer", "cloudflared": "transfer",
	"wg-quick": "transfer", "wireguard": "transfer", "openvpn": "transfer",

	"sshd": "system", "systemd": "system", "systemd-resolve": "system", "chronyd": "system",
	"ntpd": "system", "dnsmasq": "system", "cron": "system", "rsyslogd": "system",
	"node_exporter": "system", "prometheus": "system", "sonar-agent": "system",

	"node": "app", "python3": "app", "python": "app", "java": "app", "gunicorn": "app",
	"uwsgi": "app", "php-fpm": "app", "ruby": "app", "postfix": "app", "dovecot": "app",
	"rspamd": "app",
}

func categoryOf(process string) string {
	if c, ok := serviceCategory[process]; ok {
		return c
	}
	return "other"
}

// sortedPorts 去重并排序，避免上报里出现同一端口重复几十次。
func sortedPorts(set map[int]struct{}, limit int) []int {
	out := make([]int, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Ints(out)
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func sortedPIDs(set map[int]struct{}, limit int) []int {
	return sortedPorts(set, limit)
}
