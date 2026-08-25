//go:build !linux

package main

import "os/user"

/*
非 Linux 平台的空实现。

SSH 实况采集依赖 /etc/passwd、/etc/ssh 和 sshd -T，这些在 macOS 上形态不同、
在 Windows 上根本不存在。与其写一份半吊子的实现，不如明确返回空 ——
面板那边会把 observedAt 显示成 0，界面上标为「该平台不支持实况」。

**采不到就要说采不到，不能静默显示成 0 把钥匙。** 后者会让人以为这台机器很干净，
而那正是最危险的误判。
*/

type authorizedKey struct {
	RemoteUser  string `json:"remoteUser"`
	Fingerprint string `json:"fingerprint"`
	KeyType     string `json:"keyType"`
	Comment     string `json:"comment"`
	Options     string `json:"options"`
}

type hostKey struct {
	Type string `json:"type"`
	Blob string `json:"blob"`
}

type SSHFacts struct {
	SSHDVersion     string          `json:"sshdVersion"`
	SSHDPort        int             `json:"sshdPort"`
	PasswordAuth    *bool           `json:"passwordAuth"`
	PermitRootLogin string          `json:"permitRootLogin"`
	HostKeys        []hostKey       `json:"hostKeys"`
	Keys            []authorizedKey `json:"keys"`
}

// collectSSHFacts 在非 Linux 上不采集。
//
// 返回零值而不是一个 keys 为空数组的结构 —— 面板据此区分
// 「采集到了、确实没有钥匙」和「这个平台采不到」。
func collectSSHFacts() SSHFacts { return SSHFacts{} }

// SSHApplier 在非 Linux 上恒不执行。
type SSHApplier struct {
	Enable bool
}

func (a *SSHApplier) Apply(cmd Command) CommandResult {
	return CommandResult{
		ID:      cmd.ID,
		Skipped: true,
		Output:  "当前平台不支持 SSH 密钥管理",
	}
}

func (a *SSHApplier) pruneExpired() int { return 0 }

func lookupUser(name string) (*user.User, error) { return user.Lookup(name) }
