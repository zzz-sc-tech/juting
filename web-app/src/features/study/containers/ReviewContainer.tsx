import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DifficultReviewStage } from '../../../components/DifficultReviewStage'
import {
  useMediaControls,
  useMediaPlaying,
  useMediaTime,
} from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'
import { useStageNavigation } from '../hooks/useStageNavigation'
import { setPendingWaveLoop } from '../../../lib/waveHandoff'
import { loadUserPrefs, persistUserPrefs } from '../../../lib/userPrefs'

type ReviewOrder = 'original' | 'weakest' | 'random'

// 随机排序的种子哈希：同课同一会话内保持稳定（池子增减不打乱已见顺序）
const hashString = (value: string): number => {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const seededShuffle = <T,>(items: T[], seed: number): T[] => {
  const out = [...items]
  let state = seed || 1
  const rand = () => {
    state = Math.imul(state ^ (state >>> 15), state | 1)
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61)
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296
  }
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// 难点复习容器：先听后看（R 揭晓）、攻克出池（F=掌握+移出）、连播、
// 顺序三档（最弱优先=已听遍数降序）、本句送波形 A-B。
export function ReviewContainer() {
  const {
    activeExercise,
    countLineRepeat,
    difficultLines,
    markLineUnclear,
    progress,
    selectedLine,
    studyExercise,
    toggleLineMastered,
  } = useStudySession()
  const { currentTime } = useMediaTime()
  const { isPlaying } = useMediaPlaying()
  const { mediaRef, playSingleLine, toggleMediaPlayback } = useMediaControls()
  const goToStage = useStageNavigation()

  // ── 顺序：原序 / 最弱优先（已听遍数降序）/ 随机（按课播种）──
  const [orderMode, setOrderMode] = useState<ReviewOrder>(() => loadUserPrefs().reviewOrder)
  const cycleOrder = useCallback(() => {
    setOrderMode((current) => {
      const next: ReviewOrder =
        current === 'weakest' ? 'original' : current === 'original' ? 'random' : 'weakest'
      const prefs = loadUserPrefs()
      persistUserPrefs({ ...prefs, reviewOrder: next })
      return next
    })
  }, [])
  const orderedLines = useMemo(() => {
    if (orderMode === 'original') {
      return difficultLines
    }
    if (orderMode === 'weakest') {
      return [...difficultLines].sort(
        (a, b) =>
          (progress?.lines[b.id]?.repeatCount ?? 0) -
          (progress?.lines[a.id]?.repeatCount ?? 0),
      )
    }
    return seededShuffle(difficultLines, hashString(`review|${studyExercise?.id ?? 0}`))
  }, [difficultLines, orderMode, progress?.lines, studyExercise?.id])
  // 选中句仍在池内则保持（从精听带着某句进复习不打断），否则落到排序后的第一句
  const selectedReviewLine = useMemo(
    () => orderedLines.find((line) => line.id === selectedLine?.id) ?? orderedLines[0] ?? null,
    [orderedLines, selectedLine?.id],
  )

  // ── 先听后看：每换一句自动回遮 ──
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    setRevealed(false)
  }, [selectedReviewLine?.id])

  // ── 连播：本机偏好持久 ──
  const [autoAdvance, setAutoAdvance] = useState(() => loadUserPrefs().reviewAutoAdvance)
  const toggleAutoAdvance = useCallback(() => {
    setAutoAdvance((current) => {
      const next = !current
      const prefs = loadUserPrefs()
      persistUserPrefs({ ...prefs, reviewAutoAdvance: next })
      return next
    })
  }, [])

  // 起播统一入口：计已听遍数（喂「最弱优先」排序）
  const playLine = useCallback(
    async (line: NonNullable<typeof selectedReviewLine>) => {
      if (!line) return
      countLineRepeat(line.id)
      await playSingleLine(line)
    },
    [countLineRepeat, playSingleLine],
  )

  const moveReviewLineAndPlay = useCallback(
    async (offset: number) => {
      if (!selectedReviewLine) {
        return
      }
      const currentIndex = orderedLines.findIndex((line) => line.id === selectedReviewLine.id)
      const nextLine = orderedLines[currentIndex + offset]
      if (!nextLine) {
        return
      }
      await playLine(nextLine)
    },
    [orderedLines, playLine, selectedReviewLine],
  )

  // 连播检测：播放由真转假且进度贴近句尾 = 自然播完 → 进下一句
  const prevPlayingRef = useRef(isPlaying)
  const autoAdvanceRef = useRef(autoAdvance)
  autoAdvanceRef.current = autoAdvance
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime
  const advanceRef = useRef<() => void>(() => {})
  advanceRef.current = () => {
    void moveReviewLineAndPlay(1)
  }
  useEffect(() => {
    if (prevPlayingRef.current && !isPlaying) {
      const line = selectedReviewLine
      if (
        autoAdvanceRef.current &&
        line &&
        Math.abs(currentTimeRef.current - line.end) < 0.25 &&
        orderedLines.length > 1
      ) {
        advanceRef.current()
      }
    }
    prevPlayingRef.current = isPlaying
  }, [isPlaying, selectedReviewLine, orderedLines.length])

  // ── D：仅移出（不掌握）／ F：攻克 = 掌握并移出 ──
  const removeFromPool = useCallback(
    (lineId: string) => {
      if (progress?.lines[lineId]?.unclear) {
        markLineUnclear(lineId)
      }
    },
    [markLineUnclear, progress?.lines],
  )
  const conquer = useCallback(
    (lineId: string) => {
      const line = progress?.lines[lineId]
      if (!line?.mastered) {
        toggleLineMastered(lineId)
      }
      if (progress?.lines[lineId]?.unclear ?? line?.unclear) {
        markLineUnclear(lineId)
      }
    },
    [markLineUnclear, progress?.lines, toggleLineMastered],
  )

  // ── 本句送波形 A-B ──
  const goWaveLoop = useCallback(
    (line: { start: number; end: number }) => {
      if (!activeExercise) return
      setPendingWaveLoop({ exerciseId: activeExercise.id, start: line.start, end: line.end })
      goToStage('waveform')
    },
    [activeExercise, goToStage],
  )

  if (!studyExercise || !progress) {
    return null
  }

  return (
    <DifficultReviewStage
      exercise={studyExercise}
      mediaRef={mediaRef}
      progress={progress}
      reviewLines={orderedLines}
      selectedLine={selectedReviewLine}
      isPlaying={isPlaying}
      revealed={revealed}
      onReveal={() => setRevealed(true)}
      onBackToIntensive={() => goToStage('intensive')}
      onLineSelect={(lineId) => {
        const line = orderedLines.find((item) => item.id === lineId)
        if (line) void playLine(line)
      }}
      onRemoveFromPool={removeFromPool}
      onConquer={conquer}
      onMoveReviewLine={(offset) => {
        void moveReviewLineAndPlay(offset)
      }}
      onPlayLine={(line) => void playLine(line)}
      onTogglePlayback={toggleMediaPlayback}
      autoAdvance={autoAdvance}
      onToggleAutoAdvance={toggleAutoAdvance}
      orderMode={orderMode}
      onCycleOrder={cycleOrder}
      onGoWaveLoop={goWaveLoop}
    />
  )
}
