import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useLive } from '../lib/live';
import { useAuth } from '../lib/auth';
import { maskIp } from '../lib/format';
import { CountryBadge } from './CountryBadge';
import { StatusDot, STATUS_TEXT } from './ui';
import { IconEnter, IconSearch } from './icons';
import type { NavGroup } from './nav';
import type { NodeStatus } from '../lib/types';

/**
 * 命令面板（⌘K）。
 *
 * 机器一多，"去某台机器的详情"就成了在网格里找卡片 —— 而人脑子里记的往往是
 * 名字的一部分、IP 的前两段或者一个标签。这里把机器、页面、常用操作放进同一个
 * 搜索框，敲几个字回车就到，和 Cloudflare 控制台的 Quick search 是同一个思路。
 *
 * 只做键盘能完成的事：↑↓ 选、回车执行、Esc 关。鼠标悬停和键盘共用同一个高亮，
 * 不会出现两行同时亮着的情况。
 */

export interface PaletteAction {
  id: string;
  title: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

interface Cmd {
  id: string;
  group: string;
  title: string;
  sub?: ReactNode;
  icon: ReactNode;
  haystack: string;
  run: () => void;
}

const MAX_MACHINES_IDLE = 6;

export function CommandPalette({
  onClose,
  nav,
  actions,
}: {
  onClose: () => void;
  nav: NavGroup[];
  actions: PaletteAction[];
}) {
  const navigate = useNavigate();
  const { nodes } = useLive();
  const { can } = useAuth();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时记住焦点在哪，关掉还回去 —— 否则 Tab 会从页面开头重新数
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, []);

  const commands = useMemo<Cmd[]>(() => {
    const list: Cmd[] = [];

    for (const g of nav) {
      for (const item of g.items) {
        const Icon = item.icon;
        list.push({
          id: `page:${item.key}`,
          group: '页面',
          title: item.label,
          sub: g.label,
          icon: <Icon size={16} />,
          haystack: `${item.label} ${g.label} ${item.keywords ?? ''}`.toLowerCase(),
          run: () => navigate(item.to),
        });
      }
    }

    // 进不了详情页的人，列出机器也只能把他带到一个"请先登录"的页面
    if (can('node:detail')) {
      const rank: Record<NodeStatus, number> = { warning: 0, online: 1, offline: 2 };
      const sorted = [...nodes].sort(
        (a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name, 'zh-CN'),
      );
      for (const n of sorted) {
        list.push({
          id: `node:${n.id}`,
          group: '机器',
          title: n.name,
          sub: (
            <>
              {STATUS_TEXT[n.status]} · {n.provider ? `${n.provider} · ` : ''}
              {maskIp(n.ip)}
            </>
          ),
          icon: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <StatusDot status={n.status} size={7} />
              <CountryBadge code={n.countryCode} title={n.region} />
            </span>
          ),
          haystack: [n.name, n.hostname, n.ip, n.provider, n.region, n.countryCode, ...n.tags]
            .join(' ')
            .toLowerCase(),
          run: () => navigate(`/node/${n.id}`),
        });
      }
    }

    for (const a of actions) {
      list.push({
        id: `act:${a.id}`,
        group: '操作',
        title: a.title,
        icon: a.icon,
        haystack: `${a.title} ${a.keywords ?? ''}`.toLowerCase(),
        run: a.run,
      });
    }
    return list;
  }, [nav, nodes, can, actions, navigate]);

  const results = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      // 空查询时机器只列前几台（告警的排最前），否则一长串机器会把页面和操作挤出视野
      let machines = 0;
      return commands.filter((c) => c.group !== '机器' || machines++ < MAX_MACHINES_IDLE);
    }
    return commands.filter((c) => tokens.every((t) => c.haystack.includes(t)));
  }, [commands, query]);

  // 结果变了就回到第一项，免得高亮停在一个已经消失的位置
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function run(cmd: Cmd | undefined) {
    if (!cmd) return;
    onClose();
    cmd.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  let lastGroup = '';

  return createPortal(
    <div
      className="ds-cmdk-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="ds-cmdk" role="dialog" aria-modal="true" aria-label="快速跳转">
        <div className="ds-cmdk-input">
          <IconSearch size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索机器名、IP、标签，或者跳到某个页面…"
            role="combobox"
            aria-expanded="true"
            aria-controls="ds-cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-${results[active].id}` : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="ds-kbd">Esc</span>
        </div>

        <div className="ds-cmdk-list" id="ds-cmdk-list" role="listbox" ref={listRef}>
          {results.length === 0 ? (
            <div className="ds-cmdk-empty">没有匹配「{query.trim()}」的机器或页面</div>
          ) : (
            results.map((c, i) => {
              const head = c.group !== lastGroup;
              lastGroup = c.group;
              return (
                <div key={c.id}>
                  {head && <div className="ds-cmdk-group">{c.group}</div>}
                  <div
                    id={`cmdk-${c.id}`}
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    data-active={i === active || undefined}
                    className="ds-cmdk-item"
                    // 用 mousemove 而不是 mouseenter：键盘翻页时列表在静止的鼠标下滚动，
                    // mouseenter 会把高亮抢回鼠标所在的那一行
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => run(c)}
                  >
                    {c.icon}
                    <span className="ds-cmdk-title">{c.title}</span>
                    {c.sub && <span className="ds-cmdk-sub">{c.sub}</span>}
                    <IconEnter size={14} className="ds-cmdk-enter" />
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="ds-cmdk-foot">
          <span>
            <span className="ds-kbd">↑</span>
            <span className="ds-kbd">↓</span>
            选择
          </span>
          <span>
            <span className="ds-kbd">↵</span>
            打开
          </span>
          <span style={{ flex: 1 }} />
          <span>
            <span className="ds-kbd">⌘</span>
            <span className="ds-kbd">K</span>
            随时唤起
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
