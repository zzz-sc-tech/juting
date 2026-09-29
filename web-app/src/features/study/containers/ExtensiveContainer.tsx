import { useCallback, useEffect } from 'react'
import { ExtensiveStage } from '../../../components/ExtensiveStage'
import {
  useMediaControls,
  useMediaPlaying,
  useMediaTime,
} from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'
import { useActiveAnchorId, useJumpToAnchor } from '../hooks/useAnchorNavigation'
import { useStageNavigation } from '../hooks/useStageNavigation'

// 泛听容器：整段播放 + 播完自动标记完成，其余全部直通共享上下文。
export function ExtensiveContainer() {
  const {
    activeExercise,
    completedStages,
    dialogueAnchors,
    selectLine,
    setStageCompleted,
  } = useStudySession()
  const { currentTime, duration } = useMediaTime()
  const { isPlaying } = useMediaPlaying()
  const { mediaRef, seekMedia, toggleMediaPlayback } = useMediaControls()
  const activeAnchorId = useActiveAnchorId(currentTime)
  const jumpToAnchor = useJumpToAnchor()
  const goToStage = useStageNavigation()

  const playExtensivePass = useCallback(async () => {
    if (!activeExercise) {
      return
    }

    if (currentTime === 0 && activeExercise.lines[0]) {
      selectLine(activeExercise.lines[0].id)
    }

    await toggleMediaPlayback()
  }, [activeExercise, currentTime, selectLine, toggleMediaPlayback])

  useEffect(() => {
    if (
      !activeExercise ||
      isPlaying ||
      duration <= 0 ||
      currentTime < duration ||
      completedStages.extensive
    ) {
      return
    }

    setStageCompleted('extensive', true)
  }, [
    activeExercise,
    completedStages.extensive,
    currentTime,
    duration,
    isPlaying,
    setStageCompleted,
  ])

  if (!activeExercise) {
    return null
  }

  return (
    <ExtensiveStage
      exercise={activeExercise}
      mediaRef={mediaRef}
      currentTime={currentTime}
      duration={duration}
      isPlaying={isPlaying}
      dialogueAnchors={dialogueAnchors}
      activeAnchorId={activeAnchorId}
      onJumpToAnchor={jumpToAnchor}
      onSeek={seekMedia}
      onTogglePlayback={() => void playExtensivePass()}
      onNextStage={() => goToStage('intensive')}
    />
  )
}
