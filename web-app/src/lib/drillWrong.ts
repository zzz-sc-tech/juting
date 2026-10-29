/**
 * 专项刷题的错题本（本机 localStorage，键 juting.web.drill-wrong.v1）。
 *
 * 为什么单独建一本：drill-stats 只记「每个 Section 对几错几」，
 * 回答不了「我到底哪几道题还不会」。这一本按 exerciseId:题号 存，
 * 答对即出队，于是它就是一份会自己变短的待补漏清单。
 *
 * 与 examHistory 的错题（按整卷记账）刻意分开：那边的题号来自 25 题整卷，
 * 这里的题号来自单题训练，混在一起会让两边都不可信。
 */
import { safeSetItem } from './storageSafety'

export type DrillWrongEntry = {
  exerciseId: number
  n: number
  /** 累计答错次数（同一题反复错时累加，用来排序） */
  wrongCount: number
  /** 最后一次答错时间（ISO） */
  lastWrongAt: string
}

export type DrillWrongStore = Record<string, DrillWrongEntry>

const KEY = 'juting.web.drill-wrong.v1'

/** 上限：错题本无限长没有意义，超过就丢最久没碰过的 */
const MAX_ENTRIES = 200

export const wrongKey = (exerciseId: number, n: number) => `${exerciseId}:${n}`

const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null

/** 体检任意来源的错题本（本机读盘 / 备份导入共用）；非法条目整条丢弃。 */
export const normalizeDrillWrong = (value: unknown): DrillWrongStore | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const safe: DrillWrongStore = {}
  for (const [, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const exerciseId = positiveInt(entry.exerciseId)
    const n = positiveInt(entry.n)
    if (exerciseId === null || n === null || n > 25) continue
    const wrongCount = positiveInt(entry.wrongCount) ?? 1
    const lastWrongAt = typeof entry.lastWrongAt === 'string' ? entry.lastWrongAt : ''
    safe[wrongKey(exerciseId, n)] = { exerciseId, n, wrongCount, lastWrongAt }
  }
  return safe
}

const write = (store: DrillWrongStore): void => {
  safeSetItem(KEY, JSON.stringify(store))
}

export const loadDrillWrong = (): DrillWrongStore => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    return normalizeDrillWrong(JSON.parse(raw)) ?? {}
  } catch {
    return {}
  }
}

/** 记一次答错并返回新错题本；同一题累加次数、刷新时间。 */
export const addDrillWrong = (
  exerciseId: number,
  n: number,
  at: string = new Date().toISOString(),
): DrillWrongStore => {
  const store = loadDrillWrong()
  const key = wrongKey(exerciseId, n)
  const existing = store[key]
  store[key] = {
    exerciseId,
    n,
    wrongCount: (existing?.wrongCount ?? 0) + 1,
    lastWrongAt: at,
  }
  // 超上限时裁掉最久没答错的那些
  const entries = Object.entries(store)
  if (entries.length > MAX_ENTRIES) {
    entries.sort((left, right) => right[1].lastWrongAt.localeCompare(left[1].lastWrongAt))
    const trimmed: DrillWrongStore = {}
    for (const [trimKey, entry] of entries.slice(0, MAX_ENTRIES)) {
      trimmed[trimKey] = entry
    }
    write(trimmed)
    return trimmed
  }
  write(store)
  return store
}

/** 答对即出队：错题本的意义是「还欠着的题」，答对就没必要留着。 */
export const removeDrillWrong = (exerciseId: number, n: number): DrillWrongStore => {
  const store = loadDrillWrong()
  const key = wrongKey(exerciseId, n)
  if (!(key in store)) return store
  delete store[key]
  write(store)
  return store
}

export const clearDrillWrong = (): DrillWrongStore => {
  write({})
  return {}
}

/** 按最近答错时间倒序（重练时先补最近还错的）。 */
export const drillWrongList = (store: DrillWrongStore): DrillWrongEntry[] =>
  Object.values(store).sort((left, right) => right.lastWrongAt.localeCompare(left.lastWrongAt))

export { KEY as DRILL_WRONG_KEY }
