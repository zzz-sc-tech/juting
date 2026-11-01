/**
 * 题干行重建（2026-10-30 执行过一次，可重复跑，幂等）。
 *
 * 背景：questions_json[].stemLineId 是早期按「题目顺序」写进去的，
 * 与字幕实际题干行对不上——全量审计 950 题里 413 条指错（239 指到别的题、
 * 153 指到材料/报头、21 条指向已重排删掉的行）。结果就是实战「正在读题」高亮歪、
 * 「去句听」落到别的句子。
 *
 * 做法：按字幕文本找 `Q7.` / `Question 7.` / `Question five.` 三种写法，
 * 取第一次出现的那一行作为题干行；找不到的保持原值（当前语料 0 条）。
 * 只改 stemLineId，不动 options。
 *
 * 用法：
 *   node scripts/content/rebuild-question-stems.mjs          # 演练，只打印会改什么
 *   node scripts/content/rebuild-question-stems.mjs --apply  # 写库（先自动备份旧值）
 */
import fs from 'node:fs'
import path from 'node:path'
import { connect } from '../audit/data-contract.mjs'

const APPLY = process.argv.includes('--apply')

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
}
// 「question」必须排在「q」前：否则 "Question 1." 会先匹配 q、把 "uestion" 当题号
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
  'select id, title, transcript_json, questions_json from exercises order by id',
)

const backup = []
let changedCourses = 0
let changedQuestions = 0
let unresolved = 0

for (const row of rows) {
  const questions = parse(row.questions_json)
  if (!Array.isArray(questions) || questions.length === 0) continue
  const lines = parse(row.transcript_json) ?? []
  const index = new Map()
  for (const line of lines) {
    const n = questionNo(line.text)
    if (n !== null && !index.has(n)) index.set(n, line.id)
  }

  let touched = 0
  const next = questions.map((question) => {
    const lineId = index.get(Number(question.n))
    if (!lineId) {
      unresolved += 1
      return question
    }
    if (lineId === question.stemLineId) return question
    touched += 1
    return { ...question, stemLineId: lineId }
  })
  if (touched === 0) continue

  backup.push({ id: row.id, title: row.title, questions })
  console.log(`${row.id}\t${row.title}\t改 ${touched}/${questions.length}`)
  changedCourses += 1
  changedQuestions += touched
  if (APPLY) {
    await conn.query('update exercises set questions_json = ? where id = ?', [
      JSON.stringify(next),
      row.id,
    ])
  }
}

if (APPLY && backup.length > 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join('temp', `questions-backup-${stamp}.json`)
  fs.mkdirSync('temp', { recursive: true })
  fs.writeFileSync(file, JSON.stringify(backup, null, 1))
  console.log(`旧值备份：${file}`)
}
console.log(
  `\n${APPLY ? '已写入' : '演练'}：${changedCourses} 门课 / ${changedQuestions} 条题干；无文本可匹配 ${unresolved} 条`,
)
await conn.end()
