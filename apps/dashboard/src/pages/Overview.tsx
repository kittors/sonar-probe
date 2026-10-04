import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { NodeCard, NodeRow } from '../components/NodeCard';
import { EmptyState, Segmented, Select, Skeleton, StatusDot, useTweened } from '../components/ui';
import { Sparkline } from '../components/charts/Sparkline';
import { IconAlert, IconGrid, IconInfo, IconList, IconPlus, IconSearch, IconServer } from '../components/icons';
import { TextInput } from '../components/Input';
import { seedEvents, useAsync, useLive, type ConnState } from '../lib/live';
import { EnrollDialog } from '../components/EnrollDialog';
import { Tooltip } from '../components/Tooltip';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { ago, bytes, count, moneyTotal, quotaTone, rate } from '../lib/format';
import { CURRENCY_META, monthlyCostOf, normalizeCurrency } from '../lib/currency';
import { useSettings } from '../lib/settings';
import type { EventLog, NodeState, NodeStatus } from '../lib/types';

type Filter = 'all' | NodeStatus;
type View = 'grid' | 'list';
type Sort = 'status' | 'name' | 'cpu' | 'traffic';

const VIEW_KEY = 'sonar-view';

/** 配额分布图最多画这么多根柱子，再多每根细到看不见 */
const MAX_QUOTA_BARS = 40;

export function Overview() {
  const { nodes, events, conn } = useLive();
  const { can } = useAuth();
  const settings = useSettings();
  const canViewBlocks = can('block:view');
  const canManage = can('node:manage');
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('status');
  const [query, setQuery] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [view, setView] = useState<View>(() =>
    localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid',
  );

  useEffect(() => localStorage.setItem(VIEW_KEY, view), [view]);

  // 命令面板里的"接入新机器"跳到 /?enroll=1。读完就从地址栏抹掉，刷新不会再弹一次
  useEffect(() => {
    if (params.get('enroll') !== '1') return;
    if (canManage) setEnrolling(true);
    const next = new URLSearchParams(params);
    next.delete('enroll');
    setParams(next, { replace: true });
  }, [params, setParams, canManage]);

  // 事件流的历史部分走 REST 拿一次，之后靠 WebSocket 增量追加
  const { data: history } = useAsync(() => api.events(40), []);
  useEffect(() => {
    if (history) seedEvents(history);
  }, [history]);

  const counts = useMemo(
    () => ({
      all: nodes.length,
      online: nodes.filter((n) => n.status === 'online').length,
      warning: nodes.filter((n) => n.status === 'warning').length,
      offline: nodes.filter((n) => n.status === 'offline').length,
    }),
    [nodes],
  );

  /** 状态筛选项：数量为 0 的不列出来。 */
  const statusOptions = useMemo(() => {
    const opts: Array<{ value: Filter; label: string; count: number }> = [
      { value: 'all', label: '全部', count: counts.all },
    ];
    if (counts.online > 0) opts.push({ value: 'online', label: '在线', count: counts.online });
    if (counts.warning > 0) opts.push({ value: 'warning', label: '告警', count: counts.warning });
    if (counts.offline > 0) opts.push({ value: 'offline', label: '离线', count: counts.offline });
    return opts;
  }, [counts]);

  // 选中的那一档可能因为机器状态变化而消失（比如最后一台告警机恢复了），
  // 这时得退回「全部」，否则会停在一个空列表上
  useEffect(() => {
    if (!statusOptions.some((o) => o.value === filter)) setFilter('all');
  }, [statusOptions, filter]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = nodes.filter((n) => {
      if (filter !== 'all' && n.status !== filter) return false;
      if (!q) return true;
      return (
        n.name.toLowerCase().includes(q) ||
        n.hostname.toLowerCase().includes(q) ||
        n.ip.includes(q) ||
        n.provider.toLowerCase().includes(q) ||
        n.region.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
      );
    });

    const rank: Record<NodeStatus, number> = { warning: 0, online: 1, offline: 2 };
    return list.sort((a, b) => {
      switch (sort) {
        case 'cpu':
          return (b.metric?.cpu ?? -1) - (a.metric?.cpu ?? -1);
        case 'traffic':
          return b.trafficUsed - a.trafficUsed;
        case 'name':
          return a.name.localeCompare(b.name, 'zh-CN');
        default:
          // 告警排最前 —— 出问题的机器不该让人自己去网格里找
          return rank[a.status] - rank[b.status] || a.name.localeCompare(b.name, 'zh-CN');
      }
    });
  }, [nodes, filter, query, sort]);

  const totals = useMemo(() => {
    const now = Date.now();
    const rx = nodes.reduce((a, n) => a + (n.status !== 'offline' ? (n.metric?.netRx ?? 0) : 0), 0);
    const tx = nodes.reduce((a, n) => a + (n.status !== 'offline' ? (n.metric?.netTx ?? 0) : 0), 0);
    const traffic = nodes.reduce((a, n) => a + n.trafficUsed, 0);

    /*
     * 带宽趋势：把每台在线机器最近的采样按"从最新往回数"对齐后相加。
     *
     * 各台机器的趋势数组长度不一定相同（刚接入的只有几个点），从尾部对齐才能保证
     * 每一列加的都是同一时刻附近的读数；离线机器的趋势停在断线那一刻，不能掺进来。
     */
    const live = nodes.filter((n) => n.status !== 'offline' && n.netTrend.length > 1);
    const len = live.reduce((a, n) => Math.max(a, n.netTrend.length), 0);
    const txTrend = new Array<number>(len).fill(0);
    const rxTrend = new Array<number>(len).fill(0);
    for (const n of live) {
      const off = len - n.netTrend.length;
      n.netTrend.forEach((p, i) => {
        txTrend[off + i]! += p.tx;
        rxTrend[off + i]! += p.rx;
      });
    }

    /*
     * 月度成本。
     *
     * 按面板设置的展示币种逐台折算，算法和服务端 store.ts 的 monthlyCostOf 是同一套 ——
     * 之所以前端再算一次而不是直接用汇总接口，是因为机器列表走 WebSocket 实时推送，
     * 再拉一次 REST 会让"在线 3/3"和"月度成本"来自两个不同时刻的快照。
     */
    const billable = settings.costIncludeExpired
      ? nodes
      : nodes.filter((n) => n.expireAt <= 0 || n.expireAt > now);
    const cost = billable.reduce(
      (a, n) => a + monthlyCostOf(n, settings.displayCurrency, settings.rates),
      0,
    );
    const pricedNodes = billable.filter((n) => n.price > 0).length;

    // 换算前各币种各是多少。汇总数字换过算，人总会想核对一下原值
    const byCurrency = new Map<string, number>();
    for (const n of billable) {
      if (!(n.price > 0)) continue;
      const code = normalizeCurrency(n.currency);
      byCurrency.set(code, (byCurrency.get(code) ?? 0) + monthlyCostOf(n, code, settings.rates));
    }
    const mixedCurrency = byCurrency.size > 1;

    /*
     * 即将到期和已经过期要分开数。
     *
     * 一台过期 30 天的机器不该被数进"7 天内到期"里 —— 两者需要的动作不同：
     * 即将到期是"该续费了"，已过期是"要么续要么从面板上删掉"。
     */
    const expiring = nodes.filter(
      (n) => n.expireAt > now && n.expireAt - now < settings.expiryWarnDays * 86_400_000,
    ).length;
    const expired = nodes.filter((n) => n.expireAt > 0 && n.expireAt <= now).length;

    // 每台有配额的机器用了多少，从高到低 —— 汇总格子里那排小柱子
    const quotaUse = nodes
      .filter((n) => n.trafficQuota > 0)
      .map((n) => ({ id: n.id, name: n.name, pct: Math.min(100, (n.trafficUsed / n.trafficQuota) * 100) }))
      .sort((a, b) => b.pct - a.pct);
    const overQuota = quotaUse.filter((q) => q.pct > settings.quotaWarnPercent).length;
    // 机器之间账单日不一致时，这个合计跨的不是同一段时间，得说明一下
    const mixedCycle = new Set(nodes.map((n) => n.cycleStart)).size > 1;
    return {
      rx, tx, txTrend, rxTrend, traffic, cost, pricedNodes, byCurrency, mixedCurrency,
      expiring, expired, overQuota, quotaUse, mixedCycle,
    };
  }, [nodes, settings]);

  const loading = conn !== 'live' && nodes.length === 0;
  const empty = !loading && nodes.length === 0;
  // 汇总格子有几个：封禁要权限、成本要有人填过价格，按实际数量排版
  const statCount = 3 + (canViewBlocks ? 1 : 0) + (totals.pricedNodes > 0 ? 1 : 0);

  return (
    <>
      {/* —— 标题区 —— */}
      <section className="ds-hero">
        <span className="ds-sq ds-sq-edge" style={{ left: 0, top: '100%' }} aria-hidden="true" />
        <span className="ds-sq ds-sq-edge" style={{ left: '100%', top: '100%' }} aria-hidden="true" />
        <div style={{ minWidth: 0 }}>
          <LiveEyebrow conn={conn} total={nodes.length} loading={loading} />
          <h1 className="ds-display">机器概览</h1>
          <p className="ds-lede">{summarize(counts, totals, settings.expiryWarnDays, loading, empty)}</p>
        </div>
        {/*
          接入机器只给能管机器的人 —— 这个按钮背后是 agent token。
          作为标题区唯一的主按钮，而不是工具栏角落里一个没有文字的蓝色加号。
        */}
        {canManage && (
          <button className="ds-btn ds-btn-primary" onClick={() => setEnrolling(true)}>
            <IconPlus size={15} strokeWidth={2} />
            接入机器
          </button>
        )}
      </section>

      {/* —— 汇总 —— */}
      <div className="ds-bento-wrap">
        <div className="ds-bento" data-count={statCount} style={{ '--n': statCount } as React.CSSProperties}>
          <StatTile
            label="在线机器"
            loading={loading}
            value={
              <>
                <Tween value={counts.online} format={(v) => Math.round(v).toString()} />
                <small>/ {counts.all}</small>
              </>
            }
            viz={
              counts.all > 0 && (
                <div
                  className="ds-stack"
                  role="img"
                  aria-label={`在线 ${counts.online}，告警 ${counts.warning}，离线 ${counts.offline}`}
                >
                  <span style={{ flexGrow: counts.online, background: 'var(--ds-data)' }} />
                  <span style={{ flexGrow: counts.warning, background: 'var(--color-warn)' }} />
                  <span style={{ flexGrow: counts.offline, background: 'var(--ds-bg-track)' }} />
                </div>
              )
            }
            // 只列出不为 0 的部分。之前写的是"0 告警 · 1 离线"，那个 0 是纯噪声
            hint={
              [counts.warning > 0 && `${counts.warning} 台告警`, counts.offline > 0 && `${counts.offline} 台离线`]
                .filter(Boolean)
                .join(' · ') || '全部在线'
            }
            tone={counts.warning + counts.offline > 0 ? 'warn' : undefined}
          />

          <StatTile
            label="出站带宽"
            loading={loading}
            value={<Tween value={totals.tx} format={rate} split="unit" />}
            viz={
              totals.txTrend.length > 1 && (
                <Sparkline
                  values={totals.txTrend}
                  secondary={{ values: totals.rxTrend, color: 'var(--chart-neutral)' }}
                  height={28}
                />
              )
            }
            hint={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <i style={{ display: 'inline-block', width: 12, height: 2, borderRadius: 2, background: 'var(--chart-neutral)' }} />
                入站 <span className="ds-mono">{rate(totals.rx)}</span>
              </span>
            }
          />

          <StatTile
            /* 各机器的账单日可能不同，这就是各自周期用量的合计，不是同一个自然月 */
            label="本周期流量"
            loading={loading}
            value={<Tween value={totals.traffic} format={(v) => bytes(v)} split="unit" />}
            viz={totals.quotaUse.length > 0 && <QuotaBars items={totals.quotaUse} />}
            // 一台配额都没设的时候说"配额充足"是句空话
            hint={
              totals.overQuota > 0
                ? `${totals.overQuota} 台接近配额`
                : totals.quotaUse.length > 0
                  ? '配额充足'
                  : totals.mixedCycle
                    ? '各机器按自身周期统计'
                    : undefined
            }
            tone={totals.overQuota > 0 ? 'warn' : undefined}
          />

          {/*
            下面两格按"有没有信息量"决定显不显示，而不是一律占位。
            没权限就摆一个写着"你没有查看权限"的空格子，等于用一块屏幕告诉人一件
            与他无关的事；没人填过价格却显示"月度成本 未设置"，同样是白占地方。
          */}
          {canViewBlocks && (
            <StatTile label="生效封禁" loading={loading} value={<BlockCount />} hint="在机器详情的「安全」里管理" />
          )}

          {totals.pricedNodes > 0 && (
            <StatTile
              label="月度成本"
              loading={loading}
              value={
                /*
                 * 多币种时把换算前的原值挂在提示里。折算成一个数字是为了能一眼看出量级，
                 * 但汇率总有出入，真要去对账单的人需要的是"欧元那台到底多少欧元"。
                 */
                totals.mixedCurrency || settings.ratesMeta.usingFallback ? (
                  <Tooltip content={costTooltip(totals.byCurrency, settings)} maxWidth={320}>
                    <span style={{ cursor: 'help' }}>
                      <Tween value={totals.cost} format={(v) => moneyTotal(v, settings.displayCurrency)} split="cents" />
                    </span>
                  </Tooltip>
                ) : (
                  <Tween value={totals.cost} format={(v) => moneyTotal(v, settings.displayCurrency)} split="cents" />
                )
              }
              hint={costHint(totals, settings) ?? `${totals.pricedNodes} 台机器计费`}
              tone={totals.expired > 0 ? 'danger' : totals.expiring > 0 ? 'warn' : undefined}
            />
          )}
        </div>
      </div>

      {/* —— 工具栏 —— */}
      {!empty && (
        <div className="ds-toolbar">
          <div className="ds-toolbar-search">
            <TextInput
              pill
              leading={<IconSearch size={15} />}
              placeholder="筛选名称、IP、厂商、标签"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery('')}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              aria-label="筛选机器"
            />
          </div>

          {/* 只有一种状态时整个筛选器都不显示 —— 那时「全部」和「在线」是同一批机器 */}
          {statusOptions.length > 2 && (
            <div className="ds-toolbar-scroll">
              <Segmented value={filter} onChange={setFilter} options={statusOptions} ariaLabel="按状态筛选" />
            </div>
          )}

          <span className="ds-toolbar-spacer" />

          <Select
            value={sort}
            onChange={setSort}
            width={116}
            ariaLabel="排序方式"
            options={[
              { value: 'status', label: '按状态' },
              // 排的是 CPU 占用。之前叫"按负载"，可卡片上"负载"指的是 load average，两个词撞了
              { value: 'cpu', label: '按 CPU' },
              { value: 'traffic', label: '按流量' },
              { value: 'name', label: '按名称' },
            ]}
          />

          <Segmented
            iconOnly
            value={view}
            onChange={setView}
            ariaLabel="视图"
            options={[
              { value: 'grid', label: <IconGrid size={15} />, ariaLabel: '网格视图' },
              { value: 'list', label: <IconList size={15} />, ariaLabel: '列表视图' },
            ]}
          />
        </div>
      )}

      {/* —— 机器 —— */}
      {loading ? (
        <CardGridSkeleton />
      ) : empty ? (
        <section className="ds-sec">
          <EmptyState
            icon={<IconServer size={22} />}
            title="还没有接入任何机器"
            hint="在机器上运行一行安装命令，采集端装好后会自动出现在这里，几秒内就有数据。"
            action={
              canManage && (
                <button className="ds-btn ds-btn-primary" onClick={() => setEnrolling(true)}>
                  <IconPlus size={15} strokeWidth={2} />
                  接入第一台机器
                </button>
              )
            }
          />
        </section>
      ) : visible.length === 0 ? (
        <section className="ds-sec">
          <EmptyState
            icon={<IconSearch size={22} />}
            title="没有匹配的机器"
            hint={query ? `换个关键词试试，当前筛选「${query}」` : '调整筛选条件看看'}
            action={
              <button
                className="ds-btn ds-btn-ghost"
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                }}
              >
                清除筛选
              </button>
            }
          />
        </section>
      ) : view === 'grid' ? (
        <div className="ds-node-wrap">
          <div className="ds-node-grid">
            {visible.map((n, i) => (
              <NodeCard key={n.id} node={n} index={i} />
            ))}
          </div>
        </div>
      ) : (
        /*
         * 列表视图是七列的表格，最窄也要 860px 左右。
         * 放不下时给横向滚动，而不是裁掉 —— 裁掉等于把后面几列删了。
         */
        <div
          className="ds-table-scroll ds-fade-in"
          style={{ overflowX: 'auto', overflowY: 'hidden', borderBottom: '1px solid var(--ds-border)' }}
        >
          <div className="ds-node-table">
            <div className="ds-node-table-head">
              <span>机器</span>
              <span>厂商 / 地区</span>
              <span>CPU</span>
              <span>内存</span>
              <span>磁盘</span>
              <span>网络</span>
              <span>本周期流量</span>
            </div>
            {visible.map((n) => (
              <NodeRow key={n.id} node={n} />
            ))}
          </div>
        </div>
      )}

      {/* —— 事件 —— */}
      <EventFeed events={events} nodes={nodes} />
      {enrolling && <EnrollDialog onClose={() => setEnrolling(false)} />}
    </>
  );
}

/**
 * 标题下那句话：把汇总格子里的数字说成一句人话。
 *
 * 数字适合比较，句子适合"一眼知道现在怎么样"。只说值得说的部分 ——
 * 全部正常就说全部正常，不念一遍"0 台告警，0 台离线"。
 */
function summarize(
  counts: { all: number; online: number; warning: number; offline: number },
  totals: { overQuota: number; expiring: number; expired: number },
  warnDays: number,
  loading: boolean,
  empty: boolean,
): string {
  if (loading) return '正在建立实时连接…';
  if (empty) return '还没有接入机器。在服务器上运行一行安装命令，几秒内就会出现在这里。';
  const parts = [`${counts.online} 台在线`];
  if (counts.warning > 0) parts.push(`${counts.warning} 台需要注意`);
  if (counts.offline > 0) parts.push(`${counts.offline} 台已离线`);
  const extra: string[] = [];
  if (totals.overQuota > 0) extra.push(`${totals.overQuota} 台流量接近配额`);
  if (totals.expired > 0) extra.push(`${totals.expired} 台已过期`);
  else if (totals.expiring > 0) extra.push(`${totals.expiring} 台将在 ${warnDays} 天内到期`);
  const head = counts.warning + counts.offline === 0 ? `${counts.all} 台机器全部在线` : parts.join('，');
  return extra.length > 0 ? `${head}；${extra.join('，')}。` : `${head}。`;
}

/** 标题上方的小胶囊：实时状态 + 机器数。断线时如实说明，不让人对着旧数据做判断 */
function LiveEyebrow({ conn, total, loading }: { conn: ConnState; total: number; loading: boolean }) {
  if (loading) {
    return (
      <span className="ds-eyebrow">
        <StatusDot status="warning" size={7} />
        正在连接
      </span>
    );
  }
  if (conn === 'live') {
    return (
      <span className="ds-eyebrow">
        <StatusDot status="online" size={7} />
        实时更新中 · 共 {total} 台机器
      </span>
    );
  }
  return (
    <span className="ds-eyebrow" style={{ color: 'color-mix(in srgb, var(--color-warn) 80%, var(--ds-text-primary))' }}>
      <StatusDot status="warning" size={7} />
      {conn === 'down' ? '连接已断开' : '正在重连'} · 显示的是断线前的数据
    </span>
  );
}

/**
 * 滚动过渡的数字，顺便把单位排小一号。
 *
 * "9.65 MB/s" 里真正要看的是 9.65，单位是给数字定性的；同样字号的话单位会和数字
 * 抢视线。金额则把分位排小（$346.70 → $346 .70），整数部分才是要比较的量级。
 */
function Tween({
  value,
  format,
  split,
}: {
  value: number;
  format: (v: number) => string;
  split?: 'unit' | 'cents';
}) {
  const v = useTweened(value, { from: 0 });
  const text = format(v);
  if (split === 'unit') {
    const i = text.lastIndexOf(' ');
    if (i > 0) {
      return (
        <>
          {text.slice(0, i)}
          <small>{text.slice(i)}</small>
        </>
      );
    }
  }
  if (split === 'cents') {
    const i = text.lastIndexOf('.');
    if (i > 0) {
      return (
        <>
          {text.slice(0, i)}
          <small style={{ marginLeft: 0 }}>{text.slice(i)}</small>
        </>
      );
    }
  }
  return <>{text}</>;
}

function StatTile({
  label,
  value,
  viz,
  hint,
  tone,
  loading,
}: {
  label: string;
  value: ReactNode;
  viz?: ReactNode;
  hint?: ReactNode;
  tone?: 'warn' | 'danger';
  loading?: boolean;
}) {
  return (
    <div className="ds-stat">
      <div className="ds-stat-label">
        <span className="ds-ellipsis">{label}</span>
      </div>
      {/* 加载时保留数字位的排版，只把内容换成占位符 ——
          灰条会让这一格看起来像坏了，而 "—" 明确表示"还没有值" */}
      <div className="ds-stat-value" style={loading ? { color: 'var(--ds-text-disabled)' } : undefined}>
        {loading ? '—' : value}
      </div>
      {!loading && viz && <div className="ds-stat-viz">{viz}</div>}
      {/*
        提示行允许换行，不做省略：说明文字截成"各机器按自身周期…"就彻底失去意义了。
        它被压到格子底部，同一排几格的提示行对齐在一条线上。
      */}
      {hint && !loading && (
        <div className="ds-stat-hint" data-tone={tone}>
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * 配额分布：每台有配额的机器一根小柱子，高度是用量，从高到低排。
 *
 * 只给一个"合计 3.85 TB"的话，看不出是大家都用得差不多，还是有一台快撞线了；
 * 而这排柱子里最高的那根是不是变了色，一眼就知道。每根都有一条满高的浅槽，
 * 用量很低的机器也看得出"这里有一台，只是用得少"。
 */
function QuotaBars({ items }: { items: Array<{ id: string; name: string; pct: number }> }) {
  const shown = items.slice(0, MAX_QUOTA_BARS);
  return (
    <div
      role="img"
      aria-label={`配额用量最高的是 ${shown[0]?.name ?? ''}，${shown[0]?.pct.toFixed(0) ?? 0}%`}
      style={{ display: 'flex', alignItems: 'stretch', gap: 3, width: '100%', height: '100%' }}
    >
      {shown.map((q) => (
        <Tooltip key={q.id} content={`${q.name} · 已用 ${q.pct.toFixed(0)}%`}>
          <span
            style={{
              position: 'relative',
              flex: '1 1 0',
              maxWidth: 11,
              minWidth: 3,
              borderRadius: 2,
              background: 'var(--ds-bg-track)',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: `${q.pct}%`,
                minHeight: q.pct > 0 ? 2 : 0,
                background: quotaTone(q.pct),
                transition: 'height 0.6s cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            />
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * 月度成本那一格的说明文字。
 *
 * 优先级按"这句话有多可能让人做错判断"排：汇率是内置参考值时，那个数字本身就
 * 不该被当真，这件事比"几台快到期"更需要先说；到期提醒次之。
 */
function costHint(
  totals: { expiring: number; expired: number; mixedCurrency: boolean },
  settings: ReturnType<typeof useSettings>,
): string | undefined {
  if (settings.ratesMeta.usingFallback && totals.mixedCurrency) return '汇率为内置参考值，仅供估算';
  if (settings.ratesMeta.stale && totals.mixedCurrency) return '汇率已超过一天未更新';
  // 已过期排在即将到期前面：它更急，而且默认不计入上面那个金额，
  // 不说明的话会显得"机器多了成本却没涨"
  if (totals.expired > 0) {
    return settings.costIncludeExpired
      ? `${totals.expired} 台已过期`
      : `${totals.expired} 台已过期，未计入`;
  }
  if (totals.expiring > 0) return `${totals.expiring} 台 ${settings.expiryWarnDays} 天内到期`;
  if (totals.mixedCurrency) return '多币种已按汇率折算';
  return undefined;
}

/** 悬停时给出换算前的原始金额，一行一个币种。 */
function costTooltip(
  byCurrency: Map<string, number>,
  settings: ReturnType<typeof useSettings>,
): string {
  const lines = [...byCurrency.entries()].map(([code, amount]) => {
    const meta = CURRENCY_META[normalizeCurrency(code)];
    return `${meta.label} ${meta.symbol}${amount.toFixed(meta.decimals)} / 月`;
  });
  if (settings.ratesMeta.usingFallback) {
    lines.push('汇率未能联网获取，用的是内置参考值');
  } else if (settings.ratesMeta.fetchedAt > 0) {
    lines.push(`汇率更新于 ${ago(settings.ratesMeta.fetchedAt)}`);
  }
  return lines.join('\n');
}

/**
 * 机器格子的骨架：和真实格子同一套网格、大致同样的高度。
 * 内容一到位只是填色，不会从"一行字"撑成"满屏卡片"。
 */
function CardGridSkeleton() {
  return (
    <div className="ds-node-wrap ds-fade-in" aria-busy="true" aria-label="正在加载机器列表">
      <div className="ds-node-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="ds-node">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
              <Skeleton height={15} width={20} radius={2} />
              <Skeleton height={16} width="48%" />
            </div>
            <div style={{ display: 'grid', gap: 14, marginBottom: 22 }}>
              {[0, 1, 2, 3].map((j) => (
                <Skeleton key={j} height={4} radius={999} />
              ))}
            </div>
            <Skeleton height={12} width="64%" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 生效封禁数。变化不频繁，单独取一次就够，不必挂在实时流里。
 *
 * 没有 block:view 的人（比如访客）不发这个请求 —— 发了必然 403，
 * 只会在控制台刷一片红，还什么也拿不到。
 */
function BlockCount() {
  const { can } = useAuth();
  const allowed = can('block:view');
  const { data } = useAsync(() => (allowed ? api.blocks() : Promise.resolve(null)), [allowed]);
  if (!allowed) return <span style={{ color: 'var(--ds-text-disabled)' }}>—</span>;
  const n = data?.filter((r) => r.state === 'active').length ?? 0;
  return <Tween value={n} format={(v) => count(Math.round(v))} />;
}

type EventFilter = 'all' | 'alert';

function EventFeed({ events, nodes }: { events: EventLog[]; nodes: NodeState[] }) {
  const { can } = useAuth();
  const [filter, setFilter] = useState<EventFilter>('all');
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  if (events.length === 0) return null;

  const alerts = events.filter((e) => e.level !== 'info').length;
  const shown = (filter === 'alert' ? events.filter((e) => e.level !== 'info') : events).slice(0, 40);
  const canOpen = can('node:detail');

  return (
    <section className="ds-sec">
      <div className="ds-sec-head">
        <div>
          <h2 className="ds-sec-title">最近事件</h2>
          <p className="ds-sec-desc">上下线、告警、封禁与登录，最新的在最上面</p>
        </div>
        <Segmented
          size="s"
          value={filter}
          onChange={setFilter}
          ariaLabel="事件筛选"
          options={[
            { value: 'all', label: '全部', count: events.length },
            { value: 'alert', label: '告警', count: alerts },
          ]}
        />
      </div>
      <div className="ds-events">
        {shown.length === 0 ? (
          <div className="ds-text-body-sm text-ds-description" style={{ padding: '28px 40px', textAlign: 'center' }}>
            最近没有告警
          </div>
        ) : (
          shown.map((e) => {
            const node = e.nodeId ? byId.get(e.nodeId) : undefined;
            return (
              <div key={e.id} className="ds-event ds-fade-in" data-level={e.level}>
                <span className="ds-event-icon">
                  {e.level === 'info' ? <IconInfo size={15} /> : <IconAlert size={15} />}
                </span>
                <EventMessage event={e} node={node} canOpen={canOpen} />
                <Tooltip content={new Date(e.ts).toLocaleString('zh-CN', { hour12: false })}>
                  <span className="ds-event-time">{ago(e.ts)}</span>
                </Tooltip>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/**
 * 事件正文。
 *
 * 大部分机器事件以机器名开头（"新加坡 · 主库 磁盘使用率超过 85%"），就把开头那段
 * 做成链接；不以机器名开头的（"SSH 指令执行失败：…"）在句末补一个机器名，
 * 否则看不出是哪台机器出的事。
 */
function EventMessage({ event, node, canOpen }: { event: EventLog; node?: NodeState; canOpen: boolean }) {
  const name = node?.name;
  const link = (text: string) =>
    canOpen && node ? (
      <Link to={`/node/${node.id}`}>{text}</Link>
    ) : (
      <b style={{ fontWeight: 500, color: 'var(--ds-text-primary)' }}>{text}</b>
    );

  if (name && event.message.startsWith(name)) {
    return (
      <span className="ds-event-msg">
        {link(name)}
        {event.message.slice(name.length)}
      </span>
    );
  }
  return (
    <span className="ds-event-msg">
      {event.message}
      {name && (
        <>
          <span style={{ color: 'var(--ds-text-disabled)' }}> · </span>
          {link(name)}
        </>
      )}
    </span>
  );
}
