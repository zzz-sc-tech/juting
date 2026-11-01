// 给 2016 四套补题目与答案：题干选项来自试卷 PDF，答案来自公开题库（已按选项文本逐题对齐）
// 默认演练；加 --apply 写库。旧值（null）备份到 questions-backup-*.json。
const fs = require('node:fs')
const path = require('node:path')
const mysql = require('C:/Users/Zsc/Documents/duolinting/node_modules/mysql2/promise')
const { parseListening } = require('./parse-cet-paper.cjs')

const BASE = 'http://127.0.0.1:8100'
const APPLY = process.argv.includes('--apply')
const PLAN = [
  { courseId: 59, year: '2016', month: '06', set: '01' },
  { courseId: 60, year: '2016', month: '06', set: '02' },
  { courseId: 61, year: '2016', month: '12', set: '01' },
  { courseId: 62, year: '2016', month: '12', set: '02' },
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

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const sameOption = (a, b) => {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x === y || x.startsWith(y.slice(0, 24)) || y.startsWith(x.slice(0, 24))
}

;(async () => {
  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'cet6-all.json'), 'utf8'))
  const db = await mysql.createConnection({
    host: '127.0.0.1', port: 3307, user: 'duolinting', password: 'duolinting', database: 'duolinting_app_dev',
  })
  const backup = []
  let ok = 0

  for (const plan of PLAN) {
    const questions = parseListening(fs.readFileSync(path.join(__dirname, 'papers', `${plan.courseId}.txt`), 'utf8'))
    const paper = dataset.papers.find(
      (p) => p.year === plan.year && p.month === plan.month && p.set === plan.set,
    )
    if (!paper) { console.log(plan.courseId, '数据集缺此卷'); continue }
    const answers = {}
    for (const [key, value] of Object.entries(paper.answers || {})) {
      if (Number(key) >= 1 && Number(key) <= 25) answers[key] = String(value).toUpperCase()
    }

    const detail = await fetch(`${BASE}/api/v1/exercises/${plan.courseId}`).then((r) => r.json())
    const stemIndex = new Map()
    for (const line of detail.lines) {
      const n = questionNo(line.text)
      if (n !== null && !stemIndex.has(n)) stemIndex.set(n, line.id)
    }

    // 校验 1：题目/答案齐全，选项长度不超后端 240 字上限
    const problems = []
    if (questions.length !== 25) problems.push(`题数 ${questions.length}`)
    if (Object.keys(answers).length !== 25) problems.push(`答案 ${Object.keys(answers).length}`)
    for (const q of questions) {
      for (const letter of ['A', 'B', 'C', 'D']) {
        const text = q.options[letter] ?? ''
        if (!text) problems.push(`Q${q.n}${letter} 空`)
        if (text.length > 240) problems.push(`Q${q.n}${letter} 超长 ${text.length}`)
      }
      if (!answers[String(q.n)]) problems.push(`Q${q.n} 无答案`)
    }

    // 校验 2：数据集里的题与 PDF 选项必须对得上（同一套卷才允许合并）
    let compared = 0
    let matched = 0
    for (const q of paper.questions || []) {
      const mine = questions.find((item) => item.n === q.number)
      if (!mine) continue
      compared += 1
      if (['A', 'B', 'C', 'D'].every((letter) => sameOption(q.options?.[letter], mine.options[letter]))) matched += 1
    }
    const stemHits = questions.filter((q) => stemIndex.has(q.n)).length

    if (problems.length || compared === 0 || matched / compared < 0.8) {
      console.log(`${plan.courseId} 跳过：`, problems.slice(0, 4).join('；'), `| 选项对齐 ${matched}/${compared}`)
      continue
    }

    const nextQuestions = questions.map((q) => ({
      n: q.n,
      stemLineId: stemIndex.get(q.n) ?? null,
      options: q.options,
    }))
    const [rows] = await db.query('select questions_json, answer_key_json from exercises where id = ?', [plan.courseId])
    backup.push({ id: plan.courseId, before: rows[0] })
    console.log(
      `${plan.courseId}\t${detail.title}\t题 ${nextQuestions.length}\t答案 ${Object.keys(answers).length}\t题干行 ${stemHits}/25\t选项对齐 ${matched}/${compared}`,
    )
    ok += 1
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
  console.log(`\n${APPLY ? '已写入' : '演练'}：${ok} 门；旧值备份 ${file}`)
  await db.end()
})().catch((error) => { console.error(error); process.exit(1) })
