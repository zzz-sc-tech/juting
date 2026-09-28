import { useMemo } from 'react'
import type {
  ExerciseProgress,
  LineProgress,
  ListeningExercise,
  StudyStore,
} from '@juting/domain'
import {
  createExerciseProgress,
  createLineProgress,
  ensureExerciseProgress,
} from '../lib/progressStore'
import { isDictationAccepted } from '../lib/studyStages'

type UseStudyProgressOptions = {
  activeExercise?: ListeningExercise
  store: StudyStore
  setStore: React.Dispatch<React.SetStateAction<StudyStore>>
}

export function useStudyProgress({
  activeExercise,
  store,
  setStore,
}: UseStudyProgressOptions) {
  const progress = useMemo(
    () =>
      activeExercise
        ? store.progressByExercise[activeExercise.id] ??
          createExerciseProgress(activeExercise)
        : undefined,
    [activeExercise, store.progressByExercise],
  )

  const selectedLine =
    activeExercise && progress
      ? activeExercise.lines.find((line) => line.id === progress.lastLineId) ??
        activeExercise.lines[0]
      : undefined

  const selectedLineIndex =
    activeExercise && selectedLine
      ? Math.max(
          activeExercise.lines.findIndex((line) => line.id === selectedLine.id),
          0,
        )
      : 0

  const lineProgress =
    selectedLine && progress
      ? progress.lines[selectedLine.id] ?? createLineProgress()
      : createLineProgress()

  // 分子只统计当前 exercise 里真实存在的行：历史进度里可能残留指令行的
  // 孤儿条目（指令行已不在学习内容中），直接用 stats.mastered 会虚高甚至超 100%。
  const masteredInContent = activeExercise && progress
    ? activeExercise.lines.filter((line) => progress.lines[line.id]?.mastered).length
    : 0
  const masteryPercent = activeExercise?.lines.length
    ? Math.round((masteredInContent / activeExercise.lines.length) * 100)
    : 0
  const acceptedAnswers = selectedLine
    ? [selectedLine.text, ...(selectedLine.answers ?? [])]
    : []
  const dictationMatches = isDictationAccepted(
    lineProgress.dictation,
    acceptedAnswers,
  )

  const updateActiveProgress = (
    updater: (progress: ExerciseProgress) => ExerciseProgress,
  ) => {
    if (!activeExercise) {
      return
    }

    setStore((current) => {
      const prepared = ensureExerciseProgress(current, activeExercise)
      return {
        ...prepared,
        progressByExercise: {
          ...prepared.progressByExercise,
          [activeExercise.id]: {
            ...updater(prepared.progressByExercise[activeExercise.id]),
            updatedAt: new Date().toISOString(),
          },
        },
      }
    })
  }

  const updateLineProgress = (
    lineId: string,
    updater: (line: LineProgress) => LineProgress,
  ) => {
    updateActiveProgress((current) => ({
      ...current,
      lines: {
        ...current.lines,
        [lineId]: updater(current.lines[lineId] ?? createLineProgress()),
      },
    }))
  }

  const selectLine = (lineId: string) => {
    updateActiveProgress((current) => ({
      ...current,
      lastLineId: lineId,
    }))
  }

  const addVocabulary = (word: string, line = selectedLine) => {
    if (!line) {
      return
    }

    updateActiveProgress((current) => ({
      ...current,
      vocabulary: {
        ...current.vocabulary,
        [word]: line.text,
      },
    }))
  }

  const moveSelectedLine = (offset: number) => {
    if (!activeExercise) {
      return
    }

    const nextLine = activeExercise.lines[selectedLineIndex + offset]
    if (nextLine) {
      selectLine(nextLine.id)
    }
  }

  const markLineMastered = (lineId: string) => {
    // mastered 是 toggle；每日活动统计由调用方（App）在本地记录，
    // 这里只负责切换状态。
    updateLineProgress(lineId, (current) => ({
      ...current,
      mastered: !current.mastered,
    }))
  }

  const markLineUnclear = (lineId: string) => {
    updateLineProgress(lineId, (current) => ({
      ...current,
      unclear: !current.unclear,
    }))
  }

  return {
    addVocabulary,
    dictationMatches,
    lineProgress,
    markLineMastered,
    markLineUnclear,
    masteryPercent,
    moveSelectedLine,
    progress,
    selectedLine,
    selectedLineIndex,
    selectLine,
    updateActiveProgress,
    updateLineProgress,
  }
}
