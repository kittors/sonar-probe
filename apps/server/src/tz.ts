/**
 * 时区。
 *
 * 面板原先一律按 UTC 切日：daily_traffic 的 day 是 UTC 生成的，流量周期
 * 也按 UTC 判定。对 UTC+8 的人来说，"今日流量"要到晚上 8 点才归零，
 * 而服务商后台早在 8 小时前就翻了页 —— 两边永远对不上账。
 *
 * 单独成文件、不 import 任何东西，是为了让 billing.ts 能继续脱离数据库测试：
 * 它只需要"某个时刻在某个时区属于哪一天"，不需要知道设置存在哪里。
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone);
  if (!f) {
    // en-CA 的数字日期格式恰好就是 YYYY-MM-DD，不用自己拼零填充
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(timezone, f);
  }
  return f;
}

/**
 * 时区是否合法。
 *
 * 不维护白名单 —— IANA 数据库有 400 多个时区，写死一份必然过时。
 * 直接拿它构造一个 DateTimeFormat：建得起来就是这台机器认识的，
 * 建不起来会抛 RangeError。这条判定跟运行时的实际能力完全一致，
 * 不会出现"白名单里有但本机 ICU 不认识"的情况。
 */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 某个时刻在指定时区下属于哪一天，YYYY-MM-DD。 */
export function dayKeyIn(timezone: string, ts: number = Date.now()): string {
  try {
    return dayFormatter(timezone).format(new Date(ts));
  } catch {
    // 时区在存进来时已校验过，这里兜底只为防备 ICU 数据被裁剪的运行环境
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** 同上，取到月：YYYY-MM。 */
export function monthKeyIn(timezone: string, ts: number = Date.now()): string {
  return dayKeyIn(timezone, ts).slice(0, 7);
}

/** 拆成年月日三个数，供周期计算用。month 是 0 基，跟 Date 的约定一致。 */
export function civilDateIn(
  timezone: string,
  ts: number = Date.now(),
): { year: number; month: number; day: number } {
  const [y, m, d] = dayKeyIn(timezone, ts).split('-');
  return { year: Number(y), month: Number(m) - 1, day: Number(d) };
}

/**
 * 时区选项。
 *
 * 只列常见的那些放进下拉里，其余靠"自定义"输入 —— 400 多个时区平铺开
 * 会让人翻半天，而 VPS 面板的用户九成落在这十几个里。
 */
export const COMMON_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: 'UTC', label: 'UTC（协调世界时）' },
  { value: 'Asia/Shanghai', label: '中国标准时间 UTC+8' },
  { value: 'Asia/Hong_Kong', label: '香港 UTC+8' },
  { value: 'Asia/Taipei', label: '台北 UTC+8' },
  { value: 'Asia/Singapore', label: '新加坡 UTC+8' },
  { value: 'Asia/Tokyo', label: '东京 UTC+9' },
  { value: 'Asia/Seoul', label: '首尔 UTC+9' },
  { value: 'Asia/Kolkata', label: '印度 UTC+5:30' },
  { value: 'Europe/London', label: '伦敦 UTC+0/+1' },
  { value: 'Europe/Berlin', label: '柏林 UTC+1/+2' },
  { value: 'Europe/Moscow', label: '莫斯科 UTC+3' },
  { value: 'America/New_York', label: '纽约 UTC−5/−4' },
  { value: 'America/Chicago', label: '芝加哥 UTC−6/−5' },
  { value: 'America/Los_Angeles', label: '洛杉矶 UTC−8/−7' },
  { value: 'America/Sao_Paulo', label: '圣保罗 UTC−3' },
  { value: 'Australia/Sydney', label: '悉尼 UTC+10/+11' },
];
