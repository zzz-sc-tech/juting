/**
 * 模拟实战进行中状态（本机 localStorage，键 juting.web.exam-inprogress.v1）：
 * 切阶段/误关页后回到考试可继续（作答 + 播放位置）。交卷或重新开考即清。
 */
import type { ExamLetter } from './examHistory'

export type ExamInprogress = {
  answers: Record<string, ExamLetter>
  currentTime: number
  savedAt: number
}

const KEY = 'juting.web.exam-inprogress.v1'

export const getInprogress = (exerciseId: number): ExamInprogress | null => {
  try {
    const raw = localStorage.getItem(KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, ExamInprogress>) : {}
    const state = all[String(exerciseId)]
    return state && state.answers && typeof state.currentTime === 'number' && Object.keys(state.answers).length > 0
      ? state
      : null
  } catch {
    return null
  }
}

export const saveInprogress = (exerciseId: number, state: ExamInprogress): void => {
  if (Object.keys(state.answers).length === 0) {
    return
  }
  try {
    const raw = localStorage.getItem(KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, ExamInprogress>) : {}
    all[String(exerciseId)] = state
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 同上：静默失败
  }
}

export const clearInprogress = (exerciseId: number): void => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const all = JSON.parse(raw) as Record<string, ExamInprogress>
    delete all[String(exerciseId)]
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 忽略
  }
}
