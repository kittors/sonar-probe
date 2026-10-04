import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api } from '../lib/api';
import { useAsync, useLiveNode } from '../lib/live';
import { useAuth } from '../lib/auth';
import { trafficDirectionLabel, useSettings } from '../lib/settings';
import type { BlockRule, NodeState, PeerTraffic } from '../lib/types';
import {
  ago,
  bytes,
  clockTime,
  count,
  cycleLastDay,
  isNearQuota,
  money,
  monthDay,
  percent,
  rate,
  ratio,
  safeUrl,
  trafficTotal,
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
import {
  DateRangePicker,
  dayCount,
  isSameRange,
  lastNDays,
  sinceDay,
  type Range as DayRange,
  type RangePreset,
} from '../components/DateRangePicker';
import { NodeEditDialog } from '../components/NodeEditDialog';
import { CountryBadge } from '../components/CountryBadge';
import { Tooltip } from '../components/Tooltip';
import {
  Alert,
  Badge,
  Chip,
  EmptyState,
  Pagination,
  SectionCard,
  Segmented,
  Skeleton,
  Stat,
  StatusBadge,
  Tabs,
} from '../components/ui';
import {
  IconActivity,
  IconBan,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconCpu,
  IconDown,
  IconEdit,
  IconExternal,
  IconGlobe,
  IconLayers,
  IconServer,
  IconShield,
  IconTerminal,
  IconThermometer,
  IconTrash,
  IconUp,
  IconWifiOff,
} from '../components/icons';

/** 负载曲线的时间窗，和流量的日期区间是两码事，别混用一个名字 */
type MetricRange = '15m' | '1h' | '6h' | '24h';
type Tab = 'load' | 'traffic' | 'security';

export function NodeDetail() {
  const { id } = useParams<{ id: string }>();
  const { node, ready } = useLiveNode(id);
  const { can } = useAuth();

  const [tab, setTab] = useState<Tab>('load');
  const [editing, setEditing] = useState(false);
  const [range, setRange] = useState<MetricRange>('1h');
  const [blockTarget, setBlockTarget] = useState<PeerTraffic | null>(null);

  /*
   * 流量的日期区间。三张流量卡片共用它。
   *
   * 默认落在**当前计费周期**而不是"近 30 天"：人打开这一页最常问的是
   * "这个周期还剩多少配额"，而周期起点取决于账单日，跟自然月往往对不上。
   * cycleStart 要等 WebSocket 推来第一帧才有，所以先用近 30 天兜着，
   * 拿到之后再切过去（下面那个 effect）。
   */
  const [trafficRange, setTrafficRange] = useState<DayRange>(() => lastNDays(30));
  const [rangePinned, setRangePinned] = useState(false);
  const cycleStart = node?.cycleStart;

  useEffect(() => {
    // 人一旦自己选过区间，就不要再被这里覆盖掉
    if (rangePinned || !cycleStart) return;
    setTrafficRange(sinceDay(cycleStart));
  }, [cycleStart, rangePinned]);

  const pickRange = (r: DayRange) => {
    setRangePinned(true);
    setTrafficRange(r);
  };

  /** 快捷项。"本周期"没拿到账单日之前是灰的，不假装它可用 */
  const presets = useMemo<RangePreset[]>(
    () => [
      { key: 'cycle', label: '本周期', range: () => (cycleStart ? sinceDay(cycleStart) : null) },
      { key: '7d', label: '近 7 天', range: () => lastNDays(7) },
      { key: '14d', label: '近 14 天', range: () => lastNDays(14) },
      { key: '30d', label: '近 30 天', range: () => lastNDays(30) },
      { key: '90d', label: '近 90 天', range: () => lastNDays(90) },
    ],
    [cycleStart],
  );
  const activePreset = presets.find((p) => isSameRange(trafficRange, p.range()))?.key;

  // 没权限的接口干脆不发请求 —— 发了也是 403，白白在控制台刷一片红
  const metrics = useAsync(() => api.metrics(id!, range), [id, range]);
  const daily = useAsync(
    () => (can('traffic:daily') ? api.dailyTraffic(id!, trafficRange) : Promise.resolve([])),
    [id, trafficRange],
  );
  const services = useAsync(
    () => (can('traffic:services') ? api.serviceTraffic(id!, trafficRange) : Promise.resolve([])),
    [id, trafficRange],
  );
  const peers = useAsync(
    () => (can('traffic:peers') ? api.peerTraffic(id!, trafficRange, 40) : Promise.resolve([])),
    [id, trafficRange],
  );
  const blocks = useAsync(() => (can('block:view') ? api.blocks(id!) : Promise.resolve([])), [id]);

  /*
   * 区间内"会被账单扣掉的那个数"。
   *
   * 按面板设置的计费方向合并，和服务端算 trafficUsed 是同一个口径 ——
   * 否则机房只计出站时，卡片标题写着"合计 846 GB"、正下方的配额条写着
   * "399 GB / 1 TB"，两个数字在同一张卡片里对不上。
   */
  const { trafficDirection } = useSettings();
  const billedSum = useMemo(
    () => (daily.data ?? []).reduce((a, d) => a + trafficTotal(d.rx, d.tx), 0),
    // trafficDirection 不在函数体里出现，但 trafficTotal 读的就是它 —— 口径变了要重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [daily.data, trafficDirection],
  );
  // 只计单向时把口径写出来，不然"合计"比柱子加起来少一半，看着像漏数据
  const directionNote =
    trafficDirection === 'both' ? '' : `（${trafficDirectionLabel(trafficDirection)}）`;

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
   * 整页先塌成一行字再撑开，视觉上就是"闪一下"；骨架保持和真实内容一样的结构，
   * 数据到了只是填色，布局不跳。
   *
   * ready 为真才说明确实没有这台机器 —— 那时才该说它不存在。
   */
  if (!node) {
    return ready ? (
      <div className="ds-surface">
        <EmptyState
          icon={<IconServer size={22} />}
          title="找不到这台机器"
          hint="它可能已经从面板移除。返回概览看看还有哪些机器在管。"
          action={
            <Link to="/" className="ds-btn ds-btn-ghost">
              返回机器概览
            </Link>
          }
        />
      </div>
    ) : (
      <NodeDetailSkeleton />
    );
  }

  const m = node.metric;
  const offline = node.status === 'offline';
  const memPct = m ? ratio(m.memUsed, node.memTotal) : 0;
  const diskPct = m ? ratio(m.diskUsed, node.diskTotal) : 0;
  const swapPct = m && node.swapTotal > 0 ? ratio(m.swapUsed, node.swapTotal) : 0;
  const loadPct = m ? Math.min(100, (m.load1 / Math.max(1, node.cpuCores)) * 100) : 0;
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

  // 安全页里两块都没权限看的话，这个标签就是一张白纸，不如不给
  const showSecurity = can('traffic:peers') || can('block:view');
  const tabs: Array<{ value: Tab; label: string; count?: number }> = [
    { value: 'load', label: '负载' },
    { value: 'traffic', label: '流量' },
    ...(showSecurity
      ? [{ value: 'security' as Tab, label: '安全', count: activeRules.length || undefined }]
      : []),
  ];
  const activeTab: Tab = tabs.some((t) => t.value === tab) ? tab : 'load';

  const billing =
    node.price > 0
      ? `${money(node.price, node.currency)} / ${
          node.billingCycle === 'yearly' ? '年' : node.billingCycle === 'quarterly' ? '季' : '月'
        }`
      : undefined;

  function afterBlock() {
    blocks.reload();
    peers.reload();
  }

  return (
    <>
      <section className="ds-hero" style={{ display: 'block' }}>
        <span className="ds-sq ds-sq-edge" style={{ left: 0, top: '100%' }} aria-hidden="true" />
        <span className="ds-sq ds-sq-edge" style={{ left: '100%', top: '100%' }} aria-hidden="true" />
        <nav className="ds-breadcrumb" aria-label="当前位置">
          <Link to="/">机器概览</Link>
          <IconChevronRight size={12} />
          <span aria-current="page">{node.name}</span>
        </nav>

        {/* —— 页头 —— */}
        <header className="ds-detail-head">
          <span style={{ display: 'flex', paddingTop: 6 }}>
            <CountryBadge code={node.countryCode} size="lg" title={node.region} />
          </span>
          {/* 伸缩基准取 240 而不是更大：手机上一旦放不下，旗帜会单独占一行，标题被挤到下面 */}
          <div style={{ minWidth: 0, flex: '1 1 240px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 className="ds-page-title">{node.name}</h1>
              <StatusBadge status={node.status} />
            </div>
            <div
              className="ds-page-desc"
              style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 5 }}
            >
              <CopyText text={node.ip} label="IP" />
              {/* provider 可能为空，逐段拼接避免出现连续的分隔符 */}
              {[node.provider, node.region, node.hostname].filter(Boolean).map((x) => (
                <span key={x} style={{ display: 'contents' }}>
                  <span style={{ color: 'var(--ds-text-disabled)' }}>·</span>
                  <span>{x}</span>
                </span>
              ))}
            </div>
            {node.tags.length > 0 && (
              <div style={{ display: 'flex', gap: 5, marginTop: 10, flexWrap: 'wrap' }}>
                {node.tags.map((t) => (
                  <Chip key={t}>{t}</Chip>
                ))}
              </div>
            )}
          </div>

          {/*
            操作放在页头右侧，带文字的次级按钮。之前是标题旁边两个无字小图标，
            不悬停根本不知道一个是"去服务商控制台"、一个是"编辑"。
          */}
          {(panelUrl || can('node:manage')) && (
            <div className="ds-page-actions">
              {panelUrl && (
                <a
                  className="ds-btn ds-btn-ghost"
                  href={panelUrl}
                  target="_blank"
                  // noreferrer 不只是隐私：没有它，目标页能通过 window.opener 把本页
                  // 导航到钓鱼页面（反向标签劫持）
                  rel="noopener noreferrer"
                >
                  <IconExternal size={14} />
                  {node.provider ? `${node.provider} 控制台` : '服务商控制台'}
                </a>
              )}
              {can('node:manage') && (
                <button className="ds-btn ds-btn-ghost" onClick={() => setEditing(true)}>
                  <IconEdit size={14} />
                  编辑
                </button>
              )}
            </div>
          )}
        </header>

        {offline && (
          <div style={{ marginTop: 18 }}>
            <Alert tone="warn" icon={<IconWifiOff size={15} />} title="这台机器已失联">
              最后一次上报在 {ago(node.lastSeen)}，下面展示的是断线前的最后一批数据。
              采集端恢复上报后会自动刷新，不需要手动操作。
            </Alert>
          </div>
        )}
      </section>

      {/* —— 事实陈列：这台机器是什么、跑了多久、什么时候到期 —— */}
      <div className="ds-facts ds-animate-in">
        <Fact icon={<IconClock size={12} />} k="已运行" v={m ? uptime(m.uptime) : '—'} />
        <Fact
          icon={<IconActivity size={12} />}
          k="最后上报"
          v={ago(node.lastSeen)}
          tone={offline ? 'warn' : undefined}
          sub={node.lastSeen ? new Date(node.lastSeen).toLocaleString('zh-CN', { hour12: false }) : undefined}
        />
        {/* 没填到期时间就整个不显示。摆一个写着"未设置"的格子，占的是版面，给的是零信息 */}
        {expire.known && (
          <Fact
            icon={<IconCalendar size={12} />}
            k="到期"
            v={expire.text}
            tone={expire.days < 0 ? 'danger' : expire.urgent ? 'warn' : undefined}
            sub={billing}
          />
        )}
        {/* 没有 node:hardware 权限时服务端会把这些字段清空，空的就不摆 */}
        {node.os && (
          <Fact
            icon={<IconLayers size={12} />}
            k="系统"
            v={node.os}
            sub={[node.kernel, node.arch].filter(Boolean).join(' · ')}
          />
        )}
        {node.cpuModel && (
          <Fact icon={<IconCpu size={12} />} k="处理器" v={node.cpuModel} sub={`${node.cpuCores} 核`} />
        )}
        <Fact icon={<IconTerminal size={12} />} k="采集端" v={node.agentVersion ? `v${node.agentVersion}` : '—'} />
      </div>

      {/* —— 实时快照 —— */}
      <div className="ds-snap-rings">
        <RingCell value={m?.cpu ?? 0} empty={!m} label="CPU" sub={`${node.cpuCores} 核`} />
        <RingCell
          value={memPct}
          empty={!m}
          label="内存"
          sub={`${bytes(m?.memUsed ?? 0, 1)} / ${bytes(node.memTotal, 0)}`}
        />
        <RingCell
          value={diskPct}
          empty={!m}
          label="磁盘"
          sub={`${bytes(m?.diskUsed ?? 0, 0)} / ${bytes(node.diskTotal, 0)}`}
        />
        {/*
          环里是"1 分钟负载占核心数的百分比"，和左边三个环同一口径 ——
          四个环并排时混着绝对值和百分比，看的人得先分辨这个数是什么单位。
          1/5/15 分钟的原始负载放在下面，对比趋势时仍然拿得到。
        */}
        <RingCell
          value={loadPct}
          empty={!m}
          label="负载"
          sub={m ? `${m.load1.toFixed(2)} · ${m.load5.toFixed(2)} · ${m.load15.toFixed(2)}` : '—'}
          hint="1 分钟负载占核心数的比例；下面三个数是 1 / 5 / 15 分钟的原始负载"
        />
      </div>

      <div className="ds-snap-info">
        <InfoCell
          title="网络"
          rows={[
            [
              <>
                <IconUp size={12} style={{ color: SERIES.tx }} /> 上行
              </>,
              rate(m?.netTx ?? 0),
            ],
            [
              <>
                <IconDown size={12} style={{ color: SERIES.rx }} /> 下行
              </>,
              rate(m?.netRx ?? 0),
            ],
          ]}
        />
        <InfoCell
          title="连接与进程"
          rows={[
            ['TCP 连接', count(m?.tcpConns ?? 0)],
            ['UDP 连接', count(m?.udpConns ?? 0)],
            ['进程', count(m?.processes ?? 0)],
          ]}
        />
        <InfoCell
          title="磁盘与温度"
          rows={[
            ['读 / 写', `${rate(m?.diskRead ?? 0)} / ${rate(m?.diskWrite ?? 0)}`],
            [
              '交换分区',
              node.swapTotal > 0 ? (
                <span style={{ color: swapPct > 40 ? 'var(--color-warn)' : undefined }}>
                  {percent(swapPct, 0)} · {bytes(node.swapTotal, 0)}
                </span>
              ) : (
                '未启用'
              ),
            ],
            [
              <>
                <IconThermometer size={12} /> 温度
              </>,
              m?.tempC != null ? (
                <span style={{ color: m.tempC > 75 ? 'var(--color-warn)' : undefined }}>{m.tempC.toFixed(0)}°C</span>
              ) : (
                '不可用'
              ),
            ],
          ]}
        />
      </div>

      {/* —— 分区切换 —— */}
      <section className="ds-sec" style={{ paddingTop: 6 }}>
        <div style={{ marginBottom: 22 }}>
          <Tabs value={activeTab} onChange={setTab} options={tabs} ariaLabel="详情分区" />
        </div>

        {/*
          面板套一层带 key 的容器。
          没有它，切换标签时 React 会复用同一个 DOM，CSS 动画只在元素插入时触发，
          复用就不会重播 —— 表现就是内容"啪"地换掉。key 变了才是真的卸载重建。
        */}
        <div key={activeTab} className="ds-tab-panel">
          {/* —— 负载 —— */}
          {activeTab === 'load' && (
            <>
              <div className="ds-section-bar">
                <span className="ds-text-body-sm text-ds-description tnum">
                  {metrics.data?.length
                    ? `${metrics.data.length} 个采样点 · ${clockTime(ts[0] ?? 0)} 至 ${clockTime(ts[ts.length - 1] ?? 0)}`
                    : '正在加载采样数据'}
                </span>
                <Segmented
                  value={range}
                  onChange={setRange}
                  ariaLabel="时间范围"
                  options={[
                    { value: '15m', label: '15 分钟' },
                    { value: '1h', label: '1 小时' },
                    { value: '6h', label: '6 小时' },
                    { value: '24h', label: '24 小时' },
                  ]}
                />
              </div>

              {metrics.loading && !metrics.data ? (
                <div className="ds-chart-grid">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="ds-chart-card" style={{ display: 'grid', gap: 12 }}>
                      <Skeleton height={14} width={110} />
                      <Skeleton height={200} radius={6} />
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  /*
                   * key 跟着数据窗口走：切时间范围时整块重新挂载，播一次淡入。
                   * SVG 的 d 属性没法靠 CSS 过渡，点数还不一样，只能整体换。
                   * 加载期间旧图留在原地并轻微降透明，比先清空再填要稳得多。
                   */
                  key={chartKey}
                  className="ds-chart-grid ds-chart-swap"
                  style={{ opacity: metrics.loading ? 0.55 : 1, transition: 'opacity 0.18s ease' }}
                >
                  <ChartCard title="CPU 与负载" legend={[['CPU', SERIES.cpu], ['1 分钟负载', SERIES.load]]}>
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
                          values:
                            metrics.data?.map((x) => Math.min(100, (x.load1 / Math.max(1, node.cpuCores)) * 100)) ?? [],
                          format: (v) => ((v / 100) * node.cpuCores).toFixed(2),
                        },
                      ]}
                    />
                  </ChartCard>

                  <ChartCard title="内存占用" legend={[['已用内存', SERIES.mem]]}>
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
                  </ChartCard>

                  <ChartCard title="网络吞吐" legend={[['上行', SERIES.tx], ['下行', SERIES.rx]]}>
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
                  </ChartCard>

                  <ChartCard title="磁盘 IO" legend={[['读', SERIES.read], ['写', SERIES.write]]}>
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
                  </ChartCard>
                </div>
              )}
            </>
          )}

          {/* —— 流量 —— */}
          {activeTab === 'traffic' && (
            <div className="ds-chart-grid">
              <SectionCard
                title="流量消耗"
                subtitle={
                  daily.data
                    ? `${rangeLabel(trafficRange, activePreset)} · 合计 ${bytes(billedSum)}${directionNote}`
                    : '加载中'
                }
                actions={
                  <DateRangePicker
                    value={trafficRange}
                    onChange={pickRange}
                    presets={presets}
                    activePreset={activePreset}
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
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                        gap: 16,
                        marginTop: 16,
                        paddingTop: 16,
                        borderTop: '1px solid var(--ds-divider)',
                      }}
                    >
                      <Stat
                        /* 周期未必是自然月（可按开通日重置），所以标签不能写死"本月" */
                        label="本周期已用"
                        value={bytes(node.trafficUsed)}
                        hint={
                          [
                            `${monthDay(node.cycleStart)} – ${monthDay(cycleLastDay(node.cycleEnd))}`,
                            node.trafficOffset !== 0 ? '含人工校准' : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        }
                        color={
                          // 门槛跟设置里的「配额提醒」走。写死 0.85 的话，这台机器
                          // 在概览页已经被标成"接近配额"，点进详情却还是黑字
                          node.trafficQuota > 0 && isNearQuota(ratio(node.trafficUsed, node.trafficQuota))
                            ? 'var(--color-warn)'
                            : undefined
                        }
                      />
                      <Stat label="日均" value={bytes(billedSum / Math.max(1, daily.data?.length ?? 1))} />
                      <Stat
                        label="累计上行"
                        value={bytes(daily.data?.reduce((a, d) => a + d.tx, 0) ?? 0)}
                        hint={<LegendDot color={SERIES.tx} />}
                      />
                      <Stat
                        label="累计下行"
                        value={bytes(daily.data?.reduce((a, d) => a + d.rx, 0) ?? 0)}
                        hint={<LegendDot color={SERIES.rx} />}
                      />
                    </div>
                  </>
                )}
              </SectionCard>

              {can('traffic:services') && (
                <SectionCard
                  title="流量都被谁吃了"
                  subtitle={`按进程 / 服务归因 · ${rangeLabel(trafficRange, activePreset)}`}
                >
                  {services.loading && !services.data ? (
                    <Skeleton height={220} />
                  ) : (
                    <>
                      <AttributionCoverage
                        attributed={(services.data ?? []).reduce((a, s) => a + s.rx + s.tx, 0)}
                        total={(daily.data ?? []).reduce((a, d) => a + d.rx + d.tx, 0)}
                      />
                      <ServiceBreakdown data={services.data ?? []} />
                    </>
                  )}
                </SectionCard>
              )}
            </div>
          )}

          {/* —— 安全 —— */}
          {activeTab === 'security' && (
            <div style={{ display: 'grid', gap: 16 }}>
              {can('traffic:peers') && (
                <SectionCard
                  title="对端 IP 流量"
                  subtitle={`${rangeLabel(trafficRange, activePreset)} · 按累计流量排序，可直接对可疑来源下封禁`}
                  padded={false}
                  actions={
                    /* 和流量页共用同一个区间。两边各管各的话，
                       "谁吃了流量"和"谁连过来"就对不上账了 */
                    <DateRangePicker
                      value={trafficRange}
                      onChange={pickRange}
                      presets={presets}
                      activePreset={activePreset}
                    />
                  }
                >
                  {peers.loading && !peers.data ? (
                    <div style={{ padding: 20 }}>
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

              {can('block:view') && (
                <SectionCard
                  title="封禁规则"
                  subtitle={
                    activeRules.length > 0
                      ? `${activeRules.filter((r) => r.state === 'active').length} 条生效中，${activeRules.filter((r) => r.state === 'pending').length} 条待下发`
                      : '暂无生效中的规则'
                  }
                  padded={false}
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
            </div>
          )}
        </div>
      </section>

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
 * 可复制的一段文字（IP、主机名）。
 *
 * 打了码的地址（带 *）复制出来也用不了，那种情况只显示不给按钮。
 */
function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const masked = text.includes('*');
  if (masked) return <span className="tnum">{text}</span>;
  return (
    <Tooltip content={copied ? '已复制' : `复制${label}`}>
      <button
        type="button"
        className="ds-copy tnum"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {text}
        {copied ? <IconCheck size={13} style={{ color: 'var(--color-ok)' }} /> : <IconCopy size={13} />}
      </button>
    </Tooltip>
  );
}

function Fact({
  icon,
  k,
  v,
  sub,
  tone,
}: {
  icon?: React.ReactNode;
  k: string;
  v: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'warn' | 'danger';
}) {
  return (
    <div className="ds-fact">
      <div className="ds-fact-k">
        {icon}
        {k}
      </div>
      <div
        className="ds-fact-v"
        style={
          tone
            ? { color: `color-mix(in srgb, var(--color-${tone}) 80%, var(--ds-text-primary))` }
            : undefined
        }
      >
        {v}
      </div>
      {sub && <div className="ds-fact-sub">{sub}</div>}
    </div>
  );
}

function InfoCell({ title, rows }: { title: string; rows: Array<[React.ReactNode, React.ReactNode]> }) {
  return (
    <div className="ds-snap-cell ds-snap-cell-col">
      <div className="ds-text-caption text-ds-description" style={{ fontWeight: 500 }}>
        {title}
      </div>
      <div style={{ display: 'grid', gap: 7 }}>
        {rows.map(([k, v], i) => (
          <div key={i} className="ds-kv">
            <span>{k}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LegendDot({ color }: { color: string }) {
  return <span style={{ display: 'inline-block', width: 14, height: 3, borderRadius: 2, background: color }} />;
}

/**
 * 详情页骨架。
 *
 * 形状贴着真实布局走：面包屑、页头、事实带、四个环、三张读数卡、标签栏。
 * 骨架和内容的高度对不上的话，数据一到页面就会跳一下，那还不如不做。
 */
function NodeDetailSkeleton() {
  return (
    <div className="ds-fade-in" aria-busy="true" aria-label="正在加载机器信息">
      <Skeleton height={13} width={160} style={{ marginBottom: 14 }} />
      <div style={{ display: 'flex', gap: 14, marginBottom: 22 }}>
        <Skeleton height={20} width={26} radius={3} style={{ marginTop: 6 }} />
        <div style={{ flex: 1, display: 'grid', gap: 9 }}>
          <Skeleton height={28} width={240} />
          <Skeleton height={14} width={340} />
        </div>
      </div>
      <Skeleton height={64} radius={8} style={{ marginBottom: 16 }} />
      <div className="ds-snap-rings">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="ds-snap-cell">
            <Skeleton height={64} width={64} radius={999} />
            <div style={{ flex: 1, display: 'grid', gap: 8 }}>
              <Skeleton height={12} width={48} />
              <Skeleton height={12} width="70%" />
            </div>
          </div>
        ))}
      </div>
      <Skeleton height={40} width={240} radius={6} style={{ margin: '8px 0 18px' }} />
      <Skeleton height={260} radius={8} />
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
        <span className="ds-text-caption text-ds-description">
          不限量 · {monthDay(node.cycleStart)} – {monthDay(cycleLastDay(node.cycleEnd))}
        </span>
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
        {/*
          周期区间要写出来，光说"14 天后重置"不够。
          面板按这里配的账单日切周期，机房后台按它自己的日子切 —— 两边对不上时，
          这一行是唯一能让人立刻看出"面板从 1 号算、机房从 5 号算"的地方，
          否则只能看到两个总量不一样，却不知道差在哪。
        */}
        <Tooltip content={`本流量周期 ${node.cycleStart} 至 ${cycleLastDay(node.cycleEnd)}，与机房后台的起始日不一致时，在编辑里改「流量周期」重置日`}>
          <span className="ds-text-caption text-ds-description tnum">
            {monthDay(node.cycleStart)} – {monthDay(cycleLastDay(node.cycleEnd))}
          </span>
        </Tooltip>
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

/**
 * 一个环 + 名称 + 副读数。四个环统一用品牌蓝，越线才变黄变红 ——
 * 之前负载环固定是琥珀色，和"告警黄"撞色，正常的负载看起来也像出了事。
 */
function RingCell({
  value,
  label,
  sub,
  hint,
  empty,
}: {
  value: number;
  label: string;
  sub: string;
  hint?: string;
  empty?: boolean;
}) {
  const cell = (
    <div className="ds-snap-cell">
      <Ring value={value} size={64} thickness={6} label={label} empty={empty} />
      <div style={{ minWidth: 0 }}>
        <div className="ds-text-body-sm" style={{ fontWeight: 600, color: 'var(--ds-text-primary)' }}>
          {label}
        </div>
        <div className="ds-text-caption text-ds-description tnum ds-ellipsis" style={{ marginTop: 2 }}>
          {sub}
        </div>
      </div>
    </div>
  );
  return hint ? <Tooltip content={hint}>{cell}</Tooltip> : cell;
}

function ChartCard({
  title,
  legend,
  children,
}: {
  title: string;
  legend: Array<[string, string]>;
  children: React.ReactNode;
}) {
  return (
    <div className="ds-chart-card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <span className="ds-card-title" style={{ fontSize: 14 }}>
          {title}
        </span>
        <span className="ds-legend">
          {legend.map(([label, color]) => (
            <span key={label}>
              <i style={{ background: color }} />
              {label}
            </span>
          ))}
        </span>
      </div>
      {children}
    </div>
  );
}

/** 卡片副标题里那句区间描述。命中快捷项就用它的说法，比两个日期好读 */
function rangeLabel(r: DayRange, preset: string | undefined): string {
  if (preset === 'cycle') return '本周期';
  if (preset) return `近 ${dayCount(r)} 天`;
  return `${r.from.slice(5)} 至 ${r.to.slice(5)}`;
}

/**
 * 归因覆盖率。
 *
 * 归因永远不会等于总量：conntrack 跟不到的流量（没开 accounting 的那段时间、
 * 表满被丢弃的条目、非 IP 流量）落不进任何一个进程名下。把这个差额明说出来，
 * 是因为不说的话，人只能默认排行榜就是全部 —— 上一版归因只覆盖了 4% 的真实流量，
 * 而界面上没有任何地方透露过这件事，于是它安静地错了很久。
 */
function AttributionCoverage({ attributed, total }: { attributed: number; total: number }) {
  if (total <= 0 || attributed <= 0) return null;
  // ratio 是 0-100 并且封顶在 100 —— 归因可能因为取整或采样边界
  // 略微超过总量，那时说"102%"只会让人怀疑别的地方也算错了
  const pct = ratio(attributed, total);
  const low = pct < 60;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        marginBottom: 12,
        paddingBottom: 11,
        borderBottom: '1px solid var(--ds-border)',
      }}
    >
      <span className="ds-text-xs text-ds-description">已归因</span>
      <span className="tnum ds-text-body-sm" style={{ fontWeight: 600 }}>
        {bytes(attributed)}
      </span>
      <span className="ds-text-xs text-ds-description">
        / {bytes(total)} · {percent(pct, 0)}
      </span>
      {low && (
        <Tooltip
          content={
            '这段时间里有相当一部分流量没能落到具体进程上。常见原因：nf_conntrack_acct 没开、' +
            'agent 不是 root 跑的（读不到别的进程的 socket）、或者这段区间里 agent 有过掉线。'
          }
        >
          <span className="ds-chip" style={{ color: 'var(--color-warn)' }}>
            覆盖偏低
          </span>
        </Tooltip>
      )}
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
                <Tooltip content="这些连接在采集时已经关闭，无法再对应到具体进程。属于正常现象，占比通常很低。">
                  <span className="ds-chip">连接已关闭</span>
                </Tooltip>
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

  const suspicious = peers.filter((p) => p.threatScore >= 40);
  const filtered = onlySuspicious ? suspicious : peers;
  // 换筛选条件后停在第 3 页会看到空列表，回到第一页
  useEffect(() => setPage(0), [onlySuspicious, peers.length]);

  const shown = filtered.slice(page * PEER_PAGE_SIZE, (page + 1) * PEER_PAGE_SIZE);
  const maxTotal = Math.max(...peers.map((p) => p.rx + p.tx), 1);

  if (peers.length === 0) {
    return (
      <EmptyState
        icon={<IconGlobe size={22} />}
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
          gap: 12,
          padding: '12px 22px',
          borderBottom: '1px solid var(--ds-divider)',
          flexWrap: 'wrap',
        }}
      >
        <Segmented
          size="s"
          value={onlySuspicious ? 'sus' : 'all'}
          onChange={(v) => setOnlySuspicious(v === 'sus')}
          ariaLabel="来源筛选"
          options={[
            { value: 'all', label: '全部', count: peers.length },
            { value: 'sus', label: '可疑', count: suspicious.length },
          ]}
        />
        <span style={{ flex: 1 }} />
        <span className="ds-text-caption text-ds-description">
          威胁分综合连接数、流量比例、目标端口和情报标记
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="ds-table" style={{ minWidth: 780 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 22 }}>来源 IP</th>
              <th>归属</th>
              <th>流量占比</th>
              <th style={{ textAlign: 'right' }}>上行</th>
              <th style={{ textAlign: 'right' }}>下行</th>
              <th style={{ textAlign: 'right' }}>连接</th>
              <th>威胁</th>
              <th style={{ paddingRight: 22 }} aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const isBlocked = blockedIps.has(p.ip) || p.blocked;
              const tc = threatColor(p.threatScore);
              const flagged = p.threatScore >= 25;
              return (
                <tr key={p.ip} className="ds-fade-in" style={{ opacity: isBlocked ? 0.5 : 1 }}>
                  <td style={{ paddingLeft: 22, whiteSpace: 'nowrap' }}>
                    <span
                      className="ds-mono"
                      style={{
                        fontSize: 13,
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
                  <td style={{ maxWidth: 210 }}>
                    <div
                      className="ds-ellipsis"
                      style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--ds-text-secondary)' }}
                    >
                      <CountryBadge code={p.countryCode} />
                      <span className="ds-ellipsis">{p.org}</span>
                    </div>
                    <div className="ds-mono" style={{ fontSize: 12, color: 'var(--ds-text-description)' }}>
                      AS{p.asn}
                    </div>
                  </td>
                  <td style={{ minWidth: 120 }}>
                    <span className="ds-meter-track" style={{ display: 'block', height: 3 }}>
                      <span
                        className="ds-meter-fill"
                        style={{ width: `${Math.max(1.5, ((p.rx + p.tx) / maxTotal) * 100)}%`, background: tc }}
                      />
                    </span>
                    <div className="ds-mono" style={{ fontSize: 12, color: 'var(--ds-text-description)', marginTop: 5 }}>
                      {bytes(p.rx + p.tx)}
                    </div>
                  </td>
                  <td className="ds-mono" style={{ textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                    {bytes(p.tx)}
                  </td>
                  <td className="ds-mono" style={{ textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                    {bytes(p.rx)}
                  </td>
                  <td
                    className="ds-mono"
                    style={{
                      textAlign: 'right',
                      fontSize: 12.5,
                      color: p.conns > 1500 ? 'var(--color-danger)' : undefined,
                    }}
                  >
                    {count(p.conns)}
                  </td>
                  <td>
                    {/* 判定依据可能有好几条，提示框的 white-space:pre-line 会保留换行 */}
                    <Tooltip content={p.threatReasons.join('\n') || '无异常信号'}>
                      {flagged ? (
                        <span
                          className="ds-badge"
                          style={{
                            color: `color-mix(in srgb, ${tc} 78%, var(--ds-text-primary))`,
                            borderColor: `color-mix(in srgb, ${tc} 30%, transparent)`,
                            background: `color-mix(in srgb, ${tc} 7%, var(--ds-bg-surface))`,
                          }}
                        >
                          {threatLabel(p.threatScore)} <span className="ds-mono">{p.threatScore}</span>
                        </span>
                      ) : (
                        // 正常的来源只写一行灰字，不挂徽标 —— 满屏的"正常"徽标会把可疑的那几行淹掉
                        <span className="ds-text-caption text-ds-description">
                          正常 <span className="ds-mono">{p.threatScore}</span>
                        </span>
                      )}
                    </Tooltip>
                  </td>
                  <td style={{ paddingRight: 22, textAlign: 'right' }}>
                    {isBlocked ? (
                      <Badge tone="danger">
                        <IconBan size={11} />
                        已封禁
                      </Badge>
                    ) : canBlock ? (
                      <button
                        className="ds-btn ds-btn-ghost ds-btn-s"
                        onClick={() => onBlock(p)}
                        style={{ color: p.threatScore >= 50 ? 'var(--color-danger)' : undefined }}
                      >
                        <IconBan size={12} />
                        封禁
                      </button>
                    ) : (
                      <span style={{ color: 'var(--ds-text-disabled)' }}>—</span>
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

      <Pagination page={page} pageSize={PEER_PAGE_SIZE} total={filtered.length} onPage={setPage} />
    </>
  );
}

const RULE_STATE: Record<string, { text: string; tone: 'danger' | 'warn' | 'idle' }> = {
  active: { text: '生效中', tone: 'danger' },
  pending: { text: '待下发', tone: 'warn' },
  expired: { text: '已过期', tone: 'idle' },
  removed: { text: '已解除', tone: 'idle' },
  failed: { text: '执行失败', tone: 'danger' },
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
        icon={<IconShield size={22} />}
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
          <div key={r.id} style={{ borderBottom: '1px solid var(--ds-divider)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 22px',
                flexWrap: 'wrap',
              }}
            >
              <span className="ds-mono" style={{ fontSize: 13, color: 'var(--ds-text-primary)', minWidth: 128 }}>
                {r.target}
              </span>
              <Badge tone={st.tone} dot>
                {st.text}
              </Badge>
              <Chip>
                <span className="ds-mono">{r.mode === 'enforced' ? 'enforce' : 'dry-run'}</span>
              </Chip>
              <span
                className="ds-text-caption text-ds-description ds-ellipsis"
                style={{ flex: 1, minWidth: 120 }}
              >
                {r.reason || '未填写原因'}
              </span>
              <span className="ds-text-caption text-ds-description" style={{ whiteSpace: 'nowrap' }}>
                {ago(r.createdAt)}
                {r.expiresAt > 0 && ` · ${untilExpireShort(r.expiresAt)}`}
              </span>
              <button
                className="ds-btn ds-btn-ghost ds-btn-s"
                onClick={() => setExpanded(open ? null : r.id)}
                aria-expanded={open}
              >
                <IconTerminal size={12} />
                命令
              </button>
              {live && canRemove && (
                <button
                  className="ds-btn ds-btn-ghost ds-btn-s"
                  disabled={busy === r.id}
                  onClick={() => void remove(r.id)}
                >
                  <IconTrash size={12} />
                  {busy === r.id ? '解除中…' : '解除'}
                </button>
              )}
            </div>
            {open && (
              <div className="ds-fade-in" style={{ padding: '0 22px 14px' }}>
                <pre className="ds-enroll-cmd" style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
                  {r.commands.join('\n')}
                </pre>
                {r.result && (
                  <p className="ds-text-caption text-ds-description" style={{ margin: '8px 0 0' }}>
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
