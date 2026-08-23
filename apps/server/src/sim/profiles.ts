/**
 * 机器画像
 *
 * 每台机器有"性格"：一台跑 MySQL 的机器内存高、外网流量低、磁盘 IO 大；
 * 一台反代机器网络吞吐大、CPU 中等、内存平稳。把这些差异写进画像，
 * 曲线才不会看起来像同一份噪声复制了 12 份。
 */

export type NodeRole = 'edge' | 'app' | 'database' | 'build' | 'storage' | 'probe' | 'mail';

export interface RoleProfile {
  /** CPU 基线占比 0-1 */
  cpuBase: number;
  cpuVolatility: number;
  /** 突发尖峰概率（每个 tick） */
  spikeChance: number;
  spikeMagnitude: number;
  /** 内存占用基线 0-1 */
  memBase: number;
  /** 磁盘占用基线 0-1 */
  diskBase: number;
  /** 下行/上行基线速率 byte/s */
  rxBase: number;
  txBase: number;
  netVolatility: number;
  /**
   * 该角色典型的进程数区间
   *
   * 注意：rxBase / txBase 是「日间峰值速率」而非均值。夜间调制系数会压到 0.15 左右，
   * 全天平均约为峰值的 45%。取值时按配额倒推：月配额 4TB → 日均 133GB → 均速 1.54MB/s
   * → 峰值约 3.4MB/s。不这么校准的话，卡片上的月流量会离配额差一个数量级。
   */
  processes: [number, number];
  connections: [number, number];
  /** 磁盘 IO 基线 byte/s */
  diskIoBase: number;
  /** 该角色跑的服务，权重决定流量占比 */
  services: Array<{ name: string; category: ServiceCategory; weight: number; ports: number[] }>;
}

export type ServiceCategory =
  | 'web'
  | 'database'
  | 'container'
  | 'transfer'
  | 'system'
  | 'app'
  | 'other';

export const ROLE_PROFILES: Record<NodeRole, RoleProfile> = {
  edge: {
    cpuBase: 0.22,
    cpuVolatility: 0.045,
    spikeChance: 0.03,
    spikeMagnitude: 0.35,
    memBase: 0.38,
    diskBase: 0.31,
    rxBase: 7.4e5,
    txBase: 2.9e6,
    netVolatility: 0.42,
    processes: [140, 210],
    connections: [800, 2600],
    diskIoBase: 1.8e6,
    services: [
      { name: 'nginx', category: 'web', weight: 0.58, ports: [80, 443] },
      { name: 'caddy', category: 'web', weight: 0.14, ports: [443, 2019] },
      { name: 'cloudflared', category: 'transfer', weight: 0.12, ports: [7844] },
      { name: 'node', category: 'app', weight: 0.09, ports: [3000, 3001] },
      { name: 'sshd', category: 'system', weight: 0.01, ports: [22] },
      { name: 'systemd-resolved', category: 'system', weight: 0.02, ports: [53] },
      { name: 'containerd', category: 'container', weight: 0.04, ports: [] },
    ],
  },
  app: {
    cpuBase: 0.34,
    cpuVolatility: 0.06,
    spikeChance: 0.05,
    spikeMagnitude: 0.4,
    memBase: 0.55,
    diskBase: 0.42,
    rxBase: 1.2e6,
    txBase: 2.4e6,
    netVolatility: 0.38,
    processes: [190, 280],
    connections: [400, 1400],
    diskIoBase: 3.2e6,
    services: [
      { name: 'node', category: 'app', weight: 0.34, ports: [3000, 8080] },
      { name: 'gunicorn', category: 'app', weight: 0.18, ports: [8000] },
      { name: 'dockerd', category: 'container', weight: 0.16, ports: [2375] },
      { name: 'redis-server', category: 'database', weight: 0.11, ports: [6379] },
      { name: 'nginx', category: 'web', weight: 0.13, ports: [80, 443] },
      { name: 'sshd', category: 'system', weight: 0.02, ports: [22] },
      { name: 'prometheus', category: 'system', weight: 0.06, ports: [9090, 9100] },
    ],
  },
  database: {
    cpuBase: 0.28,
    cpuVolatility: 0.05,
    spikeChance: 0.04,
    spikeMagnitude: 0.3,
    memBase: 0.78,
    diskBase: 0.63,
    rxBase: 6.2e5,
    txBase: 1.15e6,
    netVolatility: 0.3,
    processes: [90, 150],
    connections: [200, 700],
    diskIoBase: 1.4e7,
    services: [
      { name: 'mysqld', category: 'database', weight: 0.46, ports: [3306] },
      { name: 'postgres', category: 'database', weight: 0.27, ports: [5432] },
      { name: 'redis-server', category: 'database', weight: 0.13, ports: [6379] },
      { name: 'mysqldump', category: 'transfer', weight: 0.08, ports: [] },
      { name: 'node_exporter', category: 'system', weight: 0.04, ports: [9100] },
      { name: 'sshd', category: 'system', weight: 0.02, ports: [22] },
    ],
  },
  build: {
    cpuBase: 0.18,
    cpuVolatility: 0.08,
    spikeChance: 0.12,
    spikeMagnitude: 0.72,
    memBase: 0.44,
    diskBase: 0.57,
    rxBase: 4.1e6,
    txBase: 8.4e5,
    netVolatility: 0.6,
    processes: [120, 340],
    connections: [80, 420],
    diskIoBase: 2.6e7,
    services: [
      { name: 'buildkitd', category: 'container', weight: 0.32, ports: [] },
      { name: 'dockerd', category: 'container', weight: 0.24, ports: [2375] },
      { name: 'gitlab-runner', category: 'app', weight: 0.21, ports: [8093] },
      { name: 'git', category: 'transfer', weight: 0.13, ports: [9418] },
      { name: 'npm', category: 'transfer', weight: 0.08, ports: [] },
      { name: 'sshd', category: 'system', weight: 0.02, ports: [22] },
    ],
  },
  storage: {
    cpuBase: 0.12,
    cpuVolatility: 0.03,
    spikeChance: 0.06,
    spikeMagnitude: 0.5,
    memBase: 0.31,
    diskBase: 0.84,
    rxBase: 3.2e6,
    txBase: 5.4e6,
    netVolatility: 0.75,
    processes: [70, 120],
    connections: [60, 320],
    diskIoBase: 4.2e7,
    services: [
      { name: 'minio', category: 'transfer', weight: 0.44, ports: [9000, 9001] },
      { name: 'rsync', category: 'transfer', weight: 0.21, ports: [873] },
      { name: 'restic', category: 'transfer', weight: 0.16, ports: [] },
      { name: 'smbd', category: 'transfer', weight: 0.1, ports: [445] },
      { name: 'nginx', category: 'web', weight: 0.07, ports: [80, 443] },
      { name: 'sshd', category: 'system', weight: 0.02, ports: [22] },
    ],
  },
  mail: {
    cpuBase: 0.09,
    cpuVolatility: 0.025,
    spikeChance: 0.02,
    spikeMagnitude: 0.25,
    memBase: 0.36,
    diskBase: 0.38,
    rxBase: 3.1e5,
    txBase: 4.2e5,
    netVolatility: 0.35,
    processes: [80, 130],
    connections: [40, 260],
    diskIoBase: 8e5,
    services: [
      { name: 'postfix', category: 'app', weight: 0.42, ports: [25, 587] },
      { name: 'dovecot', category: 'app', weight: 0.27, ports: [143, 993] },
      { name: 'rspamd', category: 'app', weight: 0.16, ports: [11332] },
      { name: 'nginx', category: 'web', weight: 0.11, ports: [80, 443] },
      { name: 'sshd', category: 'system', weight: 0.04, ports: [22] },
    ],
  },
  probe: {
    cpuBase: 0.05,
    cpuVolatility: 0.02,
    spikeChance: 0.015,
    spikeMagnitude: 0.2,
    memBase: 0.27,
    diskBase: 0.22,
    rxBase: 6.4e4,
    txBase: 8.2e4,
    netVolatility: 0.25,
    processes: [50, 90],
    connections: [20, 90],
    diskIoBase: 1.2e5,
    services: [
      { name: 'sonar-agent', category: 'system', weight: 0.31, ports: [] },
      { name: 'sshd', category: 'system', weight: 0.14, ports: [22] },
      { name: 'wg-quick', category: 'transfer', weight: 0.29, ports: [51820] },
      { name: 'dnsmasq', category: 'system', weight: 0.16, ports: [53] },
      { name: 'chronyd', category: 'system', weight: 0.1, ports: [123] },
    ],
  },
};

export interface NodeSeed {
  id: string;
  name: string;
  hostname: string;
  role: NodeRole;
  countryCode: string;
  region: string;
  provider: string;
  os: string;
  kernel: string;
  cpuModel: string;
  cpuCores: number;
  memTotalGb: number;
  swapTotalGb: number;
  diskTotalGb: number;
  price: number;
  currency: string;
  billingCycle: 'monthly' | 'quarterly' | 'yearly';
  /** 距今多少天到期 */
  expireInDays: number;
  /** 月流量配额 TB，0 = 不限 */
  trafficQuotaTb: number;
  tags: string[];
  ipPrefix: string;
  /** 已连续运行天数 */
  uptimeDays: number;
  /** 用于制造"离线/告警"这类非健康态 */
  health: 'ok' | 'warning' | 'offline';
}

export const NODE_SEEDS: NodeSeed[] = [
  {
    id: 'hkg-edge-01',
    name: '香港 · 边缘节点',
    hostname: 'hkg-edge-01',
    role: 'edge',
    countryCode: 'HK',
    region: 'Hong Kong',
    provider: 'Akile Cloud',
    os: 'Debian 12',
    kernel: '6.1.0-28-amd64',
    cpuModel: 'AMD EPYC 9754 96-Core',
    cpuCores: 4,
    memTotalGb: 8,
    swapTotalGb: 2,
    diskTotalGb: 120,
    price: 12.9,
    currency: 'USD',
    billingCycle: 'monthly',
    expireInDays: 23,
    trafficQuotaTb: 4,
    tags: ['生产', 'CN2 GIA', '反代'],
    ipPrefix: '154.17',
    uptimeDays: 96,
    health: 'ok',
  },
  {
    id: 'nrt-app-01',
    name: '东京 · 应用主力',
    hostname: 'nrt-app-01',
    role: 'app',
    countryCode: 'JP',
    region: 'Tokyo',
    provider: 'Vultr',
    os: 'Ubuntu 24.04 LTS',
    kernel: '6.8.0-51-generic',
    cpuModel: 'Intel Xeon Platinum 8358',
    cpuCores: 8,
    memTotalGb: 16,
    swapTotalGb: 4,
    diskTotalGb: 320,
    price: 48,
    currency: 'USD',
    billingCycle: 'monthly',
    expireInDays: 7,
    trafficQuotaTb: 5,
    tags: ['生产', 'K3s', '主力'],
    ipPrefix: '45.76',
    uptimeDays: 41,
    health: 'ok',
  },
  {
    id: 'sin-db-01',
    name: '新加坡 · 主库',
    hostname: 'sin-db-01',
    role: 'database',
    countryCode: 'SG',
    region: 'Singapore',
    provider: 'DigitalOcean',
    os: 'Rocky Linux 9.4',
    kernel: '5.14.0-427.el9.x86_64',
    cpuModel: 'AMD EPYC 7763 64-Core',
    cpuCores: 8,
    memTotalGb: 32,
    swapTotalGb: 8,
    diskTotalGb: 640,
    price: 96,
    currency: 'USD',
    billingCycle: 'monthly',
    expireInDays: 58,
    trafficQuotaTb: 6,
    tags: ['生产', '主库', '禁止重启'],
    ipPrefix: '188.166',
    uptimeDays: 212,
    health: 'warning',
  },
  {
    id: 'fra-storage-01',
    name: '法兰克福 · 对象存储',
    hostname: 'fra-storage-01',
    role: 'storage',
    countryCode: 'DE',
    region: 'Frankfurt',
    provider: 'Hetzner',
    os: 'Debian 12',
    kernel: '6.1.0-28-amd64',
    cpuModel: 'AMD Ryzen 9 7950X3D',
    cpuCores: 16,
    memTotalGb: 64,
    swapTotalGb: 8,
    diskTotalGb: 7680,
    price: 52,
    currency: 'EUR',
    billingCycle: 'monthly',
    expireInDays: 134,
    trafficQuotaTb: 0,
    tags: ['备份', 'MinIO', '大盘'],
    ipPrefix: '116.202',
    uptimeDays: 388,
    health: 'ok',
  },
  {
    id: 'lax-edge-02',
    name: '洛杉矶 · 中转',
    hostname: 'lax-edge-02',
    role: 'edge',
    countryCode: 'US',
    region: 'Los Angeles',
    provider: 'RackNerd',
    os: 'Ubuntu 22.04 LTS',
    kernel: '5.15.0-126-generic',
    cpuModel: 'Intel Xeon E5-2680 v4',
    cpuCores: 2,
    memTotalGb: 4,
    swapTotalGb: 2,
    diskTotalGb: 60,
    price: 21.88,
    currency: 'USD',
    billingCycle: 'yearly',
    expireInDays: 3,
    trafficQuotaTb: 3,
    tags: ['中转', '9929'],
    ipPrefix: '198.23',
    uptimeDays: 17,
    health: 'ok',
  },
  {
    id: 'ams-build-01',
    name: '阿姆斯特丹 · 构建机',
    hostname: 'ams-build-01',
    role: 'build',
    countryCode: 'NL',
    region: 'Amsterdam',
    provider: 'Oracle Cloud',
    os: 'Ubuntu 24.04 LTS',
    kernel: '6.8.0-49-generic',
    cpuModel: 'Ampere Altra (aarch64)',
    cpuCores: 4,
    memTotalGb: 24,
    swapTotalGb: 4,
    diskTotalGb: 200,
    price: 0,
    currency: 'USD',
    billingCycle: 'monthly',
    expireInDays: 999,
    trafficQuotaTb: 10,
    tags: ['CI', 'ARM', '白嫖'],
    ipPrefix: '141.147',
    uptimeDays: 62,
    health: 'ok',
  },
  {
    id: 'sea-mail-01',
    name: '西雅图 · 邮件网关',
    hostname: 'sea-mail-01',
    role: 'mail',
    countryCode: 'US',
    region: 'Seattle',
    provider: 'Linode',
    os: 'Debian 11',
    kernel: '5.10.0-33-amd64',
    cpuModel: 'AMD EPYC 7601 32-Core',
    cpuCores: 2,
    memTotalGb: 4,
    swapTotalGb: 1,
    diskTotalGb: 80,
    price: 24,
    currency: 'USD',
    billingCycle: 'monthly',
    expireInDays: 41,
    trafficQuotaTb: 4,
    tags: ['邮件', 'SPF/DKIM'],
    ipPrefix: '45.79',
    uptimeDays: 154,
    health: 'ok',
  },
  {
    id: 'cdg-app-02',
    name: '巴黎 · 应用备机',
    hostname: 'cdg-app-02',
    role: 'app',
    countryCode: 'FR',
    region: 'Paris',
    provider: 'Scaleway',
    os: 'Ubuntu 24.04 LTS',
    kernel: '6.8.0-48-generic',
    cpuModel: 'AMD EPYC 7543P 32-Core',
    cpuCores: 4,
    memTotalGb: 8,
    swapTotalGb: 2,
    diskTotalGb: 160,
    price: 17.99,
    currency: 'EUR',
    billingCycle: 'monthly',
    expireInDays: 71,
    trafficQuotaTb: 0,
    tags: ['备机', '灾备'],
    ipPrefix: '51.15',
    uptimeDays: 88,
    health: 'ok',
  },
  {
    id: 'syd-probe-01',
    name: '悉尼 · 拨测小鸡',
    hostname: 'syd-probe-01',
    role: 'probe',
    countryCode: 'AU',
    region: 'Sydney',
    provider: 'BuyVM',
    os: 'Alpine 3.20',
    kernel: '6.6.60-0-lts',
    cpuModel: 'Intel Xeon E5-2650 v3',
    cpuCores: 1,
    memTotalGb: 1,
    swapTotalGb: 1,
    diskTotalGb: 20,
    price: 3.5,
    currency: 'USD',
    billingCycle: 'monthly',
    expireInDays: 12,
    trafficQuotaTb: 1,
    tags: ['拨测', 'WireGuard'],
    ipPrefix: '107.189',
    uptimeDays: 231,
    health: 'ok',
  },
  {
    id: 'icn-edge-03',
    name: '首尔 · 边缘节点',
    hostname: 'icn-edge-03',
    role: 'edge',
    countryCode: 'KR',
    region: 'Seoul',
    provider: 'Kdatacenter',
    os: 'Debian 12',
    kernel: '6.1.0-27-amd64',
    cpuModel: 'Intel Xeon Gold 6248R',
    cpuCores: 4,
    memTotalGb: 8,
    swapTotalGb: 2,
    diskTotalGb: 100,
    price: 29,
    currency: 'USD',
    billingCycle: 'monthly',
    expireInDays: 19,
    trafficQuotaTb: 3,
    tags: ['生产', '直连'],
    ipPrefix: '103.106',
    uptimeDays: 5,
    health: 'ok',
  },
  {
    id: 'sjc-db-02',
    name: '圣何塞 · 只读副本',
    hostname: 'sjc-db-02',
    role: 'database',
    countryCode: 'US',
    region: 'San Jose',
    provider: 'Vultr',
    os: 'Rocky Linux 9.4',
    kernel: '5.14.0-427.el9.x86_64',
    cpuModel: 'Intel Xeon Platinum 8362',
    cpuCores: 4,
    memTotalGb: 16,
    swapTotalGb: 4,
    diskTotalGb: 320,
    price: 48,
    currency: 'USD',
    billingCycle: 'monthly',
    expireInDays: 88,
    trafficQuotaTb: 4,
    tags: ['只读副本', '生产'],
    ipPrefix: '149.28',
    uptimeDays: 129,
    health: 'ok',
  },
  {
    id: 'waw-probe-02',
    name: '华沙 · 冷备',
    hostname: 'waw-probe-02',
    role: 'probe',
    countryCode: 'PL',
    region: 'Warsaw',
    provider: 'Aeza',
    os: 'Debian 12',
    kernel: '6.1.0-26-amd64',
    cpuModel: 'AMD EPYC 7413 24-Core',
    cpuCores: 2,
    memTotalGb: 2,
    swapTotalGb: 1,
    diskTotalGb: 40,
    price: 4.2,
    currency: 'EUR',
    billingCycle: 'monthly',
    expireInDays: 34,
    trafficQuotaTb: 2,
    tags: ['冷备'],
    ipPrefix: '176.100',
    uptimeDays: 0,
    health: 'offline',
  },
];

/**
 * 对端 IP 池
 *
 * 全部是合成数据，用于演示流量归因和封禁流程。
 * 分三类：正常业务流量、良性扫描（安全研究机构）、需要处置的恶意来源。
 */
export interface PeerSeed {
  ip: string;
  countryCode: string;
  asn: number;
  org: string;
  kind: 'benign' | 'scanner' | 'abusive';
  /** 相对流量权重 */
  weight: number;
  ports: number[];
  reasons: string[];
}

export const BENIGN_PEERS: PeerSeed[] = [
  { ip: '104.16.132.229', countryCode: 'US', asn: 13335, org: 'Cloudflare', kind: 'benign', weight: 1, ports: [443], reasons: [] },
  { ip: '172.67.74.18', countryCode: 'US', asn: 13335, org: 'Cloudflare', kind: 'benign', weight: 0.82, ports: [443], reasons: [] },
  { ip: '142.250.196.110', countryCode: 'US', asn: 15169, org: 'Google LLC', kind: 'benign', weight: 0.55, ports: [443], reasons: [] },
  { ip: '13.107.42.14', countryCode: 'US', asn: 8075, org: 'Microsoft Azure', kind: 'benign', weight: 0.31, ports: [443], reasons: [] },
  { ip: '203.208.60.9', countryCode: 'CN', asn: 24429, org: 'Alibaba (China) Technology', kind: 'benign', weight: 0.44, ports: [443, 80], reasons: [] },
  { ip: '119.29.29.29', countryCode: 'CN', asn: 45090, org: 'Tencent Cloud', kind: 'benign', weight: 0.38, ports: [53, 443], reasons: [] },
  { ip: '151.101.129.140', countryCode: 'US', asn: 54113, org: 'Fastly', kind: 'benign', weight: 0.29, ports: [443], reasons: [] },
  { ip: '146.75.28.132', countryCode: 'NL', asn: 54113, org: 'Fastly', kind: 'benign', weight: 0.24, ports: [443], reasons: [] },
  { ip: '185.199.108.153', countryCode: 'US', asn: 54113, org: 'GitHub Pages', kind: 'benign', weight: 0.19, ports: [443], reasons: [] },
  { ip: '52.216.49.129', countryCode: 'US', asn: 16509, org: 'Amazon S3', kind: 'benign', weight: 0.63, ports: [443], reasons: [] },
  { ip: '162.159.130.233', countryCode: 'US', asn: 13335, org: 'Cloudflare WARP', kind: 'benign', weight: 0.21, ports: [443, 7844], reasons: [] },
  { ip: '95.216.145.72', countryCode: 'FI', asn: 24940, org: 'Hetzner Online', kind: 'benign', weight: 0.34, ports: [873, 443], reasons: [] },
];

export const SCANNER_PEERS: PeerSeed[] = [
  {
    ip: '167.248.133.42',
    countryCode: 'US',
    asn: 398324,
    org: 'Censys Research',
    kind: 'scanner',
    weight: 0.05,
    ports: [22, 80, 443, 3306, 6379, 9200],
    reasons: ['已知安全研究扫描器（Censys）', '短时间内扫描 6 个以上端口'],
  },
  {
    ip: '71.6.146.185',
    countryCode: 'US',
    asn: 10439,
    org: 'Shodan.io',
    kind: 'scanner',
    weight: 0.04,
    ports: [22, 443, 2375, 5432, 27017],
    reasons: ['已知安全研究扫描器（Shodan）', '探测容器与数据库端口'],
  },
  {
    ip: '198.235.24.163',
    countryCode: 'US',
    asn: 396982,
    org: 'Palo Alto Networks Cortex Xpanse',
    kind: 'scanner',
    weight: 0.03,
    ports: [80, 443, 8080, 8443],
    reasons: ['资产测绘扫描器', '仅做端口存活探测'],
  },
];

export const ABUSIVE_PEERS: PeerSeed[] = [
  {
    ip: '45.129.14.207',
    countryCode: 'RU',
    asn: 208091,
    org: 'Xhost Internet Solutions',
    kind: 'abusive',
    weight: 0.02,
    ports: [22],
    reasons: ['SSH 暴力破解：10 分钟内 2,400+ 次失败登录', '连接数极高但流量极小', '来自高风险托管商网段'],
  },
  {
    ip: '193.32.162.89',
    countryCode: 'NL',
    asn: 202425,
    org: 'IP Volume Inc',
    kind: 'abusive',
    weight: 0.09,
    ports: [80, 443],
    reasons: ['HTTP 洪水：单 IP QPS 超过全站均值 40 倍', 'User-Agent 高度重复', '无 Referer 且不加载静态资源'],
  },
  {
    ip: '92.63.197.153',
    countryCode: 'RU',
    asn: 49505, // 合成数据，非真实归属
    org: 'Selectel Cloud',
    kind: 'abusive',
    weight: 0.015,
    ports: [3306, 6379, 27017],
    reasons: ['直连数据库端口，未经过应用层', 'Redis 未授权访问探测特征', '与已知僵尸网络 C2 网段相邻'],
  },
  {
    ip: '103.149.28.44',
    countryCode: 'VN',
    asn: 135905,
    org: 'VIETNAM POSTS AND TELECOM',
    kind: 'abusive',
    weight: 0.31,
    ports: [443, 80],
    reasons: ['单 IP 下载量占全站出站流量 18%', '持续拉取大文件，疑似盗刷流量', '无正常业务访问路径'],
  },
  {
    ip: '141.98.11.62',
    countryCode: 'LT',
    asn: 209588,
    org: 'Flyservers S.A.',
    kind: 'abusive',
    weight: 0.012,
    ports: [22, 3389, 5900],
    reasons: ['多协议远程登录爆破（SSH/RDP/VNC）', '命中蜜罐端口', '被多个威胁情报源标记'],
  },
  {
    ip: '80.94.95.226',
    countryCode: 'BG',
    asn: 401120,
    org: 'CHANGWAY LTD',
    kind: 'abusive',
    weight: 0.006,
    ports: [25, 587],
    reasons: ['SMTP 中继滥用尝试', '批量投递被 rspamd 拦截', '发件域名频繁变化'],
  },
];
