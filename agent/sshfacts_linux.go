//go:build linux

package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

/*
SSH 实况采集

这是 Sonar 相对所有 SSH 客户端管理工具（Termius、Tabby、assh）真正的优势：
它们装在你本机，只能记住"你打算怎么连"，而 agent 就跑在目标机器上，
能回答"这台机器上现在到底有哪些钥匙"。

两者的差异才是有价值的东西 —— 一台买了两年、装过各种一键脚本的 VPS，
它的 authorized_keys 里往往有几把谁也说不清来历的钥匙。

————————————————————————————————————————————————

三条硬规矩：

 1. **只读。** 这个文件里的所有函数都不写任何东西。写操作在 sshapply_linux.go，
    而且默认关闭。

 2. **只上报指纹，不上报公钥原文。** 公钥本身不是秘密，但"哪些公钥能进哪些机器"
    的完整地图对定向攻击极有价值。面板被拖库时，指纹够做对账，却复原不出可用的钥匙。

 3. **绝不解析 sshd_config 自己猜。** 用 `sshd -T` 拿真正生效的配置 ——
    手工解析要处理 Match 块、Include、大小写、默认值，每一条都可能猜错，
    而猜错的后果是预检拿着错误的前提去判断"删这把钥匙安不安全"。
*/

// authorizedKey 是从某个用户的 authorized_keys 里读出来的一行。
type authorizedKey struct {
	RemoteUser  string `json:"remoteUser"`
	Fingerprint string `json:"fingerprint"`
	KeyType     string `json:"keyType"`
	Comment     string `json:"comment"`
	Options     string `json:"options"`
}

// hostKey 是这台机器自己的身份，用来生成 known_hosts。
type hostKey struct {
	Type string `json:"type"`
	Blob string `json:"blob"`
}

// SSHFacts 是一次 SSH 实况快照。字段名对应面板的 AgentReport.ssh。
type SSHFacts struct {
	SSHDVersion     string          `json:"sshdVersion"`
	SSHDPort        int             `json:"sshdPort"`
	PasswordAuth    *bool           `json:"passwordAuth"`
	PermitRootLogin string          `json:"permitRootLogin"`
	HostKeys        []hostKey       `json:"hostKeys"`
	Keys            []authorizedKey `json:"keys"`
}

// collectSSHFacts 采集一次。任何一项失败都不影响其它项 ——
// 一台机器可能没装 sshd（那就没有版本和配置），但仍然有 authorized_keys。
func collectSSHFacts() SSHFacts {
	f := SSHFacts{}
	f.SSHDVersion = sshdVersion()
	f.HostKeys = readHostKeys()

	cfg := effectiveSSHDConfig()
	if v, ok := cfg["port"]; ok {
		f.SSHDPort, _ = strconv.Atoi(v)
	}
	if v, ok := cfg["passwordauthentication"]; ok {
		b := v == "yes"
		f.PasswordAuth = &b
	}
	f.PermitRootLogin = cfg["permitrootlogin"]

	f.Keys = readAllAuthorizedKeys(cfg)
	return f
}

// —————————————————————————————————————————————————————————
// sshd 配置
// —————————————————————————————————————————————————————————

// effectiveSSHDConfig 跑 `sshd -T` 拿真正生效的配置。
//
// 不去手工解析 /etc/ssh/sshd_config：那需要处理 Include、Match 块、
// 大小写不敏感的键、以及一大堆"没写就是默认值"的项。每一条都可能解析错，
// 而错误的结果会被拿去判断"删掉这把钥匙之后还进不进得来"。
//
// sshd -T 需要 root，且在某些发行版上要 -C 参数才肯输出。拿不到就返回空表，
// 上层会把 passwordAuth 报成 null，面板那边按"未知"处理（预检时按最坏情况拦住）。
func effectiveSSHDConfig() map[string]string {
	out := map[string]string{}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	bin := sshdPath()
	if bin == "" {
		return out
	}

	// -T 是 test mode，只打印生效配置，不会启动服务、不改任何状态
	data, err := exec.CommandContext(ctx, bin, "-T").Output()
	if err != nil {
		// 有的发行版要求带上连接参数才肯输出
		data, err = exec.CommandContext(ctx, bin, "-T", "-C", "user=root,host=localhost,addr=127.0.0.1").Output()
		if err != nil {
			return out
		}
	}

	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		// sshd -T 的输出是「小写键 值」，值里可能有空格
		parts := strings.SplitN(line, " ", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.ToLower(parts[0])
		// 同一个键可能出现多次（如 hostkey），保留第一个就够用了
		if _, seen := out[key]; !seen {
			out[key] = strings.TrimSpace(parts[1])
		}
	}
	return out
}

func sshdPath() string {
	for _, p := range []string{"/usr/sbin/sshd", "/usr/local/sbin/sshd", "/sbin/sshd"} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	if p, err := exec.LookPath("sshd"); err == nil {
		return p
	}
	return ""
}

// sshdVersion 取版本号，如 "9.6p1"。
//
// sshd -V 把版本打到 stderr 而不是 stdout（这是它的老行为），
// 所以要用 CombinedOutput。
func sshdVersion() string {
	bin := sshdPath()
	if bin == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	data, _ := exec.CommandContext(ctx, bin, "-V").CombinedOutput()
	// 输出形如 OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13
	s := string(data)
	i := strings.Index(s, "OpenSSH_")
	if i < 0 {
		return ""
	}
	rest := s[i+len("OpenSSH_"):]
	end := strings.IndexAny(rest, " ,\n\r")
	if end < 0 {
		end = len(rest)
	}
	v := strings.TrimSpace(rest[:end])
	if len(v) > 40 {
		v = v[:40]
	}
	return v
}

// readHostKeys 读这台机器自己的公钥身份。
//
// 这几个是**公钥**文件（.pub），不是私钥 —— 私钥就在旁边，绝不碰。
// 把它们带给面板，用户首次连接时就不必盲按那个
// "Are you sure you want to continue connecting?" —— TOFU 那个信任缺口没了。
func readHostKeys() []hostKey {
	var out []hostKey
	paths, _ := filepath.Glob("/etc/ssh/ssh_host_*_key.pub")
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		fields := strings.Fields(string(data))
		if len(fields) < 2 {
			continue
		}
		out = append(out, hostKey{Type: fields[0], Blob: fields[1]})
		if len(out) >= 8 {
			break
		}
	}
	return out
}

// —————————————————————————————————————————————————————————
// authorized_keys
// —————————————————————————————————————————————————————————

// readAllAuthorizedKeys 扫描所有有 shell 的本地用户。
//
// 只扫 /etc/passwd 里那些看起来能登录的账号 —— 系统账号（nologin/false）
// 就算有 authorized_keys 也进不来，把它们列出来只是噪音。
func readAllAuthorizedKeys(cfg map[string]string) []authorizedKey {
	var out []authorizedKey

	for _, u := range loginUsers() {
		for _, path := range authorizedKeyPaths(cfg, u) {
			out = append(out, parseAuthorizedKeysFile(path, u.Username)...)
			if len(out) >= 500 {
				return out
			}
		}
	}
	return out
}

type localUser struct {
	Username string
	Home     string
}

func loginUsers() []localUser {
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return nil
	}
	defer f.Close()

	var out []localUser
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "#") {
			continue
		}
		// name:passwd:uid:gid:gecos:home:shell
		p := strings.Split(line, ":")
		if len(p) < 7 {
			continue
		}
		shell := p[6]
		if strings.HasSuffix(shell, "nologin") || strings.HasSuffix(shell, "false") || shell == "" {
			continue
		}
		if p[5] == "" {
			continue
		}
		out = append(out, localUser{Username: p[0], Home: p[5]})
		if len(out) >= 64 {
			break
		}
	}
	return out
}

// authorizedKeyPaths 按 sshd 真正生效的 AuthorizedKeysFile 展开路径。
//
// 硬编码 ~/.ssh/authorized_keys 会在改过这一项的机器上扫了个空 ——
// 而扫空的表现是"这台机器一把钥匙都没有"，那正是最容易让人误判的结果。
func authorizedKeyPaths(cfg map[string]string, u localUser) []string {
	spec := cfg["authorizedkeysfile"]
	if strings.TrimSpace(spec) == "" {
		spec = ".ssh/authorized_keys .ssh/authorized_keys2"
	}

	var out []string
	for _, pat := range strings.Fields(spec) {
		// %h=home, %u=用户名, %%=字面量 %
		p := strings.NewReplacer("%h", u.Home, "%u", u.Username, "%%", "%").Replace(pat)
		if !strings.HasPrefix(p, "/") {
			p = filepath.Join(u.Home, p)
		}
		out = append(out, p)
	}
	return out
}

// parseAuthorizedKeysFile 解析一个 authorized_keys 文件。
//
// 每行的格式是 `[选项,...] <类型> <base64> [注释]`，选项部分可有可无、
// 里面可能带引号包着的逗号（如 command="a,b"），所以不能简单按逗号切。
func parseAuthorizedKeysFile(path, username string) []authorizedKey {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	var out []authorizedKey
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	// authorized_keys 的行可能很长（RSA 4096 带一堆选项），默认 64KB 缓冲不够
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		opts, rest := splitOptions(line)
		fields := strings.Fields(rest)
		if len(fields) < 2 {
			continue
		}
		keyType, blob := fields[0], fields[1]
		if !knownKeyType(keyType) {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(blob)
		if err != nil || len(raw) == 0 {
			continue
		}

		comment := ""
		if len(fields) > 2 {
			comment = strings.Join(fields[2:], " ")
		}
		if len(comment) > 200 {
			comment = comment[:200]
		}
		if len(opts) > 200 {
			opts = opts[:200]
		}

		out = append(out, authorizedKey{
			RemoteUser: username,
			// 只报指纹，公钥原文不出机器 —— 见文件头第 2 条
			Fingerprint: sshFingerprint(raw),
			KeyType:     keyType,
			Comment:     comment,
			Options:     opts,
		})
	}
	return out
}

// splitOptions 把行首的选项部分和密钥部分分开。
//
// 判据是：一行如果不是以密钥类型开头，那么第一个**不在引号内**的空格之前
// 就是选项。command="echo hi there" 这种值里带空格的情况必须靠引号状态判断，
// 按第一个空格硬切会把密钥本体切进选项里。
func splitOptions(line string) (opts, rest string) {
	fields := strings.Fields(line)
	if len(fields) > 0 && knownKeyType(fields[0]) {
		return "", line
	}

	inQuote := false
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '"':
			inQuote = !inQuote
		case ' ', '\t':
			if !inQuote {
				return strings.TrimSpace(line[:i]), strings.TrimSpace(line[i+1:])
			}
		}
	}
	return "", line
}

func knownKeyType(t string) bool {
	switch t {
	case "ssh-ed25519", "ssh-rsa", "ssh-dss",
		"ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
		"sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com":
		return true
	}
	return false
}

// sshFingerprint 与 `ssh-keygen -lf` 的输出一致：SHA256 + base64，去掉填充。
//
// 面板那边（ssh.ts 的 fingerprintOf）用的是同一套算法。两边算得不一样的话，
// 对账会把每一把钥匙都显示成"面板不认识"，整个功能就废了。
func sshFingerprint(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "=")
}

// lookupUser 给写入端用：确认账号存在并拿到家目录。
func lookupUser(name string) (*user.User, error) {
	return user.Lookup(name)
}
