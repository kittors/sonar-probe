import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type IdentityInfo } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago } from '../lib/format';
import { IconCheck, IconChevronRight, IconGlobe, IconShield } from '../components/icons';
import { OAuthSetupDialog } from '../components/Shell';
import { Alert, Field, PageHeader, SectionCard } from '../components/ui';
import { Tooltip } from '../components/Tooltip';
import { PasswordInput, TextInput } from '../components/Input';

/**
 * 个人设置
 *
 * 这一页不需要任何能力点。改自己的密码、绑自己的 GitHub 是账号自带的权利 ——
 * 挂在 user:manage 之类的能力下面，会导致一个被收走全部权限的人连密码都改不了，
 * 而那恰恰是最该让他改密码的处境。
 */
export function Profile() {
  const { me, identities, config, refresh } = useAuth();
  const [list, setList] = useState<IdentityInfo[]>(identities);

  useEffect(() => setList(identities), [identities]);

  if (!me) return null;

  const header = (
    <PageHeader
      breadcrumb={
        <nav className="ds-breadcrumb" aria-label="当前位置">
          <Link to="/">机器概览</Link>
          <IconChevronRight size={12} />
          <span aria-current="page">个人设置</span>
        </nav>
      }
      title="个人设置"
      description={`${me.name} · ${me.roleLabel}。改自己的资料、密码和登录方式不需要任何权限。`}
    />
  );

  if (me.kind === 'guest') {
    return (
      <div className="ds-narrow">
        {header}
        <Alert tone="info" title="访客身份没有可维护的凭据">
          访客是一次性身份，关掉浏览器就结束了，没有密码也不能绑定 GitHub。
          需要长期访问的话，请管理员给你开一个正式账号。
        </Alert>
      </div>
    );
  }

  /*
   * 表单页收窄到 760px。之前三个输入框拉满整屏宽，一个"邮箱"框有六七百像素长，
   * 视线要横跨整个屏幕去找下一格。
   */
  return (
    <div className="ds-narrow" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ marginBottom: -4 }}>{header}</div>
      {me.mustChangePassword && (
        <Alert tone="warn" title="请先修改初始密码">
          你现在用的是系统生成或管理员设置的密码，它经过了第二个人的手（或者写在服务器的文件里）。
          换成只有你知道的密码之后，这条提示会消失。
        </Alert>
      )}

      <ProfileCard />
      <PasswordCard onDone={() => void refresh()} />
      <IdentitiesCard
        identities={list}
        githubConfigured={config?.github ?? false}
        onChange={(next) => {
          setList(next);
          void refresh();
        }}
      />
    </div>
  );
}

function ProfileCard() {
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.name ?? '');
  const [email, setEmail] = useState(me?.email ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(t);
  }, [done]);

  const dirty = name !== (me?.name ?? '') || email !== (me?.email ?? '');

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.updateProfile({ name: name.trim(), email: email.trim() });
      await refresh();
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="基本信息" subtitle="显示在顶栏、在线列表和审计日志里">
      {error && <Alert tone="danger" title="保存失败">{error}</Alert>}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: error ? 12 : 0 }}>
        <Field label="用户名" grow hint="登录用，创建后不可更改">
          <TextInput value={me?.username || '—'} disabled />
        </Field>
        <Field label="显示名称" grow>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="邮箱" grow hint="仅用于展示，不会发信">
          <TextInput value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <span className="ds-text-caption text-ds-description" style={{ flex: 1 }}>
          当前角色：{me?.roleLabel}
          {me?.isRoot && ' · 超级管理员'}
        </span>
        {done && (
          <span className="ds-text-caption" style={{ color: 'var(--color-ok)' }}>
            <IconCheck size={12} /> 已保存
          </span>
        )}
        <button className="ds-btn ds-btn-primary ds-btn-s" onClick={() => void save()} disabled={busy || !dirty}>
          保存
        </button>
      </div>
    </SectionCard>
  );
}

function PasswordCard({ onDone }: { onDone: () => void }) {
  const { identities } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const hasPassword = identities.some((i) => i.provider === 'password');
  const mismatch = confirm.length > 0 && next !== confirm;

  async function submit() {
    if (next !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '修改失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title={hasPassword ? '修改密码' : '设置密码'}
      subtitle={
        hasPassword
          ? '改完之后，你在其它设备上的登录会被踢下线，当前这个窗口不受影响'
          : '这个账号目前只能用 GitHub 登录。设一个密码，OAuth 出问题时还有路进来'
      }
    >
      {error && <Alert tone="danger" title="修改失败">{error}</Alert>}
      {done && !error && <Alert tone="success" title="密码已更新">其它设备上的登录已经失效。</Alert>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: error || done ? 12 : 0 }}>
        {hasPassword && (
          <Field label="当前密码">
            <PasswordInput
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
        )}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="新密码" grow hint="至少 10 位，包含两类以上字符，且不能含用户名">
            <PasswordInput
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="确认新密码" grow error={mismatch ? '两次输入不一致' : ''}>
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button
          className="ds-btn ds-btn-primary ds-btn-s"
          onClick={() => void submit()}
          disabled={busy || !next || !confirm || mismatch || (hasPassword && !current)}
        >
          {busy ? '提交中…' : hasPassword ? '修改密码' : '设置密码'}
        </button>
      </div>
    </SectionCard>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  password: '用户名密码',
  github: 'GitHub',
};

function IdentitiesCard({
  identities,
  githubConfigured,
  onChange,
}: {
  identities: IdentityInfo[];
  githubConfigured: boolean;
  onChange: (next: IdentityInfo[]) => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [linked, setLinked] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);

  // 配 OAuth 要动服务器上的文件，只有能改设置的人看到这个引导才有意义
  const canSetup = can('settings:manage');

  // GitHub 绑定走一次完整跳转，回来时带着结果
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const ok = p.get('linked');
    const err = p.get('link_error');
    if (ok) setLinked(PROVIDER_LABEL[ok] ?? ok);
    if (err) {
      setError(
        err === 'session_changed'
          ? '绑定过程中登录状态变了，请重新发起'
          : decodeURIComponent(err),
      );
    }
    if (ok || err) {
      const url = new URL(location.href);
      url.searchParams.delete('linked');
      url.searchParams.delete('link_error');
      history.replaceState(null, '', url);
    }
  }, []);

  const hasGithub = identities.some((i) => i.provider === 'github');
  const only = identities.length <= 1;

  async function unbind(provider: 'github' | 'password') {
    setBusy(provider);
    setError('');
    try {
      const res = await api.unbindIdentity(provider);
      onChange(res.identities);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '解绑失败');
    } finally {
      setBusy('');
    }
  }

  return (
    <SectionCard title="登录方式" subtitle="同一个账号可以有多种登录方式，用哪种进来都是同一个你">
      {error && <Alert tone="danger" title="操作失败">{error}</Alert>}
      {linked && <Alert tone="success" title={`已绑定 ${linked}`}>现在可以用它登录了。</Alert>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: error || linked ? 12 : 0 }}>
        {identities.map((i) => (
          <div
            key={i.provider}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid var(--ds-border)',
              background: 'var(--ds-bg-sunken)',
            }}
          >
            {i.provider === 'github' ? <IconGlobe size={15} /> : <IconShield size={15} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ds-text-body-sm" style={{ fontWeight: 600 }}>
                {PROVIDER_LABEL[i.provider] ?? i.provider}
              </div>
              <div className="ds-text-caption text-ds-description">
                {i.label}
                {i.lastUsedAt > 0 && ` · 最近使用 ${ago(i.lastUsedAt)}`}
              </div>
            </div>
            {/*
              提示挂在外面那层 span 上：按钮禁用时浏览器不给它派发鼠标事件，
              直接挂在按钮上的提示永远出不来 —— 而禁用的时候恰恰最需要说明为什么。
            */}
            <Tooltip content={only ? '这是唯一的登录方式，解绑后就再也登不进来了' : ''}>
              <span style={{ display: 'inline-flex' }}>
                <button
                  className="ds-btn ds-btn-ghost ds-btn-s"
                  onClick={() => void unbind(i.provider)}
                  disabled={busy === i.provider || only}
                >
                  解绑
                </button>
              </span>
            </Tooltip>
          </div>
        ))}
      </div>

      {!hasGithub && (
        <div style={{ marginTop: 12 }}>
          {githubConfigured ? (
            <a
              className="ds-btn ds-btn-ghost ds-btn-s"
              href={`/api/auth/github?mode=link&redirect=${encodeURIComponent('/settings')}`}
              style={{ textDecoration: 'none' }}
            >
              <IconGlobe size={13} />
              绑定 GitHub
            </a>
          ) : (
            <Alert tone="info" title="面板还没有配置 GitHub 登录">
              需要先在服务端填好 <code>GITHUB_CLIENT_ID</code> 和{' '}
              <code>GITHUB_CLIENT_SECRET</code>，这里才会出现绑定入口。
              {canSetup && (
                <>
                  {' '}
                  <button
                    className="ds-link-btn"
                    onClick={() => setSetupOpen(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      font: 'inherit',
                      color: 'var(--color-brand)',
                      cursor: 'pointer',
                    }}
                  >
                    查看配置步骤
                  </button>
                </>
              )}
            </Alert>
          )}
          {setupOpen && <OAuthSetupDialog onClose={() => setSetupOpen(false)} />}
        </div>
      )}

      {only && (
        <p className="ds-text-caption text-ds-description" style={{ margin: '12px 0 0' }}>
          只剩一种登录方式时不能解绑 —— 解开之后账号还在、权限还在，但没有任何一条路能再登进来。
        </p>
      )}
    </SectionCard>
  );
}
