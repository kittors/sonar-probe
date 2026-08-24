import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { NodeState } from '../lib/types';
import { bytes, safeUrl } from '../lib/format';
import { CURRENCIES as ALL_CURRENCIES, CURRENCY_META } from '../lib/currency';
import { useSettings } from '../lib/settings';
import { Modal } from './Modal';
import { Alert, Checkbox, DatePicker, Field, FieldRow, Segmented, Select } from './ui';

/**
 * 机器属性编辑
 *
 * 这里只放采集端拿不到的东西：价格、计费周期、到期日、流量配额、服务商、地区。
 * CPU 型号、内存大小那些是机器自己上报的事实，不该让人手动覆盖 —— 覆盖了只会让
 * 面板和真机对不上。
 */

const CYCLES = [
  { value: 'monthly' as const, label: '月付' },
  { value: 'quarterly' as const, label: '季付' },
  { value: 'yearly' as const, label: '年付' },
];

/**
 * 币种下拉。
 *
 * 带上中文名而不只是三字码：填这个框的人是在照着自己的账单选，
 * 账单上写的是"港币"不是"HKD"，而 HKD/SGD/TWD 这几个码认错了很难被发现。
 */
const CURRENCY_OPTIONS = ALL_CURRENCIES.map((c) => ({
  value: c,
  label: `${CURRENCY_META[c].label} ${CURRENCY_META[c].symbol}`,
  hint: c,
}));

/*
 * 流量额度的重置日。
 *
 * 很多 VPS 是从开通日算周期的，不是每月 1 号 —— 按自然月统计的话，
 * 账单日附近那几天的用量会落进错误的周期。
 * 29–31 号在短月会自动落到当月最后一天，所以这里照常给出。
 */
const BILLING_DAYS = [
  { value: '0', label: '自然月（每月 1 号）' },
  ...Array.from({ length: 31 }, (_, i) => ({
    value: String(i + 1),
    label: `每月 ${i + 1} 号`,
  })),
];

/** 把 YYYY-MM-DD 显示成 MM-DD —— 周期起止只关心月日 */
function md(day: string): string {
  return day.slice(5);
}

interface Props {
  node: NodeState;
  onClose: () => void;
  onSaved: (node: NodeState) => void;
}

export function NodeEditDialog({ node, onClose, onSaved }: Props) {
  /*
   * 配额输入的进制跟着面板设置走。
   *
   * 人填的"2 TB"是照着服务商页面抄下来的，那里的 TB 是 10¹² 还是 2⁴⁰
   * 取决于服务商 —— 面板设置里选的正是这件事。用固定的 1024 去折算，
   * 会让一台标称 2 TB 的机器在库里存成 2.2×10¹²，配额百分比一直偏低 10%。
   */
  const { byteBase } = useSettings();
  const GB = byteBase ** 3;
  const TB = byteBase ** 4;

  const [name, setName] = useState(node.name);
  const [provider, setProvider] = useState(node.provider);
  const [countryCode, setCountryCode] = useState(node.countryCode === 'XX' ? '' : node.countryCode);
  const [region, setRegion] = useState(node.region);
  const [price, setPrice] = useState(node.price > 0 ? String(node.price) : '');
  const [currency, setCurrency] = useState(node.currency || 'USD');
  const [cycle, setCycle] = useState<'monthly' | 'quarterly' | 'yearly'>(node.billingCycle);
  const [expireDate, setExpireDate] = useState(
    node.expireAt > 0 ? new Date(node.expireAt).toISOString().slice(0, 10) : '',
  );
  // 配额拆成"是否不限量"和"具体数值"两截，比让人填 0 表示无限直观得多
  const [unlimited, setUnlimited] = useState(node.trafficQuota <= 0);
  const [quotaValue, setQuotaValue] = useState(
    node.trafficQuota > 0
      ? String(node.trafficQuota >= TB ? node.trafficQuota / TB : node.trafficQuota / GB)
      : '',
  );
  const [quotaUnit, setQuotaUnit] = useState<'GB' | 'TB'>(
    node.trafficQuota > 0 && node.trafficQuota < TB ? 'GB' : 'TB',
  );
  const [panelUrl, setPanelUrl] = useState(node.panelUrl);
  const [tags, setTags] = useState(node.tags.join(', '));

  const [billingDay, setBillingDay] = useState(String(node.billingDay || 0));

  /*
   * 校准输入框**始终留空**，当前状态写在下面的提示里。
   *
   * 之前是把"当前已用总量"预填进去，问题有两个：
   *   一是这个数每秒都在涨，你填的 91.22 隔一小时再打开就变成 109.11，
   *     看起来像是设置没保存住；
   *   二是每次保存都按显示值（两位小数）重算差额，反复打开保存会累积精度误差。
   *
   * 留空的语义更干脆：不填就是不动校准，填了就是重设。
   */
  const [usedValue, setUsedValue] = useState('');
  const [usedUnit, setUsedUnit] = useState<'GB' | 'TB'>('GB');
  const [dropOffset, setDropOffset] = useState(false);

  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const quotaBytes = unlimited
    ? 0
    : Math.round((Number(quotaValue) || 0) * (quotaUnit === 'TB' ? TB : GB));

  const usedTouched = usedValue.trim() !== '';
  const usedBytes = usedTouched
    ? Math.round((Number(usedValue) || 0) * (usedUnit === 'TB' ? TB : GB))
    : 0;
  const delta = usedBytes - node.trafficMeasured;

  /*
   * 校验。
   *
   * 只拦真正会造成坏数据的输入，不做"必填"这种形式主义 —— 这个表单里几乎每一项
   * 都可以留空（价格没填就是没记，标签为空就是没打标）。
   *
   * 服务端对同样的字段也有一遍兜底（见 store.ts 的 updateNode），
   * 这里是为了当场让人看见错在哪，不是替代服务端。
   */
  const errors: Record<string, string> = {};

  if (countryCode.trim() && !/^[A-Za-z]{2}$/.test(countryCode.trim())) {
    errors.countryCode = '要两位字母';
  }
  if (price.trim() && !(Number(price) >= 0)) {
    errors.price = '要 ≥ 0 的数字';
  }
  if (!unlimited) {
    if (!quotaValue.trim()) errors.quota = '填一个配额，或勾选不限量';
    else if (!(Number(quotaValue) > 0)) errors.quota = '配额要大于 0';
  }
  if (usedTouched && !(Number(usedValue) >= 0)) {
    errors.used = '要 ≥ 0 的数字';
  }
  if (panelUrl.trim() && !safeUrl(panelUrl.trim())) {
    // 只放行 http/https —— 这个值会进 <a href>，javascript: 点一下就执行了
    errors.panelUrl = '要以 http:// 或 https:// 开头';
  }
  const tagList = tags
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tagList.length > 8) errors.tags = `最多 8 个标签，现在有 ${tagList.length} 个`;
  else if (tagList.some((t) => t.length > 20)) errors.tags = '单个标签不超过 20 字';

  const invalid = Object.keys(errors).length > 0;

  /*
   * 字段下的文案必须短 —— "国家代码"那格只有 92px 宽，一句完整的话会折成两行，
   * 把下面的字段整体顶下去。汇总条里再补上字段名，那里有整行的宽度。
   */
  const FIELD_NAME: Record<string, string> = {
    countryCode: '国家代码',
    price: '价格',
    quota: '流量配额',
    used: '已用校准',
    panelUrl: '控制台链接',
    tags: '标签',
  };
  /** 点过保存之后才报红。边打字边报太吵 —— "配额不能为空"在你还没填完时就成立了 */
  const show = (k: string) => (showErrors ? errors[k] : undefined);

  async function save() {
    setShowErrors(true);
    if (invalid) return;

    setBusy(true);
    setErr(null);
    try {
      const updated = await api.updateNode(node.id, {
        name: name.trim() || node.id,
        provider: provider.trim(),
        countryCode: countryCode.trim().toUpperCase() || 'XX',
        region: region.trim(),
        price: Number(price) || 0,
        currency,
        billingCycle: cycle,
        // date input 给的是当地零点，存成当天结束更符合"这天到期"的直觉
        expireAt: expireDate ? new Date(`${expireDate}T23:59:59`).getTime() : 0,
        trafficQuota: quotaBytes,
        billingDay: Number(billingDay) || 0,
        panelUrl: panelUrl.trim(),
        /*
         * 三种情况分开表达：
         *   填了值   → 按新值重设校准
         *   点了撤销 → 传 null 清零
         *   都没有   → 不带这个字段，服务端不动它
         * 之前"留空即撤销"会让人一进一出就把校准弄丢。
         */
        trafficUsedActual: usedTouched ? usedBytes : dropOffset ? null : undefined,
        tags: tagList,
      });
      onSaved(updated);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '保存失败');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="编辑机器信息"
      subtitle="这些是采集端拿不到的账务信息"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="ds-btn ds-btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="ds-btn ds-btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FieldRow>
          <Field label="名称" grow>
            <input className="ds-input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="服务商" grow>
            <input
              className="ds-input"
              placeholder="如 Vultr"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="国家代码" width={92} error={show('countryCode')}>
            <input
              className="ds-input"
              placeholder="HK"
              maxLength={2}
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="地区" grow>
            <input
              className="ds-input"
              placeholder="Hong Kong"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </Field>
        </FieldRow>

        <div className="ds-form-gap" />

        <FieldRow>
          <Field label="价格" width={104} error={show('price')}>
            <input
              className="ds-input tnum"
              placeholder="0.00"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
          <Field label="币种" width={92}>
            <Select
              value={currency}
              onChange={setCurrency}
              options={CURRENCY_OPTIONS}
              ariaLabel="币种"
            />
          </Field>
          <Field label="计费周期" grow>
            <Segmented value={cycle} onChange={setCycle} options={CYCLES} />
          </Field>
        </FieldRow>

        <Field label="到期日" hint="留空表示不设到期">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <DatePicker value={expireDate} onChange={setExpireDate} ariaLabel="到期日" />
            {expireDate && (
              <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={() => setExpireDate('')}>
                清除
              </button>
            )}
          </div>
        </Field>

        <div className="ds-form-gap" />

        <Field label="流量配额" error={show('quota')}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Checkbox checked={unlimited} onChange={setUnlimited} label="不限量" />

            {!unlimited && (
              <>
                <input
                  className="ds-input tnum"
                  style={{ width: 104 }}
                  placeholder="0"
                  inputMode="decimal"
                  value={quotaValue}
                  onChange={(e) => setQuotaValue(e.target.value)}
                  aria-label="配额数值"
                />
                <Segmented
                  value={quotaUnit}
                  onChange={setQuotaUnit}
                  options={[
                    { value: 'GB', label: 'GB' },
                    { value: 'TB', label: 'TB' },
                  ]}
                />
                {quotaBytes > 0 && (
                  <span className="ds-text-caption text-ds-description tnum">
                    = {bytes(quotaBytes, 0)} / 月
                  </span>
                )}
              </>
            )}
          </div>
        </Field>

        <Field
          label="流量周期"
          hint={`本周期 ${md(node.cycleStart)} – ${md(node.cycleEnd)}`}
        >
          <Select
            value={billingDay}
            onChange={setBillingDay}
            options={BILLING_DAYS}
            ariaLabel="流量周期重置日"
          />
        </Field>

        {/*
          校准。
          探针总是中途装的，装之前那段流量库里没有记录，所以面板的已用永远比账单小。
          这里填服务商后台的真实值，服务端记下差额，后续增长照常实时累加。
        */}
        <Field
          label="已用校准"
          error={show('used')}
          hint={
            usedTouched && delta !== 0
              ? `面板实测 ${bytes(node.trafficMeasured, 1)}，将补 ${delta > 0 ? '+' : '−'}${bytes(Math.abs(delta), 1)}`
              : node.trafficOffset !== 0
                ? `当前记为 ${bytes(node.trafficUsed, 1)}（实测 ${bytes(node.trafficMeasured, 1)} + 校准 ${node.trafficOffset > 0 ? '+' : '−'}${bytes(Math.abs(node.trafficOffset), 1)}）。留空则不改动`
                : `面板实测 ${bytes(node.trafficMeasured, 1)}。填入服务商后台的真实值即可校准`
          }
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="ds-input tnum"
              style={{ width: 104 }}
              placeholder="实际已用"
              inputMode="decimal"
              value={usedValue}
              onChange={(e) => setUsedValue(e.target.value)}
              aria-label="本周期实际已用流量"
            />
            <Segmented
              value={usedUnit}
              onChange={setUsedUnit}
              options={[
                { value: 'GB', label: 'GB' },
                { value: 'TB', label: 'TB' },
              ]}
            />
            {usedTouched ? (
              <button className="ds-btn ds-btn-ghost ds-btn-s" onClick={() => setUsedValue('')}>
                清除
              </button>
            ) : (
              node.trafficOffset !== 0 && (
                // 留空只是"不改动"，要真的取消校准得有个明确的动作
                <button
                  className="ds-btn ds-btn-ghost ds-btn-s"
                  onClick={() => setDropOffset((v) => !v)}
                  style={dropOffset ? { color: 'var(--color-danger)' } : undefined}
                >
                  {dropOffset ? '将撤销校准' : '撤销校准'}
                </button>
              )
            )}
          </div>
        </Field>

        <div className="ds-form-gap" />

        <Field
          label="控制台链接"
          hint="服务商后台里这台机器的地址，排查时可一键跳过去"
          error={show('panelUrl')}
        >
          <input
            className="ds-input"
            placeholder="https://..."
            inputMode="url"
            value={panelUrl}
            onChange={(e) => setPanelUrl(e.target.value)}
          />
        </Field>

        <Field label="标签" hint="逗号分隔" error={show('tags')}>
          <input
            className="ds-input"
            placeholder="如：生产, 主库"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </Field>

        {/* 服务端返回的错误。前端校验拦不住的（比如并发改动、权限变更）会走到这 */}
        {err && <Alert title="保存失败">{err}</Alert>}

        {/* 有字段没填对时，保存按钮旁边光禁用不说原因太闷 */}
        {showErrors && invalid && !err && (
          <Alert tone="warn" title="还有几处要改">
            <ul>
              {Object.entries(errors).map(([k, e]) => (
                <li key={k}>
                  {FIELD_NAME[k] ?? k}：{e}
                </li>
              ))}
            </ul>
          </Alert>
        )}
      </div>
    </Modal>
  );
}
