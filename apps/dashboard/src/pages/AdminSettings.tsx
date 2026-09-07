import { useEffect, useMemo, useState } from 'react';

import { api, type PanelSettings, type RatesPayload, type SettingsBundle } from '../lib/api';
import { useAsync, useLive } from '../lib/live';
import { useAuth } from '../lib/auth';
import { reloadSettings } from '../lib/settings';
import { CURRENCY_META, normalizeCurrency, type Currency } from '../lib/currency';
import { ago, bytes } from '../lib/format';
import { Alert, Chip, Field, FieldRow, SectionCard, Segmented, Skeleton } from '../components/ui';
import { Select } from '../components/Select';
import { Tooltip } from '../components/Tooltip';
import { IconInfo, IconRefresh } from '../components/icons';

/**
 * 通用设置
 *
 * 收的是"同一份数据，换个人看就该换个口径"的那些东西。判断一项该不该进来的标准
 * 只有一条：**它在代码里原本是个写死的字面量，而不同的人需要不同的值。**
 *
 * 按这个标准，"卡片圆角多大"不进来（那是设计决定，不是用户口径），
 * "流量按 1024 还是 1000 进制"要进来（服务商账单和 Linux 工具链本来就两套算法，
 * 面板替谁做主都是错的）。
 */
export function AdminSettings() {
  const { can } = useAuth();
  const { nodes } = useLive();
  const bundle = useAsync(() => api.settings(), []);
  const [draft, setDraft] = useState<PanelSettings | null>(null);
  const [rates, setRates] = useState<RatesPayload | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const editable = can('settings:manage');
  const loaded = bundle.data;

  // 服务端的值到了就铺进草稿。之后的编辑都在草稿上，直到点保存 ——
  // 每改一个字段就发一次请求，会让"改了三项发现方向错了"变成不可回退的操作
  useEffect(() => {
    if (loaded) {
      setDraft(loaded.settings);
      setRates(loaded.rates);
    }
  }, [loaded]);

  const dirty = useMemo(
    () => Boolean(draft && loaded && JSON.stringify(draft) !== JSON.stringify(loaded.settings)),
    [draft, loaded],
  );

  /** 当前有机器在用的币种。汇率表默认只显示这些，其余的没必要占地方 */
  const usedCurrencies = useMemo(() => {
    const set = new Set<Currency>();
    for (const n of nodes) if (n.price > 0) set.add(normalizeCurrency(n.currency));
    return set;
  }, [nodes]);

  if (bundle.loading && !loaded) return <Skeleton height={420} />;
  if (bundle.error) {
    return <Alert title="读取设置失败">{bundle.error}</Alert>;
  }
  if (!draft || !loaded || !rates) return <Skeleton height={420} />;

  const set = <K extends keyof PanelSettings>(key: K, value: PanelSettings[K]) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateSettings(draft);
      setDraft(res.settings);
      setRates(res.rates);
      // 展示口径立刻在本页生效 —— 下面的对照示例就是用它渲染的
      await reloadSettings();
      bundle.reload();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16, paddingBottom: dirty ? 64 : 0 }}>
      {!editable && (
        <Alert tone="info" title="只读">
          你可以查看这些口径，但没有修改权限。面板上所有数字都按这里的设置渲染，
          知道口径才能正确解读它们。
        </Alert>
      )}
      {error && <Alert title="保存失败">{error}</Alert>}

      <CostSection
        draft={draft}
        set={set}
        editable={editable}
        rates={rates}
        onRates={setRates}
        usedCurrencies={usedCurrencies}
        options={loaded.options}
      />
      <TrafficSection draft={draft} set={set} editable={editable} />
      <TimeSection draft={draft} set={set} editable={editable} options={loaded.options} />
      <ThresholdSection draft={draft} set={set} editable={editable} defaults={loaded.defaults} />
      <RetentionSection draft={draft} set={set} editable={editable} />
      <PanelSection draft={draft} set={set} editable={editable} />

      {editable && dirty && <SaveBar saving={saving} onSave={() => void save()} onReset={() => setDraft(loaded.settings)} />}
      {editable && !dirty && saved && (
        <p className="ds-text-caption" style={{ margin: 0, color: 'var(--color-ok)' }}>
          已保存，新口径已推送给所有在线的人。
        </p>
      )}
    </div>
  );
}

type Setter = <K extends keyof PanelSettings>(key: K, value: PanelSettings[K]) => void;

interface SectionProps {
  draft: PanelSettings;
  set: Setter;
  editable: boolean;
}

// ————————————————————————————————————————————————————————
// 成本与货币
// ————————————————————————————————————————————————————————

function CostSection({
  draft,
  set,
  editable,
  rates,
  onRates,
  usedCurrencies,
  options,
}: SectionProps & {
  rates: RatesPayload;
  onRates: (r: RatesPayload) => void;
  usedCurrencies: Set<Currency>;
  options: SettingsBundle['options'];
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const display = normalizeCurrency(draft.displayCurrency);

  /*
   * 汇率表里列哪些币种。
   *
   * 默认只列"当前真有机器在用的" —— 一个三台机器全是美元的人，看到十二行
   * 汇率输入框只会觉得这页很复杂，而其中十一行对他毫无意义。
   * 展示货币始终列出，因为它是换算的落点。
   */
  const visible = showAll
    ? options.currencies.map((c) => c.value)
    : options.currencies
        .map((c) => c.value)
        .filter((c) => usedCurrencies.has(c) || c === display);

  // 全是同一种货币时根本不发生换算，整张汇率表都不必显示
  const needsConversion = [...usedCurrencies].some((c) => c !== display);

  async function refresh() {
    setRefreshing(true);
    try {
      onRates(await api.refreshRates());
    } catch {
      // 失败原因已经写在 rates.lastError 里，下面那行会显示出来
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <SectionCard
      title="成本与货币"
      subtitle="月度成本怎么折算、折成哪种货币"
      actions={<Chip>{CURRENCY_META[display].label}</Chip>}
    >
      <FieldRow>
        <Field
          label="展示货币"
          width={200}
          hint="概览页的「月度成本」折算到这种货币"
        >
          <Select
            value={display}
            onChange={(v) => set('displayCurrency', v as Currency)}
            disabled={!editable}
            ariaLabel="展示货币"
            options={options.currencies.map((c) => ({
              value: c.value,
              label: `${c.label} ${c.symbol}`,
              hint: c.value,
            }))}
          />
        </Field>

        <Field
          label="已过期的机器"
          width={220}
          hint="到期就不再扣费了，继续算进去会让人以为还在为一台停掉的机器付钱"
        >
          <Segmented
            value={draft.costIncludeExpired ? 'include' : 'exclude'}
            onChange={(v) => editable && set('costIncludeExpired', v === 'include')}
            options={[
              { value: 'exclude', label: '不计入' },
              { value: 'include', label: '计入' },
            ]}
          />
        </Field>
      </FieldRow>

      {/* —— 汇率 —— */}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
          <span className="ds-text-body-sm" style={{ fontWeight: 500 }}>
            汇率
          </span>
          <Chip color={rateTone(rates)}>{rateStatusText(rates)}</Chip>
          {editable && (
            <button
              className="ds-btn ds-btn-ghost ds-btn-s"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <IconRefresh size={11} />
              {refreshing ? '拉取中…' : '立即更新'}
            </button>
          )}
        </div>

        <p className="ds-text-caption text-ds-description" style={{ margin: '0 0 12px', lineHeight: 1.7 }}>
          {rates.lastError
            ? `最近一次拉取失败：${rates.lastError}`
            : rates.fetchedAt > 0
              ? `数据来自 ${rates.source}，更新于 ${ago(rates.fetchedAt)}。`
              : '尚未成功拉取过，当前用的是内置参考值。'}
          {' 手填的值优先于自动拉取 —— 信用卡入账汇率和实时中间价本来就有出入，认真对账时以你账单上的为准。'}
        </p>

        <Field
          label="自动更新"
          hint="每天向公开汇率接口拉取一次。请求不带任何参数，不会把面板信息带出去；内网部署可以关掉"
        >
          <Segmented
            value={draft.autoRefreshRates ? 'on' : 'off'}
            onChange={(v) => editable && set('autoRefreshRates', v === 'on')}
            options={[
              { value: 'on', label: '开启' },
              { value: 'off', label: '关闭' },
            ]}
          />
        </Field>

        {!needsConversion ? (
          <p className="ds-text-caption text-ds-description" style={{ margin: '14px 0 0', lineHeight: 1.7 }}>
            <IconInfo size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
            当前所有机器都以 {CURRENCY_META[display].label} 计价，不发生换算，汇率对成本汇总没有影响。
            {!showAll && (
              <button
                className="ds-btn ds-btn-ghost ds-btn-s"
                style={{ marginLeft: 6 }}
                onClick={() => setShowAll(true)}
              >
                仍要查看汇率表
              </button>
            )}
          </p>
        ) : null}

        {(needsConversion || showAll) && (
          <div style={{ marginTop: 14 }}>
            <RateTable
              codes={visible}
              rates={rates}
              overrides={draft.rateOverrides}
              display={display}
              editable={editable}
              usedCurrencies={usedCurrencies}
              onChange={(next) => set('rateOverrides', next)}
            />
            <button
              className="ds-btn ds-btn-ghost ds-btn-s"
              style={{ marginTop: 10 }}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? '只看在用的币种' : `显示全部 ${options.currencies.length} 种货币`}
            </button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function rateTone(r: RatesPayload): string | undefined {
  if (r.usingFallback) return 'var(--color-warn)';
  if (r.stale) return 'var(--color-warn)';
  return 'var(--color-ok)';
}

function rateStatusText(r: RatesPayload): string {
  if (r.usingFallback) return '内置参考值';
  if (r.stale) return '已过期';
  return '最新';
}

/**
 * 汇率表。
 *
 * 每一行给的是"1 USD = N"，而不是"1 该币种 = N 美元"。统一用一个基准
 * 才能任意两币互转；换成后者的话，人填的数字和面板内部存的要来回取倒数，
 * 而取倒数带来的舍入误差恰好会在成本汇总里被放大。
 */
function RateTable({
  codes,
  rates,
  overrides,
  display,
  editable,
  usedCurrencies,
  onChange,
}: {
  codes: Currency[];
  rates: RatesPayload;
  overrides: Partial<Record<Currency, number>>;
  display: Currency;
  editable: boolean;
  usedCurrencies: Set<Currency>;
  onChange: (next: Partial<Record<Currency, number>>) => void;
}) {
  function setOverride(code: Currency, raw: string) {
    const next = { ...overrides };
    const n = Number(raw);
    // 清空输入框 = 撤销覆盖，回到自动拉取的值。这是唯一的撤销入口，
    // 不能因为"空字符串转成 0"就把它当成一个合法汇率存进去
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) delete next[code];
    else next[code] = n;
    onChange(next);
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
        <thead>
          <tr className="ds-text-caption text-ds-description">
            {['货币', '1 USD =', '手动覆盖', `折算示例`].map((h, i) => (
              <th
                key={h}
                style={{
                  textAlign: i === 0 ? 'left' : 'right',
                  fontWeight: 400,
                  padding: '8px 10px',
                  borderBottom: '1px solid var(--ds-border)',
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {codes.map((code) => {
            const meta = CURRENCY_META[code];
            const effective = rates.rates[code] ?? 0;
            const override = overrides[code];
            const inUse = usedCurrencies.has(code);
            // 一台 10 单位该币种的机器折成展示货币是多少 —— 抽象的汇率数字
            // 配一个具体例子，才好判断填对没有
            const sample =
              effective > 0 && rates.rates[display]
                ? (10 / effective) * (rates.rates[display] ?? 1)
                : 0;
            return (
              <tr
                key={code}
                style={{
                  borderBottom: '1px solid var(--ds-border)',
                  // 没有机器在用的币种压暗，视线直接落到有意义的那几行上
                  opacity: inUse || code === display ? 1 : 0.5,
                }}
              >
                <td className="ds-text-body-sm" style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                  {meta.label}
                  <span className="ds-text-caption text-ds-description"> {code}</span>
                  {inUse && (
                    <Tooltip content="有机器以这种货币计价">
                      <span style={{ marginLeft: 5 }}>
                        <Chip color="var(--color-brand)">在用</Chip>
                      </span>
                    </Tooltip>
                  )}
                </td>
                <td
                  className="ds-text-body-sm tnum text-ds-secondary"
                  style={{ padding: '7px 10px', textAlign: 'right' }}
                >
                  {effective > 0 ? effective.toFixed(4) : '—'}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'right' }}>
                  <input
                    className="ds-input tnum"
                    style={{ width: 110, textAlign: 'right' }}
                    inputMode="decimal"
                    disabled={!editable || code === 'USD'}
                    // USD 是基准，永远是 1，给个输入框只会让人以为能改
                    placeholder={code === 'USD' ? '基准' : '自动'}
                    value={override != null ? String(override) : ''}
                    onChange={(e) => setOverride(code, e.target.value)}
                    aria-label={`${meta.label}汇率覆盖`}
                  />
                </td>
                <td
                  className="ds-text-caption tnum text-ds-description"
                  style={{ padding: '7px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}
                >
                  {code === display
                    ? '展示货币'
                    : sample > 0
                      ? `${meta.symbol}10 ≈ ${CURRENCY_META[display].symbol}${sample.toFixed(2)}`
                      : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ————————————————————————————————————————————————————————
// 流量口径
// ————————————————————————————————————————————————————————

/** 服务商标称的 2 TB，按 1000 进制就是这么多字节。 */
const VENDOR_2TB = 2_000_000_000_000;

function TrafficSection({ draft, set, editable }: SectionProps) {
  /*
   * 对照示例。
   *
   * 不用 bytes() 渲染 —— 那个函数跟着已保存的设置走，而这里要展示的是
   * "如果按草稿里这个进制会显示成什么"。两者在保存前是不一样的，
   * 用 bytes() 会让人改了选项却看不到任何变化。
   */
  const asBinary = (VENDOR_2TB / 1024 ** 4).toFixed(2);
  const asDecimal = (VENDOR_2TB / 1000 ** 4).toFixed(2);
  const binaryLabel = draft.binaryUnitLabels ? 'TiB' : 'TB';

  return (
    <SectionCard title="流量口径" subtitle="配额、账本、告警都按这里的算法计数">
      <FieldRow>
        <Field
          label="字节进制"
          width={220}
          hint="1024 是 Linux 工具的算法，1000 是服务商账单的算法"
        >
          <Segmented
            value={String(draft.byteBase)}
            onChange={(v) => editable && set('byteBase', v === '1000' ? 1000 : 1024)}
            options={[
              { value: '1024', label: '1024' },
              { value: '1000', label: '1000' },
            ]}
          />
        </Field>

        {draft.byteBase === 1024 && (
          <Field label="单位写法" width={200} hint="1024 进制下，严格写法是 GiB / TiB">
            <Segmented
              value={draft.binaryUnitLabels ? 'binary' : 'decimal'}
              onChange={(v) => editable && set('binaryUnitLabels', v === 'binary')}
              options={[
                { value: 'decimal', label: 'GB / TB' },
                { value: 'binary', label: 'GiB / TiB' },
              ]}
            />
          </Field>
        )}

        <Field
          label="计费方向"
          width={240}
          hint="很多机房只计出站，按双向算会让一台正常同步镜像的机器显示成随时要超额"
        >
          <Segmented
            value={draft.trafficDirection}
            onChange={(v) => editable && set('trafficDirection', v as PanelSettings['trafficDirection'])}
            options={[
              { value: 'both', label: '双向' },
              { value: 'tx', label: '仅出站' },
              { value: 'rx', label: '仅入站' },
            ]}
          />
        </Field>
      </FieldRow>

      {/*
        进制这一项最容易被当成无关紧要的显示偏好。给一个具体到数字的对照，
        它就变成了一件有后果的事：同一台机器同一份流量，两种算法差 10%，
        足以让人以为自己快超额而去关掉一个正常的服务。
      */}
      <div
        className="ds-text-caption"
        style={{
          marginTop: 16,
          padding: '11px 13px',
          borderRadius: 8,
          background: 'var(--ds-bg-sunken)',
          lineHeight: 1.8,
          color: 'var(--ds-text-secondary)',
        }}
      >
        <IconInfo size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
        服务商标称的「2 TB 流量」通常指 2,000,000,000,000 字节。
        <br />
        按 <b>1024</b> 进制显示为 <b className="tnum">{asBinary} {binaryLabel}</b>
        {'，'}按 <b>1000</b> 进制显示为 <b className="tnum">{asDecimal} TB</b>。
        <br />
        选 1024 时，一台标称 2 TB 的机器在面板上永远到不了「2 TB」，
        用到 <span className="tnum">{asBinary}</span> 就已经是满额了。
      </div>
    </SectionCard>
  );
}

// ————————————————————————————————————————————————————————
// 时区
// ————————————————————————————————————————————————————————

function TimeSection({
  draft,
  set,
  editable,
  options,
}: SectionProps & { options: SettingsBundle['options'] }) {
  const [custom, setCustom] = useState(
    () => !options.timezones.some((t) => t.value === draft.timezone),
  );

  // 面板时区下的此刻。抽象的时区名配一个具体时间，才好确认选对没有
  const nowThere = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: draft.timezone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date());
    } catch {
      return '时区无效';
    }
  }, [draft.timezone]);

  return (
    <SectionCard title="时区" subtitle="决定「今天」和「本流量周期」从几点开始">
      <FieldRow>
        <Field label="面板时区" width={260} hint={`当前该时区时间：${nowThere}`}>
          {custom ? (
            <input
              className="ds-input"
              value={draft.timezone}
              disabled={!editable}
              placeholder="Asia/Shanghai"
              onChange={(e) => set('timezone', e.target.value)}
              aria-label="时区"
            />
          ) : (
            <Select
              value={draft.timezone}
              onChange={(v) => set('timezone', v)}
              disabled={!editable}
              ariaLabel="面板时区"
              options={options.timezones}
            />
          )}
        </Field>

        <Field label=" " width={140} hint="IANA 名称，如 Europe/Oslo">
          <button
            className="ds-btn ds-btn-ghost"
            disabled={!editable}
            onClick={() => setCustom((v) => !v)}
          >
            {custom ? '从列表选' : '手动输入'}
          </button>
        </Field>
      </FieldRow>

      <p className="ds-text-caption text-ds-description" style={{ margin: '14px 0 0', lineHeight: 1.8 }}>
        这一项只管<b>业务时间</b>：流量按哪一天归档、流量周期从哪天切。
        界面上的「11 小时前」「进入于 14:23」仍按你自己电脑的时区显示 ——
        一台美国机房的机器，账单该按机房时区算，但你在北京看到的时刻理应是北京时间。
      </p>
      <p className="ds-text-caption" style={{ margin: '8px 0 0', lineHeight: 1.8, color: 'var(--color-warn)' }}>
        改时区不会重算历史：已经归档的日流量仍按旧时区归属，换时区当天那一格会有
        几个小时的偏差，之后恢复正常。重算需要逐条采样的原始时间戳，而那些按保留策略早已清掉。
      </p>
    </SectionCard>
  );
}

// ————————————————————————————————————————————————————————
// 状态与告警
// ————————————————————————————————————————————————————————

function ThresholdSection({
  draft,
  set,
  editable,
  defaults,
}: SectionProps & { defaults: PanelSettings }) {
  return (
    <SectionCard
      title="状态与告警"
      subtitle="机器什么时候算离线、什么时候标成告警、什么时候提醒续费"
    >
      <FieldRow>
        <NumberField
          label="离线判定"
          value={draft.offlineAfterSeconds}
          onChange={(v) => set('offlineAfterSeconds', v)}
          suffix="秒没上报"
          min={5}
          max={3600}
          editable={editable}
          defaultValue={defaults.offlineAfterSeconds}
          hint="agent 默认 3 秒一报，30 秒留了十次重试的余量"
        />
        <NumberField
          label="CPU 告警线"
          value={draft.cpuWarnPercent}
          onChange={(v) => set('cpuWarnPercent', v)}
          suffix="%"
          min={10}
          max={99}
          editable={editable}
          defaultValue={defaults.cpuWarnPercent}
        />
        <NumberField
          label="内存告警线"
          value={draft.memWarnPercent}
          onChange={(v) => set('memWarnPercent', v)}
          suffix="%"
          min={10}
          max={99}
          editable={editable}
          defaultValue={defaults.memWarnPercent}
        />
        <NumberField
          label="磁盘告警线"
          value={draft.diskWarnPercent}
          onChange={(v) => set('diskWarnPercent', v)}
          suffix="%"
          min={10}
          max={99}
          editable={editable}
          defaultValue={defaults.diskWarnPercent}
        />
        <NumberField
          label="负载告警线"
          value={draft.loadWarnRatio}
          onChange={(v) => set('loadWarnRatio', v)}
          suffix="× 核心数"
          min={0.5}
          max={20}
          step={0.1}
          editable={editable}
          defaultValue={defaults.loadWarnRatio}
          hint="构建机常年跑在三四倍，按 2.5 判会让它永远挂着告警"
        />
      </FieldRow>

      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--ds-border)' }}>
        <FieldRow>
          <NumberField
            label="到期提醒"
            value={draft.expiryWarnDays}
            onChange={(v) => set('expiryWarnDays', v)}
            suffix="天前"
            min={1}
            max={365}
            editable={editable}
            defaultValue={defaults.expiryWarnDays}
            hint="概览页和汇总接口现在共用这一个值"
          />
          <NumberField
            label="配额提醒"
            value={draft.quotaWarnPercent}
            onChange={(v) => set('quotaWarnPercent', v)}
            suffix="% 时"
            min={10}
            max={100}
            editable={editable}
            defaultValue={defaults.quotaWarnPercent}
            hint="周期流量用到配额的这个比例就标成接近配额"
          />
        </FieldRow>
      </div>
    </SectionCard>
  );
}

// ————————————————————————————————————————————————————————
// 数据保留
// ————————————————————————————————————————————————————————

function RetentionSection({ draft, set, editable }: SectionProps) {
  return (
    <SectionCard title="数据保留" subtitle="超过期限的记录会被定时清掉">
      <FieldRow>
        <NumberField
          label="高频指标"
          value={draft.metricRetentionHours}
          onChange={(v) => set('metricRetentionHours', v)}
          suffix="小时"
          min={2}
          max={720}
          editable={editable}
          hint="每台机器每几秒一条，是库里最大的一张表。详情页最长看 24 小时曲线"
        />
        <NumberField
          label="审计日志"
          value={draft.auditRetentionDays}
          onChange={(v) => set('auditRetentionDays', v)}
          suffix="天"
          min={0}
          max={3650}
          editable={editable}
          hint="0 表示永久保留。每次浏览都会落一行，常看的面板一年能攒几十万条"
        />
        <NumberField
          label="流量归因明细"
          value={draft.trafficRetentionDays}
          onChange={(v) => set('trafficRetentionDays', v)}
          suffix="天"
          min={0}
          max={3650}
          editable={editable}
          hint="0 表示永久保留。指按服务、按对端拆分的那两张表；日流量总账不受影响，一直留着"
        />
      </FieldRow>

      <p className="ds-text-caption" style={{ margin: '14px 0 0', color: 'var(--color-warn)', lineHeight: 1.7 }}>
        调小之后，超出新期限的记录会在下一次清理（每分钟一轮）时被真的删掉，无法恢复。
      </p>
    </SectionCard>
  );
}

// ————————————————————————————————————————————————————————
// 面板身份
// ————————————————————————————————————————————————————————

function PanelSection({ draft, set, editable }: SectionProps) {
  return (
    <SectionCard title="面板" subtitle="顶栏和浏览器标签上显示的名字">
      <FieldRow>
        <Field label="名称" width={220}>
          <input
            className="ds-input"
            value={draft.panelName}
            disabled={!editable}
            maxLength={30}
            onChange={(e) => set('panelName', e.target.value)}
            aria-label="面板名称"
          />
        </Field>
        <Field label="副标题" width={240} hint="留空则不显示那行小字">
          <input
            className="ds-input"
            value={draft.panelTagline}
            disabled={!editable}
            maxLength={40}
            onChange={(e) => set('panelTagline', e.target.value)}
            aria-label="副标题"
          />
        </Field>
      </FieldRow>
    </SectionCard>
  );
}

// ————————————————————————————————————————————————————————
// 通用件
// ————————————————————————————————————————————————————————

/**
 * 数字输入。
 *
 * 用受控的字符串而不是直接绑 number：绑 number 时，删到只剩空串会被
 * Number('') 转成 0，光标一闪跳成"0"，再想输 30 就变成了 "030"。
 * 失焦时才收敛到合法范围 —— 输入过程中越界是正常的（要输 100 必然先经过 1）。
 */
function NumberField({
  label,
  value,
  onChange,
  suffix,
  min,
  max,
  step = 1,
  editable,
  hint,
  defaultValue,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  min: number;
  max: number;
  step?: number;
  editable: boolean;
  hint?: string;
  defaultValue?: number;
}) {
  const [text, setText] = useState(String(value));

  // 外部值变了（读到服务端数据、点了重置）要跟上，但不能覆盖正在输入的内容
  useEffect(() => {
    setText((t) => (Number(t) === value ? t : String(value)));
  }, [value]);

  const changed = defaultValue !== undefined && value !== defaultValue;

  return (
    <Field
      label={label}
      width={190}
      hint={
        hint ? (
          <>
            {hint}
            {changed && <span style={{ color: 'var(--color-brand)' }}> · 已改（默认 {defaultValue}）</span>}
          </>
        ) : changed ? (
          <span style={{ color: 'var(--color-brand)' }}>已改（默认 {defaultValue}）</span>
        ) : undefined
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          className="ds-input tnum"
          style={{ width: suffix ? 78 : undefined }}
          inputMode="decimal"
          disabled={!editable}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (Number.isFinite(n) && e.target.value.trim()) onChange(n);
          }}
          onBlur={() => {
            const n = Number(text);
            const safe = !Number.isFinite(n) ? value : Math.min(max, Math.max(min, n));
            const rounded = step < 1 ? Math.round(safe * 10) / 10 : Math.round(safe);
            setText(String(rounded));
            onChange(rounded);
          }}
          aria-label={label}
        />
        {suffix && (
          <span className="ds-text-caption text-ds-description" style={{ whiteSpace: 'nowrap' }}>
            {suffix}
          </span>
        )}
      </div>
    </Field>
  );
}

/**
 * 保存条。
 *
 * 固定在视口底部而不是跟在最后一节后面：这一页有六个分区，改的很可能是
 * 第二节里的某一项，改完要往下滚三屏才能按到保存。
 */
function SaveBar({
  saving,
  onSave,
  onReset,
}: {
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div
      className="ds-animate-in"
      style={{
        position: 'sticky',
        bottom: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '11px 16px',
        borderRadius: 12,
        border: '1px solid var(--ds-border)',
        background: 'var(--ds-bg-surface)',
        boxShadow: 'var(--ds-shadow-card)',
        backdropFilter: 'blur(12px)',
        zIndex: 5,
      }}
    >
      <span className="ds-text-body-sm text-ds-secondary" style={{ flex: 1, minWidth: 0 }}>
        有未保存的修改。保存后新口径会立刻推送给所有在线的人。
      </span>
      <button className="ds-btn ds-btn-ghost" onClick={onReset} disabled={saving}>
        放弃
      </button>
      <button className="ds-btn ds-btn-primary" onClick={onSave} disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  );
}

/** 供其他页面复用：把字节数按当前口径读成一句话。 */
export function describeQuota(quota: number): string {
  return quota > 0 ? bytes(quota, 0) : '不限量';
}
