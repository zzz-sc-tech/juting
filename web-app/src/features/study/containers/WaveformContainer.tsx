import { WaveformStage } from '../../../components/WaveformStage'
import {
  useMediaControls,
  useMediaPlaying,
  useMediaTime,
} from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'
import { useActiveAnchorId, useJumpToAnchor } from '../hooks/useAnchorNavigation'

// 波形自由听：工具阶段，无专属会话逻辑，纯透传。
export function WaveformContainer() {
  const { activeExercise, dialogueAnchors } = useStudySession()
  const { currentTime, duration } = useMediaTime()
  const { isPlaying } = useMediaPlaying()
  const { mediaRef, playMedia, toggleMediaPlayback } = useMediaControls()
  const activeAnchorId = useActiveAnchorId(currentTime)
  const jumpToAnchor = useJumpToAnchor()

  if (!activeExercise) {
    return null
  }

  return (
    <WaveformStage
      exercise={activeExercise}
      mediaRef={mediaRef}
      currentTime={currentTime}
      duration={duration}
      isPlaying={isPlaying}
      dialogueAnchors={dialogueAnchors}
      activeAnchorId={activeAnchorId}
      onJumpToAnchor={jumpToAnchor}
      onPlayFrom={(time) => void playMedia(time)}
      onTogglePlayback={toggleMediaPlayback}
    />
  )
}
