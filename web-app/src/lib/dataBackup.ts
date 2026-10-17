/**
 * 学习数据导出 / 导入（本机 localStorage，全部 juting.web.*.v1 键）。
 *
 * 备份文件是自描述 JSON：format + version 双重校验，畸形文件在写入前就被
 * 拒绝——历史上因为没校验导致过白屏，这里宁可报错也绝不静默写垃圾数据。
 *
 * 覆盖（replace）：备份原样写回，适合换机/清缓存后恢复。
 * 合并（merge）：进度取并集（同句 mastered/unclear 取 OR、repeatCount 取 max、
 * 生词并集）、每日活动按日取 max、实战档案逐场去重追加；偏好/目标/主题
 * 属于设备偏好，合并时保留本机不动。
 *
 * 老键兼容：duolinting.web.progress.v1 是更名前的 legacy 键，读取仍回退；
 * 导出时 legacy 值会作为 progress 导出，导入统一写回新键。
 */

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

/** 导出全部学习数据（6 类；exam-inprogress 是临时态，故意不含）。 */
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

const writeRaw = (key: string, value: unknown) => {
  localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
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

const mergeProgress = (local: unknown, incoming: unknown): Record<string, unknown> => {
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

const mergeActivity = (local: unknown, incoming: unknown): Record<string, number> => {
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

const mergeExamHistory = (local: unknown, incoming: unknown): Record<string, AttemptLike[]> => {
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

// ---------- 启动自动快照（环形 3 份，误清数据的兜底） ----------

type AutoSnapshot = { at: string; progress: unknown; activity: unknown }

/**
 * 应用启动时把进度快照一份到 autobackup（保留最近 3 份）。
 * 与上一份内容完全一致时跳过，不重复堆栈。
 */
export const snapshotForAutobackup = (): void => {
  try {
    const progress = readRaw(KEYS.progress, KEYS.legacyProgress)
    if (progress === undefined) return
    const activity = readRaw(KEYS.activity, KEYS.legacyActivity)
    const rawList = localStorage.getItem(KEYS.autobackup)
    const parsed = rawList ? (JSON.parse(rawList) as unknown) : []
    const list: AutoSnapshot[] = Array.isArray(parsed) ? (parsed as AutoSnapshot[]) : []
    const latest = list[0]
    if (
      latest &&
      JSON.stringify(latest.progress) === JSON.stringify(progress) &&
      JSON.stringify(latest.activity) === JSON.stringify(activity)
    ) {
      return
    }
    const next = [{ at: new Date().toISOString(), progress, activity }, ...list].slice(0, 3)
    localStorage.setItem(KEYS.autobackup, JSON.stringify(next))
  } catch {
    // 快照是兜底措施，任何异常都不该影响启动
  }
}
