//go:build linux

package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

/*
写 authorized_keys

这是整个项目里出错代价最高的一段代码。封禁写错了最坏是误封一个 IP，
这里写错了是**这台机器再也进不去**，而且没有任何界面能撤销。

————————————————————————————————————————————————

四条不可动摇的规矩：

 1. **不执行面板下发的命令字符串。** 面板给的 preview 只用于展示和存档，
    agent 拿到的是结构化参数，自己构造文件操作。这里连 exec 都不需要 ——
    纯 Go 文件 IO，比封禁那边（至少要 exec nft）更没有可乘之机。

 2. **agent 自己再跑一遍守卫。** 面板已经预检过一次，这里再来一次是纵深防御。
    两边独立判断，任何一边认为危险就不执行。

 3. **原子写。** 写临时文件 → fsync → rename。直接改原文件时如果 OOM 或断电，
    会留下一个被截断的 authorized_keys —— 所有钥匙一起丢，机器立刻失联。
    这是最容易被忽略、后果最严重的一个细节。

 4. **只删自己装的。** 只有 comment 带 sonar: 前缀的行才可能被删除。
    手工加的、别的工具加的，一律不碰。
*/

// sonarTag 必须和面板的 SONAR_TAG 一致。对不上的话，agent 会认为
// 面板装的每一把钥匙都"不是自己人"，于是永远删不掉它们。
const sonarTag = "sonar:"

// SSHApplier 执行面板下发的密钥变更。
type SSHApplier struct {
	// Enable 为 false 时只打印将要做什么，不真的改文件。默认 false。
	Enable bool
}

// Apply 执行一条指令。返回的 CommandResult 会被回传给面板。
func (a *SSHApplier) Apply(cmd Command) CommandResult {
	res := CommandResult{ID: cmd.ID}

	if !a.Enable {
		res.Skipped = true
		res.Output = "agent 未启用 -ssh-keys，只打印不执行：\n" + strings.Join(cmd.Commands, "\n")
		return res
	}

	if why := guardRemoteUser(cmd.RemoteUser); why != "" {
		res.Skipped = true
		res.Output = "agent 拒绝执行：" + why
		return res
	}

	u, err := lookupUser(cmd.RemoteUser)
	if err != nil {
		res.Output = fmt.Sprintf("用户 %s 不存在", cmd.RemoteUser)
		return res
	}
	if u.HomeDir == "" {
		res.Output = fmt.Sprintf("用户 %s 没有家目录", cmd.RemoteUser)
		return res
	}

	switch cmd.Kind {
	case "ssh_grant":
		return a.grant(cmd, u.HomeDir, u.Uid, u.Gid, res)
	case "ssh_revoke":
		return a.revoke(cmd, u.HomeDir, res)
	default:
		res.Output = "不认识的指令类型 " + cmd.Kind
		return res
	}
}

// guardRemoteUser 挡住路径穿越和明显不合法的账号名。
//
// remoteUser 会被拿去查 /etc/passwd 再拼路径，带 / 或 .. 的值就是一条
// 写到任意位置的路。面板那边校验过一次，这里是第二道。
func guardRemoteUser(name string) string {
	if name == "" {
		return "账号名为空"
	}
	if len(name) > 32 {
		return "账号名过长"
	}
	for _, r := range name {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '.' || r == '_' || r == '-'
		if !ok {
			return fmt.Sprintf("账号名 %q 含有非法字符", name)
		}
	}
	return ""
}

func (a *SSHApplier) grant(cmd Command, home, uid, gid string, res CommandResult) CommandResult {
	line := strings.TrimSpace(cmd.PublicKey)
	if line == "" {
		res.Output = "缺少公钥"
		return res
	}

	// 自己解析一遍，不信面板传来的类型。塞进去一行 sshd 不认的东西，
	// 有可能让**整个文件**被拒绝 —— 那台机器上所有人都进不来
	fields := strings.Fields(line)
	if len(fields) < 2 || !knownKeyType(fields[0]) {
		res.Output = "公钥格式不合法"
		return res
	}
	raw, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(raw) == 0 {
		res.Output = "公钥 base64 不合法"
		return res
	}
	// 面板说的指纹和实际算出来的对不上，说明传输中被改过
	if fp := sshFingerprint(raw); cmd.Fingerprint != "" && fp != cmd.Fingerprint {
		res.Output = fmt.Sprintf("公钥指纹不匹配：面板说 %s，实际是 %s", cmd.Fingerprint, fp)
		return res
	}

	comment := cmd.Comment
	if !strings.HasPrefix(comment, sonarTag) {
		// 没有前缀的话这把钥匙将来删不掉（见 revoke 的守卫），不如现在就拒绝
		res.Output = "comment 缺少 sonar: 前缀，拒绝写入一把将来无法安全删除的钥匙"
		return res
	}

	entry := fields[0] + " " + fields[1] + " " + comment
	if cmd.ExpiresAt > 0 {
		if !sshdSupportsExpiry() {
			/*
			 * 低于 7.7 的 sshd 会把带 expiry-time 的整行当成坏选项拒绝，
			 * 那把钥匙直接失效 —— 表现是"授权成功但连不上"。
			 *
			 * 不写这个选项，改由本地到期清理来保证（见 pruneExpired）。
			 */
			res.Output = "注意：sshd 版本低于 7.7，不写 expiry-time，改由 agent 本地到期清理\n"
		} else {
			ts := time.UnixMilli(cmd.ExpiresAt).UTC().Format("200601021504")
			entry = fmt.Sprintf("expiry-time=%q,%s", ts+"Z", entry)
		}
	}

	path := filepath.Join(home, ".ssh", "authorized_keys")
	if err := ensureSSHDir(filepath.Join(home, ".ssh"), uid, gid); err != nil {
		res.Output += "创建 .ssh 目录失败：" + err.Error()
		return res
	}

	existing := readLines(path)
	for _, l := range existing {
		// 幂等：blob 相同就当已经装好了。重复执行不该追加出多行
		if strings.Contains(l, fields[1]) {
			res.OK = true
			res.Output += "这把公钥已经在了，无需改动"
			return res
		}
	}

	if err := writeLinesAtomic(path, append(existing, entry), uid, gid); err != nil {
		res.Output += "写入失败：" + err.Error()
		return res
	}

	res.OK = true
	res.Output += fmt.Sprintf("已写入 %s（现有 %d 行）", path, len(existing)+1)
	return res
}

func (a *SSHApplier) revoke(cmd Command, home string, res CommandResult) CommandResult {
	if cmd.Fingerprint == "" {
		res.Output = "缺少指纹，无法定位要删除的行"
		return res
	}

	path := filepath.Join(home, ".ssh", "authorized_keys")
	lines := readLines(path)
	if len(lines) == 0 {
		// 文件不存在或空，没什么可删的。这不是失败
		res.OK = true
		res.Output = "没有 authorized_keys，无需处理"
		return res
	}

	var kept []string
	removed := 0
	remaining := 0

	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			kept = append(kept, l)
			continue
		}
		opts, rest := splitOptions(trimmed)
		_ = opts
		fields := strings.Fields(rest)
		if len(fields) < 2 || !knownKeyType(fields[0]) {
			kept = append(kept, l)
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(fields[1])
		if err != nil {
			kept = append(kept, l)
			continue
		}

		fp := sshFingerprint(raw)
		comment := ""
		if len(fields) > 2 {
			comment = strings.Join(fields[2:], " ")
		}

		/*
		 * 只删同时满足两个条件的行：指纹对得上，**且**带 sonar: 前缀。
		 *
		 * 第二个条件是硬规矩。同一把公钥可能既被 Sonar 装过、又被人手工加过，
		 * 只按指纹删会把手工那份也一并抹掉 —— 那不是我们装的，无权处置。
		 */
		if fp == cmd.Fingerprint && strings.HasPrefix(comment, sonarTag) {
			removed++
			continue
		}
		kept = append(kept, l)
		remaining++
	}

	if removed == 0 {
		res.OK = true
		res.Output = "没有找到带 sonar: 标记的匹配行，未做改动"
		return res
	}

	/*
	 * 最后一道自伤保护：删完就没钥匙了，而密码登录是关的。
	 *
	 * 面板预检过一次，这里再来一次 —— 面板那份实况可能已经过时（比如
	 * 这几分钟内有人手工删了别的钥匙），而 agent 看到的是此刻的真相。
	 */
	if remaining == 0 && passwordLoginDisabled() {
		res.Skipped = true
		res.Output = "agent 拒绝执行：删掉这一行之后就没有任何公钥了，而密码登录是关闭的 —— 执行后这台机器将无法登录"
		return res
	}

	if err := backupFile(path); err != nil {
		res.Output = "备份失败，已中止：" + err.Error()
		return res
	}

	st, err := os.Stat(path)
	uid, gid := "", ""
	if err == nil {
		uid, gid = ownerOf(st)
	}
	if err := writeLinesAtomic(path, kept, uid, gid); err != nil {
		res.Output = "写入失败：" + err.Error()
		return res
	}

	res.OK = true
	res.Output = fmt.Sprintf("已删除 %d 行，剩余 %d 把公钥", removed, remaining)
	return res
}

// —————————————————————————————————————————————————————————
// 到期清理
// —————————————————————————————————————————————————————————

// pruneExpired 摘掉本地记录里已经过期的 sonar 钥匙。
//
// **不依赖面板。** 面板挂了、网断了、agent 与面板永久失联，临时授权照样按时失效 ——
// 这和封禁把 TTL 交给 nftables 内核是同一个道理：绝不能出现"面板没了，
// 临时权限变成永久"。
//
// sshd ≥ 7.7 时 expiry-time 已经让钥匙失效了，这一步只是把行也清掉；
// 低于 7.7 时，这一步是有效期唯一的保证。
func (a *SSHApplier) pruneExpired() int {
	if !a.Enable {
		return 0
	}
	now := time.Now().UTC()
	cleaned := 0

	for _, u := range loginUsers() {
		path := filepath.Join(u.Home, ".ssh", "authorized_keys")
		lines := readLines(path)
		if len(lines) == 0 {
			continue
		}

		var kept []string
		changed := false
		for _, l := range lines {
			if exp, ok := expiryOf(l); ok && exp.Before(now) && strings.Contains(l, sonarTag) {
				changed = true
				cleaned++
				continue
			}
			kept = append(kept, l)
		}

		if changed {
			// 全删光了就不动 —— 宁可留着几行过期的（sshd 本来也会拒绝它们），
			// 也不要制造一个空文件
			if len(kept) == 0 {
				continue
			}
			if err := backupFile(path); err != nil {
				continue
			}
			st, err := os.Stat(path)
			uid, gid := "", ""
			if err == nil {
				uid, gid = ownerOf(st)
			}
			_ = writeLinesAtomic(path, kept, uid, gid)
		}
	}
	return cleaned
}

// expiryOf 从一行里读出 expiry-time 的值。
func expiryOf(line string) (time.Time, bool) {
	opts, _ := splitOptions(strings.TrimSpace(line))
	if opts == "" {
		return time.Time{}, false
	}
	i := strings.Index(opts, "expiry-time=")
	if i < 0 {
		return time.Time{}, false
	}
	v := opts[i+len("expiry-time="):]
	v = strings.TrimPrefix(v, `"`)
	if j := strings.IndexAny(v, `",`); j >= 0 {
		v = v[:j]
	}
	v = strings.TrimSuffix(v, "Z")

	for _, layout := range []string{"200601021504", "20060102150405", "20060102"} {
		if t, err := time.ParseInLocation(layout, v, time.UTC); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func sshdSupportsExpiry() bool {
	v := sshdVersion()
	if v == "" {
		return false
	}
	var major, minor int
	if _, err := fmt.Sscanf(v, "%d.%d", &major, &minor); err != nil {
		return false
	}
	return major > 7 || (major == 7 && minor >= 7)
}

func passwordLoginDisabled() bool {
	cfg := effectiveSSHDConfig()
	v, ok := cfg["passwordauthentication"]
	// 拿不到就按"没关"处理，让上层的其它保护去拦。这里返回 true 会把
	// 一个本来安全的删除操作拦下来，那种误报同样有代价
	return ok && v == "no"
}

// —————————————————————————————————————————————————————————
// 文件操作
// —————————————————————————————————————————————————————————

// ownerOf 从文件信息里取出属主，改写时用来保持原样。
//
// 不保持的话，以 root 跑的 agent 改完一个普通用户的 authorized_keys，
// 文件就归了 root —— sshd 对此的反应是拒绝整个文件，那个用户从此进不来。
func ownerOf(st os.FileInfo) (uid, gid string) {
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return "", ""
	}
	return strconv.FormatUint(uint64(sys.Uid), 10), strconv.FormatUint(uint64(sys.Gid), 10)
}

func readLines(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	s := strings.TrimRight(string(data), "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

// writeLinesAtomic 原子替换。
//
// 写临时文件 → fsync → rename。少了这一步，一次 OOM 或断电就可能留下
// 被截断的 authorized_keys —— 所有钥匙一起丢，机器立刻失联。
// rename 在同一个文件系统内是原子的，所以临时文件必须和目标同目录。
func writeLinesAtomic(path string, lines []string, uid, gid string) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".sonar-ak-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // rename 成功后这次删除是空操作

	content := strings.Join(lines, "\n")
	if content != "" {
		content += "\n"
	}
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	// 权限必须在 rename 之前设好：先 rename 再 chmod 的话，中间那一瞬
	// 文件是 0600 之外的权限，sshd 正好在这时读到就会拒绝整个文件
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if uid != "" && gid != "" {
		if u, err1 := strconv.Atoi(uid); err1 == nil {
			if g, err2 := strconv.Atoi(gid); err2 == nil {
				_ = tmp.Chown(u, g)
			}
		}
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func ensureSSHDir(dir, uid, gid string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// 目录权限不对时 sshd 会静默拒绝整个 authorized_keys，
	// 这是这类功能失效的头号原因，所以每次都重设一遍
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	if uid != "" && gid != "" {
		if u, err1 := strconv.Atoi(uid); err1 == nil {
			if g, err2 := strconv.Atoi(gid); err2 == nil {
				_ = os.Chown(dir, u, g)
			}
		}
	}
	return nil
}

// backupFile 留一份带时间戳的副本，只保留最近 5 份。
func backupFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	stamp := time.Now().UTC().Format("20060102-150405")
	if err := os.WriteFile(path+".sonar-bak."+stamp, data, 0o600); err != nil {
		return err
	}
	pruneBackups(path, 5)
	return nil
}

func pruneBackups(path string, keep int) {
	matches, _ := filepath.Glob(path + ".sonar-bak.*")
	if len(matches) <= keep {
		return
	}
	// 文件名里的时间戳是可排序的，字典序即时间序
	sortStrings(matches)
	for _, old := range matches[:len(matches)-keep] {
		_ = os.Remove(old)
	}
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
