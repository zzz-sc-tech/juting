import { useCallback, useEffect, useRef } from 'react'
import { WaveformStage } from '../../../components/WaveformStage'
import {
  useMediaControls,
  useMediaPlaying,
  useMediaTime,
} from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'
import { useActiveAnchorId, useJumpToAnchor } from '../hooks/useAnchorNavigation'
import { useStageNavigation } from '../hooks/useStageNavigation'
import { loadUserPrefs, RATE_OPTIONS } from '../../../lib/userPrefs'

const SKIP_SECONDS = 15

// 波形自由听容器：工具阶段。倍速循环 / ±15s 键盘步进 / 本句送进精听。
export function WaveformContainer() {
  const {
    activeExercise,
    dialogueAnchors,
    progress,
    selectLine,
    studyExercise,
    updateActiveProgress,
  } = useStudySession()
  const { currentTime, duration } = useMediaTime()
  const { isPlaying } = useMediaPlaying()
  const { mediaRef, playMedia, playMediaRange, seekMedia, toggleMediaPlayback } = useMediaControls()
  const activeAnchorId = useActiveAnchorId(currentTime)
  const jumpToAnchor = useJumpToAnchor()
  const goToStage = useStageNavigation()

  // 倍速：与精听/泛听同一套课程倍速存储，未手动调速的课程跟随全局默认
  const effectiveRate = progress?.playbackRate ?? loadUserPrefs().defaultPlaybackRate
  const cycleRate = useCallback(() => {
    updateActiveProgress((current) => {
      const active = current.playbackRate ?? loadUserPrefs().defaultPlaybackRate
      const index = RATE_OPTIONS.indexOf(active as (typeof RATE_OPTIONS)[number])
      const next = RATE_OPTIONS[(index + 1) % RATE_OPTIONS.length]
      return { ...current, playbackRate: next }
    })
  }, [updateActiveProgress])

  // ±15s 键盘步进：焦点在输入框上时让位原生行为（平移滑动条是 range input）
  const skipRef = useRef<(delta: number) => void>(() => {})
  const skip = useCallback(
    (delta: number) => {
      seekMedia(Math.max(0, Math.min(currentTime + delta, duration || currentTime + delta)))
    },
    [currentTime, duration, seekMedia],
  )
  skipRef.current = skip
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return
      }
      event.preventDefault()
      skipRef.current(event.key === 'ArrowLeft' ? -SKIP_SECONDS : SKIP_SECONDS)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 本句送进精听：跳阶段 → 选中句（题干/指令行不在学习池时保持默认选中）→ 延迟一拍起播
  const goIntensive = useCallback(
    (line: { id: string; start: number; end: number }) => {
      goToStage('intensive')
      if (studyExercise?.lines.some((item) => item.id === line.id)) {
        selectLine(line.id)
      }
      window.setTimeout(() => {
        void playMediaRange(line.start, line.end)
      }, 300)
    },
    [goToStage, playMediaRange, selectLine, studyExercise],
  )

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
      playbackRate={effectiveRate}
      onCycleRate={cycleRate}
      onGoIntensive={goIntensive}
    />
  )
}
