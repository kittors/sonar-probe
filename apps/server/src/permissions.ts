/**
 * 能力点
 *
 * 粒度是"按钮级"：每个会产生后果的操作都是一个独立的能力点，前端拿它决定按钮显不显示，
 * 后端拿它决定请求放不放行。**两边都要判** —— 前端隐藏按钮只是不碍眼，
 * 真正拦住越权的是后端那道。
 *
 * 这份定义前后端各有一份镜像（apps/dashboard/src/lib/permissions.ts），改动时两边都要动。
 *
 * ——————————————————————————————————————————————
 *
 * 这里**只有能力点**，没有角色。
 *
 * 角色和它的能力集在数据库里（roles 表，见 roles.ts），运行期可增删改；
 * 能力点则必须留在代码里，因为每一个都一一对应路由上的 requireCap。
 * 让人在界面上凭空造一个 'node:destroy' 存进库，不会有任何代码去读它 ——
 * 那不是一项权限，只是一行让人误以为生效了的配置。
 *
 * 判断标准：**新增能力点必然伴随新增代码，所以它属于代码。**
 */

export const CAPABILITIES = {
  // —— 浏览
  'node:list': { label: '查看机器列表', group: '浏览', risk: 'low' },
  'node:detail': { label: '进入机器详情页', group: '浏览', risk: 'low' },
  'node:full_ip': { label: '查看未打码的 IP 地址', group: '浏览', risk: 'medium' },
  'node:hardware': { label: '查看硬件与系统信息', group: '浏览', risk: 'low' },
  'node:manage': { label: '编辑机器信息（价格、配额、到期）', group: '浏览', risk: 'medium' },

  // —— 流量
  'traffic:daily': { label: '查看每日流量', group: '流量', risk: 'low' },
  'traffic:services': { label: '查看服务流量归因', group: '流量', risk: 'medium' },
  'traffic:peers': { label: '查看对端 IP 流量', group: '流量', risk: 'medium' },

  // —— 封禁
  'block:view': { label: '查看封禁规则', group: '封禁', risk: 'low' },
  'block:preflight': { label: '预检封禁目标', group: '封禁', risk: 'low' },
  'block:dryrun': { label: '生成封禁规则（不下发）', group: '封禁', risk: 'medium' },
  'block:enforce': { label: '真正下发封禁到机器', group: '封禁', risk: 'high' },
  'block:remove': { label: '解除封禁', group: '封禁', risk: 'high' },

  // —— 告警
  'alert:view': { label: '查看流量阈值', group: '告警', risk: 'low' },
  'alert:manage': { label: '增删改流量阈值', group: '告警', risk: 'medium' },

  // —— SSH
  /*
   * 别名 + 端口 + 账号拼起来就是一张完整的入侵路线图，所以定 medium 而不是 low ——
   * 按 anonymous 只给 node:list 的克制程度，这个绝不能给访客。
   */
  'ssh:view': { label: '查看 SSH 接入方式与别名', group: 'SSH', risk: 'medium' },
  /*
   * 管自己的公钥不产生跨用户后果，观察者也该有 —— 否则别人给你授权了，
   * 你还得先找管理员帮你登记 key。
   */
  'ssh:keys': { label: '管理自己的公钥', group: 'SSH', risk: 'low' },
  'ssh:endpoint': { label: '编辑机器的 SSH 别名与连接方式', group: 'SSH', risk: 'medium' },
  /*
   * 能看到全机队所有密钥的分布，是这套系统里最完整的那张地图。
   * 默认不给运维。
   */
  'ssh:audit': { label: '查看机器上的密钥实况与漂移', group: 'SSH', risk: 'high' },
  'ssh:grant': { label: '发起 SSH 授权', group: 'SSH', risk: 'high' },
  'ssh:approve': { label: '审批 SSH 授权申请', group: 'SSH', risk: 'high' },
  'ssh:revoke': { label: '撤销 SSH 授权', group: 'SSH', risk: 'high' },
  /*
   * 这一项单独存在，是因为它是整个面板唯一一处"远程改变机器状态"的能力。
   * 不加它时，面板只产出文本，人拿去自己执行 —— 面板被攻破也拿不到任何机器。
   */
  'ssh:remote_apply': { label: '经 agent 远程下发密钥变更', group: 'SSH', risk: 'high' },

  // —— 管理
  'audit:view': { label: '查看访问审计与在线用户', group: '管理', risk: 'medium' },
  'user:view': { label: '查看用户列表', group: '管理', risk: 'medium' },
  'user:manage': { label: '改用户角色与权限', group: '管理', risk: 'high' },
  /*
   * 建号和改权限分开。
   *
   * 前者是"把人放进来"，后者是"决定他能干什么"—— 值班的人常需要开一个只读账号
   * 给临时协作方，但不该顺手就能把自己提成管理员。
   */
  'user:create': { label: '创建与删除用户账号', group: '管理', risk: 'high' },
  /*
   * 提权闸门。
   *
   * 默认情况下，谁都不能创建或授予**自己没有的**能力 —— 否则一个只有
   * user:create 的人可以建一个 admin 账号再登进去，一步就把"能开号"变成
   * "能干任何事"。这是权限系统里最经典的提权路径。
   *
   * 但一刀切会挡住一类正当需求：专职开账号的人（入职、外包对接）需要给别人
   * 配置他自己用不上的权限，总不能为了给运维开号，先把自己变成运维。
   *
   * 所以照 Kubernetes RBAC 的 escalate 动词来做：默认拒绝，需要时显式授予。
   * 拿到它等于拿到了通往任何权限的路，所以标签必须把这件事说破，
   * 不能让人以为这只是"建号权限的一个补充选项"。
   */
  'user:escalate': {
    label: '授予自己没有的权限（等同于可自我提权）',
    group: '管理',
    risk: 'high',
  },
  /*
   * 改角色比改某个人的权限影响面大一个数量级：一次编辑会同时改变所有挂着
   * 这个角色的人，而那些人此刻正开着页面。所以单独一个能力点，不并进 user:manage。
   */
  'role:manage': { label: '增删改角色及其能力集', group: '管理', risk: 'high' },
  'settings:view': { label: '查看通用设置', group: '管理', risk: 'low' },
  /*
   * 改设置算高危，理由不在"能改坏页面"，而在两件有实际后果的事：
   * 改流量口径会让所有人的配额百分比一起变（可能把一台快超额的机器
   * 显示成安全的），改保留天数会真的删掉指标和审计记录。
   */
  'settings:manage': { label: '修改通用设置（口径、阈值、保留策略）', group: '管理', risk: 'high' },
} as const;

export type Capability = keyof typeof CAPABILITIES;

export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

const CAPABILITY_SET = new Set<string>(ALL_CAPABILITIES);

/**
 * 角色 id。
 *
 * 曾经是 'admin' | 'operator' | ... 的字面量联合，现在角色可以由管理员任意创建，
 * 类型上就只能是字符串了。取而代之的约束在运行期：写入前必须查得到对应的 roles 行。
 */
export type Role = string;

/** 系统内置角色的 id。它们不可删除，且各自带着额外约束，见 roles.ts。 */
export const SYSTEM_ROLE = {
  admin: 'admin',
  operator: 'operator',
  viewer: 'viewer',
  guest: 'guest',
  anonymous: 'anonymous',
} as const;

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}

/**
 * 把任意输入收敛成一组合法能力点。
 *
 * 未知的能力点直接丢弃而不是报错：一次降级发布（代码里删掉了某个能力点）之后，
 * 库里存着的旧值会全表残留，为此拒绝整个角色的保存只会让人改不动任何东西。
 */
export function sanitizeCapabilities(input: unknown): Capability[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<Capability>();
  for (const item of input) {
    if (isCapability(item)) out.add(item);
  }
  // 按定义顺序输出，让存进库的 JSON 稳定可比对
  return ALL_CAPABILITIES.filter((c) => out.has(c));
}

/**
 * 算出最终能力集：角色能力 + 单独授予 - 单独收回。
 *
 * 收回优先于授予 —— 出现冲突时按更严格的那个来。
 */
export function resolveCapabilities(
  base: readonly string[],
  granted: readonly string[] = [],
  revoked: readonly string[] = [],
): Set<Capability> {
  const set = new Set<Capability>();
  for (const c of base) {
    if (isCapability(c)) set.add(c);
  }
  for (const c of granted) {
    if (isCapability(c)) set.add(c);
  }
  for (const c of revoked) {
    set.delete(c as Capability);
  }
  return set;
}

/**
 * 提权检查
 *
 * 三个入口共用同一套判断：建号、改权限、重置密码。三处各写一遍的话，
 * 迟早有一处漏掉 —— 而漏掉的那一处就是完整的提权路径，攻击者只需要找到最弱的那个。
 *
 * 抽成纯函数还有一个理由：它是这个项目里出错代价最高的一段逻辑，
 * 却因为原先埋在路由处理器里而无法单测。
 */
export type EscalationBlock =
  /** 目标账号本来就拥有你没有的能力 —— 碰他的权限或密码都等于越权 */
  | { kind: 'outranks'; caps: Capability[] }
  /** 这次改动会新增你自己都没有的能力 */
  | { kind: 'grants'; caps: Capability[] };

export function checkEscalation(input: {
  /** 操作者的能力集 */
  mine: Set<Capability>;
  /** 目标当前的能力集。建新账号时传空集 */
  currentCaps: Set<Capability>;
  /** 目标变更后的能力集 */
  nextCaps: Set<Capability>;
}): EscalationBlock | null {
  const { mine, currentCaps, nextCaps } = input;

  // 显式的提权授权，见 CAPABILITIES 里 user:escalate 那段说明
  if (mine.has('user:escalate')) return null;

  const outranks = [...currentCaps].filter((c) => !mine.has(c));
  if (outranks.length > 0) return { kind: 'outranks', caps: outranks };

  /*
   * 只看**新增**的部分。
   *
   * 收回权限任何时候都是安全的，拿变更后的全集去比会把"给运维减一项权限"
   * 也判成提权 —— 那时报错里列出的是对方早就有的能力，操作者根本对不上号。
   */
  const granted = [...nextCaps].filter((c) => !currentCaps.has(c) && !mine.has(c));
  if (granted.length > 0) return { kind: 'grants', caps: granted };

  return null;
}

/** 能力点按展示分组，管理页用它渲染权限矩阵。 */
export function groupedCapabilities(): Array<{
  group: string;
  items: Array<{ key: Capability; label: string; risk: string }>;
}> {
  const map = new Map<string, Array<{ key: Capability; label: string; risk: string }>>();
  for (const key of ALL_CAPABILITIES) {
    const meta = CAPABILITIES[key];
    const list = map.get(meta.group) ?? [];
    list.push({ key, label: meta.label, risk: meta.risk });
    map.set(meta.group, list);
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }));
}
