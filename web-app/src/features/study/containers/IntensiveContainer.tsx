import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { registerVocabWords, unregisterVocabWord } from '../../../lib/vocabReview'
import { loadUserPrefs, persistUserPrefs } from '../../../lib/userPrefs'

// 精听容器：正文中「上一句/下一句」移动必须用 studyExercise.lines 寻址——
// selectedLineIndex 是正文序号；历史上误用全量 lines（含指令行）曾导致
// 「下一句」越走越靠前（见 useStudyProgress 与交接文档 §3.2）。
export function IntensiveContainer() {
  const {
    activeExercise,
    countLineRepeat,
    dialogueAnchors,
    exercisesByCategory,
    lineProgress,
    markLineUnclear,
    progress,
    revealedLineIds,
    selectedLine,
    selectedLineIndex,
    selectedSeriesId,
    seriesExercises,
    studyExercise,
    studySections,
    syncRoute,
    studyStage,
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

  // 词典侧栏：例句来源标注用课标题；跳转保持当前阶段
  const courseTitles = useMemo(
    () => Object.fromEntries(seriesExercises.map((item) => [item.id, item.title])),
    [seriesExercises],
  )

  // courseId → seriesId：ctx 里的例句可能来自别的系列（今天都同系列，属防御）
  const seriesOfCourse = useMemo(() => {
    const map: Record<number, number> = {}
    for (const [categoryId, list] of Object.entries(exercisesByCategory)) {
      for (const item of list ?? []) map[item.id] = Number(categoryId)
    }
    return map
  }, [exercisesByCategory])

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
        // 复习调度登记：新收藏的词按默认间隔明天才进复习队列（见 vocabReview.ts）
        registerVocabWords(words)
        updateActiveProgress((current) => {
          const vocabulary = { ...current.vocabulary }
          for (const word of words) {
            // 词表里可能已存在大小写不同的同一词（The / the），复用旧键而不是新增一条
            const existingKey = Object.keys(vocabulary).find(
              (key) => key.toLowerCase() === word.toLowerCase(),
            )
            vocabulary[existingKey ?? word] = selectedLine.text
          }
          return { ...current, vocabulary }
        })
      }}
      onRemoveVocabulary={(word) => {
        // 同步清掉复习调度记录（同词再收藏会重新排队）
        unregisterVocabWord(word)
        updateActiveProgress((current) => {
          // 侧栏的「已收藏」判定忽略大小写，删除也必须同样忽略，否则按钮点了没反应
          const key = Object.keys(current.vocabulary ?? {}).find(
            (item) => item.toLowerCase() === word.toLowerCase(),
          )
          if (!key) return current
          const vocabulary = { ...current.vocabulary }
          delete vocabulary[key]
          return { ...current, vocabulary }
        })
      }}
      courseTitles={courseTitles}
      onJumpToLine={(courseId, lineId) => {
        // ctx 的 courseId 可能属于别的系列，用映射表里的系列，别拿当前系列硬套
        syncRoute(seriesOfCourse[courseId] ?? selectedSeriesId, courseId, studyStage, { lineId })
      }}
    />
  )
}
