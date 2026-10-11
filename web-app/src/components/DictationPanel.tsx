import { Check, Eye, Flag, Lightbulb, Play, Plus, RotateCcw } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { TranscriptLine } from '@juting/shared'
import { useLanguage } from '../i18n/LanguageProvider'
import {
  findGivenSpans,
  givenNormsOf,
  judgeDictation,
  punctuationDiff,
  wordHint,
  type DictationResult,
} from '../lib/dictation'

/**
 * 听写面板（精听句卡内嵌）：输入 → 检查 → 四层判定 diff。
 * 判定规则见 lib/dictation.ts 头注释；错词可进生词本 / 重听本句；
 * 三轮未过建议标难点。严格模式 = 无预置 + 标点计入。
 */
type DictationPanelProps = {
  line: TranscriptLine
  onPlayLine: (line: TranscriptLine) => void
  onAddVocabulary: (words: string[]) => void
  onMarkUnclear: (lineId: string) => void
}

export function DictationPanel({ line, onPlayLine, onAddVocabulary, onMarkUnclear }: DictationPanelProps) {
  const { t } = useLanguage()
  const [input, setInput] = useState('')
  const [result, setResult] = useState<DictationResult | null>(null)
  const [attempts, setAttempts] = useState(0)
  const [strict, setStrict] = useState(false)
  const [punctNotes, setPunctNotes] = useState<string[]>([])
  const [addedWords, setAddedWords] = useState<Set<string>>(new Set())
  const [hintLevel, setHintLevel] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // 换句重置（父组件用 key=line.id 保证重挂亦可，这里双保险）
  const lineIdRef = useRef(line.id)
  if (lineIdRef.current !== line.id) {
    lineIdRef.current = line.id
    setInput('')
    setResult(null)
    setAttempts(0)
    setPunctNotes([])
    setAddedWords(new Set())
    setHintLevel(0)
  }

  const givenSpans = useMemo(() => findGivenSpans(line.text), [line.text])
  const givenNorms = useMemo(() => givenNormsOf(line.text), [line.text])

  const check = useCallback(() => {
    if (!input.trim()) return
    const res = judgeDictation(line.text, input, givenNorms)
    setResult(res)
    setAttempts((n) => n + 1)
    setHintLevel((lvl) => (res.passed ? lvl : Math.max(lvl, 1)))
    setPunctNotes(strict ? punctuationDiff(line.text, input) : [])
    if (!res.passed && attempts + 1 >= 2) setHintLevel(2)
  }, [attempts, givenNorms, input, line.text, strict])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      check()
    }
  }

  const scoreText = result
    ? t('intensive.dictationScore', { pass: result.contentPass, total: result.contentTotal })
    : ''
  const wrongWords = useMemo(
    () => (result ? result.words.filter((w) => w.kind === 'miss' || w.kind === 'near') : []),
    [result],
  )
  const suggestDifficult = result !== null && !result.passed && attempts >= 3

  return (
    <div className="dictation-panel">
      <div className="dictation-head">
        <span className="dictation-label">{t('intensive.dictation')}</span>
        {givenSpans.length > 0 && !strict && (
          <span className="dictation-given">
            {t('intensive.dictationGiven')}
            {givenSpans.map((span) => (
              <code key={`${span.start}-${span.text}`}>{span.text}</code>
            ))}
          </span>
        )}
        <button
          className={strict ? 'subtitle-chip on' : 'subtitle-chip'}
          onClick={() => {
            setStrict((v) => !v)
            setResult(null)
            setPunctNotes([])
          }}
          title={t('intensive.dictationStrictHint')}
          type="button"
          aria-pressed={strict}
        >
          {t('intensive.dictationStrict')}
        </button>
      </div>

      <textarea
        autoFocus
        className="dictation-input"
        lang="en"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        placeholder={t('intensive.dictationPlaceholder')}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={onKeyDown}
        ref={inputRef}
        rows={3}
        value={input}
      />

      <div className="dictation-actions">
        <button className="command-button" disabled={!input.trim()} onClick={check} type="button">
          <Check size={15} aria-hidden="true" />
          {t('intensive.dictationCheck')}
        </button>
        <button className="icon-button" onClick={() => onPlayLine(line)} type="button">
          <Play size={15} aria-hidden="true" />
          <span>{t('intensive.replayShort')}</span>
        </button>
        {!result?.passed && attempts > 0 && (
          <button className="icon-button" onClick={() => setHintLevel((l) => Math.min(2, l + 1))} type="button">
            <Lightbulb size={15} aria-hidden="true" />
            <span>{t('intensive.dictationHint')}</span>
          </button>
        )}
        {result && (
          <button
            className="icon-button"
            onClick={() => {
              setResult(null)
              setPunctNotes([])
              setHintLevel(0)
              inputRef.current?.focus()
            }}
            type="button"
          >
            <RotateCcw size={15} aria-hidden="true" />
            <span>{t('intensive.dictationRetry')}</span>
          </button>
        )}
        {result && (
          <span className={result.passed ? 'dictation-score pass' : 'dictation-score'}>
            {scoreText}
            {result.passed ? ' ✓' : ''}
          </span>
        )}
      </div>

      {result && (
        <div className="dictation-diff" aria-live="polite">
          {result.words.map((w, idx) => {
            const cls = `dw dw-${w.kind}`
            const title =
              w.kind === 'near' ? t('intensive.dictationNear', { typo: w.expect ?? '' })
              : w.kind === 'miss' ? t('intensive.dictationWrote', { typo: w.expect ?? '' })
              : w.kind === 'fn' ? t('intensive.dictationFn')
              : w.kind === 'given' ? t('intensive.dictationGivenHint')
              : undefined
            const label =
              w.kind === 'miss' && hintLevel >= 1 ? wordHint(w.raw)
              : w.kind === 'miss' && hintLevel >= 2 ? w.raw
              : w.raw
            return (
              <span className={cls} key={`${idx}-${w.raw}`} title={title}>
                {w.kind === 'extra' ? <s>{w.raw}</s> : label}
              </span>
            )
          })}
        </div>
      )}

      {punctNotes.length > 0 && (
        <p className="dictation-punct">
          <Eye size={13} aria-hidden="true" />
          {punctNotes.join('；')}
        </p>
      )}

      {wrongWords.length > 0 && (
        <div className="dictation-words">
          {wrongWords.map((w) => (
            <span className="dictation-word-chip" key={w.raw}>
              {w.raw}
              {!addedWords.has(w.raw) && (
                <button
                  className="dictation-word-add"
                  onClick={() => {
                    onAddVocabulary([w.raw])
                    setAddedWords((cur) => new Set(cur).add(w.raw))
                  }}
                  title={t('vocab.save')}
                  type="button"
                >
                  <Plus size={12} aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {suggestDifficult && (
        <button className="dictation-difficult" onClick={() => onMarkUnclear(line.id)} type="button">
          <Flag size={13} aria-hidden="true" />
          {t('intensive.dictationMarkDifficult')}
        </button>
      )}
    </div>
  )
}
