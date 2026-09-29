import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react'
import type { TranscriptLine } from '@juting/shared'
import { useMediaPlayback } from '../../hooks/useMediaPlayback'
import { useStudySession } from './StudySessionContext'

// 三个 Context 按更新频率拆分：
// - time：currentTime/duration，播放时约 4Hz 更新，只有泛听/波形需要
// - playing：isPlaying，只在播放/暂停切换时变化，精听/复习只需要它
// - controls：稳定回调 + mediaRef，几乎不变
// 这样 4Hz 的 timeupdate 不再驱动课程地图/精听卡/句列表整树重渲染。

type MediaTimeContextValue = {
  currentTime: number
  duration: number
}

type MediaPlayingContextValue = {
  isPlaying: boolean
}

type MediaControlsContextValue = {
  mediaRef: RefObject<HTMLMediaElement | null>
  pauseMedia: () => void
  playMedia: (startAt?: number) => Promise<boolean>
  playMediaRange: (start: number, end?: number) => Promise<void>
  playSingleLine: (line: TranscriptLine) => Promise<void>
  runPlayback: (task: () => Promise<void>) => Promise<boolean>
  seekMedia: (time: number) => void
  stopPlayback: () => void
  toggleMediaPlayback: (options?: { restartAt?: number }) => Promise<void>
}

const MediaTimeContext = createContext<MediaTimeContextValue | null>(null)
const MediaPlayingContext = createContext<MediaPlayingContextValue | null>(null)
const MediaControlsContext = createContext<MediaControlsContextValue | null>(null)

export function MediaPlaybackProvider({
  playbackRate,
  children,
}: {
  playbackRate: number
  children: ReactNode
}) {
  // mediaRef 与四个舞台组件共享：哪个阶段挂载，哪个就把自己的 audio/video
  // 元素绑到同一个 ref 上（同一时间只有一个舞台渲染媒体元素）。
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const { activeExercise, selectLine } = useStudySession()
  const {
    currentTime,
    duration,
    isPlaying,
    pauseMedia,
    playMedia,
    playMediaRange,
    runPlayback,
    seekMedia,
    stopPlayback,
    toggleMediaPlayback,
  } = useMediaPlayback({ mediaRef, playbackRate })

  const playSingleLine = useCallback(
    async (line: TranscriptLine) => {
      if (!activeExercise) {
        return
      }

      stopPlayback()
      selectLine(line.id)
      await runPlayback(async () => {
        await playMediaRange(line.start, line.end)
      })
    },
    [activeExercise, playMediaRange, runPlayback, selectLine, stopPlayback],
  )

  const timeValue = useMemo<MediaTimeContextValue>(
    () => ({ currentTime, duration }),
    [currentTime, duration],
  )
  const playingValue = useMemo<MediaPlayingContextValue>(
    () => ({ isPlaying }),
    [isPlaying],
  )
  const controlsValue = useMemo<MediaControlsContextValue>(
    () => ({
      mediaRef,
      pauseMedia,
      playMedia,
      playMediaRange,
      playSingleLine,
      runPlayback,
      seekMedia,
      stopPlayback,
      toggleMediaPlayback,
    }),
    [
      pauseMedia,
      playMedia,
      playMediaRange,
      playSingleLine,
      runPlayback,
      seekMedia,
      stopPlayback,
      toggleMediaPlayback,
    ],
  )

  return (
    <MediaControlsContext.Provider value={controlsValue}>
      <MediaTimeContext.Provider value={timeValue}>
        <MediaPlayingContext.Provider value={playingValue}>
          {children}
        </MediaPlayingContext.Provider>
      </MediaTimeContext.Provider>
    </MediaControlsContext.Provider>
  )
}

export function useMediaTime() {
  const context = useContext(MediaTimeContext)
  if (!context) {
    throw new Error('useMediaTime must be used inside MediaPlaybackProvider')
  }
  return context
}

export function useMediaPlaying() {
  const context = useContext(MediaPlayingContext)
  if (!context) {
    throw new Error('useMediaPlaying must be used inside MediaPlaybackProvider')
  }
  return context
}

export function useMediaControls() {
  const context = useContext(MediaControlsContext)
  if (!context) {
    throw new Error('useMediaControls must be used inside MediaPlaybackProvider')
  }
  return context
}
