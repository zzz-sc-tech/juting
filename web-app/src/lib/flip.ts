/**
 * FLIP（First-Last-Invert-Play）列表位移动画，纯 Web Animations API，不引库。
 *
 * 拆成 capture / play 两段而不是「capture → mutate → play」一体的原因：
 * mutate 在 React 里是 setState，DOM 更新发生在提交时（异步）——play 必须等
 * React commit 之后再执行，Last 位置的测量才有意义。调用方在 setState 前用
 * capturePositions 存 First，setState 后用 playFlip 播放（内部双 rAF 等 commit）。
 *
 * 红线：只动 transform / opacity；列表塌陷用 FLIP 而不是 height 过渡。
 */

export type FlipOptions = {
  /** FLIP 位移时长；新增项淡入共用此值 */
  duration?: number
  easing?: string
}

/** First：记录变更前所有直接子元素的位置。 */
export const capturePositions = (container: HTMLElement): Map<HTMLElement, DOMRect> => {
  const first = new Map<HTMLElement, DOMRect>()
  for (const el of Array.from(container.children) as HTMLElement[]) {
    first.set(el, el.getBoundingClientRect())
  }
  return first
}

/**
 * Last + Invert + Play：对位移过的子元素做 translateY 反演回放；
 * First 里没有的子元素视为新增，做 scale(0.96) 淡入（不用位移，避免与 FLIP 打架）。
 * 内部双 rAF：确保 React commit 与布局刷新都已完成。
 */
export const playFlip = (
  container: HTMLElement,
  first: Map<HTMLElement, DOMRect>,
  { duration = 200, easing = 'cubic-bezier(0.22, 1, 0.36, 1)' }: FlipOptions = {},
): void => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const el of Array.from(container.children) as HTMLElement[]) {
        const prev = first.get(el)
        if (!prev) {
          el.animate(
            [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'scale(1)' }],
            { duration, easing, fill: 'both' },
          )
          continue
        }
        const next = el.getBoundingClientRect()
        const dy = prev.top - next.top
        if (Math.abs(dy) < 1) continue
        el.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
          { duration, easing, fill: 'both' },
        )
      }
    })
  })
}
