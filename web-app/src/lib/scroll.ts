/**
 * 滚动行为统一入口。
 *
 * CSS 的 `scroll-behavior: auto !important`（motion.css 的 reduced-motion 兜底）
 * 管不住 JS 里显式的 `behavior: 'smooth'`——开了系统「减少动态效果」之后，
 * 页面切换已经瞬间完成，列表却还在慢慢滑。所有程序化滚动都走这里。
 */
export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export const smoothOrAuto = (): ScrollBehavior =>
  prefersReducedMotion() ? 'auto' : 'smooth'
