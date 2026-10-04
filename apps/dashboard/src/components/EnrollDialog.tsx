import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/live';
import { IconCheck, IconCopy, IconServer } from './icons';
import { Modal } from './Modal';
import { Alert, Checkbox, Field, Skeleton } from './ui';
import { TextInput } from './Input';

/**
 * 接入一台新机器。
 *
 * 目标是把"加服务器"压缩成一次复制粘贴：面板地址和 token 都由服务端填好，
 * 人只需要起个名字。之前这一步要自己去翻 panel.env 找 token、自己拼参数，
 * 每加一台都得重来一遍。
 */

interface Props {
  onClose: () => void;
}

export function EnrollDialog({ onClose }: Props) {
  const info = useAsync(() => api.enrollInfo(), []);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [enforce, setEnforce] = useState(false);
  const [ensureCt, setEnsureCt] = useState(true);
  const [copied, setCopied] = useState(false);

  const taken = useMemo(
    () => new Set(info.data?.existingIds ?? []),
    [info.data],
  );

  const trimmedId = id.trim();
  const idError = !trimmedId
    ? ''
    : !/^[A-Za-z0-9._-]+$/.test(trimmedId)
      ? '只能用字母、数字、点、下划线、连字符'
      : taken.has(trimmedId)
        ? '这个标识已经被占用了'
        : '';

  const command = useMemo(() => {
    const d = info.data;
    if (!d?.ready || !d.panelUrl) return '';
    const parts = [
      `curl -fsSL ${d.panelUrl}/install-agent.sh | sudo bash -s --`,
      `  --panel ${d.panelUrl}`,
      `  --token ${d.token}`,
    ];
    if (trimmedId) parts.push(`  --id ${trimmedId}`);
    if (name.trim()) parts.push(`  --name ${JSON.stringify(name.trim())}`);
    // 默认全自动，只有明确不要时才传参数关掉
    if (!ensureCt) parts.push('  --no-conntrack');
    if (enforce) parts.push('  --enforce');
    return parts.join(' \\\n');
  }, [info.data, trimmedId, name, enforce, ensureCt]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  function copy() {
    if (!command) return;
    void navigator.clipboard.writeText(command).then(() => setCopied(true));
  }

  return (
    <Modal
      title="接入新机器"
      subtitle="在目标机器上执行下面这条命令即可"
      onClose={onClose}
      width={620}
      icon={<IconServer size={16} />}
      footer={
        <>
          <span className="ds-text-caption text-ds-description" style={{ flex: 1 }}>
            装好后几秒内就会出现在概览里
          </span>
          <button className="ds-btn ds-btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button className="ds-btn ds-btn-primary" onClick={copy} disabled={!command}>
            {copied ? '已复制' : '复制命令'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {info.loading && !info.data ? (
          <>
            <Skeleton height={34} />
            <Skeleton height={92} radius={8} />
          </>
        ) : !info.data?.ready ? (
          <Alert tone="warn" title="上报通道还没启用">
            服务端没有配置 <code>SONAR_AGENT_TOKEN</code>，采集端无法上报。
            在面板所在机器上编辑 <code>/opt/sonar/server/data/panel.env</code> 填好之后重启服务。
          </Alert>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Field
                label="机器标识"
                grow
                error={idError}
                hint="唯一，之后不可更改。留空则用目标机器的主机名"
              >
                <TextInput
                  placeholder="hkg-edge-01"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  autoFocus
                />
              </Field>
              <Field label="显示名称" grow hint="面板上展示的名字，可留空">
                <TextInput
                  placeholder="香港 · 边缘节点"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </div>

            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 7,
                }}
              >
                <span className="ds-text-caption text-ds-description">在目标机器上执行</span>
                <span style={{ flex: 1 }} />
                <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={copy}>
                  {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <pre className="ds-enroll-cmd">{command}</pre>
              {/* token 就在这条命令里，得让人意识到它不能随手贴到公开的地方 */}
              <p className="ds-text-caption text-ds-description" style={{ margin: '7px 0 0' }}>
                这条命令里含上报凭据，别贴到公开的地方。
              </p>
            </div>

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
                label="允许这台机器真正执行封禁"
                hint="不勾选时，面板下发的封禁指令只会打印不会改防火墙。建议先不勾，跑通流程后再说。"
              />
            </div>

            <div
              style={{
                padding: 12,
                borderRadius: 10,
                border: '1px solid var(--ds-border)',
                background: 'var(--ds-bg-sunken)',
              }}
            >
              <Checkbox
                checked={ensureCt}
                onChange={setEnsureCt}
                label="自动补齐流量归因的前提"
                hint={
                  <>
                    默认开。装的时候会一并处理好内核侧的两个前提并做持久化：
                    开启 conntrack 字节计数、以及在完全没有防火墙规则的机器上补一条
                    <b>只计数、不拦截</b>的规则（policy accept，独立 table，不碰原有配置）。
                    不做这些的话，「对端 IP 流量」和「流量都被谁吃了」会一直是空的。
                    不想让脚本碰内核配置就取消勾选，基础指标不受影响。
                  </>
                }
              />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
