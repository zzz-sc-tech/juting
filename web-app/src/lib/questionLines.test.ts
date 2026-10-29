import { describe, expect, it } from 'vitest'
import type { ExamQuestion, TranscriptLine } from '@juting/shared'
import { indexQuestionLines, questionNumberOf, resolveQuestionLine } from './questionLines'

/**
 * 题干行解析：文本优先、stemLineId 兜底。
 * 这份能力是语料修复的地基——950 个题干里曾有 413 个 stemLineId 指错，
 * 解析错了，实战高亮和「去句听」就一起歪。
 */

const line = (id: string, start: number, text: string): TranscriptLine => ({
  id,
  start,
  end: start + 4,
  text,
  translation: '',
  answers: [],
  keywords: [],
})

describe('questionNumberOf', () => {
  it('认 "Q1." 与 "Question 7."', () => {
    expect(questionNumberOf('Q1. What do we learn?')).toBe(1)
    expect(questionNumberOf('Question 7. Why does the man agree?')).toBe(7)
  })

  it('认念出来的词形 "Question five."（课 45 有两句）', () => {
    expect(questionNumberOf('Question five. What will many people say?')).toBe(5)
    expect(questionNumberOf('Question twenty-five. What next?')).toBe(25)
  })

  it('不把复数报头当题干（"Questions 5 to 8 are based on..."）', () => {
    expect(questionNumberOf('Questions 5 to 8 are based on the conversation you have just heard.')).toBeNull()
  })

  it('超范围与无关文本返回 null', () => {
    expect(questionNumberOf('Q26. Out of range')).toBeNull()
    expect(questionNumberOf('Conversation 1')).toBeNull()
    expect(questionNumberOf('M: Hello there.')).toBeNull()
  })
})

describe('indexQuestionLines', () => {
  it('按题号建索引，同一题号取第一次出现', () => {
    const index = indexQuestionLines([
      line('l1', 10, 'Q1. First?'),
      line('l2', 20, 'Q2. Second?'),
      line('l3', 30, 'Q1. Repeated later?'),
    ])
    expect(index.get(1)?.id).toBe('l1')
    expect(index.get(2)?.id).toBe('l2')
    expect(index.size).toBe(2)
  })
})

describe('resolveQuestionLine', () => {
  const lines = [line('l1', 10, 'Q1. Real stem?'), line('l2', 20, 'Q3. Another stem?')]
  const byText = indexQuestionLines(lines)

  it('文本优先：stemLineId 指错了也按文本纠正', () => {
    const question: ExamQuestion = {
      n: 1,
      stemLineId: 'l2',
      options: { A: 'a', B: 'b', C: 'c', D: 'd' },
    }
    expect(resolveQuestionLine(question, lines, byText)?.id).toBe('l1')
  })

  it('字幕里没有该题号的题干行时退回 stemLineId', () => {
    const question: ExamQuestion = {
      n: 2,
      stemLineId: 'l2',
      options: { A: 'a', B: 'b', C: 'c', D: 'd' },
    }
    expect(resolveQuestionLine(question, lines, byText)?.id).toBe('l2')
  })

  it('两者都没有返回 null', () => {
    const question: ExamQuestion = {
      n: 9,
      stemLineId: null,
      options: { A: 'a', B: 'b', C: 'c', D: 'd' },
    }
    expect(resolveQuestionLine(question, lines, byText)).toBeNull()
  })
})
