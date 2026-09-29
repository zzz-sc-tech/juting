import { useCallback, useMemo } from 'react'
import {
  findDialogueAnchorAtTime,
  type DialogueAnchor,
} from '@juting/shared'
import {
  useMediaControls,
  useMediaPlaying,
} from '../MediaPlaybackContext'
import { useStudySession } from '../StudySessionContext'

// 当前高亮锚点。参考时间由调用方按阶段给出：
// 精听跟随选中句 start，泛听/波形跟随播放进度 currentTime。
export function useActiveAnchorId(referenceTime: number) {
  const { dialogueAnchors } = useStudySession()
  return useMemo(
    () =>
      dialogueAnchors.length === 0
        ? null
        : findDialogueAnchorAtTime(dialogueAnchors, referenceTime)?.id ?? null,
    [dialogueAnchors, referenceTime],
  )
}

export function useJumpToAnchor() {
  const { activeExercise, studyExercise, studyStage } = useStudySession()
  const { isPlaying } = useMediaPlaying()
  const { playMedia, playSingleLine, seekMedia } = useMediaControls()

  return useCallback(
    (anchor: DialogueAnchor) => {
      if (!activeExercise || !studyExercise) {
        return
      }

      if (studyStage === 'intensive') {
        // 精听：定位到锚点区间内的第一句正文并按句子范围播放（指令行已被过滤）。
        const targetLine =
          studyExercise.lines.find((line) => line.start >= anchor.start - 0.001) ??
          studyExercise.lines[0]
        if (targetLine) {
          void playSingleLine(targetLine)
        }
        return
      }

      // 泛听：跳到指令句开头并连续播放整段对话。
      seekMedia(anchor.start)
      if (!isPlaying) {
        void playMedia()
      }
    },
    [
      activeExercise,
      isPlaying,
      playMedia,
      playSingleLine,
      seekMedia,
      studyExercise,
      studyStage,
    ],
  )
}
