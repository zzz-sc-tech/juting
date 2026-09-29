import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type {
  CatalogExerciseSummary,
  CatalogResponse,
} from '@juting/shared'
import type { StudyStage } from '../../../lib/studyStages'

type UseCourseRoutingOptions = {
  catalog: CatalogResponse
  exercisesByCategory: Record<string, CatalogExerciseSummary[]>
  loadExercises: (categoryId: number) => Promise<CatalogExerciseSummary[]>
}

// URL（/courses/:seriesId/chapters/:exerciseId?stage=）是学习页的唯一路由真相：
// 这里集中做参数解析、系列/课程回落、stage 读写与路由合法性校验。
export function useCourseRouting({
  catalog,
  exercisesByCategory,
  loadExercises,
}: UseCourseRoutingOptions) {
  const navigate = useNavigate()
  const { seriesId: routeSeriesId, exerciseId: routeExerciseId } = useParams<{
    seriesId?: string
    exerciseId?: string
  }>()
  const parsedRouteSeriesId = routeSeriesId ? Number(routeSeriesId) : undefined
  const parsedRouteExerciseId = routeExerciseId ? Number(routeExerciseId) : undefined
  const [searchParams, setSearchParams] = useSearchParams()
  const [studyStage, setStudyStage] = useState<StudyStage>('extensive')

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

  // 只改 stage 查询参数（goToStage 用），课程路径不动
  const setStageParam = useCallback((stage: StudyStage) => {
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
  }, [setSearchParams])

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

  return {
    studyStage,
    setStudyStage,
    setStageParam,
    syncRoute,
    selectedSeriesId,
    seriesExercises,
    activeExerciseSummary,
    hasExercise,
  }
}
