import { ChevronDown, ListChecks } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExerciseProgress,
  ListeningExercise,
  TranscriptLine,
} from '@juting/shared'
import type { StudySection } from '../lib/studySections'
import { createLineProgress } from '../lib/progressStore'
import { useLanguage } from '../i18n/LanguageProvider'

const shortLine = (line: TranscriptLine) =>
  line.text.length > 82 ? `${line.text.slice(0, 82)}...` : line.text

type TranscriptPanelProps = {
  exercise: ListeningExercise
  progress: ExerciseProgress
  selectedLineId: string
  hideSelectedLineCopy?: boolean
  revealedLineIds: Record<string, true>
  /** 按锚点切好的分组（正文句 + 指令介绍）；无锚点课程为单组。 */
  sections: StudySection[]
  onLineSelect: (lineId: string) => void
  /** 纯题干播报组（无正文句）点击组头时的跳转回调。 */
}

/**
 * 章节句子列表（手风琴）：按对话锚点分组，平时只显示分组标签行，
 * 点击展开该段正文句；选中句变化时自动展开所在组并滚动定位。
 * 指令行（报头/介绍/题干播报）不出现在学习句子中，仅以弱化文本展示在组内顶部。
 */
export function TranscriptPanel({
  exercise,
  progress,
  selectedLineId,
  hideSelectedLineCopy = false,
  revealedLineIds,
  sections,
  onLineSelect,
}: TranscriptPanelProps) {
  const { t } = useLanguage()
  const listRef = useRef<HTMLOListElement | null>(null)
  // 「平时收起」：初始所有分组都收起；选中句变化时自动展开所在组（见下方 effect）。
  // 无锚点课程（flatMode 单组）不收起，保持平铺。
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    const singleFlat = sections.length <= 1 && sections[0]?.anchor === null
    if (singleFlat) {
      return new Set()
    }
    return new Set(sections.map((section) => section.id))
  })

  // 对答案开关：默认隐藏，避免做题时被剧透；换课程时自动收回隐藏态。
  const [answersShown, setAnswersShown] = useState(false)
  useEffect(() => {
    setAnswersShown(false)
  }, [exercise.id])

  /** 题组锚点标签（Q1–4 / Q19）→ 题号区间；非题组返回 null。 */
  const questionRangeOf = (label: string): [number, number] | null => {
    const match = label.match(/^Q\s*(\d+)\s*[–\-—]\s*(\d+)$/) ?? label.match(/^Q\s*(\d+)$/)
    if (!match) return null
    const start = Number(match[1])
    return [start, match[2] ? Number(match[2]) : start]
  }

  /** 该题组在答案钥匙里的字母串，如 "ACBD"；缺题跳过，整组无答案返回 null。 */
  const answersOfRange = (start: number, end: number): string | null => {
    const key = exercise.answerKey
    if (!key) return null
    let letters = ''
    for (let n = start; n <= end; n += 1) {
      const letter = key[String(n)]
      if (letter) letters += letter
    }
    return letters || null
  }

  const sectionOfSelected = useMemo(
    () => sections.find((section) => section.lines.some((line) => line.id === selectedLineId)) ?? null,
    [sections, selectedLineId],
  )

  // 选中句变化：自动展开所在组（其余保持原状，不强制收起）。
  useEffect(() => {
    if (!sectionOfSelected) {
      return
    }
    setCollapsedIds((current) => {
      if (!current.has(sectionOfSelected.id)) {
        return current
      }
      const next = new Set(current)
      next.delete(sectionOfSelected.id)
      return next
    })
  }, [sectionOfSelected])

  // 选中句滚动定位：只滚列表自身，避免连带外层容器抽动。
  useEffect(() => {
    const container = listRef.current
    if (!container) return

    const activeItem = container.querySelector<HTMLElement>('.line-row.active')
    if (!activeItem) return

    const panel = container.closest<HTMLElement>('.compact-panel')
    if (!panel) return
    const panelRect = panel.getBoundingClientRect()
    const itemRect = activeItem.getBoundingClientRect()
    panel.scrollTo({
      top:
        panel.scrollTop +
        (itemRect.top - panelRect.top) -
        panel.clientHeight / 2 +
        itemRect.height / 2,
      behavior: 'smooth',
    })
  }, [selectedLineId, collapsedIds])

  const toggleSection = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // 无锚点的课程：单组且不显示分组头，保持原有平铺行为（零回归）。
  const flatMode = sections.length <= 1 && sections[0]?.anchor === null
  const visibleSections = flatMode
    ? [{ ...sections[0], id: 'all' }]
    : sections

  return (
    <aside className="transcript-panel compact-panel level-list">
      <div className="panel-title">
        <ListChecks size={17} aria-hidden="true" />
        <span>{t('transcript.panelTitle')}</span>
        {exercise.answerKey && (
          <button
            className="answer-toggle"
            onClick={() => setAnswersShown((current) => !current)}
            type="button"
          >
            {answersShown ? t('transcript.hideAnswers') : t('transcript.showAnswers')}
          </button>
        )}
      </div>
      <ol className="line-list" ref={listRef}>
        {visibleSections.map((section) => {
          const collapsed = !flatMode && collapsedIds.has(section.id)
          return (
            <Fragment key={section.id}>
              {!flatMode && section.lines.length === 0 && (
                // 纯指令组（开场 / Section A、B、C 的播报说明）：固化为不可点击的
                // 标签——精听不听指令，可点击的分组头只会误导（点击还可能跳播指令）。
                <li className="anchor-section-head static">
                  <span className="anchor-section-label">{section.label}</span>
                </li>
              )}
              {!flatMode && section.lines.length > 0 && (
                <li className="anchor-section-head">
                  <button
                    aria-expanded={!collapsed}
                    onClick={() => {
                      toggleSection(section.id)
                    }}
                    type="button"
                  >
                    <span className="anchor-section-label">{section.label}</span>
                    {answersShown && (() => {
                      const range = questionRangeOf(section.label)
                      if (!range) return null
                      const letters = answersOfRange(range[0], range[1])
                      if (!letters) return null
                      return (
                        <span className="anchor-section-answers" aria-label={t('transcript.showAnswers')}>
                          {Array.from(letters).map((letter, index) => (
                            <span key={`${range[0] + index}`}>{range[0] + index}{letter}</span>
                          ))}
                        </span>
                      )
                    })()}
                    <span className="anchor-section-count">
                      {section.lines.length > 0
                        ? t('transcript.groupSentences', { count: section.lines.length })
                        : null}
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className={collapsed ? 'anchor-section-chevron' : 'anchor-section-chevron open'}
                      size={15}
                    />
                  </button>
                </li>
              )}
              {!collapsed && section.introText && (
                <li className="anchor-section-intro" title={section.introText}>
                  {section.introText}
                </li>
              )}
              {!collapsed &&
                section.lines.map((line) => {
                  const item = progress.lines[line.id] ?? createLineProgress()
                  const lineVisible = Boolean(revealedLineIds[line.id]) || item.mastered
                  const globalIndex = exercise.lines.findIndex((l) => l.id === line.id)
                  return (
                    <li
                      className={
                        selectedLineId === line.id
                          ? 'line-row active'
                          : item.mastered
                            ? 'line-row mastered'
                            : 'line-row'
                      }
                      key={line.id}
                    >
                      <button
                        className="line-main"
                        onClick={() => onLineSelect(line.id)}
                        type="button"
                      >
                        <span className="line-index">
                          {String(globalIndex + 1).padStart(2, '0')}
                        </span>
                        <span
                          className={
                            selectedLineId === line.id && hideSelectedLineCopy
                              ? 'line-copy is-selected-hint'
                              : 'line-copy'
                          }
                        >
                          {selectedLineId === line.id && hideSelectedLineCopy
                            ? t('transcript.selectedLineHint')
                            : lineVisible
                              ? shortLine(line)
                              : t('transcript.hiddenLineChallenge')}
                        </span>
                      </button>
                      <div className="line-actions">
                        {item.unclear && <span className="status-dot warning" />}
                        {item.mastered && <span className="status-dot success" />}
                      </div>
                    </li>
                  )
                })}
            </Fragment>
          )
        })}
      </ol>
    </aside>
  )
}
