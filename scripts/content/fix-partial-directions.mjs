/**
 * 修复补行时长违例：行文本=完整 Directions 模板但语音窗只够念前缀。
 * 修法「转写定范围、模板给文本」：听证行区间 → 转写 → 与模板 token 求 LCP →
 * 文本=模板原文前 lcp 词（补句号）。词数随语音走，时长门禁自然合规。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const MIMO_KEY = fs.readFileSync(path.join(os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
const CACHE = 'temp/mimo-frag-cache'
const STORE = 'temp/runtime/media-store/duolinting-media'
const toks = (t) => String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
const needOf = (t) => Math.min(Math.max(toks(t).filter((w) => w.length >= 2).length * 0.28, 0.3), 20)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mimoRaw = async (file) => {
  const data = fs.readFileSync(file).toString('base64')
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch('https://token-plan-cn.xiaomimimo.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + MIMO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-asr', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'mp3' } }] }] }) })
      if (res.status === 429) { if (attempt === 3) throw new Error('429'); await sleep(4000); continue }
      const j = JSON.parse(await res.text())
      const c = j.choices?.[0]?.message?.content ?? ''
      if (c.trim()) return c.trim()
      throw new Error('空结果')
    } catch (e) { if (attempt === 3) throw e; await sleep(1500) }
  }
}
const hearLine = async (cid, audio, l) => {
  const id = `p-${cid}-${l.start.toFixed(2)}-${l.end.toFixed(2)}`
  const cf = path.join(CACHE, id + '.txt')
  if (fs.existsSync(cf)) { const c = fs.readFileSync(cf, 'utf8'); if (c.trim()) return c.trim(); fs.rmSync(cf, { force: true }) }
  const mp3 = path.join(CACHE, id + '.mp3')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(l.start), '-t', String(l.end - l.start), '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
  let text = ''
  try { text = await mimoRaw(mp3) } catch { text = '' }
  if (text.trim()) fs.writeFileSync(cf, text)
  fs.rmSync(mp3, { force: true })
  return text.trim()
}

const conn = await connect()
const [rows] = await conn.query('select id, category_id, audio_object_name, transcript_json from exercises order by id')
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const todayPrefix = `${today}.`
const nextVersionOf = new Map()
let fixed = 0, examined = 0

for (const row of rows) {
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const audio = path.join(STORE, String(row.audio_object_name || '').replace(/^.*?audio\//, 'audio/'))
  if (!fs.existsSync(audio)) continue
  const suspects = lines.filter((l) => {
    const dur = l.end - l.start
    return /In this section|College English Test|Then mark the corresponding/.test(String(l.text)) && dur < needOf(l.text) * 0.8
  })
  if (!suspects.length) continue
  let changed = false
  for (const l of suspects) {
    examined++
    const heard = await hearLine(row.id, audio, l)
    if (!heard) continue
    // 找最相近模板（token 重叠）
    const ht = toks(heard)
    const TPLS = [
      'In this section, you will hear two long conversations. At the end of each conversation, you will hear four questions. Both the conversation and the questions will be spoken only once. After you hear a question, you must choose the best answer from the four choices marked A, B, C and D. Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.',
      'In this section, you will hear two passages. At the end of each passage, you will hear three or four questions. Both the passage and the questions will be spoken only once. After you hear a question, you must choose the best answer from the four choices marked A, B, C and D. Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.',
      'In this section, you will hear three news reports. At the end of each news report, you will hear two or three questions. Both the news report and the questions will be spoken only once. After you hear a question, you must choose the best answer from the four choices marked A, B, C and D. Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.',
      'In this section, you will hear three recordings of lectures or talks followed by three or four questions. The recordings will be played only once. After you hear a question, you must choose the best answer from the four choices marked A, B, C and D. Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.',
      'Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.',
    ]
    let best = null
    for (const tpl of TPLS) {
      const tt = toks(tpl)
      const hit = ht.filter((w) => tt.includes(w)).length / Math.max(ht.length, 1)
      if (!best || hit > best.hit) best = { tpl, hit }
    }
    if (!best || best.hit < 0.6) continue
    // LCP：模板 token 序列与转写 token 序列的近似最长公共前缀（逐位容忍 1 词跳过）
    const tt = toks(best.tpl)
    let i = 0, j = 0, skips = 0
    while (i < ht.length && j < tt.length) {
      if (ht[i] === tt[j]) { i++; j++; skips = 0; continue }
      if (skips === 0 && i + 1 < ht.length && ht[i + 1] === tt[j]) { i++; skips++; continue }
      if (skips === 0 && j + 1 < tt.length && ht[i] === tt[j + 1]) { j++; skips++; continue }
      break
    }
    if (j < Math.min(tt.length, 4)) {
      // 中段转写（如 "The recordings will be played only once." 是 dir-C 模板第 2 句）：
      // LCP 从头比必败。转写词几乎全在模板词表（hit≥0.7）→ 直接采用转写文本
      // （首字母大写+句号；hit 已保证无 ASR 乱码）。
      if (best.hit >= 0.7 && ht.length >= 4) {
        let text = heard.trim()
        text = text.charAt(0).toUpperCase() + text.slice(1)
        if (!/[.。!?]$/.test(text)) text += '.'
        if (text !== l.text) {
          console.log()
          l.text = text
          changed = true
          fixed++
        }
      }
      continue
    }
    // 文本=模板原文前 j 个词（按原文词序截取，保留标点，补句号）
    const words = best.tpl.split(/\s+/)
    let text = words.slice(0, j).join(' ').replace(/[,;]$/, '')
    if (!/[.。!?]$/.test(text)) text += '.'
    if (text !== l.text) {
      console.log(`#${row.id} ${l.id}「${l.text.slice(0, 40)}…」(${(l.end - l.start).toFixed(1)}s) → 「${text.slice(0, 50)}…」(${j} 词)`)
      l.text = text
      changed = true
      fixed++
    }
  }
  if (!changed) continue
  const seedPath = seedOf(row.category_id)
  if (!nextVersionOf.has(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
    nextVersionOf.set(seedPath, seed.version.startsWith(todayPrefix)
      ? `${todayPrefix}${Number(seed.version.slice(todayPrefix.length)) + 1}` : `${todayPrefix}1`)
  }
  await saveTranscript({ conn, cid: row.id, lines, version: nextVersionOf.get(seedPath), seedPath,
    expect: { lineDelta: [0, 0], allowUntranslatedGrow: true, note: '补行文本按语音窗裁剪（转写定范围、模板给文本）' }, dryRun: false })
}
console.log(`\n══ 检查 ${examined} 行，裁剪 ${fixed} 行 ══`)
await conn.end()
