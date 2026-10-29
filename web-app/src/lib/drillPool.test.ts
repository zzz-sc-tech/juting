import { describe, expect, it } from 'vitest'
import type { CatalogExerciseSummary, DialogueAnchor, ExamQuestion, TranscriptLine } from '@juting/shared'
import {
  buildDrillPool,
  questionAudioRange,
  shuffle,
  takeRound,
  type DrillQuestion,
} from './drillPool'

/**
 * 专项刷题的纯数据层：题池抽取（Section 归类 + 必须有答案）、洗牌、单题音频区间。
 * 区间算法是这里的核心风险——切早了听不到答案信息，切晚了拖进下一题的材料。
 */

const question = (n: number, stemLineId?: string): ExamQuestion => ({
  n,
  stemLineId,
  options: { A: 'a', B: 'b', C: 'c', D: 'd' },
})

const answerKeyOf = (numbers: number[], letter: 'A' | 'B' | 'C' | 'D' = 'A') =>
  Object.fromEntries(numbers.map((n) => [String(n), letter]))

type ExerciseSeed = {
  id: number
  categoryId?: number
  title?: string
  questions?: ExamQuestion[] | null
  answerKey?: Record<string, string> | null
}

const exercise = ({
  id,
  categoryId = 1,
  title = `卷 ${id}`,
  questions = [question(1), question(16)],
  answerKey = answerKeyOf((questions ?? []).map((q) => q.n)),
}: ExerciseSeed): CatalogExerciseSummary =>
  ({
    id,
    categoryId,
    title,
    audioUrl: `/audio/${id}.mp3`,
    questions,
    answerKey,
  }) as unknown as CatalogExerciseSummary

const line = (id: string, start: number, end: number): TranscriptLine => ({
  id,
  start,
  end,
  text: id,
  translation: '',
  answers: [],
  keywords: [],
})

describe('buildDrillPool', () => {
  it('按题号归 Section：1-8 A / 9-15 B / 16-25 C', () => {
    const exercises = [
      exercise({ id: 1, questions: [question(1), question(9), question(16)], answerKey: answerKeyOf([1, 9, 16]) }),
    ]
    expect(buildDrillPool(exercises, 'A').map((q) => q.n)).toEqual([1])
    expect(buildDrillPool(exercises, 'B').map((q) => q.n)).toEqual([9])
    expect(buildDrillPool(exercises, 'C').map((q) => q.n)).toEqual([16])
  })

  it('没有答案钥匙的题不进池（判不了分的题不能做）', () => {
    const exercises = [
      exercise({ id: 1, questions: [question(1), question(2)], answerKey: { '1': 'B' } }),
    ]
    const pool = buildDrillPool(exercises, 'A')
    expect(pool.map((q) => q.n)).toEqual([1])
    expect(pool[0].answer).toBe('B')
  })

  it('整门课没有 questions/answerKey 时安全跳过', () => {
    const exercises = [
      exercise({ id: 1, questions: null, answerKey: null }),
      exercise({ id: 2, questions: [question(16)], answerKey: answerKeyOf([16]) }),
    ]
    expect(buildDrillPool(exercises, 'C').map((q) => q.exerciseId)).toEqual([2])
  })

  it('答案字母非法（如 "E"）视为没有答案', () => {
    const exercises = [exercise({ id: 1, questions: [question(1)], answerKey: { '1': 'E' } })]
    expect(buildDrillPool(exercises, 'A')).toHaveLength(0)
  })

  it('携带出处信息（课程名 / categoryId / 题干行 / 音频地址）', () => {
    const exercises = [
      exercise({
        id: 7,
        categoryId: 3,
        title: '2019年6月 第1套',
        questions: [question(1, 'l-stem')],
        answerKey: { '1': 'C' },
      }),
    ]
    const [item] = buildDrillPool(exercises, 'A')
    expect(item).toMatchObject({
      exerciseId: 7,
      categoryId: 3,
      title: '2019年6月 第1套',
      stemLineId: 'l-stem',
      answer: 'C',
      audioUrl: '/audio/7.mp3',
      key: '7:1',
    })
  })

  it('同一门课重复出现时去重', () => {
    const single = exercise({ id: 1, questions: [question(1)], answerKey: { '1': 'A' } })
    expect(buildDrillPool([single, single], 'A')).toHaveLength(1)
  })

  it('结果按题号升序、同题号按课程升序（稳定输出）', () => {
    const exercises = [
      exercise({ id: 9, questions: [question(16)], answerKey: answerKeyOf([16]) }),
      exercise({ id: 3, questions: [question(17)], answerKey: answerKeyOf([17]) }),
      exercise({ id: 5, questions: [question(16)], answerKey: answerKeyOf([16]) }),
    ]
    expect(buildDrillPool(exercises, 'C').map((q) => q.key)).toEqual(['5:16', '9:16', '3:17'])
  })
})

describe('shuffle / takeRound', () => {
  const pool: DrillQuestion[] = [1, 2, 3, 4, 5].map((n) => ({ n }) as DrillQuestion)

  it('洗牌不丢元素且不改原数组', () => {
    const shuffled = shuffle(pool, () => 0)
    expect(shuffled).toHaveLength(5)
    expect(new Set(shuffled.map((q) => q.n))).toEqual(new Set([1, 2, 3, 4, 5]))
    expect(pool.map((q) => q.n)).toEqual([1, 2, 3, 4, 5])
  })

  it('取一轮按 size 截断，池子不足时全给', () => {
    expect(takeRound(pool, 3)).toHaveLength(3)
    expect(takeRound(pool, 50)).toHaveLength(5)
    expect(takeRound(pool, 0)).toHaveLength(1)
  })
})

describe('questionAudioRange', () => {
  // 真实结构：Section A → Conversation 1 →（材料）→ Q1 Q2 → Conversation 2 →（材料）→ Q3
  const lines: TranscriptLine[] = [
    { ...line('sec', 0, 5), text: 'Section A' },
    { ...line('c1', 5, 8), text: 'Conversation 1' },
    { ...line('m1', 8, 40), text: 'W: material one ...' },
    { ...line('q1', 40, 44), text: 'Q1. What does the man mean?' },
    { ...line('q2', 44, 48), text: 'Q2. Why does the woman agree?' },
    { ...line('c2', 48, 51), text: 'Conversation 2' },
    { ...line('m2', 51, 90), text: 'M: material two ...' },
    { ...line('q3', 90, 94), text: 'Q3. What is the topic?' },
  ]
  const anchors: DialogueAnchor[] = [
    { id: 'a1', kind: 'text', label: 'Section A', start: 0, end: 5, lineIds: ['sec'] },
    { id: 'a2', kind: 'text', label: 'Conversation 1', start: 5, end: 40, lineIds: ['c1'] },
    { id: 'a3', kind: 'text', label: 'Conversation 2', start: 48, end: 90, lineIds: ['c2'] },
  ]
  const questions = [question(1), question(2), question(3)]

  it('从该部分材料报头起播，到本题题干念完（材料不能被切掉）', () => {
    expect(questionAudioRange(questions, lines, 2, { anchors })).toEqual({ start: 5, end: 48 })
  })

  it('同一部分里靠后的题也从头听材料（Q3 起于 Conversation 2）', () => {
    expect(questionAudioRange(questions, lines, 3, { anchors })).toEqual({ start: 48, end: 94 })
  })

  it('认 "Question 7." 词形，不只认 "Q7."', () => {
    const worded = [...lines, { ...line('q7', 94, 99), text: 'Question 7. What do we learn?' }]
    const range = questionAudioRange(
      [...questions, question(7)],
      worded,
      7,
      { anchors: [{ id: 'a4', kind: 'text', label: 'Passage 3', start: 94, end: 100, lineIds: [] }] },
    )
    expect(range).toEqual({ start: 94, end: 99 })
  })

  it('没有报头锚点时退化为上一题念完处', () => {
    expect(questionAudioRange(questions, lines, 2)).toEqual({ start: 44, end: 48 })
    expect(questionAudioRange(questions, lines, 3)).toEqual({ start: 48, end: 94 })
  })

  it('字幕里没有 Q 标签时用 stemLineId 兜底', () => {
    const plain: TranscriptLine[] = [
      { ...line('m', 0, 30), text: 'material' },
      { ...line('s', 30, 36), text: 'What does the man imply?' },
    ]
    const range = questionAudioRange([question(1, 's')], plain, 1, { anchors })
    expect(range).toEqual({ start: 5, end: 36 })
  })

  it('题干行没有结束时间时，退到下一题起点 / duration', () => {
    const broken: TranscriptLine[] = [
      { ...line('m', 0, 10), text: 'material' },
      { id: 'q1', start: 10, end: Number.NaN, text: 'Q1. Why?', translation: '', answers: [], keywords: [] },
      { ...line('q2', 60, 64), text: 'Q2. What?' },
    ]
    expect(questionAudioRange([question(1), question(2)], broken, 1, { anchors })).toEqual({ start: 5, end: 60 })
  })

  it('duration 会截断越界区间', () => {
    expect(questionAudioRange(questions, lines, 3, { anchors, duration: 92 })).toEqual({ start: 48, end: 92 })
  })

  it('没有字幕时间轴 / 题号不存在时返回 null', () => {
    expect(questionAudioRange(questions, [], 1, { anchors })).toBeNull()
    expect(questionAudioRange(questions, lines, 25, { anchors })).toBeNull()
  })
})
