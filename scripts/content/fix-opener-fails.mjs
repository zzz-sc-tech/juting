/**
 * 听感验证 FAIL 修复（2026-10-27，追加轮②③）：老课播报缺行/错位 + 题干错位。
 * 每条修复都是听证证实（temp/mimo-frag-cache/x2-*）的硬编码清单——量小，通用化不值。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const MIMO_KEY = fs.readFileSync(path.join(os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
const CACHE = 'temp/mimo-frag-cache'
const STORE = 'temp/runtime/media-store/duolinting-media'
const APPLY = process.argv.includes('--apply')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mimoRaw = async (file) => {
  const data = fs.readFileSync(file).toString('base64')
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch('https://token-plan-cn.xiaomimimo.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + MIMO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-asr', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'mp3' } }] }] }) })
      if (res.status === 429) { if (attempt === 3) throw new Error('429'); await sleep(4000); continue }
      const c = JSON.parse(await res.text()).choices?.[0]?.message?.content ?? ''
      if (c.trim()) return c.trim()
      throw new Error('空结果')
    } catch (e) { if (attempt === 3) throw e; await sleep(1500) }
  }
}
const hear = async (cid, audio, a, b) => {
  const id = `x3-${cid}-${a.toFixed(2)}-${b.toFixed(2)}`
  const cf = path.join(CACHE, id + '.txt')
  if (fs.existsSync(cf)) { const c = fs.readFileSync(cf, 'utf8'); if (c.trim()) return c.trim(); fs.rmSync(cf, { force: true }) }
  const mp3 = path.join(CACHE, id + '.mp3')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(b - a), '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
  let text = ''
  try { text = await mimoRaw(mp3) } catch { text = '' }
  if (text.trim()) fs.writeFileSync(cf, text)
  fs.rmSync(mp3, { force: true })
  return text.trim()
}

// 修复清单：{cid, moves:[[lineId, newStart]], retext:[[lineId, newText]], inserts:[{start,end,text}], extend:[[lineId, newEnd]]}
const FIXES = [
  { cid: 42, moves: [['l3', 35.3]] },
  { cid: 46, moves: [['l2', 14.1]], inserts: [{ start: 14.1, end: 19.4, text: 'College English Test Band 6, Part 2: Listening Comprehension.' }] },
  { cid: 55, moves: [['l3', 42.4]] },
  { cid: 57, moves: [['l4', 39.8]], extend: [['l1', 32.8], ['l2', 38.7]] },
  { cid: 59, retext: [['l6', 'Question 1.']], inserts: [{ start: 25.6, end: 33.4, text: 'After you hear a question, you must choose the best answer from the four choices marked A, B, C and D.' }] },
  { cid: 61, moves: [['l4', 42.9]], extend: [['l3', 40.5]] },
]

const conn = await connect()
const [rows] = await conn.query('select id, category_id, audio_object_name, transcript_json from exercises where id in (42,46,55,57,59,61)')
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const todayPrefix = `${today}.`
const nextVersionOf = new Map()
let ok = 0, failed = 0

for (const row of rows) {
  const fix = FIXES.find((f) => f.cid === row.id)
  if (!fix) continue
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const log = []
  for (const [lid, ns] of fix.moves ?? []) {
    const l = lines.find((x) => x.id === lid)
    if (!l) { console.error(`✗ #${row.id} ${lid} 不存在`); continue }
    log.push(`${lid} ${l.start.toFixed(1)}→${ns}`)
    l.start = ns
  }
  for (const [lid, text] of fix.retext ?? []) {
    const l = lines.find((x) => x.id === lid)
    if (!l) continue
    log.push(`${lid} 文本→「${text}」`)
    l.text = text
  }
  for (const [lid, ne] of fix.extend ?? []) {
    const l = lines.find((x) => x.id === lid)
    if (!l) continue
    log.push(`${lid} end ${l.end.toFixed(1)}→${ne}`)
    l.end = ne
  }
  for (const ins of fix.inserts ?? []) {
    const idx = lines.findIndex((l) => l.start > ins.start)
    lines.splice(idx < 0 ? lines.length : idx, 0, { id: 'new', start: ins.start, end: ins.end, text: ins.text })
    log.push(`插入 @${ins.start}「${ins.text.slice(0, 36)}…」`)
  }
  lines.sort((a, b) => a.start - b.start)
  lines.forEach((l, i) => { l.id = `l${i + 1}` })
  // 单调收敛
  const needOf = (l) => Math.min(Math.max((String(l.text).match(/[A-Za-z0-9']+/g) || []).filter((w) => w.length >= 2).length * 0.28, 0.3), 20)
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], l = lines[i]
    if (l.start < p.end - 0.001) {
      if (l.start - p.start >= Math.max(0.18, needOf(p) * 0.35 + 0.2)) p.end = +l.start.toFixed(2)
      else l.start = +p.end.toFixed(2)
    }
    if (l.end <= l.start) l.end = +(l.start + 0.3).toFixed(2)
  }
  console.log(`#${row.id}: ${log.join('；')}`)
  if (!APPLY) continue
  const seedPath = seedOf(row.category_id)
  if (!nextVersionOf.has(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
    nextVersionOf.set(seedPath, seed.version.startsWith(todayPrefix)
      ? `${todayPrefix}${Number(seed.version.slice(todayPrefix.length)) + 1}` : `${todayPrefix}1`)
  }
  const delta = (fix.inserts?.length ?? 0)
  try {
    await saveTranscript({ conn, cid: row.id, lines, version: nextVersionOf.get(seedPath), seedPath,
      expect: { lineDelta: [0, delta], allowUntranslatedGrow: true, note: `听感 FAIL 修复：${log.length} 处` }, dryRun: false })
    ok++
  } catch (e) { failed++; console.error(`✗ #${row.id} ${e.message}`) }
}
console.log(`\n══ 落库 ${ok} / 失败 ${failed} ══`)
await conn.end()
