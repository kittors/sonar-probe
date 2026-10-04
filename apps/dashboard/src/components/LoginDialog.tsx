import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { IconCheck, IconGlobe, IconShield } from './icons';
import { Modal } from './Modal';
import { Alert, Field } from './ui';
import { PasswordInput, TextInput } from './Input';

/**
 * 登录
 *
 * 密码在前、GitHub 在后，这个顺序是有意的：密码登录不依赖任何外部配置，
 * 是面板永远可用的那条路。OAuth 没配好、GitHub 挂了、网络出不去的时候，
 * 它是唯一能进门的方式 —— 把它放在折叠区里，等于把兜底方案藏起来。
 *
 * 三条路都可能被关掉，界面要能只剩一条时仍然说得通，而不是留下一片空白。
 */

interface Props {
  onClose: () => void;
  /** 登录成功后回到哪里，交给 GitHub 那条路带过去 */
  redirect?: string;
}

/** 页脚的提交按钮靠它关联到表单，见下面那段注释。 */
const FORM_ID = 'sonar-login-form';

export function LoginDialog({ onClose, redirect }: Props) {
  const { config, loginWithPassword, loginAsGuest } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestLabel, setGuestLabel] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // GitHub 回调失败时会把原因塞在 query 里，登录框一打开就该看到
  useEffect(() => {
    const err = new URLSearchParams(location.search).get('login_error');
    if (!err) return;
    setError(decodeURIComponent(LOGIN_ERRORS[err] ?? err));
    // 读完就从地址栏抹掉，免得刷新一次又弹一遍
    const url = new URL(location.href);
    url.searchParams.delete('login_error');
    history.replaceState(null, '', url);
  }, []);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) {
      setError('请填写用户名和密码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await loginWithPassword(username.trim(), password);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  async function guest() {
    setBusy(true);
    setError('');
    try {
      await loginAsGuest(guestLabel.trim() || undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '访客登录失败');
    } finally {
      setBusy(false);
    }
  }

  const githubUrl = `/api/auth/github?redirect=${encodeURIComponent(redirect ?? location.pathname + location.search)}`;
  const showGithub = config?.github ?? false;
  const showGuest = config?.guestEnabled ?? false;

  return (
    <Modal
      title="登录 Sonar"
      subtitle="用账号登录以查看机器详情与流量归因"
      onClose={onClose}
      width={420}
      icon={<IconShield size={16} />}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="ds-btn ds-btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          {/*
            这个按钮在 Modal 的页脚里，和 <form> 不在同一棵子树下。
            用 form 属性按 id 关联，它就是这个表单真正的提交按钮 ——
            于是在输入框里按回车能提交，而不需要再挂一个键盘监听。
          */}
          <button
            type="submit"
            form={FORM_ID}
            className="ds-btn ds-btn-primary"
            disabled={busy}
          >
            {busy ? '登录中…' : '登录'}
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => void submit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        {error && <Alert tone="danger" title="登录失败">{error}</Alert>}

        <Field label="用户名">
          <TextInput
            ref={inputRef}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="admin"
            disabled={busy}
          />
        </Field>

        <Field label="密码">
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
          />
        </Field>

        {(showGithub || showGuest) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0' }}>
            <div style={{ flex: 1, height: 1, background: 'var(--ds-border)' }} />
            <span className="ds-text-caption text-ds-description">或</span>
            <div style={{ flex: 1, height: 1, background: 'var(--ds-border)' }} />
          </div>
        )}

        {showGithub && (
          <a
            className="ds-btn ds-btn-ghost"
            href={githubUrl}
            style={{ textDecoration: 'none', justifyContent: 'center' }}
          >
            <IconGlobe size={14} />
            用 GitHub 登录
          </a>
        )}

        {showGuest && !guestOpen && (
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-s"
            onClick={() => setGuestOpen(true)}
            disabled={busy}
            style={{ justifyContent: 'center' }}
          >
            以访客身份浏览
          </button>
        )}

        {showGuest && guestOpen && (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              border: '1px solid var(--ds-border)',
              background: 'var(--ds-bg-sunken)',
              display: 'flex',
              flexDirection: 'column',
              gap: 9,
            }}
          >
            <Field label="留个称呼" hint="管理员能看到访客的到访记录，留个名字方便对方认出你">
              <TextInput
                value={guestLabel}
                onChange={(e) => setGuestLabel(e.target.value)}
                placeholder="可留空"
                disabled={busy}
              />
            </Field>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-s"
              onClick={() => void guest()}
              disabled={busy}
              style={{ justifyContent: 'center' }}
            >
              <IconCheck size={12} />
              进入
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** GitHub 回调重定向回来时带的错误码。原样显示一串英文对人没有帮助。 */
const LOGIN_ERRORS: Record<string, string> = {
  state_mismatch: '登录请求已过期，请重新点一次登录',
  missing_code: 'GitHub 没有返回授权码，请重试',
  oauth_failed: '与 GitHub 通信失败，请稍后重试',
  disabled: '这个账号已被停用，请联系管理员',
};
