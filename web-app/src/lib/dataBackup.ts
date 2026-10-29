/**
 * 学习数据导出 / 导入（本机 localStorage，全部 juting.web.*.v1 键）。
 *
 * 备份文件是自描述 JSON：format + version 双重校验，畸形文件在写入前就被
 * 拒绝——历史上因为没校验导致过白屏，这里宁可报错也绝不静默写垃圾数据。
 *
 * 覆盖（replace）：备份原样写回，适合换机/清缓存后恢复。
 * 合并（merge）：进度取并集（同句 mastered/unclear 取 OR、repeatCount 取 max、
 * 生词并集）、每日活动按日取 max、实战档案逐场去重追加、生词复习取更靠后的一方、
 * 所听时长按日取 max；偏好/目标/主题属于设备偏好，合并时保留本机不动。
 *
 * 老键兼容：duolinting.web.progress.v1 是更名前的 legacy 键，读取仍回退；
 * 导出时 legacy 值会作为 progress 导出，导入统一写回新键。
 */

import { isValidExamDate } from './examDate'
import { registerSpaceReclaimer, safeSetItem } from './storageSafety'

export type BackupFile = {
  format: 'juting-backup'
  version: 1
  exportedAt: string
  appVersion?: string
  data: {
    progress?: unknown
    activity?: unknown
    examHistory?: unknown
    prefs?: unknown
    dailyGoal?: unknown
    theme?: unknown
    mode?: unknown
    /** 生词复习调度（A3 补入；老备份可能没有） */
    vocabReview?: unknown
    /** 所听时长（A3 补入；老备份可能没有） */
    listenTime?: unknown
    /** 考试日期 'YYYY-MM-DD'（备考三功能补入） */
    examDate?: unknown
  }
}

export type ImportMode = 'replace' | 'merge'

export type ImportResult = {
  ok: boolean
  /** 实际写回的存储键（不含 autobackup） */
  imported: string[]
  /** 备份里有但因校验不过被丢弃的部分 */
  skipped: string[]
  error?: string
}

const KEYS = {
  progress: 'juting.web.progress.v1',
  legacyProgress: 'duolinting.web.progress.v1',
  activity: 'juting.web.activity.v1',
  legacyActivity: 'duolinting.web.activity.v1',
  examHistory: 'juting.web.exam-history.v1',
  prefs: 'juting.web.prefs.v1',
  dailyGoal: 'juting.web.daily-goal.v1',
  legacyDailyGoal: 'duolinting.web.daily-goal.v1',
  theme: 'juting.web.theme.v1',
  mode: 'juting.web.mode.v1',
  vocabReview: 'juting.web.vocab-review.v1',
  listenTime: 'juting.web.listen-time.v1',
  examDate: 'juting.web.exam-date.v1',
  autobackup: 'juting.web.autobackup.v1',
  lastExport: 'juting.web.last-export.v1',
} as const

export const LAST_EXPORT_KEY = KEYS.lastExport

const readRaw = (key: string, legacyKey?: string): unknown => {
  try {
    const raw = localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null)
    if (raw === null) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return raw // daily-goal / theme 存的是裸字符串
    }
  } catch {
    return undefined
  }
}

/** 导出全部学习数据（8 类；exam-inprogress 是临时态，故意不含）。 */
export const exportAll = (): BackupFile => ({
  format: 'juting-backup',
  version: 1,
  exportedAt: new Date().toISOString(),
  data: {
    progress: readRaw(KEYS.progress, KEYS.legacyProgress),
    activity: readRaw(KEYS.activity, KEYS.legacyActivity),
    examHistory: readRaw(KEYS.examHistory),
    prefs: readRaw(KEYS.prefs),
    dailyGoal: readRaw(KEYS.dailyGoal, KEYS.legacyDailyGoal),
    theme: readRaw(KEYS.theme),
    mode: readRaw(KEYS.mode),
    vocabReview: readRaw(KEYS.vocabReview),
    listenTime: readRaw(KEYS.listenTime),
    examDate: readRaw(KEYS.examDate),
  },
})

/** 触发浏览器下载 .json，文件名带日期。 */
export const downloadBackup = (): void => {
  const backup = exportAll()
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const day = new Date().toISOString().slice(0, 10)
  anchor.href = url
  anchor.download = `juting-backup-${day}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
  try {
    localStorage.setItem(KEYS.lastExport, new Date().toISOString())
  } catch {
    // 上次导出时间只是展示，存不下就算了
  }
}

export const getLastExportAt = (): string | null => {
  try {
    return localStorage.getItem(KEYS.lastExport)
  } catch {
    return null
  }
}

/** 校验备份文件顶层结构；任何不合规都抛出带中文说明的 Error。 */
export const parseBackup = (text: string): BackupFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('文件不是合法的 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('文件结构不符合备份格式')
  }
  const file = parsed as Record<string, unknown>
  if (file.format !== 'juting-backup') {
    throw new Error('不是句听备份文件（缺少 format 标识）')
  }
  if (file.version !== 1) {
    throw new Error(`备份版本不受支持（version=${String(file.version)}）`)
  }
  if (typeof file.data !== 'object' || file.data === null || Array.isArray(file.data)) {
    throw new Error('备份缺少 data 数据区')
  }
  return {
    format: 'juting-backup',
    version: 1,
    exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : '',
    appVersion: typeof file.appVersion === 'string' ? file.appVersion : undefined,
    data: file.data as BackupFile['data'],
  }
}

// ---------- 写入前的逐项校验（仿 examHistory / progressStore 的体检写法） ----------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** progress 必须是 StudyStore 形态；畸形课直接丢弃（渲染层也会兜底，这里再拦一道）。 */
const sanitizeProgress = (value: unknown): string | null => {
  if (value === undefined) return null
  if (!isRecord(value)) return 'progress'
  const rawProgress = value.progressByExercise
  if (rawProgress !== undefined && !isRecord(rawProgress)) return 'progress'
  if (isRecord(rawProgress)) {
    for (const entry of Object.values(rawProgress)) {
      if (!isRecord(entry) || !isRecord(entry.lines)) return 'progress'
    }
  }
  return null
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const sanitizeActivity = (value: unknown): Record<string, number> | null => {
  if (value === undefined) return null
  if (!isRecord(value)) return null
  const safe: Record<string, number> = {}
  for (const [day, rawCount] of Object.entries(value)) {
    const count = typeof rawCount === 'number' ? rawCount : Number.NaN
    if (DAY_RE.test(day) && Number.isFinite(count) && count > 0) {
      safe[day] = count
    }
  }
  return safe
}

type AttemptLike = { date: string; score: number; total: number; wrong: unknown; unanswered: number; wrongBySection?: unknown }

const sanitizeExamHistory = (value: unknown): Record<string, AttemptLike[]> | null => {
  if (value === undefined) return null
  if (!isRecord(value)) return null
  const safe: Record<string, AttemptLike[]> = {}
  for (const [exerciseId, attempts] of Object.entries(value)) {
    if (!Array.isArray(attempts)) continue
    const list: AttemptLike[] = []
    for (const attempt of attempts) {
      if (
        isRecord(attempt) &&
        typeof attempt.date === 'string' &&
        Number.isFinite(attempt.score) &&
        Number.isFinite(attempt.total)
      ) {
        list.push(attempt as AttemptLike)
      }
    }
    if (list.length > 0) safe[exerciseId] = list
  }
  return safe
}

const sanitizePrefs = (value: unknown): unknown | null => (value !== undefined && isRecord(value) ? value : null)

const sanitizeDailyGoal = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : null
}

const THEMES = ['paper', 'gazette', 'minimal', 'exam'] as const
const sanitizeTheme = (value: unknown): string | null =>
  typeof value === 'string' && (THEMES as readonly string[]).includes(value) ? value : null
const MODES = ['system', 'light', 'dark'] as const
const sanitizeMode = (value: unknown): string | null =>
  typeof value === 'string' && (MODES as readonly string[]).includes(value) ? value : null

type VocabReviewLike = {
  addedAt: number
  dueAt?: number
  lastReviewedAt?: number
  reviewCount: number
  mastered: boolean
}

/** 生词复习：逐词体检，非法词条丢弃（与 vocabReview.loadVocabReview 同款容错）。 */
const sanitizeVocabReview = (value: unknown): Record<string, VocabReviewLike> | null => {
  if (value === undefined) return null
  if (!isRecord(value)) return null
  const safe: Record<string, VocabReviewLike> = {}
  for (const [word, rawEntry] of Object.entries(value)) {
    if (!isRecord(rawEntry)) continue
    const addedAt = typeof rawEntry.addedAt === 'number' && Number.isFinite(rawEntry.addedAt) ? rawEntry.addedAt : null
    if (addedAt === null) continue
    const reviewCount =
      typeof rawEntry.reviewCount === 'number' && Number.isFinite(rawEntry.reviewCount)
        ? Math.max(0, Math.floor(rawEntry.reviewCount))
        : 0
    safe[word] = {
      addedAt,
      dueAt: typeof rawEntry.dueAt === 'number' && Number.isFinite(rawEntry.dueAt) ? rawEntry.dueAt : undefined,
      lastReviewedAt:
        typeof rawEntry.lastReviewedAt === 'number' && Number.isFinite(rawEntry.lastReviewedAt)
          ? rawEntry.lastReviewedAt
          : undefined,
      reviewCount,
      mastered: rawEntry.mastered === true,
    }
  }
  return safe
}

type ListenTimeLike = { totalMs: number; byDay: Record<string, number> }

/** 所听时长：只保留合法日期键与非负数值，totalMs 不得小于按日累计。 */
const sanitizeListenTime = (value: unknown): ListenTimeLike | null => {
  if (value === undefined) return null
  if (!isRecord(value)) return null
  const byDay: Record<string, number> = {}
  if (isRecord(value.byDay)) {
    for (const [day, rawMs] of Object.entries(value.byDay)) {
      if (DAY_RE.test(day) && typeof rawMs === 'number' && Number.isFinite(rawMs) && rawMs > 0) {
        byDay[day] = rawMs
      }
    }
  }
  const declared =
    typeof value.totalMs === 'number' && Number.isFinite(value.totalMs) && value.totalMs > 0 ? value.totalMs : 0
  const summed = Object.values(byDay).reduce((sum, ms) => sum + ms, 0)
  return { totalMs: Math.max(declared, summed), byDay }
}

/** 考试日期：只接受合法的 'YYYY-MM-DD'，脏值整项跳过（宁可不恢复也不写坏数据）。 */
const sanitizeExamDate = (value: unknown): string | null =>
  typeof value === 'string' && isValidExamDate(value) ? value : null

const writeRaw = (key: string, value: unknown) => {
  // 导入写盘同样不能静默失败：配额满时用户以为恢复成功，实际一条没写进去
  const ok = safeSetItem(key, typeof value === 'string' ? value : JSON.stringify(value))
  if (!ok) {
    throw new Error('本地存储写入失败（可能空间已满），导入未完成')
  }
}

// ---------- 合并（merge） ----------

type LineProgressLike = {
  unclear?: boolean
  mastered?: boolean
  repeatCount?: number
  note?: string
  dictation?: string
}

type ExerciseProgressLike = {
  exerciseId?: number
  lastLineId?: string
  showTranslation?: boolean
  hideTranscript?: boolean
  playbackRate?: number
  lastPositionSec?: number
  extensivePasses?: number
  updatedAt?: string
  lines?: Record<string, LineProgressLike>
  vocabulary?: Record<string, string>
}

const mergeLine = (local: LineProgressLike | undefined, incoming: LineProgressLike | undefined) => {
  if (!local) return incoming ?? {}
  if (!incoming) return local
  return {
    unclear: Boolean(local.unclear) || Boolean(incoming.unclear),
    mastered: Boolean(local.mastered) || Boolean(incoming.mastered),
    repeatCount: Math.max(local.repeatCount ?? 0, incoming.repeatCount ?? 0),
    note: local.note || incoming.note || '',
    dictation: local.dictation || incoming.dictation || '',
  }
}

const mergeExerciseProgress = (local: ExerciseProgressLike, incoming: ExerciseProgressLike): ExerciseProgressLike => {
  // 界面偏好类字段取 updatedAt 较新者为基底；行为数据（lines/vocabulary）双向并集
  const base = (incoming.updatedAt ?? '') > (local.updatedAt ?? '') ? incoming : local
  const lines: Record<string, LineProgressLike> = { ...(local.lines ?? {}) }
  for (const [lineId, line] of Object.entries(incoming.lines ?? {})) {
    lines[lineId] = mergeLine(lines[lineId], line)
  }
  return {
    ...base,
    lines,
    vocabulary: { ...(incoming.vocabulary ?? {}), ...(local.vocabulary ?? {}) },
    extensivePasses: Math.max(local.extensivePasses ?? 0, incoming.extensivePasses ?? 0),
    updatedAt: (local.updatedAt ?? '') > (incoming.updatedAt ?? '') ? local.updatedAt : incoming.updatedAt,
  }
}

// 合并规则是纯函数，导出供单测直接覆盖（不摸 localStorage / DOM）
export const mergeProgress = (local: unknown, incoming: unknown): Record<string, unknown> => {
  const localStore = isRecord(local) ? local : {}
  const incomingStore = isRecord(incoming) ? incoming : {}
  const localProgress = isRecord(localStore.progressByExercise) ? localStore.progressByExercise : {}
  const incomingProgress = isRecord(incomingStore.progressByExercise) ? incomingStore.progressByExercise : {}
  const progressByExercise: Record<string, ExerciseProgressLike> = {}
  for (const [courseId, progress] of Object.entries(localProgress)) {
    progressByExercise[courseId] = progress as ExerciseProgressLike
  }
  for (const [courseId, incomingEntry] of Object.entries(incomingProgress)) {
    const localEntry = progressByExercise[courseId]
    progressByExercise[courseId] = localEntry
      ? mergeExerciseProgress(localEntry, incomingEntry as ExerciseProgressLike)
      : (incomingEntry as ExerciseProgressLike)
  }
  return {
    // activeExerciseId 保留本机当前状态
    activeExerciseId: localStore.activeExerciseId ?? '',
    progressByExercise,
  }
}

export const mergeActivity = (local: unknown, incoming: unknown): Record<string, number> => {
  const localActivity = sanitizeActivity(local) ?? {}
  const incomingActivity = sanitizeActivity(incoming) ?? {}
  const merged: Record<string, number> = { ...localActivity }
  for (const [day, count] of Object.entries(incomingActivity)) {
    merged[day] = Math.max(merged[day] ?? 0, count)
  }
  return merged
}

const attemptFingerprint = (attempt: AttemptLike) =>
  `${attempt.date}|${attempt.score}|${Array.isArray(attempt.wrong) ? attempt.wrong.length : -1}`

export const mergeExamHistory = (local: unknown, incoming: unknown): Record<string, AttemptLike[]> => {
  const localHistory = sanitizeExamHistory(local) ?? {}
  const incomingHistory = sanitizeExamHistory(incoming) ?? {}
  const merged: Record<string, AttemptLike[]> = { ...localHistory }
  for (const [exerciseId, attempts] of Object.entries(incomingHistory)) {
    const existing = merged[exerciseId] ?? []
    const seen = new Set(existing.map(attemptFingerprint))
    for (const attempt of attempts) {
      const fingerprint = attemptFingerprint(attempt)
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint)
        existing.push(attempt)
      }
    }
    merged[exerciseId] = existing
  }
  return merged
}

// ---------- 生词复习 / 听时长的合并 ----------

const mergeVocabEntry = (local: VocabReviewLike, incoming: VocabReviewLike): VocabReviewLike => {
  // 以「更靠后」的一方为基底（复习次数多者优先，同次数取最近复习时间）
  const incomingAhead =
    incoming.reviewCount > local.reviewCount ||
    (incoming.reviewCount === local.reviewCount && (incoming.lastReviewedAt ?? 0) > (local.lastReviewedAt ?? 0))
  const base = incomingAhead ? incoming : local
  const lastReviewedAt = Math.max(local.lastReviewedAt ?? 0, incoming.lastReviewedAt ?? 0)
  return {
    addedAt: Math.min(local.addedAt, incoming.addedAt),
    dueAt: base.dueAt,
    lastReviewedAt: lastReviewedAt > 0 ? lastReviewedAt : undefined,
    reviewCount: Math.max(local.reviewCount, incoming.reviewCount),
    // 任一侧已掌握即算掌握：用户确实复习够次数了，回退只会让它重新排队
    mastered: local.mastered || incoming.mastered,
  }
}

export const mergeVocabReview = (local: unknown, incoming: unknown): Record<string, VocabReviewLike> => {
  const merged = { ...(sanitizeVocabReview(local) ?? {}) }
  for (const [word, entry] of Object.entries(sanitizeVocabReview(incoming) ?? {})) {
    merged[word] = merged[word] ? mergeVocabEntry(merged[word], entry) : entry
  }
  return merged
}

export const mergeListenTime = (local: unknown, incoming: unknown): ListenTimeLike => {
  const localTime = sanitizeListenTime(local) ?? { totalMs: 0, byDay: {} }
  const incomingTime = sanitizeListenTime(incoming) ?? { totalMs: 0, byDay: {} }
  const byDay: Record<string, number> = { ...localTime.byDay }
  for (const [day, ms] of Object.entries(incomingTime.byDay)) {
    byDay[day] = Math.max(byDay[day] ?? 0, ms)
  }
  // 同一段时间在两台设备都听过，不能简单相加（会翻倍），取按日累计的较大者
  const summed = Object.values(byDay).reduce((sum, ms) => sum + ms, 0)
  return { totalMs: Math.max(localTime.totalMs, incomingTime.totalMs, summed), byDay }
}

// ---------- 导入 ----------
/** 导入备份；mode=replace 原样写回（校验过的部分），mode=merge 按并集规则合并。 */
export const importAll = (backup: BackupFile, mode: ImportMode): ImportResult => {
  const imported: string[] = []
  const skipped: string[] = []
  const { data } = backup

  try {
    if (mode === 'replace') {
      const badProgress = sanitizeProgress(data.progress)
      if (data.progress !== undefined && badProgress) {
        skipped.push(badProgress)
      } else if (data.progress !== undefined) {
        writeRaw(KEYS.progress, data.progress)
        imported.push(KEYS.progress)
      }

      const activity = sanitizeActivity(data.activity)
      if (data.activity !== undefined && !activity) skipped.push('activity')
      else if (activity) {
        writeRaw(KEYS.activity, activity)
        imported.push(KEYS.activity)
      }

      const examHistory = sanitizeExamHistory(data.examHistory)
      if (data.examHistory !== undefined && !examHistory) skipped.push('examHistory')
      else if (examHistory) {
        writeRaw(KEYS.examHistory, examHistory)
        imported.push(KEYS.examHistory)
      }

      const prefs = sanitizePrefs(data.prefs)
      if (data.prefs !== undefined && !prefs) skipped.push('prefs')
      else if (prefs) {
        writeRaw(KEYS.prefs, prefs)
        imported.push(KEYS.prefs)
      }

      const dailyGoal = sanitizeDailyGoal(data.dailyGoal)
      if (data.dailyGoal !== undefined && dailyGoal === null) skipped.push('dailyGoal')
      else if (dailyGoal !== null) {
        writeRaw(KEYS.dailyGoal, String(dailyGoal))
        imported.push(KEYS.dailyGoal)
      }

      const theme = sanitizeTheme(data.theme)
      if (data.theme !== undefined && !theme) skipped.push('theme')
      else if (theme) {
        writeRaw(KEYS.theme, theme)
        imported.push(KEYS.theme)
      }

      const mode = sanitizeMode(data.mode)
      if (data.mode !== undefined && !mode) skipped.push('mode')
      else if (mode) {
        writeRaw(KEYS.mode, mode)
        imported.push(KEYS.mode)
      }

      const vocabReview = sanitizeVocabReview(data.vocabReview)
      if (data.vocabReview !== undefined && !vocabReview) skipped.push('vocabReview')
      else if (vocabReview) {
        writeRaw(KEYS.vocabReview, vocabReview)
        imported.push(KEYS.vocabReview)
      }

      const listenTime = sanitizeListenTime(data.listenTime)
      if (data.listenTime !== undefined && !listenTime) skipped.push('listenTime')
      else if (listenTime) {
        writeRaw(KEYS.listenTime, listenTime)
        imported.push(KEYS.listenTime)
      }

      const examDate = sanitizeExamDate(data.examDate)
      if (data.examDate !== undefined && !examDate) skipped.push('examDate')
      else if (examDate) {
        writeRaw(KEYS.examDate, examDate)
        imported.push(KEYS.examDate)
      }
    } else {
      // 合并：只碰学习数据（progress/activity/examHistory）；偏好/目标/主题保留本机
      const localProgress = readRaw(KEYS.progress, KEYS.legacyProgress)
      if (data.progress !== undefined && sanitizeProgress(data.progress) === null) {
        writeRaw(KEYS.progress, mergeProgress(localProgress, data.progress))
        imported.push(KEYS.progress)
      } else if (data.progress !== undefined) {
        skipped.push('progress')
      }

      const mergedActivity = mergeActivity(readRaw(KEYS.activity, KEYS.legacyActivity), data.activity)
      if (data.activity !== undefined) {
        writeRaw(KEYS.activity, mergedActivity)
        imported.push(KEYS.activity)
      }

      if (data.examHistory !== undefined) {
        writeRaw(KEYS.examHistory, mergeExamHistory(readRaw(KEYS.examHistory), data.examHistory))
        imported.push(KEYS.examHistory)
      }

      if (data.vocabReview !== undefined && sanitizeVocabReview(data.vocabReview) !== null) {
        writeRaw(KEYS.vocabReview, mergeVocabReview(readRaw(KEYS.vocabReview), data.vocabReview))
        imported.push(KEYS.vocabReview)
      } else if (data.vocabReview !== undefined) {
        skipped.push('vocabReview')
      }

      if (data.listenTime !== undefined && sanitizeListenTime(data.listenTime) !== null) {
        writeRaw(KEYS.listenTime, mergeListenTime(readRaw(KEYS.listenTime), data.listenTime))
        imported.push(KEYS.listenTime)
      } else if (data.listenTime !== undefined) {
        skipped.push('listenTime')
      }

      // 考试日期属于「目标」类设置（和每日目标同族）：合并时保留本机不动
    }
  } catch (error) {
    return {
      ok: false,
      imported: [],
      skipped,
      error: error instanceof Error ? error.message : '写入存储失败',
    }
  }

  return { ok: true, imported, skipped }
}

// ---------- 自动快照（环形 2 份，误清数据的兜底；可在设置页恢复） ----------

type AutoSnapshot = { at: string; progress: unknown; activity: unknown }

/**
 * 保留份数：原先 3 份完整 progress 副本与主数据抢同一个 5MB 配额，
 * 配额满时先失败的恰恰是真正的进度写入（见 A2）。降到 2 份并加回收器。
 */
const MAX_SNAPSHOTS = 2
/** 配额告急时先裁到这份数，把空间还给主数据 */
const SNAPSHOTS_WHEN_TIGHT = 1

const readAutobackup = (): AutoSnapshot[] => {
  try {
    const raw = localStorage.getItem(KEYS.autobackup)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return (parsed as AutoSnapshot[]).filter(
      (item) => isRecord(item) && typeof item.at === 'string',
    )
  } catch {
    return []
  }
}

/** 直接写回快照列表（不经 safeSetItem，避免回收器递归）。 */
const writeAutobackup = (list: AutoSnapshot[]): boolean => {
  try {
    localStorage.setItem(KEYS.autobackup, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

/** 裁掉多余快照；返回是否真的删掉了东西（供配额回收判断）。 */
const trimAutobackup = (keep: number): boolean => {
  const list = readAutobackup()
  if (list.length <= keep) return false
  return writeAutobackup(list.slice(0, keep))
}

// 配额满时优先牺牲快照，保住主数据（顺序：先裁到 1 份）
registerSpaceReclaimer(() => trimAutobackup(SNAPSHOTS_WHEN_TIGHT))

/**
 * 把当前进度快照一份到 autobackup（保留最近 2 份）。
 * 与上一份内容完全一致时跳过，不重复堆栈。
 * 启动时调用一次；长驻会话由 main.tsx 的低频定时器续做（见 D 批 A3 修复）。
 */
export const snapshotForAutobackup = (): void => {
  try {
    const progress = readRaw(KEYS.progress, KEYS.legacyProgress)
    if (progress === undefined) return
    const activity = readRaw(KEYS.activity, KEYS.legacyActivity)
    const list = readAutobackup()
    const latest = list[0]
    if (
      latest &&
      JSON.stringify(latest.progress) === JSON.stringify(progress) &&
      JSON.stringify(latest.activity) === JSON.stringify(activity)
    ) {
      return
    }
    const next = [{ at: new Date().toISOString(), progress, activity }, ...list].slice(0, MAX_SNAPSHOTS)
    // 快照写失败不打扰用户：主数据才是要紧的（配额问题会由主写入路径上报）
    writeAutobackup(next)
  } catch {
    // 快照是兜底措施，任何异常都不该影响启动
  }
}

/** 快照摘要：设置页列表用（时间 + 课程数 + 句子数 + 已掌握数）。 */
export type AutoSnapshotSummary = {
  at: string
  courseCount: number
  lineCount: number
  masteredCount: number
}

export const listAutoSnapshots = (): AutoSnapshotSummary[] =>
  readAutobackup().map((snapshot) => {
    const progressByExercise = isRecord(snapshot.progress) && isRecord(snapshot.progress.progressByExercise)
      ? snapshot.progress.progressByExercise
      : {}
    let courseCount = 0
    let lineCount = 0
    let masteredCount = 0
    for (const entry of Object.values(progressByExercise)) {
      if (!isRecord(entry) || !isRecord(entry.lines)) continue
      const lines = Object.values(entry.lines)
      if (lines.length === 0) continue
      courseCount += 1
      lineCount += lines.length
      masteredCount += lines.filter((line) => isRecord(line) && line.mastered === true).length
    }
    return { at: snapshot.at, courseCount, lineCount, masteredCount }
  })

/**
 * 从自动快照恢复：只回写 progress + activity（快照的结构就是这两项）。
 * 返回是否写入成功；调用方负责刷新页面。
 */
export const restoreAutoSnapshot = (at: string): boolean => {
  const snapshot = readAutobackup().find((item) => item.at === at)
  if (!snapshot) return false
  try {
    if (snapshot.progress !== undefined) {
      writeRaw(KEYS.progress, snapshot.progress)
    }
    if (snapshot.activity !== undefined) {
      writeRaw(KEYS.activity, snapshot.activity)
    }
    return true
  } catch {
    return false
  }
}
