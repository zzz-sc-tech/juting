import { createEmptyStore, type StudyStore } from '@juting/domain'
import { quarantineCorrupt, safeSetItem } from './storageSafety'

export {
  calculateChapterProgress,
  calculateSeriesProgress,
  countExerciseStats,
  createEmptyChapterProgress,
  createEmptyStore,
  createExerciseProgress,
  createInitialStore,
  createLineProgress,
  ensureExerciseProgress,
} from '@juting/domain'
export type {
  ChapterProgressSummary,
  SeriesProgressSummary,
} from '@juting/domain'

/**
 * 本地免登录模式的学习进度持久化：进度整仓存 localStorage，
 * 刷新/重启不丢。服务端同步已随登录功能一并移除。
 */
const STORE_STORAGE_KEY = 'juting.web.progress.v1'
const LEGACY_STORE_STORAGE_KEY = 'duolinting.web.progress.v1'
/** 隔离副本键前缀：完整损坏 → juting.web.progress.corrupt.<时间戳> */
const CORRUPT_KEY_PREFIX = 'juting.web.progress'

/**
 * 整块解析失败时暂停写盘：否则 StudySessionProvider 挂载 800ms 后
 * 就会把空仓库写回，把原始数据覆盖成不可恢复（见 A1）。
 * 用户显式处理（设置页「忽略损坏数据」/导入备份）后才恢复写入。
 */
let writeBlocked = false
/** 最近一次加载丢弃的课程条目数（诊断用） */
let lastDroppedCount = 0

export const isProgressWriteBlocked = (): boolean => writeBlocked
export const getLastDroppedCount = (): number => lastDroppedCount

/** 用户显式确认后可恢复写盘（隔离副本仍在，随时可导出）。 */
export const resumeProgressWrites = (): void => {
  writeBlocked = false
}

/**
 * 启动时读取本地进度；数据损坏或结构不符时回退空仓库，绝不因此白屏。
 * 但「不白屏」不等于「可以静默覆盖」：损坏的原始字符串先隔离另存，
 * 整块解析失败时暂停写盘，等用户处理。
 */
export const loadStoredStudyStore = (): StudyStore => {
  try {
    const raw = localStorage.getItem(STORE_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORE_STORAGE_KEY)
    if (!raw) {
      return createEmptyStore()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 整块坏档：隔离 + 停止写盘（顺序很重要，先留证据再降级）
      quarantineCorrupt(CORRUPT_KEY_PREFIX, raw, { blocking: true })
      writeBlocked = true
      return createEmptyStore()
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      quarantineCorrupt(CORRUPT_KEY_PREFIX, raw, { blocking: true })
      writeBlocked = true
      return createEmptyStore()
    }
    const record = parsed as Partial<StudyStore>
    const rawProgress = record.progressByExercise
    const progressByExercise: StudyStore['progressByExercise'] = {}
    let dropped = 0
    if (rawProgress && typeof rawProgress === 'object') {
      // 逐条体检：任何畸形条目（缺 lines 等）都会让渲染期抛错白屏，直接丢弃
      for (const [key, value] of Object.entries(rawProgress as Record<string, unknown>)) {
        // 畸形条目直接丢弃：该课程下次打开时会被 ensureExerciseProgress 重建
        if (
          value && typeof value === 'object' && 'lines' in value &&
          typeof (value as { lines: unknown }).lines === 'object' && (value as { lines: object }).lines !== null
        ) {
          progressByExercise[key] = value as StudyStore['progressByExercise'][string]
        } else {
          dropped += 1
        }
      }
    }
    lastDroppedCount = dropped
    if (dropped > 0) {
      // 部分条目坏掉：原始内容同样留档，但不锁写盘——否则用户这门课以外
      // 的进度也一起写不进去，代价过大。UI 侧给非阻塞提示。
      quarantineCorrupt(CORRUPT_KEY_PREFIX, raw, { dropped })
      console.warn(`[progressStore] 丢弃 ${dropped} 条畸形课程进度，原始数据已隔离另存`)
    }
    return {
      activeExerciseId:
        typeof record.activeExerciseId === 'number' ? record.activeExerciseId : '',
      progressByExercise,
    }
  } catch {
    return createEmptyStore()
  }
}

/** 进度写回本地；调用方负责防抖。损坏未处理期间直接跳过写盘。 */
export const persistStudyStore = (store: StudyStore) => {
  if (writeBlocked) {
    // 原始数据还没被处理，此时写回等于覆盖证据
    return false
  }
  try {
    return safeSetItem(STORE_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // JSON.stringify 失败（循环引用等理论可能）：不阻断学习，交给上层兜底
    return false
  }
}

/**
 * 本地每日掌握计数（免登录版的活动记录）：{ 'yyyy-MM-dd': count }。
 * 仪表盘的今日进度/连续天数/近 14 天图表都读它，不依赖服务端。
 */
const ACTIVITY_STORAGE_KEY = 'juting.web.activity.v1'
const LEGACY_ACTIVITY_STORAGE_KEY = 'duolinting.web.activity.v1'

export type LocalDailyActivity = Record<string, number>

export const loadLocalActivity = (): LocalDailyActivity => {
  try {
    const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY) ?? localStorage.getItem(LEGACY_ACTIVITY_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as LocalDailyActivity
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    // 只保留合法日期键，防脏数据
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([day, count]) =>
          /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(count) && count > 0,
      ),
    )
  } catch {
    return {}
  }
}

export const recordLocalMastery = (
  activity: LocalDailyActivity,
  day: string,
  delta = 1,
): LocalDailyActivity => ({
  ...activity,
  [day]: (activity[day] ?? 0) + delta,
})

export const persistLocalActivity = (activity: LocalDailyActivity) => {
  try {
    safeSetItem(ACTIVITY_STORAGE_KEY, JSON.stringify(activity))
  } catch {
    // stringify 异常（理论可能）：不阻断学习
  }
}

/** 客户端本地日期（yyyy-MM-dd），与学习行为发生地保持一致。 */
export const localDayString = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 每日掌握目标（句）：本地免登录模式下存 localStorage，设置页可改，默认 10。 */
const DAILY_GOAL_KEY = 'juting.web.daily-goal.v1'
const LEGACY_DAILY_GOAL_KEY = 'duolinting.web.daily-goal.v1'
export const DEFAULT_DAILY_GOAL = 10

export const loadDailyGoal = (): number => {
  try {
    const raw = localStorage.getItem(DAILY_GOAL_KEY) ?? localStorage.getItem(LEGACY_DAILY_GOAL_KEY)
    const value = raw === null ? NaN : Number.parseInt(raw, 10)
    return Number.isInteger(value) && value >= 1 && value <= 500 ? value : DEFAULT_DAILY_GOAL
  } catch {
    return DEFAULT_DAILY_GOAL
  }
}

export const persistDailyGoal = (goal: number) => {
  safeSetItem(DAILY_GOAL_KEY, String(goal))
}
