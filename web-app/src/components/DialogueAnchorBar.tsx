import { Flag } from 'lucide-react'
import type { DialogueAnchor } from '@juting/shared'
import { useLanguage } from '../i18n/LanguageProvider'

/**
 * 对话锚点条：横排可点击的「第8–11题 / 对话 2 / 第一节」等锚点标签。
 * 锚点由 extractDialogueAnchors 从字幕里的指令句推导（四六级真题的
 * 「听下面一段对话，回答第8至11题」等），没有指令句的课程不渲染本条。
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

  if (anchors.length === 0) {
    return null
  }

  return (
    <div className="dialogue-anchor-bar" aria-label={t('anchors.barLabel')}>
      <span className="dialogue-anchor-bar-title">
        <Flag size={14} aria-hidden="true" />
        {t('anchors.barLabel')}
      </span>
      <div className="dialogue-anchor-chips" role="group">
        {anchors.map((anchor) => (
          <button
            className={
              anchor.id === activeAnchorId
                ? 'dialogue-anchor-chip active'
                : 'dialogue-anchor-chip'
            }
            key={anchor.id}
            onClick={() => onJump(anchor)}
            title={t('anchors.jumpTooltip', { label: anchor.label })}
            type="button"
          >
            {anchor.label}
          </button>
        ))}
      </div>
    </div>
  )
}
