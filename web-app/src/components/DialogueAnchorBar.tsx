import { Flag } from 'lucide-react'
import type { DialogueAnchor } from '@juting/shared'
import { useLanguage } from '../i18n/LanguageProvider'

/**
 * 对话锚点条：横排可点击的「第8–11题 / 对话 2 / 第一节」等锚点标签。
 * 锚点由 extractDialogueAnchors 从字幕里的指令句推导（四六级真题的
 * 「听下面一段对话，回答第8至11题」等），没有指令句的课程不渲染本条。
 *
 * 一节真题常有 20+ 个锚点。全部平铺时，单是这条就占了首屏 17 个可操作项，
 * 而用户真正要跳的通常只有「Section A/B/C」和当前段。所以只常驻前 3 个 +
 * 当前段，其余收进一个原生下拉——任意段一次点击可达，功能不丢。
 */
type DialogueAnchorBarProps = {
  anchors: DialogueAnchor[]
  /** 当前播放/选中句子所属的锚点 id，用于高亮当前区间。 */
  activeAnchorId?: string | null
  onJump: (anchor: DialogueAnchor) => void
}

const PRIMARY_ANCHOR_COUNT = 3

export function DialogueAnchorBar({
  anchors,
  activeAnchorId,
  onJump,
}: DialogueAnchorBarProps) {
  const { t } = useLanguage()

  if (anchors.length === 0) {
    return null
  }

  const primary = anchors.slice(0, PRIMARY_ANCHOR_COUNT)
  const activeAnchor = anchors.find((anchor) => anchor.id === activeAnchorId)
  const showActiveChip =
    activeAnchor !== undefined && !primary.some((anchor) => anchor.id === activeAnchor.id)
  const visibleAnchors = showActiveChip && activeAnchor ? [...primary, activeAnchor] : primary
  const hasOverflow = anchors.length > visibleAnchors.length

  return (
    <div className="dialogue-anchor-bar" aria-label={t('anchors.barLabel')}>
      <span className="dialogue-anchor-bar-title">
        <Flag size={14} aria-hidden="true" />
        {t('anchors.barLabel')}
      </span>
      <div className="dialogue-anchor-chips" role="group">
        {visibleAnchors.map((anchor) => (
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
        {hasOverflow && (
          <label className="dialogue-anchor-select-wrap">
            <select
              aria-label={t('anchors.moreLabel')}
              className="dialogue-anchor-select"
              onChange={(event) => {
                const next = anchors.find((anchor) => anchor.id === event.target.value)
                if (next) onJump(next)
              }}
              /* 常驻占位文案，不跟随当前段：否则会和左边的当前段 chip 重复显示同一个标签 */
              value=""
            >
              <option value="">{t('anchors.moreOption', { count: anchors.length })}</option>
              {anchors.map((anchor) => (
                <option key={anchor.id} value={anchor.id}>
                  {anchor.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  )
}
