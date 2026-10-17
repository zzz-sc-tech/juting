/**
 * 模拟实战成绩档案（本机 localStorage，键 juting.web.exam-history.v1）：
 * 每课最多保留 50 场，供仪表盘分数曲线 / 章节卡最近分 / 错题重练消费。
 * 六级听力卷面固定 25 题、Section 划分固定（1-8 A / 9-15 B / 16-25 C）。
 */
import { safeSetItem } from './storageSafety'

export type ExamSection = 'A' | 'B' | 'C'
export type ExamLetter = 'A' | 'B' | 'C' | 'D'

export type ExamAttempt = {
  date: string
  score: number
  total: number
  /** 答错题号 */
  wrong: number[]
  unanswered: number
  wrongBySection: Record<ExamSection, number>
}

const KEY = 'juting.web.exam-history.v1'
const MAX_PER_COURSE = 50

export const sectionOfQuestion = (n: number): ExamSection =>
  n <= 8 ? 'A' : n <= 15 ? 'B' : 'C'

const loadAll = (): Record<string, ExamAttempt[]> => {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, ExamAttempt[]>) : {}
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    // 逐条校验：畸形条目（对象/字符串等非数组形态）一律视为空，
    // 否则 getAttempts 的 for...of 会在结果页抛 not-iterable 白屏
    const safe: Record<string, ExamAttempt[]> = {}
    for (const [exerciseId, attempts] of Object.entries(parsed)) {
      if (Array.isArray(attempts)) {
        safe[exerciseId] = attempts
      }
    }
    return safe
  } catch {
    return {}
  }
}

export const getAttempts = (exerciseId: number): ExamAttempt[] =>
  loadAll()[String(exerciseId)] ?? []

export const getAllAttempts = (): Record<string, ExamAttempt[]> => loadAll()

/** 每课最近一场（按日期取最新）；供课程地图「最近 X/25」角标。 */
export const getLatestByCourse = (): Record<string, ExamAttempt> => {
  const latest: Record<string, ExamAttempt> = {}
  for (const [exerciseId, attempts] of Object.entries(loadAll())) {
    const last = attempts[attempts.length - 1]
    if (last) {
      latest[exerciseId] = last
    }
  }
  return latest
}

export const recordAttempt = (
  exerciseId: number,
  raw: { score: number; total: number; wrong: number[]; unanswered: number },
): ExamAttempt => {
  const wrongBySection: Record<ExamSection, number> = { A: 0, B: 0, C: 0 }
  for (const n of raw.wrong) {
    wrongBySection[sectionOfQuestion(n)] += 1
  }
  const attempt: ExamAttempt = {
    date: new Date().toISOString(),
    score: raw.score,
    total: raw.total,
    wrong: [...raw.wrong].sort((a, b) => a - b),
    unanswered: raw.unanswered,
    wrongBySection,
  }
  try {
    const all = loadAll()
    const key = String(exerciseId)
    all[key] = [...(all[key] ?? []), attempt].slice(-MAX_PER_COURSE)
    safeSetItem(KEY, JSON.stringify(all))
  } catch {
    // stringify 异常（理论可能）：成绩档案只是统计，不阻断交卷
  }
  return attempt
}
