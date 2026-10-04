import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Logo,
  IconChevronDown,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSun,
  IconTerminal,
  IconUser,
} from './icons';
import { LoginDialog } from './LoginDialog';
import { Modal } from './Modal';
import { Tooltip } from './Tooltip';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { useNavGroups } from './nav';
import { Badge } from './ui';
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

const CONN_TONE: Record<ConnState, 'warn' | 'ok' | 'danger'> = {
  connecting: 'warn',
  live: 'ok',
  reconnecting: 'warn',
  down: 'danger',
};

const LOGIN_EVENT = 'sonar:open-login';

/**
 * 从页面里打开登录框。
 *
 * 登录框挂在外壳上，而"这一页需要先登录"之类的提示在路由里面，隔着好几层；
 * 用一个窗口事件传过来，免得为了一个按钮把状态一路往下透传。
 */
export function openLogin(): void {
  window.dispatchEvent(new Event(LOGIN_EVENT));
}

/** ⌘ 还是 Ctrl。快捷键提示写错平台，等于告诉 Windows 用户一个按不出来的组合 */
export function modKey(): string {
  const p =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad/i.test(p) ? '⌘' : 'Ctrl';
}

/** 正在往输入框里打字时，单键快捷键（比如 /）不能抢走这个字符 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** 这一页的区块是不是贴着纸面边缘铺的（自己管内边距） */
function bleeds(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/node/');
}

/**
 * 换页动画的 key。
 *
 * 管理后台、SSH 里切标签只换了路径的后半段，那是同一页里的切换，不该整页重放入场；
 * 详情页之间互相跳（/node/a → /node/b）则是真的换了一台机器，状态要清干净。
 */
function routeKey(pathname: string): string {
  if (pathname.startsWith('/node/')) return pathname;
  return `/${pathname.split('/')[1] ?? ''}`;
}

/**
 * 页面外壳：一条顶栏 + 居中的内容区。
 *
 * 顶栏只放四样东西：品牌、搜索、主题、身份。去哪个页面不靠常驻导航 ——
 * 面板的主体就是概览这一页，SSH 和管理后台是低频入口，放在头像菜单里，
 * 外加 ⌘K 随时跳转。界面应该像一块安静的仪表盘，而不是一套后台系统。
 */
export function Shell({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const { me, can, logout } = useAuth();
  const theme = useTheme();
  const { conn } = useLive();
  const location = useLocation();
  const navigate = useNavigate();
  const nav = useNavGroups();

  const [palette, setPalette] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  // 标签页标题跟着面板名走。自部署的人常同时开着好几个面板，
  // 全都叫 "Sonar" 的话，标签栏上根本分不出哪个是哪个
  useEffect(() => {
    document.title = settings.panelTagline
      ? `${settings.panelName} · ${settings.panelTagline}`
      : settings.panelName;
  }, [settings.panelName, settings.panelTagline]);

  /*
   * GitHub 回调失败会带着 ?login_error= 跳回来。
   *
   * 那时人已经不在登录框里了，不自动打开的话，页面看起来就是"点了登录，
   * 转了一圈，什么都没发生"—— 最难排查的那种失败。
   */
  useEffect(() => {
    if (new URLSearchParams(location.search).has('login_error')) setLoginOpen(true);
    // 只在落地时看一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const open = () => setLoginOpen(true);
    window.addEventListener(LOGIN_EVENT, open);
    return () => window.removeEventListener(LOGIN_EVENT, open);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [
      {
        id: 'theme',
        title: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        icon: theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />,
        keywords: 'theme dark light 主题 深色 浅色 夜间',
        run: () => toggleTheme(),
      },
    ];
    if (can('node:manage')) {
      list.push({
        id: 'enroll',
        title: '接入新机器',
        icon: <IconPlus size={16} />,
        keywords: 'enroll add agent 添加 安装',
        run: () => navigate('/?enroll=1'),
      });
    }
    if (me) {
      list.push({
        id: 'logout',
        title: '退出登录',
        icon: <IconLogout size={16} />,
        keywords: 'logout sign out 登出',
        run: () => void logout(),
      });
    } else {
      list.push({
        id: 'login',
        title: '登录',
        icon: <IconUser size={16} />,
        keywords: 'login sign in',
        run: () => setLoginOpen(true),
      });
    }
    return list;
  }, [theme, can, me, logout, navigate]);

  const closePalette = useCallback(() => setPalette(false), []);

  return (
    <div className="ds-app">
      <header className="ds-topbar">
        <div className="ds-topbar-inner">
          <Link to="/" className="ds-brand" aria-label={`${settings.panelName} 首页`}>
            <Logo size={28} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span className="ds-brand-name">{settings.panelName}</span>
              {/* 副标题可以被清空 —— 有人就是不想要那行小字 */}
              {settings.panelTagline && <span className="ds-brand-tagline">{settings.panelTagline}</span>}
            </span>
          </Link>

          <span style={{ flex: 1 }} />

          {/* 连接正常时什么都不显示 —— 一切如常是默认状态，只有断线才值得占用注意力 */}
          {conn !== 'live' && (
            <Badge tone={CONN_TONE[conn]} dot>
              {CONN_TEXT[conn]}
            </Badge>
          )}

          <Tooltip content={`搜索机器与页面  ${modKey()} K`} placement="bottom">
            <button className="ds-btn-icon" onClick={() => setPalette(true)} aria-label="搜索">
              <IconSearch size={17} />
            </button>
          </Tooltip>

          <Tooltip content={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} placement="bottom">
            <button
              className="ds-btn-icon"
              onClick={() => toggleTheme()}
              aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            >
              <span key={theme} style={{ display: 'flex', animation: 'ds-theme-icon 0.35s cubic-bezier(0.16,1,0.3,1)' }}>
                {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
              </span>
            </button>
          </Tooltip>

          {me ? (
            <UserMenu />
          ) : (
            <button className="ds-btn ds-btn-primary ds-btn-s" style={{ marginLeft: 4 }} onClick={() => setLoginOpen(true)}>
              登录
            </button>
          )}
        </div>
      </header>

      {/*
        纸面。顶上两个角各压一个橙色小方块 —— 顶栏的底线和纸面的边线在那里相交。
        概览和详情页的区块是贴边的（发丝线要通到纸面边缘），其余页面留内边距。
      */}
      <main className="ds-frame">
        <span className="ds-sq" style={{ left: 0, top: 0 }} aria-hidden="true" />
        <span className="ds-sq" style={{ left: '100%', top: 0 }} aria-hidden="true" />
        {/* key 跟着路径走：换页时内容区重新挂载，播一次很轻的淡入 */}
        <div className={bleeds(location.pathname) ? 'ds-route' : 'ds-route ds-frame-body'} key={routeKey(location.pathname)}>
          {children}
        </div>
      </main>

      {palette && <CommandPalette onClose={closePalette} nav={nav} actions={actions} />}
      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
    </div>
  );
}

/**
 * GitHub OAuth 还没配时的指引。这一步只能由面板的拥有者本人完成。
 *
 * 这条命令要在面板所在的机器上执行。之前这里写死的是 `ssh <某台主机名>` ——
 * 那是开发时自己机器的名字，对任何别的部署者都毫无意义，开源出去更是直接泄露了部署拓扑。
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
          width: 22,
          height: 22,
          borderRadius: '50%',
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          background: 'var(--color-brand-soft)',
          color: 'var(--color-brand)',
          fontSize: 12,
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
          fontSize: 11.5,
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

/** 头像：有 GitHub 头像就用，没有就用名字的第一个字，比一个地球图标更像"我" */
function Avatar({ name, src, size = 26 }: { name: string; src?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        style={{ borderRadius: '50%', flexShrink: 0, boxShadow: '0 0 0 1px var(--ds-border)' }}
      />
    );
  }
  const initial = [...(name.trim() || '?')][0]!.toUpperCase();
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--color-brand-soft)',
        color: 'var(--color-brand)',
        fontSize: size * 0.46,
        fontWeight: 600,
      }}
    >
      {initial}
    </span>
  );
}

/**
 * 顶栏右侧的身份入口，同时也是 SSH、管理后台这些低频页面的入口。
 *
 * 每一项一个专属图标。之前个人设置和退出登录用的都是地球、SSH 和管理后台用的
 * 都是盾牌，菜单里四行有两对长得一样，只能靠读字区分。
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

  if (!me) return null;

  const canSsh = can('ssh:view') || can('ssh:keys');
  const canAdmin = can('user:view') || can('audit:view') || can('alert:view') || can('settings:view');

  return (
    <div ref={ref} style={{ position: 'relative', marginLeft: 4 }}>
      <button
        className="ds-user-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="账号菜单"
      >
        <Avatar name={me.name} src={me.avatar} />
        <span className="ds-user-name">{me.name}</span>
        <IconChevronDown size={13} className="ds-user-chevron" />
      </button>

      {open && (
        <div
          className="ds-dropdown ds-menu-pop"
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: 232,
            padding: 6,
            zIndex: 70,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px 10px' }}>
            <Avatar name={me.name} src={me.avatar} size={34} />
            <div style={{ minWidth: 0 }}>
              <div className="ds-text-body-sm ds-ellipsis" style={{ fontWeight: 600, color: 'var(--ds-text-primary)' }}>
                {me.name}
              </div>
              <div className="ds-text-caption text-ds-description ds-ellipsis">
                {me.kind === 'guest' ? '访客身份' : `@${me.username || me.login}`} · {me.roleLabel}
              </div>
            </div>
          </div>

          <div className="ds-menu-sep" />

          {/* 访客没有可维护的凭据，个人设置对他是一个空页面 */}
          {me.kind !== 'guest' && (
            <Link to="/settings" role="menuitem" onClick={() => setOpen(false)} className="ds-menu-item">
              <IconUser size={15} />
              个人设置
            </Link>
          )}

          {canSsh && (
            <Link to="/ssh" role="menuitem" onClick={() => setOpen(false)} className="ds-menu-item">
              <IconTerminal size={15} />
              SSH 接入
            </Link>
          )}

          {canAdmin && (
            <Link to="/admin" role="menuitem" onClick={() => setOpen(false)} className="ds-menu-item">
              <IconSettings size={15} />
              管理后台
            </Link>
          )}

          <div className="ds-menu-sep" />

          <button role="menuitem" onClick={() => void logout()} className="ds-menu-item">
            <IconLogout size={15} />
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
