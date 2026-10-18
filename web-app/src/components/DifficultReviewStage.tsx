import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Eye,
  Pause,
  Play,
  Repeat,
  RotateCcw,
} from 'lucide-react'
import { useCallback, useEffect, type RefObject } from 'react'
import type {
  ExerciseProgress,
  ListeningExercise,
  TranscriptLine,
} from '@juting/shared'
import { useLanguage } from '../i18n/LanguageProvider'
import { resolveLineTranslation } from '../lib/lineTranslation'
import { createLineProgress } from '../lib/progressStore'
import { resolveApiUrl } from '../lib/apiClient'
import { Tooltip } from './Tooltip'

type ReviewOrder = 'original' | 'weakest' | 'random'

type DifficultReviewStageProps = {
  exercise: ListeningExercise
  mediaRef: RefObject<HTMLMediaElement | null>
  progress: ExerciseProgress
  reviewLines: TranscriptLine[]
  selectedLine: TranscriptLine | null
  isPlaying: boolean
  /** 先听后看：揭晓前原文与译文都遮住（复习检验的是耳朵不是眼睛） */
  revealed: boolean
  onReveal: () => void
  onBackToIntensive: () => void
  onLineSelect: (lineId: string) => void
  /** D：仅移出难点池（不标掌握） */
  onRemoveFromPool: (lineId: string) => void
  /** F：攻克 = 标掌握并移出难点池 */
  onConquer: (lineId: string) => void
  onMoveReviewLine: (offset: number) => void
  onPlayLine: (line: TranscriptLine) => void
  onTogglePlayback: () => void
  /** 连播 / 顺序切换 / 本句送波形 A-B */
  autoAdvance: boolean
  onToggleAutoAdvance: () => void
  orderMode: ReviewOrder
  onCycleOrder: () => void
  onGoWaveLoop: (line: TranscriptLine) => void
}

export function DifficultReviewStage({
  exercise,
  mediaRef,
  progress,
  reviewLines,
  selectedLine,
  isPlaying,
  revealed,
  onReveal,
  onBackToIntensive,
  onLineSelect,
  onRemoveFromPool,
  onConquer,
  onMoveReviewLine,
  onPlayLine,
  onTogglePlayback,
  autoAdvance,
  onToggleAutoAdvance,
  orderMode,
  onCycleOrder,
  onGoWaveLoop,
}: DifficultReviewStageProps) {
  const { t, contentLocale } = useLanguage()
  // 译文权威字段是 translations[contentLocale]（line.translation 对新数据为空），
  // 与泛听/精听同走 resolveLineTranslation；空串=隐藏译文层。
  const translation = selectedLine
    ? resolveLineTranslation(selectedLine, contentLocale)
    : ''
  const translationVisible = Boolean(translation)
  const selectedIndex = selectedLine
    ? reviewLines.findIndex((line) => line.id === selectedLine.id)
    : -1
  const selectedProgress = selectedLine
    ? progress.lines[selectedLine.id] ?? createLineProgress()
    : createLineProgress()
  const orderLabel = orderMode === 'weakest'
    ? t('review.orderWeakest')
    : orderMode === 'random'
      ? t('review.orderRandom')
      : t('review.orderOriginal')

  // 键盘快捷键
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!selectedLine) return
      const target = event.target instanceof HTMLElement ? event.target : null
      // 输入类控件聚焦时字母属于打字、空格/方向属于原生行为，快捷键一概让位
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const onActivatable = target?.closest('button, a')
      if (onActivatable && (event.key === ' ' || event.key.startsWith('Arrow'))) return

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault()
          onMoveReviewLine(-1)
          break
        case 'ArrowRight':
          event.preventDefault()
          onMoveReviewLine(1)
          break
        case ' ':
          event.preventDefault()
          if (isPlaying) {
            onTogglePlayback()
          } else {
            onPlayLine(selectedLine)
          }
          break
        case 'q':
        case 'Q':
          event.preventDefault()
          onPlayLine(selectedLine)
          break
        case 'r':
        case 'R':
          event.preventDefault()
          onReveal()
          break
        case 'd':
        case 'D':
          event.preventDefault()
          onRemoveFromPool(selectedLine.id)
          break
        case 'f':
        case 'F':
          event.preventDefault()
          onConquer(selectedLine.id)
          break
      }
    },
    [
      selectedLine,
      isPlaying,
      onMoveReviewLine,
      onTogglePlayback,
      onPlayLine,
      onReveal,
      onRemoveFromPool,
      onConquer,
    ],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  if (reviewLines.length === 0 || !selectedLine) {
    return (
      <section className="stage-board difficult-review-board">
        <div className="review-empty-card">
          <CircleHelp size={26} aria-hidden="true" />
          <strong>{t('review.emptyTitle')}</strong>
          <button className="icon-button primary wide" onClick={onBackToIntensive} type="button">
            {t('review.backToIntensive')}
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="stage-board difficult-review-board">
      <div className="review-workbench">
        <div className="lesson-media-card review-media-card">
          {exercise.mediaType === 'video' ? (
            <video
              ref={mediaRef as RefObject<HTMLVideoElement | null>}
              className="lesson-media lesson-video"
              playsInline
              preload="metadata"
              src={resolveApiUrl(exercise.audioUrl)}
            />
          ) : (
            <audio
              ref={mediaRef as RefObject<HTMLAudioElement | null>}
              className="lesson-media lesson-audio"
              preload="metadata"
              src={resolveApiUrl(exercise.audioUrl)}
            />
          )}

          <div className="media-subtitle-overlay review-subtitle-overlay">
            <div className="subtitle-topline">
              <span>{String(selectedIndex + 1).padStart(2, '0')} / {reviewLines.length}</span>
              <span className="subtitle-topline-right">
                <button
                  className={autoAdvance ? 'subtitle-chip on' : 'subtitle-chip'}
                  onClick={onToggleAutoAdvance}
                  type="button"
                  aria-pressed={autoAdvance}
                >
                  {t('intensive.autoAdvance')}
                </button>
                <button
                  className="subtitle-chip"
                  onClick={onCycleOrder}
                  title={t('review.orderLabel')}
                  type="button"
                >
                  {orderLabel}
                </button>
                <span className="subtitle-repeat-count">
                  {selectedProgress.repeatCount
                    ? t('intensive.repeatCount', { count: selectedProgress.repeatCount })
                    : ''}
                </span>
              </span>
            </div>
            <p className={revealed ? 'subtitle-text revealed' : 'subtitle-text'}>
              <span className="line-body" key={selectedLine.id}>
                {revealed ? (
                  selectedLine.text
                ) : (
                  <span className="subtitle-placeholder">{t('review.transcriptHint')}</span>
                )}
              </span>
            </p>
            <p className={revealed && translationVisible ? 'subtitle-translation revealed' : 'subtitle-translation hidden'}>
              {revealed && translationVisible ? translation : ' '}
            </p>
          </div>

          <div className="media-overlay-controls" aria-label={t('review.mediaControlsLabel')}>
            <div className="control-cluster">
              <Tooltip label={t('review.previousTooltip')} shortcut="←">
                <button
                  className="icon-button"
                  disabled={selectedIndex <= 0}
                  onClick={() => onMoveReviewLine(-1)}
                  type="button"
                >
                  <ChevronLeft size={18} aria-hidden="true" />
                  <span>{t('review.previous')}</span>
                </button>
              </Tooltip>
              <Tooltip label={isPlaying ? t('review.pause') : t('review.playLineTooltip')} shortcut={t('review.spaceShortcut')}>
                <button
                  className="icon-button primary wide"
                  onClick={isPlaying ? onTogglePlayback : () => onPlayLine(selectedLine)}
                  type="button"
                >
                  {isPlaying
                    ? <Pause size={18} aria-hidden="true" />
                    : <Play size={18} aria-hidden="true" />}
                  <span>{isPlaying ? t('review.pause') : t('review.play')}</span>
                </button>
              </Tooltip>
              <Tooltip label={t('intensive.replaySentence')} shortcut="Q">
                <button
                  className="icon-button"
                  onClick={() => onPlayLine(selectedLine)}
                  type="button"
                >
                  <RotateCcw size={18} aria-hidden="true" />
                  <span>{t('intensive.replayShort')}</span>
                </button>
              </Tooltip>
              <Tooltip label={t('intensive.showTranscript')} shortcut="R">
                <button
                  className={revealed ? 'icon-button reveal' : 'icon-button'}
                  aria-pressed={revealed}
                  onClick={onReveal}
                  type="button"
                >
                  <Eye size={18} aria-hidden="true" />
                  <span>{t('intensive.transcript')}</span>
                </button>
              </Tooltip>
              <Tooltip label={t('review.nextTooltip')} shortcut="→">
                <button
                  className="icon-button"
                  disabled={selectedIndex >= reviewLines.length - 1}
                  onClick={() => onMoveReviewLine(1)}
                  type="button"
                >
                  <ChevronRight size={18} aria-hidden="true" />
                  <span>{t('review.next')}</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="status-actions review-status-actions">
          <Tooltip label={t('review.removeDifficult')} shortcut="D">
            <button
              className="pill active"
              onClick={() => onRemoveFromPool(selectedLine.id)}
              type="button"
            >
              <CircleHelp size={18} aria-hidden="true" />
              {t('review.removeDifficult')}
            </button>
          </Tooltip>
          <Tooltip label={t('review.conquer')} shortcut="F">
            <button
              className={selectedProgress.mastered ? 'pill success' : 'pill primary'}
              onClick={() => onConquer(selectedLine.id)}
              type="button"
            >
              <CheckCircle2 size={18} aria-hidden="true" />
              {t('review.conquer')}
            </button>
          </Tooltip>
          <Tooltip label={t('intensive.goWaveLoop')}>
            <button
              className="pill"
              onClick={() => onGoWaveLoop(selectedLine)}
              type="button"
            >
              <Repeat size={18} aria-hidden="true" />
              {t('intensive.goWaveLoop')}
            </button>
          </Tooltip>
        </div>
      </div>

      <aside className="transcript-panel compact-panel level-list difficult-list">
        <div className="panel-title">
          <CircleHelp size={17} aria-hidden="true" />
          <span>{t('review.sentenceListTitle')}</span>
        </div>
        <ol className="line-list">
          {reviewLines.map((line, index) => {
            const item = progress.lines[line.id] ?? createLineProgress()
            return (
              <li
                className={
                  selectedLine.id === line.id
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
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="line-copy">{line.text}</span>
                </button>
                <div className="line-actions">
                  {item.repeatCount > 0 && (
                    <span className="line-repeat-count" title={t('intensive.repeatCount', { count: item.repeatCount })}>
                      {item.repeatCount}
                    </span>
                  )}
                  {item.mastered && (
                    <span className="line-flag mastered" title={t('transcript.flagMastered')}>
                      <Check size={13} aria-hidden="true" />
                      <span className="sr-only">{t('transcript.flagMastered')}</span>
                    </span>
                  )}
                  <span className="line-flag unclear" title={t('transcript.flagUnclear')}>
                    <CircleAlert size={13} aria-hidden="true" />
                    <span className="sr-only">{t('transcript.flagUnclear')}</span>
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      </aside>
    </section>
  )
}
