// 用「答案文本」反查选项，确认某份答案属于哪套卷：文本能对上，字母才可信
const fs = require('node:fs')
const { parseListening } = require('./parse-cet-paper.cjs')

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const similarity = (a, b) => {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const short = x.length < y.length ? x : y
  const long = x.length < y.length ? y : x
  if (long.startsWith(short) && short.length > 12) return 0.95
  const wordsA = new Set(x.split(' '))
  const wordsB = new Set(y.split(' '))
  let hit = 0
  for (const word of wordsA) if (wordsB.has(word)) hit += 1
  return hit / Math.max(wordsA.size, wordsB.size)
}

const verify = (courseId, answers) => {
  const questions = parseListening(fs.readFileSync(`papers/${courseId}.txt`, 'utf8'))
  const byNumber = new Map(questions.map((q) => [q.n, q]))
  const rows = []
  for (const item of answers) {
    const question = byNumber.get(item.n)
    if (!question) {
      rows.push({ ...item, score: 0, note: '该题未解析出来' })
      continue
    }
    const option = question.options[item.letter]
    rows.push({ ...item, option, score: similarity(item.text, option) })
  }
  const matched = rows.filter((r) => r.score >= 0.6)
  return { rows, matched: matched.length, total: rows.length }
}

module.exports = { verify, similarity }

if (require.main === module) {
  const answers = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const { rows, matched, total } = verify(Number(process.argv[3]), answers)
  for (const row of rows.filter((r) => r.score < 0.6)) {
    console.log(`✗ Q${row.n} ${row.letter} 源: ${row.text} | PDF: ${row.option ?? row.note} (${row.score.toFixed(2)})`)
  }
  console.log(`匹配 ${matched}/${total}`)
}
