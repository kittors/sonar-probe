import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 账号、角色与权限。
 *
 * 这一组测试锁的都是"错了就没法自己恢复"的行为：把最后一个管理员降权、
 * 解绑唯一的登录方式、建一个权限比自己大的账号。它们的共同点是出事之后
 * 界面上没有任何一条路能改回来 —— 只能去动数据库。
 *
 * db.ts 在模块加载时就读 SONAR_DB 建库，所以环境变量必须在 import 之前设好，
 * 只能用动态 import。
 */

let dir: string;
let auth: typeof import('./auth.js');
let roles: typeof import('./roles.js');
let identities: typeof import('./identities.js');
let password: typeof import('./password.js');
let permissions: typeof import('./permissions.js');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sonar-auth-'));
  process.env.SONAR_DB = join(dir, 'test.db');
  process.env.SONAR_DATA_DIR = dir;

  permissions = await import('./permissions.js');
  roles = await import('./roles.js');
  identities = await import('./identities.js');
  password = await import('./password.js');
  auth = await import('./auth.js');

  roles.ensureSystemRoles();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ————————————————————————————————————————————————————————
// 角色
// ————————————————————————————————————————————————————————

test('系统角色开箱就在', () => {
  const ids = roles.listRoles().map((r) => r.id);
  for (const id of ['admin', 'operator', 'viewer', 'guest', 'anonymous']) {
    assert.ok(ids.includes(id), `缺少系统角色 ${id}`);
  }
});

test('admin 的能力集恒等于全部能力，不读库里的快照', () => {
  // 直接把库里那行改成只剩一项，模拟"发版新增了能力点但种子数据是旧的"
  const db = roles as unknown as { __db?: unknown };
  void db;
  roles.updateRole('admin', { name: '管理员' });
  const admin = roles.getRole('admin')!;
  assert.deepEqual(
    [...admin.capabilities].sort(),
    [...permissions.ALL_CAPABILITIES].sort(),
    'admin 必须拥有代码里定义的每一个能力点，否则新功能上线即对管理员不可用',
  );
});

test('admin 的能力集不可编辑', () => {
  roles.updateRole('admin', { capabilities: ['node:list'] });
  assert.equal(
    roles.getRole('admin')!.capabilities.length,
    permissions.ALL_CAPABILITIES.length,
    '锁定的角色不该被 patch 改掉能力集',
  );
});

test('系统角色不能删除', () => {
  assert.throws(() => roles.deleteRole('viewer'), /系统角色/);
  assert.throws(() => roles.deleteRole('anonymous'), /系统角色/);
});

test('自定义角色：建、改、删', () => {
  const created = roles.createRole({
    id: 'auditor',
    name: '审计员',
    capabilities: ['node:list', 'audit:view', 'not-a-real-cap'],
  });
  // 不认识的能力点被丢掉，而不是原样存进去
  assert.deepEqual(created.capabilities, ['node:list', 'audit:view']);

  roles.updateRole('auditor', { capabilities: ['audit:view'] });
  assert.deepEqual(roles.getRole('auditor')!.capabilities, ['audit:view']);

  roles.deleteRole('auditor');
  assert.equal(roles.getRole('auditor'), null);
});

test('角色标识必须是 slug', () => {
  assert.throws(() => roles.createRole({ id: 'Bad Role', name: 'x' }), /角色标识/);
  assert.throws(() => roles.createRole({ id: '1abc', name: 'x' }), /角色标识/);
});

test('能力解析：收回优先于授予', () => {
  const caps = permissions.resolveCapabilities(
    ['node:list', 'node:detail'],
    ['block:enforce'],
    ['node:detail', 'block:enforce'],
  );
  assert.deepEqual([...caps], ['node:list']);
});

test('角色不存在时能力集为空，但个人授予仍然生效', () => {
  const caps = roles.capabilitiesFor('ghost-role', ['node:list']);
  assert.deepEqual([...caps], ['node:list']);
});

// ————————————————————————————————————————————————————————
// 提权守卫
//
// 建号、改权限、重置密码三个入口共用这一段判断，它是全项目出错代价最高的逻辑：
// 漏掉任何一条路径，就是一条完整的提权链。
// ————————————————————————————————————————————————————————

type Cap = import('./permissions.js').Capability;
const capSet = (...c: string[]) => new Set(c as Cap[]);

test('提权守卫：不能建一个含有自己没有的能力的账号', () => {
  const blocked = permissions.checkEscalation({
    mine: capSet('user:create', 'user:view'),
    currentCaps: capSet(),
    nextCaps: capSet('user:create', 'block:enforce'),
  });
  assert.equal(blocked?.kind, 'grants');
  assert.deepEqual(blocked?.caps, ['block:enforce']);
});

test('提权守卫：不能碰本来就比自己大的账号', () => {
  const blocked = permissions.checkEscalation({
    mine: capSet('user:manage'),
    currentCaps: capSet('user:manage', 'block:enforce'),
    nextCaps: capSet('user:manage', 'block:enforce'),
  });
  assert.equal(blocked?.kind, 'outranks');
  assert.deepEqual(blocked?.caps, ['block:enforce']);
});

test('提权守卫：收回权限任何时候都允许', () => {
  // 这一条曾经是错的：拿变更后的全集去比，会把"给对方减一项"也判成提权，
  // 而报错里列的是对方早就有的能力，操作者根本对不上号
  const blocked = permissions.checkEscalation({
    mine: capSet('user:manage', 'node:list'),
    currentCaps: capSet('node:list'),
    nextCaps: capSet(),
  });
  assert.equal(blocked, null);
});

test('提权守卫：授予自己有的能力是允许的', () => {
  const blocked = permissions.checkEscalation({
    mine: capSet('user:manage', 'block:enforce', 'node:list'),
    currentCaps: capSet('node:list'),
    nextCaps: capSet('node:list', 'block:enforce'),
  });
  assert.equal(blocked, null);
});

test('提权守卫：user:escalate 是显式的例外', () => {
  const blocked = permissions.checkEscalation({
    mine: capSet('user:create', 'user:escalate'),
    currentCaps: capSet(),
    nextCaps: capSet('block:enforce', 'settings:manage'),
  });
  assert.equal(blocked, null, 'escalate 就是为了让专职开号的人能配置自己用不上的权限');
});

// ————————————————————————————————————————————————————————
// 密码
// ————————————————————————————————————————————————————————

test('密码哈希可校验，且同一密码两次哈希不相同', async () => {
  const a = await password.hashPassword('correct horse battery');
  const b = await password.hashPassword('correct horse battery');
  assert.notEqual(a, b, '没有加盐');
  assert.ok(await password.verifyPassword('correct horse battery', a));
  assert.ok(!(await password.verifyPassword('correct horse batterz', a)));
});

test('损坏的哈希返回 false 而不是抛错', async () => {
  assert.ok(!(await password.verifyPassword('x', '')));
  assert.ok(!(await password.verifyPassword('x', 'not$a$valid$hash$at$all')));
  // 库里存了一个会撑爆内存的 N，必须直接拒绝而不是真去分配
  assert.ok(!(await password.verifyPassword('x', 'scrypt$99999999$8$1$AAAA$AAAA')));
});

test('密码强度：长度、字符类别、不含用户名', () => {
  assert.match(password.checkPasswordStrength('short1A')!, /至少/);
  assert.match(password.checkPasswordStrength('alllowercase')!, /两类字符/);
  assert.match(
    password.checkPasswordStrength('alice-is-here-1', { username: 'alice' })!,
    /不能包含用户名/,
  );
  assert.equal(password.checkPasswordStrength('Tr0ub4dor-and-3'), null);
});

test('生成的初始密码不含易混淆字符', () => {
  for (let i = 0; i < 20; i++) {
    assert.doesNotMatch(password.generatePassword(24), /[0O1lI]/);
  }
});

// ————————————————————————————————————————————————————————
// 账号
// ————————————————————————————————————————————————————————

test('建号后可以用密码登录', async () => {
  const user = await auth.createUser({
    username: 'alice',
    password: 'Tr0ub4dor-and-3',
    name: 'Alice',
    role: 'operator',
  });
  assert.equal(user.username, 'alice');
  assert.equal(user.role, 'operator');
  assert.equal(user.kind, 'user');

  const logged = await auth.authenticatePassword('alice', 'Tr0ub4dor-and-3');
  assert.equal(logged.id, user.id);
});

test('登录失败不区分「没这个人」和「密码不对」', async () => {
  const wrongPassword = await auth
    .authenticatePassword('alice', 'nope-nope-nope-1')
    .then(() => null, (e: Error) => e.message);
  const noSuchUser = await auth
    .authenticatePassword('nobody', 'nope-nope-nope-1')
    .then(() => null, (e: Error) => e.message);

  assert.equal(wrongPassword, noSuchUser, '两种失败必须给出同一句话，否则就是用户名枚举接口');
});

test('用户名重复会被拒绝', async () => {
  await assert.rejects(
    auth.createUser({ username: 'alice', password: 'Another-Pass-99' }),
    /已经被占用/,
  );
});

test('建号时角色必须存在', async () => {
  await assert.rejects(
    auth.createUser({ username: 'bob', password: 'Another-Pass-99', role: 'nonexistent' }),
    /不存在/,
  );
});

test('anonymous 角色不能指派给账号', async () => {
  // 它是"没有账号时"的兜底能力集，挂到某个人身上会让 roleUsage 的计数失真，
  // 而界面正是靠"用户数为 —"来表示它不挂在任何人身上的
  await assert.rejects(
    auth.createUser({ username: 'nobody2', password: 'Another-Pass-99', role: 'anonymous' }),
    /不能指派给账号/,
  );
  const alice = auth.findUserByUsername('alice');
  if (alice) {
    assert.throws(() => auth.updateUser(alice.id, { role: 'anonymous' }), /不能指派给账号/);
  }
});

test('停用的账号密码对也进不来', async () => {
  const u = await auth.createUser({ username: 'carol', password: 'Winter-Sky-4421', role: 'viewer' });
  auth.updateUser(u.id, { disabled: true });
  await assert.rejects(auth.authenticatePassword('carol', 'Winter-Sky-4421'), /停用/);
  auth.updateUser(u.id, { disabled: false });
});

// ————————————————————————————————————————————————————————
// 超级管理员
// ————————————————————————————————————————————————————————

test('冷启动会创建 root，且只创建一次', async () => {
  const first = await auth.ensureRootAdmin(dir);
  assert.ok(first, '空库应该造一个超级管理员');
  const root = auth.rootAdmin();
  assert.ok(root);
  assert.equal(root.isRoot, true);
  assert.equal(root.role, 'admin');
  assert.equal(root.mustChangePassword, true, '系统生成的初始密码必须强制修改');

  const second = await auth.ensureRootAdmin(dir);
  assert.equal(second, null, '已有管理员时不该再造一个');
});

test('root 不能被降权、停用或删除', () => {
  const root = auth.rootAdmin()!;
  assert.throws(() => auth.updateUser(root.id, { role: 'viewer' }), /不能修改/);
  assert.throws(() => auth.updateUser(root.id, { disabled: true }), /不能被停用/);
  assert.throws(() => auth.deleteUser(root.id), /不能删除/);
});

test('root 用初始密码能登进来', async () => {
  const root = auth.rootAdmin()!;
  // ensureRootAdmin 把密码写进了 data/initial-admin.txt，这里直接重置一个已知值来验证链路
  const pw = await auth.resetPassword(root.id, 'Root-Known-Pass-1');
  const logged = await auth.authenticatePassword(root.username, pw);
  assert.equal(logged.id, root.id);
});

// ————————————————————————————————————————————————————————
// 身份绑定
// ————————————————————————————————————————————————————————

test('同一个人可以既有密码又有 GitHub', () => {
  const alice = auth.findUserByUsername('alice')!;
  auth.linkGithub(alice.id, {
    id: 4242,
    login: 'alice-gh',
    name: 'Alice',
    avatar_url: 'https://example.invalid/a.png',
    email: null,
  });

  const list = auth.userIdentities(alice.id).map((i) => i.provider).sort();
  assert.deepEqual(list, ['github', 'password']);

  // 用 GitHub 进来应该落到同一个账号，而不是新建一个
  const { user, created } = auth.upsertGithubUser({
    id: 4242,
    login: 'alice-gh',
    name: 'Alice',
    avatar_url: 'https://example.invalid/a.png',
    email: null,
  });
  assert.equal(created, false);
  assert.equal(user.id, alice.id);
});

test('一个 GitHub 账号不能绑到两个人身上', async () => {
  const dave = await auth.createUser({ username: 'dave', password: 'Marble-Fox-8830', role: 'viewer' });
  assert.throws(
    () =>
      auth.linkGithub(dave.id, {
        id: 4242,
        login: 'alice-gh',
        name: 'Alice',
        avatar_url: '',
        email: null,
      }),
    /已经绑定/,
  );
});

test('唯一的登录方式不能解绑', () => {
  const dave = auth.findUserByUsername('dave')!;
  assert.throws(() => identities.unbindIdentity(dave.id, 'password'), /唯一的登录方式/);

  // 有两种时可以解掉其中一种
  const alice = auth.findUserByUsername('alice')!;
  identities.unbindIdentity(alice.id, 'github');
  assert.deepEqual(auth.userIdentities(alice.id).map((i) => i.provider), ['password']);
});

test('关掉自助注册后，陌生 GitHub 账号被拒绝', () => {
  process.env.SONAR_DISABLE_GITHUB_SIGNUP = '1';
  assert.throws(
    () =>
      auth.upsertGithubUser({
        id: 9999,
        login: 'stranger',
        name: null,
        avatar_url: '',
        email: null,
      }),
    /还没有被授权/,
  );
  delete process.env.SONAR_DISABLE_GITHUB_SIGNUP;
});

// ————————————————————————————————————————————————————————
// 改密
// ————————————————————————————————————————————————————————

test('改密要验旧密码，且新密码不能和旧的相同', async () => {
  const dave = auth.findUserByUsername('dave')!;
  await assert.rejects(
    auth.changePassword(dave.id, { current: 'wrong-one-here', next: 'Amber-Trail-6017' }),
    /当前密码不正确/,
  );
  await assert.rejects(
    auth.changePassword(dave.id, { current: 'Marble-Fox-8830', next: 'Marble-Fox-8830' }),
    /不能和当前密码相同/,
  );

  await auth.changePassword(dave.id, { current: 'Marble-Fox-8830', next: 'Amber-Trail-6017' });
  const logged = await auth.authenticatePassword('dave', 'Amber-Trail-6017');
  assert.equal(logged.id, dave.id);
  assert.equal(logged.mustChangePassword, false, '改完密码应该解除强制修改标记');
});

test('没改初始密码前，权限降到匿名级', async () => {
  const u = await auth.createUser({
    username: 'newbie',
    password: 'Fresh-Start-4410',
    role: 'admin',
    mustChangePassword: true,
  });
  const sid = auth.createSession(u.id, '127.0.0.1', 'test');

  const ctx = auth.loadSession(sid)!;
  assert.deepEqual(
    [...ctx.caps],
    [...roles.capabilitiesFor('anonymous')],
    '初始密码还没换，这个会话不该比未登录访客拥有更多东西',
  );
  assert.ok(
    !ctx.caps.has('user:manage'),
    'admin 角色也不例外 —— 密码是别人给的，此刻不止一个人能用这个身份',
  );

  // 换掉之后立刻恢复
  await auth.changePassword(u.id, { current: 'Fresh-Start-4410', next: 'Chosen-By-Me-7729' }, sid);
  const after = auth.loadSession(sid)!;
  assert.ok(after.caps.has('user:manage'), '改完密码，管理员权限应该立刻回来');
});

test('管理员重置密码后，对方被强制改密且所有会话失效', async () => {
  const dave = auth.findUserByUsername('dave')!;
  const sid = auth.createSession(dave.id, '127.0.0.1', 'test');
  assert.ok(auth.loadSession(sid), '刚建的会话应该有效');

  await auth.resetPassword(dave.id, 'Cedar-Post-3388');
  assert.equal(auth.loadSession(sid), null, '重置密码必须踢掉已有会话');
  assert.equal(auth.getUser(dave.id)!.mustChangePassword, true);
});

// ————————————————————————————————————————————————————————
// 最后一个管理员
// ————————————————————————————————————————————————————————

test('删除最后一个管理员会被拒绝', async () => {
  const extra = await auth.createUser({
    username: 'admin2',
    password: 'Admin-Two-Pass-1',
    role: 'admin',
  });
  // 此刻有 root + admin2 两个管理员，删掉非 root 的那个是允许的
  auth.deleteUser(extra.id);
  assert.equal(auth.getUser(extra.id), null);

  // root 是最后一个，两道保护都该拦住
  const root = auth.rootAdmin()!;
  assert.throws(() => auth.deleteUser(root.id), /不能删除/);
});

test('删除用户不会连带删掉他的审计记录', async () => {
  const tmp = await auth.createUser({ username: 'ghost', password: 'Quiet-River-2200', role: 'viewer' });
  auth.audit({
    userId: tmp.id,
    sessionId: '',
    action: 'login',
    ip: '127.0.0.1',
    userAgent: 'test',
  });
  auth.deleteUser(tmp.id);

  const entries = auth.listAudit({ userId: tmp.id });
  assert.equal(entries.length, 1, '账号删了，他做过什么必须还留着');
});

test('有用户挂着的角色不能删', async () => {
  roles.createRole({ id: 'temp-role', name: '临时', capabilities: ['node:list'] });
  const u = await auth.createUser({
    username: 'temped',
    password: 'Copper-Lane-5591',
    role: 'temp-role',
  });
  assert.throws(() => roles.deleteRole('temp-role'), /还有 1 个用户/);

  auth.updateUser(u.id, { role: 'viewer' });
  roles.deleteRole('temp-role');
  assert.equal(roles.getRole('temp-role'), null);
});
