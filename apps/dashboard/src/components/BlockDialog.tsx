import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { BlockPreflight, BlockRule, PeerTraffic } from '../lib/types';
import { threatColor, threatLabel } from './charts/chart-utils';
import { IconAlert, IconBan, IconCheck, IconCopy, IconInfo, IconTerminal } from './icons';
import { Modal } from './Modal';
import { Checkbox, Field } from './ui';
import { bytes, count } from '../lib/format';
import { CountryBadge } from './CountryBadge';

const TTL_OPTIONS = [
  { value: 3600, label: '1 小时' },
  { value: 6 * 3600, label: '6 小时' },
  { value: 24 * 3600, label: '24 小时' },
  { value: 7 * 86400, label: '7 天' },
  { value: 0, label: '永久' },
];

interface Props {
  nodeId: string;
  nodeName: string;
  peer: PeerTraffic;
  onClose: () => void;
  onDone: (rule: BlockRule) => void;
}

/**
 * 封禁确认框。
 *
 * 核心是"让人看清自己在做什么"：先跑一次预检，把将要执行的 nftables 命令、
 * 命中的守卫、以及判定它可疑的具体依据全摊开，再让人决定要不要真的下发。
 * enforce 模式还要额外勾一次确认 —— 这一步故意做得有点麻烦。
 */
export function BlockDialog({ nodeId, nodeName, peer, onClose, onDone }: Props) {
  const [ttl, setTtl] = useState(24 * 3600);
  const [enforce, setEnforce] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState(peer.threatReasons[0] ?? '手动封禁');
  const [check, setCheck] = useState<BlockPreflight | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mode = enforce ? 'enforced' : 'dry-run';

  // 每次改模式或有效期都重新预检 —— 命令内容会跟着变，不能拿旧的给人看
  useEffect(() => {
    let alive = true;
    setChecking(true);
    api
      .preflight(nodeId, peer.ip, mode, ttl)
      .then((r) => alive && setCheck(r))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, [nodeId, peer.ip, mode, ttl]);

  // 切回 dry-run 时把确认状态清掉，避免"勾一次管一路"
  useEffect(() => {
    if (!enforce) setAcknowledged(false);
  }, [enforce]);

  const blocked = check ? !check.allowed : false;
  const canSubmit =
    !!check && check.allowed && !submitting && !checking && (!enforce || acknowledged);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const rule = await api.block({ nodeId, target: peer.ip, reason, mode, ttlSeconds: ttl });
      onDone(rule);
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : '提交失败，请重试',
      );
      setSubmitting(false);
    }
  }

  function copyCommands() {
    if (!check?.commands.length) return;
    void navigator.clipboard.writeText(check.commands.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <Modal
      title={<>封禁 <span className="tnum">{peer.ip}</span></>}
      subtitle={
        <>
          作用于 {nodeName} · <CountryBadge code={peer.countryCode} /> AS{peer.asn} {peer.org}
        </>
      }
      onClose={onClose}
      width={560}
      icon={<IconBan size={16} />}
      footer={
        <>
          <span className="ds-text-caption text-ds-description" style={{ flex: 1 }}>
            {enforce ? '规则会立刻下发' : '仅生成规则，不下发'}
          </span>
          <button className="ds-btn ds-btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className={`ds-btn ${enforce ? 'ds-btn-danger' : 'ds-btn-primary'}`}
            disabled={!canSubmit}
            onClick={submit}
          >
            {submitting ? '提交中…' : enforce ? '确认封禁' : '生成规则'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* —— 判定依据 —— */}
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <span className="ds-text-caption text-ds-description">判定依据</span>
              <span
                className="ds-chip"
                style={{
                  color: threatColor(peer.threatScore),
                  background: `color-mix(in srgb, ${threatColor(peer.threatScore)} 10%, transparent)`,
                  borderColor: `color-mix(in srgb, ${threatColor(peer.threatScore)} 24%, transparent)`,
                }}
              >
                {threatLabel(peer.threatScore)} {peer.threatScore}
              </span>
              <span style={{ flex: 1 }} />
              <span className="ds-text-caption text-ds-description tnum">
                {bytes(peer.rx + peer.tx)} · {count(peer.conns)} 连接
              </span>
            </div>
            {peer.threatReasons.length > 0 ? (
              <ul
                style={{
                  margin: 0,
                  padding: '10px 12px',
                  listStyle: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  background: 'var(--ds-bg-sunken)',
                  borderRadius: 8,
                  border: '1px solid var(--ds-border)',
                }}
              >
                {peer.threatReasons.map((r) => (
                  <li
                    key={r}
                    className="ds-text-body-sm text-ds-secondary"
                    style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}
                  >
                    <span
                      style={{
                        width: 3,
                        height: 3,
                        borderRadius: '50%',
                        background: 'var(--ds-text-disabled)',
                        marginTop: 8,
                        flexShrink: 0,
                      }}
                    />
                    {r}
                  </li>
                ))}
              </ul>
            ) : (
              <p
                className="ds-text-body-sm text-ds-description"
                style={{
                  margin: 0,
                  padding: '10px 12px',
                  background: 'var(--ds-bg-sunken)',
                  borderRadius: 8,
                }}
              >
                这个地址没有触发任何异常信号，确认要封禁吗？
              </p>
            )}
          </div>

          {/* —— 有效期 —— */}
          <div>
            <label className="ds-text-caption text-ds-description" style={{ display: 'block', marginBottom: 7 }}>
              有效期
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TTL_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => setTtl(o.value)}
                  className={`ds-btn ds-btn-s ${ttl === o.value ? 'ds-btn-primary' : 'ds-btn-ghost'}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="ds-text-caption text-ds-description" style={{ margin: '7px 0 0' }}>
              有效期由 nftables 的 set timeout 控制，到点内核自动解封 —— 面板离线也照样生效。
            </p>
          </div>

          {/* —— 原因 —— */}
          <Field label="备注原因">
            <input
              className="ds-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="记录下为什么封它，方便以后回溯"
            />
          </Field>

          {/* —— 执行模式 —— */}
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              border: `1px solid ${enforce ? 'color-mix(in srgb, var(--color-danger) 30%, transparent)' : 'var(--ds-border)'}`,
              background: enforce
                ? 'color-mix(in srgb, var(--color-danger) 5%, transparent)'
                : 'var(--ds-bg-sunken)',
              transition: 'all 0.2s',
            }}
          >
            <Checkbox
              checked={enforce}
              onChange={setEnforce}
              tone="danger"
              label="在目标机器上真正执行（enforce）"
              hint="不勾选则只生成规则存档（dry-run），不会下发到机器。"
            />

            {enforce && (
              <div
                className="ds-fade-in"
                style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--ds-border)' }}
              >
                <Checkbox
                  checked={acknowledged}
                  onChange={setAcknowledged}
                  tone="danger"
                  label={`我确认下面这些命令会立刻在 ${nodeName} 上生效`}
                />
              </div>
            )}
          </div>

          {/* —— 预检结果 —— */}
          {checking && !check ? (
            <div className="ds-skeleton" style={{ height: 76 }} />
          ) : (
            check && (
              <>
                {blocked && (
                  <Callout tone="danger" icon={<IconAlert size={14} />} title="预检未通过，无法封禁">
                    <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                      {check.blockers.map((b) => (
                        <li key={b} className="ds-text-body-sm">
                          {b}
                        </li>
                      ))}
                    </ul>
                  </Callout>
                )}

                {check.warnings.length > 0 && !blocked && (
                  <Callout tone="warn" icon={<IconInfo size={14} />} title="执行前请注意">
                    <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                      {check.warnings.map((w) => (
                        <li key={w} className="ds-text-body-sm">
                          {w}
                        </li>
                      ))}
                    </ul>
                  </Callout>
                )}

                {check.commands.length > 0 && (
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        marginBottom: 7,
                      }}
                    >
                      <IconTerminal size={13} style={{ color: 'var(--ds-text-description)' }} />
                      <span className="ds-text-caption text-ds-description">
                        将在目标机器执行
                      </span>
                      <span style={{ flex: 1 }} />
                      <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={copyCommands}>
                        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                        {copied ? '已复制' : '复制'}
                      </button>
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        padding: '10px 12px',
                        background: 'var(--ds-bg-sunken)',
                        border: '1px solid var(--ds-border)',
                        borderRadius: 8,
                        overflowX: 'auto',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        lineHeight: 1.75,
                        color: 'var(--ds-text-secondary)',
                      }}
                    >
                      {check.commands.join('\n')}
                    </pre>
                  </div>
                )}
              </>
            )
          )}

          {error && (
            <Callout tone="danger" icon={<IconAlert size={14} />} title="操作失败">
              <span className="ds-text-body-sm">{error}</span>
            </Callout>
          )}
      </div>
    </Modal>
  );
}

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'danger' | 'warn';
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  const color = tone === 'danger' ? 'var(--color-danger)' : 'var(--color-warn)';
  return (
    <div
      style={{
        display: 'flex',
        gap: 9,
        padding: '10px 12px',
        borderRadius: 8,
        background: `color-mix(in srgb, ${color} 7%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
        color: 'var(--ds-text-secondary)',
      }}
    >
      <span style={{ color, marginTop: 1, flexShrink: 0 }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div className="ds-text-body-sm" style={{ fontWeight: 600, color }}>
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}
