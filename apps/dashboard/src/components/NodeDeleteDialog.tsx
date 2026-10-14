import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/live';
import { ago, count } from '../lib/format';
import type { NodeDeletionImpact } from '../lib/types';
import { IconCheck, IconCopy, IconTrash } from './icons';
import { Modal } from './Modal';
import { Alert, Checkbox, Field, Skeleton } from './ui';
import { TextInput } from './Input';

/**
 * 删除机器
 *
 * 弹窗的任务是让人在点下去之前看清三件事：
 *
 *   会失去什么 —— 流量账本、指标、归因，没有回收站；
 *   会留下什么 —— 机器防火墙里的封禁、authorized_keys 里面板装上去的公钥，
 *                 删完之后面板再也管不到它们；
 *   之后会怎样 —— 采集端不会因为面板删了机器就停下，它会一直被拒绝。
 *
 * 确认照 Cloudflare 删域名的做法：手打一遍标识。删错一台机器的代价，
 * 远大于多敲几个字母。
 */

const STOP_AGENT = 'systemctl disable --now sonar-agent';

interface Props {
  nodeId: string;
  nodeName: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function NodeDeleteDialog({ nodeId, nodeName, onClose, onDeleted }: Props) {
  const impact = useAsync(() => api.deletionImpact(nodeId), [nodeId]);
  const [typed, setTyped] = useState('');
  const [ackGrants, setAckGrants] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const d = impact.data;
  const needsAck = (d?.liveGrants.length ?? 0) > 0;
  const ready = Boolean(d) && typed.trim() === nodeId && (!needsAck || ackGrants) && !busy;

  /*
   * 等评估到了、输入框出现之后再聚焦，而且不滚动。
   *
   * 直接写 autoFocus 的话，浏览器会把弹窗内容滚到输入框那儿 —— 最要紧的
   * "这一步不可撤销"和"采集端还在上报"被顶出视野，人第一眼看到的反而是
   * 最底下的封禁明细。
   */
  const confirmRef = useRef<HTMLInputElement>(null);
  const loaded = Boolean(d);
  useEffect(() => {
    if (loaded) confirmRef.current?.focus({ preventScroll: true });
  }, [loaded]);

  // 删到一半关掉弹窗，人会以为没删成又去点一次
  const close = () => {
    if (!busy) onClose();
  };

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteNode(nodeId, { confirm: nodeId, acknowledgeGrants: needsAck && ackGrants });
      onDeleted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '删除失败');
      setBusy(false);
      // 评估可能已经过时（比如这期间有人新加了一条授权），重拉一次让弹窗跟上服务端
      impact.reload();
    }
  }

  return (
    <Modal
      title="删除机器"
      subtitle={`${nodeName}（${nodeId}）`}
      onClose={close}
      width={540}
      icon={<IconTrash size={16} />}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="ds-btn ds-btn-ghost" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="ds-btn ds-btn-danger" onClick={() => void submit()} disabled={!ready}>
            {busy ? '删除中…' : '删除机器'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {impact.loading && !d ? (
          <>
            <Skeleton height={104} radius={8} />
            <Skeleton height={58} radius={8} />
            <Skeleton height={34} />
          </>
        ) : !d ? (
          <Alert title="没拿到删除前的评估">{impact.error ?? '请稍后再试'}</Alert>
        ) : (
          <>
            <HistoryNotice impact={d} />
            {d.source === 'agent' && <AgentNotice impact={d} />}
            {d.activeBlocks.length > 0 && <BlocksNotice impact={d} />}
            {needsAck && <GrantsNotice impact={d} ack={ackGrants} onAck={setAckGrants} />}

            <Field label={`输入 ${nodeId} 以确认`}>
              <TextInput
                ref={confirmRef}
                value={typed}
                placeholder={nodeId}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                aria-label="输入机器标识以确认删除"
              />
            </Field>

            {err && <Alert title="删除失败">{err}</Alert>}
          </>
        )}
      </div>
    </Modal>
  );
}

/** 会随机器一起清掉的历史 */
function HistoryNotice({ impact }: { impact: NodeDeletionImpact }) {
  const h = impact.history;
  const items = [
    h.trafficDays > 0 &&
      `流量账本 ${count(h.trafficDays)} 天${h.firstTrafficDay ? `（自 ${h.firstTrafficDay} 起）` : ''}`,
    h.metricSamples > 0 && `指标采样 ${count(h.metricSamples)} 条`,
    h.attributionRows > 0 && `服务与对端归因 ${count(h.attributionRows)} 行`,
    h.trafficRules > 0 && `${h.trafficRules} 条只针对这台机器的流量阈值`,
    h.pendingCommands > 0 && `${h.pendingCommands} 条还没执行完的指令，删掉就不会再下发`,
  ].filter((x): x is string => Boolean(x));

  return (
    <Alert tone="danger" title="这一步不可撤销">
      {items.length > 0 ? (
        <>
          下面这些会随机器一起清掉，没有回收站：
          <ul>
            {items.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      ) : (
        <>它还没有攒下任何历史数据。</>
      )}
      事件流和审计日志会保留 —— 这台机器发生过什么、是谁删的，之后仍然查得到。
    </Alert>
  );
}

/**
 * 采集端会怎样。
 *
 * 删了机器却忘了停 agent 很常见，而那台机器可能还在按小时计费。
 * 还在报的给醒目的警告和一键复制的命令；已经不报的也要提一句 ——
 * 它也许只是断网了，恢复之后会开始被拒绝。
 */
function AgentNotice({ impact }: { impact: NodeDeletionImpact }) {
  const reenroll = '之后想用同一个标识重新接入，在「接入新机器」里允许它回来即可。';
  if (impact.agentActive) {
    return (
      <Alert tone="warn" title="它的采集端还在上报">
        删掉之后它不会自己停，每一次上报都会被拒绝。不再需要监控的话，到那台机器上执行：
        <StopCommand />
        {reenroll}
      </Alert>
    );
  }
  return (
    <Alert tone="info">
      {impact.lastReport > 0
        ? `采集端最后一次上报在 ${ago(impact.lastReport)}。`
        : '采集端还没有上报过。'}
      那台机器如果还在，记得停掉采集端（<code>{STOP_AGENT}</code>），否则它恢复联网后会一直被拒绝。
      {reenroll}
    </Alert>
  );
}

function StopCommand() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
      <pre className="ds-enroll-cmd" style={{ flex: 1, padding: '7px 12px' }}>
        {STOP_AGENT}
      </pre>
      <button
        className="ds-btn ds-btn-ghost ds-btn-s"
        onClick={() => void navigator.clipboard.writeText(STOP_AGENT).then(() => setCopied(true))}
      >
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

function expiryText(ts: number): string {
  return ts > 0 ? `${new Date(ts).toLocaleDateString('zh-CN')} 到期` : '永久';
}

/** 留在机器防火墙里的封禁。没有 block:view 的人只看得到条数 */
function BlocksNotice({ impact }: { impact: NodeDeletionImpact }) {
  const { can } = useAuth();
  const blocks = impact.activeBlocks;
  const forever = blocks.filter((b) => b.expiresAt === 0).length;
  return (
    <Alert tone="warn" title={`${blocks.length} 条封禁会留在机器的防火墙里`}>
      删掉之后面板再也解不开它们
      {forever > 0 ? `：带时限的到点会自动失效，永久的 ${forever} 条只能到机器上手动清` : '，到点会自动失效'}。
      机器还在、又想现在就放开的话，先在本页「安全」里解除。
      {can('block:view') && (
        <ul>
          {blocks.map((b) => (
            <li key={b.id}>
              <code>{b.target}</code> · {expiryText(b.expiresAt)}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

/**
 * 可能还留在机器上的公钥。
 *
 * 这是整个弹窗里唯一需要额外勾选的一项：其余的残留要么会自己过期、要么无害，
 * 而一把没人管的公钥是一扇没人记得的门。服务端在没勾选时会拒绝删除，
 * 这里的勾选框只是把那道闸门提前摆到人眼前。
 */
function GrantsNotice({
  impact,
  ack,
  onAck,
}: {
  impact: NodeDeletionImpact;
  ack: boolean;
  onAck: (v: boolean) => void;
}) {
  const { can } = useAuth();
  const grants = impact.liveGrants;
  return (
    <Alert tone="danger" title={`${grants.length} 把面板装上去的公钥可能还在机器上`}>
      删掉之后面板不再对账，它们会变成 authorized_keys 里来历不明的钥匙。
      机器还在的话，先去 <Link to="/ssh/grants">SSH 接入 · 授权</Link> 撤销；
      机器已经不在了，勾选下面这项再删。指纹和归属会完整写进审计日志。
      {can('ssh:audit') && (
        <ul>
          {grants.map((g) => (
            <li key={g.id}>
              {g.ownerName || '未知用户'}「{g.keyLabel}」→ <code>{g.remoteUser}</code>
              {g.state === 'active' ? ' · 已在机器上确认' : ' · 已下发，尚未在机器上确认'}
              {g.expiresAt > 0 && ` · ${expiryText(g.expiresAt)}`}
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: 10 }}>
        <Checkbox
          checked={ack}
          onChange={onAck}
          tone="danger"
          label="我知道这些公钥会留在机器上（或机器已经不在了）"
        />
      </div>
    </Alert>
  );
}
