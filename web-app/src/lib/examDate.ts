/**
 * 考试倒计时（本机 localStorage，键 juting.web.exam-date.v1）。
 *
 * 存 'YYYY-MM-DD' 纯日期而不是时间戳：考试是一个「哪一天」的概念，
 * 带上时分秒只会在跨时区/夏令时的时候差出一天。剩余天数一律按本地
 * 日界算（今天零点 → 考试日零点），与仪表盘活动统计同一口径。
 */
import { safeSetItem } from './storageSafety'

const KEY = 'juting.web.exam-date.v1'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 解析 'YYYY-MM-DD'；月份/日期越界（2026-02-30）视为非法。 */
export const parseDay = (value: string): { year: number; month: number; day: number } | null => {
  const match = DAY_RE.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

export const isValidExamDate = (value: unknown): value is string =>
  typeof value === 'string' && parseDay(value) !== null

/** 读考试日期；没设过或存的是脏数据都返回 null（整卡隐藏，不显示 1970）。 */
export const loadExamDate = (): string | null => {
  try {
    const raw = localStorage.getItem(KEY)
    return isValidExamDate(raw) ? raw : null
  } catch {
    return null
  }
}

/** 写考试日期；传 null / 空串表示清除。 */
export const persistExamDate = (value: string | null): void => {
  try {
    if (!value) {
      localStorage.removeItem(KEY)
      return
    }
    if (!isValidExamDate(value)) return
    safeSetItem(KEY, value)
  } catch {
    // 设置项写不进去不影响使用：下次打开只是没记住
  }
}

/**
 * 剩余天数 = 考试日 − 今天（本地日界）。
 * 今天就是考试日 → 0；已过 → 负数；日期非法 → null。
 */
export const daysUntil = (value: string, today: Date = new Date()): number | null => {
  const parsed = parseDay(value)
  if (!parsed) return null
  const target = new Date(parsed.year, parsed.month - 1, parsed.day)
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  // 四舍五入而不是 floor：夏令时那天相差 23/25 小时，floor 会把 1 天算成 0 天
  return Math.round((target.getTime() - base.getTime()) / 86_400_000)
}

export { KEY as EXAM_DATE_KEY }
