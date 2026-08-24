import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type AdminUser, type LedgerRow, type TrafficRule } from '../lib/api';
import { AdminSettings } from './AdminSettings';
import { useAsync, useLive } from '../lib/live';
import { useAuth } from '../lib/auth';
import { ASSIGNABLE_ROLES, ROLE_LABEL, type Capability, type Role } from '../lib/permissions';
import { ago, bytes, clockTime, count, isNearQuota, percent, quotaTone } from '../lib/format';
import { CountryBadge } from '../components/CountryBadge';
import { Tooltip } from '../components/Tooltip';
import { Chip, EmptyState, Field, RawCheckbox, SectionCard, Segmented, Select, Skeleton, Stat } from '../components/ui';
import {
  IconAlert,
  IconChevronLeft,
  IconCheck,
  IconGlobe,
  IconInfo,
  IconShield,
  IconTrash,
  IconX,
} from '../components/icons';

type Tab = 'users' | 'online' | 'audit' | 'traffic' | 'settings';

export function Admin() {
  const { can, me } = useAuth();
  const [tab, setTab] = useState<Tab>('users');

  if (!can('user:view') && !can('audit:view') && !can('alert:view') && !can('settings:view')) {
    return (
      <div className="ds-surface">
        <EmptyState
          icon={<IconShield size={30} />}
          title="你没有管理权限"
          hint="需要管理员给你开通「查看用户列表」或「查看访问审计」才能进入这里。"
        />
      </div>
    );
  }

  const tabs: Array<{ value: Tab; label: string; show: boolean }> = [
    { value: 'users', label: '用户与权限', show: can('user:view') },
    { value: 'online', label: '在线与访客', show: can('audit:view') },
    { value: 'audit', label: '审计日志', show: can('audit:view') },
    { value: 'traffic', label: '流量阈值', show: can('alert:view') },
    // 放在最后：它管的是全站口径，改的频率远低于前面几项日常要看的东西
    { value: 'settings', label: '通用设置', show: can('settings:view') },
  ];
  const visible = tabs.filter((t) => t.show);
  const active = visible.some((t) => t.value === tab) ? tab : (visible[0]?.value ?? 'users');

  return (
    <>
      <Link
        to="/"
        className="ds-text-body-sm text-ds-description"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, textDecoration: 'none', marginBottom: 12 }}
      >
        <IconChevronLeft size={14} />
        返回概览
      </Link>

      <header style={{ marginBottom: 18 }}>
        <h1 className="ds-text-slogan text-ds-primary" style={{ margin: 0, fontSize: 'clamp(22px, 2.6vw, 30px)' }}>
          管理后台
        </h1>
        <p className="ds-text-body text-ds-description" style={{ margin: '6px 0 0' }}>
          当前身份 {me?.name} · {me?.roleLabel}
        </p>
      </header>

      <div style={{ marginBottom: 16 }}>
        <Segmented
          value={active}
          onChange={(v) => setTab(v)}
          options={visible.map((t) => ({ value: t.value, label: t.label }))}
        />
      </div>

      {active === 'users' && <UsersTab />}
      {active === 'online' && <OnlineTab />}
      {active === 'audit' && <AuditTab />}
      {active === 'traffic' && <TrafficTab />}
      {active === 'settings' && <AdminSettings />}
    </>
  );
}

// ————————————————————————————————————————————————————————
// 用户与权限
// ————————————————————————————————————————————————————————

function UsersTab() {
  const { can, me } = useAuth();
  const users = useAsync(() => api.adminUsers(), []);
  const catalog = useAsync(() => api.adminCapabilities(), []);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editable = can('user:manage');

  async function patch(id: string, body: Parameters<typeof api.updateUser>[1]) {
    setError(null);
    try {
      await api.updateUser(id, body);
      users.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败');
    }
  }

  if (users.loading && !users.data) return <Skeleton height={260} />;

  const list = users.data ?? [];
  const admins = list.filter((u) => u.role === 'admin' && !u.disabled).length;

  return (
    <>
      {error && (
        <div
          className="ds-surface"
          style={{
            padding: '10px 14px',
            marginBottom: 12,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            borderColor: 'color-mix(in srgb, var(--color-danger) 28%, transparent)',
            background: 'color-mix(in srgb, var(--color-danger) 6%, transparent)',
          }}
        >
          <IconAlert size={14} style={{ color: 'var(--color-danger)' }} />
          <span className="ds-text-body-sm text-ds-secondary">{error}</span>
        </div>
      )}

      <SectionCard
        title="用户"
        subtitle={`${list.length} 个账号 · ${admins} 位管理员 · ${list.filter((u) => u.kind === 'guest').length} 个访客身份`}
        padded={false}
        actions={!editable ? <Chip>只读</Chip> : undefined}
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr className="ds-text-caption text-ds-description">
                {['用户', '来源', '角色', '能力数', '最近活跃', ''].map((h, i) => (
                  <th
                    key={h + i}
                    style={{
                      textAlign: 'left',
                      fontWeight: 400,
                      padding: '9px 12px',
                      borderBottom: '1px solid var(--ds-border)',
                      background: 'var(--ds-bg-sunken)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  isSelf={u.id === me?.id}
                  editable={editable}
                  expanded={editing === u.id}
                  onToggle={() => setEditing(editing === u.id ? null : u.id)}
                  onPatch={(body) => void patch(u.id, body)}
                  onKick={async () => {
                    await api.kickUser(u.id);
                    users.reload();
                  }}
                  catalog={catalog.data}
                />
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

const RISK_COLOR: Record<string, string> = {
  low: 'var(--ds-text-description)',
  medium: 'var(--color-warn)',
  high: 'var(--color-danger)',
};

function UserRow({
  user,
  isSelf,
  editable,
  expanded,
  onToggle,
  onPatch,
  onKick,
  catalog,
}: {
  user: AdminUser;
  isSelf: boolean;
  editable: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (body: Parameters<typeof api.updateUser>[1]) => void;
  onKick: () => Promise<void>;
  catalog: Awaited<ReturnType<typeof api.adminCapabilities>> | null;
}) {
  const caps = new Set(user.capabilities);
  const roleDefaults = new Set(
    catalog?.roles.find((r) => r.value === user.role)?.capabilities ?? [],
  );

  /** 勾选 = 授予，取消 = 收回。相对角色默认值算出 granted/revoked 两个差集。 */
  function toggleCap(cap: Capability, on: boolean) {
    const granted = new Set(user.granted);
    const revoked = new Set(user.revoked);
    granted.delete(cap);
    revoked.delete(cap);

    if (on && !roleDefaults.has(cap)) granted.add(cap);
    if (!on && roleDefaults.has(cap)) revoked.add(cap);

    onPatch({ granted: [...granted], revoked: [...revoked] });
  }

  return (
    <>
      <tr style={{ borderBottom: '1px solid var(--ds-border)', opacity: user.disabled ? 0.5 : 1 }}>
        <td style={{ padding: '10px 12px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {user.avatar ? (
              <img
                src={user.avatar}
                alt=""
                width={26}
                height={26}
                style={{ borderRadius: '50%', flexShrink: 0 }}
              />
            ) : (
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  background: 'var(--ds-bg-sunken)',
                  color: 'var(--ds-text-description)',
                  flexShrink: 0,
                }}
              >
                <IconGlobe size={13} />
              </span>
            )}
            <span style={{ minWidth: 0 }}>
              <span
                className="ds-text-body-sm"
                style={{ display: 'block', fontWeight: 500, color: 'var(--ds-text-primary)' }}
              >
                {user.name}
                {isSelf && <span className="ds-text-caption text-ds-description"> （你）</span>}
              </span>
              <span className="ds-text-caption text-ds-description">{user.login}</span>
            </span>
          </span>
        </td>
        <td style={{ padding: '10px 12px' }}>
          <Chip color={user.kind === 'github' ? 'var(--color-brand)' : undefined}>
            {user.kind === 'github' ? 'GitHub' : '访客'}
          </Chip>
        </td>
        <td style={{ padding: '10px 12px' }}>
          {editable && !isSelf ? (
            <Select
                value={user.role}
                onChange={(v) => onPatch({ role: v as Role })}
                width={104}
                ariaLabel="角色"
                options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
              />
          ) : (
            <Chip color={user.role === 'admin' ? 'var(--color-danger)' : undefined}>
              {ROLE_LABEL[user.role]}
            </Chip>
          )}
        </td>
        <td className="ds-text-body-sm tnum text-ds-secondary" style={{ padding: '10px 12px' }}>
          {user.capabilities.length}
          {user.granted.length > 0 && (
            <span style={{ color: 'var(--color-ok)' }}> +{user.granted.length}</span>
          )}
          {user.revoked.length > 0 && (
            <span style={{ color: 'var(--color-danger)' }}> −{user.revoked.length}</span>
          )}
        </td>
        <td className="ds-text-caption text-ds-description tnum" style={{ padding: '10px 12px' }}>
          {ago(user.lastSeen)}
        </td>
        <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
          <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={onToggle}>
            {expanded ? '收起' : '权限'}
          </button>
          {editable && !isSelf && (
            <>
              <button
                className="ds-btn ds-btn-ghost ds-btn-s"
                style={{ marginLeft: 5 }}
                onClick={() => void onKick()}
                title="强制下线，需要重新登录"
              >
                踢下线
              </button>
              <button
                className="ds-btn ds-btn-ghost ds-btn-s"
                style={{ marginLeft: 5, color: user.disabled ? 'var(--color-ok)' : 'var(--color-danger)' }}
                onClick={() => onPatch({ disabled: !user.disabled })}
              >
                {user.disabled ? '启用' : '停用'}
              </button>
            </>
          )}
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={6} style={{ padding: 0, background: 'var(--ds-bg-sunken)' }}>
            <div className="ds-fade-in" style={{ padding: '14px 16px' }}>
              <p className="ds-text-caption text-ds-description" style={{ margin: '0 0 12px' }}>
                勾选框显示的是最终生效的权限。角色默认给的权限取消后会记为「收回」，
                角色没有的权限勾上会记为「单独授予」。
                {!editable && ' 你没有修改权限的能力，这里只能查看。'}
              </p>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))',
                  gap: 16,
                }}
              >
                {catalog?.groups.map((g) => (
                  <div key={g.group}>
                    <div
                      className="ds-text-caption"
                      style={{ fontWeight: 600, color: 'var(--ds-text-secondary)', marginBottom: 7 }}
                    >
                      {g.group}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {g.items.map((item) => {
                        const on = caps.has(item.key);
                        const isDefault = roleDefaults.has(item.key);
                        return (
                          <label
                            key={item.key}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 7,
                              cursor: editable ? 'pointer' : 'default',
                            }}
                          >
                            <RawCheckbox
                              checked={on}
                              disabled={!editable}
                              onChange={(v) => toggleCap(item.key, v)}
                              // 高危能力用红色，勾上时一眼看出分量不同
                              tone={item.risk === 'high' ? 'danger' : undefined}
                              ariaLabel={item.label}
                              style={{ marginTop: 2 }}
                            />
                            <span style={{ minWidth: 0 }}>
                              <span
                                className="ds-text-caption"
                                style={{
                                  color: on ? 'var(--ds-text-primary)' : 'var(--ds-text-description)',
                                }}
                              >
                                {item.label}
                              </span>
                              {item.risk !== 'low' && (
                                <span
                                  className="ds-text-caption"
                                  style={{ color: RISK_COLOR[item.risk], marginLeft: 4 }}
                                >
                                  ●
                                </span>
                              )}
                              {on !== isDefault && (
                                <span
                                  className="ds-text-caption"
                                  style={{
                                    marginLeft: 4,
                                    color: on ? 'var(--color-ok)' : 'var(--color-danger)',
                                  }}
                                >
                                  {on ? '已授予' : '已收回'}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ————————————————————————————————————————————————————————
// 在线与访客
// ————————————————————————————————————————————————————————

function OnlineTab() {
  const online = useAsync(() => api.online(), []);
  const visitors = useAsync(() => api.visitors(7), []);
  const { reload: reloadOnline } = online;

  // 在线状态要贴近实时，10 秒刷一次
  useEffect(() => {
    const t = setInterval(reloadOnline, 10_000);
    return () => clearInterval(t);
  }, [reloadOnline]);

  const list = online.data ?? [];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionCard
        title="此刻在线"
        subtitle={
          list.length > 0
            ? `${list.length} 人正在看，90 秒内有活动即视为在线`
            : '当前没有人在线'
        }
        padded={false}
        actions={
          <Chip color={list.length > 0 ? 'var(--color-ok)' : undefined}>{list.length} 人</Chip>
        }
      >
        {online.loading && !online.data ? (
          <div style={{ padding: 18 }}>
            <Skeleton height={100} />
          </div>
        ) : list.length === 0 ? (
          <EmptyState title="暂时没有人在线" hint="有人打开面板时会实时出现在这里。" />
        ) : (
          <div>
            {list.map((o) => (
              <div
                key={o.sessionId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '11px 16px',
                  borderBottom: '1px solid var(--ds-border)',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--color-ok)',
                    animation: 'ds-pulse-ring 2.4s infinite',
                    color: 'var(--color-ok)',
                    flexShrink: 0,
                  }}
                />
                {o.user.avatar ? (
                  <img src={o.user.avatar} alt="" width={24} height={24} style={{ borderRadius: '50%' }} />
                ) : (
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      display: 'grid',
                      placeItems: 'center',
                      background: 'var(--ds-bg-sunken)',
                      color: 'var(--ds-text-description)',
                    }}
                  >
                    <IconGlobe size={12} />
                  </span>
                )}
                <span style={{ minWidth: 120 }}>
                  <span className="ds-text-body-sm" style={{ display: 'block', fontWeight: 500 }}>
                    {o.user.name}
                  </span>
                  <span className="ds-text-caption text-ds-description">
                    {ROLE_LABEL[o.user.role]}
                  </span>
                </span>
                <Chip color={o.user.kind === 'github' ? 'var(--color-brand)' : undefined}>
                  {o.user.kind === 'github' ? 'GitHub' : '访客'}
                </Chip>
                <span className="ds-text-caption text-ds-description tnum" style={{ minWidth: 108 }}>
                  {o.ip}
                </span>
                {/* 完整 UA 太长，截断显示，悬停给全文 */}
                <Tooltip content={o.userAgent} maxWidth={420}>
                  <span
                    className="ds-text-caption text-ds-secondary"
                    style={{
                      flex: 1,
                      minWidth: 130,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {o.currentView ? `正在看 ${friendlyView(o.currentView)}` : '概览页'}
                  </span>
                </Tooltip>
                <span className="ds-text-caption text-ds-description tnum">
                  进入于 {clockTime(o.since)} · {ago(o.lastActive)}活跃
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="近 7 天来访"
        subtitle="谁来过、看了多少、用了几个 IP"
        padded={false}
      >
        {visitors.loading && !visitors.data ? (
          <div style={{ padding: 18 }}>
            <Skeleton height={120} />
          </div>
        ) : (visitors.data ?? []).length === 0 ? (
          <EmptyState title="近 7 天没有访问记录" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead>
                <tr className="ds-text-caption text-ds-description">
                  {['访客', '来源', '会话数', '操作数', 'IP 数', '首次', '最近'].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: 'left',
                        fontWeight: 400,
                        padding: '9px 12px',
                        borderBottom: '1px solid var(--ds-border)',
                        background: 'var(--ds-bg-sunken)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(visitors.data ?? []).map((v) => (
                  <tr key={v.userId} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                    <td className="ds-text-body-sm" style={{ padding: '9px 12px', fontWeight: 500 }}>
                      {v.name}
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <Chip color={v.kind === 'github' ? 'var(--color-brand)' : undefined}>
                        {v.kind === 'github' ? 'GitHub' : '访客'}
                      </Chip>
                    </td>
                    <td className="ds-text-body-sm tnum text-ds-secondary" style={{ padding: '9px 12px' }}>
                      {count(v.visits)}
                    </td>
                    <td className="ds-text-body-sm tnum text-ds-secondary" style={{ padding: '9px 12px' }}>
                      {count(v.actions)}
                    </td>
                    <td className="ds-text-body-sm tnum text-ds-secondary" style={{ padding: '9px 12px' }}>
                      {count(v.ipCount)}
                    </td>
                    <td className="ds-text-caption tnum text-ds-description" style={{ padding: '9px 12px' }}>
                      {ago(v.firstSeen)}
                    </td>
                    <td className="ds-text-caption tnum text-ds-description" style={{ padding: '9px 12px' }}>
                      {ago(v.lastSeen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function friendlyView(view: string): string {
  if (view.startsWith('node:')) return `机器 ${view.slice(5)}`;
  if (view === 'overview') return '概览页';
  if (view === 'admin') return '管理后台';
  return view;
}

// ————————————————————————————————————————————————————————
// 审计日志
// ————————————————————————————————————————————————————————

const ACTION_LABEL: Record<string, { text: string; color: string }> = {
  login: { text: '登录', color: 'var(--color-ok)' },
  logout: { text: '登出', color: 'var(--ds-text-description)' },
  view: { text: '浏览', color: 'var(--ds-text-description)' },
  denied: { text: '被拒绝', color: 'var(--color-danger)' },
  'block.enforce': { text: '下发封禁', color: 'var(--color-danger)' },
  'block.dryrun': { text: '生成规则', color: 'var(--color-warn)' },
  'block.remove': { text: '解除封禁', color: 'var(--color-warn)' },
  'user.update': { text: '改权限', color: 'var(--color-danger)' },
  'user.kick': { text: '踢下线', color: 'var(--color-warn)' },
  'alert.create': { text: '建阈值', color: 'var(--color-brand)' },
  'alert.delete': { text: '删阈值', color: 'var(--color-warn)' },
};

function AuditTab() {
  const [filter, setFilter] = useState<'all' | 'sensitive'>('all');
  const log = useAsync(() => api.auditLog({ limit: 200 }), []);

  const rows = useMemo(() => {
    const list = log.data ?? [];
    if (filter === 'all') return list;
    // 敏感操作：改了东西或被拒绝的，浏览记录太多会淹没它们
    return list.filter((r) => r.action !== 'view');
  }, [log.data, filter]);

  return (
    <SectionCard
      title="审计日志"
      subtitle="所有登录、浏览和有后果的操作都会留痕"
      padded={false}
      actions={
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'sensitive', label: '仅操作' },
          ]}
        />
      }
    >
      {log.loading && !log.data ? (
        <div style={{ padding: 18 }}>
          <Skeleton height={200} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="暂无记录" />
      ) : (
        <div style={{ maxHeight: 560, overflowY: 'auto' }}>
          {rows.map((r) => {
            const meta = ACTION_LABEL[r.action] ?? {
              text: r.action,
              color: 'var(--ds-text-description)',
            };
            return (
              <div
                key={r.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 16px',
                  borderBottom: '1px solid var(--ds-border)',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  className="ds-chip"
                  style={{
                    color: meta.color,
                    background: `color-mix(in srgb, ${meta.color} 10%, transparent)`,
                    borderColor: `color-mix(in srgb, ${meta.color} 22%, transparent)`,
                    minWidth: 62,
                    justifyContent: 'center',
                  }}
                >
                  {meta.text}
                </span>
                <span className="ds-text-body-sm" style={{ fontWeight: 500, minWidth: 90 }}>
                  {r.user?.name ?? '未知用户'}
                </span>
                <span
                  className="ds-text-caption text-ds-secondary"
                  style={{
                    flex: 1,
                    minWidth: 140,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.target && <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.target}</code>}
                  {r.detail && <span className="text-ds-description"> · {r.detail}</span>}
                </span>
                <span className="ds-text-caption text-ds-description tnum">{r.ip}</span>
                <span className="ds-text-caption text-ds-description tnum" style={{ minWidth: 62, textAlign: 'right' }}>
                  {ago(r.ts)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ————————————————————————————————————————————————————————
// 流量阈值
// ————————————————————————————————————————————————————————

function TrafficTab() {
  const { can } = useAuth();
  const { nodes } = useLive();
  const rules = useAsync(() => api.trafficRules(), []);
  const ledger = useAsync(() => api.trafficLedger(30), []);
  const [error, setError] = useState<string | null>(null);

  const manage = can('alert:manage');

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {manage && (
        <RuleComposer
          nodes={nodes.map((n) => ({ id: n.id, name: n.name }))}
          onCreated={() => {
            setError(null);
            rules.reload();
          }}
          onError={setError}
        />
      )}

      {error && (
        <div
          className="ds-surface"
          style={{
            padding: '10px 14px',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            borderColor: 'color-mix(in srgb, var(--color-danger) 28%, transparent)',
            background: 'color-mix(in srgb, var(--color-danger) 6%, transparent)',
          }}
        >
          <IconAlert size={14} style={{ color: 'var(--color-danger)' }} />
          <span className="ds-text-body-sm text-ds-secondary">{error}</span>
        </div>
      )}

      <SectionCard
        title="已设阈值"
        subtitle={`${(rules.data ?? []).filter((r) => r.enabled).length} 条生效中`}
        padded={false}
      >
        {rules.loading && !rules.data ? (
          <div style={{ padding: 18 }}>
            <Skeleton height={100} />
          </div>
        ) : (rules.data ?? []).length === 0 ? (
          <EmptyState
            icon={<IconInfo size={26} />}
            title="还没有设置阈值"
            hint="设一条之后，流量超线时会在事件流里提醒你。"
          />
        ) : (
          <div>
            {(rules.data ?? []).map((r) => (
              <RuleRow
                key={r.id}
                rule={r}
                nodeName={nodes.find((n) => n.id === r.nodeId)?.name ?? '全部机器'}
                manage={manage}
                onChanged={() => rules.reload()}
              />
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="流量账本" subtitle="近 30 天，按机器汇总" padded={false}>
        {ledger.loading && !ledger.data ? (
          <div style={{ padding: 18 }}>
            <Skeleton height={200} />
          </div>
        ) : (
          <LedgerTable rows={ledger.data ?? []} />
        )}
      </SectionCard>
    </div>
  );
}

function RuleComposer({
  nodes,
  onCreated,
  onError,
}: {
  nodes: Array<{ id: string; name: string }>;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [nodeId, setNodeId] = useState('');
  const [scope, setScope] = useState<'day' | 'month'>('month');
  const [compare, setCompare] = useState<'absolute' | 'quota'>('quota');
  const [value, setValue] = useState('80');
  const [unit, setUnit] = useState<'GB' | 'TB'>('TB');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      onError('阈值必须是正数');
      return;
    }
    setBusy(true);
    try {
      await api.createTrafficRule({
        nodeId,
        scope,
        compare,
        // 绝对量按选定单位换算成字节；配额模式直接就是百分比
        threshold: compare === 'quota' ? n : n * (unit === 'TB' ? 1024 ** 4 : 1024 ** 3),
        note,
      });
      setNote('');
      onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="新建阈值" subtitle="流量超过设定值时在事件流里提醒">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="机器">
          <Select
              value={nodeId}
              onChange={setNodeId}
              width={168}
              ariaLabel="机器"
              options={[
                { value: '', label: '全部机器' },
                ...nodes.map((n) => ({ value: n.id, label: n.name })),
              ]}
            />
        </Field>

        <Field label="周期">
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'month', label: '本月' },
              { value: 'day', label: '当日' },
            ]}
          />
        </Field>

        <Field label="判定方式">
          <Segmented
            value={compare}
            onChange={setCompare}
            options={[
              { value: 'quota', label: '按配额百分比' },
              { value: 'absolute', label: '按绝对量' },
            ]}
          />
        </Field>

        <Field label="阈值">
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="ds-input"
              style={{ width: 86 }}
              value={value}
              inputMode="decimal"
              onChange={(e) => setValue(e.target.value)}
            />
            {compare === 'quota' ? (
              <span
                className="ds-chip"
                style={{ height: 34, paddingInline: 10 }}
              >
                %
              </span>
            ) : (
              <Segmented
                value={unit}
                onChange={setUnit}
                options={[
                  { value: 'GB', label: 'GB' },
                  { value: 'TB', label: 'TB' },
                ]}
              />
            )}
          </div>
        </Field>

        <Field label="备注">
          <input
            className="ds-input"
            style={{ width: 180 }}
            placeholder="为什么要盯这条"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        <button className="ds-btn ds-btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? '创建中…' : '添加'}
        </button>
      </div>

      <p className="ds-text-caption text-ds-description" style={{ margin: '11px 0 0', lineHeight: 1.6 }}>
        {compare === 'quota'
          ? '按配额百分比更省心 —— 换套餐时不用回来改阈值。没设配额的机器会被跳过。'
          : '按绝对量适合不限量但你自己想控制成本的机器。'}
        {' 同一条规则在同一周期内只提醒一次，不会刷屏。'}
      </p>
    </SectionCard>
  );
}

function RuleRow({
  rule,
  nodeName,
  manage,
  onChanged,
}: {
  rule: TrafficRule;
  nodeName: string;
  manage: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const desc =
    rule.compare === 'quota'
      ? `${rule.scope === 'day' ? '当日' : '本月'}流量达到配额的 ${rule.threshold}%`
      : `${rule.scope === 'day' ? '当日' : '本月'}流量超过 ${bytes(rule.threshold, 0)}`;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '11px 16px',
        borderBottom: '1px solid var(--ds-border)',
        flexWrap: 'wrap',
        opacity: rule.enabled ? 1 : 0.55,
      }}
    >
      <Chip color={rule.enabled ? 'var(--color-ok)' : undefined}>
        {rule.enabled ? '生效中' : '已停用'}
      </Chip>
      <span className="ds-text-body-sm" style={{ fontWeight: 500, minWidth: 128 }}>
        {nodeName}
      </span>
      <span className="ds-text-body-sm text-ds-secondary" style={{ flex: 1, minWidth: 180 }}>
        {desc}
        {rule.note && <span className="text-ds-description"> · {rule.note}</span>}
      </span>
      <span className="ds-text-caption text-ds-description tnum">
        {rule.fireCount > 0 ? `已提醒 ${rule.fireCount} 次 · ${ago(rule.lastFired)}` : '尚未触发'}
      </span>
      {manage && (
        <>
          <button
            className="ds-btn ds-btn-ghost ds-btn-s"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.toggleTrafficRule(rule.id, !rule.enabled).finally(() => setBusy(false));
              onChanged();
            }}
          >
            {rule.enabled ? <IconX size={11} /> : <IconCheck size={11} />}
            {rule.enabled ? '停用' : '启用'}
          </button>
          <button
            className="ds-btn ds-btn-ghost ds-btn-s"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.deleteTrafficRule(rule.id).finally(() => setBusy(false));
              onChanged();
            }}
          >
            <IconTrash size={11} />
            删除
          </button>
        </>
      )}
    </div>
  );
}

function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  if (rows.length === 0) return <EmptyState title="暂无流量数据" />;

  const totalMonth = rows.reduce((a, r) => a + r.monthUsed, 0);

  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 22,
          padding: '14px 16px',
          borderBottom: '1px solid var(--ds-border)',
          flexWrap: 'wrap',
        }}
      >
        <Stat label="本月合计" value={bytes(totalMonth)} />
        <Stat label="今日合计" value={bytes(rows.reduce((a, r) => a + r.todayUsed, 0))} />
        {/* 门槛跟设置里的「配额提醒」走，和概览页、卡片进度条共用同一个数 */}
        <Stat
          label="接近配额"
          value={String(rows.filter((r) => isNearQuota(r.quotaPercent ?? 0)).length)}
          unit="台"
          color={
            rows.some((r) => isNearQuota(r.quotaPercent ?? 0)) ? 'var(--color-warn)' : undefined
          }
        />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead>
            <tr className="ds-text-caption text-ds-description">
              {['机器', '今日', '本月', '配额占比', '日均', '峰值日', '30 天合计'].map((h, i) => (
                <th
                  key={h}
                  style={{
                    textAlign: i === 0 ? 'left' : 'right',
                    fontWeight: 400,
                    padding: '9px 12px',
                    borderBottom: '1px solid var(--ds-border)',
                    background: 'var(--ds-bg-sunken)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = r.quotaPercent;
              // 不限量的机器不该被涂成"安全"的颜色 —— 它压根没有配额可比
              const tone =
                pct == null
                  ? 'var(--ds-text-description)'
                  : quotaTone(pct, 'var(--ds-text-secondary)');
              return (
                <tr key={r.nodeId} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <td className="ds-text-body-sm" style={{ padding: '9px 12px' }}>
                    <CountryBadge code={r.countryCode} /> {r.nodeName}
                    <span className="ds-text-caption text-ds-description"> · {r.provider}</span>
                  </td>
                  <td className="ds-text-body-sm tnum text-ds-secondary" style={{ padding: '9px 12px', textAlign: 'right' }}>
                    {bytes(r.todayUsed)}
                  </td>
                  <td className="ds-text-body-sm tnum" style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 600 }}>
                    {bytes(r.monthUsed)}
                  </td>
                  <td className="ds-text-body-sm tnum" style={{ padding: '9px 12px', textAlign: 'right', color: tone }}>
                    {pct == null ? '不限量' : percent(pct, 0)}
                  </td>
                  <td className="ds-text-body-sm tnum text-ds-secondary" style={{ padding: '9px 12px', textAlign: 'right' }}>
                    {bytes(r.dailyAvg)}
                  </td>
                  <td className="ds-text-caption tnum text-ds-description" style={{ padding: '9px 12px', textAlign: 'right' }}>
                    {r.peakDay.day ? `${r.peakDay.day.slice(5)} · ${bytes(r.peakDay.total)}` : '—'}
                  </td>
                  <td className="ds-text-body-sm tnum text-ds-secondary" style={{ padding: '9px 12px', textAlign: 'right' }}>
                    {bytes(r.periodTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
