import {
  CatalogErrorState,
  EmptyStudyState,
  ExerciseErrorState,
  ExerciseLoadingState,
} from '../../components/StudyStates'
import { TopBar } from '../../components/TopBar'
import { useLanguage } from '../../i18n/LanguageProvider'
import { ExtensiveContainer } from './containers/ExtensiveContainer'
import { IntensiveContainer } from './containers/IntensiveContainer'
import { ReviewContainer } from './containers/ReviewContainer'
import { WaveformContainer } from './containers/WaveformContainer'
import { CourseMapContainer } from './CourseMapContainer'
import { MediaPlaybackProvider } from './MediaPlaybackContext'
import { StageRailContainer } from './StageRailContainer'
import { StudyBanner } from './StudyBanner'
import { StudySessionProvider, useStudySession } from './StudySessionContext'

// 学习页（/courses…）编排：数据在 StudySessionContext，播放在 MediaPlaybackContext
// （4Hz currentTime 被隔离在泛听/波形子树），舞台逻辑在 containers/。
export function StudyPage() {
  return (
    <StudySessionProvider>
      <StudyPlaybackScope />
    </StudySessionProvider>
  )
}

function StudyPlaybackScope() {
  const { progress } = useStudySession()
  return (
    <MediaPlaybackProvider playbackRate={progress?.playbackRate ?? 1}>
      <StudyLayout />
    </MediaPlaybackProvider>
  )
}

function StudyLayout() {
  const { t } = useLanguage()
  const {
    activeExercise,
    catalogLoadFailed,
    exerciseLoadFailed,
    exerciseLoading,
    hasExercise,
    progress,
    reloadCatalog,
    selectedLine,
    studyExercise,
    studyStage,
  } = useStudySession()

  return (
    <main className="app-shell">
      <TopBar active="study" />

      <section className="workspace">
        <CourseMapContainer />

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
              <StudyBanner />

              <StageRailContainer />

              {studyStage === 'extensive' && <ExtensiveContainer />}
              {studyStage === 'intensive' && <IntensiveContainer />}
              {studyStage === 'waveform' && <WaveformContainer />}
              {studyStage === 'review' && <ReviewContainer />}
            </>
          )}
        </section>
      </section>
    </main>
  )
}
