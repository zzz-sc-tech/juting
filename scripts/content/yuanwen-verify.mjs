// 独立质检：把新版合成出的报头锚点行时间，与 ASR 缓存里报头的真实时间交叉比对，
// 排查「整体错位一个 section」这类系统性偏移（命中率高也可能错位）。
import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { parseYuanwenMd, buildAsrWordTimeline, synthesizeTranscript } from './yuanwen-lib.mjs'

let envPwd = process.env.MYSQL_PASSWORD
for (const line of fs.readFileSync('backend/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*MYSQL_PASSWORD\s*=\s*(.*)\s*$/)
  if (m) envPwd = m[1].replace(/^["']|["']$/g, '')
}
const conn = await mysql.createConnection({
  host: '127.0.0.1', port: 3307, database: 'duolinting_app_dev', user: 'duolinting', password: envPwd,
})
const [rows] = await conn.query('SELECT id, title, audio_object_name FROM exercises ORDER BY sort_order')
const [jobs] = await conn.query('SELECT object_name, result_json FROM media_asr_jobs WHERE status="succeeded" ORDER BY id DESC')
const jobByObj = new Map()
for (const j of jobs) if (!jobByObj.has(j.object_name)) jobByObj.set(j.object_name, j)

const mdIndex = new Map()
const examKeyFrom = (s) => {
  const y = s.match(/(\d{4})/)?.[1]
  const mo = s.match(/[年.](\d{1,2})月/)?.[1]?.padStart(2, '0')
  const st = s.match(/第(\d+)套/)?.[1] ?? '1'
  return y && mo ? `${y}-${mo}:${st}` : null
}
;(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { scan(full); continue }
    if (!e.name.endsWith('.md') || e.name.startsWith('00-')) continue
    const k = examKeyFrom(e.name)
    if (k) mdIndex.set(k, full)
  }
})('./原文（改成你的听力原文目录，或用 YUANWEN_DIR 环境变量）')

// 报头在 ASR 里的常见转写形态（(?!\d) 防止 "Conversation 10" 被误配成 "Conversation 1"）
const HEAD_PATTERNS = [
  [/^CONVERSATION\s+(\d)/i, /conversation\s+(one|two|1|2)(?!\d)/i, 'Conversation'],
  [/^PASSAGE\s+(\d)/i, /passage\s+(one|two|three|1|2|3)(?!\d)/i, 'Passage'],
  [/^RECORDING\s+(\d)/i, /recording\s+(one|two|three|1|2|3)(?!\d)/i, 'Recording'],
]

let checked = 0, offsets = []
console.log('id | 课程 | 锚点行 | 合成时间 | ASR实际报头时间 | 偏差')
console.log('-'.repeat(96))
for (const r of rows) {
  const mdPath = mdIndex.get(examKeyFrom(r.title))
  const job = jobByObj.get(r.audio_object_name)
  if (!mdPath || !job) continue
  const segs = JSON.parse(job.result_json)
  const { lines } = synthesizeTranscript(parseYuanwenMd(fs.readFileSync(mdPath, 'utf8')), buildAsrWordTimeline(segs))

  // 在 ASR 原始分段里找每个报头的真实起止时间
  const asrOccur = []
  for (const seg of segs) {
    for (const [, re, kind] of HEAD_PATTERNS) {
      const m = seg.text.match(re)
      if (m) asrOccur.push({ kind, idx: parseInt(m[1], 10), t: seg.start, text: seg.text.slice(0, 46) })
    }
  }
  let shown = 0
  for (const l of lines) {
    if (!l.isSectionHead) continue
    for (const [mdRe, , kind] of HEAD_PATTERNS) {
      const m = l.text.match(mdRe)
      if (!m) continue
      const idx = parseInt(m[1], 10)
      // 取同 kind 同序号的 ASR 报头作为参照
      const ref = asrOccur.find((o) => o.kind === kind && o.idx === idx)
      if (!ref) continue
      const off = l.start - ref.t
      offsets.push({ id: r.id, kind, idx, off })
      if (shown < 3) {
        console.log(`${String(r.id).padStart(3)} | ${r.title.padEnd(18)} | ${l.text.padEnd(14)} | ${l.start.toFixed(0).padStart(6)}s | ${ref.t.toFixed(0).padStart(6)}s  ${ref.text} | ${off >= 0 ? '+' : ''}${off.toFixed(0)}s`)
      }
      shown++
      checked++
    }
  }
}
const abs = offsets.map((o) => Math.abs(o.off)).sort((a, b) => a - b)
console.log('-'.repeat(96))
console.log(`共核对 ${checked} 个报头锚点。偏差绝对值：中位 ${abs[Math.floor(abs.length / 2)].toFixed(1)}s，` +
  `P90 ${abs[Math.floor(abs.length * 0.9)].toFixed(1)}s，最大 ${abs[abs.length - 1].toFixed(1)}s`)
const bad = offsets.filter((o) => Math.abs(o.off) > 25)
console.log(`偏差 >25s 的锚点：${bad.length} 个` + (bad.length ? ' → ' + bad.slice(0, 10).map((o) => `#${o.id} ${o.kind}${o.idx} ${o.off.toFixed(0)}s`).join(', ') : ''))
await conn.end()
