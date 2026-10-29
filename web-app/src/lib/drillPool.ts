/**
 * 按题型专项刷题的纯数据层：从课程摘要里抽题、按 Section 归类、算单题音频区间。
 *
 * 为什么抽题要跨课：专项训练的意义就是「不按卷套、按题型」——
 * Section C 的题散在 38 套卷里，抽出来才能连着做十道篇章听力。
 *
 * 单题音频区间不是「只放题干那一句」：六级听力里答案信息在题干之前念的材料里，
 * 只放题干等于让人凭空猜。区间取「该部分材料开始 → 本题题干念完」。
 *
 * 为什么要从字幕文本里找题干，而不是信 questions_json 的 stemLineId：
 * 实测 38 门课 929 个题干里只有约 58% 的 stemLineId 指向文本以对应题号开头的行，
 * 其余整体偏移 1–3 题或指向报头行（详见 temp/ 的审计脚本）。按文本找
 * 「Q7. / Question 7」比信那份映射可靠得多，映射只作为兜底。
 */
import type {
  CatalogExerciseSummary,
  DialogueAnchor,
  ExamQuestion,
  TranscriptLine,
} from '@juting/shared'
import { sectionOfQuestion, type ExamLetter, type ExamSection } from './examHistory'

const LETTERS: ExamLetter[] = ['A', 'B', 'C', 'D']

/** 材料报头：一个部分的起点（与 ExamStage 的部分划分同一套标签） */
const PART_BOUNDARY = /^(?:Conversation|Passage|Recording|Text)\s*\d|^Section\s+[ABC]/i

/** 题干行：'Q7. What...' / 'Question 7. What...' / 'Q7 What...' */
const READ_OUT = /^(?:Q|Question)\s*(\d{1,2})\b/i

export type DrillQuestion = {
  /** exerciseId:n，React key 与去重都用它 */
  key: string
  exerciseId: number
  categoryId: number
  title: string
  audioUrl: string
  section: ExamSection
  n: number
  options: ExamQuestion['options']
  stemLineId: string | null
  /** 正确答案字母（来自 answerKey，缺答案的题不收进题池） */
  answer: ExamLetter
}

const asLetter = (value: unknown): ExamLetter | null =>
  typeof value === 'string' && (LETTERS as readonly string[]).includes(value) ? (value as ExamLetter) : null

/**
 * 抽某 Section 的题池。
 * 只收「有题干选项 + 有正确答案」的题：专项刷题的第一交互是立即判分，
 * 没有答案钥匙的课进来只会让人做完发现判不了。
 */
export const buildDrillPool = (
  exercises: CatalogExerciseSummary[],
  section: ExamSection,
): DrillQuestion[] => {
  const pool: DrillQuestion[] = []
  const seen = new Set<string>()
  for (const exercise of exercises) {
    const questions = exercise.questions
    const answerKey = exercise.answerKey
    if (!Array.isArray(questions) || questions.length === 0) continue
    if (!answerKey || typeof answerKey !== 'object') continue
    for (const question of questions) {
      if (!question || typeof question.n !== 'number') continue
      if (sectionOfQuestion(question.n) !== section) continue
      const answer = asLetter((answerKey as Record<string, unknown>)[String(question.n)])
      if (!answer) continue
      const key = `${exercise.id}:${question.n}`
      if (seen.has(key)) continue
      seen.add(key)
      pool.push({
        key,
        exerciseId: exercise.id,
        categoryId: exercise.categoryId,
        title: exercise.title,
        audioUrl: exercise.audioUrl,
        section,
        n: question.n,
        options: question.options,
        stemLineId: question.stemLineId ?? null,
        answer,
      })
    }
  }
  return pool.sort((left, right) => left.n - right.n || left.exerciseId - right.exerciseId)
}

/** Fisher-Yates 洗牌（random 可注入，单测才能断言确定性）。 */
export const shuffle = <T>(list: T[], random: () => number = Math.random): T[] => {
  const next = [...list]
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const swap = next[i]!
    next[i] = next[j]!
    next[j] = swap
  }
  return next
}

/** 从题池里取一轮：不足 size 时全给（宁少不重复，同题连做两遍没意义）。 */
export const takeRound = (
  pool: DrillQuestion[],
  size: number,
  random: () => number = Math.random,
): DrillQuestion[] => shuffle(pool, random).slice(0, Math.max(1, size))

export type AudioRange = { start: number; end: number }

const finite = (value: number | undefined | null): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** 从字幕里按题干文本建「题号 → 题干行」索引；同一题号取第一次出现的行。 */
const readOutIndex = (lines: TranscriptLine[]): Map<number, TranscriptLine> => {
  const index = new Map<number, TranscriptLine>()
  for (const line of lines) {
    const match = READ_OUT.exec(line.text.trim())
    if (!match) continue
    const n = Number(match[1])
    if (!index.has(n)) index.set(n, line)
  }
  return index
}

export type QuestionRangeOptions = {
  /** 部分是材料报头（Conversation 1 / Passage 2 / Recording 3 / Section A），由 extractDialogueAnchors 产出 */
  anchors?: DialogueAnchor[]
  duration?: number
}

/**
 * 单题音频区间 = [该部分材料开始, 本题题干念完]。
 *
 * - 起点取「本题之前最后一个材料报头」：六级听力是先念材料、再连读这一组的题干，
 *   所以只从上一题念完处起播会漏掉答案所在的材料，只从题干起播更是等于让人猜。
 * - 终点取本题题干念完：正好覆盖「要听懂并作答」所需的全部音频。
 * - 题干行按文本 `Q7. / Question 7` 找（stemLineId 实测有系统性偏移，只作兜底）。
 * - 没有报头锚点时退化为上一题念完处；整门课没有字幕时间轴时返回 null。
 */
export const questionAudioRange = (
  questions: ExamQuestion[],
  lines: TranscriptLine[],
  targetN: number,
  options: QuestionRangeOptions = {},
): AudioRange | null => {
  if (lines.length === 0) return null
  const ordered = [...questions].sort((left, right) => left.n - right.n)
  if (!ordered.some((question) => question.n === targetN)) return null

  const lineById = new Map(lines.map((line) => [line.id, line]))
  const readOuts = readOutIndex(lines)
  const stemOf = (question: ExamQuestion | undefined) => {
    const id = question?.stemLineId
    return id ? lineById.get(id) : undefined
  }
  const target = ordered.find((question) => question.n === targetN)!
  const targetLine = readOuts.get(targetN) ?? stemOf(target)
  if (!targetLine || !finite(targetLine.start)) return null

  const anchors = options.anchors ?? []
  let start = 0
  if (anchors.length > 0) {
    for (const anchor of anchors) {
      if (anchor.kind !== 'text' || !PART_BOUNDARY.test(anchor.label)) continue
      if (finite(anchor.start) && anchor.start <= targetLine.start + 0.2) {
        start = Math.max(start, anchor.start)
      }
    }
  } else {
    // 没有报头信息：退化为「上一题念完处」，至少别把上一题的材料算进来
    for (const question of ordered) {
      if (question.n >= targetN) break
      const line = readOuts.get(question.n) ?? stemOf(question)
      if (line && finite(line.end)) start = Math.max(start, line.end)
    }
  }

  let end = targetLine.end
  if (!finite(end)) {
    let nextStart: number | null = null
    for (const question of ordered) {
      if (question.n <= targetN) continue
      const line = readOuts.get(question.n) ?? stemOf(question)
      if (line && finite(line.start)) {
        nextStart = line.start
        break
      }
    }
    end = nextStart ?? (finite(options.duration) ? options.duration : start + 30)
  }

  if (finite(options.duration)) {
    start = Math.min(start, options.duration)
    end = Math.min(end, options.duration)
  }
  start = Math.max(0, start)
  if (!(end > start)) {
    end = start + 30
  }
  return { start, end }
}
