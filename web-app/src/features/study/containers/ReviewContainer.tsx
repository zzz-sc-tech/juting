import { useCallback, useEffect } from 'react'
import { DifficultReviewStage } from '../../../components/DifficultReviewStage'
import {
  useMediaControls,
  useMediaPlaying,
} from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'
import { useStageNavigation } from '../hooks/useStageNavigation'

// 难点复习容器：难句列表在难句集合内移动（独立句表，不走锚点分组）。
export function ReviewContainer() {
  const {
    difficultLines,
    markLineUnclear,
    progress,
    selectedLine,
    selectedReviewLine,
    selectLine,
    studyExercise,
    studyStage,
    toggleLineMastered,
  } = useStudySession()
  const { isPlaying } = useMediaPlaying()
  const { mediaRef, playSingleLine, toggleMediaPlayback } = useMediaControls()
  const goToStage = useStageNavigation()

  // 复习阶段选中行不在难句列表时，重置为第一句难句
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

  const moveDifficultLineAndPlay = useCallback(
    async (offset: number) => {
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
    },
    [difficultLines, playSingleLine, selectedReviewLine],
  )

  if (!studyExercise || !progress) {
    return null
  }

  return (
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
  )
}
