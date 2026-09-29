import { StageRail } from '../../components/StageRail'
import { useLanguage } from '../../i18n/LanguageProvider'
import { stageCopy, type StudyStage } from '../../lib/studyStages'
import { useStudySession } from './StudySessionContext'
import { useStageNavigation } from './hooks/useStageNavigation'

export function StageRailContainer() {
  const { t } = useLanguage()
  const { completedStages, studyStage } = useStudySession()
  const goToStage = useStageNavigation()

  const stageRailItems = (Object.keys(stageCopy) as StudyStage[]).map(
    (stage) => ({
      id: stage,
      ...stageCopy[stage],
      // 文案走 i18n：stageCopy 的中文仅作 t() 缺 key 时的兜底
      title: t(`stage.${stage}.title`),
      tool: stage === 'waveform',
    }),
  )

  return (
    <StageRail
      activeStage={studyStage}
      completedStages={completedStages}
      stages={stageRailItems}
      onStageSelect={goToStage}
    />
  )
}
