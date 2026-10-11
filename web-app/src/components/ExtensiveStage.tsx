import { ChevronRight, FastForward, Flag, Pause, Play, Rewind } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { ContentLocale, DialogueAnchor, ListeningExercise } from '@juting/shared'
import { DialogueAnchorBar } from './DialogueAnchorBar'
import { resolveApiUrl } from '../lib/apiClient'
import { resolveLineTranslation } from '../lib/lineTranslation'
import { loadUserPrefs } from '../lib/userPrefs'
import { useLanguage } from '../i18n/LanguageProvider'

type ExtensiveStageProps = {
  exercise: ListeningExercise
  mediaRef: RefObject<HTMLMediaElement | null>
  currentTime: number
  duration: number
  isPlaying: boolean
  dialogueAnchors: DialogueAnchor[]
  activeAnchorId: string | null
  onJumpToAnchor: (anchor: DialogueAnchor) => void
  onSeek: (time: number) => void
  onTogglePlayback: () => void
  onNextStage: () => void
  /** 歌词行即时标难点（切换）：泛听中遇到没听懂的句子随手插旗，不打断播放 */
  onToggleUnclear: (lineId: string) => void
  unclearLineIds: ReadonlySet<string>
  /** 倍速循环切换与 ±15s 步进（容器接 MediaPlaybackContext / 课程进度） */
  playbackRate: number
  onCycleRate: () => void
  onSkip: (delta: number) => void
  /** 泛听遍数（持久）；onGoExam 存在时右栏多一个「考一遍」入口 */
  extensivePasses: number
  onGoExam?: () => void
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00'
  }

  const totalSeconds = Math.floor(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

export function ExtensiveStage({
  exercise,
  mediaRef,
  currentTime,
  duration,
  isPlaying,
  dialogueAnchors,
  activeAnchorId,
  onJumpToAnchor,
  onSeek,
  onTogglePlayback,
  onNextStage,
  onToggleUnclear,
  unclearLineIds,
  playbackRate,
  onCycleRate,
  onSkip,
  extensivePasses,
  onGoExam,
}: ExtensiveStageProps) {
  const { t, contentLocale } = useLanguage()
  const progressPercent =
    duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0

  // 实时字幕：按播放进度取"最后一句已开始的台词"（含指令句——泛听听的就是全篇）；
  // 句间空档沿用上一句，避免字幕闪烁消失。
  // 初始显示状态走「设置 → 播放与字幕」的本机偏好
  const [captionsOn, setCaptionsOn] = useState(() => loadUserPrefs().lyricsDefault)
  const [translationOn, setTranslationOn] = useState(() => loadUserPrefs().translationDefault)
  const activeLine = useMemo(() => {
    let current: ListeningExercise['lines'][number] | null = null
    for (const line of exercise.lines) {
      if (line.start <= currentTime + 0.05) {
        current = line
      } else {
        break
      }
    }
    return current
  }, [exercise.lines, currentTime])

  // 歌词式滚动字幕：当前句居中高亮，上下文句淡显可点（点击跳播到那句）。
  // 首帧定位用瞬时滚动，之后跟句用平滑滚动。
  const lyricsRef = useRef<HTMLDivElement | null>(null)
  const scrolledOnceRef = useRef(false)
  // 只在「激活句切换」时重定位：依赖句 id 而非句对象，避免 4Hz 播放时钟整拍重跑
  const activeLineId = activeLine?.id
  useEffect(() => {
    const container = lyricsRef.current
    if (!container || activeLineId == null) {
      return
    }
    const active = container.querySelector<HTMLElement>('[data-active="true"]')
    if (!active) {
      return
    }
    container.scrollTo({
      top: active.offsetTop - container.clientHeight / 2 + active.clientHeight / 2,
      behavior: scrolledOnceRef.current ? 'smooth' : 'auto',
    })
    scrolledOnceRef.current = true
    // captionsOn 关→开时容器重新挂载，需要重跑定位
  }, [activeLineId, captionsOn])

  return (
    <section className="stage-board extensive-board">
      <DialogueAnchorBar
        anchors={dialogueAnchors}
        activeAnchorId={activeAnchorId}
        onJump={onJumpToAnchor}
      />
      <div className="listen-visual">
        {exercise.mediaType === 'video' ? (
            <video
              ref={mediaRef as RefObject<HTMLVideoElement | null>}
              className="lesson-media lesson-video"
              src={resolveApiUrl(exercise.audioUrl)}
              playsInline
              preload="metadata"
            />
          ) : (
            <>
              <audio
                ref={mediaRef as RefObject<HTMLAudioElement | null>}
                src={resolveApiUrl(exercise.audioUrl)}
                preload="metadata"
              />
              {/* 歌词式滚动字幕填满波形区：当前句高亮居中，任意句可点跳播，
                  悬停可插难点旗（不打断播放）。列表抽成 memo 子组件——
                  currentTime 4Hz 变化只重渲染进度条，不对 200+ 歌词行做 VDOM diff。 */}
              {captionsOn ? (
                <ExtensiveLyrics
                  activeId={activeLine?.id ?? ''}
                  contentLocale={contentLocale}
                  lines={exercise.lines}
                  lyricsRef={lyricsRef}
                  onSeek={onSeek}
                  onToggleUnclear={onToggleUnclear}
                  translationsOn={translationOn}
                  unclearLineIds={unclearLineIds}
                />
              ) : (
                <div aria-hidden="true" className="listen-visual-waves" />
              )}
            </>
          )}
          {/* 浮动控制栏：播放/步进/倍速 + 字幕译文开关 + 进度条 */}
          <div className="listen-visual-controls">
            <button className="media-play-btn" onClick={onTogglePlayback} type="button">
              {isPlaying ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
              <span>{isPlaying ? t('extensive.pause') : t('extensive.play')}</span>
            </button>
            <button
              aria-label={t('extensive.back15')}
              className="media-skip-btn"
              onClick={() => onSkip(-15)}
              type="button"
            >
              <Rewind size={15} aria-hidden="true" />
              <span className="skip-label">15</span>
            </button>
            <button
              aria-label={t('extensive.forward15')}
              className="media-skip-btn"
              onClick={() => onSkip(15)}
              type="button"
            >
              <FastForward size={15} aria-hidden="true" />
              <span className="skip-label">15</span>
            </button>
            <button
              aria-label={t('extensive.rate')}
              className="rate-chip"
              onClick={onCycleRate}
              title={t('extensive.rate')}
              type="button"
            >
              {playbackRate}x
            </button>
            <button
              className={captionsOn ? 'subtitle-chip on' : 'subtitle-chip'}
              onClick={() => setCaptionsOn((current) => !current)}
              type="button"
              aria-pressed={captionsOn}
            >
              {t('extensive.captions')}
            </button>
            <button
              className={translationOn ? 'subtitle-chip on' : 'subtitle-chip'}
              onClick={() => setTranslationOn((current) => !current)}
              type="button"
              aria-pressed={translationOn}
            >
              {t('extensive.translation')}
            </button>
            <label className="media-progress-track overlay">
              <span className="sr-only">{t('extensive.playbackProgress')}</span>
              <input
                type="range"
                min="0"
                max={duration || 0}
                step="0.1"
                value={Math.min(currentTime, duration || currentTime)}
                onChange={(event) => onSeek(Number(event.target.value))}
                disabled={duration <= 0}
              />
              <span
                className="media-progress-fill"
                style={{ width: `${progressPercent}%` }}
                aria-hidden="true"
              />
            </label>
            <span className="media-time-label">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
        </div>
        <aside className="stage-side listen-progress-card">
        <div className="listen-progress-icon">
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none" aria-hidden="true">
            <circle cx="40" cy="40" r="33" stroke="var(--line)" strokeWidth="7" strokeLinecap="round" transform="rotate(-90 40 40)" />
            {/* 0% 时不渲染弧线：零长虚线配圆角线帽会显示成一个圆点 */}
            {progressPercent > 0 && (
              <circle cx="40" cy="40" r="33" stroke="var(--accent)" strokeWidth="7" strokeDasharray={`${progressPercent * 2.08} 208`} strokeLinecap="round" transform="rotate(-90 40 40)" />
            )}
          </svg>
          <span className="listen-progress-pct">
            {duration > 0 ? Math.round(progressPercent) : 0}%
          </span>
        </div>
        {extensivePasses > 0 && (
          <p className="listen-passes">{t('extensive.passes', { count: extensivePasses })}</p>
        )}
        <button
          className="command-button primary large listen-progress-cta"
          onClick={onNextStage}
          type="button"
        >
          <ChevronRight size={22} aria-hidden="true" />
          {t('extensive.skipToSentenceStudy')}
        </button>
        {onGoExam && (
          <button
            className="command-button large listen-progress-cta ghost"
            onClick={onGoExam}
            type="button"
          >
            {t('extensive.takeExam')}
          </button>
        )}
      </aside>
    </section>
  )
}

const ExtensiveLyrics = memo(function ExtensiveLyrics({
  lines,
  activeId,
  contentLocale,
  translationsOn,
  lyricsRef,
  onSeek,
  onToggleUnclear,
  unclearLineIds,
}: {
  lines: ListeningExercise['lines']
  activeId: string
  contentLocale: ContentLocale
  translationsOn: boolean
  lyricsRef: RefObject<HTMLDivElement | null>
  onSeek: (time: number) => void
  onToggleUnclear: (lineId: string) => void
  unclearLineIds: ReadonlySet<string>
}) {
  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, time: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSeek(time)
    }
  }

  return (
    <div className="extensive-lyrics" ref={lyricsRef} aria-live="polite">
      {lines.map((line) => {
        const active = line.id === activeId
        const flagged = unclearLineIds.has(line.id)
        // 每行都挂译文（翻译开关统一控制）：开关一开一关整列都有反应，
        // 不再只有当前句一行——用户曾反馈「翻译键像摆设」。
        const translation = translationsOn
          ? resolveLineTranslation(line, contentLocale)
          : ''
        return (
          <div
            className={active ? 'extensive-lyric active' : 'extensive-lyric'}
            data-active={active || undefined}
            data-line-id={line.id}
            key={line.id}
            onClick={() => onSeek(line.start)}
            onKeyDown={(event) => handleRowKeyDown(event, line.start)}
            role="button"
            tabIndex={0}
          >
            <span className="extensive-lyric-text">{line.text}</span>
            {translation !== '' && (
              <span className="extensive-lyric-translation">{translation}</span>
            )}
            <button
              aria-pressed={flagged}
              className={flagged ? 'extensive-lyric-flag flagged' : 'extensive-lyric-flag'}
              onClick={(event) => {
                event.stopPropagation()
                onToggleUnclear(line.id)
              }}
              title={flagged ? '取消难点' : '标记难点'}
              type="button"
            >
              <Flag size={13} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
})
