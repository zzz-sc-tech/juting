import { Check, ChevronRight, CircleAlert, Headphones, Play, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { extractDialogueAnchors, type ListeningExercise } from '@juting/shared'
import { TopBar } from '../components/TopBar'
import { useDrillData } from '../hooks/useDrillData'
import { useLanguage } from '../i18n/LanguageProvider'
import type { MessageKey } from '../i18n/messages'
import { resolveApiUrl } from '../lib/apiClient'
import {
  fetchExerciseDetail,
  getCachedExerciseDetail,
  prefetchExerciseDetail,
} from '../lib/drillDetail'
import {
  buildDrillPool,
  questionAudioRange,
  takeRound,
  type DrillQuestion,
} from '../lib/drillPool'
import {
  accuracyOf,
  loadDrillStats,
  recordDrillAnswer,
  resetDrillStats,
  type DrillStats,
} from '../lib/drillStats'
import {
  addDrillWrong,
  clearDrillWrong,
  drillWrongList,
  loadDrillWrong,
  removeDrillWrong,
  wrongKey,
  type DrillWrongStore,
} from '../lib/drillWrong'
import { sectionOfQuestion, type ExamLetter, type ExamSection } from '../lib/examHistory'

// 按题型专项刷题：从 38 套有答案钥匙的真题里按 Section 抽题，单题作答、立即判分。
// 刻意独立成页、独立记账：实战舞台是「整套卷模拟」，混进单题训练会毁掉它的语义，
// 战绩写进 examHistory 也会把分数曲线和「最常错的题」带歪。
const SECTIONS: ExamSection[] = ['A', 'B', 'C']
const LETTERS: ExamLetter[] = ['A', 'B', 'C', 'D']
const ROUND_SIZE = 10

const SECTION_LABEL: Record<ExamSection, MessageKey> = {
  A: 'drill.section.A',
  B: 'drill.section.B',
  C: 'drill.section.C',
}
const SECTION_RANGE: Record<ExamSection, MessageKey> = {
  A: 'drill.section.A.range',
  B: 'drill.section.B.range',
  C: 'drill.section.C.range',
}

const formatClock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// 单课详情（拿题干时间轴）：由 lib/drillDetail 统一缓存，换题时可直接命中预取结果
function useExerciseDetailLite(exerciseId: number | null) {
  const [detail, setDetail] = useState<ListeningExercise | null>(null)
  useEffect(() => {
    if (exerciseId === null) {
      setDetail(null)
      return
    }
    const cached = getCachedExerciseDetail(exerciseId)
    if (cached) {
      setDetail(cached)
      return
    }
    let mounted = true
    setDetail(null)
    fetchExerciseDetail(exerciseId)
      .then((exercise) => {
        if (mounted) setDetail(exercise)
      })
      .catch(() => {
        // 详情拉不到只影响「播放本题音频」与跳转定位，题目本身照做
      })
    return () => {
      mounted = false
    }
  }, [exerciseId])
  return detail
}

type DrillRound = {
  /** pool = 按题型抽题；wrong = 错题本／本轮错题重练 */
  mode: 'pool' | 'wrong'
  section: ExamSection
  queue: DrillQuestion[]
  index: number
  answer: ExamLetter | null
  correct: number
  wrong: number
  skipped: number
  /** 本轮答错的题：小结页「只练本轮错题」用它 */
  wrongThisRound: DrillQuestion[]
  /** 当前题是否已计入统计（重做后不再计，避免同一题算两次） */
  counted: boolean
  /** 当前题是重做过的（判分条上标「重做不计分」） */
  retried: boolean
}

export function DrillPage() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const { exercises, status, reload } = useDrillData()
  const [section, setSection] = useState<ExamSection>('A')
  const [round, setRound] = useState<DrillRound | null>(null)
  const [stats, setStats] = useState<DrillStats>(loadDrillStats)
  const [wrongStore, setWrongStore] = useState<DrillWrongStore>(loadDrillWrong)

  const pools = useMemo(
    () => ({
      A: buildDrillPool(exercises, 'A'),
      B: buildDrillPool(exercises, 'B'),
      C: buildDrillPool(exercises, 'C'),
    }),
    [exercises],
  )
  // 错题本里存的是 exerciseId:题号，跨 Section；重建题目要回到总池里找
  const questionByKey = useMemo(() => {
    const map = new Map<string, DrillQuestion>()
    for (const item of [...pools.A, ...pools.B, ...pools.C]) {
      map.set(item.key, item)
    }
    return map
  }, [pools])
  const wrongQuestions = useMemo(
    () =>
      drillWrongList(wrongStore)
        .map((entry) => questionByKey.get(wrongKey(entry.exerciseId, entry.n)))
        .filter((item): item is DrillQuestion => Boolean(item)),
    [questionByKey, wrongStore],
  )

  const current = round && round.index < round.queue.length ? round.queue[round.index] : null
  const finished = Boolean(round && round.index >= round.queue.length)
  const nextQuestion =
    round && round.index + 1 < round.queue.length ? round.queue[round.index + 1] : null

  // 答当前题的时候就把下一题那门课的详情取好：换题时不再等一次 70KB 请求
  useEffect(() => {
    prefetchExerciseDetail(nextQuestion?.exerciseId)
  }, [nextQuestion?.exerciseId])

  const detail = useExerciseDetailLite(current?.exerciseId ?? null)
  // 部分边界（Conversation 1 / Passage 2 …）：单题区间的起点靠它，
  // 否则只能从上一题念完处起播，等于把答案所在的材料切掉
  const anchors = useMemo(
    () => (detail ? extractDialogueAnchors(detail.lines) : []),
    [detail],
  )
  const range = useMemo(
    () =>
      current && detail && detail.id === current.exerciseId
        ? questionAudioRange(detail.questions ?? [], detail.lines, current.n, { anchors })
        : null,
    [anchors, current, detail],
  )

  // ── 音频：自建极简播放器（不复用 MediaPlaybackContext，那套与学习会话耦合） ──
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stopAtRef = useRef<number | null>(null)
  const rangeRef = useRef(range)
  rangeRef.current = range
  const autoPlayRef = useRef(false)
  const playedKeyRef = useRef<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)

  const stopAudio = useCallback(() => {
    const audio = audioRef.current
    stopAtRef.current = null
    if (audio) audio.pause()
    setPlaying(false)
  }, [])

  const playCurrent = useCallback(() => {
    const audio = audioRef.current
    const target = rangeRef.current
    if (!audio || !target) return
    autoPlayRef.current = true
    const begin = () => {
      audio.currentTime = target.start
      stopAtRef.current = target.end
      void audio
        .play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false))
    }
    if (audio.readyState >= 1) {
      begin()
    } else {
      audio.addEventListener('loadedmetadata', begin, { once: true })
    }
  }, [])

  // 换题后自动播（第一次仍需用户点一下，之后沿用这次交互授权）
  useEffect(() => {
    if (!autoPlayRef.current || !range || !current) return
    if (playedKeyRef.current === current.key) return
    playedKeyRef.current = current.key
    playCurrent()
  }, [current, playCurrent, range])

  useEffect(() => () => {
    audioRef.current?.pause()
  }, [])

  const handleTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio) return
    if (stopAtRef.current !== null && audio.currentTime >= stopAtRef.current) {
      audio.pause()
      stopAtRef.current = null
      setPlaying(false)
    }
    const target = rangeRef.current
    setPosition(target ? Math.max(0, audio.currentTime - target.start) : 0)
  }

  // ── 一轮的推进 ──
  const startRound = useCallback(
    (mode: 'pool' | 'wrong', preset?: DrillQuestion[]) => {
      const queue =
        preset ??
        (mode === 'wrong'
          ? wrongQuestions.slice(0, ROUND_SIZE)
          : takeRound(pools[section], ROUND_SIZE))
      if (queue.length === 0) return
      playedKeyRef.current = null
      stopAudio()
      setRound({
        mode,
        section,
        queue,
        index: 0,
        answer: null,
        correct: 0,
        wrong: 0,
        skipped: 0,
        wrongThisRound: [],
        counted: false,
        retried: false,
      })
    },
    [pools, section, stopAudio, wrongQuestions],
  )

  const choose = (letter: ExamLetter) => {
    if (!round || round.answer !== null || !current) return
    const isCorrect = letter === current.answer
    const counts = !round.counted
    setRound({
      ...round,
      answer: letter,
      counted: true,
      correct: round.correct + (counts && isCorrect ? 1 : 0),
      wrong: round.wrong + (counts && !isCorrect ? 1 : 0),
      wrongThisRound:
        counts && !isCorrect ? [...round.wrongThisRound, current] : round.wrongThisRound,
    })
    if (counts) {
      setStats(recordDrillAnswer(sectionOfQuestion(current.n), isCorrect))
      setWrongStore(
        isCorrect
          ? removeDrillWrong(current.exerciseId, current.n)
          : addDrillWrong(current.exerciseId, current.n),
      )
    }
    stopAudio()
  }

  const goNext = () => {
    if (!round || round.answer === null) return
    stopAudio()
    setRound({ ...round, index: round.index + 1, answer: null, counted: false, retried: false })
  }

  /** 跳过：不计对错、不进统计，只累加跳过数（卡住时不必作废整轮） */
  const skip = () => {
    if (!round || round.answer !== null) return
    stopAudio()
    setRound({
      ...round,
      index: round.index + 1,
      answer: null,
      counted: false,
      retried: false,
      skipped: round.skipped + 1,
    })
  }

  /** 重做：清掉这次选择再来一遍；第一次的对错已计入，重做不再计分 */
  const redo = () => {
    if (!round || round.answer === null) return
    stopAudio()
    setRound({ ...round, answer: null, counted: true, retried: true })
  }

  const quitRound = () => {
    stopAudio()
    playedKeyRef.current = null
    setRound(null)
  }

  const jumpToCourse = () => {
    if (!current) return
    const lineId = range?.partLineId
    navigate(
      `/courses/${current.categoryId}/chapters/${current.exerciseId}?stage=intensive${lineId ? `&line=${encodeURIComponent(lineId)}` : ''}`,
    )
  }

  const clearWrong = () => {
    if (!window.confirm(t('drill.wrong.confirmClear'))) return
    setWrongStore(clearDrillWrong())
  }

  const resetStats = () => {
    if (!window.confirm(t('drill.stats.confirmReset'))) return
    setStats(resetDrillStats())
  }

  const totalStat = useMemo(() => {
    const correct = SECTIONS.reduce((sum, item) => sum + stats[item].correct, 0)
    const wrong = SECTIONS.reduce((sum, item) => sum + stats[item].wrong, 0)
    const total = correct + wrong
    return { total, accuracy: total > 0 ? Math.round((correct / total) * 100) : null }
  }, [stats])

  // ── 键盘作答：A–D / 1–4 选，Enter/→ 下一题，R 重听，S 跳过 ──
  // 处理器走 ref：播放中每 250ms 一次 timeupdate 都会重渲染，若进依赖数组，
  // 监听器会被反复摘挂（实战舞台踩过同样的坑）。
  const keyStateRef = useRef({ choose, goNext, skip, playCurrent, round, current, finished })
  keyStateRef.current = { choose, goNext, skip, playCurrent, round, current, finished }
  useEffect(() => {
    const letterByKey: Record<string, ExamLetter> = {
      a: 'A',
      b: 'B',
      c: 'C',
      d: 'D',
      1: 'A',
      2: 'B',
      3: 'C',
      4: 'D',
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const state = keyStateRef.current
      if (!state.round || state.finished || !state.current) return
      const key = event.key.toLowerCase()
      const letter = letterByKey[key]
      if (letter) {
        if (state.round.answer === null) {
          event.preventDefault()
          state.choose(letter)
        }
        return
      }
      if (key === 'enter' || key === 'arrowright') {
        if (state.round.answer !== null) {
          event.preventDefault()
          state.goNext()
        }
        return
      }
      if (key === 's') {
        if (state.round.answer === null) {
          event.preventDefault()
          state.skip()
        }
        return
      }
      if (key === 'r') {
        event.preventDefault()
        state.playCurrent()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const poolCount = pools[section].length
  const roundSize = Math.min(ROUND_SIZE, poolCount)

  return (
    <div className="drill-page">
      <TopBar active="drill" />
      <div className="drill-container">
        <header className="drill-header">
          <h1>{t('drill.title')}</h1>
          <p>{t('drill.subtitle')}</p>
        </header>

        {status === 'loading' ? (
          <p className="drill-empty">{t('drill.loading')}</p>
        ) : status === 'error' ? (
          <div className="drill-empty">
            <p>{t('drill.loadFailed')}</p>
            <button className="drill-ghost" onClick={reload} type="button">
              {t('drill.retry')}
            </button>
          </div>
        ) : (
          <>
            <audio
              onEnded={() => {
                stopAtRef.current = null
                setPlaying(false)
              }}
              onTimeUpdate={handleTimeUpdate}
              preload="metadata"
              ref={audioRef}
              src={current ? resolveApiUrl(current.audioUrl) : undefined}
            />

            {!round && (
              <section className="drill-panel">
                <div className="drill-section-tabs" role="radiogroup" aria-label={t('drill.title')}>
                  {SECTIONS.map((item) => (
                    <button
                      aria-checked={section === item}
                      className={section === item ? 'drill-section-tab active' : 'drill-section-tab'}
                      key={item}
                      onClick={() => setSection(item)}
                      role="radio"
                      type="button"
                    >
                      <span className="drill-section-title">
                        {t(SECTION_LABEL[item])}
                        <span className="drill-section-range">{t(SECTION_RANGE[item])}</span>
                      </span>
                      <span className="drill-section-count">
                        {pools[item].length > 0
                          ? t('drill.pool', { count: pools[item].length })
                          : t('drill.poolEmpty')}
                      </span>
                    </button>
                  ))}
                </div>

                {poolCount > 0 ? (
                  <button className="drill-start" onClick={() => startRound('pool')} type="button">
                    <Headphones size={16} aria-hidden="true" />
                    {t('drill.start', { count: roundSize })}
                  </button>
                ) : (
                  <p className="drill-empty">{t('drill.emptyPool')}</p>
                )}

                {wrongQuestions.length > 0 && (
                  <div className="drill-wrongbar">
                    <span className="drill-wrongbar-main">
                      <CircleAlert size={14} aria-hidden="true" />
                      {t('drill.wrong.title')}
                      <span className="drill-wrongbar-count">
                        {t('drill.wrong.count', { count: wrongQuestions.length })}
                      </span>
                    </span>
                    <span className="drill-wrongbar-actions">
                      <button className="drill-ghost" onClick={() => startRound('wrong')} type="button">
                        {t('drill.wrong.start')}
                      </button>
                      <button className="drill-ghost" onClick={clearWrong} type="button">
                        {t('drill.wrong.clear')}
                      </button>
                    </span>
                  </div>
                )}
              </section>
            )}

            {round && !finished && current && (
              <section
                className="drill-question-card"
                data-exercise-id={current.exerciseId}
                data-question-no={current.n}
              >
                <div className="drill-q-head">
                  <span className="drill-q-no">{t('drill.questionLabel', { n: current.n })}</span>
                  {round.mode === 'wrong' && (
                    <span className="drill-mode-chip">{t('drill.mode.wrong')}</span>
                  )}
                  <span className="drill-q-source">{current.title}</span>
                  <span className="drill-q-progress">
                    {t('drill.roundProgress', {
                      index: round.index + 1,
                      total: round.queue.length,
                    })}
                  </span>
                  {round.answer === null && (
                    <button className="drill-ghost" onClick={skip} type="button">
                      {t('drill.skip')}
                    </button>
                  )}
                  <button className="drill-ghost" onClick={quitRound} type="button">
                    {t('drill.quit')}
                  </button>
                </div>

                <div className="drill-audio">
                  <button
                    className="drill-play"
                    disabled={!range}
                    onClick={playCurrent}
                    type="button"
                  >
                    {playing ? <RotateCcw size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                    <span>{t('drill.play')}</span>
                  </button>
                  <span className="drill-clock">
                    {range ? `${formatClock(position)} / ${formatClock(range.end - range.start)}` : t('drill.audioLoading')}
                  </span>
                  {!range && detail && <span className="drill-audio-hint">{t('drill.audioMissing')}</span>}
                </div>

                <div className="drill-options">
                  {LETTERS.map((letter) => {
                    const revealed = round.answer !== null
                    const isCorrect = letter === current.answer
                    const isMine = round.answer === letter
                    const className =
                      'drill-option' +
                      (revealed && isCorrect ? ' correct' : '') +
                      (revealed && isMine && !isCorrect ? ' wrong' : '') +
                      (isMine ? ' picked' : '')
                    return (
                      <button
                        className={className}
                        disabled={revealed}
                        key={letter}
                        onClick={() => choose(letter)}
                        type="button"
                      >
                        <span className="drill-option-letter">{letter}</span>
                        <span className="drill-option-text">{current.options[letter]}</span>
                        {revealed && isCorrect && <Check className="drill-option-mark" size={15} aria-hidden="true" />}
                        {revealed && isMine && !isCorrect && <X className="drill-option-mark" size={15} aria-hidden="true" />}
                      </button>
                    )
                  })}
                </div>

                {round.answer !== null && (
                  <div
                    aria-live="polite"
                    className={round.answer === current.answer ? 'drill-verdict ok' : 'drill-verdict bad'}
                  >
                    <div className="drill-verdict-head">
                      <strong>
                        {round.answer === current.answer ? t('drill.right') : t('drill.wrong')}
                      </strong>
                      <span>{t('drill.correctAnswer', { letter: current.answer })}</span>
                      {round.retried && <span className="drill-retry-note">{t('drill.retryNotCounted')}</span>}
                    </div>
                    <div className="drill-verdict-foot">
                      <div className="drill-verdict-actions">
                        <button className="drill-ghost" onClick={jumpToCourse} type="button">
                          {t('drill.goCourse')}
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                        <button className="drill-ghost" onClick={playCurrent} type="button">
                          <RotateCcw size={14} aria-hidden="true" />
                          {t('drill.replay')}
                        </button>
                      </div>
                      <div className="drill-verdict-actions">
                        {round.answer !== current.answer && (
                          <button className="drill-ghost" onClick={redo} type="button">
                            {t('drill.redo')}
                          </button>
                        )}
                        <button className="drill-next" onClick={goNext} type="button">
                          {round.index + 1 >= round.queue.length ? t('drill.finish') : t('drill.next')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <p className="drill-key-hint">{t('drill.keyHint')}</p>
              </section>
            )}

            {round && finished && (
              <section className="drill-summary">
                <h2>{t('drill.done.title')}</h2>
                <p className="drill-summary-score">
                  <strong>{round.correct}</strong> / {round.queue.length}
                </p>
                <p className="drill-summary-detail">
                  {t('drill.stats.detail', { correct: round.correct, wrong: round.wrong })}
                  {round.skipped > 0 ? ` · ${t('drill.done.skipped', { count: round.skipped })}` : ''}
                </p>
                <p className="drill-summary-hint">{t('drill.done.hint')}</p>
                <div className="drill-summary-actions">
                  {round.wrongThisRound.length > 0 && (
                    <button
                      className="drill-start"
                      onClick={() => startRound('wrong', round.wrongThisRound)}
                      type="button"
                    >
                      {t('drill.done.wrongOnly', { count: round.wrongThisRound.length })}
                    </button>
                  )}
                  <button
                    className={round.wrongThisRound.length > 0 ? 'drill-ghost' : 'drill-start'}
                    onClick={() => startRound(round.mode)}
                    type="button"
                  >
                    {t('drill.again')}
                  </button>
                  <button className="drill-ghost" onClick={quitRound} type="button">
                    {t('drill.backToSetup')}
                  </button>
                </div>
              </section>
            )}

            <section className="drill-stats" aria-label={t('drill.stats.title')}>
              <div className="drill-stats-head">
                <h2>{t('drill.stats.title')}</h2>
                <span className="drill-stats-total">
                  {totalStat.accuracy === null
                    ? t('drill.stats.totalEmpty')
                    : t('drill.stats.total', {
                        count: totalStat.total,
                        accuracy: totalStat.accuracy,
                      })}
                </span>
                {totalStat.total > 0 && (
                  <button className="drill-ghost" onClick={resetStats} type="button">
                    {t('drill.stats.reset')}
                  </button>
                )}
              </div>
              <ul>
                {SECTIONS.map((item) => {
                  const stat = stats[item]
                  const accuracy = accuracyOf(stat)
                  return (
                    <li key={item}>
                      <span className="drill-stats-name">
                        {t(SECTION_LABEL[item])}
                        <span className="drill-stats-range">{t(SECTION_RANGE[item])}</span>
                      </span>
                      <span className="drill-stats-detail">
                        {t('drill.stats.detail', { correct: stat.correct, wrong: stat.wrong })}
                      </span>
                      <span className="drill-stats-accuracy">
                        {accuracy === null ? t('drill.stats.none') : `${accuracy}%`}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          </>
        )}

        <p className="drill-note">
          <CircleAlert size={13} aria-hidden="true" />
          {t('drill.note')}
        </p>
      </div>
    </div>
  )
}
