// 界面主题：paper=纸墨书房（默认） / gazette=黑白晨报 / minimal=极简白 / exam=油印试卷。
// 主题只改视觉令牌与装饰层，不碰任何行为；持久化在 localStorage。
import { safeSetItem } from './storageSafety'

export type UiTheme = 'paper' | 'gazette' | 'minimal' | 'exam'

const THEME_KEY = 'juting.web.theme.v1'

export function isUiTheme(value: unknown): value is UiTheme {
  return (
    value === 'paper' ||
    value === 'gazette' ||
    value === 'minimal' ||
    value === 'exam'
  )
}

export function getStoredTheme(): UiTheme {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    return isUiTheme(raw) ? raw : 'paper'
  } catch {
    return 'paper'
  }
}

export function applyTheme(theme: UiTheme) {
  document.documentElement.dataset.theme = theme
}

export function persistTheme(theme: UiTheme) {
  // 写不进去时至少让用户知道（否则表现为「换主题后刷新又回去了」）
  safeSetItem(THEME_KEY, theme)
}

// 首帧前调用一次，避免主题闪烁
export function initTheme(): UiTheme {
  const theme = getStoredTheme()
  applyTheme(theme)
  return theme
}
