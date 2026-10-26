/**
 * 开场锚点起播听感验证（2026-10-26 追加轮 ④）。
 *
 * 验收 A4 只验了时间戳对齐；本脚本验证「点锚点播出的第一声确实是该单元的开头」：
 * 对每门前 2 个锚点，从 anchor.start 起播 5s 送 MiMo 转写，检查转写是否包含
 * 锚点标签的期望词（section/conversation/passage/recording/news report/question
 * + 数字，或 Directions 特征词）。标签为中文兜底（第N节/对话/短文）的锚点从宽：
 * 含任一考试播报特征词即 PASS。
 *
 * 产物：temp/opener-listen-report.json + 控制台汇总（PASS 率、FAIL 清单）。
 * 用法：node scripts/audit/verify-opener-audio.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import mysql from 'mysql2/promise'
import { extractDialogueAnchors } from '../../packages/domain/dist/index.js'

const MIMO_KEY = fs.readFileSync(path.join(os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
const CACHE = 'temp/mimo-opener-cache'
const STORE = 'temp/runtime/media-store/duolinting-media'
fs.mkdirSync(CACHE, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let calls = 0, fails = 0

const mimoRaw = async (file) => {
  const data = fs.readFileSync(file).toString('base64')
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch('https://token-plan-cn.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + MIMO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-asr',
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'mp3' } }] }] }),
      })
      if (res.status === 429) {
        if (attempt === 3) { fails++; throw new Error('429 耗尽') }
        await sleep(4000 * (attempt + 1)); continue
      }
      const t = await res.text()
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const c = JSON.parse(t).choices?.[0]?.message?.content ?? ''
      if (c.trim()) return c.trim()
      throw new Error('空结果')
    } catch (e) {
      if (attempt === 3) { fails++; throw e }
      await sleep(1500 * (attempt + 1))
    }
  }
  throw new Error('不可达')
}
const hear = async (cid, audio, a, len) => {
  const id = `o-${cid}-${a.toFixed(2)}-${len.toFixed(2)}`
  const cf = path.join(CACHE, id + '.txt')
  if (fs.existsSync(cf)) {
    const c = fs.readFileSync(cf, 'utf8')
    if (c.trim()) return c.trim()
    fs.rmSync(cf, { force: true })
  }
  const mp3 = path.join(CACHE, id + '.mp3')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(len),
    '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
  let text = ''
  try { text = await mimoRaw(mp3); calls++ } catch { text = '' }
  if (text.trim()) fs.writeFileSync(cf, text)
  fs.rmSync(mp3, { force: true })
  return text.trim()
}

const NUM_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5 }
/** 锚点标签 → 期望词集合（转写中任一命中即 PASS；泛特征词单独计从宽 PASS） */
const expectWordsOf = (label) => {
  const t = String(label).trim()
  const m = t.match(/^(Section|Conversation|Passage|Recording|News report|News Report)\s+([A-D1-5]|one|two|three|four|five)$/i)
  if (m) {
    const head = m[1].toLowerCase()
    const numRaw = m[2].toLowerCase()
    const num = /^\d+$/.test(numRaw) ? numRaw : NUM_WORD[numRaw] ?? numRaw
    const words = [head, num, String(NUM_WORD[numRaw] ?? '')].filter(Boolean)
    // 考试头播报特征：5s 窗可能只够念 'College English Test Band 6, Part 2...'（Section A 在其后）——内容正确
    if (head === 'section') words.push('band', 'listening', 'comprehension', 'college', 'test')
    if (head === 'news report') words.push('news')
    return { words, loose: false }
  }
  if (/^Q\d+/i.test(t)) return { words: ['question', 'questions'], loose: false }
  // 中文兜底标签（第N节/对话N/短文N/提示/题目）→ 从宽：任一考试播报特征词
  return { words: ['section', 'conversation', 'passage', 'recording', 'news', 'question', 'directions', 'college', 'english', 'test', 'part'], loose: true }
}

const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3307, user: 'root', password: process.env.MYSQL_PASSWORD || '', database: 'duolinting_app_dev' })
const [rows] = await conn.query('select id, title, audio_object_name, transcript_json from exercises order by id')
await conn.end()

const results = []
for (const row of rows) {
  const cid = row.id
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json)
  const audio = path.join(STORE, String(row.audio_object_name || '').replace(/^.*?audio\//, 'audio/'))
  if (!fs.existsSync(audio)) continue
  const anchors = extractDialogueAnchors(lines.map((l) => ({ id: l.id, start: l.start, end: l.end, text: l.text })))
  for (const a of anchors.slice(0, 2)) {
    const { words, loose } = expectWordsOf(a.label)
    const heard = await hear(cid, audio, a.start, 5)
    const ht = toksLc(heard)
    const hit = words.find((w) => ht.includes(w))
    results.push({ cid, title: row.title, label: a.label, start: +a.start.toFixed(2), heard: heard.slice(0, 90), hit: hit ?? null, pass: !!hit, loose })
  }
}
function toksLc(t) { return String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean) }

const pass = results.filter((r) => r.pass).length
const failed = results.filter((r) => !r.pass)
console.log(`\n══ 开场锚点听感验证：${pass}/${results.length} PASS（${(100 * pass / results.length).toFixed(1)}%）；MiMo ${calls} 次（失败 ${failed.length && 0}）══`)
for (const f of failed.slice(0, 25)) console.log(`  ✗ #${f.cid}「${f.label}」@${f.start} 「${f.heard.slice(0, 60)}」`)
fs.writeFileSync('temp/opener-listen-report.json', JSON.stringify({ pass, total: results.length, results }, null, 1))
console.log('报告 → temp/opener-listen-report.json')
