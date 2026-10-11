import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ExtensiveStage } from '../../../components/ExtensiveStage'
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

// 泛听容器：整段播放 + 播完自动标记完成（并累加泛听遍数），其余直通共享上下文。
// 歌词行标难点直接复用精听的 markLineUnclear（切换语义），难点池两边同源。
export function ExtensiveContainer() {
  const {
    activeExercise,
    completedStages,
    dialogueAnchors,
    markLineUnclear,
    progress,
    selectLine,
    setStageCompleted,
    updateActiveProgress,
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

  // 播完 = 标记本阶段完成 + 泛听遍数 +1（每次会话完整听完记一遍）
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
    updateActiveProgress((current) => ({
      ...current,
      extensivePasses: (current.extensivePasses ?? 0) + 1,
    }))
  }, [
    activeExercise,
    completedStages.extensive,
    currentTime,
    duration,
    isPlaying,
    setStageCompleted,
    updateActiveProgress,
  ])

  // 倍速：未手动调速的课程跟随设置里的全局默认，循环按钮沿精听同一套档位/存储
  const effectiveRate = progress?.playbackRate ?? loadUserPrefs().defaultPlaybackRate
  const cycleRate = useCallback(() => {
    updateActiveProgress((current) => {
      const active = current.playbackRate ?? loadUserPrefs().defaultPlaybackRate
      const index = RATE_OPTIONS.indexOf(active as (typeof RATE_OPTIONS)[number])
      const next = RATE_OPTIONS[(index + 1) % RATE_OPTIONS.length]
      return { ...current, playbackRate: next }
    })
  }, [updateActiveProgress])

  // ±15s 步进：键盘 ←/→ 同义（焦点在输入框上时让位给原生行为，避免进度条双重响应）
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

  const unclearLineIds = useMemo(() => {
    const ids = new Set<string>()
    for (const [lineId, line] of Object.entries(progress?.lines ?? {})) {
      if (line && typeof line === 'object' && (line as { unclear?: boolean }).unclear) {
        ids.add(lineId)
      }
    }
    return ids
  }, [progress?.lines])

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
      onToggleUnclear={markLineUnclear}
      unclearLineIds={unclearLineIds}
      playbackRate={effectiveRate}
      onCycleRate={cycleRate}
      onSkip={skip}
      extensivePasses={progress?.extensivePasses ?? 0}
      onGoExam={
        activeExercise.questions && activeExercise.questions.length > 0
          ? () => goToStage('exam')
          : undefined
      }
    />
  )
}
