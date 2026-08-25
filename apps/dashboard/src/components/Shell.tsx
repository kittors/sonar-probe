import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo, IconChevronDown, IconGlobe, IconMoon, IconShield, IconSun } from './icons';
import { LoginDialog } from './LoginDialog';
import { Modal } from './Modal';
import { useLive } from '../lib/live';
import { useSettings } from '../lib/settings';
import { toggleTheme, useTheme } from '../lib/theme';
import { useAuth } from '../lib/auth';
import type { ConnState } from '../lib/live';

const CONN_TEXT: Record<ConnState, string> = {
  connecting: '连接中',
  live: '实时',
  reconnecting: '重连中',
  down: '已断开',
};

const CONN_COLOR: Record<ConnState, string> = {
  connecting: 'var(--color-warn)',
  live: 'var(--color-ok)',
  reconnecting: 'var(--color-warn)',
  down: 'var(--color-danger)',
};

/** 页面外壳：背景光晕 + 顶栏。两个页面共用。 */
export function Shell({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const { conn } = useLive();
  const settings = useSettings();

  // 标签页标题跟着面板名走。自部署的人常同时开着好几个面板，
  // 全都叫 "Sonar" 的话，标签栏上根本分不出哪个是哪个
  useEffect(() => {
    document.title = settings.panelTagline
      ? `${settings.panelName} · ${settings.panelTagline}`
      : settings.panelName;
  }, [settings.panelName, settings.panelTagline]);

  return (
    <div style={{ minHeight: '100%', position: 'relative', isolation: 'isolate' }}>
      {/* 顶部那层极淡的品牌光晕。DeepSeek 首页就是靠它把纯白底撑出空间感的 */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: -1,
          pointerEvents: 'none',
          background: `
            radial-gradient(900px 460px at 12% -8%, var(--ds-aurora-1), transparent 62%),
            radial-gradient(760px 420px at 88% -12%, var(--ds-aurora-2), transparent 58%)
          `,
        }}
      />

      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'var(--ds-glass-bg)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          borderBottom: '1px solid var(--ds-border)',
        }}
      >
        <div
          className="ds-container"
          style={{
            height: 58,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Link
            to="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <Logo size={27} />
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
              <span
                className="ds-text-subtitle text-ds-primary"
                style={{ letterSpacing: '-0.015em' }}
              >
                {settings.panelName}
              </span>
              {/* 副标题可以被清空 —— 有人就是不想要那行小字 */}
              {settings.panelTagline && (
                <span className="ds-text-xs text-ds-description">{settings.panelTagline}</span>
              )}
            </span>
          </Link>

          <span style={{ flex: 1 }} />

          {/* 连接正常时什么都不显示 —— 一切如常是默认状态，不需要一个常驻指示物。
              只有断线才值得占用注意力。 */}
          {conn !== 'live' && (
            <span
              className="ds-chip"
              style={{
                color: CONN_COLOR[conn],
                background: `color-mix(in srgb, ${CONN_COLOR[conn]} 10%, transparent)`,
                borderColor: `color-mix(in srgb, ${CONN_COLOR[conn]} 24%, transparent)`,
              }}
            >
              {CONN_TEXT[conn]}
            </span>
          )}

          <button
            className="ds-btn-icon"
            onClick={() => toggleTheme()}
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          >
            {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
          </button>

          <UserMenu />
        </div>
      </header>

      <main className="ds-container" style={{ paddingBlock: 'clamp(20px, 3vw, 32px) 64px' }}>
        {children}
      </main>
    </div>
  );
}

/**
 * 登录入口。
 *
 * 打开一个对话框而不是直接跳 GitHub —— 现在有三条路（密码、GitHub、访客），
 * 而密码是唯一不依赖外部配置、永远可用的那条。直接跳转的写法把面板的
 * 可登录性绑在了 OAuth 配置上：secret 填错、GitHub 挂了、机器出不了网，
 * 管理员就再也进不去自己的面板。
 */
function SignInButton() {
  const [open, setOpen] = useState(false);

  /*
   * GitHub 回调失败会带着 ?login_error= 跳回来。
   *
   * 那时人已经不在登录框里了，不自动打开的话，页面看起来就是"点了登录，
   * 转了一圈，什么都没发生"—— 最难排查的那种失败。
   */
  useEffect(() => {
    if (new URLSearchParams(location.search).has('login_error')) setOpen(true);
  }, []);

  return (
    <>
      <button className="ds-btn ds-btn-primary ds-btn-s" onClick={() => setOpen(true)}>
        登录
      </button>
      {open && <LoginDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * GitHub OAuth 还没配时的指引。这一步只能由面板的拥有者本人完成。
 *
 * 必须用 Portal 挂到 body：这个组件渲染在顶栏里，而顶栏有 backdrop-filter。
 * 带 backdrop-filter / transform / filter 的元素会成为后代 fixed 定位的包含块 ——
 * 不脱离出去的话，inset:0 的遮罩只会撑满 58px 高的顶栏，弹窗直接溢出到屏幕外。
 */
/*
 * 这条命令要在面板所在的机器上执行。
 *
 * 之前这里写死的是 `ssh <某台主机名>` —— 那是开发时自己机器的名字，对任何
 * 别的部署者都毫无意义，开源出去更是直接泄露了部署拓扑。
 */
const SETUP_CMD = 'sudo vi /opt/sonar/server/data/panel.env && sudo systemctl restart sonar';

export function OAuthSetupDialog({ onClose }: { onClose: () => void }) {
  const callback = `${location.origin}/api/auth/github/callback`;
  const [copied, setCopied] = useState<string | null>(null);

  function copy(text: string, tag: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(tag);
      setTimeout(() => setCopied(null), 1600);
    });
  }

  return (
    <Modal
      title="GitHub 登录还没启用"
      onClose={onClose}
      width={520}
      footer={
        <button className="ds-btn ds-btn-ghost" onClick={onClose}>
          知道了
        </button>
      }
    >
        <p className="ds-text-body-sm text-ds-secondary" style={{ margin: '0 0 18px', lineHeight: 1.7 }}>
          面板还没有 GitHub 的 Client ID 和 Secret。这一步得由你来做 —— OAuth App 要建在你自己的
          GitHub 账号下，Secret 也只有你能看到。配好之后第一个登录成功的人就是管理员。
        </p>

        <Step n={1} title="创建 OAuth App">
          打开{' '}
          <a
            href="https://github.com/settings/developers"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--color-brand)' }}
          >
            github.com/settings/developers
          </a>
          ，点 New OAuth App。Homepage 填 <Code>{location.origin}</Code>，Authorization callback URL 填：
          <CopyRow value={callback} copied={copied === 'cb'} onCopy={() => copy(callback, 'cb')} />
        </Step>

        <Step n={2} title="把凭据填进服务器">
          在面板所在的机器上编辑配置文件，填上 <Code>GITHUB_CLIENT_ID</Code> 和{' '}
          <Code>GITHUB_CLIENT_SECRET</Code> 两行，然后重启服务：
          <CopyRow value={SETUP_CMD} copied={copied === 'cmd'} onCopy={() => copy(SETUP_CMD, 'cmd')} />
        </Step>

        <Step n={3} title="回来点登录" last>
          重启后刷新这个页面，「登录」就会直接跳到 GitHub 授权。
        </Step>

    </Modal>
  );
}

function Step({
  n,
  title,
  children,
  last,
}: {
  n: number;
  title: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 12, paddingBottom: last ? 0 : 16 }}>
      <span
        className="tnum"
        style={{
          width: 21,
          height: 21,
          borderRadius: '50%',
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          background: 'var(--color-brand-soft)',
          color: 'var(--color-brand)',
          fontSize: 11.5,
          fontWeight: 600,
        }}
      >
        {n}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ds-text-body-sm" style={{ fontWeight: 600, color: 'var(--ds-text-primary)', marginBottom: 4 }}>
          {title}
        </div>
        <div className="ds-text-caption text-ds-secondary" style={{ lineHeight: 1.75 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11.5,
        padding: '1px 5px',
        borderRadius: 4,
        background: 'var(--ds-bg-sunken)',
        border: '1px solid var(--ds-border)',
      }}
    >
      {children}
    </code>
  );
}

function CopyRow({
  value,
  copied,
  onCopy,
}: {
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 7,
        padding: '7px 9px',
        borderRadius: 7,
        background: 'var(--ds-bg-sunken)',
        border: '1px solid var(--ds-border)',
      }}
    >
      <code
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          flex: 1,
          minWidth: 0,
          overflowX: 'auto',
          whiteSpace: 'nowrap',
          color: 'var(--ds-text-secondary)',
        }}
      >
        {value}
      </code>
      <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={onCopy} style={{ flexShrink: 0 }}>
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

/**
 * 顶栏右侧的身份入口。
 *
 * 未登录时就是一个「登录」按钮 —— 概览页任何人都能看，
 * 想看详情再登录，不该一进门就被拦住。
 */
function UserMenu() {
  const { me, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!me) return <SignInButton />;

  const canAdmin = can('user:view') || can('audit:view') || can('alert:view');

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="ds-btn ds-btn-ghost ds-btn-s"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{ gap: 5, paddingInline: 6 }}
      >
        {me.avatar ? (
          <img src={me.avatar} alt="" width={18} height={18} style={{ borderRadius: '50%' }} />
        ) : (
          <IconGlobe size={13} />
        )}
        <span style={{ maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {me.name}
        </span>
        <IconChevronDown size={12} />
      </button>

      {open && (
        <div
          className="ds-dropdown ds-fade-in"
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 208,
            padding: 6,
            zIndex: 50,
          }}
        >
          <div style={{ padding: '7px 9px 9px' }}>
            <div className="ds-text-body-sm" style={{ fontWeight: 600, color: 'var(--ds-text-primary)' }}>
              {me.name}
            </div>
            <div className="ds-text-caption text-ds-description">
              {me.kind === 'guest' ? '访客身份' : `@${me.username || me.login}`} · {me.roleLabel}
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--ds-border)', margin: '2px 0 4px' }} />

          {/* 访客没有可维护的凭据，个人设置对他是一个空页面 */}
          {me.kind !== 'guest' && (
            <Link to="/settings" role="menuitem" onClick={() => setOpen(false)} className="ds-menu-item">
              <IconGlobe size={14} />
              个人设置
            </Link>
          )}

          {can('ssh:view') || can('ssh:keys') ? (
            <Link to="/ssh" role="menuitem" onClick={() => setOpen(false)} className="ds-menu-item">
              <IconShield size={14} />
              SSH 接入
            </Link>
          ) : null}

          {canAdmin && (
            <Link to="/admin" role="menuitem" onClick={() => setOpen(false)} className="ds-menu-item">
              <IconShield size={14} />
              管理后台
            </Link>
          )}

          <button role="menuitem" onClick={() => void logout()} className="ds-menu-item">
            <IconGlobe size={14} />
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
