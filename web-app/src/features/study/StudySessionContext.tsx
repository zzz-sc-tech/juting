import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  extractDialogueAnchors,
  type CatalogExerciseSummary,
  type CatalogResponse,
  type DialogueAnchor,
  type ExerciseProgress,
  type LineProgress,
  type ListeningExercise,
  type StudyStore,
  type TranscriptLine,
} from '@juting/shared'
import { useCatalog } from '../../hooks/useCatalog'
import { useCategoryExercises } from '../../hooks/useCategoryExercises'
import { useExerciseDetail } from '../../hooks/useExerciseDetail'
import { useStudyProgress } from '../../hooks/useStudyProgress'
import { useLanguage } from '../../i18n/LanguageProvider'
import {
  calculateChapterProgress,
  calculateSeriesProgress,
  loadLocalActivity,
  loadStoredStudyStore,
  localDayString,
  persistLocalActivity,
  persistStudyStore,
  recordLocalMastery,
  type ChapterProgressSummary,
  type SeriesProgressSummary,
} from '../../lib/progressStore'
import { buildStudySections, type StudySection } from '../../lib/studySections'
import type { StudyStage } from '../../lib/studyStages'
import { useCourseRouting } from './hooks/useCourseRouting'

export type StudySessionContextValue = {
  // 目录
  catalog: CatalogResponse
  catalogLoadFailed: boolean
  reloadCatalog: () => void
  loadExercises: (categoryId: number) => Promise<CatalogExerciseSummary[]>
  seriesProgressByCategory: Record<string, SeriesProgressSummary>
  chapterProgressByExercise: Record<string, ChapterProgressSummary>
  // 路由派生
  studyStage: StudyStage
  setStudyStage: React.Dispatch<React.SetStateAction<StudyStage>>
  setStageParam: (stage: StudyStage) => void
  syncRoute: (
    seriesId: number,
    exerciseId: number,
    stage?: StudyStage,
    options?: { replace?: boolean },
  ) => void
  selectedSeriesId: number
  seriesExercises: CatalogExerciseSummary[]
  activeExerciseSummary: CatalogExerciseSummary | undefined
  hasExercise: boolean
  // 课程详情
  activeExercise: ListeningExercise | undefined
  exerciseLoading: boolean
  exerciseLoadFailed: boolean
  // 内容派生（锚点 → 正文 → 分节，见 lib/studySections 注释）
  dialogueAnchors: DialogueAnchor[]
  studyExercise: ListeningExercise | undefined
  studySections: StudySection[]
  // 学习进度
  store: StudyStore
  setActiveExerciseId: (exerciseId: number) => void
  progress: ExerciseProgress | undefined
  selectedLine: TranscriptLine | undefined
  selectedLineIndex: number
  lineProgress: LineProgress
  masteryPercent: number
  selectLine: (lineId: string) => void
  markLineUnclear: (lineId: string) => void
  toggleLineMastered: (lineId: string) => void
  updateActiveProgress: (
    updater: (progress: ExerciseProgress) => ExerciseProgress,
  ) => void
  // 难句复习
  difficultLines: TranscriptLine[]
  selectedReviewLine: TranscriptLine | null
  // 会话级 UI 状态（换课/换阶段时重置）
  completedStages: Partial<Record<StudyStage, boolean>>
  setStageCompleted: (stage: StudyStage, done: boolean) => void
  revealedLineIds: Record<string, true>
  toggleRevealLine: (lineId: string) => void
  resetRevealedLines: () => void
  resetSessionUi: () => void
}

const StudySessionContext = createContext<StudySessionContextValue | null>(null)

export function StudySessionProvider({ children }: { children: ReactNode }) {
  const { contentLocale, t } = useLanguage()
  // 本地免登录模式：进度与每日掌握计数都持久化在 localStorage，刷新/重启不丢。
  const [store, setStore] = useState(loadStoredStudyStore)
  const [completedStages, setCompletedStages] = useState<
    Partial<Record<StudyStage, boolean>>
  >({})
  const [revealedLineIds, setRevealedLineIds] = useState<Record<string, true>>(
    {},
  )

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
  const { exercisesByCategory, loadExercises } =
    useCategoryExercises(contentLocale)
  const {
    studyStage,
    setStudyStage,
    setStageParam,
    syncRoute,
    selectedSeriesId,
    seriesExercises,
    activeExerciseSummary,
    hasExercise,
  } = useCourseRouting({ catalog, exercisesByCategory, loadExercises })

  const seriesProgressByCategory = useMemo<Record<string, SeriesProgressSummary>>(() => {
    return Object.fromEntries(
      catalog.categories.map((category) => [
        category.id,
        calculateSeriesProgress(exercisesByCategory[category.id] ?? [], store),
      ]),
    )
  }, [catalog.categories, exercisesByCategory, store])
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

  const { activeExercise, exerciseLoading, exerciseLoadFailed } =
    useExerciseDetail({
      activeExerciseSummary,
      setStore,
      contentLocale,
    })

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

  const toggleRevealLine = useCallback((lineId: string) => {
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
  }, [])

  const setActiveExerciseId = useCallback((exerciseId: number) => {
    setStore((current) => ({
      ...current,
      activeExerciseId: exerciseId,
    }))
  }, [])

  const toggleLineMastered = useCallback(
    (lineId: string) => {
      // 本地活动记录：只在「取消掌握 → 掌握」时计一次，供仪表盘统计。
      const wasMastered =
        store.progressByExercise[String(activeExercise?.id ?? '')]?.lines?.[lineId]?.mastered ?? false
      markLineMastered(lineId)
      if (!wasMastered) {
        persistLocalActivity(recordLocalMastery(loadLocalActivity(), localDayString()))
      }
    },
    [activeExercise?.id, markLineMastered, store.progressByExercise],
  )

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

  const setStageCompleted = useCallback((stage: StudyStage, done: boolean) => {
    setCompletedStages((current) => ({ ...current, [stage]: done }))
  }, [])

  const resetRevealedLines = useCallback(() => setRevealedLineIds({}), [])

  const resetSessionUi = useCallback(() => {
    setStudyStage('extensive')
    setCompletedStages({})
    setRevealedLineIds({})
  }, [setStudyStage])

  const value = useMemo<StudySessionContextValue>(
    () => ({
      catalog,
      catalogLoadFailed,
      reloadCatalog,
      loadExercises,
      seriesProgressByCategory,
      chapterProgressByExercise,
      studyStage,
      setStudyStage,
      setStageParam,
      syncRoute,
      selectedSeriesId,
      seriesExercises,
      activeExerciseSummary,
      hasExercise,
      activeExercise,
      exerciseLoading,
      exerciseLoadFailed,
      dialogueAnchors,
      studyExercise,
      studySections,
      store,
      setActiveExerciseId,
      progress,
      selectedLine,
      selectedLineIndex,
      lineProgress,
      masteryPercent,
      selectLine,
      markLineUnclear,
      toggleLineMastered,
      updateActiveProgress,
      difficultLines,
      selectedReviewLine,
      completedStages,
      setStageCompleted,
      revealedLineIds,
      toggleRevealLine,
      resetRevealedLines,
      resetSessionUi,
    }),
    [
      catalog,
      catalogLoadFailed,
      reloadCatalog,
      loadExercises,
      seriesProgressByCategory,
      chapterProgressByExercise,
      studyStage,
      setStudyStage,
      setStageParam,
      syncRoute,
      selectedSeriesId,
      seriesExercises,
      activeExerciseSummary,
      hasExercise,
      activeExercise,
      exerciseLoading,
      exerciseLoadFailed,
      dialogueAnchors,
      studyExercise,
      studySections,
      store,
      setActiveExerciseId,
      progress,
      selectedLine,
      selectedLineIndex,
      lineProgress,
      masteryPercent,
      selectLine,
      markLineUnclear,
      toggleLineMastered,
      updateActiveProgress,
      difficultLines,
      selectedReviewLine,
      completedStages,
      setStageCompleted,
      revealedLineIds,
      toggleRevealLine,
      resetRevealedLines,
      resetSessionUi,
    ],
  )

  return (
    <StudySessionContext.Provider value={value}>
      {children}
    </StudySessionContext.Provider>
  )
}

export function useStudySession() {
  const context = useContext(StudySessionContext)
  if (!context) {
    throw new Error('useStudySession must be used inside StudySessionProvider')
  }
  return context
}
