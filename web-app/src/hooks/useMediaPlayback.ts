import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

type UseMediaPlaybackOptions = {
  mediaRef: RefObject<HTMLMediaElement | null>
  playbackRate: number
}

export function useMediaPlayback({
  mediaRef,
  playbackRate,
}: UseMediaPlaybackOptions) {
  const [isPlaying, setIsPlaying] = useState(false)
  const isPlayingRef = useRef(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  // 速率最新值：轮询接线新挂载的媒体元素时要立即应用
  const playbackRateRef = useRef(playbackRate)
  playbackRateRef.current = playbackRate
  const stopPlaybackRef = useRef(false)
  const playbackTokenRef = useRef(0)
  const rangeCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // 舞台组件挂载媒体元素发生在本 effect 之后（ref 绑定不触发重渲），
    // 若只按渲染时的 mediaRef.current 快照接线，直进某舞台时监听器会漏挂
    // （currentTime/isPlaying 永不更新）。这里低频轮询 ref 变化自动补接线。
    let attached: HTMLMediaElement | null = null
    let detach: (() => void) | null = null

    const attach = () => {
      const media = mediaRef.current
      if (!media || media === attached) {
        return
      }
      detach?.()
      attached = media

      const syncPlaybackState = () => {
        const playing = !media.paused && !media.ended
        isPlayingRef.current = playing
        setIsPlaying(playing)
        setCurrentTime(Number.isFinite(media.currentTime) ? media.currentTime : 0)
        setDuration(Number.isFinite(media.duration) ? media.duration : 0)
      }

      syncPlaybackState()
      // 元素后挂载时把当前速率立即放上去（applyPlaybackRate 的 effect 只在
      // 速率变化时重跑，首挂载那一刻它早已跑过、当时 ref 还是空的）
      media.playbackRate = playbackRateRef.current
      media.addEventListener('play', syncPlaybackState)
      media.addEventListener('pause', syncPlaybackState)
      media.addEventListener('ended', syncPlaybackState)
      media.addEventListener('timeupdate', syncPlaybackState)
      media.addEventListener('loadedmetadata', syncPlaybackState)
      media.addEventListener('durationchange', syncPlaybackState)
      detach = () => {
        media.removeEventListener('play', syncPlaybackState)
        media.removeEventListener('pause', syncPlaybackState)
        media.removeEventListener('ended', syncPlaybackState)
        media.removeEventListener('timeupdate', syncPlaybackState)
        media.removeEventListener('loadedmetadata', syncPlaybackState)
        media.removeEventListener('durationchange', syncPlaybackState)
      }
    }

    attach()
    const timer = window.setInterval(attach, 250)
    return () => {
      window.clearInterval(timer)
      detach?.()
    }
  }, [mediaRef])

  useEffect(
    () => () => {
      rangeCleanupRef.current?.()
    },
    [],
  )

  const applyPlaybackRate = useCallback(() => {
    if (mediaRef.current) {
      mediaRef.current.playbackRate = playbackRate
    }
  }, [mediaRef, playbackRate])

  const seekMediaTo = useCallback((media: HTMLMediaElement, targetTime: number) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        globalThis.clearTimeout(timeoutId)
        media.removeEventListener('seeked', finish)
        media.removeEventListener('canplay', finish)
        resolve()
      }

      const timeoutId = globalThis.setTimeout(finish, 800)
      media.addEventListener('seeked', finish, { once: true })
      media.addEventListener('canplay', finish, { once: true })
      media.currentTime = targetTime

      if (!media.seeking && Math.abs(media.currentTime - targetTime) < 0.025) {
        finish()
      }
    }), [])

  const stopPlayback = useCallback(() => {
    playbackTokenRef.current += 1
    rangeCleanupRef.current?.()
    rangeCleanupRef.current = null
    stopPlaybackRef.current = true
    isPlayingRef.current = false
    if (mediaRef.current) {
      mediaRef.current.pause()
    }
    window.speechSynthesis?.cancel()
    setIsPlaying(false)
  }, [mediaRef])

  const playMediaRange = useCallback((start: number, end?: number) =>
    new Promise<void>((resolve) => {
      const runPlaybackRange = async () => {
        const media = mediaRef.current
        if (!media) {
          globalThis.setTimeout(resolve, 500)
          return
        }

        const playbackToken = playbackTokenRef.current + 1
        playbackTokenRef.current = playbackToken
        rangeCleanupRef.current?.()
        rangeCleanupRef.current = null

        const safeStart = Math.max(0, start)
        const safeEnd = end === undefined ? undefined : Math.max(safeStart, end)
        media.pause()
        await seekMediaTo(media, safeStart)
        if (playbackTokenRef.current !== playbackToken) {
          resolve()
          return
        }

        let finished = false
        let frameId = 0
        let timeoutId = 0

        const cleanup = () => {
          window.cancelAnimationFrame(frameId)
          window.clearTimeout(timeoutId)
          media.removeEventListener('pause', finish)
          media.removeEventListener('ended', finish)
          media.removeEventListener('error', finish)
        }
        const finish = () => {
          if (finished) {
            return
          }
          finished = true
          playbackTokenRef.current += 1
          cleanup()
          rangeCleanupRef.current = null
          resolve()
        }

        const stopAtEnd = () => {
          if (safeEnd === undefined) {
            return
          }

          if (media.currentTime >= safeEnd) {
            media.pause()
            if (Math.abs(media.currentTime - safeEnd) <= 0.12) {
              media.currentTime = safeEnd
            }
            finish()
            return
          }

          frameId = window.requestAnimationFrame(stopAtEnd)
        }

        rangeCleanupRef.current = cleanup
        media.playbackRate = playbackRate
        media.addEventListener('pause', finish)
        media.addEventListener('ended', finish)
        media.addEventListener('error', finish)

        if (safeEnd !== undefined) {
          // 字幕时间是媒体时间轴上的秒数；真实等待时间要除以播放速度。
          // rAF 负责贴近结束点停止，timeout 是后台标签页或低频回调时的兜底。
          const effectivePlaybackRate =
            Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1
          const remainingMilliseconds = Math.max(
            0,
            Math.round(((safeEnd - safeStart) / effectivePlaybackRate) * 1000),
          )
          timeoutId = window.setTimeout(() => {
            if (media.currentTime < safeEnd) {
              media.currentTime = safeEnd
            }
            media.pause()
            finish()
          }, remainingMilliseconds)
          frameId = window.requestAnimationFrame(stopAtEnd)
        }

        void media.play().catch(finish)
      }

      void runPlaybackRange()
    }), [mediaRef, playbackRate, seekMediaTo])

  const playMedia = useCallback(async (startAt?: number) => {
    const media = mediaRef.current
    if (!media) {
      return false
    }

    if (typeof startAt === 'number') {
      await seekMediaTo(media, startAt)
    } else if (media.ended || (media.duration > 0 && media.currentTime >= media.duration)) {
      await seekMediaTo(media, 0)
    }

    stopPlaybackRef.current = false
    applyPlaybackRate()
    try {
      await media.play()
      return true
    } catch {
      setIsPlaying(false)
      return false
    }
  }, [applyPlaybackRate, mediaRef, seekMediaTo])

  const pauseMedia = useCallback(() => {
    mediaRef.current?.pause()
  }, [mediaRef])

  const toggleMediaPlayback = useCallback(async (options?: { restartAt?: number }) => {
    const media = mediaRef.current
    if (!media) {
      return
    }

    if (!media.paused && !media.ended) {
      pauseMedia()
      return
    }

    await playMedia(options?.restartAt)
  }, [mediaRef, pauseMedia, playMedia])

  const seekMedia = useCallback((time: number) => {
    const media = mediaRef.current
    if (!media) {
      return
    }

    media.currentTime = Math.max(0, Math.min(time, media.duration || time))
    setCurrentTime(media.currentTime)
  }, [mediaRef])

  const runPlayback = useCallback(async (task: () => Promise<void>) => {
    if (isPlayingRef.current) {
      return false
    }

    stopPlaybackRef.current = false
    isPlayingRef.current = true
    window.speechSynthesis?.cancel()
    setIsPlaying(true)
    await task()
    // 只有没有被外部 stopPlayback 打断，才重置播放状态
    // （避免竞态：外部 stopPlayback 后新播放已开始，此处错误地把状态清零）
    if (!stopPlaybackRef.current) {
      isPlayingRef.current = false
      setIsPlaying(false)
    }
    return !stopPlaybackRef.current
  }, [])

  return {
    currentTime,
    duration,
    isPlaying,
    pauseMedia,
    playMediaRange,
    playMedia,
    runPlayback,
    seekMedia,
    stopPlayback,
    toggleMediaPlayback,
  }
}
