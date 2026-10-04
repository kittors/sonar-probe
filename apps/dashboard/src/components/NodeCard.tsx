import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import type { NodeState } from '../lib/types';
import { Sparkline } from './charts/Sparkline';
import { MeterBar, StatusBadge, StatusDot, meterTone } from './ui';
import { IconArrowRight, IconDown, IconUp, IconWifiOff } from './icons';
import {
  ago,
  bytes,
  cycleLastDay,
  maskIp,
  monthDay,
  quotaTone,
  rate,
  ratio,
  untilExpire,
} from '../lib/format';
import { CountryBadge } from './CountryBadge';
import { Tooltip } from './Tooltip';

/**
 * 机器卡片。
 *
 * 信息取舍：只放"要不要点进去看"这个决策需要的东西。
 * 具体到哪个进程吃了多少流量，那是详情页的事。
 *
 * 版面是一套固定的骨架：标题 → 四行指标 → 网络与流量 → 标签与到期。
 * 不管有没有配额、到期日、标签，骨架都不变 —— 之前缺了配额的卡片少一根进度条、
 * 缺了标签的少一行，同一排卡片的内容上下错开，网格看起来就是乱的。
 *
 * 配色只有炭黑和橙：平时全是炭黑，哪一项越线才变橙，一眼扫过去就知道该看哪台。
 */

/** 低于 1% 保留一位小数，否则空闲机器显示 0% 会让人以为采集挂了 */
function pct(v: number): string {
  return v > 0 && v < 1 ? v.toFixed(1) : v.toFixed(0);
}

/** 卡片里只放最大的那一级单位："212 天"，详情页再给"212 天 1 小时" */
function shortUptime(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  if (d > 0) return `${d} 天`;
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h} 小时`;
  return `${Math.max(1, Math.floor(seconds / 60))} 分钟`;
}

/**
 * 卡片外壳。
 *
 * 没有详情权限时渲染成普通 div 而不是链接 —— 点了没反应就好，跳到一个"请先登录"
 * 的空页面比什么都不发生更让人费解。也因此它没有悬停反馈：亮起来等于在邀请人点它。
 */
function CardShell({
  node,
  canOpen,
  children,
  className,
  style,
}: {
  node: NodeState;
  canOpen: boolean;
  children: ReactNode;
  className: string;
  style?: React.CSSProperties;
}) {
  if (canOpen) {
    return (
      <Link
        to={`/node/${node.id}`}
        className={className}
        style={style}
        data-status={node.status}
        aria-label={`${node.name}，查看详情`}
      >
        {children}
      </Link>
    );
  }
  return (
    <div className={className} style={style} data-status={node.status}>
      {children}
    </div>
  );
}

export function NodeCard({ node, index = 0 }: { node: NodeState; index?: number }) {
  const { can } = useAuth();
  const canOpen = can('node:detail');
  const m = node.metric;
  const offline = node.status === 'offline';

  const cpu = m?.cpu ?? 0;
  const memPct = m ? ratio(m.memUsed, node.memTotal) : 0;
  const diskPct = m ? ratio(m.diskUsed, node.diskTotal) : 0;
  // 负载和上面两条一样按百分比读数：几行并排时，只有一行是"0.29"这种
  // 绝对值，得先知道机器几核才判断得出它高不高。原始负载放 Tooltip。
  const loadPct = m ? Math.min(100, (m.load1 / Math.max(1, node.cpuCores)) * 100) : 0;

  const hasQuota = node.trafficQuota > 0;
  const quotaPct = hasQuota ? ratio(node.trafficUsed, node.trafficQuota) : 0;
  const expire = untilExpire(node.expireAt);

  // 趋势线的纵轴跟着数据走，不固定在 100%。大多数机器只跑到 10~30%，
  // 固定满量程会把曲线压成贴底的一条直线。绝对值由右边的读数负责。
  const cpuPeak = node.cpuTrend.length > 0 ? Math.max(...node.cpuTrend) : 0;
  const sparkMax = Math.max(Math.ceil(cpuPeak * 1.35), 12);

  const cycle = `${monthDay(node.cycleStart)} – ${monthDay(cycleLastDay(node.cycleEnd))}`;

  return (
    <CardShell
      node={node}
      canOpen={canOpen}
      className="ds-node ds-animate-in"
      style={{ animationDelay: `${Math.min(index * 40, 480)}ms` }}
    >
      {/* —— 标题 —— */}
      <div className="ds-node-head">
        <CountryBadge code={node.countryCode} size="md" title={node.region} />
        <div className="ds-node-name">
          {/* 名字放不下会截断，提示里给出完整的 */}
          <Tooltip content={node.name}>
            <span>{node.name}</span>
          </Tooltip>
          {canOpen && <IconArrowRight size={15} className="ds-node-go" />}
        </div>
        <StatusBadge status={node.status} />
      </div>
      <div className="ds-node-meta">
        {/* provider 可能为空（agent 上报的机器不知道自己是谁家的），直接拼会留下孤零零的分隔符 */}
        {node.provider && `${node.provider} · `}
        <span className="ds-mono" style={{ fontSize: 12.5 }}>
          {maskIp(node.ip)}
        </span>
      </div>

      {/* 离线：说清楚断了多久。下面的读数是断线前最后一次的，整体压灰 */}
      {offline && (
        <div className="ds-node-offline">
          <IconWifiOff size={14} />
          最后上报于 {ago(node.lastSeen)}
        </div>
      )}

      {/* —— 指标 —— */}
      <div className="ds-node-body ds-node-metrics">
        <div className="ds-node-metric">
          <span className="ds-node-k">CPU</span>
          <div className="ds-node-spark">
            {offline || node.cpuTrend.length < 2 ? (
              <MeterBar value={cpu} empty={!m} />
            ) : (
              <Sparkline values={node.cpuTrend} color={meterTone(cpu)} height={22} max={sparkMax} fill={false} />
            )}
          </div>
          <Value v={cpu} empty={!m} />
        </div>
        <MetricRow label="内存" value={memPct} empty={!m} />
        <MetricRow label="磁盘" value={diskPct} empty={!m} />
        <Tooltip
          content={
            m
              ? `1 / 5 / 15 分钟负载 ${m.load1.toFixed(2)} / ${m.load5.toFixed(2)} / ${m.load15.toFixed(2)} · ${node.cpuCores} 核`
              : ''
          }
        >
          <div className="ds-node-metric">
            <span className="ds-node-k">负载</span>
            <MeterBar value={loadPct} empty={!m} />
            <Value v={loadPct} empty={!m} />
          </div>
        </Tooltip>
      </div>

      <div className="ds-node-sep" />

      {/* —— 网络 —— */}
      <div className="ds-node-row ds-node-body">
        <Tooltip content="出站速率">
          <span className="ds-node-rate">
            <IconUp size={13} />
            <b>{m && !offline ? rate(m.netTx) : '—'}</b>
          </span>
        </Tooltip>
        <Tooltip content="入站速率">
          <span className="ds-node-rate">
            <IconDown size={13} />
            <b>{m && !offline ? rate(m.netRx) : '—'}</b>
          </span>
        </Tooltip>
        <span style={{ flex: 1 }} />
        <Tooltip content="已运行时长">
          <span className="ds-node-rate">已运行 {shortUptime(m?.uptime)}</span>
        </Tooltip>
      </div>

      {/* —— 周期流量 —— */}
      {/* 周期未必是自然月（可按开通日重置），标签只说"流量"，起止放提示里 */}
      <Tooltip content={`本流量周期 ${cycle}${hasQuota ? ` · 已用 ${pct(quotaPct)}%` : ' · 不限量'}`}>
        <div className="ds-node-traffic">
          <span className="ds-node-k">流量</span>
          {hasQuota ? (
            // 越线变色的门槛跟设置里的"配额提醒"走：概览页说这台机器接近配额时，
            // 它的进度条必须同时变色，否则两处在讲同一件事却对不上
            <MeterBar value={quotaPct} color={quotaTone(quotaPct)} />
          ) : (
            <span className="ds-node-unlimited">不限量</span>
          )}
          <span style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
            <span className="ds-mono" style={{ color: 'var(--ds-text-primary)' }}>
              {bytes(node.trafficUsed)}
            </span>
            {hasQuota && (
              <span className="ds-mono" style={{ color: 'var(--ds-text-disabled)' }}>
                {' '}
                / {bytes(node.trafficQuota, 0)}
              </span>
            )}
          </span>
        </div>
      </Tooltip>

      {/* —— 标签与到期 —— */}
      <div className="ds-node-foot">
        <div className="ds-node-tags">
          {node.tags.slice(0, 3).map((t) => (
            <span key={t} className="ds-chip">
              {t}
            </span>
          ))}
          {node.tags.length > 3 && (
            <Tooltip content={node.tags.slice(3).join('、')}>
              <span className="ds-chip">+{node.tags.length - 3}</span>
            </Tooltip>
          )}
        </div>
        <Expiry expire={expire} />
      </div>
    </CardShell>
  );
}

function Value({ v, empty }: { v: number; empty: boolean }) {
  return (
    <span
      className="ds-node-v"
      style={{
        color: empty
          ? 'var(--ds-text-disabled)'
          : v >= 80
            ? `color-mix(in srgb, ${meterTone(v)} 85%, var(--ds-text-primary))`
            : undefined,
      }}
    >
      {empty ? '—' : `${pct(v)}%`}
    </span>
  );
}

function MetricRow({ label, value, empty }: { label: string; value: number; empty: boolean }) {
  return (
    <div className="ds-node-metric">
      <span className="ds-node-k">{label}</span>
      <MeterBar value={value} empty={empty} />
      <Value v={value} empty={empty} />
    </div>
  );
}

/**
 * 到期提示。
 *
 * 不急的到期日只是一行灰字；进入提醒窗口才变橙，过期变红。
 * 之前每张卡片都挂着一个"236 天后到期"的方块，真正快到期的那台反而不显眼。
 */
function Expiry({ expire }: { expire: ReturnType<typeof untilExpire> }) {
  if (!expire.known || expire.days > 900) return null;
  const color =
    expire.days < 0
      ? 'color-mix(in srgb, var(--color-danger) 85%, var(--ds-text-primary))'
      : expire.urgent
        ? 'color-mix(in srgb, var(--color-warn) 85%, var(--ds-text-primary))'
        : 'var(--ds-text-description)';
  return (
    <span style={{ fontSize: 12.5, whiteSpace: 'nowrap', color }}>
      {expire.text}
    </span>
  );
}

/**
 * 列表视图的一行 —— 机器多的时候网格太占地方。
 *
 * 列名写全称。之前三列占用条的表头是 C / M / D，第一次看的人得猜。
 */
export function NodeRow({ node }: { node: NodeState }) {
  const { can } = useAuth();
  const canOpen = can('node:detail');
  const m = node.metric;
  const memPct = m ? ratio(m.memUsed, node.memTotal) : 0;
  const diskPct = m ? ratio(m.diskUsed, node.diskTotal) : 0;
  const offline = node.status === 'offline';
  const hasQuota = node.trafficQuota > 0;
  const quotaPct = hasQuota ? ratio(node.trafficUsed, node.trafficQuota) : 0;

  const cells = (
    <>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <StatusDot status={node.status} />
        <CountryBadge code={node.countryCode} title={node.region} />
        <span style={{ minWidth: 0 }}>
          <span
            className="ds-ellipsis"
            style={{ display: 'block', fontSize: 14, fontWeight: 500, color: 'var(--ds-text-primary)' }}
          >
            {node.name}
          </span>
          <span className="ds-mono" style={{ fontSize: 12, color: 'var(--ds-text-description)' }}>
            {offline ? `离线 · ${ago(node.lastSeen)}` : maskIp(node.ip)}
          </span>
        </span>
      </span>

      <span style={{ minWidth: 0 }}>
        <span className="ds-text-body-sm text-ds-secondary ds-ellipsis" style={{ display: 'block' }}>
          {node.provider || '—'}
        </span>
        <span className="ds-text-caption text-ds-description ds-ellipsis" style={{ display: 'block' }}>
          {node.region}
        </span>
      </span>

      <MiniMeter value={m?.cpu ?? 0} empty={!m} />
      <MiniMeter value={memPct} empty={!m} />
      <MiniMeter value={diskPct} empty={!m} />

      <span className="ds-mono" style={{ display: 'grid', gap: 2, fontSize: 12, color: 'var(--ds-text-secondary)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <IconUp size={12} style={{ color: 'var(--ds-text-description)' }} />
          {m && !offline ? rate(m.netTx) : '—'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <IconDown size={12} style={{ color: 'var(--ds-text-description)' }} />
          {m && !offline ? rate(m.netRx) : '—'}
        </span>
      </span>

      <span style={{ display: 'grid', gap: 6, minWidth: 0 }}>
        <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
          <span className="ds-mono" style={{ color: 'var(--ds-text-primary)' }}>
            {bytes(node.trafficUsed)}
          </span>
          <span className="ds-mono" style={{ color: 'var(--ds-text-disabled)' }}>
            {hasQuota ? ` / ${bytes(node.trafficQuota, 0)}` : ''}
          </span>
          {!hasQuota && <span style={{ color: 'var(--ds-text-disabled)' }}> · 不限量</span>}
        </span>
        {hasQuota && <MeterBar value={quotaPct} color={quotaTone(quotaPct)} height={3} />}
      </span>
    </>
  );

  if (canOpen) {
    return (
      <Link to={`/node/${node.id}`} className="ds-node-table-row" data-status={node.status}>
        {cells}
      </Link>
    );
  }
  return (
    <div className="ds-node-table-row" data-status={node.status}>
      {cells}
    </div>
  );
}

function MiniMeter({ value, empty }: { value: number; empty: boolean }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <span className="ds-mini-meter">
      <MeterBar value={v} empty={empty} height={3} />
      <span
        style={{
          color: empty
            ? 'var(--ds-text-disabled)'
            : v >= 80
              ? `color-mix(in srgb, ${meterTone(v)} 85%, var(--ds-text-primary))`
              : 'var(--ds-text-secondary)',
        }}
      >
        {empty ? '—' : `${pct(v)}%`}
      </span>
    </span>
  );
}
