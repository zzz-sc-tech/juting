import { useCallback } from 'react'
import type { StudyStage } from '../../../lib/studyStages'
import { useMediaControls } from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'

// 阶段切换：停播放 → 更新状态与 URL → 精听/复习阶段顺带重置选中句与揭晓态。
export function useStageNavigation() {
  const {
    difficultLines,
    resetRevealedLines,
    selectLine,
    setStageParam,
    setStudyStage,
    studyExercise,
  } = useStudySession()
  const { stopPlayback } = useMediaControls()

  return useCallback(
    (stage: StudyStage) => {
      stopPlayback()
      setStudyStage(stage)
      setStageParam(stage)
      if (stage === 'intensive' && studyExercise?.lines[0]) {
        selectLine(studyExercise.lines[0].id)
        resetRevealedLines()
      }
      if (stage === 'review' && difficultLines[0]) {
        selectLine(difficultLines[0].id)
        resetRevealedLines()
      }
    },
    [
      difficultLines,
      resetRevealedLines,
      selectLine,
      setStageParam,
      setStudyStage,
      stopPlayback,
      studyExercise,
    ],
  )
}
