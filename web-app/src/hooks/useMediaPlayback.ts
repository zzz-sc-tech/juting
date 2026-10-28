import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { accumulateListenTime, flushListenTime } from '../lib/listenTime'
import { validResumePosition, worthSaving } from '../lib/playbackResume'

type UseMediaPlaybackOptions = {
  mediaRef: RefObject<HTMLMediaElement | null>
  playbackRate: number
  /** 断点续听的课程键（seriesId/exerciseId）；undefined = 不保存不恢复（如实战）。 */
  courseKey?: string
  /** 位置落库回调（sec=null 表示清除，ended 后调用）；节流由本 hook 负责。 */
  onSavePosition?: (sec: number | null) => void
  /** 该课程上次保存的位置秒数（courseKey 变化时尝试恢复）。 */
  savedPositionSec?: number
}

export function useMediaPlayback({
  mediaRef,
  playbackRate,
  courseKey,
  onSavePosition,
  savedPositionSec,
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

  // ---- 断点续听 ----
  // 保存：播放中每 10s 节流写一次；pause 事件即时写（换课/换舞台前的最后一刻）；
  // ended 清除。恢复：courseKey 变化时收下 savedPositionSec，媒体元数据就绪后
  // 且还没被别处 seek 过，才静默 seek 过去（暂停态，是否播放由用户决定）。
  const courseKeyRef = useRef(courseKey)
  courseKeyRef.current = courseKey
  const savePositionRef = useRef(onSavePosition)
  savePositionRef.current = onSavePosition
  const lastTimeRef = useRef(0)
  const pendingResumeRef = useRef<number | null>(null)
  const restoredKeyRef = useRef<string | undefined>(undefined)

  const persistPosition = useCallback(
    (sec: number | null) => {
      const key = courseKeyRef.current
      if (!key || !savePositionRef.current) {
        return
      }
      savePositionRef.current(sec)
    },
    [],
  )

  const tryPersistCurrent = useCallback(() => {
    const media = mediaRef.current
    if (!media) {
      return
    }
    const time = media.currentTime
    lastTimeRef.current = time
    if (worthSaving(time, Number.isFinite(media.duration) ? media.duration : 0)) {
      persistPosition(time)
    }
  }, [mediaRef, persistPosition])

  useEffect(() => {
    if (restoredKeyRef.current === courseKey) {
      return
    }
    restoredKeyRef.current = courseKey
    pendingResumeRef.current =
      courseKey && savedPositionSec ? validResumePosition(savedPositionSec, 0) : null
    // 竞态兜底：音频已缓存时 loadedmetadata 可能早于本 effect 触发（attach 时的
    // applyPendingResume 还没拿到意图）——元数据已就绪就立即补一次
    const media = mediaRef.current
    if (pendingResumeRef.current != null && media && media.readyState >= 1) {
      const target = pendingResumeRef.current
      if (media.currentTime <= 0.5) {
        const dur = Number.isFinite(media.duration) ? media.duration : 0
        const valid = validResumePosition(target, dur)
        pendingResumeRef.current = null
        if (valid != null) {
          media.currentTime = valid
          setCurrentTime(valid)
        }
      } else {
        pendingResumeRef.current = null
      }
    }
  }, [courseKey, savedPositionSec])

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

      // 断点恢复：元数据就绪且尚未被别处 seek 过（currentTime 仍在起点）才应用
      const applyPendingResume = () => {
        const target = pendingResumeRef.current
        if (target == null || media.currentTime > 0.5) {
          return
        }
        const dur = Number.isFinite(media.duration) ? media.duration : 0
        const valid = validResumePosition(target, dur)
        pendingResumeRef.current = null
        if (valid != null) {
          media.currentTime = valid
          setCurrentTime(valid)
        }
      }

      const onPauseSync = () => {
        syncPlaybackState()
        tryPersistCurrent()
      }
      const onEndedSync = () => {
        syncPlaybackState()
        persistPosition(null)
      }
      const onMetadataSync = () => {
        syncPlaybackState()
        applyPendingResume()
      }

      syncPlaybackState()
      // 元素后挂载时把当前速率立即放上去（applyPlaybackRate 的 effect 只在
      // 速率变化时重跑，首挂载那一刻它早已跑过、当时 ref 还是空的）
      media.playbackRate = playbackRateRef.current
      // 断点恢复兜底：pending 还挂着且元数据已就绪（loadedmetadata 可能已在
      // StrictMode 双挂载的清理窗口里错过）→ 每次挂载/轮询 attach 时补应用
      if (pendingResumeRef.current != null && media.readyState >= 1) {
        const target = pendingResumeRef.current
        if (media.currentTime <= 0.5) {
          const dur = Number.isFinite(media.duration) ? media.duration : 0
          const valid = validResumePosition(target, dur)
          if (valid != null) {
            media.currentTime = valid
            setCurrentTime(valid)
          }
          pendingResumeRef.current = null
        } else {
          pendingResumeRef.current = null
        }
      }
      media.addEventListener('play', syncPlaybackState)
      media.addEventListener('pause', onPauseSync)
      media.addEventListener('ended', onEndedSync)
      media.addEventListener('timeupdate', syncPlaybackState)
      media.addEventListener('loadedmetadata', onMetadataSync)
      media.addEventListener('durationchange', onMetadataSync)
      detach = () => {
        media.removeEventListener('play', syncPlaybackState)
        media.removeEventListener('pause', onPauseSync)
        media.removeEventListener('ended', onEndedSync)
        media.removeEventListener('timeupdate', syncPlaybackState)
        media.removeEventListener('loadedmetadata', onMetadataSync)
        media.removeEventListener('durationchange', onMetadataSync)
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

  // 断点续听：播放中每 10s 落一次位置；页面隐藏/卸载时补一次
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (isPlayingRef.current && !document.hidden) {
        tryPersistCurrent()
      }
    }, 10_000)
    const flushOnHide = () => {
      if (isPlayingRef.current) {
        tryPersistCurrent()
      }
    }
    window.addEventListener('pagehide', flushOnHide)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pagehide', flushOnHide)
      if (isPlayingRef.current) {
        tryPersistCurrent()
      }
    }
  }, [tryPersistCurrent])

  // ---- 所听时长累计（任务：首页「所听时长」统计）----
  // 在本 hook 的播放状态上按墙钟时间累计（不乘倍速），复用这一层而不是另起采集体系。
  // 细节：
  // - 只在 isPlayingRef === true 时累加（音频加载中/暂停/ended 都不计）
  // - document.hidden 时停止累加（切走标签页不算听），且跳过与上一次 tick 间隔
  //   过大的补账（浏览器后台节流会把 interval 拉长到分钟级，回来一次性补一大段会虚高）
  // - 落盘交给 listenTime 模块节流（15 秒一次），这里只在暂停/卸载时强制 flush
  useEffect(() => {
    let lastTickAt = Date.now()
    const timer = window.setInterval(() => {
      const now = Date.now()
      const delta = now - lastTickAt
      lastTickAt = now
      if (document.hidden || delta > 5000) {
        return
      }
      if (isPlayingRef.current) {
        accumulateListenTime(delta)
      }
    }, 1000)

    const flushOnHide = () => {
      if (document.hidden) {
        flushListenTime()
      }
    }
    window.addEventListener('pagehide', flushListenTime)
    document.addEventListener('visibilitychange', flushOnHide)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pagehide', flushListenTime)
      document.removeEventListener('visibilitychange', flushOnHide)
      flushListenTime()
    }
  }, [])

  const applyPlaybackRate = useCallback(() => {
    if (mediaRef.current) {
      mediaRef.current.playbackRate = playbackRate
    }
  }, [mediaRef, playbackRate])

  // 速率变化即时生效（暂停中也生效）——否则要等下一次起播才应用，
  // chip 显示与实际速率会短暂不一致
  useEffect(() => {
    applyPlaybackRate()
  }, [applyPlaybackRate])

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
