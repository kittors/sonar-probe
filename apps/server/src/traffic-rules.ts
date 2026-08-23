import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { listNodeStates } from './store.js';

/**
 * 流量阈值
 *
 * 管理员设定"某台机器某个周期内用超多少就告警"。支持两种表达方式：
 *
 *   absolute — 绝对量，比如"这台机器本月超过 3 TB 就提醒我"
 *   quota    — 配额百分比，比如"用到套餐流量的 80% 就提醒我"
 *
 * 第二种更实用：机器换套餐时不用回来改阈值。
 */

export type RuleScope = 'day' | 'month';
export type RuleCompare = 'absolute' | 'quota';

export interface TrafficRule {
  id: string;
  /** 空字符串表示对所有机器生效 */
  nodeId: string;
  scope: RuleScope;
  /** absolute 时是字节数；quota 时是百分比 0-100 */
  threshold: number;
  compare: RuleCompare;
  enabled: boolean;
  note: string;
  createdBy: string;
  createdAt: number;
  lastFired: number;
  fireCount: number;
}

function rowToRule(r: Record<string, unknown>): TrafficRule {
  return {
    id: r.id as string,
    nodeId: r.node_id as string,
    scope: r.scope as RuleScope,
    threshold: r.threshold as number,
    compare: r.compare as RuleCompare,
    enabled: Number(r.enabled) === 1,
    note: r.note as string,
    createdBy: r.created_by as string,
    createdAt: r.created_at as number,
    lastFired: r.last_fired as number,
    fireCount: r.fire_count as number,
  };
}

export function listTrafficRules(nodeId?: string): TrafficRule[] {
  const rows = nodeId
    ? db
        .prepare('SELECT * FROM traffic_rules WHERE node_id IN (?, "") ORDER BY created_at DESC')
        .all(nodeId)
    : db.prepare('SELECT * FROM traffic_rules ORDER BY created_at DESC').all();
  return (rows as Array<Record<string, unknown>>).map(rowToRule);
}

export function createTrafficRule(input: {
  nodeId: string;
  scope: RuleScope;
  threshold: number;
  compare: RuleCompare;
  note: string;
  createdBy: string;
}): TrafficRule {
  const rule: TrafficRule = {
    id: randomUUID(),
    nodeId: input.nodeId,
    scope: input.scope,
    threshold: input.threshold,
    compare: input.compare,
    enabled: true,
    note: input.note,
    createdBy: input.createdBy,
    createdAt: Date.now(),
    lastFired: 0,
    fireCount: 0,
  };
  db.prepare(`
    INSERT INTO traffic_rules (id,node_id,scope,threshold,compare,enabled,note,created_by,created_at,last_fired,fire_count)
    VALUES (?,?,?,?,?,1,?,?,?,0,0)
  `).run(
    rule.id, rule.nodeId, rule.scope, rule.threshold, rule.compare,
    rule.note, rule.createdBy, rule.createdAt,
  );
  return rule;
}

export function setTrafficRuleEnabled(id: string, enabled: boolean): TrafficRule | null {
  db.prepare('UPDATE traffic_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  const r = db.prepare('SELECT * FROM traffic_rules WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToRule(r) : null;
}

export function deleteTrafficRule(id: string): boolean {
  const res = db.prepare('DELETE FROM traffic_rules WHERE id = ?').run(id);
  return Number(res.changes ?? 0) > 0;
}

// ————————————————————————————————————————————————————————
// 用量与判定
// ————————————————————————————————————————————————————————

function dayKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function monthPrefix(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 7);
}

/** 某台机器在指定周期内的用量。 */
export function usageOf(nodeId: string, scope: RuleScope): { rx: number; tx: number; total: number } {
  const row =
    scope === 'day'
      ? (db
          .prepare('SELECT COALESCE(rx,0) AS rx, COALESCE(tx,0) AS tx FROM daily_traffic WHERE node_id=? AND day=?')
          .get(nodeId, dayKey()) as { rx: number; tx: number } | undefined)
      : (db
          .prepare(
            'SELECT COALESCE(SUM(rx),0) AS rx, COALESCE(SUM(tx),0) AS tx FROM daily_traffic WHERE node_id=? AND day LIKE ?',
          )
          .get(nodeId, `${monthPrefix()}%`) as { rx: number; tx: number });

  const rx = row?.rx ?? 0;
  const tx = row?.tx ?? 0;
  return { rx, tx, total: rx + tx };
}

export interface RuleBreach {
  rule: TrafficRule;
  nodeId: string;
  nodeName: string;
  used: number;
  limit: number;
  percent: number;
}

/**
 * 检查所有规则，返回当前越界的那些。
 *
 * 同一条规则在同一个周期内只报一次：day 规则一天一次，month 规则一个月一次。
 * 不做这个抑制的话，一旦超阈值就会每个 tick 刷一条告警，事件流直接被淹。
 */
export function evaluateTrafficRules(): RuleBreach[] {
  const rules = listTrafficRules().filter((r) => r.enabled);
  if (rules.length === 0) return [];

  const nodes = listNodeStates();
  const breaches: RuleBreach[] = [];
  const now = Date.now();

  for (const rule of rules) {
    const targets = rule.nodeId ? nodes.filter((n) => n.id === rule.nodeId) : nodes;

    for (const node of targets) {
      const { total } = usageOf(node.id, rule.scope);

      let limit: number;
      if (rule.compare === 'quota') {
        // 没设配额的机器无从谈起百分比，跳过
        if (node.trafficQuota <= 0) continue;
        limit = (node.trafficQuota * rule.threshold) / 100;
      } else {
        limit = rule.threshold;
      }

      if (limit <= 0 || total < limit) continue;

      // 同周期内已经报过就不再报
      if (rule.lastFired > 0) {
        const firedKey = rule.scope === 'day' ? dayKey(rule.lastFired) : monthPrefix(rule.lastFired);
        const nowKey = rule.scope === 'day' ? dayKey(now) : monthPrefix(now);
        if (firedKey === nowKey) continue;
      }

      breaches.push({
        rule,
        nodeId: node.id,
        nodeName: node.name,
        used: total,
        limit,
        percent: (total / limit) * 100,
      });
    }
  }

  return breaches;
}

export function markFired(ruleId: string): void {
  db.prepare('UPDATE traffic_rules SET last_fired = ?, fire_count = fire_count + 1 WHERE id = ?').run(
    Date.now(),
    ruleId,
  );
}

/**
 * 流量明细：每台机器在指定天数内的逐日用量 + 当期合计 + 配额占比。
 * 管理页的"详细记录流量消耗"用的就是它。
 */
export function trafficLedger(days = 30) {
  const nodes = listNodeStates();
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

  const rows = db
    .prepare(
      `SELECT node_id, day, rx, tx FROM daily_traffic WHERE day >= ? ORDER BY node_id, day ASC`,
    )
    .all(since) as Array<{ node_id: string; day: string; rx: number; tx: number }>;

  const byNode = new Map<string, Array<{ day: string; rx: number; tx: number }>>();
  for (const r of rows) {
    const list = byNode.get(r.node_id) ?? [];
    list.push({ day: r.day, rx: r.rx, tx: r.tx });
    byNode.set(r.node_id, list);
  }

  return nodes.map((n) => {
    const series = byNode.get(n.id) ?? [];
    const periodRx = series.reduce((a, d) => a + d.rx, 0);
    const periodTx = series.reduce((a, d) => a + d.tx, 0);
    const month = usageOf(n.id, 'month');
    const today = usageOf(n.id, 'day');

    return {
      nodeId: n.id,
      nodeName: n.name,
      countryCode: n.countryCode,
      provider: n.provider,
      quota: n.trafficQuota,
      monthUsed: month.total,
      monthRx: month.rx,
      monthTx: month.tx,
      todayUsed: today.total,
      periodRx,
      periodTx,
      periodTotal: periodRx + periodTx,
      quotaPercent: n.trafficQuota > 0 ? (month.total / n.trafficQuota) * 100 : null,
      dailyAvg: series.length > 0 ? (periodRx + periodTx) / series.length : 0,
      peakDay: series.reduce(
        (best, d) => (d.rx + d.tx > best.total ? { day: d.day, total: d.rx + d.tx } : best),
        { day: '', total: 0 },
      ),
      series,
    };
  });
}
