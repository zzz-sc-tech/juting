import { describe, expect, it } from 'vitest'
import type { ExamAttempt } from './examHistory'
import { aggregateWrong } from './wrongStats'

/**
 * 反复错题聚合：跨场次计数、最近错期、Section 归属、排序稳定。
 * 覆盖老数据（无 wrong 字段）与畸形条目，保证仪表盘不因脏数据白屏。
 */

const attempt = (date: string, wrong: number[]): ExamAttempt => ({
  date,
  score: 25 - wrong.length,
  total: 25,
  wrong,
  unanswered: 0,
  wrongBySection: { A: 0, B: 0, C: 0 },
})

describe('aggregateWrong', () => {
  it('跨场次累计错次数，并记录该课总场数', () => {
    const stats = aggregateWrong({
      '12': [attempt('2026-10-01', [3, 9]), attempt('2026-10-08', [3]), attempt('2026-10-15', [3])],
    })
    const q3 = stats.find((s) => s.questionNo === 3)
    expect(q3?.wrongCount).toBe(3)
    expect(q3?.attemptCount).toBe(3)
  })

  it('最近错期取最大日期', () => {
    const stats = aggregateWrong({
      '12': [attempt('2026-10-08', [3]), attempt('2026-10-01', [3]), attempt('2026-10-15', [3])],
    })
    expect(stats[0].lastWrongDate).toBe('2026-10-15')
  })

  it('Section 归属：1-8 A / 9-15 B / 16-25 C', () => {
    const stats = aggregateWrong({ '1': [attempt('2026-10-01', [1, 9, 16])] })
    const byNo = Object.fromEntries(stats.map((s) => [s.questionNo, s.section]))
    expect(byNo[1]).toBe('A')
    expect(byNo[9]).toBe('B')
    expect(byNo[16]).toBe('C')
  })

  it('按错次数降序；同次数按课程、题号升序（稳定输出）', () => {
    const stats = aggregateWrong({
      '9': [attempt('2026-10-01', [5, 2])],
      '3': [attempt('2026-10-01', [7]), attempt('2026-10-02', [7])],
    })
    expect(stats[0]).toMatchObject({ courseId: 3, questionNo: 7, wrongCount: 2 })
    expect(stats.slice(1).map((s) => s.questionNo)).toEqual([2, 5])
  })

  it('老数据没有 wrong 字段时跳过，不抛错', () => {
    const legacy = [{ date: '2026-10-01', score: 20, total: 25, unanswered: 2 }] as unknown as ExamAttempt[]
    expect(aggregateWrong({ '5': legacy })).toEqual([])
  })

  it('空课程与非法条目（wrong 不是数组 / 题号非整数）都被忽略', () => {
    const dirty = [
      { date: '2026-10-01', score: 20, total: 25, wrong: 'nope' },
      { date: '2026-10-02', score: 20, total: 25, wrong: [1, 2.5, 'x'] },
    ] as unknown as ExamAttempt[]
    const stats = aggregateWrong({ '5': dirty, '6': [] })
    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({ courseId: 5, questionNo: 1, wrongCount: 1 })
  })

  it('同一题在同一场里重复出现只按追加处理（数据脏时的兜底行为）', () => {
    const stats = aggregateWrong({ '1': [attempt('2026-10-01', [4, 4])] })
    expect(stats[0].wrongCount).toBe(2)
  })
})
