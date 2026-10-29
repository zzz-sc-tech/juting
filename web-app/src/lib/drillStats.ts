/**
 * 按题型专项刷题的累计战绩（本机 localStorage，键 juting.web.drill-stats.v1）。
 *
 * 刻意与 examHistory 分账：专项刷题是「单题训练」，混进按整卷 25 题记账的
 * examHistory 会污染分数曲线和「你最常错的题」（同一道题一天能刷十几遍）。
 * 这里只记每个 Section 的累计对/错，够看「我这块到底行不行」。
 */
import type { ExamSection } from './examHistory'
import { safeSetItem } from './storageSafety'

export type DrillSectionStat = {
  correct: number
  wrong: number
}

export type DrillStats = Record<ExamSection, DrillSectionStat>

const KEY = 'juting.web.drill-stats.v1'

const SECTIONS: ExamSection[] = ['A', 'B', 'C']

export const emptyDrillStats = (): DrillStats => ({
  A: { correct: 0, wrong: 0 },
  B: { correct: 0, wrong: 0 },
  C: { correct: 0, wrong: 0 },
})

const countOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/**
 * 体检任意来源的统计对象（本机读盘 / 备份导入共用）。
 * 非对象、缺 Section、负数或小数一律归零，绝不把垃圾写回去。
 */
export const normalizeDrillStats = (value: unknown): DrillStats | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const stats = emptyDrillStats()
  for (const section of SECTIONS) {
    const entry = record[section]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { correct, wrong } = entry as Record<string, unknown>
    stats[section] = { correct: countOf(correct), wrong: countOf(wrong) }
  }
  return stats
}

export const loadDrillStats = (): DrillStats => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return emptyDrillStats()
    return normalizeDrillStats(JSON.parse(raw)) ?? emptyDrillStats()
  } catch {
    return emptyDrillStats()
  }
}

const write = (stats: DrillStats): void => {
  safeSetItem(KEY, JSON.stringify(stats))
}

/** 记一题并返回新统计（调用方直接拿去 setState）。 */
export const recordDrillAnswer = (section: ExamSection, isCorrect: boolean): DrillStats => {
  const stats = loadDrillStats()
  const current = stats[section]
  stats[section] = isCorrect
    ? { correct: current.correct + 1, wrong: current.wrong }
    : { correct: current.correct, wrong: current.wrong + 1 }
  write(stats)
  return stats
}

export const resetDrillStats = (): DrillStats => {
  const stats = emptyDrillStats()
  write(stats)
  return stats
}

/** 正确率（0–100 整数）；没做过返回 null，界面据此显示「—」而不是 0%。 */
export const accuracyOf = (stat: DrillSectionStat): number | null => {
  const total = stat.correct + stat.wrong
  return total > 0 ? Math.round((stat.correct / total) * 100) : null
}

export { KEY as DRILL_STATS_KEY }
