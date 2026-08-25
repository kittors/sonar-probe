import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../lib/api';
import { useAsync, useLive } from '../lib/live';
import { useAuth } from '../lib/auth';
import { ago } from '../lib/format';
import type { SshDrift, SshEndpoint, SshGrant, SshKey } from '../lib/types';
import { Modal } from '../components/Modal';
import { Tooltip } from '../components/Tooltip';
import {
  Alert,
  Chip,
  EmptyState,
  Field,
  SectionCard,
  Segmented,
  Select,
  Skeleton,
} from '../components/ui';
import {
  IconAlert,
  IconCheck,
  IconChevronLeft,
  IconCopy,
  IconGlobe,
  IconShield,
  IconTrash,
} from '../components/icons';

/**
 * SSH 接入
 *
 * 面板做的是**凭据分发**和**连接目录**，不做会话代理 —— 不存私钥、不建隧道、
 * 没有 Web 终端。你的 ssh 连接直连目标机器，一个字节都不经过面板。
 *
 * 这也是和哪吒那类探针最根本的差别：它们的 WebSSH 是 agent 反向隧道 + 执行
 * 面板下发的命令，等于在每台机器上开了个受控后门，安全社区的共识是要关掉它。
 * Sonar 选择不提供那个能力，代价是不能在浏览器里敲命令，换来的是面板被攻破
 * 也拿不到任何一台机器。
 */

type Tab = 'access' | 'keys' | 'grants' | 'drift';

export function SshAccess() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('access');

  if (!can('ssh:view') && !can('ssh:keys')) {
    return (
      <div className="ds-surface">
        <EmptyState
          icon={<IconShield size={30} />}
          title="你没有 SSH 管理权限"
          hint="需要管理员给你开通「查看 SSH 接入方式」或「管理自己的公钥」。"
        />
      </div>
    );
  }

  const tabs: Array<{ value: Tab; label: string; show: boolean }> = [
    { value: 'access', label: '怎么连', show: can('ssh:view') },
    { value: 'keys', label: '我的钥匙', show: can('ssh:keys') },
    { value: 'grants', label: '授权', show: can('ssh:view') },
    // 对账是这套东西最有价值的一格，但它暴露全机队的密钥分布，权限最高
    { value: 'drift', label: '密钥实况', show: can('ssh:audit') },
  ];
  const visible = tabs.filter((t) => t.show);
  const active = visible.some((t) => t.value === tab) ? tab : (visible[0]?.value ?? 'keys');

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
          SSH 接入
        </h1>
        <p className="ds-text-body text-ds-description" style={{ margin: '6px 0 0' }}>
          面板只分发公钥、只维护连接目录。私钥不经过这里，ssh 连接也不经过这里。
        </p>
      </header>

      <div style={{ marginBottom: 16 }}>
        <Segmented
          value={active}
          onChange={(v) => setTab(v)}
          options={visible.map((t) => ({ value: t.value, label: t.label }))}
        />
      </div>

      {active === 'access' && <AccessTab />}
      {active === 'keys' && <KeysTab />}
      {active === 'grants' && <GrantsTab />}
      {active === 'drift' && <DriftTab />}
    </>
  );
}

// ————————————————————————————————————————————————————————
// 怎么连
// ————————————————————————————————————————————————————————

function AccessTab() {
  const { can } = useAuth();
  const endpoints = useAsync(() => api.sshEndpoints(), []);
  const [editing, setEditing] = useState<SshEndpoint | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  if (endpoints.loading && !endpoints.data) return <Skeleton height={240} />;

  const list = endpoints.data ?? [];
  const withHostKeys = list.filter((e) => e.hostKeys.length > 0).length;

  return (
    <>
      <SectionCard
        title="机器与别名"
        subtitle={
          list.length === 0
            ? '还没有机器'
            : `${list.length} 台 · ${withHostKeys} 台已采到 host key，首次连接不用盲信任`
        }
        padded={false}
        actions={
          <button className="ds-btn ds-btn-primary ds-btn-s" onClick={() => setShowConfig(true)}>
            生成本地配置
          </button>
        }
      >
        {list.length === 0 ? (
          <div style={{ padding: 20 }}>
            <EmptyState title="还没有接入任何机器" hint="先在概览页接入机器，这里会自动出现它的 SSH 别名。" />
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
              <thead>
                <tr className="ds-text-caption text-ds-description">
                  {['别名', '地址', '账号', 'sshd', '实况', ''].map((h, i) => (
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
                {list.map((e) => (
                  <tr key={e.nodeId} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                    <td style={{ padding: '10px 12px' }}>
                      <code className="ds-text-body-sm" style={{ fontWeight: 600 }}>
                        ssh {e.alias}
                      </code>
                      <div className="ds-text-caption text-ds-description">{e.nodeName}</div>
                    </td>
                    <td className="ds-text-body-sm tnum" style={{ padding: '10px 12px' }}>
                      {e.effectiveHostname || <span style={{ color: 'var(--color-danger)' }}>未知</span>}
                      {e.port !== 22 && <span className="text-ds-description">:{e.port}</span>}
                      {e.proxyJump && (
                        <div className="ds-text-caption text-ds-description">经 {e.proxyJump}</div>
                      )}
                    </td>
                    <td className="ds-text-body-sm" style={{ padding: '10px 12px' }}>
                      {e.defaultUser}
                    </td>
                    <td className="ds-text-caption text-ds-description" style={{ padding: '10px 12px' }}>
                      {e.sshdVersion || '—'}
                      {e.passwordAuth === true && (
                        <Tooltip content="这台机器允许密码登录">
                          <span style={{ color: 'var(--color-warn)', marginLeft: 4 }}>密码</span>
                        </Tooltip>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <FactsChip endpoint={e} />
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      {can('ssh:endpoint') && (
                        <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={() => setEditing(e)}>
                          编辑
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {editing && (
        <EndpointDialog
          endpoint={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            endpoints.reload();
          }}
        />
      )}
      {showConfig && <ConfigDialog onClose={() => setShowConfig(false)} />}
    </>
  );
}

/**
 * 实况新鲜度。
 *
 * 过期的实况比没有实况更危险 —— 人会拿一份三天前的快照去判断"删这把钥匙安不安全"。
 * 所以过期和从未采集要显示成两种不同的状态，而不是都显示成一个灰点。
 */
function FactsChip({ endpoint }: { endpoint: SshEndpoint }) {
  if (endpoint.observedAt === 0) {
    return (
      <Tooltip content="agent 还没上报过 SSH 实况。可能是 agent 版本较旧，或这台机器不是 Linux">
        <Chip>未采集</Chip>
      </Tooltip>
    );
  }
  if (endpoint.factsStale) {
    return (
      <Tooltip content="实况已过期，此时不能作为删除决策的依据">
        <Chip color="var(--color-warn)">{ago(endpoint.observedAt)}</Chip>
      </Tooltip>
    );
  }
  return <Chip color="var(--color-ok)">{ago(endpoint.observedAt)}</Chip>;
}

function EndpointDialog({
  endpoint,
  onClose,
  onSaved,
}: {
  endpoint: SshEndpoint;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [alias, setAlias] = useState(endpoint.alias);
  const [hostname, setHostname] = useState(endpoint.hostname);
  const [port, setPort] = useState(String(endpoint.port));
  const [defaultUser, setDefaultUser] = useState(endpoint.defaultUser);
  const [proxyJump, setProxyJump] = useState(endpoint.proxyJump);
  const [identityFile, setIdentityFile] = useState(endpoint.identityFile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.updateSshEndpoint(endpoint.nodeId, {
        alias: alias.trim(),
        hostname: hostname.trim(),
        port: Number(port),
        defaultUser: defaultUser.trim(),
        proxyJump: proxyJump.trim(),
        identityFile: identityFile.trim(),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`编辑「${endpoint.nodeName}」的连接方式`}
      subtitle="这些只影响生成的本地配置，不会改动目标机器上的任何东西"
      onClose={onClose}
      width={560}
      icon={<IconGlobe size={16} />}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="ds-btn ds-btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="ds-btn ds-btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <Alert tone="danger" title="保存失败">{error}</Alert>}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="别名" grow hint="敲 ssh <别名> 就能连上">
            <input className="ds-input" value={alias} onChange={(e) => setAlias(e.target.value)} />
          </Field>
          <Field label="端口" hint="默认 22">
            <input
              className="ds-input"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              style={{ width: 90 }}
            />
          </Field>
        </div>

        <Field
          label="主机名或 IP"
          hint={
            endpoint.hostname
              ? '留空则回落到面板采集到的地址'
              : `留空时使用 ${endpoint.effectiveHostname || '（面板还没采到地址）'}`
          }
        >
          <input
            className="ds-input"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder={endpoint.effectiveHostname}
          />
        </Field>

        {/*
          这一段是有必要写出来的：nodes.ip 是 agent 上报的**出口** IP，
          而 ssh 需要的是**入口**地址。NAT 后的机器两者完全不同。
        */}
        <Alert tone="info" title="地址填错是这里最常见的问题">
          面板采到的是这台机器的出口 IP，而 ssh 要的是入口地址。NAT 后面的机器、
          走 Tailscale 的机器、只能经跳板进的机器，这两个地址都不一样 —— 那时就得手工填。
        </Alert>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="默认账号" grow>
            <input
              className="ds-input"
              value={defaultUser}
              onChange={(e) => setDefaultUser(e.target.value)}
            />
          </Field>
          <Field label="跳板" grow hint="user@host 或另一个 Host 别名，留空表示直连">
            <input
              className="ds-input"
              value={proxyJump}
              onChange={(e) => setProxyJump(e.target.value)}
              placeholder="bastion"
            />
          </Field>
        </div>

        <Field label="本地私钥路径" hint="写进生成的配置里，留空则由 ssh 自己挑">
          <input
            className="ds-input"
            value={identityFile}
            onChange={(e) => setIdentityFile(e.target.value)}
            placeholder="~/.ssh/id_ed25519"
          />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * 生成本地配置。
 *
 * known_hosts 那一半是这个面板相对 Termius/Tabby 真正的优势：它们装在你本机，
 * 不知道目标机器的 host key，只能让你首次连接时盲按一次 yes ——
 * 而那一下正是中间人攻击唯一的窗口。
 */
function ConfigDialog({ onClose }: { onClose: () => void }) {
  const cfg = useAsync(() => api.sshConfig(), []);
  const [copied, setCopied] = useState('');

  function copy(text: string, tag: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(tag);
      setTimeout(() => setCopied(''), 1800);
    });
  }

  return (
    <Modal
      title="本地 SSH 配置"
      subtitle="复制到本机之后，敲别名就能连"
      onClose={onClose}
      width={760}
      icon={<IconGlobe size={16} />}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="ds-btn ds-btn-primary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      {cfg.loading && !cfg.data ? (
        <Skeleton height={200} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(cfg.data?.missingHostKeys ?? 0) > 0 && (
            <Alert tone="warn" title={`${cfg.data?.missingHostKeys} 台机器还没采到 host key`}>
              这些机器首次连接时仍会问你「Are you sure you want to continue connecting?」——
              那一下是盲信任。等 agent 上报之后再回来生成一次，就不用按了。
            </Alert>
          )}

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
              <span className="ds-text-caption text-ds-description" style={{ flex: 1 }}>
                存为 ~/.ssh/config.d/sonar
              </span>
              <button
                className="ds-btn ds-btn-ghost ds-btn-s"
                onClick={() => copy(cfg.data?.config ?? '', 'cfg')}
              >
                {copied === 'cfg' ? <IconCheck size={12} /> : <IconCopy size={12} />}
                {copied === 'cfg' ? '已复制' : '复制'}
              </button>
            </div>
            <pre className="ds-enroll-cmd" style={{ maxHeight: 260, overflow: 'auto' }}>
              {cfg.data?.config}
            </pre>
          </div>

          {cfg.data?.knownHosts && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                <span className="ds-text-caption text-ds-description" style={{ flex: 1 }}>
                  追加到 ~/.ssh/known_hosts —— 这样首次连接不用盲按 yes
                </span>
                <button
                  className="ds-btn ds-btn-ghost ds-btn-s"
                  onClick={() => copy(cfg.data?.knownHosts ?? '', 'kh')}
                >
                  {copied === 'kh' ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  {copied === 'kh' ? '已复制' : '复制'}
                </button>
              </div>
              <pre className="ds-enroll-cmd" style={{ maxHeight: 160, overflow: 'auto' }}>
                {cfg.data.knownHosts}
              </pre>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ————————————————————————————————————————————————————————
// 我的钥匙
// ————————————————————————————————————————————————————————

function KeysTab() {
  const keys = useAsync(() => api.sshKeys(), []);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState('');

  async function importGithub() {
    setImporting(true);
    setError('');
    try {
      const res = await api.importGithubKeys();
      setImported(
        res.added > 0
          ? `导入了 ${res.added} 把`
          : `没有新增：${res.skipped.slice(0, 2).join('；') || '这些钥匙都已经登记过了'}`,
      );
      keys.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导入失败');
    } finally {
      setImporting(false);
    }
  }

  async function remove(k: SshKey) {
    setError('');
    try {
      await api.deleteSshKey(k.id);
      keys.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除失败');
    }
  }

  if (keys.loading && !keys.data) return <Skeleton height={220} />;
  const list = keys.data ?? [];

  return (
    <>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="danger" title="操作失败">{error}</Alert>
        </div>
      )}
      {imported && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="success" title="GitHub 导入完成">{imported}</Alert>
        </div>
      )}

      <SectionCard
        title="我的公钥"
        subtitle="私钥永远不要贴到这里，也不要贴到任何地方"
        padded={false}
        actions={
          <span style={{ display: 'flex', gap: 6 }}>
            <button
              className="ds-btn ds-btn-ghost ds-btn-s"
              onClick={() => void importGithub()}
              disabled={importing}
            >
              {importing ? '导入中…' : '从 GitHub 导入'}
            </button>
            <button className="ds-btn ds-btn-primary ds-btn-s" onClick={() => setAdding(true)}>
              添加公钥
            </button>
          </span>
        }
      >
        {list.length === 0 ? (
          <div style={{ padding: 20 }}>
            <EmptyState
              title="还没有登记公钥"
              hint="登记之后才能把它授权到机器上。已经绑定 GitHub 的话，可以直接一键导入。"
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {list.map((k) => (
              <div
                key={k.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--ds-border)',
                  opacity: k.disabled ? 0.5 : 1,
                }}
              >
                <IconShield size={15} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ds-text-body-sm" style={{ fontWeight: 600 }}>
                    {k.label}
                    <span className="ds-text-caption text-ds-description" style={{ marginLeft: 6 }}>
                      {k.keyType}
                      {k.bits > 0 && ` ${k.bits}`}
                    </span>
                    {k.source === 'github' && (
                      <span style={{ marginLeft: 6 }}>
                        <Chip color="var(--color-brand)">GitHub</Chip>
                      </span>
                    )}
                  </div>
                  {/* 指纹要能和本地 ssh-keygen -lf 的输出逐字对照，所以完整显示 */}
                  <code className="ds-text-caption text-ds-description">{k.fingerprint}</code>
                </div>
                <div className="ds-text-caption text-ds-description" style={{ whiteSpace: 'nowrap' }}>
                  {k.grantCount > 0 ? `开着 ${k.grantCount} 台` : '未授权'}
                </div>
                <button
                  className="ds-btn ds-btn-ghost ds-btn-s"
                  style={{ color: 'var(--color-danger)' }}
                  onClick={() => void remove(k)}
                  title={k.grantCount > 0 ? '还有生效中的授权，需要先撤销' : '删除'}
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {adding && (
        <AddKeyDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            keys.reload();
          }}
        />
      )}
    </>
  );
}

function AddKeyDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [publicKey, setPublicKey] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.addSshKey(publicKey.trim(), label.trim() || undefined);
      onAdded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '添加失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="添加公钥"
      subtitle="贴 .pub 文件里的那一行"
      onClose={onClose}
      width={620}
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
            disabled={busy || !publicKey.trim()}
          >
            {busy ? '添加中…' : '添加'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <Alert tone="danger" title="添加失败">{error}</Alert>}

        <Field label="公钥" hint="以 ssh-ed25519 或 ssh-rsa 开头的一行">
          <textarea
            className="ds-input"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            rows={4}
            style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }}
            placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... you@mac"
            autoFocus
          />
        </Field>

        <Field label="标签" hint="留空则用公钥自带的注释">
          <input
            className="ds-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="MacBook Pro"
          />
        </Field>

        <Alert tone="info" title="没有公钥？">
          在本机执行 <code>ssh-keygen -t ed25519</code> 生成，然后{' '}
          <code>cat ~/.ssh/id_ed25519.pub</code> 把输出贴过来。
          <br />
          <br />
          <b>那个不带 .pub 的文件是私钥，永远不要贴出来</b> —— 包括贴到这里。
        </Alert>
      </div>
    </Modal>
  );
}

// ————————————————————————————————————————————————————————
// 授权
// ————————————————————————————————————————————————————————

const GRANT_STATE: Record<string, { text: string; color: string; hint: string }> = {
  pending: {
    text: '待生效',
    color: 'var(--color-warn)',
    hint: '命令已生成，但还没在机器实况里看到这把钥匙。可能是命令还没被执行',
  },
  active: {
    text: '生效中',
    color: 'var(--color-ok)',
    hint: '已在机器实况里确认存在',
  },
  drifted: {
    text: '已漂移',
    color: 'var(--color-danger)',
    hint: '面板有记录，机器上却不见了 —— 有人手工删了，或者密钥已过期被 sshd 摘掉',
  },
  revoked: { text: '已撤销', color: 'var(--ds-text-description)', hint: '' },
  failed: { text: '失败', color: 'var(--color-danger)', hint: '下发失败，需要人工介入' },
};

function GrantsTab() {
  const { can } = useAuth();
  const grants = useAsync(() => api.sshGrants(), []);
  const [creating, setCreating] = useState(false);
  const [commands, setCommands] = useState<{ title: string; lines: string[] } | null>(null);
  const [error, setError] = useState('');

  async function revoke(g: SshGrant) {
    setError('');
    try {
      const res = await api.revokeSshGrant(g.id);
      grants.reload();
      if (!res.dispatched) {
        setCommands({ title: `撤销 ${g.keyLabel} 对 ${g.nodeName} 的访问`, lines: res.commands });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '撤销失败');
    }
  }

  async function showCommands(g: SshGrant) {
    const res = await api.sshGrantCommands(g.id);
    setCommands({ title: `授权 ${g.keyLabel} 访问 ${g.nodeName}`, lines: res.commands });
  }

  if (grants.loading && !grants.data) return <Skeleton height={220} />;
  const list = grants.data ?? [];
  const pendingApproval = list.filter((g) => g.requestState === 'pending_approval');

  return (
    <>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="danger" title="操作失败">{error}</Alert>
        </div>
      )}

      {pendingApproval.length > 0 && can('ssh:approve') && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="warn" title={`${pendingApproval.length} 条授权申请等待审批`}>
            审批前先确认申请人确实需要这台机器的访问权。自己发起的申请不能自己批。
          </Alert>
        </div>
      )}

      <SectionCard
        title="授权"
        subtitle="哪把钥匙开哪台机器。状态以机器实况为准，不以命令是否发出为准"
        padded={false}
        actions={
          can('ssh:grant') ? (
            <button className="ds-btn ds-btn-primary ds-btn-s" onClick={() => setCreating(true)}>
              新建授权
            </button>
          ) : undefined
        }
      >
        {list.length === 0 ? (
          <div style={{ padding: 20 }}>
            <EmptyState title="还没有授权" hint="选一把钥匙和一台机器，面板会生成一条可以直接粘贴执行的命令。" />
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
              <thead>
                <tr className="ds-text-caption text-ds-description">
                  {['机器 / 账号', '钥匙', '所有者', '状态', '有效期', ''].map((h, i) => (
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
                {list.map((g) => (
                  <GrantRow
                    key={g.id}
                    grant={g}
                    onRevoke={() => void revoke(g)}
                    onShowCommands={() => void showCommands(g)}
                    onApprove={async () => {
                      const res = await api.approveSshGrant(g.id);
                      grants.reload();
                      setCommands({ title: `授权 ${g.keyLabel} 访问 ${g.nodeName}`, lines: res.commands });
                    }}
                    onReject={async () => {
                      await api.rejectSshGrant(g.id, '');
                      grants.reload();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {creating && (
        <GrantDialog
          onClose={() => setCreating(false)}
          onCreated={(cmds, title) => {
            setCreating(false);
            grants.reload();
            if (cmds.length > 0) setCommands({ title, lines: cmds });
          }}
        />
      )}

      {commands && (
        <CommandsDialog
          title={commands.title}
          commands={commands.lines}
          onClose={() => setCommands(null)}
        />
      )}
    </>
  );
}

function GrantRow({
  grant,
  onRevoke,
  onShowCommands,
  onApprove,
  onReject,
}: {
  grant: SshGrant;
  onRevoke: () => void;
  onShowCommands: () => void;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const { can } = useAuth();
  const s = GRANT_STATE[grant.state] ?? GRANT_STATE.pending!;
  const awaiting = grant.requestState === 'pending_approval';

  return (
    <tr style={{ borderBottom: '1px solid var(--ds-border)', opacity: grant.state === 'revoked' ? 0.5 : 1 }}>
      <td style={{ padding: '10px 12px' }}>
        <div className="ds-text-body-sm" style={{ fontWeight: 500 }}>
          {grant.nodeName}
        </div>
        <span className="ds-text-caption text-ds-description">{grant.remoteUser}</span>
      </td>
      <td style={{ padding: '10px 12px' }}>
        <div className="ds-text-body-sm">{grant.keyLabel}</div>
        <code className="ds-text-caption text-ds-description">
          {grant.keyFingerprint.slice(0, 24)}…
        </code>
      </td>
      <td className="ds-text-body-sm" style={{ padding: '10px 12px' }}>
        {grant.ownerName}
      </td>
      <td style={{ padding: '10px 12px' }}>
        {awaiting ? (
          <Chip color="var(--color-warn)">待审批</Chip>
        ) : (
          <Tooltip content={s.hint}>
            <Chip color={s.color}>{s.text}</Chip>
          </Tooltip>
        )}
      </td>
      <td className="ds-text-caption text-ds-description tnum" style={{ padding: '10px 12px' }}>
        {grant.expiresAt > 0 ? new Date(grant.expiresAt).toLocaleDateString() : '永久'}
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {awaiting && can('ssh:approve') ? (
          <>
            <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={() => void onApprove()}>
              批准
            </button>
            <button
              className="ds-btn ds-btn-ghost ds-btn-s"
              style={{ marginLeft: 5, color: 'var(--color-danger)' }}
              onClick={() => void onReject()}
            >
              驳回
            </button>
          </>
        ) : (
          <>
            {grant.state !== 'revoked' && (
              <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={onShowCommands}>
                命令
              </button>
            )}
            {grant.state !== 'revoked' && can('ssh:revoke') && (
              <button
                className="ds-btn ds-btn-ghost ds-btn-s"
                style={{ marginLeft: 5, color: 'var(--color-danger)' }}
                onClick={onRevoke}
              >
                撤销
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

function GrantDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (commands: string[], title: string) => void;
}) {
  const { can } = useAuth();
  const { nodes } = useLive();
  const keys = useAsync(() => api.sshKeys(), []);
  const endpoints = useAsync(() => api.sshEndpoints(), []);

  const [nodeId, setNodeId] = useState('');
  const [keyId, setKeyId] = useState('');
  const [remoteUser, setRemoteUser] = useState('root');
  const [ttlDays, setTtlDays] = useState('0');
  const [useAgent, setUseAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preflight, setPreflight] = useState<{ blockers: string[]; warnings: string[]; commands: string[] } | null>(null);

  const expiresAt = useMemo(() => {
    const d = Number(ttlDays);
    return d > 0 ? Date.now() + d * 86_400_000 : 0;
  }, [ttlDays]);

  async function check() {
    if (!nodeId || !keyId) return;
    setError('');
    try {
      const p = await api.sshPreflight({ nodeId, keyId, remoteUser, expiresAt });
      setPreflight(p);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '预检失败');
      setPreflight(null);
    }
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.createSshGrant({ nodeId, keyId, remoteUser, expiresAt, useAgent });
      const ep = endpoints.data?.find((e) => e.nodeId === nodeId);
      onCreated(res.commands, `授权访问 ${ep?.nodeName ?? nodeId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '授权失败');
    } finally {
      setBusy(false);
    }
  }

  const ep = endpoints.data?.find((e) => e.nodeId === nodeId);

  return (
    <Modal
      title="新建 SSH 授权"
      subtitle="面板生成一条可以直接粘贴执行的命令，不会自己去改机器"
      onClose={onClose}
      width={620}
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
            disabled={busy || !nodeId || !keyId || (preflight?.blockers.length ?? 0) > 0}
          >
            {busy ? '提交中…' : '授权'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <Alert tone="danger" title="出错了">{error}</Alert>}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="机器" grow>
            <Select
              value={nodeId}
              onChange={(v) => {
                setNodeId(v);
                const e = endpoints.data?.find((x) => x.nodeId === v);
                if (e) setRemoteUser(e.defaultUser);
                setPreflight(null);
              }}
              ariaLabel="机器"
              options={[
                { value: '', label: '选择机器' },
                ...nodes.map((n) => ({ value: n.id, label: n.name })),
              ]}
            />
          </Field>
          <Field label="远程账号" grow>
            <input
              className="ds-input"
              value={remoteUser}
              onChange={(e) => {
                setRemoteUser(e.target.value);
                setPreflight(null);
              }}
            />
          </Field>
        </div>

        <Field label="用哪把钥匙" hint="只能用自己名下的公钥">
          <Select
            value={keyId}
            onChange={(v) => {
              setKeyId(v);
              setPreflight(null);
            }}
            ariaLabel="公钥"
            options={[
              { value: '', label: '选择公钥' },
              ...(keys.data ?? [])
                .filter((k) => !k.disabled)
                .map((k) => ({ value: k.id, label: `${k.label} · ${k.keyType}` })),
            ]}
          />
        </Field>

        <Field
          label="有效期"
          hint={
            ep && ep.sshdVersion && !supportsExpiryClient(ep.sshdVersion)
              ? `注意：这台机器的 sshd 是 ${ep.sshdVersion}，不支持 expiry-time`
              : '天数。0 表示永久'
          }
        >
          <input
            className="ds-input"
            value={ttlDays}
            onChange={(e) => {
              setTtlDays(e.target.value);
              setPreflight(null);
            }}
            style={{ width: 120 }}
          />
        </Field>

        {can('ssh:remote_apply') && (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              border: `1px solid ${useAgent ? 'color-mix(in srgb, var(--color-danger) 30%, transparent)' : 'var(--ds-border)'}`,
              background: useAgent
                ? 'color-mix(in srgb, var(--color-danger) 5%, transparent)'
                : 'var(--ds-bg-sunken)',
            }}
          >
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={useAgent}
                onChange={(e) => setUseAgent(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span className="ds-text-body-sm" style={{ fontWeight: 600 }}>
                  经 agent 远程写入
                </span>
                <span className="ds-text-caption text-ds-description" style={{ display: 'block' }}>
                  不勾选时面板只生成命令，由你自己去机器上执行 —— 那样面板永远不具备
                  改动机器的能力。勾选后 agent 会直接改 authorized_keys，且目标机器的
                  agent 必须以 <code>-ssh-keys</code> 启动。
                </span>
              </span>
            </label>
          </div>
        )}

        <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={() => void check()} disabled={!nodeId || !keyId}>
          预检
        </button>

        {preflight && (
          <>
            {preflight.blockers.length > 0 && (
              <Alert tone="danger" title="不能执行">
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {preflight.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {preflight.warnings.length > 0 && (
              <Alert tone="warn" title="需要注意">
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {preflight.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {preflight.commands.length > 0 && (
              <div>
                <div className="ds-text-caption text-ds-description" style={{ marginBottom: 6 }}>
                  将要执行
                </div>
                <pre className="ds-enroll-cmd" style={{ maxHeight: 160, overflow: 'auto' }}>
                  {preflight.commands.join('\n')}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** 和服务端 supportsExpiry 同一套判据，只用于提前给人一个提示。 */
function supportsExpiryClient(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 7 || (major === 7 && minor >= 7);
}

function CommandsDialog({
  title,
  commands,
  onClose,
}: {
  title: string;
  commands: string[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const text = commands.join('\n');

  return (
    <Modal
      title={title}
      subtitle="在目标机器上以 root 执行"
      onClose={onClose}
      width={720}
      icon={<IconCopy size={16} />}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="ds-btn ds-btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button
            className="ds-btn ds-btn-primary"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              });
            }}
          >
            {copied ? '已复制' : '复制命令'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <pre className="ds-enroll-cmd" style={{ maxHeight: 300, overflow: 'auto' }}>
          {text}
        </pre>
        {/*
          刻意生成人能看懂的原生 shell，而不是 curl | bash。
          这条命令改的是目标机器的信任根 —— 让人执行一个看不懂的脚本去改
          自己的信任根，本身就是讽刺。
        */}
        <Alert tone="info" title="这条命令是可读的，执行前请看一眼">
          它只做四件事：建 .ssh 目录并设好权限、确保 authorized_keys 存在、
          检查这把钥匙在不在、不在就<b>追加</b>一行。全程不会覆盖任何已有内容。
        </Alert>
      </div>
    </Modal>
  );
}

// ————————————————————————————————————————————————————————
// 密钥实况
// ————————————————————————————————————————————————————————

/**
 * 对账视图。
 *
 * `known=false` 的那些是这整套东西最有价值的输出 —— 它回答"这台机器上有几把
 * 我不知道来路的钥匙"。一台买了两年、装过各种一键脚本的 VPS，这个数字往往不是 0，
 * 而今天没有任何工具会告诉你。
 */
function DriftTab() {
  const drift = useAsync(() => api.sshDrift(), []);

  if (drift.loading && !drift.data) return <Skeleton height={220} />;
  const list = drift.data ?? [];

  const unknown = list.filter((d) => !d.known);
  const byNode = new Map<string, SshDrift[]>();
  for (const d of list) {
    const arr = byNode.get(d.nodeId) ?? [];
    arr.push(d);
    byNode.set(d.nodeId, arr);
  }

  return (
    <>
      {unknown.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="warn" title={`发现 ${unknown.length} 把面板不认识的公钥`}>
            它们确实在机器上，但没有登记在这个面板里 —— 可能是装机时留下的、
            某个一键脚本加的，也可能是别人加的。
            <b>逐一确认它们的来历</b>，认不出来的应该删掉。
          </Alert>
        </div>
      )}

      {list.length === 0 ? (
        <SectionCard title="密钥实况">
          <EmptyState
            title="还没有采集到任何机器的密钥实况"
            hint="需要 agent 支持 SSH 实况上报（新版本 agent 自动开启，只读，不改动任何东西）。非 Linux 机器不支持。"
          />
        </SectionCard>
      ) : (
        [...byNode.entries()].map(([nodeId, keys]) => (
          <div key={nodeId} style={{ marginBottom: 12 }}>
            <SectionCard
              title={keys[0]?.nodeName ?? nodeId}
              subtitle={`${keys.length} 把公钥 · ${keys.filter((k) => k.managed).length} 把由 Sonar 管理`}
              padded={false}
            >
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {keys.map((k) => (
                  <div
                    key={k.remoteUser + k.fingerprint}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 16px',
                      borderBottom: '1px solid var(--ds-border)',
                      background: k.known ? undefined : 'color-mix(in srgb, var(--color-warn) 5%, transparent)',
                    }}
                  >
                    {k.known ? <IconCheck size={14} /> : <IconAlert size={14} style={{ color: 'var(--color-warn)' }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="ds-text-body-sm">
                        <span style={{ fontWeight: 500 }}>{k.remoteUser}</span>
                        <span className="text-ds-description"> · {k.keyType}</span>
                        {k.managed && (
                          <span style={{ marginLeft: 6 }}>
                            <Chip color="var(--color-ok)">Sonar 管理</Chip>
                          </span>
                        )}
                      </div>
                      <code className="ds-text-caption text-ds-description">{k.fingerprint}</code>
                      {k.comment && (
                        <div className="ds-text-caption text-ds-description">{k.comment}</div>
                      )}
                    </div>
                    <div className="ds-text-caption" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {k.known ? (
                        <span className="text-ds-description">{k.ownerName || '已登记'}</span>
                      ) : (
                        <span style={{ color: 'var(--color-warn)' }}>来历不明</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>
        ))
      )}
    </>
  );
}
