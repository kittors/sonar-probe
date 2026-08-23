import { useEffect, useMemo, useState } from 'react';
import { NodeCard, NodeRow } from '../components/NodeCard';
import { Chip, EmptyState, Segmented, Skeleton, StatusDot } from '../components/ui';
import { IconAlert, IconGrid, IconList, IconPlus, IconSearch, IconServer, IconShield } from '../components/icons';
import { seedEvents, useAsync, useLive } from '../lib/live';
import { EnrollDialog } from '../components/EnrollDialog';
import { Tooltip } from '../components/Tooltip';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { ago, bytes, count, money, rate } from '../lib/format';
import type { EventLog, NodeState, NodeStatus } from '../lib/types';

type Filter = 'all' | NodeStatus;
type View = 'grid' | 'list';
type Sort = 'status' | 'name' | 'cpu' | 'traffic';

const VIEW_KEY = 'sonar-view';

export function Overview() {
  const { nodes, events, conn } = useLive();
  const { can } = useAuth();
  const canViewBlocks = can('block:view');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('status');
  const [query, setQuery] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [view, setView] = useState<View>(
    () => (localStorage.getItem(VIEW_KEY) as View) ?? 'grid',
  );

  useEffect(() => localStorage.setItem(VIEW_KEY, view), [view]);

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
    const opts: Array<{ value: Filter; label: string }> = [
      { value: 'all', label: `全部 ${counts.all}` },
    ];
    if (counts.online > 0) opts.push({ value: 'online', label: `在线 ${counts.online}` });
    if (counts.warning > 0) opts.push({ value: 'warning', label: `告警 ${counts.warning}` });
    if (counts.offline > 0) opts.push({ value: 'offline', label: `离线 ${counts.offline}` });
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
    const rx = nodes.reduce((a, n) => a + (n.metric?.netRx ?? 0), 0);
    const tx = nodes.reduce((a, n) => a + (n.metric?.netTx ?? 0), 0);
    const traffic = nodes.reduce((a, n) => a + n.trafficUsed, 0);
    const cost = nodes.reduce((a, n) => {
      const d = n.billingCycle === 'yearly' ? 12 : n.billingCycle === 'quarterly' ? 3 : 1;
      return a + n.price / d;
    }, 0);
    const expiring = nodes.filter(
      (n) => n.expireAt > 0 && n.expireAt - Date.now() < 7 * 86_400_000,
    ).length;
    const overQuota = nodes.filter(
      (n) => n.trafficQuota > 0 && n.trafficUsed / n.trafficQuota > 0.8,
    ).length;
    const hasQuota = nodes.some((n) => n.trafficQuota > 0);
    // 机器之间账单日不一致时，这个合计跨的不是同一段时间，得说明一下
    const mixedCycle = new Set(nodes.map((n) => n.cycleStart)).size > 1;
    return { rx, tx, traffic, cost, expiring, overQuota, hasQuota, mixedCycle };
  }, [nodes]);

  const loading = conn !== 'live' && nodes.length === 0;

  return (
    <>
      {/*
        标题下面原本有一行"N 台机器在管，M 台在线，实时刷新中"。
        那句话说的每一件事，下面的汇总条都已经用数字讲过一遍了，
        留着只是把首屏往下推。只在还没连上时留一句状态。
      */}
      <section style={{ marginBottom: 'clamp(14px, 2vw, 20px)' }}>
        <h1 className="ds-text-h1 text-ds-primary ds-animate-in" style={{ margin: 0 }}>
          机器概览
        </h1>
        {loading && (
          <p
            className="ds-text-body-sm text-ds-description ds-animate-in"
            style={{ margin: '6px 0 0' }}
          >
            正在建立实时连接…
          </p>
        )}
      </section>

      {/*
        用 flex-wrap 而不是 grid。
        grid 的 auto-fit 在格子数除不尽列数时会留下真空位 —— 5 个格子排 2 列，
        最后一行只有 1 个，右边那半格是空的，露出一块没有背景色的方块。
        flex 的最后一行会让项目按 flex-grow 拉伸填满，天然没有这个问题。

        分隔线由每个格子自己的 box-shadow 画（右 + 下），最外圈那道被
        overflow:hidden 裁掉，所以不会在容器边缘留下多余的线。
      */}
      <div
        className="ds-glass-card ds-animate-in ds-summary"
        style={{
          background: 'var(--ds-bg-surface)',
          overflow: 'hidden',
          marginBottom: 'clamp(16px, 2vw, 22px)',
          animationDelay: '100ms',
        }}
      >
        <SummaryCell
          icon={<IconServer size={13} />}
          label="在线 / 总数"
          value={
            <>
              {counts.online}
              <span style={{ color: 'var(--ds-text-description)', fontWeight: 500 }}>
                {' '}
                / {counts.all}
              </span>
            </>
          }
          hint={
            counts.warning + counts.offline > 0
              ? `${counts.warning} 告警 · ${counts.offline} 离线`
              : '全部正常'
          }
          tone={counts.offline > 0 ? 'warn' : 'ok'}
          loading={loading}
        />
        <SummaryCell
          label="当前出站"
          value={rate(totals.tx)}
          hint={`入站 ${rate(totals.rx)}`}
          loading={loading}
        />
        <SummaryCell
          /* 各机器的账单日可能不同，这就是各自周期用量的合计，不是同一个自然月 */
          label="周期流量"
          value={bytes(totals.traffic)}
          // 一台配额都没设的时候说"配额充足"是句空话
          hint={
            totals.overQuota > 0
              ? `${totals.overQuota} 台接近配额`
              : totals.hasQuota
                ? '配额充足'
                : totals.mixedCycle
                  ? '各机器按自身周期统计'
                  : undefined
          }
          tone={totals.overQuota > 0 ? 'warn' : undefined}
          loading={loading}
        />
        {/*
          下面两格按"有没有信息量"决定显不显示，而不是一律占位。
          没权限就摆一个写着"你没有查看权限"的空格子，等于用一块屏幕告诉人一件
          与他无关的事；没人填过价格却显示"月度成本 未设置"，同样是白占地方。
        */}
        {canViewBlocks && (
          <SummaryCell
            icon={<IconShield size={13} />}
            label="生效封禁"
            value={<BlockCount />}
            hint="点开机器详情可管理"
            loading={loading}
          />
        )}
        {totals.cost > 0 && (
          <SummaryCell
            label="月度成本"
            value={money(totals.cost, 'USD')}
            hint={totals.expiring > 0 ? `${totals.expiring} 台 7 天内到期` : undefined}
            tone={totals.expiring > 0 ? 'warn' : undefined}
            loading={loading}
          />
        )}
      </div>

      {/* —— 工具栏 —— */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div style={{ position: 'relative', flex: '1 1 200px', maxWidth: 300, minWidth: 160 }}>
          <IconSearch
            size={14}
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--ds-text-disabled)',
              pointerEvents: 'none',
            }}
          />
          <input
            className="ds-input"
            style={{ paddingLeft: 31 }}
            placeholder="搜索名称、IP、厂商、标签…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索机器"
          />
        </div>

        {/* 只有一种状态时整个筛选器都不显示 —— 那时「全部」和「在线」是同一批机器，
            摆两个等价的按钮，外加两个「0」，全是噪声 */}
        {statusOptions.length > 2 && (
          <Segmented value={filter} onChange={setFilter} options={statusOptions} />
        )}

        <span style={{ flex: 1 }} />

        <Segmented
          value={sort}
          onChange={setSort}
          options={[
            { value: 'status', label: '按状态' },
            { value: 'cpu', label: '按负载' },
            { value: 'traffic', label: '按流量' },
            { value: 'name', label: '按名称' },
          ]}
        />

        <div
          style={{
            display: 'inline-flex',
            padding: 2,
            gap: 2,
            background: 'var(--ds-bg-sunken)',
            borderRadius: 8,
            border: '1px solid var(--ds-border)',
          }}
        >
          {(
            [
              ['grid', <IconGrid key="g" size={14} />, '网格视图'],
              ['list', <IconList key="l" size={14} />, '列表视图'],
            ] as const
          ).map(([v, icon, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-label={label}
              aria-pressed={view === v}
              style={{
                width: 28,
                height: 26,
                display: 'grid',
                placeItems: 'center',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                background: view === v ? 'var(--ds-bg-surface)' : 'transparent',
                color: view === v ? 'var(--ds-text-primary)' : 'var(--ds-text-description)',
                boxShadow: view === v ? 'var(--ds-shadow-card)' : 'none',
                transition: 'all 0.18s',
              }}
            >
              {icon}
            </button>
          ))}
        </div>

        {/*
          接入机器。放在工具栏最右而不是标题旁边：这一排都是"对这个列表做点什么"，
          加机器也属于同一类动作，散在两处会让人多找一次。
          只有能管机器的人看得到 —— 这个按钮背后是 agent token。
        */}
        {can('node:manage') && (
          <Tooltip content="接入新机器">
            <button
              className="ds-btn-icon ds-btn-icon-accent"
              onClick={() => setEnrolling(true)}
              aria-label="接入新机器"
            >
              <IconPlus size={16} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* —— 机器列表 —— */}
      {/*
        加载态不铺骨架卡片。
        加载时根本不知道有几台机器，铺 8 张假卡片再塌成 2 张，跳变比不显示更刺眼；
        而首次连接通常只有几百毫秒，那一闪反而成了噪声。
        这里只留一行克制的提示，等真数据到了直接渲染。
      */}
      {loading ? (
        <CardGridSkeleton view={view} />
      ) : visible.length === 0 ? (
        <div className="ds-surface">
          <EmptyState
            icon={<IconSearch size={30} />}
            title="没有匹配的机器"
            hint={query ? `换个关键词试试，当前搜索「${query}」` : '调整筛选条件看看'}
          />
        </div>
      ) : view === 'grid' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(292px, 100%), 1fr))',
            gap: 14,
          }}
        >
          {visible.map((n, i) => (
            <NodeCard key={n.id} node={n} index={i} />
          ))}
        </div>
      ) : (
        /*
         * 列表视图是七列的表格，最窄也要 830px 左右。
         * 原来这里是 overflow:hidden —— 在手机上后面五列既看不见也滚不动，
         * 等于把内容删了。表格放不下时该给横向滚动，而不是裁掉。
         *
         * 纵向仍然 hidden，用来裁掉子元素在圆角处溢出的直角背景。
         */
        <div className="ds-surface ds-table-scroll" style={{ overflowY: 'hidden', overflowX: 'auto' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                'minmax(180px,1.6fr) 90px repeat(3, minmax(88px,1fr)) minmax(120px,1.1fr) 92px',
              gap: 12,
              padding: '9px 16px',
              borderBottom: '1px solid var(--ds-border)',
              background: 'var(--ds-bg-sunken)',
            }}
            className="ds-text-caption text-ds-description"
          >
            <span>机器</span>
            <span>厂商</span>
            <span>CPU</span>
            <span>内存</span>
            <span>磁盘</span>
            <span>网络</span>
            <span style={{ textAlign: 'right' }}>周期流量</span>
          </div>
          {visible.map((n) => (
            <NodeRow key={n.id} node={n} />
          ))}
        </div>
      )}

      {/* —— 事件流 —— */}
      <EventFeed events={events} nodes={nodes} />
      {enrolling && <EnrollDialog onClose={() => setEnrolling(false)} />}
    </>
  );
}

/**
 * 机器网格的骨架。
 *
 * 用和真实卡片一样的网格和高度，而不是居中转一个圈 —— 后者会让内容一到位就
 * 从"一行字"撑成"满屏卡片"，正是那一下跳变让人觉得页面在闪。
 *
 * 摆三张：太少显得空，太多在数据只有一两台时反差更大。
 */
function CardGridSkeleton({ view }: { view: View }) {
  if (view === 'list') {
    return (
      <div className="ds-surface ds-fade-in" style={{ padding: 12 }} aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 6px' }}>
            <Skeleton height={9} width={9} radius={999} />
            <Skeleton height={15} width={150} />
            <Skeleton height={13} width={110} />
            <span style={{ flex: 1 }} />
            <Skeleton height={13} width={64} />
            <Skeleton height={13} width={64} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      className="ds-fade-in"
      aria-busy="true"
      aria-label="正在加载机器列表"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(290px, 100%), 1fr))',
        gap: 14,
      }}
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="ds-glass-card" style={{ padding: '15px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Skeleton height={7} width={7} radius={999} />
            <div style={{ flex: 1, display: 'grid', gap: 6 }}>
              <Skeleton height={15} width="62%" />
              <Skeleton height={12} width="46%" />
            </div>
            <Skeleton height={12} width={16} radius={3} />
          </div>
          <Skeleton height={38} radius={8} style={{ marginBottom: 12 }} />
          <div style={{ display: 'grid', gap: 7, marginBottom: 12 }}>
            <Skeleton height={5} radius={999} />
            <Skeleton height={5} radius={999} />
            <Skeleton height={5} radius={999} />
          </div>
          <Skeleton height={13} width="70%" />
        </div>
      ))}
    </div>
  );
}

function SummaryCell({
  icon,
  label,
  value,
  hint,
  tone,
  loading,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'ok' | 'warn';
  loading?: boolean;
}) {
  return (
    <div className="ds-summary-cell">
      <div
        className="ds-text-caption text-ds-description"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          marginBottom: 5,
          minWidth: 0,
        }}
      >
        {icon}
        <span className="ds-ellipsis">{label}</span>
      </div>
      {/* 加载时保留数字位的排版，只把内容换成占位符 ——
          灰条会让这一格看起来像坏了，而 "—" 明确表示"还没有值" */}
      <div
        className="ds-num-lg ds-ellipsis"
        style={loading ? { color: 'var(--ds-text-disabled)' } : undefined}
      >
        {loading ? '—' : value}
      </div>
      {hint && !loading && (
        <div
          /*
            提示行允许换行，不做省略。
            数值和标签截断了还能猜出来，说明文字截成"各机器按自身周期…"
            就彻底失去意义了 —— 那正是它存在的理由。
          */
          className="ds-text-caption"
          style={{
            overflowWrap: 'anywhere',
            marginTop: 3,
            color:
              tone === 'warn'
                ? 'var(--color-warn)'
                : tone === 'ok'
                  ? 'var(--color-ok)'
                  : 'var(--ds-text-description)',
          }}
        >
          {hint}
        </div>
      )}
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
  return <>{count(n)}</>;
}

const LEVEL_COLOR: Record<EventLog['level'], string> = {
  info: 'var(--ds-text-description)',
  warn: 'var(--color-warn)',
  error: 'var(--color-danger)',
};

function EventFeed({ events, nodes }: { events: EventLog[]; nodes: NodeState[] }) {
  const nameOf = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  if (events.length === 0) return null;

  return (
    <section style={{ marginTop: 'clamp(20px, 3vw, 30px)' }}>
      <h2
        className="ds-text-subtitle text-ds-primary"
        style={{ margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 7 }}
      >
        <IconAlert size={15} style={{ color: 'var(--ds-text-description)' }} />
        最近事件
        <Chip>{events.length}</Chip>
      </h2>
      <div
        className="ds-surface"
        style={{
          maxHeight: 268,
          overflowY: 'auto',
          padding: '4px 0',
        }}
      >
        {events.slice(0, 40).map((e) => {
          const node = e.nodeId ? nameOf.get(e.nodeId) : undefined;
          return (
            <div
              key={e.id}
              className="ds-fade-in"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '7px 16px',
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: LEVEL_COLOR[e.level],
                  flexShrink: 0,
                }}
              />
              {node && <StatusDot status={node.status} size={5} />}
              <span
                className="ds-text-body-sm text-ds-secondary"
                style={{
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {e.message}
              </span>
              <span className="ds-text-caption text-ds-description tnum" style={{ flexShrink: 0 }}>
                {ago(e.ts)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
