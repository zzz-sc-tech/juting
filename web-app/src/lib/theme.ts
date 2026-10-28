// 界面主题：paper=纸墨书房（默认） / gazette=黑白晨报 / minimal=极简白 / exam=油印试卷。
// 主题只改视觉令牌与装饰层，不碰任何行为；持久化在 localStorage。
//
// 明暗（mode）：跟随系统/浅色/深色三档。深色界面只由 paper 提供（paper-dark，
// 与安卓 charcoal 深色板同源取值）——其余三套主题各自是完整视觉身份，不做反转。
// mode 是独立维度（data-mode 属性），CSS 里只有 paper 的令牌板响应它。
import { safeSetItem } from './storageSafety'

export type UiTheme = 'paper' | 'gazette' | 'minimal' | 'exam'
export type ThemeMode = 'system' | 'light' | 'dark'

const THEME_KEY = 'juting.web.theme.v1'
const MODE_KEY = 'juting.web.mode.v1'

let modeMql: MediaQueryList | null = null
let modeListener: ((event: MediaQueryListEvent) => void) | null = null

export function isUiTheme(value: unknown): value is UiTheme {
  return (
    value === 'paper' ||
    value === 'gazette' ||
    value === 'minimal' ||
    value === 'exam'
  )
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function getStoredTheme(): UiTheme {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    return isUiTheme(raw) ? raw : 'paper'
  } catch {
    return 'paper'
  }
}

export function getStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    return isThemeMode(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(theme: UiTheme) {
  document.documentElement.dataset.theme = theme
}

/** 解析 mode 为实际明暗（system 跟随系统偏好）。 */
export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') {
    return mode
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * 应用明暗：写 data-mode 属性；system 档挂 matchMedia 监听实时跟随系统切换
 * （换档时先摘掉上一个监听，避免叠加）。
 */
export function applyMode(mode: ThemeMode) {
  if (modeListener && modeMql) {
    modeMql.removeEventListener('change', modeListener)
    modeMql = null
    modeListener = null
  }
  document.documentElement.dataset.mode = resolveMode(mode)
  if (mode === 'system') {
    try {
      modeMql = window.matchMedia('(prefers-color-scheme: dark)')
      modeListener = (event) => {
        document.documentElement.dataset.mode = event.matches ? 'dark' : 'light'
      }
      modeMql.addEventListener('change', modeListener)
    } catch {
      // matchMedia 不可用：保持首帧解析结果
    }
  }
}

export function persistTheme(theme: UiTheme) {
  // 写不进去时至少让用户知道（否则表现为「换主题后刷新又回去了」）
  safeSetItem(THEME_KEY, theme)
}

export function persistMode(mode: ThemeMode) {
  safeSetItem(MODE_KEY, mode)
}

// 首帧前调用一次，避免主题/明暗闪烁
export function initTheme(): UiTheme {
  const theme = getStoredTheme()
  applyTheme(theme)
  applyMode(getStoredMode())
  return theme
}
