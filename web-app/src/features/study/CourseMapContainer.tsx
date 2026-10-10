import { useCallback } from 'react'
import { extractDialogueAnchors } from '@juting/domain'
import type { CatalogExerciseSummary } from '@juting/shared'
import { apiClient } from '../../lib/apiClient'
import { createExerciseProgress, createLineProgress } from '../../lib/progressStore'
import { CourseMap } from '../../components/CourseMap'
import { useStudySession } from './StudySessionContext'
import { useCourseSelection } from './hooks/useCourseSelection'
import { useLanguage } from '../../i18n/LanguageProvider'

export function CourseMapContainer() {
  const {
    activeExercise,
    catalog,
    chapterProgressByExercise,
    selectedSeriesId,
    seriesExercises,
    seriesProgressByCategory,
    setStore,
  } = useStudySession()
  const { selectExercise, selectSeries } = useCourseSelection()
  const { t } = useLanguage()

  // 章节卡「标为已完成」：拉取课程详情，把全部可见句（过滤指令行）
  // 合并标为 mastered。已存在的其他进度字段（跟读次数/生词等）保留，
  // 指令行孤儿条目也不动——分母侧已按可见句数封顶。
  const handleMarkExerciseDone = useCallback(
    async (exercise: CatalogExerciseSummary) => {
      let detail
      try {
        detail = await apiClient.getExercise(exercise.id)
      } catch {
        window.alert(t('courseMap.markDoneFailed'))
        return
      }
      const instructionIds = new Set(
        extractDialogueAnchors(detail.lines).flatMap((anchor) => anchor.lineIds),
      )
      const contentIds = detail.lines
        .filter((line) => !instructionIds.has(line.id))
        .map((line) => line.id)

      setStore((current) => {
        const existing = current.progressByExercise[exercise.id]
        const lines = { ...(existing?.lines ?? {}) }
        for (const lineId of contentIds) {
          lines[lineId] = { ...(lines[lineId] ?? createLineProgress()), mastered: true }
        }
        return {
          ...current,
          progressByExercise: {
            ...current.progressByExercise,
            [exercise.id]: {
              ...(existing ?? createExerciseProgress(detail)),
              lines,
              updatedAt: new Date().toISOString(),
            },
          },
        }
      })
    },
    [setStore, t],
  )

  // 章节卡「重置进度」：清掉该课全部本地进度记录（含孤儿条目），
  // 课程回到「未开始」；若正打开该课，学习页会按需重建空进度。
  const handleResetExerciseProgress = useCallback(
    (exercise: CatalogExerciseSummary) => {
      setStore((current) => {
        if (!current.progressByExercise[exercise.id]) {
          return current
        }
        const progressByExercise = { ...current.progressByExercise }
        delete progressByExercise[exercise.id]
        return { ...current, progressByExercise }
      })
    },
    [setStore],
  )

  return (
    <CourseMap
      catalog={catalog}
      selectedSeriesId={selectedSeriesId}
      activeExerciseId={activeExercise?.id ?? ''}
      seriesExercises={seriesExercises}
      chapterProgressByExercise={chapterProgressByExercise}
      seriesProgressByCategory={seriesProgressByCategory}
      onSeriesSelect={selectSeries}
      onExerciseSelect={selectExercise}
      onMarkExerciseDone={handleMarkExerciseDone}
      onResetExerciseProgress={handleResetExerciseProgress}
    />
  )
}
