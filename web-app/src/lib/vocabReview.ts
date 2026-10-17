/**
 * 生词复习调度（旁路结构，本机 localStorage，键 juting.web.vocab-review.v1）。
 *
 * 红线：不改 ExerciseProgress.vocabulary 的结构（Record<词, 原句>）——老数据
 * 在 localStorage，改结构会让老用户进度读不出来。这里用独立键记录时间与次数，
 * 词键统一小写（与词典/侧栏的忽略大小写判定一致）。
 *
 * 调度（简单、可解释，不上 SM-2）：
 *   reviewCount 0 → 1 天后复习
 *   reviewCount 1 → 3 天后
 *   reviewCount 2 → 7 天后
 *   reviewCount 3 → 15 天后
 *   reviewCount ≥4 → 已掌握（不再排队，但仍留在生词本）
 * 「不认识」→ reviewCount 归零，明天重新排队。
 *
 * 兼容：老生词没有时间——首次在生词本页出现时补登记，并把这些词标记为
 * 「今日可复习」（dueAt=now，一次性），避免老数据永远不排队。
 */

import { safeSetItem } from './storageSafety'

const KEY = 'juting.web.vocab-review.v1'
const DAY_MS = 24 * 60 * 60 * 1000

/** reviewCount → 下次复习间隔（天）；超出即已掌握。 */
const INTERVAL_DAYS = [1, 3, 7, 15]
export const MASTERED_REVIEW_COUNT = INTERVAL_DAYS.length

export type VocabReviewEntry = {
  /** 首次登记时间（ms） */
  addedAt: number
  /** 显式到期时间（ms）：迁移词/「不认识」后设置，优先于间隔推算 */
  dueAt?: number
  lastReviewedAt?: number
  reviewCount: number
  mastered: boolean
}

export type VocabReviewState = Record<string, VocabReviewEntry>

export type ReviewVerdict = 'known' | 'unknown'

const normalize = (word: string): string => word.toLowerCase()

const sanitizeEntry = (value: unknown): VocabReviewEntry | null => {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Partial<VocabReviewEntry>
  if (typeof entry.addedAt !== 'number' || !Number.isFinite(entry.addedAt)) return null
  const reviewCount = typeof entry.reviewCount === 'number' && Number.isFinite(entry.reviewCount)
    ? Math.max(0, Math.floor(entry.reviewCount))
    : 0
  return {
    addedAt: entry.addedAt,
    dueAt: typeof entry.dueAt === 'number' && Number.isFinite(entry.dueAt) ? entry.dueAt : undefined,
    lastReviewedAt:
      typeof entry.lastReviewedAt === 'number' && Number.isFinite(entry.lastReviewedAt)
        ? entry.lastReviewedAt
        : undefined,
    reviewCount,
    mastered: entry.mastered === true || reviewCount >= MASTERED_REVIEW_COUNT,
  }
}

export const loadVocabReview = (): VocabReviewState => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const safe: VocabReviewState = {}
    for (const [word, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const sanitized = sanitizeEntry(entry)
      if (sanitized) safe[word] = sanitized
    }
    return safe
  } catch {
    return {}
  }
}

export const persistVocabReview = (state: VocabReviewState): void => {
  safeSetItem(KEY, JSON.stringify(state))
}

/** 该词在复习状态里是否已有记录。 */
export const hasReviewEntry = (state: VocabReviewState, word: string): boolean =>
  normalize(word) in state

/**
 * 确保这些词都有登记记录（幂等）。
 * dueNow=true 用于老数据一次性迁移：补时间并标记「今日可复习」；
 * 新收藏走 dueNow=false，按默认间隔明天才排进队列。
 * now 可注入（单测用），不传取当前时间。
 */
export const ensureVocabEntries = (
  state: VocabReviewState,
  words: readonly string[],
  options: { dueNow?: boolean; now?: number } = {},
): VocabReviewState => {
  let changed = false
  const next: VocabReviewState = { ...state }
  const now = options.now ?? Date.now()
  for (const raw of words) {
    const word = normalize(raw)
    if (!word || word in next) continue
    next[word] = options.dueNow
      ? { addedAt: now, dueAt: now, reviewCount: 0, mastered: false }
      : { addedAt: now, reviewCount: 0, mastered: false }
    changed = true
  }
  return changed ? next : state
}

/** 从生词本删除时同步清掉复习记录（同词再收藏会重新排队）。 */
export const removeVocabEntry = (state: VocabReviewState, word: string): VocabReviewState => {
  const key = normalize(word)
  if (!(key in state)) return state
  const next = { ...state }
  delete next[key]
  return next
}

/** 计算到期时间：显式 dueAt 优先，否则按间隔表推算。 */
export const dueAtOf = (entry: VocabReviewEntry): number => {
  if (entry.dueAt !== undefined) return entry.dueAt
  const intervalDays = INTERVAL_DAYS[Math.min(entry.reviewCount, INTERVAL_DAYS.length - 1)] ?? 1
  return entry.addedAt + intervalDays * DAY_MS
}

/** 到期待复习的词（未掌握且到期时间已到），按登记时间升序（先收先复）。 */
export const dueWords = (
  state: VocabReviewState,
  words: readonly string[],
  now = Date.now(),
): string[] =>
  words
    .map(normalize)
    .filter((word, index, all) => all.indexOf(word) === index)
    .filter((word) => {
      const entry = state[word]
      return entry && !entry.mastered && dueAtOf(entry) <= now
    })

/** 复习一次：known → 次数 +1（满 4 次标记已掌握）；unknown → 归零、明天再来。 */
export const applyReviewVerdict = (
  state: VocabReviewState,
  word: string,
  verdict: ReviewVerdict,
  now = Date.now(),
): VocabReviewState => {
  const key = normalize(word)
  const existing = state[key]
  const base: VocabReviewEntry = existing ?? { addedAt: now, reviewCount: 0, mastered: false }
  const next: VocabReviewEntry =
    verdict === 'known'
      ? {
          ...base,
          lastReviewedAt: now,
          dueAt: undefined,
          reviewCount: base.reviewCount + 1,
          mastered: base.reviewCount + 1 >= MASTERED_REVIEW_COUNT,
        }
      : {
          ...base,
          lastReviewedAt: now,
          dueAt: now + DAY_MS,
          reviewCount: 0,
          mastered: false,
        }
  return { ...state, [key]: next }
}

/** 列表角标信息：已掌握 / 今日到期 / N 天后（文案由 UI 层按 kind 生成）。 */
export type ScheduleBadge = { kind: 'today' | 'later' | 'mastered'; days: number }

export const scheduleBadgeOf = (entry: VocabReviewEntry | undefined, now = Date.now()): ScheduleBadge | null => {
  if (!entry) return null
  if (entry.mastered) return { kind: 'mastered', days: 0 }
  const due = dueAtOf(entry)
  if (due <= now) return { kind: 'today', days: 0 }
  return { kind: 'later', days: Math.ceil((due - now) / DAY_MS) }
}

// ---------- 命令式便捷入口（收藏/删除/复习的各处直接调用，状态不进 React 树） ----------

/** 收藏时登记（幂等；新词按默认间隔明天进队列）。 */
export const registerVocabWords = (words: readonly string[]): void => {
  const state = loadVocabReview()
  const next = ensureVocabEntries(state, words)
  if (next !== state) {
    persistVocabReview(next)
  }
}

/** 老数据一次性迁移：补登记并标记「今日可复习」；返回最新状态（无变化时原样返回）。 */
export const registerVocabWordsDueNow = (words: readonly string[]): VocabReviewState => {
  const state = loadVocabReview()
  const next = ensureVocabEntries(state, words, { dueNow: true })
  if (next !== state) {
    persistVocabReview(next)
  }
  return next
}

/** 记录一次复习结果（认识/不认识），返回落盘后的最新状态。 */
export const recordVocabVerdict = (word: string, verdict: ReviewVerdict): VocabReviewState => {
  const next = applyReviewVerdict(loadVocabReview(), word, verdict)
  persistVocabReview(next)
  return next
}

/** 删除生词时同步清理复习记录。 */
export const unregisterVocabWord = (word: string): void => {
  persistVocabReview(removeVocabEntry(loadVocabReview(), word))
}

// ---------- 复习卡辅助 ----------

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 挖空原句：把该词（忽略大小写、整词）换成下划线，用于复习卡的回忆提示。
 * 词不在句中（按词形收藏但原句变了等边缘情况）时返回原句，不硬挖。
 */
export const blankContext = (context: string, word: string): string => {
  if (!context || !word) return context
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i')
  return context.replace(pattern, '______')
}
