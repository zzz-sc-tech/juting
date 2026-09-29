import { CourseMap } from '../../components/CourseMap'
import { useStudySession } from './StudySessionContext'
import { useCourseSelection } from './hooks/useCourseSelection'

export function CourseMapContainer() {
  const {
    activeExercise,
    catalog,
    chapterProgressByExercise,
    selectedSeriesId,
    seriesExercises,
    seriesProgressByCategory,
  } = useStudySession()
  const { selectExercise, selectSeries } = useCourseSelection()

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
    />
  )
}
