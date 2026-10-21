import { Flag } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { DialogueAnchor } from '@juting/shared'
import { useLanguage } from '../i18n/LanguageProvider'

/**
 * 对话锚点条：横排可点击的「第8–15题 / 对话 2 / Section A」等锚点标签。
 * 锚点由 extractDialogueAnchors 从字幕里的指令句推导（四六级真题的
 * 「Questions 8 to 11 are based on...」等），没有指令句的课程不渲染本条。
 *
 * 一节真题常有 16–20 个锚点。早先版本只常驻前 3 个 + 当前段、其余收进原生
 * 下拉，理由是「平铺会折成多行把字幕区挤下去」。但那把真题结构藏进了一个
 * 陌生的下拉框里——用户看不出里面是导航，也失去了「一眼看全 Section/材料/题组」
 * 的定位能力。现在改成单行横向滚动：全部锚点常驻、只占一行高度，当前段自动
 * 滚进视野，右缘渐隐提示还有更多（样式见 study-shell.css / responsive.css）。
 */
type DialogueAnchorBarProps = {
  anchors: DialogueAnchor[]
  /** 当前播放/选中句子所属的锚点 id，用于高亮当前区间。 */
  activeAnchorId?: string | null
  onJump: (anchor: DialogueAnchor) => void
}

export function DialogueAnchorBar({
  anchors,
  activeAnchorId,
  onJump,
}: DialogueAnchorBarProps) {
  const { t } = useLanguage()
  const barRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // 当前锚点变化时把它滚进视野（换句/跳段都会触发）。用 scrollIntoView 的
  // inline: 'nearest' + block: 'nearest'，避免整页纵向跳动。
  useEffect(() => {
    const el = activeRef.current
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeAnchorId])

  if (anchors.length === 0) {
    return null
  }

  return (
    <div className="dialogue-anchor-bar" aria-label={t('anchors.barLabel')} ref={barRef}>
      <span className="dialogue-anchor-bar-title">
        <Flag size={14} aria-hidden="true" />
        {t('anchors.barLabel')}
      </span>
      <div className="dialogue-anchor-chips" role="group">
        {anchors.map((anchor) => {
          const active = anchor.id === activeAnchorId
          return (
            <button
              className={active ? 'dialogue-anchor-chip active' : 'dialogue-anchor-chip'}
              key={anchor.id}
              onClick={() => onJump(anchor)}
              ref={active ? activeRef : undefined}
              title={t('anchors.jumpTooltip', { label: anchor.label })}
              type="button"
            >
              {anchor.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
