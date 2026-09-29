import { Maximize2, Pause, Play, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import type { Region } from 'wavesurfer.js/dist/plugins/regions.esm.js'
import type { DialogueAnchor, ListeningExercise, TranscriptLine } from '@juting/shared'
import { DialogueAnchorBar } from './DialogueAnchorBar'
import { resolveApiUrl } from '../lib/apiClient'
import { useLanguage } from '../i18n/LanguageProvider'

/**
 * 波形自由听：把整段音频画成波形，用户拖动/点击波形即可从该位置播放，
 * 并用区域标记标出每一句的范围 —— 播放时当前句高亮，点区域可直接跳到该句。
 *
 * 关键约束：波形必须挂在 App 共享的那一个 <audio> 元素上（通过 mediaRef），
 * 否则播放状态、进度与其余阶段会分裂成两套。
 */
type WaveformStageProps = {
  exercise: ListeningExercise
  mediaRef: RefObject<HTMLMediaElement | null>
  currentTime: number
  duration: number
  isPlaying: boolean
  dialogueAnchors: DialogueAnchor[]
  activeAnchorId: string | null
  onJumpToAnchor: (anchor: DialogueAnchor) => void
  /** 从指定时间开始播放（拖到哪就从哪播）。 */
  onPlayFrom: (time: number) => void
  onTogglePlayback: () => void
}

type WaveStatus =
  | { kind: 'loading'; percent: number }
  | { kind: 'ready'; duration: number }
  | { kind: 'error'; message: string }

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '00:00'
  }
  const total = Math.floor(seconds)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** 找出某一时刻所在的句子（含首尾，避免相邻句之间出现“没有字幕”的空窗）。 */
const findLineAtTime = (lines: readonly TranscriptLine[], time: number): TranscriptLine | null => {
  if (!lines.length || !Number.isFinite(time)) {
    return null
  }
  for (const line of lines) {
    if (time >= line.start && time < line.end) {
      return line
    }
  }
  // 落在句间空隙时取最近的前一句，感觉更自然
  let candidate: TranscriptLine | null = null
  for (const line of lines) {
    if (line.start <= time) {
      candidate = line
    }
  }
  return candidate ?? lines[0] ?? null
}

// canvas 画不进 CSS 变量：统一从 :root 读令牌实值；主题切换随页面重挂生效
function readWavePalette() {
  const rootStyle = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) =>
    rootStyle.getPropertyValue(name).trim() || fallback
  return {
    cursor: token('--ink', '#1d1b16'),
    progress: token('--accent', '#24584a'),
    region: token('--wave-region', 'rgba(36, 88, 74, 0.10)'),
    regionActive: token('--wave-region-active', 'rgba(36, 88, 74, 0.32)'),
    wave: token('--ink-4', '#c6c1b4'),
  }
}

export function WaveformStage({
  exercise,
  mediaRef,
  currentTime,
  duration,
  isPlaying,
  dialogueAnchors,
  activeAnchorId,
  onJumpToAnchor,
  onPlayFrom,
  onTogglePlayback,
}: WaveformStageProps) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<RegionsPlugin | null>(null)
  const regionByLineIdRef = useRef<Record<string, Region>>({})
  const activeLineIdRef = useRef<string>('')
  // 拖动结束前不要被 React 的重渲染打断：用 ref 读取最新播放状态，避免 effect 反复重建
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying
  const [status, setStatus] = useState<WaveStatus>({ kind: 'loading', percent: 0 })
  const [zoomPx, setZoomPx] = useState(0) // 0 = 适应宽度
  const [reloadKey, setReloadKey] = useState(0)
  // 视图平移滑动条：max = 可滚动宽度，pos = 当前滚动位置；max 为 0（未放大）时隐藏。
  // 注意：v7 缩放后实际滚动发生在 shadow DOM 内部的 scrollContainer 上，
  // 外层 .waveform-surface 的 scrollWidth 量不出缩放宽度。
  const [pan, setPan] = useState({ max: 0, pos: 0 })
  const scrollElRef = useRef<HTMLElement | null>(null)
  const updatePan = useCallback(() => {
    const el = scrollElRef.current ?? surfaceRef.current
    if (!el) return
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    setPan({ max, pos: Math.min(el.scrollLeft, max) })
  }, [])

  // 回调走「最新引用」：App 传入的函数每次渲染都是新引用，
  // 若直接进依赖，wavesurfer 会在每次渲染时被销毁重建（波形一闪就没）。
  const onPlayFromRef = useRef(onPlayFrom)
  onPlayFromRef.current = onPlayFrom

  const sourceUrl = useMemo(() => resolveApiUrl(exercise.audioUrl), [exercise.audioUrl])
  const currentLine = useMemo(
    () => findLineAtTime(exercise.lines, currentTime),
    [exercise.lines, currentTime],
  )

  // 句子区间：一次性建立，之后只在时间推进时改高亮，避免每帧重建 200 个区域
  useEffect(() => {
    const container = containerRef.current
    const media = mediaRef.current
    if (!container || !media) {
      return
    }

    let disposed = false
    setStatus({ kind: 'loading', percent: 0 })

    const palette = readWavePalette()

    const regions = RegionsPlugin.create()
    const wavesurfer = WaveSurfer.create({
      autoCenter: false,
      autoScroll: false,
      barGap: 1,
      barMinHeight: 1,
      barRadius: 2,
      barWidth: 2,
      container,
      cursorColor: palette.cursor,
      cursorWidth: 2,
      // 拖动时由 wavesurfer 自己 seek，配合下面的 interaction 处理实现「拖到哪就从哪播」
      dragToSeek: true,
      fillParent: true,
      height: Math.max(1, container.clientHeight || 120),
      hideScrollbar: false,
      interact: true,
      normalize: true,
      plugins: [regions],
      progressColor: palette.progress,
      // 与校波台一致：8k 采样率足够画波形，兼容性也更好（部分设备不支持 4k）
      sampleRate: 8000,
      media,
      waveColor: palette.wave,
    })

    wsRef.current = wavesurfer
    const scrollEl: HTMLElement | null =
      (wavesurfer as unknown as { renderer?: { scrollContainer?: HTMLElement } }).renderer?.scrollContainer ?? null
    scrollElRef.current = scrollEl
    if (scrollEl) scrollEl.addEventListener('scroll', updatePan)
    updatePan()
    regionsRef.current = regions
    regionByLineIdRef.current = {}
    activeLineIdRef.current = ''

    const onLoading = (percent: number) => {
      if (!disposed) setStatus({ kind: 'loading', percent })
    }
    const onReady = (readyDuration: number) => {
      if (disposed) return
      setStatus({ kind: 'ready', duration: readyDuration })
      // 解码完成后句子区间才有时基意义
      const map: Record<string, Region> = {}
      for (const line of exercise.lines) {
        const end = Math.min(line.end, readyDuration || line.end)
        if (!(end > line.start)) continue
        map[line.id] = regions.addRegion({
          start: line.start,
          end,
          color: palette.region,
          drag: false,
          resize: false,
        })
      }
      regionByLineIdRef.current = map
      // 重建区域后补一次当前句着色（activeLineIdRef 在主 effect 清空后仍可能指向当前句）
      const activeId = activeLineIdRef.current
      if (activeId && map[activeId]) {
        map[activeId].setOptions({ color: palette.regionActive })
      }
    }
    const onError = (error: Error) => {
      if (!disposed) setStatus({ kind: 'error', message: error.message || 'unknown error' })
    }
    // 点击/拖动波形：没在播就从该处起播；在播则由 dragToSeek 负责跟随
    const onInteraction = (newTime: number) => {
      if (disposed || !Number.isFinite(newTime)) return
      if (!isPlayingRef.current) {
        onPlayFromRef.current(newTime)
      }
    }
    const onRegionClick = (region: Region) => {
      if (disposed) return
      const line = exercise.lines.find((item) => item.id === region.id)
      const target = Number.isFinite(region.start) ? region.start : line?.start
      if (target !== undefined) {
        onPlayFromRef.current(target)
      }
    }

    wavesurfer.on('loading', onLoading)
    wavesurfer.on('ready', onReady)
    wavesurfer.on('error', onError)
    wavesurfer.on('interaction', onInteraction)
    regions.on('region-clicked', onRegionClick)

    return () => {
      disposed = true
      wavesurfer.un('loading', onLoading)
      wavesurfer.un('ready', onReady)
      wavesurfer.un('error', onError)
      wavesurfer.un('interaction', onInteraction)
      regions.un('region-clicked', onRegionClick)
      if (scrollEl) scrollEl.removeEventListener('scroll', updatePan)
      scrollElRef.current = null
      regionByLineIdRef.current = {}
      wavesurfer.destroy()
      wsRef.current = null
      regionsRef.current = null
    }
    // 换课程/换音源时重建；播放状态用 ref 读取，不进依赖
  }, [exercise.id, sourceUrl, reloadKey, exercise.lines, mediaRef, updatePan])

  // 当前句高亮：只改受影响的两个区域，不做全量重绘
  useEffect(() => {
    const nextId = currentLine?.id ?? ''
    if (nextId === activeLineIdRef.current) {
      return
    }
    const palette = readWavePalette()
    const map = regionByLineIdRef.current
    const previous = activeLineIdRef.current
    if (previous && map[previous]) {
      map[previous].setOptions({ color: palette.region })
    }
    if (nextId && map[nextId]) {
      map[nextId].setOptions({ color: palette.regionActive })
    }
    activeLineIdRef.current = nextId
  }, [currentLine?.id])

  // 缩放：0 表示适应宽度（交给 fillParent），否则按像素/秒
  // 缩放：双 API 兜底——不同 v7 小版本里 setOptions 与 zoom 的重渲染行为不一致，
  // 两个都调；zoom 还会内部 reRender，保证至少一条路径生效。
  const applyZoom = useCallback((next: number) => {
    setZoomPx(next)
    const wavesurfer = wsRef.current
    if (!wavesurfer) return
    if (next <= 0) {
      wavesurfer.setOptions({ fillParent: true, minPxPerSec: 1 })
    } else {
      wavesurfer.setOptions({ fillParent: false, minPxPerSec: next })
      try {
        wavesurfer.zoom(next)
      } catch {
        // 音频尚未解码完成时 zoom 会抛错——此时保留 setOptions 的结果即可
      }
    }
    // 渲染是异步的：等一帧再同步滑动条量程
    window.requestAnimationFrame(updatePan)
  }, [updatePan])

  const zoomIn = useCallback(() => {
    const container = containerRef.current
    const base = zoomPx > 0
      ? zoomPx
      : Math.max(2, (container?.clientWidth ?? 800) / Math.max(1, duration || 1))
    applyZoom(Math.min(400, Math.round(base * 1.6)))
  }, [applyZoom, duration, zoomPx])

  const zoomOut = useCallback(() => {
    const container = containerRef.current
    const base = zoomPx > 0
      ? zoomPx
      : Math.max(2, (container?.clientWidth ?? 800) / Math.max(1, duration || 1))
    const next = Math.round(base / 1.6)
    applyZoom(next < 2 ? 0 : next)
  }, [applyZoom, duration, zoomPx])

  const fit = useCallback(() => applyZoom(0), [applyZoom])

  const retry = useCallback(() => setReloadKey((value) => value + 1), [])

  // 缩放/解码会改变波形容器宽度，同步滑动条量程
  useEffect(() => {
    const surface = surfaceRef.current
    const canvas = containerRef.current
    if (!surface || !canvas || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(updatePan)
    observer.observe(surface)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [updatePan, status.kind])

  return (
    <section className="stage-board waveform-board">
      <DialogueAnchorBar
        anchors={dialogueAnchors}
        activeAnchorId={activeAnchorId}
        onJump={onJumpToAnchor}
      />

      <div className="waveform-card">
        <header className="waveform-header">
          <div>
            <p className="waveform-meta">
              {t('waveform.sentenceCount', { count: exercise.lines.length })}
            </p>
          </div>
          <div className="waveform-tools">
            <button
              aria-label={t('waveform.zoomOut')}
              className="icon-button"
              onClick={zoomOut}
              type="button"
            >
              <ZoomOut size={18} aria-hidden="true" />
            </button>
            <button
              aria-label={t('waveform.zoomIn')}
              className="icon-button"
              onClick={zoomIn}
              type="button"
            >
              <ZoomIn size={18} aria-hidden="true" />
            </button>
            <button
              aria-label={t('waveform.fit')}
              className="icon-button"
              onClick={fit}
              type="button"
            >
              <Maximize2 size={18} aria-hidden="true" />
            </button>
            <button
              className="icon-button primary wide"
              onClick={onTogglePlayback}
              type="button"
            >
              {isPlaying ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
              <span>{isPlaying ? t('waveform.pause') : t('waveform.play')}</span>
            </button>
            <span className="media-time-label">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
        </header>

        <div className="waveform-surface" ref={surfaceRef} onScroll={updatePan}>
          {/* 与其余阶段共用同一个媒体元素，保证播放状态一致 */}
          <audio ref={mediaRef as RefObject<HTMLAudioElement | null>} src={sourceUrl} preload="auto" />
          <div className="waveform-canvas" ref={containerRef} />

          {status.kind === 'loading' && (
            <div className="waveform-overlay" role="status">
              <span className="waveform-spinner" aria-hidden="true" />
              <span>{t('waveform.loading')}</span>
              {status.percent > 0 && <span className="waveform-percent">{Math.round(status.percent)}%</span>}
            </div>
          )}
          {status.kind === 'error' && (
            <div className="waveform-overlay error" role="alert">
              <span>{t('waveform.error')}</span>
              <button className="command-button" onClick={retry} type="button">
                {t('waveform.retry')}
              </button>
            </div>
          )}
        </div>

        {pan.max > 0 && (
          <input
            aria-label={t('waveform.viewSlider')}
            className="waveform-pan"
            max={pan.max}
            min={0}
            onChange={(event) => {
              const el = scrollElRef.current ?? surfaceRef.current
              if (el) el.scrollLeft = Number(event.target.value)
            }}
            type="range"
            value={Math.min(pan.pos, pan.max)}
          />
        )}

        <footer className="waveform-subtitle">
          <span className="waveform-subtitle-label">{t('waveform.currentSentence')}</span>
          <p className="waveform-subtitle-text">
            {currentLine?.text?.trim() ? currentLine.text : t('waveform.noSentence')}
          </p>
        </footer>
      </div>
    </section>
  )
}
