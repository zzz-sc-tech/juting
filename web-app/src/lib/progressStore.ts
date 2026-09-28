import { createEmptyStore, type StudyStore } from '@juting/domain'

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

/** 启动时读取本地进度；数据损坏或结构不符时回退空仓库，绝不因此白屏。 */
export const loadStoredStudyStore = (): StudyStore => {
  try {
    const raw = localStorage.getItem(STORE_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORE_STORAGE_KEY)
    if (!raw) {
      return createEmptyStore()
    }
    const parsed = JSON.parse(raw) as StudyStore
    if (typeof parsed !== 'object' || parsed === null) {
      return createEmptyStore()
    }
    const rawProgress = parsed.progressByExercise
    const progressByExercise: StudyStore['progressByExercise'] = {}
    if (rawProgress && typeof rawProgress === 'object') {
      // 逐条体检：任何畸形条目（缺 lines 等）都会让渲染期抛错白屏，直接重建为空进度
      for (const [key, value] of Object.entries(rawProgress as Record<string, unknown>)) {
        // 畸形条目直接丢弃：该课程下次打开时会被 ensureExerciseProgress 重建
        if (
          value && typeof value === 'object' && 'lines' in value &&
          typeof (value as { lines: unknown }).lines === 'object' && (value as { lines: object }).lines !== null
        ) {
          progressByExercise[key] = value as StudyStore['progressByExercise'][string]
        }
      }
    }
    return {
      activeExerciseId:
        typeof parsed.activeExerciseId === 'number' ? parsed.activeExerciseId : '',
      progressByExercise,
    }
  } catch {
    return createEmptyStore()
  }
}

/** 进度写回本地；调用方负责防抖，这里静默容忍配额/隐私模式异常。 */
export const persistStudyStore = (store: StudyStore) => {
  try {
    localStorage.setItem(STORE_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // 隐私模式或配额满：进度仅保留在内存，本次会话仍可用
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
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(activity))
  } catch {
    // 同上：静默降级
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
  try {
    localStorage.setItem(DAILY_GOAL_KEY, String(goal))
  } catch {
    // 静默降级：目标仅保留在内存
  }
}
