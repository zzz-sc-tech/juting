import { ChevronRight, Pause, Play } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { DialogueAnchor, ListeningExercise } from '@juting/shared'
import { DialogueAnchorBar } from './DialogueAnchorBar'
import { resolveApiUrl } from '../lib/apiClient'
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
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
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
}: ExtensiveStageProps) {
  const { t } = useLanguage()
  const progressPercent =
    duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0

  // 实时字幕：按播放进度取"最后一句已开始的台词"（含指令句——泛听听的就是全篇）；
  // 句间空档沿用上一句，避免字幕闪烁消失。
  const [captionsOn, setCaptionsOn] = useState(true)
  const [translationOn, setTranslationOn] = useState(true)
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
  const activeTranslation =
    activeLine?.translation && activeLine.translation !== activeLine.text
      ? activeLine.translation
      : null

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
              <div aria-hidden="true" className="listen-visual-waves" />
            </>
          )}
          {/* 实时字幕 + 翻译浮层（可在控制栏关闭） */}
          {captionsOn && activeLine && (
            <div className="extensive-subtitle" aria-live="polite">
              <p className="extensive-subtitle-text">{activeLine.text}</p>
              {translationOn && activeTranslation && (
                <p className="extensive-subtitle-translation">{activeTranslation}</p>
              )}
            </div>
          )}
          {/* 浮动控制栏：视频/音频底部叠加进度条和播放按钮 */}
          <div className="listen-visual-controls">
            <button className="media-play-btn" onClick={onTogglePlayback} type="button">
              {isPlaying ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
              <span>{isPlaying ? t('extensive.pause') : t('extensive.play')}</span>
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
            <circle cx="40" cy="40" r="33" stroke="#e4eef8" strokeWidth="12" strokeLinecap="round" transform="rotate(-90 40 40)" />
            <circle cx="40" cy="40" r="33" stroke="var(--accent)" strokeWidth="12" strokeDasharray={`${progressPercent * 2.08} 208`} strokeLinecap="round" transform="rotate(-90 40 40)" />
          </svg>
          <span className="listen-progress-pct">
            {duration > 0 ? Math.round(progressPercent) : 0}%
          </span>
        </div>
        <button
          className="command-button primary large listen-progress-cta"
          onClick={onNextStage}
          type="button"
        >
          <ChevronRight size={22} aria-hidden="true" />
          {t('extensive.skipToSentenceStudy')}
        </button>
      </aside>
    </section>
  )
}
