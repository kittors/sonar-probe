import { db } from './db.js';
import {
  ALL_CAPABILITIES,
  SYSTEM_ROLE,
  isCapability,
  resolveCapabilities,
  sanitizeCapabilities,
  type Capability,
  type Role,
} from './permissions.js';

/**
 * 角色
 *
 * 角色原先是 permissions.ts 里的一个常量表：加一个角色要改代码、构建、部署。
 * 但"给这批人一个能看流量、看不到对端 IP 的身份"是运行期才冒出来的需求，
 * 不该等发版。所以角色挪进了数据库，能力点留在代码里 —— 分界线的理由见 permissions.ts。
 *
 * 两条不可动摇的约束，都是为了"面板永远有人管得住"：
 *
 *   1. **admin 的能力集不读库**，运行时恒等于 ALL_CAPABILITIES。
 *      否则今天发版加了一个能力点，管理员反而是唯一没有它的人 ——
 *      新功能上线即对所有人不可用，包括本该去授权的那个人。
 *
 *   2. **系统角色不可删除**。admin 没了没人能管，anonymous 没了未登录的人
 *      连概览页都渲染不出来（它决定公开状态页显示到哪一层）。
 */

export interface RoleDef {
  id: string;
  name: string;
  description: string;
  capabilities: Capability[];
  /** 内置角色，不可删除、id 不可改 */
  system: boolean;
  /** 能力集由代码决定，界面上只读 */
  locked: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 系统角色的出厂定义。
 *
 * 只在角色不存在时写入 —— 管理员改过 operator 的能力集之后，重启面板不该把它改回来。
 * 唯一的例外是 admin，它的能力集根本不从这里取。
 */
const SEED: Array<Omit<RoleDef, 'createdAt' | 'updatedAt'>> = [
  {
    id: SYSTEM_ROLE.admin,
    name: '管理员',
    description: '拥有全部能力。能力集由系统维护，不可编辑。',
    capabilities: ALL_CAPABILITIES,
    system: true,
    locked: true,
    sortOrder: 10,
  },
  {
    /*
     * 运维能看设置但不能改。
     *
     * 他要按面板上的数字做判断，就得知道这些数字是按什么口径算出来的 ——
     * "1.83 TB / 2 TB"到底安不安全，取决于进制是 1024 还是 1000。
     * 但改口径影响的是所有人看到的所有数字，那是管理员的决定。
     */
    id: SYSTEM_ROLE.operator,
    name: '运维',
    description: '能处置机器和封禁，能看设置但不能改，不能管用户。',
    capabilities: [
      'node:list', 'node:detail', 'node:full_ip', 'node:hardware', 'node:manage',
      'traffic:daily', 'traffic:services', 'traffic:peers',
      'block:view', 'block:preflight', 'block:dryrun', 'block:enforce', 'block:remove',
      'alert:view', 'alert:manage',
      'audit:view',
      'settings:view',
      /*
       * SSH：能看接入方式、管自己的钥匙、发起授权，但不能审批、不能撤销、
       * 看不到全机队的密钥分布、也不能远程下发。
       *
       * 发起和审批分开是四眼原则；撤销比授权危险（删错就再也进不来）；
       * ssh:audit 是最完整的那张地图；远程下发是唯一能改变机器状态的能力。
       * 这四项都留给管理员。
       */
      'ssh:view', 'ssh:keys', 'ssh:endpoint', 'ssh:grant',
    ],
    system: true,
    locked: false,
    sortOrder: 20,
  },
  {
    id: SYSTEM_ROLE.viewer,
    name: '观察者',
    description: '只读。能看流量归因，但看不到未打码的 IP。',
    capabilities: [
      'node:list', 'node:detail', 'node:hardware',
      'traffic:daily', 'traffic:services', 'traffic:peers',
      'block:view',
      'alert:view',
      'settings:view',
      // 只给"管自己的公钥"：别人给他授权之后，他得能自己登记 key
      'ssh:keys',
    ],
    system: true,
    locked: false,
    sortOrder: 30,
  },
  {
    /*
     * 访客给得很克制：能看机器状态和整体流量，但看不到具体是谁在连、连的哪个端口 ——
     * 那些信息拼起来足以画出你的服务拓扑，不该对未经确认的人开放。
     */
    id: SYSTEM_ROLE.guest,
    name: '访客',
    description: '临时身份，只能看概览和每日流量。',
    capabilities: ['node:list', 'node:detail', 'traffic:daily'],
    system: true,
    locked: false,
    sortOrder: 40,
  },
  {
    /*
     * 完全未登录的人。
     *
     * 概览页是公开的状态页 —— 谁都能看到有几台机器、活着没有、负载多少。
     * 但只到这一层：点进详情要有身份，因为详情页会暴露服务拓扑和对端地址，
     * 而且需要能追溯是谁看的。
     *
     * 这一行不挂在任何用户身上，它是"没有用户时"的兜底能力集。
     * 能力可以改（有人就是不想公开任何东西），但不能删。
     */
    id: SYSTEM_ROLE.anonymous,
    name: '未登录',
    description: '公开状态页的可见范围。不挂在任何账号上。',
    capabilities: ['node:list'],
    system: true,
    locked: false,
    sortOrder: 50,
  },
];

// ————————————————————————————————————————————————————————
// 缓存
// ————————————————————————————————————————————————————————

/**
 * 角色表整份缓存在内存里。
 *
 * 每个请求都要过 loadSession → 解析能力集，那是全站最热的路径之一；
 * 角色却几乎不变。写入方负责失效，Node 单线程下不存在读到半份的问题。
 */
let cache: Map<string, RoleDef> | null = null;

function invalidate(): void {
  cache = null;
}

function rowToRole(r: Record<string, unknown>): RoleDef {
  const id = r.id as string;
  const locked = Number(r.locked) === 1;
  return {
    id,
    name: r.name as string,
    description: (r.description as string) ?? '',
    // admin 恒等于全部能力，库里那份只是快照，见文件头
    capabilities: id === SYSTEM_ROLE.admin
      ? [...ALL_CAPABILITIES]
      : sanitizeCapabilities(JSON.parse((r.capabilities as string) || '[]')),
    system: Number(r.system) === 1,
    locked,
    sortOrder: Number(r.sort_order ?? 100),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

function load(): Map<string, RoleDef> {
  if (cache) return cache;
  const rows = db
    .prepare('SELECT * FROM roles ORDER BY sort_order ASC, id ASC')
    .all() as Array<Record<string, unknown>>;
  const map = new Map<string, RoleDef>();
  for (const r of rows) {
    const role = rowToRole(r);
    map.set(role.id, role);
  }
  cache = map;
  return map;
}

/** 建表后补齐系统角色。已存在的一律不动，避免覆盖管理员的调整。 */
export function ensureSystemRoles(): void {
  const now = Date.now();
  const ins = db.prepare(`
    INSERT INTO roles (id,name,description,capabilities,system,locked,sort_order,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const s of SEED) {
    ins.run(
      s.id, s.name, s.description, JSON.stringify(s.capabilities),
      s.system ? 1 : 0, s.locked ? 1 : 0, s.sortOrder, now, now,
    );
  }

  /*
   * 已存在的系统角色补上 system 标记。
   *
   * 早期版本的库里没有这张表，是这次建的；但如果有人在中间版本手工造过
   * 同名角色，system=0 会让它变成可删除的 —— 删掉 admin 之后没有任何路径能恢复。
   */
  const fix = db.prepare('UPDATE roles SET system=1 WHERE id=? AND system=0');
  for (const s of SEED) fix.run(s.id);
  db.prepare('UPDATE roles SET locked=1 WHERE id=?').run(SYSTEM_ROLE.admin);

  invalidate();
}

// ————————————————————————————————————————————————————————
// 读
// ————————————————————————————————————————————————————————

export function listRoles(): RoleDef[] {
  return [...load().values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export function getRole(id: string): RoleDef | null {
  return load().get(id) ?? null;
}

export function roleExists(id: string): boolean {
  return load().has(id);
}

/**
 * 能不能指派给一个真实账号。
 *
 * anonymous 是"没有账号时"的兜底能力集，把它挂到某个人身上没有意义 ——
 * 那个人会得到一份为陌生人准备的权限，而 roleUsage 里的计数也会跟着失真
 * （界面上靠"用户数为 —"来表示它不挂在任何人身上）。
 *
 * 前端已经把它从下拉里滤掉了，但那只是不碍眼；真正拦住的是这里。
 */
export function roleAssignable(id: string): boolean {
  return roleExists(id) && id !== SYSTEM_ROLE.anonymous;
}

/** 某个角色的能力集。角色不存在时返回空 —— 不认识的角色等于没有任何权限。 */
export function capabilitiesOf(roleId: string): Capability[] {
  return getRole(roleId)?.capabilities ?? [];
}

/**
 * 用户的最终能力集：角色能力 + 单独授予 - 单独收回。
 *
 * 角色被删掉、或者用户挂着一个不存在的角色时，base 是空集 —— 此时个人授予
 * 仍然生效。这是有意的：管理员单独给某人加的能力，不该因为角色变动而静默消失。
 */
export function capabilitiesFor(
  roleId: string,
  granted: readonly string[] = [],
  revoked: readonly string[] = [],
): Set<Capability> {
  return resolveCapabilities(capabilitiesOf(roleId), granted, revoked);
}

/** 每个角色下挂了多少人，管理页要显示，删除前也要查。 */
export function roleUsage(): Map<string, number> {
  const rows = db
    .prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role')
    .all() as Array<{ role: string; n: number }>;
  return new Map(rows.map((r) => [r.role, Number(r.n)]));
}

// ————————————————————————————————————————————————————————
// 写
// ————————————————————————————————————————————————————————

/** 角色 id 走 slug 规则：它会出现在接口和审计日志里，留白和大小写只会带来歧义。 */
const ID_RE = /^[a-z][a-z0-9_-]{1,30}$/;

export class RoleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface RoleInput {
  id?: string;
  name?: string;
  description?: string;
  capabilities?: unknown;
  sortOrder?: number;
}

export function createRole(input: RoleInput): RoleDef {
  const id = String(input.id ?? '').trim().toLowerCase();
  if (!ID_RE.test(id)) {
    throw new RoleError('角色标识只能用小写字母开头，包含字母、数字、下划线、连字符，2-31 位');
  }
  if (roleExists(id)) throw new RoleError('这个角色标识已经存在', 409);

  const name = String(input.name ?? '').trim();
  if (!name) throw new RoleError('角色名称不能为空');

  const now = Date.now();
  db.prepare(`
    INSERT INTO roles (id,name,description,capabilities,system,locked,sort_order,created_at,updated_at)
    VALUES (?,?,?,?,0,0,?,?,?)
  `).run(
    id,
    name.slice(0, 40),
    String(input.description ?? '').trim().slice(0, 200),
    JSON.stringify(sanitizeCapabilities(input.capabilities)),
    Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 100,
    now,
    now,
  );

  invalidate();
  return getRole(id)!;
}

export function updateRole(id: string, patch: RoleInput): RoleDef {
  const current = getRole(id);
  if (!current) throw new RoleError('角色不存在', 404);

  const name = patch.name === undefined ? current.name : String(patch.name).trim().slice(0, 40);
  if (!name) throw new RoleError('角色名称不能为空');

  /*
   * locked 的角色只能改名字和描述。
   *
   * 目前只有 admin 是 locked：允许改它的能力集，等于允许把管理员的
   * user:manage 摘掉 —— 那一步之后没有任何人能把它加回来。
   */
  const capabilities = current.locked || patch.capabilities === undefined
    ? current.capabilities
    : sanitizeCapabilities(patch.capabilities);

  db.prepare('UPDATE roles SET name=?, description=?, capabilities=?, sort_order=?, updated_at=? WHERE id=?')
    .run(
      name,
      patch.description === undefined
        ? current.description
        : String(patch.description).trim().slice(0, 200),
      JSON.stringify(capabilities),
      Number.isFinite(patch.sortOrder) ? Number(patch.sortOrder) : current.sortOrder,
      Date.now(),
      id,
    );

  invalidate();
  return getRole(id)!;
}

/**
 * 删除角色。
 *
 * 还有人挂着就拒绝，而不是把他们静默降级到 viewer —— 那会让一批人的权限
 * 在没有任何人操作他们账号的情况下发生变化，事后从审计日志里也看不出所以然。
 * 让操作者先把人挪走，是多一步，但每一步都留下痕迹。
 */
export function deleteRole(id: string): void {
  const role = getRole(id);
  if (!role) throw new RoleError('角色不存在', 404);
  if (role.system) throw new RoleError('系统角色不能删除', 409);

  const inUse = roleUsage().get(id) ?? 0;
  if (inUse > 0) {
    throw new RoleError(`还有 ${inUse} 个用户是这个角色，先把他们改成别的角色再删`, 409);
  }

  db.prepare('DELETE FROM roles WHERE id=?').run(id);
  invalidate();
}

/** 供测试使用：强制丢弃缓存。 */
export function resetRoleCache(): void {
  invalidate();
}

export type { Capability, Role };
