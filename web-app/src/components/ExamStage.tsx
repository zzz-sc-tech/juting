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

// 模拟实战舞台：整卷听力连播，按「听力部分」开窗作答，交卷评分，
// 错题一键跳回句听。状态全部组件本地——离开本舞台（切阶段/换课）即视为
// 放弃本场考试，回来重新开始（容器用 key=exercise.id 保证换课重置）。
//
// 作答窗口模型（部分粒度，2026-10-11 用户裁定）：
// - 听力部分 = Conversation/Passage/Recording N（锚点 kind=text）；
//   部分报头缺失的老卷用 Section A/B/C 锚点兜底作为边界
// - 某部分开始（材料/报头响起）→ 该部分全部题目即刻可作答，
//   部分内自由切题、不随题干播报强制跳视图
// - 下一部分开始 → 上一部分整体锁定（真实考试：材料只播一遍）
// - 无部分锚点的课程退化为整卷开放作答

const LETTERS = ['A', 'B', 'C', 'D'] as const
type Letter = (typeof LETTERS)[number]

// 锚点标签「Q1–4 / Q19 / 第8–11题」→ 题号区间（题干行缺失时的兜底定位）
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

// 听力部分边界锚点：材料报头（优先）+ 节次报头（兜底，老卷缺 Passage 报头时用）
const PART_BOUNDARY = /^(?:Conversation|Passage|Recording|Text)\s*\d|^Section\s+[ABC]/i

const formatClock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

type ExamPart = {
  start: number
  label: string
  /** 该部分题目在 timing 里的下标（升序） */
  items: number[]
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
        start,
      }
    })
  }, [dialogueAnchors, exercise.lines, questions])

  // 听力部分划分：每题归属其题干前最近的边界锚点（材料报头优先、节次报头兜底）；
  // 同一边界的题并为一个部分（老卷缺材料报头时相邻题组自然并窗）。
  const parts = useMemo<ExamPart[]>(() => {
    const boundaries = dialogueAnchors
      .filter((anchor) => anchor.kind === 'text' && PART_BOUNDARY.test(anchor.label))
      .sort((a, b) => a.start - b.start)
    if (boundaries.length === 0 || timing.length === 0) {
      return []
    }
    const byStart = new Map<number, ExamPart>()
    timing.forEach((item, idx) => {
      let boundary = boundaries[0]
      for (const anchor of boundaries) {
        if (anchor.start <= item.start + 0.2) {
          boundary = anchor
        } else {
          break
        }
      }
      let part = byStart.get(boundary.start)
      if (!part) {
        part = { start: boundary.start, label: boundary.label, items: [] }
        byStart.set(boundary.start, part)
      }
      part.items.push(idx)
    })
    return [...byStart.values()].sort((a, b) => a.start - b.start)
  }, [dialogueAnchors, timing])

  // 当前音频所处的部分；正被播报题干的题（矩阵上的“正在读”标记）
  const activePartIdx = useMemo(() => {
    let idx = -1
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].start <= currentTime + 0.2) idx = i
    }
    return idx
  }, [currentTime, parts])
  const stemLiveIdx = useMemo(() => {
    let idx = 0
    for (let i = 0; i < timing.length; i += 1) {
      if (Number.isFinite(timing[i].start) && timing[i].start <= currentTime + 0.2) {
        idx = i
      }
    }
    return idx
  }, [currentTime, timing])

  // 部分切换时把视图带到新部分的第一题；部分内不强制跟随题干（自由作答）
  useEffect(() => {
    if (activePartIdx >= 0 && parts[activePartIdx]) {
      setViewIdx((current) =>
        parts[activePartIdx]!.items.includes(current)
          ? current
          : parts[activePartIdx]!.items[0],
      )
    }
  }, [activePartIdx, parts])

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
  const viewPartIdx = parts.findIndex((part) => part.items.includes(viewIdx))
  // 可作答：视图所在部分 == 当前音频部分（进入下一部分即整部分锁定）；
  // 无部分锚点的课程退化为整卷开放。
  const inOpenPart =
    parts.length === 0 ? true : viewPartIdx === activePartIdx && activePartIdx >= 0
  const answerable = !submitted && inOpenPart
  const locked = (idx: number) => {
    if (submitted) return true
    if (parts.length === 0) return false
    const partIdx = parts.findIndex((part) => part.items.includes(idx))
    return partIdx >= 0 && partIdx < activePartIdx
  }

  // 部分窗口进度条：当前部分起点 → 下一部分起点
  const activePart = activePartIdx >= 0 ? parts[activePartIdx] : null
  const partEnd = activePartIdx >= 0 && parts[activePartIdx + 1]
    ? parts[activePartIdx + 1]!.start
    : duration
  const partProgress =
    answerable && activePart && partEnd > activePart.start
      ? Math.min(
          1,
          Math.max(
            0,
            (currentTime - activePart.start) / (partEnd - activePart.start),
          ),
        )
      : null
  // 题干尚未开始播报 → 处于材料/报头播放阶段
  const materialPhase =
    activePart && timing[activePart.items[0]]
      ? currentTime < timing[activePart.items[0]]!.start - 0.2
      : false

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
              : activePartIdx < 0
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
        <>
          <div className="exam-question-card">
            <div className="exam-q-head">
              <span className="exam-q-no">{t('exam.questionLabel', { n: view.question.n })}</span>
              {inOpenPart ? (
                <span className="exam-window-group">
                  <span className={materialPhase ? 'exam-window reading' : 'exam-window on'}>
                    {materialPhase ? t('exam.materialPlaying') : t('exam.reading')}
                  </span>
                  <span className="exam-window on">
                    {t('exam.sectionWindow')}
                    {partProgress !== null && (
                      <span className="exam-window-bar">
                        <span
                          className="exam-window-fill"
                          style={{ width: `${Math.round(partProgress * 100)}%` }}
                        />
                      </span>
                    )}
                  </span>
                </span>
              ) : viewPartIdx >= 0 && viewPartIdx < activePartIdx ? (
                <span className="exam-window locked">
                  <Lock size={12} aria-hidden="true" />
                  {t('exam.sectionLocked')}
                </span>
              ) : null}
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
              return (
                <button
                  aria-current={idx === viewIdx ? 'true' : undefined}
                  className={
                    'exam-nav-cell' +
                    (idx === viewIdx ? ' current' : '') +
                    (idx === stemLiveIdx && !submitted ? ' live' : '') +
                    (isAnswered ? ' answered' : '') +
                    (locked(idx) ? ' past' : '')
                  }
                  key={item.question.n}
                  onClick={() => setViewIdx(idx)}
                  title={item.question.n === timing[stemLiveIdx]?.question.n ? t('exam.reading') : undefined}
                  type="button"
                >
                  {item.question.n}
                </button>
              )
            })}
          </nav>
        </>
      ) : (
        <div className="exam-body exam-result-body">
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
