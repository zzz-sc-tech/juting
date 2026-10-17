/**
 * 所听时长统计（本机 localStorage，键 juting.web.listen-time.v1）。
 *
 * 采集点在 useMediaPlayback 的播放轮询里：只在真正播放中按墙钟时间累加
 * （不乘倍速——用户体感是"我听了多久"），后台标签页（document.hidden）不累计。
 * 写盘策略：内存累加，每 15 秒或页面隐藏/离开时一次性落盘，避免高频写 localStorage。
 * 结构：{ totalMs, byDay: { 'yyyy-MM-dd': ms } }
 */

const KEY = 'juting.web.listen-time.v1'

export type ListenTimeStore = {
  totalMs: number
  byDay: Record<string, number>
}

const FLUSH_INTERVAL_MS = 15_000

let pendingMs = 0
let lastFlushAt = 0

const readStore = (): ListenTimeStore => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { totalMs: 0, byDay: {} }
    const parsed = JSON.parse(raw) as Partial<ListenTimeStore>
    if (typeof parsed !== 'object' || parsed === null) return { totalMs: 0, byDay: {} }
    const byDay: Record<string, number> = {}
    if (typeof parsed.byDay === 'object' && parsed.byDay !== null) {
      for (const [day, ms] of Object.entries(parsed.byDay)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
          byDay[day] = ms
        }
      }
    }
    return {
      totalMs: typeof parsed.totalMs === 'number' && Number.isFinite(parsed.totalMs) && parsed.totalMs > 0 ? parsed.totalMs : 0,
      byDay,
    }
  } catch {
    return { totalMs: 0, byDay: {} }
  }
}

const localDay = (): string => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const writeStore = (store: ListenTimeStore) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // 存储不可用时静默：时长统计不阻断学习
  }
}

/** 采集层调用：累计一段墙钟播放时间（ms），内部按 15 秒节流落盘。 */
export const accumulateListenTime = (ms: number): void => {
  if (!Number.isFinite(ms) || ms <= 0) return
  pendingMs += ms
  const now = Date.now()
  if (now - lastFlushAt >= FLUSH_INTERVAL_MS) {
    flushListenTime()
  }
}

/** 把内存里未落盘的时长写入 localStorage；暂停/切课/页面隐藏/离开时调用。 */
export const flushListenTime = (): void => {
  if (pendingMs <= 0) return
  const ms = pendingMs
  pendingMs = 0
  lastFlushAt = Date.now()
  const store = readStore()
  const day = localDay()
  store.totalMs += ms
  store.byDay[day] = (store.byDay[day] ?? 0) + ms
  writeStore(store)
}

/** 读取已落盘的统计（不含内存中未满 15 秒的零头——展示层差这几秒无所谓）。 */
export const loadListenTime = (): ListenTimeStore => readStore()

/** 格式化主值：< 1 小时 → "43 分钟"，否则 → "12 小时 34 分"。 */
export const formatListenDuration = (ms: number): string => {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 60) {
    return `${totalMinutes} 分钟`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
}
