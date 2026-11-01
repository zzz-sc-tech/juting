/**
 * 语料体检（只读）：把「能不能练」需要的前提逐项跑一遍。
 *
 * 2026-10-30 用它发现了题干行错位（413/950）、10 门课没有题目、
 * 21 条 stemLineId 指向已删行；修完再跑应为全绿。改完语料请习惯性跑一次。
 *
 * 用法：node scripts/content/audit-corpus.mjs
 */
import { connect } from '../audit/data-contract.mjs'

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
}
const LABEL = /^(?:question|q)\s*\.?\s*(\d{1,2}|[a-z-]+)\b/i
const questionNo = (text) => {
  const match = LABEL.exec(String(text).trim())
  if (!match) return null
  const raw = match[1].toLowerCase()
  const value = /^\d+$/.test(raw) ? Number(raw) : WORDS[raw]
  return value >= 1 && value <= 25 ? value : null
}
const parse = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw)

const conn = await connect()
const [rows] = await conn.query(
  'select id, title, transcript_json, questions_json, answer_key_json from exercises order by id',
)

const sum = {
  courses: rows.length,
  withQuestions: 0,
  qTotal: 0,
  stemOk: 0,
  stemBad: 0,
  stemMissing: 0,
  noAnswer: 0,
  badLetter: 0,
  emptyOption: 0,
  dupOption: 0,
  shortLine: 0,
  overlapLine: 0,
  notContiguous: [],
  noQuestions: [],
}
const offenders = []

for (const row of rows) {
  const lines = parse(row.transcript_json) ?? []
  const questions = parse(row.questions_json) ?? []
  const answers = parse(row.answer_key_json) ?? {}

  if (questions.length === 0) {
    sum.noQuestions.push(`${row.id} ${row.title}`)
  } else {
    sum.withQuestions += 1
  }
  if (questions.length > 0 && questions.length !== 25) {
    sum.notContiguous.push(`${row.id} ${row.title}：${questions.length} 题`)
  }

  const lineById = new Map(lines.map((line) => [line.id, line]))
  const readOut = new Map()
  for (const line of lines) {
    const n = questionNo(line.text)
    if (n !== null && !readOut.has(n)) readOut.set(n, line)
  }

  let bad = 0
  const numbers = new Set(questions.map((q) => Number(q.n)))
  for (const question of questions) {
    sum.qTotal += 1
    const inline = lineById.get(question.stemLineId)
    if (!inline) sum.stemMissing += 1
    else if (questionNo(inline.text) === Number(question.n)) sum.stemOk += 1
    else {
      sum.stemBad += 1
      bad += 1
    }
    const answer = answers[String(question.n)]
    if (!answer) sum.noAnswer += 1
    else if (!['A', 'B', 'C', 'D'].includes(answer)) sum.badLetter += 1
    const options = question.options ?? {}
    const values = ['A', 'B', 'C', 'D'].map((letter) => String(options[letter] ?? '').trim())
    if (values.some((value) => value.length === 0)) sum.emptyOption += 1
    if (new Set(values).size < 4) sum.dupOption += 1
  }
  for (const key of Object.keys(answers)) {
    if (!numbers.has(Number(key))) sum.badLetter += 0 // 钥匙多余题号：仅记录，不单独计数
  }
  if (bad > 0) offenders.push(`${row.id} ${row.title}：${bad}/${questions.length} 条题干指错`)

  let previousEnd = -1
  for (const line of lines) {
    if (line.end - line.start < 0.4) sum.shortLine += 1
    if (previousEnd >= 0 && line.start < previousEnd - 0.05) sum.overlapLine += 1
    previousEnd = Math.max(previousEnd, Number(line.end))
  }
}

const pct = (value, total) => `${((value / Math.max(1, total)) * 100).toFixed(1)}%`
console.log(`课程 ${sum.courses} 门｜有题目 ${sum.withQuestions} 门｜题干 ${sum.qTotal} 条`)
console.log(
  `题干定位：正确 ${sum.stemOk}（${pct(sum.stemOk, sum.qTotal)}）｜指错 ${sum.stemBad}｜缺行 ${sum.stemMissing}`,
)
console.log(`答案：缺答案 ${sum.noAnswer}｜非法字母 ${sum.badLetter}`)
console.log(`选项：空选项 ${sum.emptyOption}｜重复选项 ${sum.dupOption}`)
console.log(`字幕：过短(<0.4s) ${sum.shortLine}｜时间重叠 ${sum.overlapLine}`)
if (sum.noQuestions.length) {
  console.log(`\n没有题目的课（${sum.noQuestions.length}）：`)
  for (const item of sum.noQuestions) console.log(`  ${item}`)
}
if (sum.notContiguous.length) {
  console.log(`\n题数不是 25 的课（${sum.notContiguous.length}）：`)
  for (const item of sum.notContiguous) console.log(`  ${item}`)
}
if (offenders.length) {
  console.log(`\n题干指错的课（${offenders.length}）：`)
  for (const item of offenders) console.log(`  ${item}`)
}
await conn.end()
