import { useCallback } from 'react'
import { IntensiveStage } from '../../../components/IntensiveStage'
import {
  useMediaControls,
  useMediaPlaying,
} from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'
import { useActiveAnchorId, useJumpToAnchor } from '../hooks/useAnchorNavigation'

// 精听容器：正文中「上一句/下一句」移动必须用 studyExercise.lines 寻址——
// selectedLineIndex 是正文序号；历史上误用全量 lines（含指令行）曾导致
// 「下一句」越走越靠前（见 useStudyProgress 与交接文档 §3.2）。
export function IntensiveContainer() {
  const {
    activeExercise,
    dialogueAnchors,
    lineProgress,
    markLineUnclear,
    progress,
    revealedLineIds,
    selectedLine,
    selectedLineIndex,
    studyExercise,
    studySections,
    toggleLineMastered,
    toggleRevealLine,
    updateActiveProgress,
  } = useStudySession()
  const { isPlaying } = useMediaPlaying()
  const { mediaRef, playSingleLine, toggleMediaPlayback } = useMediaControls()
  const activeAnchorId = useActiveAnchorId(selectedLine?.start ?? 0)
  const jumpToAnchor = useJumpToAnchor()

  const moveSelectedLineAndPlay = useCallback(
    async (offset: number) => {
      if (!activeExercise || !studyExercise) {
        return
      }

      const nextLine = studyExercise.lines[selectedLineIndex + offset]
      if (!nextLine) {
        return
      }

      await playSingleLine(nextLine)
    },
    [activeExercise, playSingleLine, selectedLineIndex, studyExercise],
  )

  if (!activeExercise || !studyExercise || !progress || !selectedLine) {
    return null
  }

  return (
    <IntensiveStage
      exercise={studyExercise}
      sections={studySections}
      mediaRef={mediaRef}
      progress={progress}
      selectedLine={selectedLine}
      selectedLineIndex={selectedLineIndex}
      lineProgress={lineProgress}
      revealedLineIds={revealedLineIds}
      isPlaying={isPlaying}
      dialogueAnchors={dialogueAnchors}
      activeAnchorId={activeAnchorId}
      onJumpToAnchor={jumpToAnchor}
      onPlayLine={(line) => void playSingleLine(line)}
      onTogglePlayback={toggleMediaPlayback}
      onMoveLine={(offset) => void moveSelectedLineAndPlay(offset)}
      onRevealLine={toggleRevealLine}
      onPlaybackRateChange={(rate) =>
        updateActiveProgress((current) => ({
          ...current,
          playbackRate: rate,
        }))
      }
      onMarkUnclear={markLineUnclear}
      onMarkMastered={toggleLineMastered}
      onLineSelect={(lineId) => {
        const line = activeExercise.lines.find((item) => item.id === lineId)
        if (line) void playSingleLine(line)
      }}
    />
  )
}
