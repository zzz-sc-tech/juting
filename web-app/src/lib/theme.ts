// 界面主题：paper=纸墨书房（默认） / gazette=黑白晨报。
// 主题只改视觉令牌与装饰层，不碰任何行为；持久化在 localStorage。
export type UiTheme = 'paper' | 'gazette'

const THEME_KEY = 'juting.web.theme.v1'

export function isUiTheme(value: unknown): value is UiTheme {
  return value === 'paper' || value === 'gazette'
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
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // 隐私模式/配额异常时静默：主题下次启动回退默认
  }
}

// 首帧前调用一次，避免主题闪烁
export function initTheme(): UiTheme {
  const theme = getStoredTheme()
  applyTheme(theme)
  return theme
}
