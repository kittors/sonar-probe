import { useMemo, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/live';
import { useAuth } from '../lib/auth';
import { type Capability, type RoleInfo } from '../lib/permissions';
import { Modal } from '../components/Modal';
import { Alert, Chip, Field, RawCheckbox, SectionCard, Skeleton } from '../components/ui';
import { IconShield, IconTrash } from '../components/icons';

/**
 * 角色管理
 *
 * 角色以前是代码里的一个常量表，加一个要改代码、构建、部署。但"给这批人一个
 * 只能看流量、看不到对端 IP 的身份"是运行期才冒出来的需求。
 *
 * 界面上有三件事必须说清楚，否则改角色是个盲操作：
 *
 *   1. **这个角色下面挂了多少人。** 改能力集是一次改一批人，而那些人此刻正开着页面。
 *   2. **哪些角色动不了。** admin 的能力集锁死，系统角色不能删 —— 与其点了再报错，
 *      不如一开始就不给入口，并说明为什么。
 *   3. **改动会立刻生效。** 服务端会把新权限推给在线的人，不需要谁重新登录。
 */

const RISK_COLOR: Record<string, string> = {
  low: 'var(--ds-text-description)',
  medium: 'var(--color-warn)',
  high: 'var(--color-danger)',
};

export function AdminRoles() {
  const { can } = useAuth();
  const catalog = useAsync(() => api.adminCapabilities(), []);
  const [editing, setEditing] = useState<RoleInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<RoleInfo | null>(null);
  const [error, setError] = useState('');

  const editable = can('role:manage');

  async function remove(role: RoleInfo) {
    setError('');
    try {
      await api.deleteRole(role.value);
      setConfirmDelete(null);
      catalog.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除失败');
    }
  }

  if (catalog.loading && !catalog.data) return <Skeleton height={260} />;

  const roles = catalog.data?.roles ?? [];
  const custom = roles.filter((r) => !r.system).length;

  return (
    <>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="danger" title="操作失败">{error}</Alert>
        </div>
      )}

      <SectionCard
        title="角色"
        subtitle={`${roles.length} 个角色 · ${custom} 个自定义 · 改动会立刻推给在线的人，不用重新登录`}
        padded={false}
        actions={
          editable ? (
            <button className="ds-btn ds-btn-primary ds-btn-s" onClick={() => setCreating(true)}>
              新建角色
            </button>
          ) : (
            <Chip>只读</Chip>
          )
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr className="ds-text-caption text-ds-description">
                {['角色', '标识', '能力数', '用户数', ''].map((h, i) => (
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
              {roles.map((r) => (
                <tr key={r.value} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <span
                      className="ds-text-body-sm"
                      style={{ display: 'block', fontWeight: 500, color: 'var(--ds-text-primary)' }}
                    >
                      {r.label}
                      {r.locked && (
                        <span style={{ marginLeft: 5, color: 'var(--color-warn)' }}>
                          <IconShield size={11} />
                        </span>
                      )}
                    </span>
                    <span className="ds-text-caption text-ds-description">
                      {r.description || '—'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <code className="ds-text-caption">{r.value}</code>
                    {r.system && (
                      <span style={{ marginLeft: 6 }}>
                        <Chip>内置</Chip>
                      </span>
                    )}
                  </td>
                  <td className="ds-text-body-sm tnum text-ds-secondary" style={{ padding: '10px 12px' }}>
                    {r.capabilities.length}
                  </td>
                  <td className="ds-text-body-sm tnum text-ds-secondary" style={{ padding: '10px 12px' }}>
                    {/*
                      anonymous 不挂在任何账号上，显示 0 会让人以为"没人用，可以删"。
                      它管的是未登录访客看到什么，恰恰是影响面最大的一个。
                    */}
                    {r.assignable ? r.userCount : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      className="ds-btn ds-btn-ghost ds-btn-s"
                      onClick={() => setEditing(r)}
                    >
                      {editable && !r.locked ? '编辑' : '查看'}
                    </button>
                    {editable && !r.system && (
                      <button
                        className="ds-btn ds-btn-ghost ds-btn-s"
                        style={{ marginLeft: 5, color: 'var(--color-danger)' }}
                        onClick={() => setConfirmDelete(r)}
                        title={r.userCount > 0 ? '还有用户挂在这个角色下' : '删除角色'}
                      >
                        <IconTrash size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {(editing || creating) && (
        <RoleEditor
          role={editing}
          groups={catalog.data?.groups ?? []}
          editable={editable}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            catalog.reload();
          }}
        />
      )}

      {confirmDelete && (
        <Modal
          title="删除角色"
          subtitle={confirmDelete.label}
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
                disabled={confirmDelete.userCount > 0}
              >
                删除
              </button>
            </>
          }
        >
          {confirmDelete.userCount > 0 ? (
            <Alert tone="warn" title={`还有 ${confirmDelete.userCount} 个用户是这个角色`}>
              先把他们改成别的角色再删。
              <br />
              <br />
              不自动把他们降级到「观察者」是有意的 —— 那会让一批人的权限在没有任何人
              操作他们账号的情况下发生变化，事后从审计日志里也看不出所以然。
            </Alert>
          ) : (
            <Alert tone="danger" title="这一步不可撤销">
              没有用户挂在这个角色下，删除是安全的。
            </Alert>
          )}
        </Modal>
      )}
    </>
  );
}

/** 角色标识会出现在接口和审计日志里，收得严一点，省得日后要处理歧义。 */
const ID_RE = /^[a-z][a-z0-9_-]{1,30}$/;

function RoleEditor({
  role,
  groups,
  editable,
  onClose,
  onSaved,
}: {
  role: RoleInfo | null;
  groups: Array<{ group: string; items: Array<{ key: Capability; label: string; risk: string }> }>;
  editable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !role;
  const [id, setId] = useState('');
  const [name, setName] = useState(role?.label ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [caps, setCaps] = useState<Set<string>>(new Set(role?.capabilities ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // locked 的角色（admin）能力集由代码决定，界面上只读
  const capsEditable = editable && !role?.locked;
  const idError = id && !ID_RE.test(id) ? '小写字母开头，2-31 位，只能含小写字母、数字、下划线、连字符' : '';

  const highRiskOn = useMemo(
    () =>
      groups
        .flatMap((g) => g.items)
        .filter((i) => i.risk === 'high' && caps.has(i.key)).length,
    [groups, caps],
  );

  function toggle(cap: string, on: boolean) {
    if (!capsEditable) return;
    const next = new Set(caps);
    if (on) next.add(cap);
    else next.delete(cap);
    setCaps(next);
  }

  function toggleGroup(items: Array<{ key: Capability }>, on: boolean) {
    if (!capsEditable) return;
    const next = new Set(caps);
    for (const i of items) {
      if (on) next.add(i.key);
      else next.delete(i.key);
    }
    setCaps(next);
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (isNew) {
        await api.createRole({
          id: id.trim().toLowerCase(),
          name: name.trim(),
          description: description.trim(),
          capabilities: [...caps],
        });
      } else {
        await api.updateRole(role.value, {
          name: name.trim(),
          description: description.trim(),
          // locked 的角色不提交能力集，服务端也会忽略，两边都不改才不会有歧义
          capabilities: capsEditable ? [...caps] : undefined,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isNew ? '新建角色' : editable && !role?.locked ? `编辑「${role?.label}」` : `查看「${role?.label}」`}
      subtitle={
        role?.locked
          ? '管理员的能力集由系统维护，恒等于全部能力'
          : role && role.assignable
            ? `${role.userCount} 个用户挂在这个角色下，保存后立刻对他们生效`
            : role
              ? '这是未登录访客的可见范围，保存后立刻对所有公开访问生效'
              : undefined
      }
      onClose={onClose}
      width={760}
      icon={<IconShield size={16} />}
      footer={
        <>
          <span className="ds-text-caption text-ds-description" style={{ flex: 1 }}>
            已选 {caps.size} 项
            {highRiskOn > 0 && (
              <span style={{ color: 'var(--color-danger)' }}> · 含 {highRiskOn} 项高危</span>
            )}
          </span>
          <button className="ds-btn ds-btn-ghost" onClick={onClose} disabled={busy}>
            {editable ? '取消' : '关闭'}
          </button>
          {editable && (
            <button
              className="ds-btn ds-btn-primary"
              onClick={() => void save()}
              disabled={busy || !name.trim() || (isNew && (!id.trim() || !!idError))}
            >
              {busy ? '保存中…' : '保存'}
            </button>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <Alert tone="danger" title="保存失败">{error}</Alert>}

        {role?.locked && (
          <Alert tone="info" title="这个角色的能力集不可编辑">
            管理员恒等于代码里定义的每一个能力点。允许编辑的话，把 <code>user:manage</code>{' '}
            摘掉之后就没有任何人能再把它加回来；而新版本新增的能力点，管理员反而会是唯一没有的人。
          </Alert>
        )}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {isNew && (
            <Field label="标识" grow error={idError} hint="创建后不可更改，出现在接口和审计里">
              <input
                className="ds-input"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="auditor"
                autoFocus
              />
            </Field>
          )}
          <Field label="名称" grow>
            <input
              className="ds-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="审计员"
              disabled={!editable}
              autoFocus={!isNew}
            />
          </Field>
          <Field label="说明" grow hint="指派角色时会显示给操作者看">
            <input
              className="ds-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="只能看审计日志，不能改任何东西"
              disabled={!editable}
            />
          </Field>
        </div>

        <div>
          <div
            className="ds-text-caption"
            style={{ fontWeight: 600, color: 'var(--ds-text-secondary)', marginBottom: 9 }}
          >
            能力
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
              gap: 16,
            }}
          >
            {groups.map((g) => {
              const all = g.items.every((i) => caps.has(i.key));
              return (
                <div key={g.group}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 7,
                    }}
                  >
                    <span
                      className="ds-text-caption"
                      style={{ fontWeight: 600, color: 'var(--ds-text-secondary)', flex: 1 }}
                    >
                      {g.group}
                    </span>
                    {capsEditable && (
                      <button
                        className="ds-btn ds-btn-ghost ds-btn-s"
                        style={{ padding: '2px 6px', fontSize: 11 }}
                        onClick={() => toggleGroup(g.items, !all)}
                      >
                        {all ? '全不选' : '全选'}
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {g.items.map((item) => {
                      const on = caps.has(item.key);
                      return (
                        <label
                          key={item.key}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 7,
                            cursor: capsEditable ? 'pointer' : 'default',
                          }}
                        >
                          <RawCheckbox
                            checked={on}
                            disabled={!capsEditable}
                            onChange={(v) => toggle(item.key, v)}
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
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {capsEditable && highRiskOn > 0 && (
          <Alert tone="warn" title={`这个角色含 ${highRiskOn} 项高危能力`}>
            高危能力（红点）会产生不可逆的后果：下发封禁会真的改目标机器的防火墙，
            改通用设置会影响所有人看到的数字，管用户能把别人提权。
          </Alert>
        )}
      </div>
    </Modal>
  );
}
