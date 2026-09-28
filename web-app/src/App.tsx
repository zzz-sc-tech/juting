import { BookOpenText } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import './App.css'
import { DashboardPage } from './components/dashboard/DashboardPage'
import { SettingsPage } from './components/SettingsPage'
import { CourseMap } from './components/CourseMap'
import { DifficultReviewStage } from './components/DifficultReviewStage'
import { ExtensiveStage } from './components/ExtensiveStage'
import { IntensiveStage } from './components/IntensiveStage'
import { StageRail } from './components/StageRail'
import { WaveformStage } from './components/WaveformStage'
import {
  CatalogErrorState,
  EmptyStudyState,
  ExerciseErrorState,
  ExerciseLoadingState,
} from './components/StudyStates'
import { TopBar } from './components/TopBar'
import { useCatalog } from './hooks/useCatalog'
import { useCategoryExercises } from './hooks/useCategoryExercises'
import { useExerciseDetail } from './hooks/useExerciseDetail'
import { useMediaPlayback } from './hooks/useMediaPlayback'
import { useStudyProgress } from './hooks/useStudyProgress'
import { useLanguage } from './i18n/LanguageProvider'
import {
  calculateChapterProgress,
  calculateSeriesProgress,
  loadLocalActivity,
  loadStoredStudyStore,
  localDayString,
  persistLocalActivity,
  persistStudyStore,
  recordLocalMastery,
  type LocalDailyActivity,
  type SeriesProgressSummary,
} from './lib/progressStore'
import { buildStudySections } from './lib/studySections'
import { stageCopy, type StudyStage } from './lib/studyStages'
import {
  extractDialogueAnchors,
  findDialogueAnchorAtTime,
  type DialogueAnchor,
} from '@juting/shared'
import type {
  CatalogExerciseSummary,
  TranscriptLine,
} from '@juting/shared'



function LearnerAppShell() {
  const navigate = useNavigate()
  const { contentLocale, t } = useLanguage()
  const { seriesId: routeSeriesId, exerciseId: routeExerciseId } = useParams<{
    seriesId?: string
    exerciseId?: string
  }>()
  const parsedRouteSeriesId = routeSeriesId ? Number(routeSeriesId) : undefined
  const parsedRouteExerciseId = routeExerciseId ? Number(routeExerciseId) : undefined
  const [searchParams, setSearchParams] = useSearchParams()
  const [studyStage, setStudyStage] = useState<StudyStage>('extensive')
  const [completedStages, setCompletedStages] = useState<
    Partial<Record<StudyStage, boolean>>
  >({})
  const [revealedLineIds, setRevealedLineIds] = useState<Record<string, true>>(
    {},
  )
  // 本地免登录模式：进度与每日掌握计数都持久化在 localStorage，刷新/重启不丢。
  const [store, setStore] = useState(loadStoredStudyStore)
  const [, setDailyActivity] = useState<LocalDailyActivity>(loadLocalActivity)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const loopingLineIdRef = useRef('')

  // 进度变更 800ms 防抖写回本地（原服务端同步的本地替代）。
  // pagehide 兜底：防抖窗口内关页也不丢最后一次进度。
  useEffect(() => {
    const timer = window.setTimeout(() => persistStudyStore(store), 800)
    const flushOnHide = () => persistStudyStore(store)
    window.addEventListener('pagehide', flushOnHide)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pagehide', flushOnHide)
    }
  }, [store])

  const {
    catalog,
    catalogLoadFailed,
    reload: reloadCatalog,
  } = useCatalog(contentLocale)
  const {
    exercisesByCategory,
    loadExercises,
  } = useCategoryExercises(contentLocale)
  const seriesProgressByCategory = useMemo<Record<string, SeriesProgressSummary>>(() => {
    return Object.fromEntries(
      catalog.categories.map((category) => [
        category.id,
        calculateSeriesProgress(exercisesByCategory[category.id] ?? [], store),
      ]),
    )
  }, [catalog.categories, exercisesByCategory, store])
  const selectedSeriesId = useMemo(() => {
    if (
      Number.isInteger(parsedRouteSeriesId) &&
      catalog.categories.some((category) => category.id === parsedRouteSeriesId)
    ) {
      return parsedRouteSeriesId as number
    }

    return catalog.categories[0]?.id ?? 0
  }, [catalog.categories, parsedRouteSeriesId])

  // 懒加载当前系列下的课程列表
  const seriesExercises = useMemo(
    () => exercisesByCategory[selectedSeriesId] ?? [],
    [exercisesByCategory, selectedSeriesId],
  )
  const chapterProgressByExercise = useMemo(
    () =>
      Object.fromEntries(
        seriesExercises.map((exercise) => [
          exercise.id,
          calculateChapterProgress(exercise, store),
        ]),
      ),
    [seriesExercises, store],
  )

  // 根据 URL 或系列默认值确定当前课程
  const activeExerciseSummary = useMemo<CatalogExerciseSummary | undefined>(
    () => {
      if (parsedRouteExerciseId && seriesExercises.length > 0) {
        return seriesExercises.find(
          (exercise) =>
            exercise.id === parsedRouteExerciseId &&
            exercise.categoryId === selectedSeriesId,
        )
      }
      return seriesExercises[0]
    },
    [parsedRouteExerciseId, selectedSeriesId, seriesExercises],
  )
  const hasExercise = Boolean(activeExerciseSummary)

  const { activeExercise, exerciseLoading, exerciseLoadFailed } =
    useExerciseDetail({
      activeExerciseSummary,
      setStore,
      contentLocale,
    })

  // ── 对话锚点与精听内容过滤 ────────────────────────────────
  // 锚点指令行（报头/介绍/题干播报）不作为学习句子：先从全量行提取锚点，
  // 再派生 studyExercise（只含正文句）喂给精听链路；泛听/课程地图仍用全量。
  const dialogueAnchors = useMemo(
    () => (activeExercise ? extractDialogueAnchors(activeExercise.lines) : []),
    [activeExercise],
  )
  const studyExercise = useMemo(() => {
    if (!activeExercise) {
      return undefined
    }
    if (dialogueAnchors.length === 0) {
      return activeExercise
    }
    const instructionIds = new Set(
      dialogueAnchors.flatMap((anchor) => anchor.lineIds),
    )
    return {
      ...activeExercise,
      lines: activeExercise.lines.filter((line) => !instructionIds.has(line.id)),
    }
  }, [activeExercise, dialogueAnchors])
  const studySections = useMemo(() => {
    if (!activeExercise || !studyExercise) {
      return []
    }
    return buildStudySections(
      activeExercise.lines,
      dialogueAnchors,
      studyExercise.lines,
      t('transcript.introSection'),
    )
  }, [activeExercise, dialogueAnchors, studyExercise, t])

  const {
    lineProgress,
    markLineMastered,
    markLineUnclear,
    masteryPercent,
    progress,
    selectedLine,
    selectedLineIndex,
    selectLine,
    updateActiveProgress,
  } = useStudyProgress({
    activeExercise: studyExercise,
    store,
    setStore,
  })
  const {
    currentTime,
    duration,
    isPlaying,
    playMedia,
    playMediaRange,
    seekMedia,
    runPlayback,
    stopPlayback,
    toggleMediaPlayback,
  } = useMediaPlayback({
    mediaRef,
    playbackRate: progress?.playbackRate ?? 1,
  })

  const syncRoute = useCallback((
    nextSeriesId: number,
    nextExerciseId: number,
    nextStage: StudyStage = studyStage,
    options?: { replace?: boolean },
  ) => {
    const nextParams = new URLSearchParams(searchParams)
    if (nextStage === 'extensive') {
      nextParams.delete('stage')
    } else {
      nextParams.set('stage', nextStage)
    }

    const nextSearch = nextParams.toString()
    navigate(
      `/courses/${encodeURIComponent(nextSeriesId)}/chapters/${encodeURIComponent(nextExerciseId)}${nextSearch ? `?${nextSearch}` : ''}`,
      { replace: options?.replace ?? false },
    )
  }, [navigate, searchParams, studyStage])

  // URL 的 ?stage= 参数直接决定学习阶段；本地免登录，无需任何认证守卫。
  useEffect(() => {
    const stageParam = searchParams.get('stage')
    if (
      stageParam === 'intensive' ||
      stageParam === 'extensive' ||
      stageParam === 'waveform' ||
      stageParam === 'review'
    ) {
      setStudyStage((current) => (current === stageParam ? current : stageParam))
      return
    }

    setStudyStage((current) => (current === 'extensive' ? current : 'extensive'))
  }, [searchParams])

  // 当选中系列改变时，懒加载该系列下的课程列表
  useEffect(() => {
    if (selectedSeriesId > 0) {
      loadExercises(selectedSeriesId)
    }
  }, [selectedSeriesId, loadExercises])

  // 课程选择弹窗需要展示所有课程的整体完成度；这里预取每个课程的章节摘要。
  // 摘要只包含章节元数据和 lineCount，不会加载逐句详情或媒体文件。
  useEffect(() => {
    for (const category of catalog.categories) {
      void loadExercises(category.id)
    }
  }, [catalog.categories, loadExercises])

  // 当系列下的课程列表加载完成后，校验路由是否有效
  useEffect(() => {
    if (seriesExercises.length === 0) {
      return
    }

    const validSeries = parsedRouteSeriesId
      ? catalog.categories.some((category) => category.id === parsedRouteSeriesId)
      : false
    const validExercise = parsedRouteExerciseId
      ? seriesExercises.some((exercise) => exercise.id === parsedRouteExerciseId)
      : false

    if (
      validSeries &&
      validExercise &&
      seriesExercises.some(
        (exercise) =>
          exercise.id === parsedRouteExerciseId && exercise.categoryId === parsedRouteSeriesId,
      )
    ) {
      return
    }

    const fallbackExercise =
      seriesExercises.find((exercise) => exercise.categoryId === parsedRouteSeriesId) ??
      seriesExercises.find((exercise) => exercise.id === parsedRouteExerciseId) ??
      seriesExercises[0]

    if (!fallbackExercise) {
      return
    }

    syncRoute(
      fallbackExercise.categoryId,
      fallbackExercise.id,
      (searchParams.get('stage') as StudyStage | null) ?? 'extensive',
      { replace: true },
    )
  }, [
    catalog.categories,
    seriesExercises,
    parsedRouteExerciseId,
    parsedRouteSeriesId,
    searchParams,
    syncRoute,
  ])

  useEffect(() => {
    if (!activeExerciseSummary) {
      return
    }

    setStore((current) =>
      current.activeExerciseId === activeExerciseSummary.id
        ? current
        : {
            ...current,
            activeExerciseId: activeExerciseSummary.id,
          },
    )
  }, [activeExerciseSummary])

  const toggleRevealLine = (lineId: string) => {
    setRevealedLineIds((current) => {
      if (!current[lineId]) {
        return {
          ...current,
          [lineId]: true,
        }
      }

      const next = { ...current }
      delete next[lineId]
      return next
    })
  }

  const toggleLineMastered = (lineId: string) => {
    // 本地活动记录：只在「取消掌握 → 掌握」时计一次，供仪表盘统计。
    const wasMastered =
      store.progressByExercise[String(activeExercise?.id ?? '')]?.lines?.[lineId]?.mastered ?? false
    markLineMastered(lineId)
    if (!wasMastered) {
      setDailyActivity((current) => {
        const next = recordLocalMastery(current, localDayString())
        persistLocalActivity(next)
        return next
      })
    }
  }

  const difficultLines = useMemo(
    () =>
      studyExercise && progress
        ? studyExercise.lines.filter((line) => progress.lines[line.id]?.unclear)
        : [],
    [studyExercise, progress],
  )

  const selectedReviewLine = useMemo(
    () =>
      selectedLine
        ? difficultLines.find((line) => line.id === selectedLine.id) ??
          difficultLines[0] ??
          null
        : difficultLines[0] ?? null,
    [difficultLines, selectedLine],
  )

  const resetSessionUi = () => {
    loopingLineIdRef.current = ''
    stopPlayback()
    setStudyStage('extensive')
    setCompletedStages({})
    setRevealedLineIds({})
  }

  const selectExercise = (exercise: CatalogExerciseSummary) => {
    resetSessionUi()
    setStore((current) => ({
      ...current,
      activeExerciseId: exercise.id,
    }))
    syncRoute(exercise.categoryId, exercise.id, 'extensive')
  }

  const selectSeries = async (seriesId: number) => {
    stopPlayback()

    // 先加载该系列下的课程列表
    const exercises = await loadExercises(seriesId)
    const firstExercise = exercises[0]

    if (firstExercise) {
      resetSessionUi()
      setStore((current) => ({
        ...current,
        activeExerciseId: firstExercise.id,
      }))
      syncRoute(seriesId, firstExercise.id, 'extensive')
    }
  }

  const playExtensivePass = async () => {
    if (!activeExercise) {
      return
    }

    if (currentTime === 0 && activeExercise.lines[0]) {
      selectLine(activeExercise.lines[0].id)
    }

    await toggleMediaPlayback()
  }

  useEffect(() => {
    if (
      !activeExercise ||
      isPlaying ||
      duration <= 0 ||
      currentTime < duration ||
      completedStages.extensive
    ) {
      return
    }

    setCompletedStages((current) => ({ ...current, extensive: true }))
  }, [activeExercise, completedStages.extensive, currentTime, duration, isPlaying])

  const playSingleLine = async (line: TranscriptLine) => {
    if (!activeExercise) {
      return
    }

    stopPlayback()
    selectLine(line.id)
    await runPlayback(async () => {
      await playMediaRange(line.start, line.end)
    })
  }

  // ── 对话锚点 ──────────────────────────────────────────────
  // 锚点已在上方从字幕指令句推导（见 studyExercise 过滤处），这里只派生高亮与跳转。
  const activeAnchorId = useMemo(() => {
    if (dialogueAnchors.length === 0) {
      return null
    }
    // 精听阶段跟随当前选中句；泛听/复习阶段跟随播放进度。
    const referenceTime =
      studyStage === 'intensive' && selectedLine
        ? selectedLine.start
        : currentTime
    return findDialogueAnchorAtTime(dialogueAnchors, referenceTime)?.id ?? null
  }, [currentTime, dialogueAnchors, selectedLine, studyStage])

  const jumpToAnchor = (anchor: DialogueAnchor) => {
    if (!activeExercise || !studyExercise) {
      return
    }

    if (studyStage === 'intensive') {
      // 精听：定位到锚点区间内的第一句正文并按句子范围播放（指令行已被过滤）。
      const targetLine =
        studyExercise.lines.find((line) => line.start >= anchor.start - 0.001) ??
        studyExercise.lines[0]
      if (targetLine) {
        void playSingleLine(targetLine)
      }
      return
    }

    // 泛听：跳到指令句开头并连续播放整段对话。
    seekMedia(anchor.start)
    if (!isPlaying) {
      void playMedia()
    }
  }

  const moveSelectedLineAndPlay = async (offset: number) => {
    if (!activeExercise) {
      return
    }

    const nextLine = activeExercise.lines[selectedLineIndex + offset]
    if (!nextLine) {
      return
    }

    await playSingleLine(nextLine)
  }

  const moveDifficultLineAndPlay = async (offset: number) => {
    if (!selectedReviewLine) {
      return
    }

    const currentIndex = difficultLines.findIndex(
      (line) => line.id === selectedReviewLine.id,
    )
    const nextLine = difficultLines[currentIndex + offset]
    if (!nextLine) {
      return
    }

    await playSingleLine(nextLine)
  }

  useEffect(() => {
    if (
      studyStage !== 'review' ||
      difficultLines.length === 0 ||
      !selectedLine ||
      difficultLines.some((line) => line.id === selectedLine.id)
    ) {
      return
    }

    selectLine(difficultLines[0].id)
  }, [difficultLines, selectLine, selectedLine, studyStage])

  const goToStage = (stage: StudyStage) => {
    loopingLineIdRef.current = ''
    stopPlayback()
    setStudyStage(stage)
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (stage === 'extensive') {
          next.delete('stage')
        } else {
          next.set('stage', stage)
        }
        return next
      },
      { replace: false },
    )
    if (stage === 'intensive' && activeExercise?.lines[0]) {
      selectLine(activeExercise.lines[0].id)
      setRevealedLineIds({})
    }
    if (stage === 'review' && difficultLines[0]) {
      selectLine(difficultLines[0].id)
      setRevealedLineIds({})
    }
  }

  const stageRailItems = (Object.keys(stageCopy) as StudyStage[]).map(
    (stage) => ({
      id: stage,
      ...stageCopy[stage],
      // 文案走 i18n：stageCopy 的中文仅作 t() 缺 key 时的兜底
      title: t(`stage.${stage}.title`),
      metric: t(`stage.${stage}.metric`),
      tool: stage === 'waveform',
    }),
  )
  const activeSeries = useMemo(
    () => catalog.categories.find((category) => category.id === selectedSeriesId),
    [catalog.categories, selectedSeriesId],
  )
  const chapterIndex = useMemo(() => {
    if (!activeExercise) {
      return 0
    }
    const index = seriesExercises.findIndex((exercise) => exercise.id === activeExercise.id)
    return index >= 0 ? index + 1 : 0
  }, [activeExercise, seriesExercises])
  const activeChapterProgress = activeExercise
    ? chapterProgressByExercise[activeExercise.id] ??
      calculateChapterProgress(
        {
          id: activeExercise.id,
          lineCount: activeExercise.lines.length,
        },
        store,
      )
    : undefined

  return (
    <main className="app-shell">
      <TopBar active="study" />

      <section className="workspace">
          <CourseMap
            catalog={catalog}
            selectedSeriesId={selectedSeriesId}
            activeExerciseId={activeExercise?.id ?? ''}
            seriesExercises={seriesExercises}
            chapterProgressByExercise={chapterProgressByExercise}
            seriesProgressByCategory={seriesProgressByCategory}
            onSeriesSelect={selectSeries}
            onExerciseSelect={selectExercise}
          />

          <section className="study-pane" aria-label={t('app.studyArea.aria')}>
            {catalogLoadFailed ? (
              <CatalogErrorState onRetry={() => reloadCatalog()} />
            ) : exerciseLoadFailed ? (
              <ExerciseErrorState />
            ) : exerciseLoading ? (
              <ExerciseLoadingState />
            ) : !hasExercise || !activeExercise || !studyExercise || !progress || !selectedLine ? (
              <EmptyStudyState />
            ) : (
              <>
                <section className="study-chapter-banner" aria-label={t('app.chapterBanner.aria')}>
                  <div className="study-chapter-banner-icon" aria-hidden="true">
                    <BookOpenText size={18} />
                  </div>
                  <div className="study-chapter-banner-copy">
                    <div className="study-chapter-banner-kicker-row">
                      <p className="study-chapter-banner-kicker">{t('app.chapterBanner.kicker')}</p>
                    </div>
                    <strong className="study-chapter-banner-title">
                      {activeExercise.title}
                    </strong>
                  </div>
	                  <div className="study-chapter-banner-metrics">
	                    <span>
	                      {activeSeries?.name ?? t('app.chapterBanner.seriesFallback')}
	                    </span>
	                    <span>
	                      {t('app.chapterBanner.progress', { current: chapterIndex || 1, total: Math.max(seriesExercises.length, 1) })}
	                    </span>
	                  </div>
	                  <div className="study-chapter-progress" aria-hidden="true">
	                    <span style={{ width: `${activeChapterProgress?.percent ?? masteryPercent}%` }} />
	                  </div>
                </section>

                <StageRail
                  activeStage={studyStage}
                  completedStages={completedStages}
                  stages={stageRailItems}
                  onStageSelect={goToStage}
                />

                {studyStage === 'extensive' && (
                  <ExtensiveStage
                    exercise={activeExercise}
                    mediaRef={mediaRef}
                    currentTime={currentTime}
                    duration={duration}
                    isPlaying={isPlaying}
                    dialogueAnchors={dialogueAnchors}
                    activeAnchorId={activeAnchorId}
                    onJumpToAnchor={jumpToAnchor}
                    onSeek={seekMedia}
                    onTogglePlayback={() => void playExtensivePass()}
                    onNextStage={() => goToStage('intensive')}
                  />
                )}

                {studyStage === 'intensive' && (
                  <IntensiveStage
                    exercise={studyExercise}
                    sections={studySections}
                    mediaRef={mediaRef}
                    progress={progress}
                    selectedLine={selectedLine}
                    selectedLineIndex={selectedLineIndex}
                    lineProgress={lineProgress}
                    revealedLineIds={revealedLineIds}
                    isPlaying={isPlaying}
                    dialogueAnchors={dialogueAnchors}
                    activeAnchorId={activeAnchorId}
                    onJumpToAnchor={jumpToAnchor}
                    onPlayLine={(line) => void playSingleLine(line)}
                    onTogglePlayback={toggleMediaPlayback}
                    onMoveLine={(offset) => void moveSelectedLineAndPlay(offset)}
                    onRevealLine={toggleRevealLine}
                    onPlaybackRateChange={(rate) =>
                      updateActiveProgress((current) => ({
                        ...current,
                        playbackRate: rate,
                      }))
                    }
                    onMarkUnclear={markLineUnclear}
                    onMarkMastered={toggleLineMastered}
                    onLineSelect={(lineId) => {
                      const line = activeExercise?.lines.find((l) => l.id === lineId)
                      if (line) void playSingleLine(line)
                    }}
                  />
                )}

                {studyStage === 'waveform' && (
                  <WaveformStage
                    exercise={activeExercise}
                    mediaRef={mediaRef}
                    currentTime={currentTime}
                    duration={duration}
                    isPlaying={isPlaying}
                    dialogueAnchors={dialogueAnchors}
                    activeAnchorId={activeAnchorId}
                    onJumpToAnchor={jumpToAnchor}
                    onPlayFrom={(time) => void playMedia(time)}
                    onTogglePlayback={toggleMediaPlayback}
                  />
                )}

                {studyStage === 'review' && (
                  <DifficultReviewStage
                    exercise={studyExercise}
                    mediaRef={mediaRef}
                    progress={progress}
                    reviewLines={difficultLines}
                    selectedLine={selectedReviewLine}
                    isPlaying={isPlaying}
                    onBackToIntensive={() => goToStage('intensive')}
                    onLineSelect={(lineId) => {
                      const line = difficultLines.find((item) => item.id === lineId)
                      if (line) void playSingleLine(line)
                    }}
                    onMarkMastered={toggleLineMastered}
                    onMarkUnclear={markLineUnclear}
                    onMoveReviewLine={(offset) => {
                      void moveDifficultLineAndPlay(offset)
                    }}
                    onPlayLine={(line) => void playSingleLine(line)}
                    onTogglePlayback={toggleMediaPlayback}
                  />
                )}
              </>
            )}
          </section>
      </section>
    </main>
  )
}

function App() {
  return (
    <>
      {/* 路由外渲染，避免用户从设置或贡献页进入时绕开移动端提示。 */}
      <Routes>
        <Route path="/home" element={<DashboardPage />} />
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="/courses" element={<LearnerAppShell />} />
        <Route path="/courses/:seriesId" element={<LearnerAppShell />} />
        <Route path="/courses/:seriesId/chapters/:exerciseId" element={<LearnerAppShell />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </>
  )
}

export default App
