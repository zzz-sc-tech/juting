import { useCallback } from 'react'
import type { CatalogExerciseSummary } from '@juting/shared'
import { useMediaControls } from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'

// 换课/换系列：停播放、重置会话 UI、写回 activeExerciseId、跳路由到泛听。
export function useCourseSelection() {
  const {
    loadExercises,
    resetSessionUi,
    setActiveExerciseId,
    syncRoute,
  } = useStudySession()
  const { stopPlayback } = useMediaControls()

  const selectExercise = useCallback(
    (exercise: CatalogExerciseSummary) => {
      stopPlayback()
      resetSessionUi()
      setActiveExerciseId(exercise.id)
      syncRoute(exercise.categoryId, exercise.id, 'extensive')
    },
    [resetSessionUi, setActiveExerciseId, stopPlayback, syncRoute],
  )

  const selectSeries = useCallback(
    async (seriesId: number) => {
      stopPlayback()

      // 先加载该系列下的课程列表
      const exercises = await loadExercises(seriesId)
      const firstExercise = exercises[0]

      if (firstExercise) {
        resetSessionUi()
        setActiveExerciseId(firstExercise.id)
        syncRoute(seriesId, firstExercise.id, 'extensive')
      }
    },
    [loadExercises, resetSessionUi, setActiveExerciseId, stopPlayback, syncRoute],
  )

  return { selectExercise, selectSeries }
}
