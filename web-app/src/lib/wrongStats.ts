/**
 * 反复错题聚合（模拟实战成绩档案的跨场次统计）。
 *
 * examHistory 记了每场错的题号（ExamAttempt.wrong），但从未跨场次统计——
 * 这里把「历次都错的题」算出来：错几次、考过几次、最后错在何时、属于哪个 Section。
 * 输入是 getAllAttempts() 的形态（courseId → attempts[]），输出按 wrongCount 降序。
 */
import type { ExamAttempt, ExamSection } from './examHistory'
import { sectionOfQuestion } from './examHistory'

export type WrongStat = {
  /** 课程（真题课）id */
  courseId: number
  /** 题号 */
  questionNo: number
  /** 累计错次数 */
  wrongCount: number
  /** 该题被考过几次（每场 25 题全考，即该课场数） */
  attemptCount: number
  /** 最后一次答错的场次时间（ISO） */
  lastWrongDate: string
  /** 所属 Section（A/B/C） */
  section: ExamSection
}

/** 跨课程聚合反复错题，按 wrongCount 降序；同错次数按题号升序稳定输出。 */
export const aggregateWrong = (
  attemptsByCourse: Record<string, ExamAttempt[]>,
): WrongStat[] => {
  const byQuestion = new Map<string, WrongStat>()
  for (const [courseIdRaw, attempts] of Object.entries(attemptsByCourse)) {
    if (!Array.isArray(attempts) || attempts.length === 0) continue
    const courseId = Number(courseIdRaw)
    const attemptCount = attempts.length
    for (const attempt of attempts) {
      if (!attempt || !Array.isArray(attempt.wrong)) continue
      for (const questionNo of attempt.wrong) {
        if (typeof questionNo !== 'number' || !Number.isInteger(questionNo)) continue
        const key = `${courseId}:${questionNo}`
        const existing = byQuestion.get(key)
        if (existing) {
          existing.wrongCount += 1
          if (attempt.date > existing.lastWrongDate) {
            existing.lastWrongDate = attempt.date
          }
        } else {
          byQuestion.set(key, {
            courseId,
            questionNo,
            wrongCount: 1,
            attemptCount,
            lastWrongDate: attempt.date,
            section: sectionOfQuestion(questionNo),
          })
        }
      }
    }
  }
  return [...byQuestion.values()].sort((left, right) =>
    right.wrongCount - left.wrongCount || left.courseId - right.courseId || left.questionNo - right.questionNo,
  )
}
