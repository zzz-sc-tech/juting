import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
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
import type { MessageKey } from '../i18n/messages'
import { resolveApiUrl } from '../lib/apiClient'
import {
  getAttempts,
  recordAttempt,
  type ExamLetter,
} from '../lib/examHistory'
import {
  clearInprogress,
  getInprogress,
  saveInprogress,
} from '../lib/examInprogress'

// 模拟实战舞台：整卷听力连播，按「听力部分」开窗作答，交卷评分，
// 错题一键跳回句听。状态全部组件本地——离开本舞台（切阶段/换课）即视为
// 放弃本场考试，回来重新开始（容器用 key=exercise.id 保证换课重置）。
// 例外：已作答且未交卷的进度会按课程暂存（防手滑毁掉 25 分钟），回到
// 考试页时询问「继续 / 重新开考」。
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

// 六级听力卷面折算：25 题 / 满分 248.5（线性近似，展示用）
const SCALED_FULL = 248.5

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
  /** 重练模式播放该题所属部分区间 */
  onPlayRange: (start: number, end: number) => void
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
  onPlayRange,
}: ExamStageProps) {
  const { t } = useLanguage()
  const questions = useMemo(() => exercise.questions ?? [], [exercise.questions])
  const [answers, setAnswers] = useState<Record<number, Letter>>({})
  const [submitted, setSubmitted] = useState(false)
  const [viewIdx, setViewIdx] = useState(0)
  // 交卷确认层（显示未答数，防手滑毁掉整场）
  const [confirmOpen, setConfirmOpen] = useState(false)
  // 中断恢复询问层
  const [resumeAsk, setResumeAsk] = useState<{ answers: Record<number, Letter>; currentTime: number } | null>(null)
  // 最近一场成绩（交卷后展示折算分与历史对照）
  const [lastAttempt, setLastAttempt] = useState<{ score: number; total: number } | null>(null)
  // 错题重练（mini 卷）：历次错题并集乱序，逐题开放作答
  const [drillQueue, setDrillQueue] = useState<number[] | null>(null)
  const [drillIdx, setDrillIdx] = useState(0)
  const [drillAnswers, setDrillAnswers] = useState<Record<number, Letter>>({})

  // 中断恢复询问：仅当本课有「已作答未交卷」的暂存时弹一次
  useEffect(() => {
    const saved = getInprogress(exercise.id)
    if (saved) {
      setResumeAsk({ answers: saved.answers as Record<number, Letter>, currentTime: saved.currentTime })
    }
    // key=exercise.id 保证换课重挂，这里只看挂载时
  }, [exercise.id])

  // 恢复层与交卷确认层互斥：恢复层解决（继续/重开）时顺带关确认层，
  // 防止两层叠开（对账层共享按钮类名，叠开会有点击歧义）
  const resolveResume = useCallback((pick: { answers: Record<number, Letter>; currentTime: number } | null) => {
    setResumeAsk(pick)
    setConfirmOpen(false)
  }, [])

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

  // 当前音频所处的部分；正被播报题干的题（矩阵上的「正在读」标记）
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

  // 进行中作答暂存（800ms 防抖）：答案 + 播放位置；交卷即清。
  // 播放位置走 ref：currentTime 由播放器每 ~100ms 推一次，若进依赖数组，
  // 定时器会被不断重置、800ms 永远走不完 → 连续播放时暂存从不落盘（B1）。
  const currentTimeRef = useRef(currentTime)
  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    if (submitted || Object.keys(answers).length === 0) {
      return
    }
    const timer = window.setTimeout(() => {
      saveInprogress(exercise.id, {
        answers,
        currentTime: currentTimeRef.current,
        savedAt: Date.now(),
      })
    }, 800)
    return () => window.clearTimeout(timer)
  }, [answers, exercise.id, submitted])

  // 交卷后自动滚到第一条错题（无错题则滚回顶部）
  useEffect(() => {
    if (!submitted) return
    const timer = window.setTimeout(() => {
      const firstMiss = document.querySelector('.exam-review-row.miss')
      ;(firstMiss ?? document.querySelector('.exam-score-card'))?.scrollIntoView({ block: 'start' })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [submitted])

  // 交卷（含播完自然收卷）只通知一次 + 记入成绩档案 + 清暂存
  const completeRef = useRef(false)
  useEffect(() => {
    if (submitted && !completeRef.current) {
      completeRef.current = true
      clearInprogress(exercise.id)
      const answerKey = exercise.answerKey ?? {}
      const wrong: number[] = []
      let unanswered = 0
      for (const q of questions) {
        const mine = answers[q.n]
        const correct = answerKey[String(q.n)] as ExamLetter | undefined
        if (!mine) {
          unanswered += 1
          wrong.push(q.n)
        } else if (mine !== correct) {
          wrong.push(q.n)
        }
      }
      const attempt = recordAttempt(exercise.id, {
        score: questions.length - wrong.length,
        total: questions.length,
        wrong,
        unanswered,
      })
      setLastAttempt({ score: attempt.score, total: attempt.total })
      onComplete()
    }
    if (!submitted) {
      completeRef.current = false
    }
  }, [answers, exercise.answerKey, exercise.id, onComplete, questions, submitted])

  const wrongUnion = useMemo(() => {
    if (!submitted) return []
    const seen = new Set<number>()
    for (const attempt of getAttempts(exercise.id)) {
      for (const n of attempt.wrong) seen.add(n)
    }
    return [...seen].sort((a, b) => a - b)
  }, [exercise.id, submitted])

  const answeredCount = Object.keys(answers).length
  const answerKey = useMemo(() => exercise.answerKey ?? {}, [exercise.answerKey])
  const score = useMemo(
    () =>
      Object.entries(answers).filter(
        ([n, letter]) => answerKey[n] === letter,
      ).length,
    [answerKey, answers],
  )
  // 历史场数在仪表盘分数曲线展示；本页只展示本场折算分

  // 键盘作答：A-D/1-4 选当前题、←/→ 移动视图、回车走确认。
  // 可作答判定经 answerableRef 读取最新值——若放进 effect 依赖，parts/
  // activePartIdx 每次更新都会重挂监听器；闭包过期则会出现「界面显示
  // 可作答但按键无效」的死键（本地实测踩过）。
  const timingRef = useRef(timing)
  timingRef.current = timing
  const keyboardStateRef = useRef({ viewIdx, answers, submitted, resumeAsk, activePartIdx })
  keyboardStateRef.current = { viewIdx, answers, submitted, resumeAsk, activePartIdx }
  const answerableForRef = (idx: number) => {
    const state = keyboardStateRef.current
    if (state.submitted || state.resumeAsk) return false
    if (parts.length === 0) return true
    const partIdx = parts.findIndex((part) => part.items.includes(idx))
    return partIdx === state.activePartIdx && state.activePartIdx >= 0
  }
  useEffect(() => {
    if (submitted || resumeAsk) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const letterByValue: Record<string, Letter> = { a: 'A', b: 'B', c: 'C', d: 'D' }
      const key = event.key.toLowerCase()
      let letter: Letter | null = letterByValue[key] ?? null
      if (!letter && ['1', '2', '3', '4'].includes(key)) {
        letter = LETTERS[Number(key) - 1]
      }
      const state = keyboardStateRef.current
      const currentTiming = timingRef.current
      if (letter) {
        const question = currentTiming[state.viewIdx]?.question
        if (question && answerableForRef(state.viewIdx)) {
          event.preventDefault()
          setAnswers((current) => ({ ...current, [question.n]: letter! }))
        }
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const delta = event.key === 'ArrowLeft' ? -1 : 1
        const next = Math.min(Math.max(state.viewIdx + delta, 0), currentTiming.length - 1)
        if (next !== state.viewIdx) {
          event.preventDefault()
          setViewIdx(next)
        }
        return
      }
      if (event.key === 'Enter' && Object.keys(state.answers).length > 0) {
        event.preventDefault()
        setConfirmOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // submitted/resumeAsk 变化时重挂（暂停/恢复键盘）；其余状态走 ref 读取
  }, [submitted, resumeAsk, timing, parts])

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
  const answerable = !submitted && !resumeAsk && inOpenPart
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
    setLastAttempt(null)
    onRestart()
  }

  const submitExam = () => {
    setConfirmOpen(false)
    setSubmitted(true)
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
        {!submitted && !resumeAsk && (
          <button className="exam-submit" onClick={() => setConfirmOpen(true)} type="button">
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
              ) : viewPartIdx > activePartIdx ? (
                <span className="exam-window reading">
                  {t('exam.partNotStarted')}
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

          {resumeAsk && (
            <div className="exam-confirm-backdrop" role="dialog" aria-modal="true">
              <div className="exam-confirm-card">
                <strong>{t('exam.resumeTitle')}</strong>
                <p>{t('exam.resumeHint', {
                  count: Object.keys(resumeAsk.answers).length,
                  time: formatClock(resumeAsk.currentTime),
                })}</p>
                <div className="exam-confirm-actions">
                  <button
                    className="exam-confirm-primary"
                    onClick={() => {
                      setAnswers(resumeAsk.answers)
                      // 恢复播放位置：媒体元素挂载后 seek
                      window.setTimeout(() => {
                        const media = mediaRef.current
                        if (media && Number.isFinite(resumeAsk.currentTime)) {
                          media.currentTime = resumeAsk.currentTime
                        }
                      }, 250)
                      resolveResume(null)
                    }}
                    type="button"
                  >
                    {t('exam.resumeGo')}
                  </button>
                  <button
                    className="exam-confirm-secondary"
                    onClick={() => {
                      clearInprogress(exercise.id)
                      resolveResume(null)
                    }}
                    type="button"
                  >
                    {t('exam.resumeDrop')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {confirmOpen && (
            <div className="exam-confirm-backdrop" role="dialog" aria-modal="true">
              <div className="exam-confirm-card">
                <strong>{t('exam.confirmTitle')}</strong>
                <p>{t('exam.confirmBody', {
                  answered: answeredCount,
                  total: questions.length,
                  unanswered: questions.length - answeredCount,
                })}</p>
                <div className="exam-confirm-actions">
                  <button className="exam-confirm-primary" onClick={submitExam} type="button">
                    {t('exam.confirmOk')}
                  </button>
                  <button className="exam-confirm-secondary" onClick={() => setConfirmOpen(false)} type="button">
                    {t('exam.confirmCancel')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="exam-score-card">
            <div className="exam-score-ring">
              <span className="exam-score-value">{score}</span>
              <span className="exam-score-total">/ {questions.length}</span>
            </div>
            <div className="exam-score-side">
              <p className="exam-score-line">{t('exam.scoreLine', { score, total: questions.length })}</p>
              <p className="exam-score-sub">{t('exam.scoreSub', {
                wrong: answeredCount - score,
                unanswered: questions.length - answeredCount,
              })}</p>
              {lastAttempt && (
                <p className="exam-scaled">{t('exam.scaledScore', {
                  score: Math.round((lastAttempt.score / lastAttempt.total) * SCALED_FULL * 10) / 10,
                })}</p>
              )}
              {wrongUnion.length > 0 && (
                <button
                  className="exam-retake"
                  onClick={() => {
                    // Fisher-Yates 乱序
                    const queue = [...wrongUnion]
                    for (let i = queue.length - 1; i > 0; i -= 1) {
                      const j = Math.floor(Math.random() * (i + 1))
                      ;[queue[i], queue[j]] = [queue[j]!, queue[i]!]
                    }
                    setDrillQueue(queue)
                    setDrillIdx(0)
                    setDrillAnswers({})
                  }}
                  type="button"
                >
                  {t('exam.wrongDrill', { count: wrongUnion.length })}
                </button>
              )}
              <button className="exam-retake" onClick={retake} type="button">
                <RotateCcw size={14} aria-hidden="true" />
                <span>{t('exam.retake')}</span>
              </button>
            </div>
          </div>
          {drillQueue && <ExamDrill
            answerKey={answerKey as Record<string, ExamLetter>}
            answers={drillAnswers}
            duration={duration}
            drillIdx={drillIdx}
            onAnswer={(n, letter) => {
              setDrillAnswers((current) => ({ ...current, [n]: letter }))
              // 末题作答后直接进小结（下一题按钮在末题禁用，没有别的前进路径）
              if (drillQueue && drillIdx === drillQueue.length - 1) {
                setDrillIdx(drillQueue.length)
              }
            }}
            onDone={() => setDrillQueue(null)}
            onIdxChange={setDrillIdx}
            onPlayRange={onPlayRange}
            parts={parts}
            questions={questions}
            queue={drillQueue}
            t={t}
          />}
          <ExamHistoryPanel exerciseId={exercise.id} t={t} />
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
        </>
      )}
    </section>
  )
}


/** 错题重练 mini 卷：逐题开放作答，播放该题所属部分；全部答完出小结。 */
function ExamDrill({
  queue,
  drillIdx,
  answers,
  onAnswer,
  onIdxChange,
  onDone,
  onPlayRange,
  parts,
  questions,
  answerKey,
  duration,
  t,
}: {
  queue: number[]
  drillIdx: number
  answers: Record<number, Letter>
  onAnswer: (n: number, letter: Letter) => void
  onIdxChange: (idx: number) => void
  onDone: () => void
  onPlayRange: (start: number, end: number) => void
  parts: ExamPart[]
  questions: ExamQuestion[]
  answerKey: Record<string, ExamLetter>
  duration: number
  t: (key: MessageKey, values?: Record<string, string | number>) => string
}) {
  const finished = drillIdx >= queue.length
  const correctCount = queue.filter((qn) => answers[qn] && answers[qn] === answerKey[String(qn)]).length
  const n = finished ? queue[queue.length - 1]! : queue[drillIdx]!
  const question = questions.find((q) => q.n === n)
  if (!question) {
    return null
  }
  const playThis = () => {
    // 该题所属部分区间；无部分信息的课退化为整段
    const partIdx = parts.findIndex((p) => p.items.some((idx) => questions[idx]?.n === n))
    if (partIdx >= 0) {
      const partEnd = parts[partIdx + 1]?.start ?? duration
      onPlayRange(parts[partIdx]!.start, partEnd)
    } else {
      onPlayRange(0, duration)
    }
  }
  return (
    <div className="exam-drill">
      <div className="exam-drill-head">
        <strong>{t('exam.wrongDrill', { count: queue.length })}</strong>
        <span>{finished ? '' : `${drillIdx + 1} / ${queue.length}`}</span>
        <button className="exam-confirm-secondary" onClick={onDone} type="button">
          {t('exam.drillQuit')}
        </button>
      </div>
      {finished ? (
        <div className="exam-drill-summary">
          <p>{t('exam.drillDone', { correct: correctCount, total: queue.length })}</p>
          <button className="exam-confirm-primary" onClick={onDone} type="button">
            {t('exam.drillFinish')}
          </button>
        </div>
      ) : (
        <>
          <div className="exam-q-audio">
            <button className="exam-play" onClick={playThis} type="button">
              <Play size={15} aria-hidden="true" />
              <span>{t('exam.play')}</span>
            </button>
            <span className="exam-clock">Q{n}</span>
          </div>
          <div className="exam-options">
            {LETTERS.map((letter) => {
              const selected = answers[n] === letter
              return (
                <button
                  className={'exam-option' + (selected ? ' selected' : '')}
                  key={letter}
                  onClick={() => onAnswer(n, letter)}
                  type="button"
                >
                  <span className="exam-option-letter">{letter}</span>
                  <span className="exam-option-text">{question.options[letter]}</span>
                  {selected && <Check className="exam-option-check" size={15} aria-hidden="true" />}
                </button>
              )
            })}
          </div>
          <div className="exam-drill-nav">
            <button
              className="exam-confirm-secondary"
              disabled={drillIdx === 0}
              onClick={() => onIdxChange(drillIdx - 1)}
              type="button"
            >
              ←
            </button>
            <button
              className="exam-confirm-primary"
              disabled={drillIdx >= queue.length - 1}
              onClick={() => onIdxChange(drillIdx + 1)}
              type="button"
            >
              {t('exam.drillNext')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}


/**
 * 单课成绩历史（交卷后展示）：历场 日期|得分|错题|未答|Section 分布 + 得分走势折线。
 * 折线手写 SVG（复用仪表盘 MasteryChart 的先例），项目不引图表库。
 */
function ExamHistoryPanel({
  exerciseId,
  t,
}: {
  exerciseId: number
  t: (key: MessageKey, values?: Record<string, string | number>) => string
}) {
  const attempts = useMemo(() => getAttempts(exerciseId), [exerciseId])

  if (attempts.length === 0) {
    return (
      <div className="exam-history">
        <p className="exam-history-empty">{t('exam.history.empty')}</p>
      </div>
    )
  }

  return (
    <div className="exam-history">
      <strong className="exam-history-title">{t('exam.history.title')}</strong>
      <ExamHistoryTrend attempts={attempts} />
      <ul className="exam-history-list">
        {[...attempts].reverse().map((attempt, index) => {
          const date = new Date(attempt.date)
          const pad = (n: number) => String(n).padStart(2, '0')
          const dateLabel = Number.isNaN(date.getTime())
            ? attempt.date
            : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
          return (
            <li className="exam-history-row" key={`${attempt.date}-${index}`}>
              <span className="exam-history-date">{dateLabel}</span>
              <span className="exam-history-score">{t('exam.history.row', { score: attempt.score, total: attempt.total })}</span>
              <span className="exam-history-meta">
                {t('exam.history.wrongCount', {
                  wrong: Array.isArray(attempt.wrong) ? attempt.wrong.length : 0,
                  unanswered: attempt.unanswered,
                })}
              </span>
              <span className="exam-history-sections">
                {t('exam.history.sections', {
                  a: attempt.wrongBySection?.A ?? 0,
                  b: attempt.wrongBySection?.B ?? 0,
                  c: attempt.wrongBySection?.C ?? 0,
                })}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 得分走势（score/total 百分比），手写 SVG 折线。 */
function ExamHistoryTrend({ attempts }: { attempts: Array<{ date: string; score: number; total: number }> }) {
  const { t } = useLanguage()
  if (attempts.length < 2) {
    return null
  }
  const width = 560
  const height = 110
  const padX = 18
  const padTop = 12
  const padBottom = 14
  const percentOf = (attempt: { score: number; total: number }) =>
    attempt.total > 0 ? Math.max(0, Math.min(100, (attempt.score / attempt.total) * 100)) : 0
  const stepX = attempts.length > 1 ? (width - padX * 2) / (attempts.length - 1) : 0
  const yOf = (percent: number) => padTop + (1 - percent / 100) * (height - padTop - padBottom)
  const coords = attempts.map((attempt, index) => ({
    x: padX + index * stepX,
    y: yOf(percentOf(attempt)),
    key: `${attempt.date}-${index}`,
  }))
  const linePath = coords
    .map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.x.toFixed(1)},${coord.y.toFixed(1)}`)
    .join(' ')

  return (
    <div className="exam-history-trend">
      <span className="exam-history-trend-label">{t('exam.history.trend')}</span>
      <svg aria-hidden="true" preserveAspectRatio="none" role="img" viewBox={`0 0 ${width} ${height}`}>
        <line className="exam-history-trend-grid" x1={padX} x2={width - padX} y1={yOf(50)} y2={yOf(50)} />
        <path className="exam-history-trend-line" d={linePath} />
        {coords.map((coord) => (
          <circle className="exam-history-trend-dot" cx={coord.x} cy={coord.y} key={coord.key} r={3.5} />
        ))}
      </svg>
    </div>
  )
}
