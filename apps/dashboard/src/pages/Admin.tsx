import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';

import { api, ApiError, type AdminUser, type LedgerRow, type TrafficRule } from '../lib/api';
import { AdminSettings } from './AdminSettings';
import { AdminRoles } from './AdminRoles';
import { useAsync, useLive } from '../lib/live';
import { useAuth } from '../lib/auth';
import { type Capability, type Role, type RoleInfo } from '../lib/permissions';
import { ago, bytes, clockTime, count, isNearQuota, percent, quotaTone } from '../lib/format';
import { CountryBadge } from '../components/CountryBadge';
import { Modal } from '../components/Modal';
import { Tooltip } from '../components/Tooltip';
import { Alert, Chip, EmptyState, Field, LinkTabs, PageHeader, RawCheckbox, SectionCard, Segmented, Select, Skeleton, Stat } from '../components/ui';
import { ADMIN_SECTIONS } from '../components/nav';
import {
  IconAlert,
  IconChevronRight,
  IconCheck,
  IconCopy,
  IconGlobe,
  IconInfo,
  IconShield,
  IconTrash,
  IconX,
} from '../components/icons';
import { TextInput } from '../components/Input';

export function Admin() {
  const { can } = useAuth();
  const { tab } = useParams<{ tab?: string }>();

  // 分区和命令面板共用 nav.tsx 里那一份定义，这里只按权限筛
  const visible = ADMIN_SECTIONS.filter((s) => can(s.cap));

  if (visible.length === 0) {
    return (
      <div className="ds-surface">
        <EmptyState
          icon={<IconShield size={22} />}
          title="你没有管理权限"
          hint="需要管理员给你开通「查看用户列表」或「查看访问审计」才能进入这里。"
        />
      </div>
    );
  }

  // /admin 本身不是一页；落在一个看不到的分区上（比如权限刚被收走）也退回第一个能看的
  const section = visible.find((s) => s.tab === tab);
  if (!section) return <Navigate to={`/admin/${visible[0]!.tab}`} replace />;

  return (
    <>
      <PageHeader
        breadcrumb={
          <nav className="ds-breadcrumb" aria-label="当前位置">
            <Link to="/">机器概览</Link>
            <IconChevronRight size={12} />
            <span aria-current="page">管理后台</span>
          </nav>
        }
        title="管理后台"
        description="账号与权限、在线与审计、流量阈值，以及全站的计算口径。"
      />

      <div style={{ marginBottom: 24 }}>
        <LinkTabs
          value={section.tab}
          ariaLabel="管理分区"
          options={visible.map((s) => ({ value: s.tab, label: s.label, to: `/admin/${s.tab}` }))}
        />
        <p className="ds-text-body-sm text-ds-description" style={{ margin: '14px 0 0' }}>
          {section.description}
        </p>
      </div>

      {section.tab === 'users' && <UsersTab />}
      {section.tab === 'roles' && <AdminRoles />}
      {section.tab === 'online' && <OnlineTab />}
      {section.tab === 'audit' && <AuditTab />}
      {section.tab === 'traffic' && <TrafficTab />}
      {section.tab === 'settings' && <AdminSettings />}
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

  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);

  const editable = can('user:manage');
  const canCreate = can('user:create');

  async function patch(id: string, body: Parameters<typeof api.updateUser>[1]) {
    setError(null);
    try {
      await api.updateUser(id, body);
      users.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败');
    }
  }

  async function remove(user: AdminUser) {
    setError(null);
    try {
      await api.deleteUser(user.id);
      setConfirmDelete(null);
      users.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  }

  if (users.loading && !users.data) return <Skeleton height={260} />;

  const list = users.data ?? [];
  const admins = list.filter((u) => u.role === 'admin' && !u.disabled).length;
  const roles = catalog.data?.roles ?? [];

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
        actions={
          canCreate ? (
            <button className="ds-btn ds-btn-primary ds-btn-s" onClick={() => setCreating(true)}>
              新建账号
            </button>
          ) : !editable ? (
            <Chip>只读</Chip>
          ) : undefined
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
            <thead>
              <tr className="ds-text-caption text-ds-description">
                {['用户', '登录方式', '角色', '能力数', '最近活跃', ''].map((h, i) => (
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
                  canCreate={canCreate}
                  expanded={editing === u.id}
                  onToggle={() => setEditing(editing === u.id ? null : u.id)}
                  onPatch={(body) => void patch(u.id, body)}
                  onKick={async () => {
                    await api.kickUser(u.id);
                    users.reload();
                  }}
                  onResetPassword={() => setResetFor(u)}
                  onDelete={() => setConfirmDelete(u)}
                  roles={roles}
                  catalog={catalog.data}
                />
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {creating && (
        <CreateUserDialog
          roles={roles}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            users.reload();
          }}
        />
      )}

      {resetFor && (
        <ResetPasswordDialog
          user={resetFor}
          onClose={() => setResetFor(null)}
          onDone={() => users.reload()}
        />
      )}

      {confirmDelete && (
        <Modal
          title="删除账号"
          subtitle={`${confirmDelete.username || confirmDelete.login}（${confirmDelete.name}）`}
          onClose={() => setConfirmDelete(null)}
          width={420}
          icon={<IconTrash size={16} />}
          footer={
            <>
              <span style={{ flex: 1 }} />
              <button className="ds-btn ds-btn-ghost" onClick={() => setConfirmDelete(null)}>
                取消
              </button>
              <button
                className="ds-btn ds-btn-danger"
                onClick={() => void remove(confirmDelete)}
              >
                删除
              </button>
            </>
          }
        >
          <Alert tone="danger" title="这一步不可撤销">
            账号和它的全部登录方式会被删除，正在使用的会话立刻失效。
            <br />
            <br />
            <b>审计日志会保留</b> —— 这个人做过什么仍然查得到，否则删号就成了洗白操作记录的手段。
          </Alert>
        </Modal>
      )}
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
  canCreate,
  expanded,
  onToggle,
  onPatch,
  onKick,
  onResetPassword,
  onDelete,
  roles,
  catalog,
}: {
  user: AdminUser;
  isSelf: boolean;
  editable: boolean;
  canCreate: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (body: Parameters<typeof api.updateUser>[1]) => void;
  onKick: () => Promise<void>;
  onResetPassword: () => void;
  onDelete: () => void;
  roles: RoleInfo[];
  catalog: Awaited<ReturnType<typeof api.adminCapabilities>> | null;
}) {
  const caps = new Set(user.capabilities);
  const roleDefaults = new Set(
    catalog?.roles.find((r) => r.value === user.role)?.capabilities ?? [],
  );

  /*
   * 超级管理员的角色、停用、删除三个入口一律不渲染。
   *
   * 服务端也拦（auth.ts 的 updateUser / deleteUser），这里不渲染是为了别让人
   * 白点一次再吃一个 409 —— 那种"看得见但用不了"正是这个项目一直避免的东西。
   */
  const protectedUser = user.isRoot;
  const canEditRole = editable && !isSelf && !protectedUser;
  const isGuest = user.kind === 'guest';

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
                {user.isRoot && (
                  <Tooltip content="超级管理员：不可降权、停用或删除">
                    <span style={{ marginLeft: 5, color: 'var(--color-warn)' }}>
                      <IconShield size={11} />
                    </span>
                  </Tooltip>
                )}
              </span>
              <span className="ds-text-caption text-ds-description">
                {user.username || user.login}
                {user.mustChangePassword && (
                  <span style={{ color: 'var(--color-warn)' }}> · 待改密</span>
                )}
              </span>
            </span>
          </span>
        </td>
        <td style={{ padding: '10px 12px' }}>
          {/*
            列出实际绑定的登录方式，而不是一个二选一的"来源"。
            同一个人可以既有密码又绑着 GitHub —— 旧的单值字段表达不了这件事，
            而"他到底能怎么进来"正是管理员在这张表上最想知道的。
          */}
          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {isGuest ? (
              <Chip>访客</Chip>
            ) : user.identities.length === 0 ? (
              <Tooltip content="没有任何登录方式，这个账号进不来">
                <Chip color="var(--color-danger)">无</Chip>
              </Tooltip>
            ) : (
              user.identities.map((i) => (
                <Tooltip key={i.provider} content={i.label}>
                  <Chip color={i.provider === 'github' ? 'var(--color-brand)' : undefined}>
                    {i.provider === 'github' ? 'GitHub' : '密码'}
                  </Chip>
                </Tooltip>
              ))
            )}
          </span>
        </td>
        <td style={{ padding: '10px 12px' }}>
          {canEditRole ? (
            <Select
              value={user.role}
              onChange={(v) => onPatch({ role: v as Role })}
              width={120}
              ariaLabel="角色"
              options={roles
                .filter((r) => r.assignable)
                .map((r) => ({ value: r.value, label: r.label }))}
            />
          ) : (
            <Chip color={user.role === 'admin' ? 'var(--color-danger)' : undefined}>
              {user.roleLabel}
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
              <Tooltip content="强制下线，需要重新登录">
                <button
                  className="ds-btn ds-btn-ghost ds-btn-s"
                  style={{ marginLeft: 5 }}
                  onClick={() => void onKick()}
                >
                  踢下线
                </button>
              </Tooltip>
              {/* 访客没有密码可重置 */}
              {!isGuest && (
                <Tooltip content="生成一个新密码，对方下次登录必须修改">
                  <button
                    className="ds-btn ds-btn-ghost ds-btn-s"
                    style={{ marginLeft: 5 }}
                    onClick={onResetPassword}
                  >
                    重置密码
                  </button>
                </Tooltip>
              )}
              {!protectedUser && (
                <button
                  className="ds-btn ds-btn-ghost ds-btn-s"
                  style={{ marginLeft: 5, color: user.disabled ? 'var(--color-ok)' : 'var(--color-danger)' }}
                  onClick={() => onPatch({ disabled: !user.disabled })}
                >
                  {user.disabled ? '启用' : '停用'}
                </button>
              )}
            </>
          )}
          {canCreate && !isSelf && !protectedUser && (
            <Tooltip content="删除账号">
              <button
                className="ds-btn ds-btn-ghost ds-btn-s"
                style={{ marginLeft: 5, color: 'var(--color-danger)' }}
                onClick={onDelete}
                aria-label="删除账号"
              >
                <IconTrash size={12} />
              </button>
            </Tooltip>
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

/**
 * 新建账号。
 *
 * 密码由管理员设定，但对方首次登录必须换掉 —— 这条是服务端强制的（mustChangePassword），
 * 理由很直接：这个密码经过了第二个人的手，在对方改掉之前，账号有两个人能进。
 */
function CreateUserDialog({
  roles,
  onClose,
  onCreated,
}: {
  roles: RoleInfo[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [pw, setPw] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const assignable = roles.filter((r) => r.assignable);
  const usernameError =
    username && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/.test(username)
      ? '2-32 位，字母或数字开头，只能含字母、数字、点、下划线、连字符'
      : '';

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.createUser({
        username: username.trim(),
        password: pw,
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        role,
        note: note.trim() || undefined,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="新建账号"
      subtitle="创建一个用户名密码账号，对方也可以之后自行绑定 GitHub"
      onClose={onClose}
      width={560}
      icon={<IconShield size={16} />}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="ds-btn ds-btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="ds-btn ds-btn-primary"
            onClick={() => void submit()}
            disabled={busy || !username || !pw || !!usernameError}
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <Alert tone="danger" title="创建失败">{error}</Alert>}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="用户名" grow error={usernameError} hint="登录用，创建后不可更改">
            <TextInput
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="zhangsan"
              autoFocus
            />
          </Field>
          <Field label="显示名称" grow hint="留空则用用户名">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="张三"
            />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="初始密码" grow hint="至少 10 位、两类以上字符，且不能包含用户名">
            <TextInput
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="对方首次登录后必须修改"
            />
          </Field>
          <Field label="角色" hint="决定他能做什么">
            <Select
              value={role}
              onChange={setRole}
              width={160}
              ariaLabel="角色"
              options={assignable.map((r) => ({ value: r.value, label: r.label }))}
            />
          </Field>
        </div>

        <Field label="邮箱" hint="仅用于展示，不会发信">
          <TextInput value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>

        <Field label="备注" hint="给管理员自己看的，比如「外包，10 月底到期」">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {role && (
          <Alert tone="info" title={`${assignable.find((r) => r.value === role)?.label ?? role} 能做什么`}>
            {assignable.find((r) => r.value === role)?.description || '这个角色还没有写说明。'}
            {' '}共 {assignable.find((r) => r.value === role)?.capabilities.length ?? 0} 项能力。
          </Alert>
        )}
      </div>
    </Modal>
  );
}

/**
 * 重置密码。
 *
 * 新密码只在这一次响应里回显，服务端不留明文、也不写进日志。
 * 关掉这个框之后没有任何地方能再看到它 —— 所以复制按钮必须显眼。
 */
function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [custom, setCustom] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.resetUserPassword(user.id, custom.trim() || undefined);
      setResult(res.password);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '重置失败');
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    void navigator.clipboard.writeText(result).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <Modal
      title="重置密码"
      subtitle={`${user.username || user.login}（${user.name}）`}
      onClose={onClose}
      width={480}
      icon={<IconShield size={16} />}
      footer={
        result ? (
          <>
            <span style={{ flex: 1 }} />
            <button className="ds-btn ds-btn-primary" onClick={onClose}>
              我已记下
            </button>
          </>
        ) : (
          <>
            <span style={{ flex: 1 }} />
            <button className="ds-btn ds-btn-ghost" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="ds-btn ds-btn-danger" onClick={() => void submit()} disabled={busy}>
              {busy ? '重置中…' : '重置'}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Alert tone="success" title="新密码已生效">
            对方所有登录状态已失效，下次登录必须修改这个密码。
          </Alert>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span className="ds-text-caption text-ds-description" style={{ flex: 1 }}>
                新密码
              </span>
              <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={copy}>
                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <pre className="ds-enroll-cmd" style={{ margin: 0 }}>{result}</pre>
          </div>
          <Alert tone="warn" title="这是唯一一次显示">
            关掉之后再也看不到 —— 服务端只存哈希，不留明文。现在就把它交给本人。
          </Alert>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && <Alert tone="danger" title="重置失败">{error}</Alert>}
          <Alert tone="warn" title="重置会立刻踢掉对方所有登录">
            如果只是对方忘了密码，这是正常流程；如果怀疑账号被盗，重置之后记得同时检查审计日志。
          </Alert>
          <Field label="指定新密码" hint="留空则由系统生成一个 20 位随机密码（推荐）">
            <TextInput
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="留空自动生成"
            />
          </Field>
        </div>
      )}
    </Modal>
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
                    {o.user.roleLabel}
                  </span>
                </span>
                <Chip color={o.user.kind === 'guest' ? undefined : 'var(--color-brand)'}>
                  {o.user.kind === 'guest' ? '访客' : '账号'}
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
            <TextInput
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
          <TextInput
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
