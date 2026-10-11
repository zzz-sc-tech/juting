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
    // answers 必须是纯对象且值为合法字母——字符串等畸形形态会让恢复层
    // 把垃圾数据灌进作答状态
    const answersOk =
      state &&
      typeof state.answers === 'object' &&
      !Array.isArray(state.answers) &&
      Object.values(state.answers).every((v) => v === 'A' || v === 'B' || v === 'C' || v === 'D') &&
      Object.keys(state.answers).length > 0
    return answersOk && typeof state.currentTime === 'number' && Number.isFinite(state.currentTime)
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
