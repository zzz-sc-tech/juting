import { useCallback, useEffect, useRef, useState } from 'react'
import { IntensiveStage } from '../../../components/IntensiveStage'
import {
  useMediaControls,
  useMediaPlaying,
  useMediaTime,
} from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'
import { useActiveAnchorId, useJumpToAnchor } from '../hooks/useAnchorNavigation'
import { useStageNavigation } from '../hooks/useStageNavigation'
import { setPendingWaveLoop } from '../../../lib/waveHandoff'
import { loadUserPrefs, persistUserPrefs } from '../../../lib/userPrefs'

// 精听容器：正文中「上一句/下一句」移动必须用 studyExercise.lines 寻址——
// selectedLineIndex 是正文序号；历史上误用全量 lines（含指令行）曾导致
// 「下一句」越走越靠前（见 useStudyProgress 与交接文档 §3.2）。
export function IntensiveContainer() {
  const {
    activeExercise,
    countLineRepeat,
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
  const { currentTime } = useMediaTime()
  const { isPlaying } = useMediaPlaying()
  const { mediaRef, playSingleLine, toggleMediaPlayback } = useMediaControls()
  const activeAnchorId = useActiveAnchorId(selectedLine?.start ?? 0)
  const jumpToAnchor = useJumpToAnchor()
  const goToStage = useStageNavigation()

  // 连播：本机偏好持久，开关在句卡顶栏
  const [autoAdvance, setAutoAdvance] = useState(() => loadUserPrefs().intensiveAutoAdvance)
  const toggleAutoAdvance = useCallback(() => {
    setAutoAdvance((current) => {
      const next = !current
      const prefs = loadUserPrefs()
      persistUserPrefs({ ...prefs, intensiveAutoAdvance: next })
      return next
    })
  }, [])

  // 起播统一入口：每次播一句计一遍「已听」
  const playLine = useCallback(
    async (line: NonNullable<typeof selectedLine>) => {
      if (!line) return
      countLineRepeat(line.id)
      await playSingleLine(line)
    },
    [countLineRepeat, playSingleLine],
  )

  const moveSelectedLineAndPlay = useCallback(
    async (offset: number) => {
      if (!activeExercise || !studyExercise || !selectedLine) {
        return
      }

      const nextLine = studyExercise.lines[selectedLineIndex + offset]
      if (!nextLine) {
        return
      }

      await playLine(nextLine)
    },
    [activeExercise, playLine, selectedLine, selectedLineIndex, studyExercise],
  )

  // 连播检测：播放由真转假且进度贴近本句句尾 = 自然播完 → 进下一句。
  // 手动暂停（句中）不会命中贴近句尾判据，不触发。
  const prevPlayingRef = useRef(isPlaying)
  const autoAdvanceRef = useRef(autoAdvance)
  autoAdvanceRef.current = autoAdvance
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime
  const advanceRef = useRef<() => void>(() => {})
  advanceRef.current = () => {
    void moveSelectedLineAndPlay(1)
  }
  useEffect(() => {
    if (prevPlayingRef.current && !isPlaying) {
      const line = selectedLine
      if (
        autoAdvanceRef.current &&
        line &&
        Math.abs(currentTimeRef.current - line.end) < 0.25 &&
        selectedLineIndex < (studyExercise?.lines.length ?? 0) - 1
      ) {
        advanceRef.current()
      }
    }
    prevPlayingRef.current = isPlaying
  }, [isPlaying, selectedLine, selectedLineIndex, studyExercise?.lines.length])

  // 本句送波形 A-B：跨阶段 handoff，波形就绪后直接进入循环态
  const goWaveLoop = useCallback(
    (line: { start: number; end: number }) => {
      if (!activeExercise) return
      setPendingWaveLoop({ exerciseId: activeExercise.id, start: line.start, end: line.end })
      goToStage('waveform')
    },
    [activeExercise, goToStage],
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
      onPlayLine={(line) => void playLine(line)}
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
        if (line) void playLine(line)
      }}
      autoAdvance={autoAdvance}
      onToggleAutoAdvance={toggleAutoAdvance}
      onGoWaveLoop={goWaveLoop}
      onAddVocabulary={(words) => {
        if (!selectedLine) return
        updateActiveProgress((current) => {
          const vocabulary = { ...current.vocabulary }
          for (const word of words) {
            vocabulary[word] = selectedLine.text
          }
          return { ...current, vocabulary }
        })
      }}
    />
  )
}
