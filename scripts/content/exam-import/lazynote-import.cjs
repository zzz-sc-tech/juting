// 给 2015 六套补题目与答案：题目/选项取自懒笔记卷面页，答案取自同套解析页的「答案（…）」摘要。
// 前提：已用原文重合度确认课程音频与这几套一一对应（见 match-papers.cjs）。
const fs = require('node:fs')
const path = require('node:path')
const mysql = require('C:/Users/Zsc/Documents/duolinting/node_modules/mysql2/promise')

const BASE = 'http://127.0.0.1:8100'
const APPLY = process.argv.includes('--apply')
const DIR = path.join(__dirname, 'lazynote')
const PLAN = [
  { courseId: 53, paper: '2015-06-1' },
  { courseId: 54, paper: '2015-06-2' },
  { courseId: 55, paper: '2015-06-3' },
  { courseId: 56, paper: '2015-12-1' },
  { courseId: 57, paper: '2015-12-2' },
  { courseId: 58, paper: '2015-12-3' },
]

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
}
const LABEL = /^(?:question|q)\s*\.?\s*(\d{1,2}|[a-z-]+)\b/i
const questionNo = (text) => {
  const m = LABEL.exec(text.trim())
  if (!m) return null
  const raw = m[1].toLowerCase()
  const value = /^\d+$/.test(raw) ? Number(raw) : WORDS[raw]
  return value >= 1 && value <= 25 ? value : null
}

const decode = (text) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** 卷面页：按 id="qp-N" 切块，取 data-pdh-letter 的四个选项 */
const parseQuestions = (html) => {
  const blocks = [...html.matchAll(/id="qp-(\d+)"([\s\S]*?)(?=id="qp-\d+"|$)/g)]
  const byNumber = new Map()
  for (const [, rawNumber, body] of blocks) {
    const n = Number(rawNumber)
    if (n < 1 || n > 25 || byNumber.has(n)) continue
    const options = {}
    for (const [, letter, text] of body.matchAll(/data-pdh-letter="([A-D])">([^<]*)<\/span>/g)) {
      if (!options[letter]) options[letter] = decode(text)
    }
    if (['A', 'B', 'C', 'D'].every((letter) => options[letter])) byNumber.set(n, options)
  }
  return [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([n, options]) => ({ n, options }))
}

/** 解析页 meta：答案（1 C · 2 B · …） */
const parseAnswers = (html) => {
  const meta = /逐题给出答案（([^）]*)）/.exec(html)
  if (!meta) throw new Error('解析页没有答案摘要')
  const answers = {}
  for (const [, n, letter] of meta[1].matchAll(/(\d{1,2})\s*([A-D])/g)) {
    if (Number(n) >= 1 && Number(n) <= 25) answers[n] = letter
  }
  return answers
}

;(async () => {
  const db = await mysql.createConnection({
    host: '127.0.0.1', port: 3307, user: 'duolinting', password: 'duolinting', database: 'duolinting_app_dev',
  })
  const backup = []
  let done = 0

  for (const plan of PLAN) {
    const paperHtml = fs.readFileSync(path.join(DIR, `${plan.paper}.paper.html`), 'utf8')
    const sectionsHtml = fs.readFileSync(path.join(DIR, `${plan.paper}.html`), 'utf8')
    const questions = parseQuestions(paperHtml)
    const answers = parseAnswers(sectionsHtml)
    const detail = await fetch(`${BASE}/api/v1/exercises/${plan.courseId}`).then((r) => r.json())

    const stemIndex = new Map()
    for (const line of detail.lines) {
      const n = questionNo(line.text)
      if (n !== null && !stemIndex.has(n)) stemIndex.set(n, line.id)
    }

    const problems = []
    if (questions.length !== 25) problems.push(`题数 ${questions.length}`)
    if (Object.keys(answers).length !== 25) problems.push(`答案 ${Object.keys(answers).length}`)
    for (const q of questions) {
      for (const letter of ['A', 'B', 'C', 'D']) {
        const text = q.options[letter] ?? ''
        if (!text) problems.push(`Q${q.n}${letter} 空`)
        else if (text.length > 240) problems.push(`Q${q.n}${letter} 超长 ${text.length}`)
      }
      if (!answers[String(q.n)]) problems.push(`Q${q.n} 无答案`)
    }
    const stems = questions.filter((q) => stemIndex.has(q.n)).length
    if (problems.length) {
      console.log(`${plan.courseId} 跳过：`, problems.slice(0, 4).join('；'))
      continue
    }

    const nextQuestions = questions.map((q) => ({
      n: q.n,
      stemLineId: stemIndex.get(q.n) ?? null,
      options: q.options,
    }))
    const [rows] = await db.query('select questions_json, answer_key_json from exercises where id = ?', [plan.courseId])
    backup.push({ id: plan.courseId, before: rows[0] })
    console.log(`${plan.courseId}\t${detail.title}\t题 25\t答案 25\t题干行 ${stems}/25\t答案样例 ${answers['1']}${answers['2']}${answers['3']}`)
    done += 1
    if (APPLY) {
      await db.query('update exercises set questions_json = ?, answer_key_json = ? where id = ?', [
        JSON.stringify(nextQuestions),
        JSON.stringify(answers),
        plan.courseId,
      ])
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(__dirname, `questions-backup-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(backup, null, 1))
  console.log(`\n${APPLY ? '已写入' : '演练'}：${done} 门；旧值备份 ${file}`)
  await db.end()
})().catch((error) => { console.error(error); process.exit(1) })
