import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 机器重启后的流量统计。
 *
 * agent 上报的是网卡的**累计**字节数，服务端存差值。机器一重启，累计值从 0 重新开始，
 * 这时"本次 − 上次"是个大负数。处理不当会有两种坏结果：算成负数把当天流量抹掉，
 * 或者取绝对值凭空多出上千 GB —— 后者更糟，因为它看起来像真的。
 *
 * 这些用例把重启前后的上报序列跑一遍，锁住"重置那一拍不计增量、之后照常累加"的行为。
 */

const GB = 1024 ** 3;
let dir: string;
let ingest: typeof import('./agent-ingest.js');
let db: import('node:sqlite').DatabaseSync;

const NODE = 'reboot-test';

/** 造一份最小可用的上报，只关心累计流量 */
function report(rxTotal: number, txTotal: number) {
  return {
    nodeId: NODE,
    token: '',
    info: {
      id: NODE,
      name: '重启测试机',
      hostname: 'h',
      ip: '203.0.113.9',
      countryCode: 'US',
      region: '',
      provider: '',
      os: 'linux',
      platform: 'linux',
      arch: 'amd64',
      kernel: '',
      cpuModel: '',
      cpuCores: 2,
      memTotal: 4 * GB,
      swapTotal: 0,
      diskTotal: 40 * GB,
      agentVersion: 'test',
      bootTime: 0,
    },
    metric: {
      nodeId: NODE,
      ts: Date.now(),
      cpu: 1,
      memUsed: GB,
      swapUsed: 0,
      diskUsed: GB,
      load1: 0.1,
      load5: 0.1,
      load15: 0.1,
      netRx: 0,
      netTx: 0,
      netRxTotal: rxTotal,
      netTxTotal: txTotal,
      tcpConns: 1,
      udpConns: 0,
      processes: 10,
      uptime: 100,
      tempC: null,
      diskRead: 0,
      diskWrite: 0,
    },
    services: [],
    peers: [],
  } as unknown as Parameters<typeof ingest.ingestReport>[0];
}

function todayTraffic(): number {
  const day = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare('SELECT COALESCE(rx,0) AS rx, COALESCE(tx,0) AS tx FROM daily_traffic WHERE node_id=? AND day=?')
    .get(NODE, day) as { rx: number; tx: number } | undefined;
  return row ? row.rx + row.tx : 0;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sonar-reboot-'));
  process.env.SONAR_DB = join(dir, 'test.db');
  process.env.SONAR_AGENT_TOKEN = 'test-token';
  db = (await import('./db.js')).db;
  ingest = await import('./agent-ingest.js');

  // ingestReport 只接受已登记的机器（防止任何人往面板里塞数据），
  // 所以先手动建档，等价于跑过一次 /api/agent/register
  db.prepare(
    `INSERT INTO nodes (id, name, hostname, ip, cpu_cores, mem_total, disk_total,
                        created_at, last_seen, source)
     VALUES (?, ?, 'h', '203.0.113.9', 2, ?, ?, 0, 0, 'agent')`,
  ).run(NODE, '重启测试机', 4 * GB, 40 * GB);
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('首次上报只建档，不产生增量', () => {
  ingest.ingestReport(report(100 * GB, 50 * GB), '203.0.113.9');
  assert.equal(todayTraffic(), 0, '第一拍没有"上一次"可比，不该凭空记流量');
});

test('正常增长按差值累加', () => {
  ingest.ingestReport(report(102 * GB, 51 * GB), '203.0.113.9');
  assert.equal(todayTraffic(), 3 * GB, '入涨 2 出涨 1，共 3');
});

test('机器重启：累计值归零那一拍不计增量', () => {
  const before = todayTraffic();
  // 重启后网卡计数器从头开始
  ingest.ingestReport(report(1 * GB, 0), '203.0.113.9');
  assert.equal(
    todayTraffic(),
    before,
    '差值为负说明是计数器重置，不是流量减少 —— 这一拍应该跳过',
  );
});

test('重启之后继续正常累加', () => {
  const before = todayTraffic();
  ingest.ingestReport(report(3 * GB, 1 * GB), '203.0.113.9');
  assert.equal(todayTraffic(), before + 3 * GB, '以重启后的值为新起点接着算');
});

test('绝不会凭空多出巨量流量', () => {
  const before = todayTraffic();
  // 连续两次重启，中间还夹一次小幅增长
  ingest.ingestReport(report(0, 0), '203.0.113.9');
  ingest.ingestReport(report(GB / 2, 0), '203.0.113.9');
  ingest.ingestReport(report(0, 0), '203.0.113.9');
  const after = todayTraffic();
  const delta = after - before;
  assert.ok(delta >= 0, '不能倒退');
  assert.ok(delta <= GB, `最多只该多出中间那半个 GB，实际多了 ${(delta / GB).toFixed(2)} GB`);
});

test('面板自己重启也不会重复计数', async () => {
  // 清掉内存缓存，模拟服务端进程重启：此时只能靠数据库里的上一条 metrics 续上
  const before = todayTraffic();
  ingest.resetTotalsCache?.();
  ingest.ingestReport(report(2 * GB, 0), '203.0.113.9');
  const after = todayTraffic();
  assert.ok(
    after - before <= 2 * GB,
    '重启后若拿不到上一次的累计值而从 0 起算，会把整个累计量当成增量记一遍',
  );
});
