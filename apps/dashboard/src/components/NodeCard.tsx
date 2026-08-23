import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import type { NodeState } from '../lib/types';
import { Sparkline } from './charts/Sparkline';
import { Chip, Meter, STATUS_COLOR, STATUS_TEXT, StatusDot } from './ui';
import { IconDown, IconUp, IconWifiOff } from './icons';
import { ago, bytes, maskIp, rate, ratio, untilExpire, uptime } from '../lib/format';
import { CountryBadge } from './CountryBadge';
import { Tooltip } from './Tooltip';

/**
 * 机器卡片。
 *
 * 信息取舍：只放"要不要点进去看"这个决策需要的东西。
 * 具体到哪个进程吃了多少流量，那是详情页的事。
 */
/**
 * 卡片外壳。
 *
 * 没有详情权限时渲染成普通 div 而不是链接 —— 点了没反应就好，
 * 跳到一个"请先登录"的空页面比什么都不发生更让人费解。
 */
function CardShell({
  node,
  canOpen,
  children,
  ...rest
}: {
  node: NodeState;
  canOpen: boolean;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  if (canOpen) {
    return (
      <Link to={`/node/${node.id}`} {...rest} style={{ ...rest.style, textDecoration: 'none', color: 'inherit' }}>
        {children}
      </Link>
    );
  }
  return (
    <Tooltip content="登录后可查看这台机器的详情">
      <div {...rest} style={{ ...rest.style, cursor: 'default' }}>
        {children}
      </div>
    </Tooltip>
  );
}

export function NodeCard({ node, index = 0 }: { node: NodeState; index?: number }) {
  const { can } = useAuth();
  const canOpen = can('node:detail');
  const m = node.metric;
  const offline = node.status === 'offline';
  const accent = STATUS_COLOR[node.status];

  const cpu = m?.cpu ?? 0;
  const memPct = m ? ratio(m.memUsed, node.memTotal) : 0;
  const diskPct = m ? ratio(m.diskUsed, node.diskTotal) : 0;

  const quotaPct = node.trafficQuota > 0 ? ratio(node.trafficUsed, node.trafficQuota) : 0;
  const expire = untilExpire(node.expireAt);

  // 趋势线的纵轴跟着数据走，不固定在 100%。
  // 大多数机器只跑到 10~30%，固定满量程会把所有曲线压成贴底的一条直线，
  // 趋势就完全看不出来了。绝对值由旁边的百分比数字负责表达。
  const cpuPeak = node.cpuTrend.length > 0 ? Math.max(...node.cpuTrend) : 0;
  const sparkMax = Math.max(Math.ceil(cpuPeak * 1.35), 12);

  return (
    <CardShell
      node={node}
      canOpen={canOpen}
      className={`ds-glass-card ds-animate-in${canOpen ? ' ds-lift' : ''}`}
      style={{
        display: 'block',
        position: 'relative',
        padding: 0,
        overflow: 'hidden',
        animationDelay: `${Math.min(index * 40, 400)}ms`,
        // 离线机器压暗，让在线的机器在网格里跳出来
        opacity: offline ? 0.62 : 1,
      }}
    >
      {/* 告警/离线时顶部一条渐变提示线，比整卡变色克制得多 */}
      {node.status !== 'online' && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          }}
        />
      )}

      <div style={{ padding: '15px 16px 14px' }}>
        {/* —— 标题行 —— */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5 }}>
            <StatusDot status={node.status} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            {/* 名字放不下会截断，提示里给出完整的 */}
            <Tooltip content={node.name}>
              <div
                className="ds-text-subtitle"
                style={{
                  color: 'var(--ds-text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  lineHeight: 1.3,
                }}
              >
                {node.name}
              </div>
            </Tooltip>
            <div
              className="ds-text-caption text-ds-description"
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                marginTop: 1,
              }}
            >
              {/* provider 可能为空（agent 上报的机器不知道自己是谁家的），
                  直接拼会留下一个孤零零的分隔符 */}
              {node.provider && `${node.provider} · `}
              <span className="tnum">{maskIp(node.ip)}</span>
            </div>
          </div>
          <CountryBadge code={node.countryCode} title={node.region} />
        </div>

        {/* —— 趋势线 —— */}
        <div style={{ margin: '11px -16px 9px', position: 'relative' }}>
          {offline ? (
            <div
              style={{
                height: 38,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                color: 'var(--ds-text-disabled)',
              }}
            >
              <IconWifiOff size={13} />
              <span className="ds-text-caption">最后上报于 {ago(node.lastSeen)}</span>
            </div>
          ) : (
            <>
              <Sparkline values={node.cpuTrend} color={accent} height={38} max={sparkMax} />
              <span
                className="ds-text-caption tnum"
                style={{
                  position: 'absolute',
                  left: 16,
                  top: 0,
                  color: 'var(--ds-text-description)',
                  pointerEvents: 'none',
                }}
              >
                {/* 低于 1% 时保留一位小数：一台空闲机器显示"CPU 0%"会让人以为采集挂了 */}
                CPU {cpu < 1 ? cpu.toFixed(1) : cpu.toFixed(0)}%
              </span>
            </>
          )}
        </div>

        {/* —— 指标 —— */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Meter label="内存" value={memPct} empty={!m} compact />
          <Meter label="磁盘" value={diskPct} empty={!m} compact />
          <Meter
            label="负载"
            value={m ? Math.min(100, (m.load1 / node.cpuCores) * 100) : 0}
            detail={m ? m.load1.toFixed(2) : undefined}
            empty={!m}
            compact
          />
        </div>

        {/* —— 网络速率 —— */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            marginTop: 11,
            paddingTop: 11,
            borderTop: '1px solid var(--ds-border)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <IconUp size={12} style={{ color: 'var(--color-brand)' }} />
            <span className="ds-text-caption tnum text-ds-secondary" style={{ fontWeight: 500 }}>
              {m ? rate(m.netTx) : '—'}
            </span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <IconDown size={12} style={{ color: 'var(--color-ok)' }} />
            <span className="ds-text-caption tnum text-ds-secondary" style={{ fontWeight: 500 }}>
              {m ? rate(m.netRx) : '—'}
            </span>
          </span>
          <span style={{ flex: 1 }} />
          <span className="ds-text-caption text-ds-description tnum">
            {m ? uptime(m.uptime) : '—'}
          </span>
        </div>

        {/* —— 月流量与到期 —— */}
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 5,
            }}
          >
            {/* 周期未必是自然月（可按开通日重置），标签只说"周期"，起止放 title 里 */}
            <Tooltip content={`本流量周期 ${node.cycleStart} 至 ${node.cycleEnd}`}>
            <span className="ds-text-caption text-ds-description">
              周期流量{' '}
              <span className="tnum" style={{ color: 'var(--ds-text-secondary)', fontWeight: 500 }}>
                {bytes(node.trafficUsed)}
              </span>
              {node.trafficQuota > 0 && (
                <span className="tnum"> / {bytes(node.trafficQuota, 0)}</span>
              )}
            </span>
            </Tooltip>
            {expire.known && expire.days <= 900 && (
              <Chip color={expire.urgent ? 'var(--color-warn)' : undefined}>{expire.text}</Chip>
            )}
          </div>
          {node.trafficQuota > 0 ? (
            <div
              style={{
                height: 3,
                borderRadius: 999,
                background: 'var(--ds-bg-sunken)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, quotaPct)}%`,
                  borderRadius: 999,
                  background:
                    quotaPct >= 90
                      ? 'var(--color-danger)'
                      : quotaPct >= 75
                        ? 'var(--color-warn)'
                        : 'var(--color-brand)',
                  transition: 'width 0.6s cubic-bezier(0.4,0,0.2,1)',
                }}
              />
            </div>
          ) : (
            <div style={{ height: 3 }} />
          )}
        </div>

        {/* —— 标签 —— */}
        {node.tags.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' }}>
            {node.tags.slice(0, 3).map((t) => (
              <Chip key={t}>{t}</Chip>
            ))}
            {node.status !== 'online' && (
              <Chip color={accent}>{STATUS_TEXT[node.status]}</Chip>
            )}
          </div>
        )}
      </div>
    </CardShell>
  );
}

/** 列表视图的一行 —— 机器多的时候网格太占地方。 */
export function NodeRow({ node }: { node: NodeState }) {
  const { can } = useAuth();
  const canOpen = can('node:detail');
  const m = node.metric;
  const memPct = m ? ratio(m.memUsed, node.memTotal) : 0;
  const diskPct = m ? ratio(m.diskUsed, node.diskTotal) : 0;

  return (
    <CardShell
      node={node}
      canOpen={canOpen}
      className="ds-fade-in"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(180px,1.6fr) 90px repeat(3, minmax(88px,1fr)) minmax(120px,1.1fr) 92px',
        alignItems: 'center',
        gap: 12,
        padding: '11px 16px',
        borderBottom: '1px solid var(--ds-border)',
        transition: 'background-color 0.15s',
        opacity: node.status === 'offline' ? 0.6 : 1,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <StatusDot status={node.status} />
        <CountryBadge code={node.countryCode} title={node.region} />
        <span style={{ minWidth: 0 }}>
          <span
            className="ds-text-body-sm"
            style={{
              display: 'block',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {node.name}
          </span>
          <span className="ds-text-caption text-ds-description tnum">{maskIp(node.ip)}</span>
        </span>
      </span>

      <span className="ds-text-caption text-ds-description" style={{ minWidth: 0 }}>
        {node.provider}
      </span>

      <Meter label="C" value={m?.cpu ?? 0} empty={!m} compact />
      <Meter label="M" value={memPct} empty={!m} compact />
      <Meter label="D" value={diskPct} empty={!m} compact />

      <span className="ds-text-caption tnum text-ds-secondary" style={{ display: 'flex', gap: 8 }}>
        <span style={{ color: 'var(--color-brand)' }}>↑{m ? rate(m.netTx) : '—'}</span>
        <span style={{ color: 'var(--color-ok)' }}>↓{m ? rate(m.netRx) : '—'}</span>
      </span>

      <span className="ds-text-caption tnum text-ds-description" style={{ textAlign: 'right' }}>
        {bytes(node.trafficUsed)}
      </span>
    </CardShell>
  );
}
