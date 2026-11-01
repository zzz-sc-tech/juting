// 用「原文重合度」判定每门课的音频到底是哪一套：
// 懒笔记的解析页带完整录音文字稿，与课程字幕做 40 字片段重合率比对，比标题可靠。
const fs = require('node:fs')
const path = require('node:path')

const BASE = 'http://127.0.0.1:8100'
const PAPERS = ['2015-06-1', '2015-06-2', '2015-06-3', '2015-12-1', '2015-12-2', '2015-12-3']
const COURSES = [53, 54, 55, 56, 57, 58]
const DIR = path.join(__dirname, 'lazynote')

const fetchText = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

const stripTags = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')

const norm = (text) => text.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim()
const shingles = (text) => {
  const set = new Set()
  const t = norm(text)
  for (let i = 0; i + 40 <= t.length; i += 20) set.add(t.slice(i, i + 40))
  return set
}
const overlap = (a, b) => {
  if (a.size === 0) return 0
  let hit = 0
  for (const gram of a) if (b.has(gram)) hit += 1
  return hit / a.size
}

;(async () => {
  fs.mkdirSync(DIR, { recursive: true })
  const paperText = {}
  for (const paper of PAPERS) {
    const file = path.join(DIR, `${paper}.html`)
    if (!fs.existsSync(file)) {
      const html = await fetchText(`https://english-exam.lazynote.cn/cet6/sections/listening/${paper}/`)
      fs.writeFileSync(file, html)
      console.log('downloaded', paper, (html.length / 1024).toFixed(0) + 'KB')
    }
    paperText[paper] = stripTags(fs.readFileSync(file, 'utf8'))
  }

  const courses = {}
  for (const id of COURSES) {
    const course = await fetch(`${BASE}/api/v1/exercises/${id}`).then((r) => r.json())
    courses[id] = { title: course.title, text: course.lines.map((line) => line.text).join(' ') }
  }

  const paperGrams = {}
  for (const paper of PAPERS) paperGrams[paper] = shingles(paperText[paper])

  console.log('\n课程 → 各套原文重合率（找出真正对应的那一套）')
  for (const id of COURSES) {
    const grams = shingles(courses[id].text)
    const scores = PAPERS.map((paper) => ({ paper, score: overlap(grams, paperGrams[paper]) })).sort(
      (a, b) => b.score - a.score,
    )
    const best = scores[0]
    const second = scores[1]
    console.log(
      `${id} ${courses[id].title} → ${best.paper} ${(best.score * 100).toFixed(1)}%（次高 ${second.paper} ${(second.score * 100).toFixed(1)}%）`,
    )
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
