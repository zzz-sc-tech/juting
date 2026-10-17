import {
  CatalogErrorState,
  EmptyStudyState,
  ExerciseErrorState,
  ExerciseLoadingState,
} from '../../components/StudyStates'
import { TopBar } from '../../components/TopBar'
import { useLanguage } from '../../i18n/LanguageProvider'
import { CourseMapContainer } from './CourseMapContainer'
import { ExamContainer } from './containers/ExamContainer'
import { ExtensiveContainer } from './containers/ExtensiveContainer'
import { IntensiveContainer } from './containers/IntensiveContainer'
import { ReviewContainer } from './containers/ReviewContainer'
import { WaveformContainer } from './containers/WaveformContainer'
import { MediaPlaybackProvider } from './MediaPlaybackContext'
import { StageRailContainer } from './StageRailContainer'
import { StudyBanner } from './StudyBanner'
import { StudySessionProvider, useStudySession } from './StudySessionContext'
import { loadUserPrefs } from '../../lib/userPrefs'

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
  const { progress, studyStage } = useStudySession()
  return (
    <MediaPlaybackProvider
      playbackRate={
        // 考试阶段强制原速：课程倍速是练习偏好，真题语速是硬约束
        studyStage === 'exam' ? 1 : progress?.playbackRate ?? loadUserPrefs().defaultPlaybackRate
      }
    >
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

              {/* key 触发换阶段重挂载 → .stage-viewport 入场动画；
                  动画只作用于这层容器，不给舞台内部元素加（拖慢首帧） */}
              <div className="stage-viewport" key={studyStage}>
                {studyStage === 'extensive' && <ExtensiveContainer />}
                {studyStage === 'intensive' && <IntensiveContainer />}
                {studyStage === 'waveform' && <WaveformContainer />}
                {studyStage === 'review' && <ReviewContainer />}
                {studyStage === 'exam' && <ExamContainer />}
              </div>
            </>
          )}
        </section>
      </section>
    </main>
  )
}
