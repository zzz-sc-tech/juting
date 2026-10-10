import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  Check,
  CircleMinus,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Send,
} from 'lucide-react'
import type { DialogueAnchor, ExamQuestion, ListeningExercise } from '@juting/shared'
import { useLanguage } from '../i18n/LanguageProvider'
import { resolveApiUrl } from '../lib/apiClient'

// 模拟实战舞台：整卷听力连播，题干读完后的停顿窗口内作答，交卷评分，
// 错题一键跳回句听。状态全部组件本地——离开本舞台（切阶段/换课）即视为
// 放弃本场考试，回来重新开始（容器用 key=exercise.id 保证换课重置）。
//
// 时间模型（全部由转写行推导，不落库）：
// - stem[i] = 第 i 题题干行（questions[].stemLineId），题干行 start 即该题高亮起点
// - 作答窗口 = 题干读完（stem.end）到下一题题干开始（stem[i+1].start）
// - 窗口一旦错过（下一题开始）该题锁定，模拟真实考试节奏

const LETTERS = ['A', 'B', 'C', 'D'] as const
type Letter = (typeof LETTERS)[number]

// 锚点标签「Q1–4 / Q19 / 第8–11题」→ 题号区间（TranscriptPanel 同款判据的本地副本）
const questionRangeOfLabel = (label: string): [number, number] | null => {
  const en = label.match(/^Q(\d+)(?:\s*[–-]\s*(\d+))?$/)
  if (en) {
    const first = Number(en[1])
    return [first, en[2] ? Number(en[2]) : first]
  }
  const zh = label.match(/^第(\d+)[–-](\d+)题$/)
  if (zh) return [Number(zh[1]), Number(zh[2])]
  return null
}

const formatClock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

type ExamStageProps = {
  exercise: ListeningExercise
  mediaRef: RefObject<HTMLMediaElement | null>
  currentTime: number
  duration: number
  isPlaying: boolean
  dialogueAnchors: DialogueAnchor[]
  onTogglePlayback: () => void
  onRestart: () => void
  onComplete: () => void
  onGoIntensive: (stemLineId: string | null, fallbackStart: number | null) => void
}

export function ExamStage({
  exercise,
  mediaRef,
  currentTime,
  duration,
  isPlaying,
  dialogueAnchors,
  onTogglePlayback,
  onRestart,
  onComplete,
  onGoIntensive,
}: ExamStageProps) {
  const { t } = useLanguage()
  const questions = useMemo(() => exercise.questions ?? [], [exercise.questions])
  const [answers, setAnswers] = useState<Record<number, Letter>>({})
  const [submitted, setSubmitted] = useState(false)
  const [viewIdx, setViewIdx] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  // 每题的时序锚：题干行（首选）或覆盖该题号的锚点块（兜底）。
  const timing = useMemo(() => {
    const anchorStartByQuestion = new Map<number, number>()
    for (const anchor of dialogueAnchors) {
      const range = questionRangeOfLabel(anchor.label)
      if (!range) continue
      for (let n = range[0]; n <= range[1]; n += 1) {
        if (!anchorStartByQuestion.has(n)) {
          anchorStartByQuestion.set(n, anchor.start)
        }
      }
    }
    const lineById = new Map(exercise.lines.map((line) => [line.id, line]))
    return questions.map((question: ExamQuestion) => {
      const line = question.stemLineId
        ? lineById.get(question.stemLineId)
        : undefined
      const fallback = anchorStartByQuestion.get(question.n) ?? null
      const start = line?.start ?? fallback ?? Number.NaN
      return {
        question,
        stem: line ?? null,
        // 题干读完的时刻：无题干行时退化为区间起点（视为读完，直接开窗）
        windowStart: line?.end ?? start,
        start,
      }
    })
  }, [dialogueAnchors, exercise.lines, questions])

  // 当前题 = 最后一个已开始读题干的题；开场播报期（NaN/都未开始）落在第 1 题
  const currentIdx = useMemo(() => {
    let idx = 0
    for (let i = 0; i < timing.length; i += 1) {
      if (Number.isFinite(timing[i].start) && timing[i].start <= currentTime + 0.2) {
        idx = i
      }
    }
    return idx
  }, [currentTime, timing])

  // 视图跟随当前题：用户点导航回看旧题时，新题一开始自动切回新题
  useEffect(() => {
    setViewIdx((current) => (current < currentIdx ? currentIdx : current))
  }, [currentIdx])

  // 交卷（含播完自然收卷）只通知一次
  const completeRef = useRef(false)
  useEffect(() => {
    if (submitted && !completeRef.current) {
      completeRef.current = true
      onComplete()
    }
    if (!submitted) {
      completeRef.current = false
    }
  }, [onComplete, submitted])

  // 播放结束 = 自然收卷
  useEffect(() => {
    if (
      !submitted &&
      duration > 0 &&
      currentTime >= duration - 0.05 &&
      !isPlaying
    ) {
      setSubmitted(true)
    }
  }, [currentTime, duration, isPlaying, submitted])

  // 交卷后滚到结果区顶部
  useEffect(() => {
    if (submitted) {
      listRef.current?.scrollTo({ top: 0 })
    }
  }, [submitted])

  const answeredCount = Object.keys(answers).length
  const answerKey = useMemo(() => exercise.answerKey ?? {}, [exercise.answerKey])
  const score = useMemo(
    () =>
      Object.entries(answers).filter(
        ([n, letter]) => answerKey[n] === letter,
      ).length,
    [answerKey, answers],
  )

  if (questions.length === 0) {
    return (
      <section className="stage-board exam-board">
        <div className="exam-empty">{t('exam.noQuestions')}</div>
      </section>
    )
  }

  const view = timing[Math.min(viewIdx, timing.length - 1)]
  const windowEnd = timing[currentIdx + 1]?.start ?? duration
  // 可作答：当前题、题干已读完、未交卷；错过后锁定（真实考试节奏）
  const answerable =
    !submitted && viewIdx === currentIdx && currentTime >= view.windowStart - 0.3
  const locked = (idx: number) => submitted || idx < currentIdx
  const windowProgress =
    answerable && windowEnd > view.windowStart
      ? Math.min(
          1,
          Math.max(
            0,
            (currentTime - view.windowStart) / (windowEnd - view.windowStart),
          ),
        )
      : null

  const choose = (letter: Letter) => {
    if (!answerable) return
    setAnswers((current) => ({ ...current, [view.question.n]: letter }))
  }

  const retake = () => {
    setAnswers({})
    setSubmitted(false)
    setViewIdx(0)
    onRestart()
  }

  return (
    <section className="stage-board exam-board">
      <audio
        ref={mediaRef as RefObject<HTMLAudioElement | null>}
        src={resolveApiUrl(exercise.audioUrl)}
        preload="metadata"
      />

      <header className="exam-head">
        <div className="exam-head-status">
          <span className={submitted ? 'exam-dot done' : 'exam-dot live'} />
          <span>
            {submitted
              ? t('exam.submitted')
              : currentIdx === 0 && currentTime < (timing[0]?.windowStart ?? 0)
                ? t('exam.waiting')
                : t('exam.inProgress')}
          </span>
        </div>
        <div className="exam-head-progress">{t('exam.answered', {
          answered: answeredCount,
          total: questions.length,
        })}</div>
        {!submitted && (
          <button className="exam-submit" onClick={() => setSubmitted(true)} type="button">
            <Send size={14} aria-hidden="true" />
            <span>{t('exam.submit')}</span>
          </button>
        )}
      </header>

      {!submitted ? (
        <div className="exam-body">
          <div className="exam-question-card">
            <div className="exam-q-head">
              <span className="exam-q-no">{t('exam.questionLabel', { n: view.question.n })}</span>
              {viewIdx === currentIdx ? (
                answerable ? (
                  <span className="exam-window on">
                    {t('exam.windowHint')}
                    {windowProgress !== null && (
                      <span className="exam-window-bar">
                        <span
                          className="exam-window-fill"
                          style={{ width: `${Math.round(windowProgress * 100)}%` }}
                        />
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="exam-window reading">{t('exam.reading')}</span>
                )
              ) : (
                <span className="exam-window locked">
                  <Lock size={12} aria-hidden="true" />
                  {t('exam.locked')}
                </span>
              )}
            </div>
            <div className="exam-options">
              {LETTERS.map((letter) => {
                const selected = answers[view.question.n] === letter
                return (
                  <button
                    className={
                      'exam-option' + (selected ? ' selected' : '') + (answerable ? '' : ' inert')
                    }
                    disabled={!answerable}
                    key={letter}
                    onClick={() => choose(letter)}
                    type="button"
                  >
                    <span className="exam-option-letter">{letter}</span>
                    <span className="exam-option-text">{view.question.options[letter]}</span>
                    {selected && <Check className="exam-option-check" size={15} aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
            <div className="exam-q-audio">
              <button className="exam-play" onClick={onTogglePlayback} type="button">
                {isPlaying ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                <span>{isPlaying ? t('exam.pause') : t('exam.play')}</span>
              </button>
              <span className="exam-clock">
                {formatClock(currentTime)} / {formatClock(duration)}
              </span>
            </div>
          </div>

          <nav className="exam-navigator" aria-label={t('exam.navigator')}>
            {timing.map((item, idx) => {
              const isAnswered = answers[item.question.n] !== undefined
              const isCurrent = idx === currentIdx && !submitted
              return (
                <button
                  aria-current={isCurrent ? 'true' : undefined}
                  className={
                    'exam-nav-cell' +
                    (isCurrent ? ' current' : '') +
                    (isAnswered ? ' answered' : '') +
                    (locked(idx) ? ' past' : '')
                  }
                  key={item.question.n}
                  onClick={() => setViewIdx(idx)}
                  type="button"
                >
                  {item.question.n}
                </button>
              )
            })}
          </nav>
        </div>
      ) : (
        <div className="exam-body exam-result-body" ref={listRef}>
          <div className="exam-score-card">
            <div className="exam-score-ring">
              <span className="exam-score-value">{score}</span>
              <span className="exam-score-total">/ {questions.length}</span>
            </div>
            <div className="exam-score-side">
              <p className="exam-score-line">{t('exam.scoreLine', { score, total: questions.length })}</p>
              <p className="exam-score-sub">{t('exam.scoreSub', {
                wrong: questions.length - score,
                unanswered: questions.length - answeredCount,
              })}</p>
              <button className="exam-retake" onClick={retake} type="button">
                <RotateCcw size={14} aria-hidden="true" />
                <span>{t('exam.retake')}</span>
              </button>
            </div>
          </div>
          <ol className="exam-review-list">
            {timing.map((item) => {
              const mine = answers[item.question.n]
              const correct = answerKey[String(item.question.n)]
              const isRight = mine !== undefined && correct !== undefined && mine === correct
              return (
                <li
                  className={'exam-review-row' + (isRight ? '' : ' miss')}
                  key={item.question.n}
                >
                  <span className="exam-review-no">{item.question.n}</span>
                  <span className={isRight ? 'exam-review-mark ok' : 'exam-review-mark bad'}>
                    {isRight ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      <CircleMinus size={14} aria-hidden="true" />
                    )}
                  </span>
                  <span className="exam-review-letters">
                    <span className="exam-review-mine">
                      {t('exam.yourAnswer', { answer: mine ?? '—' })}
                    </span>
                    <span className="exam-review-correct">
                      {t('exam.correctAnswer', { answer: correct ?? '—' })}
                    </span>
                  </span>
                  {correct && (
                    <span className="exam-review-text">
                      {item.question.options[correct as Letter]}
                    </span>
                  )}
                  {!isRight && (
                    <button
                      className="exam-review-jump"
                      onClick={() =>
                        onGoIntensive(item.question.stemLineId ?? null, Number.isFinite(item.start) ? item.start : null)
                      }
                      type="button"
                    >
                      {t('exam.goListen')}
                    </button>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}
