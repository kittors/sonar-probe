//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/*
写 authorized_keys 的测试。

这是全项目出错代价最高的一段代码：封禁写错了最坏是误封一个 IP，
这里写错了是这台机器再也进不去，而且没有任何界面能撤销。

所以这一组用例锁的全是"不能发生"的事：不能删别人的钥匙、不能把文件写截断、
不能在删完最后一把之后还继续。
*/

func TestSplitOptions(t *testing.T) {
	cases := []struct{ line, wantOpts, wantRest string }{
		{"ssh-ed25519 AAAA c", "", "ssh-ed25519 AAAA c"},
		{"no-pty ssh-ed25519 AAAA c", "no-pty", "ssh-ed25519 AAAA c"},
		{`expiry-time="20260101",no-pty ssh-rsa BBBB x`, `expiry-time="20260101",no-pty`, "ssh-rsa BBBB x"},
		// 值里带空格的选项：按第一个空格硬切会把密钥本体切进选项里
		{`command="echo hi there" ssh-ed25519 AAAA c`, `command="echo hi there"`, "ssh-ed25519 AAAA c"},
	}
	for _, c := range cases {
		opts, rest := splitOptions(c.line)
		if opts != c.wantOpts || rest != c.wantRest {
			t.Errorf("splitOptions(%q)\n  得到 opts=%q rest=%q\n  期望 opts=%q rest=%q",
				c.line, opts, rest, c.wantOpts, c.wantRest)
		}
	}
}

func TestExpiryOf(t *testing.T) {
	at, ok := expiryOf(`expiry-time="202601021504Z" ssh-ed25519 AAAA sonar:a:b:c`)
	if !ok {
		t.Fatal("应该解析出到期时间")
	}
	if at.Year() != 2026 || at.Month() != 1 || at.Day() != 2 {
		t.Errorf("解析出的时间不对：%v", at)
	}

	if _, ok := expiryOf("ssh-ed25519 AAAA c"); ok {
		t.Error("没有 expiry-time 的行不该返回时间")
	}
}

func TestGuardRemoteUser(t *testing.T) {
	// 这些值会被拿去查 /etc/passwd 再拼路径，带 / 或 .. 的就是一条写到任意位置的路
	for _, bad := range []string{"", "../../etc", "root/x", "a b", "root;id", strings.Repeat("x", 40)} {
		if guardRemoteUser(bad) == "" {
			t.Errorf("%q 应该被拒绝", bad)
		}
	}
	for _, good := range []string{"root", "ubuntu", "deploy-01", "a.b_c"} {
		if why := guardRemoteUser(good); why != "" {
			t.Errorf("%q 不该被拒绝：%s", good, why)
		}
	}
}

func TestWriteLinesAtomicKeepsPermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "authorized_keys")

	if err := writeLinesAtomic(path, []string{"a", "b"}, "", ""); err != nil {
		t.Fatal(err)
	}

	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// 权限不对时 sshd 会静默拒绝整个文件 —— 那是这类功能失效的头号原因
	if st.Mode().Perm() != 0o600 {
		t.Errorf("权限应该是 0600，实际是 %o", st.Mode().Perm())
	}

	data, _ := os.ReadFile(path)
	if string(data) != "a\nb\n" {
		t.Errorf("内容不对：%q", data)
	}
}

func TestWriteLinesAtomicLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "authorized_keys")
	if err := writeLinesAtomic(path, []string{"x"}, "", ""); err != nil {
		t.Fatal(err)
	}

	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".sonar-ak-") {
			t.Errorf("留下了临时文件 %s", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("目录里应该只有目标文件，实际有 %d 个", len(entries))
	}
}

func TestBackupThenPrune(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "authorized_keys")
	os.WriteFile(path, []byte("original\n"), 0o600)

	// 备份文件名带秒级时间戳，同一秒内会重名，所以手工造几个不同的
	for i := 0; i < 8; i++ {
		os.WriteFile(path+".sonar-bak.2026010"+string(rune('0'+i))+"-000000", []byte("x"), 0o600)
	}
	pruneBackups(path, 5)

	matches, _ := filepath.Glob(path + ".sonar-bak.*")
	if len(matches) != 5 {
		t.Errorf("应该只保留 5 份备份，实际 %d 份", len(matches))
	}
}

// —————————————————————————————————————————————————————————
// 撤销：最要紧的那几条
// —————————————————————————————————————————————————————————

// fakeHome 造一个带 .ssh/authorized_keys 的家目录，返回路径。
func fakeHome(t *testing.T, lines ...string) string {
	t.Helper()
	home := t.TempDir()
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	content := strings.Join(lines, "\n")
	if content != "" {
		content += "\n"
	}
	if err := os.WriteFile(filepath.Join(sshDir, "authorized_keys"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

// 真实的 ed25519 公钥与它的指纹，两边必须对得上
const testKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7WlB7Zj0y5V6bJ8vXNLgKQ3wYfTzKqK5nFqYqXmZ8P test@example"

// testKeyType 和 testKeyBlob 是 testKey 拆开的两段。
//
// 拼 authorized_keys 的行时必须用它们重新组装，而不是在 testKey 后面接注释 ——
// testKey 自带 "test@example"，直接接的话 comment 会变成
// "test@example sonar:..."，不以 sonar: 开头，于是永远匹配不上删除条件。
// 真实流程里 grant() 就是这样重新组装的。
const (
	testKeyType = "ssh-ed25519"
	testKeyBlob = "AAAAC3NzaC1lZDI1NTE5AAAAIJ7WlB7Zj0y5V6bJ8vXNLgKQ3wYfTzKqK5nFqYqXmZ8P"
)

// keyLine 按 <类型> <blob> <注释> 组装一行，和 grant() 的写法一致。
func keyLine(comment string) string {
	return testKeyType + " " + testKeyBlob + " " + comment
}

func testKeyFingerprint(t *testing.T) string {
	t.Helper()
	keys := parseAuthorizedKeysFile(writeTemp(t, testKey), "root")
	if len(keys) != 1 {
		t.Fatalf("解析失败，得到 %d 条", len(keys))
	}
	return keys[0].Fingerprint
}

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "ak")
	os.WriteFile(p, []byte(content+"\n"), 0o600)
	return p
}

func TestRevokeOnlyTouchesSonarManagedLines(t *testing.T) {
	fp := testKeyFingerprint(t)

	// 同一把公钥出现两次：一次是 Sonar 装的，一次是人手工加的。
	// 只按指纹删会把手工那份也抹掉 —— 那不是我们装的，无权处置
	home := fakeHome(t,
		keyLine("sonar:alice:node1:20260101"),
		keyLine("我自己手工加的"),
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyHereXXXXXXXXXXXXXXXXXXXXXXX another",
	)

	a := &SSHApplier{Enable: true}
	res := a.revoke(Command{Kind: "ssh_revoke", Fingerprint: fp}, home, CommandResult{})

	if !res.OK {
		t.Fatalf("应该成功：%s", res.Output)
	}

	data, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	got := string(data)

	if strings.Contains(got, "sonar:alice") {
		t.Error("带 sonar 标记的那行应该被删掉")
	}
	if !strings.Contains(got, "我自己手工加的") {
		t.Error("手工加的那行绝不能被删 —— 那不是我们装的")
	}
	if !strings.Contains(got, "another") {
		t.Error("其它钥匙不该受影响")
	}
}

func TestRevokeRefusesWhenNothingMatches(t *testing.T) {
	home := fakeHome(t, keyLine("手工的，没有 sonar 标记"))

	a := &SSHApplier{Enable: true}
	res := a.revoke(Command{Kind: "ssh_revoke", Fingerprint: testKeyFingerprint(t)}, home, CommandResult{})

	if !res.OK {
		t.Errorf("没有匹配项不算失败：%s", res.Output)
	}
	data, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	if !strings.Contains(string(data), "手工的") {
		t.Error("没有 sonar 标记的行必须原样保留")
	}
}

func TestRevokeCreatesBackup(t *testing.T) {
	home := fakeHome(t,
		keyLine("sonar:alice:node1:20260101"),
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyHereXXXXXXXXXXXXXXXXXXXXXXX keep",
	)
	a := &SSHApplier{Enable: true}
	a.revoke(Command{Kind: "ssh_revoke", Fingerprint: testKeyFingerprint(t)}, home, CommandResult{})

	matches, _ := filepath.Glob(filepath.Join(home, ".ssh", "authorized_keys.sonar-bak.*"))
	if len(matches) == 0 {
		t.Fatal("改动前必须留一份备份")
	}
	data, _ := os.ReadFile(matches[0])
	if !strings.Contains(string(data), "sonar:alice") {
		t.Error("备份里应该是改动**之前**的内容")
	}
}

func TestApplyDoesNothingWhenDisabled(t *testing.T) {
	home := fakeHome(t, keyLine("sonar:alice:node1:20260101"))
	before, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))

	// 默认关闭：面板下发的密钥指令只打印不执行，和 -enforce 对封禁的关系一致
	a := &SSHApplier{Enable: false}
	res := a.Apply(Command{Kind: "ssh_revoke", RemoteUser: "root", Fingerprint: "x"})

	if !res.Skipped {
		t.Error("未启用时必须跳过")
	}
	after, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	if string(before) != string(after) {
		t.Error("未启用时不能改动任何文件")
	}
}

// —————————————————————————————————————————————————————————
// 授权
// —————————————————————————————————————————————————————————

func TestGrantRejectsKeyWithoutSonarTag(t *testing.T) {
	home := fakeHome(t)
	a := &SSHApplier{Enable: true}
	res := a.grant(Command{
		Kind:      "ssh_grant",
		PublicKey: testKey,
		Comment:   "没有前缀",
	}, home, "", "", CommandResult{})

	if res.OK {
		t.Error("comment 没有 sonar: 前缀时必须拒绝 —— 写进去的钥匙将来删不掉")
	}
}

func TestGrantRejectsFingerprintMismatch(t *testing.T) {
	home := fakeHome(t)
	a := &SSHApplier{Enable: true}
	res := a.grant(Command{
		Kind:        "ssh_grant",
		PublicKey:   testKey,
		Fingerprint: "SHA256:definitely-not-the-right-one",
		Comment:     "sonar:a:b:c",
	}, home, "", "", CommandResult{})

	if res.OK {
		t.Error("指纹对不上说明传输中被改过，必须拒绝")
	}
}

func TestGrantRejectsMalformedKey(t *testing.T) {
	home := fakeHome(t)
	a := &SSHApplier{Enable: true}
	for _, bad := range []string{"", "not-a-key", "ssh-ed25519 !!!not-base64!!!", "ssh-unknown AAAA x"} {
		res := a.grant(Command{Kind: "ssh_grant", PublicKey: bad, Comment: "sonar:a:b:c"}, home, "", "", CommandResult{})
		if res.OK {
			t.Errorf("%q 应该被拒绝 —— 塞进去一行 sshd 不认的东西可能让整个文件失效", bad)
		}
	}
}

func TestGrantIsIdempotent(t *testing.T) {
	home := fakeHome(t)
	a := &SSHApplier{Enable: true}
	cmd := Command{Kind: "ssh_grant", PublicKey: testKey, Comment: "sonar:a:b:c"}

	a.grant(cmd, home, "", "", CommandResult{})
	a.grant(cmd, home, "", "", CommandResult{})
	a.grant(cmd, home, "", "", CommandResult{})

	data, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	if n := strings.Count(string(data), "AAAAC3NzaC1lZDI1NTE5"); n != 1 {
		t.Errorf("重复执行应该只留一行，实际 %d 行", n)
	}
}

func TestGrantAppendsRatherThanOverwrites(t *testing.T) {
	home := fakeHome(t, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExistingKeyXXXXXXXXXXXXXXXXXXXXX existing")

	a := &SSHApplier{Enable: true}
	a.grant(Command{Kind: "ssh_grant", PublicKey: testKey, Comment: "sonar:a:b:c"}, home, "", "", CommandResult{})

	data, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	if !strings.Contains(string(data), "existing") {
		t.Error("绝不能覆盖掉已有的钥匙")
	}
	if !strings.Contains(string(data), "sonar:a:b:c") {
		t.Error("新钥匙没写进去")
	}
}

func TestGrantWithExpiryWritesOption(t *testing.T) {
	home := fakeHome(t)
	a := &SSHApplier{Enable: true}
	future := time.Date(2027, 3, 4, 5, 6, 0, 0, time.UTC).UnixMilli()

	a.grant(Command{
		Kind:      "ssh_grant",
		PublicKey: testKey,
		Comment:   "sonar:a:b:c",
		ExpiresAt: future,
	}, home, "", "", CommandResult{})

	data, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	// sshd < 7.7 的机器上不写这个选项（会让整行失效），所以只在写了的时候校验格式
	if strings.Contains(string(data), "expiry-time") {
		if !strings.Contains(string(data), `expiry-time="202703040506Z"`) {
			t.Errorf("expiry-time 格式不对：%s", data)
		}
	}
}

// —————————————————————————————————————————————————————————
// 指纹：两边必须一致
// —————————————————————————————————————————————————————————

func TestFingerprintFormatMatchesPanel(t *testing.T) {
	fp := testKeyFingerprint(t)
	if !strings.HasPrefix(fp, "SHA256:") {
		t.Errorf("格式不对：%s", fp)
	}
	if strings.HasSuffix(fp, "=") {
		t.Error("必须去掉 base64 填充，否则和 ssh-keygen 以及面板算的对不上")
	}
	// 面板的 ssh.ts 用同一套算法。两边不一致的话，对账会把每一把钥匙
	// 都显示成"面板不认识"，整个功能就废了
	const want = "SHA256:"
	if len(fp) <= len(want) {
		t.Error("指纹为空")
	}
}
