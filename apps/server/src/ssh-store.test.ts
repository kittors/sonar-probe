import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * SSH 数据层与下发队列。
 *
 * 重点是**对账**那一段：授权的状态只由机器实况决定，不由"命令发出去了"决定。
 * 少了这一条，面板会显示一个假的"已生效"或"已撤销"，而人会据此做安全决策 ——
 * 那比没有这个功能更糟。
 *
 * db.ts 在模块加载时就读 SONAR_DB 建库，所以环境变量必须在 import 之前设好。
 */

let dir: string;
let db: import('node:sqlite').DatabaseSync;
let store: typeof import('./ssh-store.js');
let commands: typeof import('./commands.js');
let roles: typeof import('./roles.js');
let auth: typeof import('./auth.js');

const KEY_A =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7WlB7Zj0y5V6bJ8vXNLgKQ3wYfTzKqK5nFqYqXmZ8P alice@mac';
const KEY_B =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHqTqzXBcPvMUvZoLZaZDGkQMhCJWmqYqXvKp8LsWmZQ bob@pc';

let aliceId = '';
let keyA = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sonar-sshstore-'));
  process.env.SONAR_DB = join(dir, 'test.db');
  process.env.SONAR_DATA_DIR = dir;

  ({ db } = await import('./db.js'));
  roles = await import('./roles.js');
  auth = await import('./auth.js');
  store = await import('./ssh-store.js');
  commands = await import('./commands.js');

  roles.ensureSystemRoles();

  const alice = await auth.createUser({
    username: 'alice',
    password: 'Harbor-Lantern-2291',
    role: 'operator',
  });
  aliceId = alice.id;

  // 造两台机器，直接写库 —— 这一层不该依赖 agent 上报流程
  const now = Date.now();
  for (const id of ['node-a', 'node-b']) {
    db.prepare(`
      INSERT INTO nodes (id,name,hostname,ip,created_at,last_seen,source,agent_last_report)
      VALUES (?,?,?,?,?,?,'agent',?)
    `).run(id, id.toUpperCase(), id, '203.0.113.10', now, now, now);
  }
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ————————————————————————————————————————————————————————
// 公钥
// ————————————————————————————————————————————————————————

test('登记公钥，标签留空时用注释兜底', () => {
  const k = store.addKey({ ownerUserId: aliceId, publicKey: KEY_A });
  keyA = k.id;
  assert.equal(k.keyType, 'ssh-ed25519');
  assert.equal(k.label, 'alice@mac', '标签留空该用公钥自带的注释，那通常正是 user@host');
  assert.match(k.fingerprint, /^SHA256:/);
});

test('同一把公钥不能被两个人登记', async () => {
  const bob = await auth.createUser({
    username: 'bob',
    password: 'Cedar-Post-3388',
    role: 'viewer',
  });
  assert.throws(
    () => store.addKey({ ownerUserId: bob.id, publicKey: KEY_A }),
    /已经登记在/,
    '允许的话，"机器上这把 key 是谁的"就有两个答案 —— 而那是出事后唯一要回答的问题',
  );
});

test('自己重复登记同一把也拒绝', () => {
  assert.throws(() => store.addKey({ ownerUserId: aliceId, publicKey: KEY_A }), /已经登记过/);
});

// ————————————————————————————————————————————————————————
// 接入方式
// ————————————————————————————————————————————————————————

test('首次访问机器时自动建 endpoint，别名默认取 node id', () => {
  const ep = store.ensureEndpoint('node-a');
  assert.equal(ep.alias, 'node-a');
  assert.equal(ep.port, 22);
  assert.equal(ep.defaultUser, 'root');
  assert.equal(ep.observedAt, 0);
  assert.equal(ep.factsStale, true, '从未采集过，等同于过期');
});

test('hostname 留空时回落到 nodes.ip', () => {
  const ep = store.getEndpoint('node-a')!;
  assert.equal(ep.hostname, '');
  assert.equal(ep.effectiveHostname, '203.0.113.10');
});

test('别名不能和别的机器重复', () => {
  store.ensureEndpoint('node-b');
  assert.throws(() => store.updateEndpoint('node-b', { alias: 'node-a' }), /已经被别的机器占用/);
});

test('端口和账号要校验', () => {
  assert.throws(() => store.updateEndpoint('node-a', { port: 0 }), /1-65535/);
  assert.throws(() => store.updateEndpoint('node-a', { port: 99999 }), /1-65535/);
  assert.throws(() => store.updateEndpoint('node-a', { defaultUser: 'a b' }), /默认账号/);
});

// ————————————————————————————————————————————————————————
// 实况与对账
// ————————————————————————————————————————————————————————

test('写入实况后 endpoint 带上 sshd 信息', () => {
  store.ingestSshFacts('node-a', {
    sshdVersion: '9.6p1',
    sshdPort: 22,
    passwordAuth: false,
    permitRootLogin: 'prohibit-password',
    hostKeys: [{ type: 'ssh-ed25519', blob: 'AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyHere' }],
    keys: [],
  });

  const ep = store.getEndpoint('node-a')!;
  assert.equal(ep.sshdVersion, '9.6p1');
  assert.equal(ep.passwordAuth, false);
  assert.equal(ep.hostKeys.length, 1);
  assert.match(ep.hostKeys[0]!.fingerprint, /^SHA256:/, 'host key 指纹要现算，用于生成 known_hosts');
  assert.equal(ep.factsStale, false, '刚采的实况不该是过期的');
});

test('passwordAuth 采不到时是 null，不是 false', () => {
  store.ingestSshFacts('node-b', { sshdVersion: '8.9p1', keys: [] });
  assert.equal(
    store.getEndpoint('node-b')!.passwordAuth,
    null,
    '采不到和"确认关闭"必须区分 —— 撤销预检对这两者的处理完全不同',
  );
});

test('带 sonar: 前缀的实况被标记为受管', () => {
  const fp = store.keyByFingerprint(
    store.getKey(keyA)!.fingerprint,
  )!.fingerprint;

  store.ingestSshFacts('node-a', {
    sshdVersion: '9.6p1',
    passwordAuth: false,
    keys: [
      { remoteUser: 'root', fingerprint: fp, keyType: 'ssh-ed25519', comment: 'sonar:alice:node-a:20260101' },
      { remoteUser: 'root', fingerprint: 'SHA256:unknownkeyhere', keyType: 'ssh-rsa', comment: '装机时留下的' },
    ],
  });

  const drift = store.listDrift('node-a');
  assert.equal(drift.length, 2);

  const managed = drift.find((d) => d.fingerprint === fp)!;
  assert.equal(managed.managed, true);
  assert.equal(managed.known, true, '面板登记过这把钥匙');
  assert.equal(managed.ownerName, 'alice');

  const stranger = drift.find((d) => d.fingerprint === 'SHA256:unknownkeyhere')!;
  assert.equal(stranger.managed, false);
  assert.equal(
    stranger.known,
    false,
    '这一格是整套东西最有价值的输出：机器上有、面板不认识的钥匙',
  );
});

test('实况是覆盖写，不是累加', () => {
  store.ingestSshFacts('node-a', { sshdVersion: '9.6p1', passwordAuth: false, keys: [] });
  assert.equal(
    store.listDrift('node-a').length,
    0,
    '这张表表达的是"此刻机器上有什么"，累加会让删掉的钥匙永远留在视图里',
  );
});

// ————————————————————————————————————————————————————————
// 授权状态机
// ————————————————————————————————————————————————————————

test('新建授权是 pending，不是 active', () => {
  const g = store.createGrant({
    nodeId: 'node-a',
    keyId: keyA,
    remoteUser: 'root',
    requestState: 'approved',
    requestedBy: aliceId,
    grantedBy: aliceId,
  });
  assert.equal(g.state, 'pending');
  assert.equal(g.appliedAt, 0, '命令刚生成，机器上还没有它');
});

test('同一把钥匙对同一台机器同一账号只能有一条有效授权', () => {
  assert.throws(
    () =>
      store.createGrant({
        nodeId: 'node-a',
        keyId: keyA,
        remoteUser: 'root',
        requestState: 'approved',
        requestedBy: aliceId,
        grantedBy: aliceId,
      }),
    /已经有一条授权/,
  );
});

test('对账：实况里看到了才变成 active', () => {
  const fp = store.getKey(keyA)!.fingerprint;
  store.ingestSshFacts('node-a', {
    sshdVersion: '9.6p1',
    passwordAuth: false,
    keys: [{ remoteUser: 'root', fingerprint: fp, comment: 'sonar:alice:node-a:20260101' }],
  });

  const g = store.listGrants({ nodeId: 'node-a' })[0]!;
  assert.equal(g.state, 'active', '只有实况才能把授权置为生效');
  assert.ok(g.appliedAt > 0);
});

test('对账：active 的授权在实况里消失时变 drifted 而不是 revoked', () => {
  store.ingestSshFacts('node-a', { sshdVersion: '9.6p1', passwordAuth: false, keys: [] });

  const g = store.listGrants({ nodeId: 'node-a' })[0]!;
  assert.equal(
    g.state,
    'drifted',
    'revoked 意味着"我们撤的"，而事实是有人手工删了 —— 两者不能混为一谈',
  );
});

test('对账：pending 的授权在实况里没有时保持 pending', () => {
  // 命令可能只是还没被执行，这不是漂移
  const g2 = store.createGrant({
    nodeId: 'node-b',
    keyId: keyA,
    remoteUser: 'root',
    requestState: 'approved',
    requestedBy: aliceId,
    grantedBy: aliceId,
  });
  store.ingestSshFacts('node-b', { sshdVersion: '8.9p1', keys: [] });
  assert.equal(store.getGrant(g2.id)!.state, 'pending');
});

test('撤销后可以再次授权 —— 唯一索引把已撤销的排除在外', () => {
  const live = store.listGrants({ nodeId: 'node-b' })[0]!;
  store.markGrantRevoked(live.id, aliceId);

  const again = store.createGrant({
    nodeId: 'node-b',
    keyId: keyA,
    remoteUser: 'root',
    requestState: 'approved',
    requestedBy: aliceId,
    grantedBy: aliceId,
  });
  assert.equal(again.state, 'pending', '授权→撤销→再授权 是完全正常的序列');
});

// ————————————————————————————————————————————————————————
// 审批
// ————————————————————————————————————————————————————————

test('四眼原则：不能审批自己发起的申请', () => {
  const g = store.createGrant({
    nodeId: 'node-a',
    keyId: keyA,
    remoteUser: 'ubuntu',
    requestState: 'pending_approval',
    requestedBy: aliceId,
    grantedBy: aliceId,
  });
  assert.throws(
    () => store.approveGrant(g.id, aliceId),
    /不能审批自己发起的/,
    '少了这条，审批流就只是多点一次鼠标',
  );

  const other = auth.findUserByUsername('bob')!;
  const approved = store.approveGrant(g.id, other.id);
  assert.equal(approved.requestState, 'approved');
});

test('驳回的申请直接进 revoked，不会留在待办里', () => {
  const g = store.createGrant({
    nodeId: 'node-a',
    keyId: keyA,
    remoteUser: 'deploy',
    requestState: 'pending_approval',
    requestedBy: aliceId,
    grantedBy: aliceId,
  });
  const bob = auth.findUserByUsername('bob')!;
  const r = store.rejectGrant(g.id, bob.id, '不需要这台机器的权限');
  assert.equal(r.requestState, 'rejected');
  assert.equal(r.state, 'revoked');
});

// ————————————————————————————————————————————————————————
// 过期与离场
// ————————————————————————————————————————————————————————

test('过期的授权会被清成 revoked', () => {
  const g = store.createGrant({
    nodeId: 'node-a',
    keyId: keyA,
    remoteUser: 'temp',
    expiresAt: Date.now() - 1000,
    requestState: 'approved',
    requestedBy: aliceId,
    grantedBy: aliceId,
  });
  assert.equal(store.expireGrants(), 1);
  assert.equal(store.getGrant(g.id)!.state, 'revoked');
});

test('离场：一次列出某人的全部有效授权', () => {
  const list = store.grantsOfUser(aliceId);
  assert.ok(list.length > 0);
  assert.ok(
    list.every((g) => g.state !== 'revoked'),
    '已撤销的不该出现在离场清单里',
  );
});

test('有生效授权的公钥不能直接删', () => {
  assert.throws(
    () => store.deleteKey(keyA),
    /先撤销那些授权再删/,
    '直接删的话，机器上会留下一把没人认识的钥匙',
  );
});

// ————————————————————————————————————————————————————————
// 下发队列
// ————————————————————————————————————————————————————————

test('入队后能被对应机器领走，且只领一次', () => {
  commands.enqueue({
    nodeId: 'node-a',
    kind: 'ssh_grant',
    payload: { remoteUser: 'root' },
    preview: ['echo hi'],
    operator: 'alice',
  });

  const first = commands.claimFor('node-a');
  assert.equal(first.length, 1);
  assert.equal(first[0]!.state, 'sent');

  // 领走之后立刻再领应该是空的 —— 否则 agent 每 2 秒上报一次会连发好几遍
  assert.equal(commands.claimFor('node-a').length, 0);
});

test('别的机器领不到不属于它的指令', () => {
  commands.enqueue({
    nodeId: 'node-a',
    kind: 'ssh_revoke',
    payload: {},
    preview: [],
    operator: 'alice',
  });
  assert.equal(
    commands.claimFor('node-b').length,
    0,
    '拿到共享 token 就能拉取别台机器的待办 —— 这正是要堵的',
  );
});

test('回执只认自己那台机器', () => {
  const cmd = commands.enqueue({
    nodeId: 'node-a',
    kind: 'ssh_grant',
    payload: {},
    preview: [],
    operator: 'alice',
  });
  commands.claimFor('node-a');

  assert.equal(
    commands.ack('node-b', { id: cmd.id, ok: true }),
    null,
    '不加这条，任何一台被攻破的机器都能替别的机器"确认"，面板会显示虚假的已撤销',
  );

  const acked = commands.ack('node-a', { id: cmd.id, ok: true });
  assert.equal(acked?.state, 'done');
});

test('失败会重试，超过上限后停手', () => {
  const cmd = commands.enqueue({
    nodeId: 'node-b',
    kind: 'ssh_grant',
    payload: {},
    preview: [],
    operator: 'alice',
  });

  for (let i = 0; i < commands.MAX_ATTEMPTS; i++) {
    commands.claimFor('node-b');
    commands.ack('node-b', { id: cmd.id, ok: false, output: '写入失败' });
  }

  // 再领一次，此时 attempts 已达上限，应该直接判失败而不是继续发
  commands.claimFor('node-b');
  const final = commands.getCommand(cmd.id)!;
  assert.equal(final.state, 'failed', '自动化最危险的不是做错事，是不停地做错事');
  assert.equal(commands.claimFor('node-b').length, 0);
});

test('skipped 也算处理完了', () => {
  const cmd = commands.enqueue({
    nodeId: 'node-a',
    kind: 'ssh_revoke',
    payload: {},
    preview: [],
    operator: 'alice',
  });
  commands.claimFor('node-a');
  const r = commands.ack('node-a', { id: cmd.id, ok: false, skipped: true, output: 'agent 拒绝执行' });
  assert.equal(r?.state, 'done', 'agent 主动拒绝是一个明确的结论，不该无限重试');
});
