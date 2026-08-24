import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api } from '../lib/api';
import { useAsync, useLiveNode } from '../lib/live';
import { useAuth } from '../lib/auth';
import type { BlockRule, NodeState, PeerTraffic } from '../lib/types';
import {
  ago,
  bytes,
  clockTime,
  count,
  isNearQuota,
  money,
  percent,
  rate,
  ratio,
  safeUrl,
  untilExpire,
  uptime,
} from '../lib/format';

import { Ring } from '../components/charts/Ring';
import { TimeChart } from '../components/charts/TimeChart';
import { TrafficBars } from '../components/charts/TrafficBars';
import { BarList, StackedBar } from '../components/charts/BarList';
import {
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  SERIES,
  threatColor,
  threatLabel,
} from '../components/charts/chart-utils';
import { BlockDialog } from '../components/BlockDialog';
import { NodeEditDialog } from '../components/NodeEditDialog';
import { CountryBadge } from '../components/CountryBadge';
import { Tooltip } from '../components/Tooltip';
import { Chip, EmptyState, Pagination, SectionCard, Segmented, Skeleton, Stat, StatusDot, STATUS_TEXT } from '../components/ui';
import {
  IconBan,
  IconChevronLeft,
  IconClock,
  IconEdit,
  IconExternal,
  IconCpu,
  IconGlobe,
  IconLayers,
  IconServer,
  IconShield,
  IconTerminal,
  IconThermometer,
  IconTrash,
  IconWifiOff,
} from '../components/icons';

type Range = '15m' | '1h' | '6h' | '24h';
type Tab = 'load' | 'traffic' | 'security';

/**
 * 详情页分标签而不是一路铺下去。
 *
 * 之前四大块叠在一条竖线上，看对端 IP 要滚过整整两屏图表。
 * 页头和实时快照常驻（那是"这台机器现在怎么样"的答案），
 * 其余按关注点分开，一次只看一件事。
 */
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'load', label: '负载' },
  { value: 'traffic', label: '流量' },
  { value: 'security', label: '安全' },
];

export function NodeDetail() {
  const { id } = useParams<{ id: string }>();
  const { node, ready } = useLiveNode(id);
  const { can } = useAuth();

  const [tab, setTab] = useState<Tab>('load');
  const [editing, setEditing] = useState(false);
  const [range, setRange] = useState<Range>('1h');
  const [trafficDays, setTrafficDays] = useState<7 | 14 | 30>(30);
  const [blockTarget, setBlockTarget] = useState<PeerTraffic | null>(null);

  // 没权限的接口干脆不发请求 —— 发了也是 403，白白在控制台刷一片红
  const metrics = useAsync(() => api.metrics(id!, range), [id, range]);
  const daily = useAsync(
    () => (can('traffic:daily') ? api.dailyTraffic(id!, trafficDays) : Promise.resolve([])),
    [id, trafficDays],
  );
  const services = useAsync(
    () => (can('traffic:services') ? api.serviceTraffic(id!, 7) : Promise.resolve([])),
    [id],
  );
  const peers = useAsync(
    () => (can('traffic:peers') ? api.peerTraffic(id!, 40) : Promise.resolve([])),
    [id],
  );
  const blocks = useAsync(() => (can('block:view') ? api.blocks(id!) : Promise.resolve([])), [id]);

  // 曲线要跟着实时走。短窗口刷得勤一点，24 小时窗口没必要频繁重拉。
  const { reload: reloadMetrics } = metrics;
  const { reload: reloadPeers } = peers;
  useEffect(() => {
    const period = range === '15m' ? 10_000 : range === '1h' ? 20_000 : 60_000;
    const t = setInterval(reloadMetrics, period);
    return () => clearInterval(t);
  }, [range, reloadMetrics]);

  useEffect(() => {
    const t = setInterval(reloadPeers, 20_000);
    return () => clearInterval(t);
  }, [reloadPeers]);

  /*
   * 还没拿到数据时给骨架，而不是一句"正在加载"。
   *
   * 刷新页面时 WebSocket 要重新握手，这段空窗有几百毫秒到几秒。用文字占位会让
   * 整页先塌成一行字再撑开，视觉上就是"闪一下"；骨架保持和真实内容一样的骨架结构，
   * 数据到了只是填色，布局不跳。
   *
   * ready 为真才说明确实没有这台机器 —— 那时才该说它不存在。
   */
  if (!node) {
    return ready ? (
      <div className="ds-surface">
        <EmptyState
          icon={<IconServer size={28} />}
          title="找不到这台机器"
          hint="它可能已经从面板移除。返回概览看看还有哪些机器在管。"
        />
      </div>
    ) : (
      <NodeDetailSkeleton />
    );
  }

  const m = node.metric;
  const memPct = m ? ratio(m.memUsed, node.memTotal) : 0;
  const diskPct = m ? ratio(m.diskUsed, node.diskTotal) : 0;
  const swapPct = m && node.swapTotal > 0 ? ratio(m.swapUsed, node.swapTotal) : 0;
  const loadPct = m ? Math.min(100, (m.load1 / node.cpuCores) * 100) : 0;
  const expire = untilExpire(node.expireAt);
  // 服务端存的时候已经过滤过协议，这里再查一遍：库里可能有更早版本写进去的脏数据
  const panelUrl = safeUrl(node.panelUrl);

  const ts = metrics.data?.map((x) => x.ts) ?? [];
  // 只在数据窗口真的变了时才重播动画 —— 每 20 秒一次的轮询刷新不该闪
  const chartKey = `${range}:${ts.length}:${ts[0] ?? 0}`;
  const activeRules = blocks.data?.filter((r) => r.state === 'active' || r.state === 'pending') ?? [];
  const blockedIps = new Set(
    blocks.data?.filter((r) => r.state === 'active').map((r) => r.target) ?? [],
  );

  function afterBlock(rule: BlockRule) {
    blocks.reload();
    peers.reload();
    void rule;
  }

  return (
    <>
      {/* —— 返回 —— */}
      <Link
        to="/"
        className="ds-text-body-sm text-ds-description"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          textDecoration: 'none',
          marginBottom: 12,
        }}
      >
        <IconChevronLeft size={14} />
        返回概览
      </Link>

      {/* —— 页头 —— */}
      <header
        className="ds-animate-in"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          flexWrap: 'wrap',
          marginBottom: 18,
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <StatusDot status={node.status} size={9} />
            <h1
              className="ds-text-h1 text-ds-primary"
              style={{ margin: 0 }}
            >
              {node.name}
            </h1>
            <CountryBadge code={node.countryCode} size="lg" title={node.region} />
            <Chip
              color={
                node.status === 'online'
                  ? 'var(--color-ok)'
                  : node.status === 'warning'
                    ? 'var(--color-warn)'
                    : 'var(--color-idle)'
              }
            >
              {STATUS_TEXT[node.status]}
            </Chip>

            {/*
              操作跟标题放一起，而不是混进右边那排数字里 ——
              "已运行/最后上报/到期"是在陈述事实，中间插一个按钮会让人先分辨
              哪个是能点的。图标按钮无边框，安静地待在标题旁边。
            */}
            <span style={{ display: 'inline-flex', gap: 2, marginLeft: 2 }}>
              {panelUrl && (
                <Tooltip content={`在${node.provider || '服务商'}控制台打开`}>
                  <a
                    className="ds-btn-icon"
                    href={panelUrl}
                    target="_blank"
                    // noreferrer 不只是隐私：没有它，目标页能通过 window.opener 把本页
                    // 导航到钓鱼页面（反向标签劫持）
                    rel="noopener noreferrer"
                    aria-label="打开服务商控制台"
                  >
                    <IconExternal size={15} />
                  </a>
                </Tooltip>
              )}
              {can('node:manage') && (
                <Tooltip content="编辑机器信息">
                  <button
                    className="ds-btn-icon"
                    onClick={() => setEditing(true)}
                    aria-label="编辑机器信息"
                  >
                    <IconEdit size={15} />
                  </button>
                </Tooltip>
              )}
            </span>
          </div>
          <p className="ds-text-body text-ds-description" style={{ margin: '6px 0 0' }}>
            {/* provider 可能为空，用 filter 拼接避免出现连续的分隔符 */}
            <span className="tnum">{node.ip}</span>
            {[node.provider, node.region, node.hostname].filter(Boolean).map((x) => ` · ${x}`).join('')}
          </p>
          {node.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 5, marginTop: 9, flexWrap: 'wrap' }}>
              {node.tags.map((t) => (
                <Chip key={t}>{t}</Chip>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 22,
            flexWrap: 'wrap',
            alignItems: 'flex-start',
            paddingTop: 4,
          }}
        >
          <Stat label="已运行" value={m ? uptime(m.uptime) : '—'} />
          <Stat
            label="最后上报"
            value={ago(node.lastSeen)}
            color={node.status === 'offline' ? 'var(--color-warn)' : undefined}
          />
          {/* 没填到期时间就整个不显示。摆一个写着"未设置"的数字位，
              占的是版面，给的是零信息 */}
          {expire.known && (
            <Stat
              label="到期"
              value={expire.text}
              color={expire.urgent ? 'var(--color-warn)' : undefined}
              hint={
                node.price > 0
                  ? `${money(node.price, node.currency)} / ${
                      node.billingCycle === 'yearly'
                        ? '年'
                        : node.billingCycle === 'quarterly'
                          ? '季'
                          : '月'
                    }`
                  : undefined
              }
            />
          )}
        </div>
      </header>

      {node.status === 'offline' && (
        <div
          className="ds-surface"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            marginBottom: 16,
            borderColor: 'color-mix(in srgb, var(--color-warn) 28%, transparent)',
            background: 'color-mix(in srgb, var(--color-warn) 6%, transparent)',
          }}
        >
          <IconWifiOff size={16} style={{ color: 'var(--color-warn)' }} />
          <span className="ds-text-body-sm text-ds-secondary">
            这台机器已失联 {ago(node.lastSeen)}。下面展示的是断线前的最后一批数据。
          </span>
        </div>
      )}

      {/* —— 实时快照 —— */}
      <section
        className="ds-surface ds-animate-in"
        style={{ padding: 18, marginBottom: 16, animationDelay: '60ms' }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(132px, 100%), 1fr))',
            gap: 18,
            alignItems: 'center',
          }}
        >
          <RingCell
            value={m?.cpu ?? 0}
            label="CPU"
            sub={`${node.cpuCores} 核`}
            color={SERIES.cpu}
            icon={<IconCpu size={13} />}
          />
          <RingCell
            value={memPct}
            label="内存"
            sub={`${bytes(m?.memUsed ?? 0, 1)} / ${bytes(node.memTotal, 0)}`}
            color={SERIES.mem}
          />
          <RingCell
            value={diskPct}
            label="磁盘"
            sub={`${bytes(m?.diskUsed ?? 0, 0)} / ${bytes(node.diskTotal, 0)}`}
            color={SERIES.disk}
          />
          <RingCell
            value={loadPct}
            label="负载"
            sub={m ? `${m.load1.toFixed(2)} / ${m.load5.toFixed(2)} / ${m.load15.toFixed(2)}` : '—'}
            color={SERIES.load}
            display={m ? m.load1.toFixed(2) : '—'}
          />

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 13,
              paddingLeft: 4,
              borderLeft: '1px solid var(--ds-border)',
            }}
          >
            <Stat label="实时上行" value={rate(m?.netTx ?? 0)} color={SERIES.tx} />
            <Stat label="实时下行" value={rate(m?.netRx ?? 0)} color={SERIES.rx} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            <Stat label="TCP 连接" value={count(m?.tcpConns ?? 0)} hint={`UDP ${count(m?.udpConns ?? 0)}`} />
            <Stat label="进程数" value={count(m?.processes ?? 0)} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            <Stat
              label="交换分区"
              value={node.swapTotal > 0 ? percent(swapPct, 0) : '未启用'}
              hint={node.swapTotal > 0 ? bytes(node.swapTotal, 0) : undefined}
              color={swapPct > 40 ? 'var(--color-warn)' : undefined}
            />
            <Stat
              label="温度"
              value={m?.tempC != null ? `${m.tempC.toFixed(0)}°C` : '不可用'}
              color={m?.tempC != null && m.tempC > 75 ? 'var(--color-warn)' : undefined}
            />
          </div>
        </div>

        <div
          className="ds-text-caption text-ds-description"
          style={{
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
            marginTop: 16,
            paddingTop: 13,
            borderTop: '1px solid var(--ds-border)',
          }}
        >
          {/* 没有 node:hardware 权限时服务端会把这些字段清空，
              直接拼接会渲染出 "Debian · · amd64" 这种带空段的字符串 */}
          {node.cpuModel && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <IconCpu size={12} /> {node.cpuModel}
            </span>
          )}
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <IconLayers size={12} />{' '}
            {[node.os, node.kernel, node.arch].filter(Boolean).join(' · ')}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <IconThermometer size={12} /> 磁盘读 {rate(m?.diskRead ?? 0)} / 写 {rate(m?.diskWrite ?? 0)}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <IconClock size={12} /> agent v{node.agentVersion}
          </span>
        </div>
      </section>

      {/* —— 分区切换 —— */}
      <div style={{ marginBottom: 14 }}>
        <Segmented value={tab} onChange={setTab} options={TABS} />
      </div>

      {/*
        面板套一层带 key 的容器。
        没有它，切换标签时 React 会认出两边顶层都是 SectionCard 从而复用同一个 DOM，
        CSS 动画只在元素插入时触发，复用就不会重播 —— 表现就是内容"啪"地换掉。
        key 变了才是真的卸载重建，动画才播得出来。
      */}
      <div key={tab} className="ds-tab-panel">

      {/* —— 负载详情 —— */}
      {tab === 'load' && (
      <SectionCard
        className="ds-animate-in"
        style={{ marginBottom: 16 }}
        title="负载详情"
        subtitle={
          metrics.data?.length
            ? `${metrics.data.length} 个采样点 · ${clockTime(ts[0] ?? 0)} 至 ${clockTime(ts[ts.length - 1] ?? 0)}`
            : '正在加载采样数据'
        }
        actions={
          <Segmented
            value={range}
            onChange={setRange}
            options={[
              { value: '15m', label: '15 分钟' },
              { value: '1h', label: '1 小时' },
              { value: '6h', label: '6 小时' },
              { value: '24h', label: '24 小时' },
            ]}
          />
        }
      >
        {metrics.loading && !metrics.data ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
              gap: 22,
            }}
          >
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ display: 'grid', gap: 8 }}>
                <Skeleton height={13} width={96} />
                <Skeleton height={186} radius={10} />
              </div>
            ))}
          </div>
        ) : (
          <div
            /*
             * key 跟着数据窗口走：切时间范围时整块重新挂载，播一次淡入。
             * 不这么做的话曲线会从旧数据"啪"地跳到新数据 —— SVG 的 d 属性没法
             * 靠 CSS 过渡，点数还不一样，只能整体换。
             *
             * 加载期间旧图留在原地并轻微降透明，比先清空再填要稳得多。
             */
            key={chartKey}
            className="ds-chart-swap"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
              gap: 22,
              opacity: metrics.loading ? 0.5 : 1,
              transition: 'opacity 0.18s ease',
            }}
          >
            <ChartBlock title="CPU 与负载" legend={[['CPU', SERIES.cpu], ['1 分钟负载', SERIES.load]]}>
              <TimeChart
                timestamps={ts}
                yMax={100}
                yFormat={(v) => `${v.toFixed(0)}%`}
                series={[
                  {
                    key: 'cpu',
                    label: 'CPU',
                    color: SERIES.cpu,
                    values: metrics.data?.map((x) => x.cpu) ?? [],
                    format: (v) => `${v.toFixed(1)}%`,
                  },
                  {
                    key: 'load',
                    label: '1 分钟负载',
                    color: SERIES.load,
                    // 负载换算成"占核心数的百分比"才能和 CPU 同轴比较
                    values: metrics.data?.map((x) => Math.min(100, (x.load1 / node.cpuCores) * 100)) ?? [],
                    format: (v) => ((v / 100) * node.cpuCores).toFixed(2),
                  },
                ]}
              />
            </ChartBlock>

            <ChartBlock title="内存占用" legend={[['已用内存', SERIES.mem]]}>
              <TimeChart
                timestamps={ts}
                fill
                yMax={100}
                yFormat={(v) => `${v.toFixed(0)}%`}
                series={[
                  {
                    key: 'mem',
                    label: '内存',
                    color: SERIES.mem,
                    values: metrics.data?.map((x) => ratio(x.memUsed, node.memTotal)) ?? [],
                    format: (v) => `${v.toFixed(1)}%  ${bytes((v / 100) * node.memTotal, 1)}`,
                  },
                ]}
              />
            </ChartBlock>

            <ChartBlock title="网络吞吐" legend={[['上行', SERIES.tx], ['下行', SERIES.rx]]}>
              <TimeChart
                timestamps={ts}
                byteScale
                yFormat={(v) => bytes(v, 0)}
                series={[
                  {
                    key: 'tx',
                    label: '上行',
                    color: SERIES.tx,
                    values: metrics.data?.map((x) => x.netTx) ?? [],
                    format: (v) => rate(v),
                  },
                  {
                    key: 'rx',
                    label: '下行',
                    color: SERIES.rx,
                    values: metrics.data?.map((x) => x.netRx) ?? [],
                    format: (v) => rate(v),
                  },
                ]}
              />
            </ChartBlock>

            <ChartBlock title="磁盘 IO" legend={[['读', SERIES.read], ['写', SERIES.write]]}>
              <TimeChart
                timestamps={ts}
                byteScale
                yFormat={(v) => bytes(v, 0)}
                series={[
                  {
                    key: 'read',
                    label: '读取',
                    color: SERIES.read,
                    values: metrics.data?.map((x) => x.diskRead) ?? [],
                    format: (v) => rate(v),
                  },
                  {
                    key: 'write',
                    label: '写入',
                    color: SERIES.write,
                    values: metrics.data?.map((x) => x.diskWrite) ?? [],
                    format: (v) => rate(v),
                  },
                ]}
              />
            </ChartBlock>
          </div>
        )}
      </SectionCard>
      )}

      {/* —— 流量分析 —— */}
      {tab === 'traffic' && (
      <div
        className="ds-animate-in"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
          gap: 16,
          marginBottom: 16,
        }}
      >
        <SectionCard
          title="流量消耗"
          subtitle={
            daily.data
              ? `近 ${trafficDays} 天合计 ${bytes(daily.data.reduce((a, d) => a + d.rx + d.tx, 0))}`
              : '加载中'
          }
          actions={
            <Segmented
              value={String(trafficDays) as '7' | '14' | '30'}
              onChange={(v) => setTrafficDays(Number(v) as 7 | 14 | 30)}
              options={[
                { value: '7', label: '7 天' },
                { value: '14', label: '14 天' },
                { value: '30', label: '30 天' },
              ]}
            />
          }
        >
          {daily.loading && !daily.data ? (
            <Skeleton height={200} />
          ) : (
            <>
              {/* 配额进度排在柱状图之前：先回答"还能用多少"，再看"每天用了多少" */}
              <QuotaBar node={node} />
              <TrafficBars data={daily.data ?? []} height={206} rxColor={SERIES.rx} txColor={SERIES.tx} />
              <div
                style={{
                  display: 'flex',
                  gap: 18,
                  marginTop: 14,
                  paddingTop: 13,
                  borderTop: '1px solid var(--ds-border)',
                  flexWrap: 'wrap',
                }}
              >
                <Stat
                  /* 周期未必是自然月（可按开通日重置），所以标签不能写死"本月" */
                  label="本周期已用"
                  value={bytes(node.trafficUsed)}
                  hint={
                    [
                      `${node.cycleStart.slice(5)} 起`,
                      node.trafficQuota > 0
                        ? `配额 ${bytes(node.trafficQuota, 0)} · ${percent(ratio(node.trafficUsed, node.trafficQuota), 0)}`
                        : '不限量',
                      node.trafficOffset !== 0 ? '含人工校准' : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  }
                  color={
                    // 门槛跟设置里的「配额提醒」走。写死 0.85 的话，这台机器
                    // 在概览页已经被标成"接近配额"，点进详情却还是黑字
                    node.trafficQuota > 0 &&
                    isNearQuota(ratio(node.trafficUsed, node.trafficQuota))
                      ? 'var(--color-warn)'
                      : undefined
                  }
                />
                <Stat
                  label="日均"
                  value={bytes(
                    (daily.data?.reduce((a, d) => a + d.rx + d.tx, 0) ?? 0) /
                      Math.max(1, daily.data?.length ?? 1),
                  )}
                />
                <Stat
                  label="累计上行"
                  value={bytes(daily.data?.reduce((a, d) => a + d.tx, 0) ?? 0)}
                  color={SERIES.tx}
                />
                <Stat
                  label="累计下行"
                  value={bytes(daily.data?.reduce((a, d) => a + d.rx, 0) ?? 0)}
                  color={SERIES.rx}
                />
              </div>
            </>
          )}
        </SectionCard>

        {can('traffic:services') && (
          <SectionCard
            title="流量都被谁吃了"
            subtitle="按进程/服务归因，近 7 天"
            actions={<IconLayers size={14} style={{ color: 'var(--ds-text-description)' }} />}
          >
            {services.loading && !services.data ? (
              <Skeleton height={220} />
            ) : (
              <ServiceBreakdown data={services.data ?? []} />
            )}
          </SectionCard>
        )}
      </div>
      )}

      {tab === 'security' && (
        <>
      {/* —— 对端 IP —— */}
      {can('traffic:peers') && (
        <SectionCard
          className="ds-animate-in"
          style={{ marginBottom: 16, animationDelay: '190ms' }}
          title="对端 IP 流量"
          subtitle="按累计流量排序，可直接对可疑来源下封禁"
          padded={false}
          actions={
            <span className="ds-chip">
              <IconGlobe size={11} />
              {peers.data?.length ?? 0} 个来源
            </span>
          }
        >
          {peers.loading && !peers.data ? (
            <div style={{ padding: 18 }}>
              <Skeleton height={220} />
            </div>
          ) : (
            <PeerTable
              peers={peers.data ?? []}
              blockedIps={blockedIps}
              onBlock={setBlockTarget}
              canBlock={can('block:dryrun')}
            />
          )}
        </SectionCard>
      )}

      {/* —— 封禁规则 —— */}
      {can('block:view') && (
        <SectionCard
          className="ds-animate-in"
          style={{ animationDelay: '230ms' }}
          title="封禁规则"
          subtitle={
            activeRules.length > 0
              ? `${activeRules.filter((r) => r.state === 'active').length} 条生效中，${activeRules.filter((r) => r.state === 'pending').length} 条待下发`
              : '暂无规则'
          }
          padded={false}
          actions={<IconShield size={14} style={{ color: 'var(--ds-text-description)' }} />}
        >
          <RuleList
            rules={blocks.data ?? []}
            canRemove={can('block:remove')}
            onRemoved={() => {
              blocks.reload();
              peers.reload();
            }}
          />
        </SectionCard>
      )}
        </>
      )}

      </div>

      {editing && (
        <NodeEditDialog
          node={node}
          onClose={() => setEditing(false)}
          onSaved={() => {
            // 节点数据走 WebSocket 实时流，服务端保存后会立刻广播，这里不用手动刷
            daily.reload();
          }}
        />
      )}

      {blockTarget && (
        <BlockDialog
          nodeId={node.id}
          nodeName={node.name}
          peer={blockTarget}
          onClose={() => setBlockTarget(null)}
          onDone={afterBlock}
        />
      )}
    </>
  );
}

// ————————————————————————————————————————————————————————
// 局部组件
// ————————————————————————————————————————————————————————

/**
 * 详情页骨架。
 *
 * 形状要贴着真实布局走：页头一行标题 + 一行副信息，下面是实时快照卡片里的
 * 四个环 + 右侧指标，再下面是标签栏。骨架和内容的高度对不上的话，
 * 数据一到页面就会跳一下，那还不如不做。
 */
function NodeDetailSkeleton() {
  return (
    <div className="ds-fade-in" aria-busy="true" aria-label="正在加载机器信息">
      <Skeleton height={13} width={64} style={{ marginBottom: 14 }} />

      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Skeleton height={9} width={9} radius={999} />
          <Skeleton height={28} width={220} />
          <Skeleton height={20} width={26} radius={4} />
          <Skeleton height={20} width={48} radius={999} />
        </div>
        <Skeleton height={14} width={320} />
        <div style={{ display: 'flex', gap: 5, marginTop: 10 }}>
          <Skeleton height={20} width={44} radius={999} />
          <Skeleton height={20} width={52} radius={999} />
        </div>
      </div>

      <div className="ds-glass-card" style={{ padding: 18, marginBottom: 16 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))',
            gap: 18,
            alignItems: 'center',
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: 'grid', justifyItems: 'center', gap: 9 }}>
              <Skeleton height={84} width={84} radius={999} />
              <Skeleton height={12} width={44} />
            </div>
          ))}
          {[0, 1, 2].map((i) => (
            <div key={`m${i}`} style={{ display: 'grid', gap: 8 }}>
              <Skeleton height={12} width={56} />
              <Skeleton height={18} width={82} />
            </div>
          ))}
        </div>
      </div>

      <Skeleton height={34} width={190} radius={10} style={{ marginBottom: 16 }} />
      <Skeleton height={280} radius={16} />
    </div>
  );
}

/**
 * 配额进度条。
 *
 * 探针面板上最该一眼看见的就是"还剩多少"，而不是"已经用了多少" ——
 * 后者是个绝对数字，得先知道配额才能判断它算多还是算少。
 *
 * 颜色分四档，越接近耗尽越扎眼；同时把"按当前速度够不够用到周期结束"算出来，
 * 因为 80% 在周期第 3 天和第 27 天是完全不同的两件事。
 */
function QuotaBar({ node }: { node: NodeState }) {
  // 不限量的机器画一条进度条毫无意义 —— 分母不存在
  if (node.trafficQuota <= 0) {
    return (
      <div className="ds-quota ds-quota-unlimited">
        <span className="ds-text-body-sm text-ds-secondary">
          本周期已用 <span className="tnum" style={{ fontWeight: 600 }}>{bytes(node.trafficUsed)}</span>
        </span>
        <span className="ds-text-caption text-ds-description">不限量 · {node.cycleStart.slice(5)} 起</span>
      </div>
    );
  }

  const pct = Math.min(100, (node.trafficUsed / node.trafficQuota) * 100);
  const left = Math.max(0, node.trafficQuota - node.trafficUsed);

  // 周期进度：用掉的时间比例。拿它和流量比例对比，才知道快慢
  const start = Date.parse(`${node.cycleStart}T00:00:00Z`);
  const end = Date.parse(`${node.cycleEnd}T00:00:00Z`);
  const now = Date.now();
  const timePct = end > start ? Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100)) : 0;
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86_400_000));

  /*
   * 分档。
   *
   * 90% 以上是"随时可能超"，85% 才警告有点晚；
   * 但只看百分比会误判——周期刚开始用了 30% 其实很危险，
   * 所以再叠一条：流量进度显著快于时间进度就提前示警。
   */
  const overspeed = timePct > 8 && pct > timePct + 25;
  const level = pct >= 95 ? 'critical' : pct >= 85 ? 'danger' : pct >= 70 || overspeed ? 'warn' : 'ok';

  // 按当前速度推算够不够用到周期结束
  const projected = timePct > 3 ? (node.trafficUsed / timePct) * 100 : 0;
  const willExceed = projected > node.trafficQuota * 1.02;

  return (
    <div className="ds-quota" data-level={level}>
      <div className="ds-quota-head">
        <span className="ds-text-body-sm">
          <span className="tnum ds-quota-used">{bytes(node.trafficUsed)}</span>
          <span className="text-ds-description"> / {bytes(node.trafficQuota, 0)}</span>
        </span>
        <span style={{ flex: 1 }} />
        <span className="ds-text-caption text-ds-description tnum">
          剩 {bytes(left)} · {daysLeft} 天后重置
        </span>
      </div>

      <div className="ds-quota-track">
        <span className="ds-quota-fill" style={{ width: `${pct}%` }} />
        {/*
          时间刻度线：周期走到哪儿了。
          流量条越过这根线就说明用得比时间快，是最直观的"超速"信号。
        */}
        {timePct > 2 && timePct < 98 && (
          <Tooltip content={`周期已过 ${timePct.toFixed(0)}%`}>
            <span className="ds-quota-tick" style={{ left: `${timePct}%` }} />
          </Tooltip>
        )}
      </div>

      <div className="ds-quota-foot">
        <span className="ds-text-caption ds-quota-pct tnum">{pct.toFixed(1)}%</span>
        {willExceed && level !== 'ok' && (
          <span className="ds-text-caption ds-quota-warn">
            按当前速度，周期结束约需 {bytes(projected, 0)} —— 会超出配额
          </span>
        )}
        {!willExceed && node.trafficOffset !== 0 && (
          <span className="ds-text-caption text-ds-description">含人工校准</span>
        )}
      </div>
    </div>
  );
}

function RingCell({
  value,
  label,
  sub,
  color,
  icon,
  display,
}: {
  value: number;
  label: string;
  sub: string;
  color: string;
  icon?: React.ReactNode;
  display?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7 }}>
      {display ? (
        <div style={{ position: 'relative' }}>
          <Ring value={value} color={color} size={86} sublabel="" />
          {/* 负载显示绝对值更有意义，百分比只用来画环 */}
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              fontSize: 19,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--ds-text-primary)',
              background: 'var(--ds-bg-surface)',
              borderRadius: '50%',
              margin: 14,
            }}
            className="tnum"
          >
            {display}
          </span>
        </div>
      ) : (
        <Ring value={value} color={color} size={86} />
      )}
      <div style={{ textAlign: 'center' }}>
        <div
          className="ds-text-caption text-ds-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center', fontWeight: 500 }}
        >
          {icon}
          {label}
        </div>
        <div className="ds-text-caption text-ds-description tnum">{sub}</div>
      </div>
    </div>
  );
}

function ChartBlock({
  title,
  legend,
  children,
}: {
  title: string;
  legend: Array<[string, string]>;
  children: React.ReactNode;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 6,
          flexWrap: 'wrap',
        }}
      >
        <span className="ds-text-body-sm" style={{ fontWeight: 600, color: 'var(--ds-text-primary)' }}>
          {title}
        </span>
        <span style={{ display: 'flex', gap: 10 }}>
          {legend.map(([label, color]) => (
            <span
              key={label}
              className="ds-text-caption text-ds-description"
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 2, background: color }} />
              {label}
            </span>
          ))}
        </span>
      </div>
      {children}
    </div>
  );
}

function ServiceBreakdown({ data }: { data: Array<import('../lib/types').ServiceTraffic> }) {
  const total = data.reduce((a, s) => a + s.rx + s.tx, 0);

  // 同一分类的服务合并成一段，用来画顶部那根构成条
  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of data) map.set(s.category, (map.get(s.category) ?? 0) + s.rx + s.tx);
    return [...map.entries()]
      .map(([key, value]) => ({
        key,
        value,
        color: CATEGORY_COLOR[key] ?? CATEGORY_COLOR.other!,
        label: CATEGORY_LABEL[key] ?? key,
      }))
      .sort((a, b) => b.value - a.value);
  }, [data]);

  if (data.length === 0) {
    return <EmptyState title="暂无服务流量数据" hint="采集端上报进程级流量后这里会自动填充。" />;
  }

  return (
    <>
      <StackedBar segments={byCategory} />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '9px 0 14px' }}>
        {byCategory.map((c) => (
          <span
            key={c.key}
            className="ds-text-caption text-ds-description"
            style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color }} />
            {c.label}
            <span className="tnum" style={{ color: 'var(--ds-text-secondary)', fontWeight: 500 }}>
              {total > 0 ? `${((c.value / total) * 100).toFixed(0)}%` : '—'}
            </span>
          </span>
        ))}
      </div>

      <BarList
        items={data.slice(0, 9).map((s) => ({
          id: s.service,
          // 状态用标签表达，不塞进名字里 —— "(已结束的连接)" 这种写法会让人
          // 以为真有个叫这名字的进程
          label:
            s.category === 'closed' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {s.service}
                <span
                  className="ds-chip"
                  title="这些连接在采集时已经关闭，无法再对应到具体进程。属于正常现象，占比通常很低。"
                >
                  连接已关闭
                </span>
              </span>
            ) : (
              s.service
            ),
          sublabel:
            s.category === 'closed'
              ? '进程已退出，归属无法追溯'
              : s.ports.length > 0
                ? `${CATEGORY_LABEL[s.category] ?? s.category} · 端口 ${s.ports.join(', ')}`
                : CATEGORY_LABEL[s.category] ?? s.category,
          value: s.rx + s.tx,
          valueText: bytes(s.rx + s.tx),
          subValueText: total > 0 ? `${(((s.rx + s.tx) / total) * 100).toFixed(1)}%` : undefined,
          color: CATEGORY_COLOR[s.category] ?? CATEGORY_COLOR.other!,
        }))}
      />
    </>
  );
}

const PEER_PAGE_SIZE = 12;

function PeerTable({
  peers,
  blockedIps,
  onBlock,
  canBlock,
}: {
  peers: PeerTraffic[];
  blockedIps: Set<string>;
  onBlock: (p: PeerTraffic) => void;
  canBlock: boolean;
}) {
  const [onlySuspicious, setOnlySuspicious] = useState(false);
  const [page, setPage] = useState(0);

  const filtered = onlySuspicious ? peers.filter((p) => p.threatScore >= 40) : peers;
  // 换筛选条件后停在第 3 页会看到空列表，回到第一页
  useEffect(() => setPage(0), [onlySuspicious, peers.length]);

  const shown = filtered.slice(page * PEER_PAGE_SIZE, (page + 1) * PEER_PAGE_SIZE);
  const maxTotal = Math.max(...peers.map((p) => p.rx + p.tx), 1);

  if (peers.length === 0) {
    return (
      <EmptyState
        icon={<IconGlobe size={26} />}
        title="还没有对端流量数据"
        hint="采集端聚合 conntrack 之后，所有连过这台机器的地址都会列在这里。"
      />
    );
  }

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 18px',
          borderBottom: '1px solid var(--ds-border)',
        }}
      >
        <Segmented
          value={onlySuspicious ? 'sus' : 'all'}
          onChange={(v) => setOnlySuspicious(v === 'sus')}
          options={[
            { value: 'all', label: `全部 ${peers.length}` },
            { value: 'sus', label: `可疑 ${peers.filter((p) => p.threatScore >= 40).length}` },
          ]}
        />
        <span style={{ flex: 1 }} />
        <span className="ds-text-caption text-ds-description">
          威胁分基于连接数、流量比例、目标端口和情报标记综合计算
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead>
            <tr className="ds-text-caption text-ds-description">
              {['来源 IP', '归属', '流量占比', '上行', '下行', '连接', '威胁', ''].map((h, i) => (
                <th
                  key={h + i}
                  style={{
                    textAlign: i >= 3 && i <= 5 ? 'right' : 'left',
                    fontWeight: 400,
                    padding: '9px 12px',
                    borderBottom: '1px solid var(--ds-border)',
                    whiteSpace: 'nowrap',
                    background: 'var(--ds-bg-sunken)',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const isBlocked = blockedIps.has(p.ip) || p.blocked;
              const tc = threatColor(p.threatScore);
              return (
                <tr
                  key={p.ip}
                  className="ds-fade-in"
                  style={{
                    borderBottom: '1px solid var(--ds-border)',
                    opacity: isBlocked ? 0.55 : 1,
                  }}
                >
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <span
                      className="ds-text-body-sm tnum"
                      style={{
                        fontWeight: 500,
                        color: 'var(--ds-text-primary)',
                        textDecoration: isBlocked ? 'line-through' : undefined,
                      }}
                    >
                      {p.ip}
                    </span>
                    <div className="ds-text-caption text-ds-description">
                      {p.ports.length > 0 ? `端口 ${p.ports.slice(0, 4).join(', ')}` : '—'}
                    </div>
                  </td>
                  <td style={{ padding: '10px 12px', maxWidth: 190 }}>
                    <div
                      className="ds-text-body-sm text-ds-secondary"
                      style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      <CountryBadge code={p.countryCode} /> {p.org}
                    </div>
                    <div className="ds-text-caption text-ds-description tnum">AS{p.asn}</div>
                  </td>
                  <td style={{ padding: '10px 12px', minWidth: 110 }}>
                    <div
                      style={{
                        height: 5,
                        borderRadius: 999,
                        background: 'var(--ds-bg-sunken)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${((p.rx + p.tx) / maxTotal) * 100}%`,
                          background: tc,
                          borderRadius: 999,
                        }}
                      />
                    </div>
                    <div className="ds-text-caption text-ds-description tnum" style={{ marginTop: 3 }}>
                      {bytes(p.rx + p.tx)}
                    </div>
                  </td>
                  <td
                    className="ds-text-body-sm tnum text-ds-secondary"
                    style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}
                  >
                    {bytes(p.tx)}
                  </td>
                  <td
                    className="ds-text-body-sm tnum text-ds-secondary"
                    style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}
                  >
                    {bytes(p.rx)}
                  </td>
                  <td
                    className="ds-text-body-sm tnum"
                    style={{
                      padding: '10px 12px',
                      textAlign: 'right',
                      color:
                        p.conns > 1500 ? 'var(--color-danger)' : 'var(--ds-text-secondary)',
                      fontWeight: p.conns > 1500 ? 600 : 400,
                    }}
                  >
                    {count(p.conns)}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    {/* 判定依据可能有好几条，提示框的 white-space:pre-line 会保留换行 */}
                    <Tooltip content={p.threatReasons.join('\n') || '无异常信号'}>
                      <span
                        className="ds-chip"
                        style={{
                          color: tc,
                          background: `color-mix(in srgb, ${tc} 10%, transparent)`,
                          borderColor: `color-mix(in srgb, ${tc} 24%, transparent)`,
                        }}
                      >
                        {threatLabel(p.threatScore)} {p.threatScore}
                      </span>
                    </Tooltip>
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                    {isBlocked ? (
                      <span className="ds-chip" style={{ color: 'var(--color-danger)' }}>
                        <IconBan size={11} />
                        已封禁
                      </span>
                    ) : canBlock ? (
                      <button
                        className="ds-btn ds-btn-ghost ds-btn-s"
                        onClick={() => onBlock(p)}
                        style={{ color: p.threatScore >= 50 ? 'var(--color-danger)' : undefined }}
                      >
                        <IconBan size={11} />
                        封禁
                      </button>
                    ) : (
                      <span className="ds-text-caption text-ds-disabled" style={{ color: 'var(--ds-text-disabled)' }}>
                        —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 筛选之后一条都不剩，也要说清楚是筛没了而不是没数据 */}
      {filtered.length === 0 && (
        <EmptyState title="没有可疑来源" hint="当前所有对端的威胁评分都在 40 以下。" />
      )}

      <Pagination
        page={page}
        pageSize={PEER_PAGE_SIZE}
        total={filtered.length}
        onPage={setPage}
      />
    </>
  );
}

const RULE_STATE: Record<string, { text: string; color: string }> = {
  active: { text: '生效中', color: 'var(--color-danger)' },
  pending: { text: '待下发', color: 'var(--color-warn)' },
  expired: { text: '已过期', color: 'var(--ds-text-description)' },
  removed: { text: '已解除', color: 'var(--ds-text-description)' },
  failed: { text: '执行失败', color: 'var(--color-danger)' },
};

function RuleList({
  rules,
  canRemove,
  onRemoved,
}: {
  rules: BlockRule[];
  canRemove: boolean;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (rules.length === 0) {
    return (
      <EmptyState
        icon={<IconShield size={28} />}
        title="还没有封禁记录"
        hint="在上面的对端 IP 列表里选中可疑来源就能创建规则。默认只生成不下发。"
      />
    );
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await api.unblock(id);
      onRemoved();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {rules.map((r) => {
        const st = RULE_STATE[r.state] ?? RULE_STATE.expired!;
        const open = expanded === r.id;
        const live = r.state === 'active' || r.state === 'pending';
        return (
          <div key={r.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '11px 18px',
                flexWrap: 'wrap',
              }}
            >
              <span
                className="ds-text-body-sm tnum"
                style={{ fontWeight: 600, color: 'var(--ds-text-primary)', minWidth: 118 }}
              >
                {r.target}
              </span>
              <span
                className="ds-chip"
                style={{
                  color: st.color,
                  background: `color-mix(in srgb, ${st.color} 10%, transparent)`,
                  borderColor: `color-mix(in srgb, ${st.color} 22%, transparent)`,
                }}
              >
                {st.text}
              </span>
              <Chip>{r.mode === 'enforced' ? 'enforce' : 'dry-run'}</Chip>
              <span
                className="ds-text-caption text-ds-description"
                style={{
                  flex: 1,
                  minWidth: 120,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {r.reason || '未填写原因'}
              </span>
              <span className="ds-text-caption text-ds-description tnum" style={{ whiteSpace: 'nowrap' }}>
                {ago(r.createdAt)}
                {r.expiresAt > 0 && ` · ${untilExpireShort(r.expiresAt)}`}
              </span>
              <button
                className="ds-btn ds-btn-ghost ds-btn-s"
                onClick={() => setExpanded(open ? null : r.id)}
                aria-expanded={open}
              >
                <IconTerminal size={11} />
                命令
              </button>
              {live && canRemove && (
                <button
                  className="ds-btn ds-btn-ghost ds-btn-s"
                  disabled={busy === r.id}
                  onClick={() => void remove(r.id)}
                >
                  <IconTrash size={11} />
                  {busy === r.id ? '解除中…' : '解除'}
                </button>
              )}
            </div>
            {open && (
              <div className="ds-fade-in" style={{ padding: '0 18px 13px' }}>
                <pre
                  style={{
                    margin: 0,
                    padding: '10px 12px',
                    background: 'var(--ds-bg-sunken)',
                    border: '1px solid var(--ds-border)',
                    borderRadius: 8,
                    overflowX: 'auto',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    lineHeight: 1.75,
                    color: 'var(--ds-text-secondary)',
                  }}
                >
                  {r.commands.join('\n')}
                </pre>
                {r.result && (
                  <p className="ds-text-caption text-ds-description" style={{ margin: '7px 0 0' }}>
                    {r.result}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function untilExpireShort(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return '已到期';
  const h = Math.floor(diff / 3600_000);
  if (h >= 24) return `${Math.floor(h / 24)} 天后解封`;
  if (h >= 1) return `${h} 小时后解封`;
  return `${Math.max(1, Math.floor(diff / 60_000))} 分钟后解封`;
}
