import * as Popover from '@radix-ui/react-popover'
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Eye,
  Gauge,
  Pause,
  Play,
  Repeat,
  RotateCcw,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
import { Tooltip } from './Tooltip'
import { DictationPanel } from './DictationPanel'
import { DialogueAnchorBar } from './DialogueAnchorBar'
import { VocabSidebar } from './VocabSidebar'
import type {
  DialogueAnchor,
  ExerciseProgress,
  LineProgress,
  ListeningExercise,
  TranscriptLine,
} from '@juting/shared'
import type { StudySection } from '../lib/studySections'
import { TranscriptPanel } from './TranscriptPanel'
import { useLanguage } from '../i18n/LanguageProvider'
import { resolveApiUrl } from '../lib/apiClient'
import { splitClickableWords } from '../lib/clickableText'
import { resolveLineTranslation } from '../lib/lineTranslation'
import { loadUserPrefs, RATE_OPTIONS } from '../lib/userPrefs'

type IntensiveStageProps = {
  exercise: ListeningExercise
  mediaRef: RefObject<HTMLMediaElement | null>
  progress: ExerciseProgress
  selectedLine: TranscriptLine
  selectedLineIndex: number
  /** 换句方向（上句 prev / 其余 next），容器在方向源事件里设置 */
  lineDirection: 'prev' | 'next'
  lineProgress: LineProgress
  revealedLineIds: Record<string, true>
  isPlaying: boolean
  dialogueAnchors: DialogueAnchor[]
  sections: StudySection[]
  activeAnchorId: string | null
  onJumpToAnchor: (anchor: DialogueAnchor) => void
  onPlayLine: (line: TranscriptLine) => void
  onTogglePlayback: () => void
  onMoveLine: (offset: number) => void
  onRevealLine: (lineId: string) => void
  onPlaybackRateChange: (rate: number) => void
  onMarkUnclear: (lineId: string) => void
  onMarkMastered: (lineId: string) => void
  onLineSelect: (lineId: string) => void
  /** 连播：本句自然播完自动进下一句 */
  autoAdvance: boolean
  onToggleAutoAdvance: () => void
  /** 本句送波形 A-B 循环 */
  onGoWaveLoop: (line: TranscriptLine) => void
  /** 收藏生词（多个词用空白/逗号分隔），存入本课 vocabulary */
  onAddVocabulary: (words: string[]) => void
  /** 从本课生词本移除（词典侧栏里点「已收藏」时用） */
  onRemoveVocabulary: (word: string) => void
  /** 词典侧栏例句跳转：跳到 courseId 的 lineId */
  onJumpToLine: (courseId: number, lineId: string) => void
  /** courseId → 课标题（词典侧栏标注例句来源） */
  courseTitles?: Record<number, string>
}

const playbackRates = RATE_OPTIONS

const formatLineDuration = (start: number, end: number) => {
  const durationSeconds = Math.max(0, end - start)
  const roundedDuration = Math.round(durationSeconds * 100) / 100
  return Number.isInteger(roundedDuration)
    ? `${roundedDuration}s`
    : `${roundedDuration.toFixed(2).replace(/\.?0+$/, '')}s`
}

/**
 * 字幕正文逐词渲染：词形可点（唤起词典侧栏），标点与空白原样保留。
 * 词形不做 tab 焦点（一句话上百个词，全进 Tab 序列反而没法用），
 * 键盘用户仍可用「+生词」手动输入入口。
 * 可点性的视觉提示交给 CSS（虚线下边线），不挂原生 title——
 * 鼠标扫过整句会连续弹 tooltip，读句子时很干扰。
 */
function ClickableSentence({
  text,
  onPickWord,
}: {
  text: string
  onPickWord: (word: string) => void
}) {
  const parts = useMemo(() => splitClickableWords(text), [text])
  return (
    <>
      {parts.map((part, index) =>
        part.type === 'word' ? (
          <span
            className="clickable-word"
            key={`${index}-${part.text}`}
            onClick={() => {
              // 用户在拖选复制某个词时不要弹出侧栏，把选择让给浏览器
              if (!window.getSelection()?.isCollapsed) return
              onPickWord(part.text)
            }}
          >
            {part.text}
          </span>
        ) : (
          <span className="clickable-gap" key={`${index}-gap`}>
            {part.text}
          </span>
        ),
      )}
    </>
  )
}

export function IntensiveStage({
  exercise,
  mediaRef,
  progress,
  selectedLine,
  selectedLineIndex,
  lineDirection,
  lineProgress,
  revealedLineIds,
  isPlaying,
  dialogueAnchors,
  sections,
  activeAnchorId,
  onJumpToAnchor,
  onPlayLine,
  onTogglePlayback,
  onMoveLine,
  onRevealLine,
  onPlaybackRateChange,
  onMarkUnclear,
  onMarkMastered,
  onLineSelect,
  autoAdvance,
  onToggleAutoAdvance,
  onGoWaveLoop,
  onAddVocabulary,
  onRemoveVocabulary,
  onJumpToLine,
  courseTitles,
}: IntensiveStageProps) {
  const [ratePickerOpen, setRatePickerOpen] = useState(false)
  // 听写模式：开启后字幕区被听写面板取代（强制用耳朵），跨句保持
  const [dictationOn, setDictationOn] = useState(false)
  // 生词收藏 popover
  const [vocabOpen, setVocabOpen] = useState(false)
  const [vocabInput, setVocabInput] = useState('')
  const [vocabSaved, setVocabSaved] = useState(false)
  // 词典侧栏：点句中单词唤起，右侧滑出（存词形本身，其余从词条派生）
  const [dictWord, setDictWord] = useState<string | null>(null)
  // 译文开关：默认开（保持既有行为），做题时不想看可以关掉
  const [translationOn, setTranslationOn] = useState(() => loadUserPrefs().translationDefault)
  // 默认倍速只读一次：原先在 JSX 里连着调 3 次 loadUserPrefs()，
  // 等于每次渲染做 3 次同步 localStorage 读 + JSON.parse（D5）
  const defaultRate = useMemo(() => loadUserPrefs().defaultPlaybackRate, [])
  const effectiveRate = progress.playbackRate ?? defaultRate
  const { t, contentLocale } = useLanguage()
  const sentenceVisible = Boolean(revealedLineIds[selectedLine.id])
  // 译文行只在「真的有译文且与原文不同」时显示：接口若把原文回填进译文，
  // 这里会渲染成同一句英文出现两次。译文权威数据在 translations[contentLocale]。
  const resolvedTranslation = resolveLineTranslation(selectedLine, contentLocale)
  const translationVisible = translationOn && Boolean(resolvedTranslation)

  // 点到的词是否已在生词本（历史数据里词形大小写不统一，比对时忽略大小写）
  const dictWordSaved = useMemo(() => {
    if (!dictWord) return false
    const target = dictWord.toLowerCase()
    return Object.keys(progress.vocabulary ?? {}).some((key) => key.toLowerCase() === target)
  }, [dictWord, progress.vocabulary])

  // 词典侧栏的本课行文本：正文句已在内存里，直接给；锚点行（不在正文句集）
  // 查不到会由侧栏按需拉整课，省一次请求
  const localLines = useMemo(
    () => ({
      [exercise.id]: Object.fromEntries(exercise.lines.map((line) => [line.id, line.text])),
    }),
    [exercise],
  )

  const handleMarkMastered = useCallback(() => {
    // 点击"我已掌握"时触发一次显示字幕
    if (!sentenceVisible) {
      onRevealLine(selectedLine.id)
    }
    onMarkMastered(selectedLine.id)
  }, [sentenceVisible, onRevealLine, onMarkMastered, selectedLine.id])

  useEffect(() => {
    setVocabOpen(false)
    setVocabInput('')
    setVocabSaved(false)
    // 换句即收起词典侧栏：留着上一个词的释义会误导
    setDictWord(null)
  }, [selectedLine.id])

  // 键盘快捷键
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // 词典侧栏优先响应 Esc（此时不抢占方向键/播放等学习快捷键）
      if (event.key === 'Escape' && dictWord) {
        setDictWord(null)
        return
      }
      // 如果 Popover 打开，不响应快捷键
      if (ratePickerOpen) return

      const target = event.target instanceof HTMLElement ? event.target : null
      // 输入类控件聚焦时字母属于打字、空格/方向属于原生行为，快捷键一概让位
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      // 按钮/链接聚焦时只保留空格与方向键的原生激活行为，字母快捷键照常
      const onActivatable = target?.closest('button, a')
      if (onActivatable && (event.key === ' ' || event.key.startsWith('Arrow'))) return
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault()
          onMoveLine(-1)
          break
        case 'ArrowRight':
          event.preventDefault()
          onMoveLine(1)
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
          // 重播本句：无论当前是否在播放，都从本句开头重新播放。
          event.preventDefault()
          onPlayLine(selectedLine)
          break
        case 'f':
        case 'F':
          handleMarkMastered()
          break
        case 'd':
        case 'D':
          onMarkUnclear(selectedLine.id)
          break
        case 'r':
        case 'R':
          onRevealLine(selectedLine.id)
          break
      }
    },
    [
      dictWord,
      ratePickerOpen,
      isPlaying,
      onMoveLine,
      onTogglePlayback,
      onPlayLine,
      selectedLine,
      onMarkUnclear,
      onRevealLine,
      handleMarkMastered,
    ],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <section className="stage-board intensive-board">
      <DialogueAnchorBar
        anchors={dialogueAnchors}
        activeAnchorId={activeAnchorId}
        onJump={onJumpToAnchor}
      />
      <div className="sentence-workbench">
        <div className="lesson-media-card">
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

          <div className="media-subtitle-overlay">
            <div className="subtitle-topline">
              <span>{String(selectedLineIndex + 1).padStart(2, '0')} / {exercise.lines.length}</span>
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
                  className={translationOn ? 'subtitle-chip on' : 'subtitle-chip'}
                  onClick={() => setTranslationOn((current) => !current)}
                  type="button"
                  aria-pressed={translationOn}
                >
                  {t('intensive.translationToggle')}
                </button>
                <button
                  className={dictationOn ? 'subtitle-chip on' : 'subtitle-chip'}
                  onClick={() => setDictationOn((current) => !current)}
                  type="button"
                  aria-pressed={dictationOn}
                >
                  {t('intensive.dictation')}
                </button>
                <span className="subtitle-repeat-count">
                  {lineProgress.repeatCount
                    ? t('intensive.repeatCount', { count: lineProgress.repeatCount })
                    : ''}
                </span>
                <span>{formatLineDuration(selectedLine.start, selectedLine.end)}</span>
              </span>
            </div>
            {!dictationOn && (
              <p className={sentenceVisible ? 'subtitle-text revealed' : 'subtitle-text'}>
                {/* 槽（.line-body）始终在 DOM 里，换句只换内容：
                    原先未揭晓时整块不渲染，换句动画根本没有承载者，
                    而且卡片高度随字幕行数跳动 67px。 */}
                <span key={selectedLine.id} className={`line-body dir-${lineDirection}`}>
                  {sentenceVisible ? (
                    <ClickableSentence
                      text={selectedLine.text}
                      onPickWord={(word) =>
                        // 再点同一个词 = 收起（遮罩不吃点击，想换词得能直接点）
                        setDictWord((current) => (current === word ? null : word))
                      }
                    />
                  ) : (
                    /* 空态给一句提示，而不是留一块空白板——否则用户以为字幕坏了 */
                    <span className="subtitle-placeholder">{t('intensive.transcriptHint')}</span>
                  )}
                </span>
              </p>
            )}
            {dictationOn ? (
              <DictationPanel
                key={selectedLine.id}
                line={selectedLine}
                onPlayLine={onPlayLine}
                onAddVocabulary={onAddVocabulary}
                onMarkUnclear={onMarkUnclear}
              />
            ) : (
              <p className={sentenceVisible ? 'subtitle-translation revealed' : 'subtitle-translation hidden'}>
                {translationVisible ? resolvedTranslation : ' '}
              </p>
            )}
          </div>

          <div className="media-overlay-controls" aria-label={t('intensive.controlsLabel')}>
            <div className="control-cluster">
              <Tooltip label={t('intensive.prevSentence')} shortcut="←">
                <button
                  className="icon-button"
                  disabled={selectedLineIndex === 0}
                  onClick={() => onMoveLine(-1)}
                  type="button"
                >
                  <ChevronLeft size={18} aria-hidden="true" />
                  <span>{t('intensive.prevShort')}</span>
                </button>
              </Tooltip>
              <Tooltip label={isPlaying ? t('intensive.pause') : t('intensive.playLine')} shortcut={t('intensive.spaceKey')}>
                <button
                  className="icon-button primary wide"
                  onClick={isPlaying ? onTogglePlayback : () => onPlayLine(selectedLine)}
                  type="button"
                >
                  {isPlaying
                    ? <Pause size={18} aria-hidden="true" />
                    : <Play size={18} aria-hidden="true" />}
                  <span>{isPlaying ? t('intensive.pausePlayback') : t('intensive.playLine')}</span>
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
                  className={sentenceVisible ? 'icon-button reveal' : 'icon-button'}
                  aria-pressed={sentenceVisible}
                  onClick={() => onRevealLine(selectedLine.id)}
                  type="button"
                >
                  <Eye size={18} aria-hidden="true" />
                  <span>{t('intensive.transcript')}</span>
                </button>
              </Tooltip>
              <Tooltip label={t('intensive.nextSentence')} shortcut="→">
                <button
                  className="icon-button"
                  disabled={selectedLineIndex >= exercise.lines.length - 1}
                  onClick={() => onMoveLine(1)}
                  type="button"
                >
                  <ChevronRight size={18} aria-hidden="true" />
                  <span>{t('intensive.nextShort')}</span>
                </button>
              </Tooltip>
            </div>
            <Popover.Root open={ratePickerOpen} onOpenChange={setRatePickerOpen}>
              <div className="rate-control compact-rate" aria-label={t('intensive.rateLabel')}>
                <Gauge size={17} aria-hidden="true" />
                <Popover.Trigger asChild>
                  <button
                    aria-expanded={ratePickerOpen}
                    className={ratePickerOpen ? 'rate-trigger active' : 'rate-trigger'}
                    type="button"
                  >
                    <span className="rate-value">{effectiveRate}x</span>
                    <ChevronDown size={24} strokeWidth={3} aria-hidden="true" />
                  </button>
                </Popover.Trigger>
              </div>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  className="rate-popover"
                  side="bottom"
                  sideOffset={10}
                >
                  <div role="radiogroup">
                    {playbackRates.map((rate) => (
                      <button
                        aria-checked={effectiveRate === rate}
                        className={
                          effectiveRate === rate
                            ? 'rate-option active'
                            : 'rate-option'
                        }
                        key={rate}
                        onClick={() => {
                          onPlaybackRateChange(rate)
                          setRatePickerOpen(false)
                        }}
                        role="radio"
                        type="button"
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </div>

        <div className="status-actions">
          <Tooltip label={t('intensive.markDifficult')} shortcut="D">
            <button
              className={lineProgress.unclear ? 'pill active' : 'pill'}
              onClick={() => onMarkUnclear(selectedLine.id)}
              type="button"
            >
              <CircleHelp size={18} aria-hidden="true" />
              {t('intensive.markDifficult')}
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
          <div className="vocab-anchor">
            <button
              className="pill"
              onClick={() => setVocabOpen((current) => !current)}
              type="button"
            >
              {t('intensive.addVocab')}
            </button>
            {vocabOpen && (
              <div className="vocab-popover" role="dialog">
                <p className="vocab-popover-context">{selectedLine.text}</p>
                <input
                  autoFocus
                  className="vocab-popover-input"
                  onChange={(event) => {
                    setVocabInput(event.target.value)
                    setVocabSaved(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      const words = vocabInput.split(/[\s,，;；、]+/).map((w) => w.trim()).filter(Boolean)
                      if (words.length) {
                        onAddVocabulary(words)
                        setVocabInput('')
                        setVocabSaved(true)
                      }
                    }
                  }}
                  placeholder={t('vocab.placeholder')}
                  type="text"
                  value={vocabInput}
                />
                <div className="vocab-popover-actions">
                  <button
                    className="command-button"
                    disabled={!vocabInput.trim()}
                    onClick={() => {
                      const words = vocabInput.split(/[\s,，;；、]+/).map((w) => w.trim()).filter(Boolean)
                      if (words.length) {
                        onAddVocabulary(words)
                        setVocabInput('')
                        setVocabSaved(true)
                      }
                    }}
                    type="button"
                  >
                    {vocabSaved ? t('intensive.vocabSaved') : t('vocab.save')}
                  </button>
                  <button className="exam-confirm-secondary" onClick={() => setVocabOpen(false)} type="button">
                    {t('vocab.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
          <Tooltip label={lineProgress.mastered ? t('intensive.undoMastered') : t('intensive.mastered')} shortcut="F">
            <button
              className={lineProgress.mastered ? 'pill success' : 'pill'}
              onClick={handleMarkMastered}
              type="button"
            >
              <CheckCircle2 size={18} aria-hidden="true" />
              {lineProgress.mastered ? t('intensive.undoMastered') : t('intensive.mastered')}
            </button>
          </Tooltip>
        </div>
      </div>

      <TranscriptPanel
        exercise={exercise}
        progress={progress}
        hideSelectedLineCopy
        selectedLineId={selectedLine.id}
        revealedLineIds={revealedLineIds}
        sections={sections}
        onLineSelect={onLineSelect}
      />

      {dictWord && (
        <VocabSidebar
          courseTitles={courseTitles}
          localLines={localLines}
          onAdd={(word) => onAddVocabulary([word])}
          onClose={() => setDictWord(null)}
          onJumpToLine={onJumpToLine}
          onRemove={onRemoveVocabulary}
          saved={dictWordSaved}
          word={dictWord}
        />
      )}
    </section>
  )
}
