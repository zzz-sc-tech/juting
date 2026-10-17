/**
 * 学习偏好（本机 localStorage，键 juting.web.prefs.v1）：
 * - lyricsDefault / translationDefault：泛听字幕与译文的初始显示状态
 *   （控制条上的开关仍可随时切，这里只管「打开课程时的默认值」）
 * - defaultPlaybackRate：未手动调速课程的播放速率（手动调过即按课程记忆）
 */
import { safeSetItem } from './storageSafety'

export const RATE_OPTIONS = [0.75, 0.9, 1, 1.15, 1.3] as const

export type UserPrefs = {
  lyricsDefault: boolean
  translationDefault: boolean
  defaultPlaybackRate: number
  /** 精听连播：本句自然播完自动进下一句 */
  intensiveAutoAdvance: boolean
  /** 复习连播：本难句自然播完自动进下一句 */
  reviewAutoAdvance: boolean
  /** 复习顺序：最弱优先（按已听遍数降序）/ 原序 / 随机 */
  reviewOrder: 'original' | 'weakest' | 'random'
}

const USER_PREFS_KEY = 'juting.web.prefs.v1'

const DEFAULT_PREFS: UserPrefs = {
  lyricsDefault: true,
  translationDefault: true,
  defaultPlaybackRate: 1,
  intensiveAutoAdvance: false,
  reviewAutoAdvance: false,
  reviewOrder: 'weakest',
}

export const loadUserPrefs = (): UserPrefs => {
  try {
    const raw = localStorage.getItem(USER_PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<UserPrefs>
    return {
      lyricsDefault: typeof parsed.lyricsDefault === 'boolean' ? parsed.lyricsDefault : DEFAULT_PREFS.lyricsDefault,
      translationDefault:
        typeof parsed.translationDefault === 'boolean' ? parsed.translationDefault : DEFAULT_PREFS.translationDefault,
      defaultPlaybackRate: RATE_OPTIONS.includes(parsed.defaultPlaybackRate as (typeof RATE_OPTIONS)[number])
        ? (parsed.defaultPlaybackRate as number)
        : DEFAULT_PREFS.defaultPlaybackRate,
      intensiveAutoAdvance:
        typeof parsed.intensiveAutoAdvance === 'boolean' ? parsed.intensiveAutoAdvance : DEFAULT_PREFS.intensiveAutoAdvance,
      reviewAutoAdvance:
        typeof parsed.reviewAutoAdvance === 'boolean' ? parsed.reviewAutoAdvance : DEFAULT_PREFS.reviewAutoAdvance,
      reviewOrder:
        parsed.reviewOrder === 'original' || parsed.reviewOrder === 'random' || parsed.reviewOrder === 'weakest'
          ? parsed.reviewOrder
          : DEFAULT_PREFS.reviewOrder,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export const persistUserPrefs = (prefs: UserPrefs): void => {
  // 静默失败会让设置「看起来生效、刷新即回退」，改走安全写入上报
  safeSetItem(USER_PREFS_KEY, JSON.stringify(prefs))
}
