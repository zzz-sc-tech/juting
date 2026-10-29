/**
 * 题干行解析：优先按字幕文本找，而不是信 questions_json.stemLineId。
 *
 * 为什么要绕这一道：2026-10 全量审计发现 950 个题干里只有 537 个的 stemLineId
 * 指向「文本以对应题号开头」的行，其余整体偏移 1–3 题（21 门课有错，11 门整卷全错），
 * 还有 21 条指向已被重排删掉的行。实战舞台的「正在读题」高亮、「去句听」落点、
 * 专项刷题的音频区间都依赖这个位置，按文本找比信那份映射可靠得多。
 *
 * 文本匹配的可靠性：38 门课 950 题里 948 题能匹配到唯一行，且各课题干时间严格递增，
 * 「取第一次出现」不会先撞上材料里引用的题号。
 */
import type { ExamQuestion, TranscriptLine } from '@juting/shared'

// 「question」必须排在「q」前，否则 "Question 1." 会先匹配到 "q"、把 "uestion" 当成题号
const QUESTION_LABEL = /^(?:question|q)\s*\.?\s*(\d{1,2}|[a-z-]+)\b/i

/** 「Question five.」这种念出来而不是写数字的题干（课 45 有两句）。 */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  'twenty-one': 21,
  'twenty-two': 22,
  'twenty-three': 23,
  'twenty-four': 24,
  'twenty-five': 25,
}

/** 从题干行文本里取题号；不是题干行返回 null。 */
export const questionNumberOf = (text: string): number | null => {
  const match = QUESTION_LABEL.exec(text.trim())
  if (!match) return null
  const raw = match[1]!.toLowerCase()
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return value >= 1 && value <= 25 ? value : null
  }
  return WORD_NUMBERS[raw] ?? null
}

/** 按字幕文本建「题号 → 题干行」索引；同一题号取第一次出现的那一行。 */
export const indexQuestionLines = (lines: TranscriptLine[]): Map<number, TranscriptLine> => {
  const index = new Map<number, TranscriptLine>()
  for (const line of lines) {
    const n = questionNumberOf(line.text)
    if (n === null) continue
    if (!index.has(n)) index.set(n, line)
  }
  return index
}

/**
 * 某题的题干行：文本索引优先，取不到再退回 stemLineId（历史上那份映射）。
 * 返回 null 表示这门课确实没有可用的题干时间轴。
 */
export const resolveQuestionLine = (
  question: ExamQuestion,
  lines: TranscriptLine[],
  index: Map<number, TranscriptLine> = indexQuestionLines(lines),
): TranscriptLine | null => {
  const byText = index.get(question.n)
  if (byText) return byText
  if (!question.stemLineId) return null
  return lines.find((line) => line.id === question.stemLineId) ?? null
}
