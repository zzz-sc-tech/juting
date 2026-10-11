/**
 * 生词本辅助（数据存于各课 ExerciseProgress.vocabulary：词 → 收藏时原句）。
 * 这里只做跨课聚合与增删的纯函数，持久化沿用 store 的既有通道。
 */
export type VocabEntry = {
  courseId: number
  word: string
  context: string
  addedAt?: string
}

/** 跨课聚合生词（按课程倒序、词加入顺序），供生词本页展示。 */
export const collectVocabEntries = (
  progressByExercise: Record<string, { vocabulary?: Record<string, string> }>,
): VocabEntry[] => {
  const entries: VocabEntry[] = []
  for (const [courseId, progress] of Object.entries(progressByExercise)) {
    for (const [word, context] of Object.entries(progress.vocabulary ?? {})) {
      entries.push({ courseId: Number(courseId), word, context })
    }
  }
  return entries
}

/** 拆分输入框里的多个词（空白/中英文逗号/分号分隔）。 */
export const splitWords = (input: string): string[] =>
  input
    .split(/[\s,，;；、]+/)
    .map((word) => word.trim())
    .filter(Boolean)
