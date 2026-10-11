import { ArrowLeft, CircleHelp, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CatalogExerciseSummary, ListeningExercise, TranscriptLine } from '@juting/shared'
import { DifficultReviewStage } from '../components/DifficultReviewStage'
import { TopBar } from '../components/TopBar'
import { apiClient } from '../lib/apiClient'
import { loadStoredStudyStore, persistStudyStore } from '../lib/progressStore'
import { loadUserPrefs, persistUserPrefs } from '../lib/userPrefs'
import { setPendingWaveLoop } from '../lib/waveHandoff'
import { useStudyProgress } from '../hooks/useStudyProgress'
import { useMediaPlayback } from '../hooks/useMediaPlayback'
import { useLanguage } from '../i18n/LanguageProvider'

/**
 * 全局难点池（/review）：跨课程聚合所有标记为难点的句子。
 * 按课分组复习（一次只加载一门课的详情，38 课全量行数据不适合一次拉全），
 * 课程队列按未攻克数排序；课内先听后看/攻克出池/连播，与课内复习同一套语义。
 */
export function GlobalReviewPage() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [store, setStore] = useState(loadStoredStudyStore)
  const [catalogTitleById, setCatalogTitleById] = useState<Record<number, string>>({})

  // 进度落盘：800ms 防抖（与学习页同节奏）
  useEffect(() => {
    const timer = window.setTimeout(() => persistStudyStore(store), 800)
    return () => window.clearTimeout(timer)
  }, [store])

  // 课程标题：目录接口（summary 级，廉价）
  useEffect(() => {
    let mounted = true
    const titles: Record<number, string> = {}
    const load = async () => {
      try {
        const catalog = await apiClient.getCatalog('zh-CN')
        for (const category of catalog.categories) {
          const exercises = await apiClient.getCategoryExercises(category.id, 'zh-CN')
          for (const exercise of exercises as CatalogExerciseSummary[]) {
            titles[exercise.id] = exercise.title
          }
        }
        if (mounted) setCatalogTitleById(titles)
      } catch {
        // 目录失败不阻断复习：标题缺省显示课程 id
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  // 难点池：每课 unclear 行数
  const poolByCourse = useMemo(() => {
    const result: Array<{ courseId: number; count: number }> = []
    for (const [courseId, progress] of Object.entries(store.progressByExercise)) {
      const count = Object.values(progress.lines ?? {}).filter((line) => line?.unclear && !line.mastered).length
      if (count > 0) {
        result.push({ courseId: Number(courseId), count })
      }
    }
    return result.sort((a, b) => b.count - a.count)
  }, [store.progressByExercise])
  const totalRemaining = useMemo(
    () => poolByCourse.reduce((sum, entry) => sum + entry.count, 0),
    [poolByCourse],
  )

  const [courseQueue, setCourseQueue] = useState<number[]>([])
  const [courseIdx, setCourseIdx] = useState(0)
  const [drill, setDrill] = useState<ListeningExercise | undefined>()
  const [loading, setLoading] = useState(false)

  // 池子变化时重建课程队列（保持当前课在队首的相对顺序）
  useEffect(() => {
    setCourseQueue(poolByCourse.map((entry) => entry.courseId))
  }, [poolByCourse])

  const currentCourseId = courseQueue[courseIdx]

  // 加载当前课详情
  useEffect(() => {
    if (currentCourseId === undefined) {
      setDrill(undefined)
      return
    }
    let mounted = true
    setLoading(true)
    apiClient
      .getExercise(currentCourseId, 'zh-CN')
      .then((exercise) => {
        if (mounted) {
          setDrill(exercise)
          setLoading(false)
        }
      })
      .catch(() => {
        if (mounted) {
          setDrill(undefined)
          setLoading(false)
        }
      })
    return () => {
      mounted = false
    }
  }, [currentCourseId])

  // 过滤指令行（与学习页同源语义：锚点消费的行不是复习对象）
  const studyLines = useMemo(() => {
    if (!drill) return []
    // 轻量近似：指令/题干行靠 domain 锚点太重，这里直接复用 detail 的全部行——
    // 难点池本身只可能包含用户在学习页标记过的行（即正文行），无需再过滤。
    return drill.lines
  }, [drill])

  const reviewLines = useMemo(
    () =>
      studyLines.filter((line) => {
        const item = store.progressByExercise[drill?.id ?? '']?.lines?.[line.id]
        return item?.unclear && !item.mastered
      }),
    [drill?.id, store.progressByExercise, studyLines],
  )

  // 选中句：第一句未攻克难点（池内变化自动落位）
  const selectedLine = reviewLines[0] ?? null

  // 播放：本地 useMediaPlayback（无 StudySession 依赖）；
  // 速率跟随该课记忆（练习偏好），未调速的课按全局默认
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const courseRate =
    (currentCourseId !== undefined
      ? store.progressByExercise[currentCourseId]?.playbackRate
      : undefined) ?? loadUserPrefs().defaultPlaybackRate
  const playback = useMediaPlayback({ mediaRef, playbackRate: courseRate })
  const { currentTime, isPlaying } = playback

  const progressHook = useStudyProgress({ activeExercise: drill, store, setStore })
  const { countLineRepeat, markLineMastered, markLineUnclear } = progressHook

  const playLine = useCallback(
    async (line: TranscriptLine) => {
      if (!line) return
      countLineRepeat(line.id)
      await playback.runPlayback(async () => {
        await playback.playMediaRange(line.start, line.end)
      })
    },
    [countLineRepeat, playback],
  )

  // 连播：自然播完 → 下一句；课内清空 → 下一课
  const prevPlayingRef = useRef(isPlaying)
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime
  const advanceRef = useRef<() => void>(() => {})
  advanceRef.current = () => {
    const idx = reviewLines.findIndex((line) => line.id === selectedLine?.id)
    const next = reviewLines[idx + 1]
    if (next) {
      void playLine(next)
      return
    }
    // 本课清空 → 下一课
    setCourseIdx((current) => current + 1)
  }
  useEffect(() => {
    if (prevPlayingRef.current && !isPlaying) {
      const line = selectedLine
      if (
        line &&
        loadUserPrefs().reviewAutoAdvance &&
        Math.abs(currentTimeRef.current - line.end) < 0.25
      ) {
        advanceRef.current()
      }
    }
    prevPlayingRef.current = isPlaying
  }, [isPlaying, selectedLine])

  // 攻克（F）= 掌握并移出池；D = 仅移出
  const conquer = useCallback(
    (lineId: string) => {
      const item = store.progressByExercise[drill?.id ?? '']?.lines?.[lineId]
      if (drill && !store.progressByExercise[drill.id]?.lines?.[lineId]?.mastered) {
        markLineMastered(lineId)
      }
      if (item?.unclear) {
        markLineUnclear(lineId)
      }
    },
    [drill, markLineMastered, markLineUnclear, store.progressByExercise],
  )
  const removeFromPool = useCallback(
    (lineId: string) => {
      if (store.progressByExercise[drill?.id ?? '']?.lines?.[lineId]?.unclear) {
        markLineUnclear(lineId)
      }
    },
    [drill?.id, markLineUnclear, store.progressByExercise],
  )

  const goWaveLoop = useCallback(
    (line: { start: number; end: number }) => {
      if (!drill) return
      setPendingWaveLoop({ exerciseId: drill.id, start: line.start, end: line.end })
      navigate(`/courses/1/chapters/${drill.id}?stage=waveform`)
    },
    [drill, navigate],
  )

  // 先听后看
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    setRevealed(false)
  }, [selectedLine?.id])

  if (totalRemaining === 0 || courseQueue.length === 0) {
    return (
      <div className="settings-page">
        <TopBar />
        <div className="settings-container">
          <div className="review-empty-card">
            <CircleHelp size={26} aria-hidden="true" />
            <strong>{t('globalReview.empty')}</strong>
            <button className="icon-button primary wide" onClick={() => navigate('/home')} type="button">
              {t('globalReview.backHome')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-page">
      <TopBar />
      <div className="settings-container global-review-container">
        <header className="settings-header">
          <button aria-label={t('settings.back')} className="settings-back" onClick={() => navigate('/home')} type="button">
            <ArrowLeft size={20} />
          </button>
          <h1 className="settings-title">{t('globalReview.title')}</h1>
          <span className="global-review-total">{t('globalReview.remaining', { count: totalRemaining })}</span>
        </header>

        <nav className="global-review-queue" aria-label={t('globalReview.title')}>
          {poolByCourse.map((entry, index) => (
            <button
              className={
                'global-review-course-chip' +
                (entry.courseId === currentCourseId ? ' current' : '')
              }
              key={entry.courseId}
              onClick={() => setCourseIdx(index)}
              type="button"
            >
              <span>{catalogTitleById[entry.courseId] ?? `#${entry.courseId}`}</span>
              <span className="global-review-course-count">{entry.count}</span>
            </button>
          ))}
        </nav>

        {loading || !drill ? (
          <p className="dashboard-empty">{t('globalReview.loading')}</p>
        ) : reviewLines.length === 0 ? (
          <p className="dashboard-empty">{t('globalReview.loading')}</p>
        ) : (
          <DifficultReviewStage
            exercise={drill}
            mediaRef={mediaRef}
            progress={store.progressByExercise[drill.id]}
            reviewLines={reviewLines}
            selectedLine={selectedLine}
            isPlaying={isPlaying}
            revealed={revealed}
            onReveal={() => setRevealed(true)}
            onBackToIntensive={() => navigate(`/courses/1/chapters/${drill.id}?stage=intensive`)}
            onLineSelect={(lineId) => {
              const line = reviewLines.find((item) => item.id === lineId)
              if (line) void playLine(line)
            }}
            onRemoveFromPool={removeFromPool}
            onConquer={conquer}
            onMoveReviewLine={(offset) => {
              const idx = reviewLines.findIndex((line) => line.id === selectedLine?.id)
              const next = reviewLines[idx + offset]
              if (next) void playLine(next)
            }}
            onPlayLine={(line) => void playLine(line)}
            onTogglePlayback={playback.toggleMediaPlayback}
            autoAdvance={loadUserPrefs().reviewAutoAdvance}
            onToggleAutoAdvance={() => {
              const prefs = loadUserPrefs()
              persistUserPrefs({ ...prefs, reviewAutoAdvance: !prefs.reviewAutoAdvance })
            }}
            orderMode="weakest"
            onCycleOrder={() => {}}
            onGoWaveLoop={goWaveLoop}
          />
        )}

        {courseQueue.length > 1 && (
          <button
            className="command-button ghost global-review-next"
            disabled={courseIdx >= courseQueue.length - 1}
            onClick={() => setCourseIdx((current) => current + 1)}
            type="button"
          >
            {t('globalReview.nextCourse')}
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
