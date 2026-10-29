import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ExamStage } from '../../../components/ExamStage'
import {
  useMediaControls,
  useMediaPlaying,
  useMediaTime,
} from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'
import { useStageNavigation } from '../hooks/useStageNavigation'

// 模拟实战容器：连播 + 交卷后标记阶段完成；错题跳回精听（题干行回归学习池，
// 可直接选中；跨舞台切换后媒体元素重挂载，延迟一拍再起播以绑到新 audio）。
export function ExamContainer() {
  const {
    activeExercise,
    dialogueAnchors,
    selectLine,
    setStageCompleted,
    studyExercise,
  } = useStudySession()
  const { currentTime, duration } = useMediaTime()
  const { isPlaying } = useMediaPlaying()
  const { mediaRef, playMediaRange, toggleMediaPlayback } = useMediaControls()
  const goToStage = useStageNavigation()
  const [searchParams, setSearchParams] = useSearchParams()

  // ?q=19：仪表盘「你最常错的题」点进来的题号。只在挂载时读一次——
  // 之后用户自己翻题/切阶段都不该再被拉回这一题。
  const [initialQuestion] = useState<number | undefined>(() => {
    const raw = searchParams.get('q')
    if (!raw || !/^\d{1,2}$/.test(raw)) return undefined
    const value = Number(raw)
    return value >= 1 && value <= 25 ? value : undefined
  })

  // 消费掉查询参数：切到精听再回来时不该又变成「定位练习」
  useEffect(() => {
    if (!searchParams.has('q')) return
    const next = new URLSearchParams(searchParams)
    next.delete('q')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const handleGoIntensive = useCallback(
    (stemLineId: string | null, fallbackStart: number | null) => {
      if (!activeExercise) return
      const line = activeExercise.lines.find((item) => item.id === stemLineId)
      goToStage('intensive')
      if (line) {
        // 精听高亮同步到题干行（题干已回归学习池；万一被锚点吞掉则保持默认选中）
        if (studyExercise?.lines.some((item) => item.id === line.id)) {
          selectLine(line.id)
        }
        // 精听舞台挂载新 audio 后再按句播放；300ms 足够 React 完成重挂载
        window.setTimeout(() => {
          void playMediaRange(line.start, line.end)
        }, 300)
      } else if (fallbackStart !== null && Number.isFinite(fallbackStart)) {
        window.setTimeout(() => {
          void playMediaRange(fallbackStart, fallbackStart + 20)
        }, 300)
      }
    },
    [activeExercise, goToStage, playMediaRange, selectLine, studyExercise],
  )

  if (!activeExercise) {
    return null
  }

  return (
    <ExamStage
      key={activeExercise.id}
      exercise={activeExercise}
      mediaRef={mediaRef}
      currentTime={currentTime}
      duration={duration}
      isPlaying={isPlaying}
      dialogueAnchors={dialogueAnchors}
      initialQuestion={initialQuestion}
      onTogglePlayback={() => void toggleMediaPlayback()}
      onRestart={() => void toggleMediaPlayback({ restartAt: 0 })}
      onComplete={() => setStageCompleted('exam', true)}
      onGoIntensive={handleGoIntensive}
      onPlayRange={(start, end) => void playMediaRange(start, end)}
    />
  )
}
