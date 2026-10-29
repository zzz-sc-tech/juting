import { Check, ChevronRight, CircleAlert, Headphones, Play, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { extractDialogueAnchors, type ListeningExercise } from '@juting/shared'
import { TopBar } from '../components/TopBar'
import { useDrillData } from '../hooks/useDrillData'
import { useLanguage } from '../i18n/LanguageProvider'
import type { MessageKey } from '../i18n/messages'
import { apiClient, resolveApiUrl } from '../lib/apiClient'
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
  type DrillStats,
} from '../lib/drillStats'
import type { ExamLetter, ExamSection } from '../lib/examHistory'

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

// 单课详情（拿题干时间轴）：按课缓存，一轮 10 题通常只碰 2-3 门课
const detailCache = new Map<number, ListeningExercise>()

function useExerciseDetailLite(exerciseId: number | null) {
  const [detail, setDetail] = useState<ListeningExercise | null>(null)
  useEffect(() => {
    if (exerciseId === null) {
      setDetail(null)
      return
    }
    const cached = detailCache.get(exerciseId)
    if (cached) {
      setDetail(cached)
      return
    }
    let mounted = true
    setDetail(null)
    apiClient
      .getExercise(exerciseId, 'zh-CN')
      .then((exercise) => {
        detailCache.set(exerciseId, exercise)
        if (mounted) setDetail(exercise)
      })
      .catch(() => {
        // 详情拉不到只影响「播放本题音频」，题目本身照做
      })
    return () => {
      mounted = false
    }
  }, [exerciseId])
  return detail
}

type DrillRound = {
  section: ExamSection
  queue: DrillQuestion[]
  index: number
  answer: ExamLetter | null
  correct: number
  wrong: number
}

export function DrillPage() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const { exercises, status, reload } = useDrillData()
  const [section, setSection] = useState<ExamSection>('A')
  const [round, setRound] = useState<DrillRound | null>(null)
  const [stats, setStats] = useState<DrillStats>(loadDrillStats)

  const pools = useMemo(
    () => ({
      A: buildDrillPool(exercises, 'A'),
      B: buildDrillPool(exercises, 'B'),
      C: buildDrillPool(exercises, 'C'),
    }),
    [exercises],
  )

  const current = round && round.index < round.queue.length ? round.queue[round.index] : null
  const finished = Boolean(round && round.index >= round.queue.length)
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
  const startRound = useCallback(() => {
    const pool = pools[section]
    if (pool.length === 0) return
    playedKeyRef.current = null
    stopAudio()
    setRound({
      section,
      queue: takeRound(pool, ROUND_SIZE),
      index: 0,
      answer: null,
      correct: 0,
      wrong: 0,
    })
  }, [pools, section, stopAudio])

  const choose = (letter: ExamLetter) => {
    if (!round || round.answer !== null || !current) return
    const isCorrect = letter === current.answer
    setRound((state) =>
      state
        ? {
            ...state,
            answer: letter,
            correct: state.correct + (isCorrect ? 1 : 0),
            wrong: state.wrong + (isCorrect ? 0 : 1),
          }
        : state,
    )
    setStats(recordDrillAnswer(round.section, isCorrect))
    stopAudio()
  }

  const goNext = () => {
    stopAudio()
    setRound((state) => (state ? { ...state, index: state.index + 1, answer: null } : state))
  }

  const quitRound = () => {
    stopAudio()
    playedKeyRef.current = null
    setRound(null)
  }

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
                  <button className="drill-start" onClick={startRound} type="button">
                    <Headphones size={16} aria-hidden="true" />
                    {t('drill.start', { count: roundSize })}
                  </button>
                ) : (
                  <p className="drill-empty">{t('drill.emptyPool')}</p>
                )}
              </section>
            )}

            {round && !finished && current && (
              <section className="drill-question-card">
                <div className="drill-q-head">
                  <span className="drill-q-no">{t('drill.questionLabel', { n: current.n })}</span>
                  <span className="drill-q-source">{current.title}</span>
                  <span className="drill-q-progress">
                    {t('drill.roundProgress', {
                      index: round.index + 1,
                      total: round.queue.length,
                    })}
                  </span>
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
                  <div className={round.answer === current.answer ? 'drill-verdict ok' : 'drill-verdict bad'}>
                    <div className="drill-verdict-head">
                      <strong>
                        {round.answer === current.answer ? t('drill.right') : t('drill.wrong')}
                      </strong>
                      <span>{t('drill.correctAnswer', { letter: current.answer })}</span>
                    </div>
                    <div className="drill-verdict-foot">
                      <button
                        className="drill-ghost"
                        onClick={() =>
                          navigate(
                            `/courses/${current.categoryId}/chapters/${current.exerciseId}?stage=intensive`,
                          )
                        }
                        type="button"
                      >
                        {t('drill.goCourse')}
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                      <button className="drill-next" onClick={goNext} type="button">
                        {round.index + 1 >= round.queue.length ? t('drill.finish') : t('drill.next')}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {round && finished && (
              <section className="drill-summary">
                <h2>{t('drill.done.title')}</h2>
                <p className="drill-summary-score">
                  <strong>{round.correct}</strong> / {round.queue.length}
                </p>
                <p className="drill-summary-hint">{t('drill.done.hint')}</p>
                <div className="drill-summary-actions">
                  <button className="drill-start" onClick={startRound} type="button">
                    {t('drill.again')}
                  </button>
                  <button className="drill-ghost" onClick={quitRound} type="button">
                    {t('drill.backToSetup')}
                  </button>
                </div>
              </section>
            )}

            <section className="drill-stats" aria-label={t('drill.stats.title')}>
              <h2>{t('drill.stats.title')}</h2>
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
