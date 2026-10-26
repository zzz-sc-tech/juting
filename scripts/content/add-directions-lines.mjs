/**
 * 六级 2015/2016 十套：指令性无行语音段补行（2026-10-26 追加轮 ②）。
 *
 * 背景（11.4 遗留）：whisper 对开场报头/Directions 整段漏转写，音频有语音、库里无行
 * ——点锚点先听到静音、锚点组结构残缺（Section B 首句是 Directions 中段）。
 *
 * 文本来源（事实源仲裁）：标准 CET 考试 Directions 模板 > MiMo 转写。
 *   MiMo 逐段转写用来「对号入座」（选出匹配的模板）；入库文本用模板原文，
 *   转写与模板 token 重叠 ≥0.55 才补（防 ASR 乱码进库）。
 *   匹配不上的段不补，记录到输出（可能是非指令内容，留人工判断）。
 *
 * 范围：与锚点组相邻（锚点起点前 3s 内开始）或课程开头 45s 内的 ≥2.5s 无行岛。
 * 题间小标签段与正文长段不在此轮范围（收益低/需逐段人工判断）。
 *
 * 用法：node scripts/content/add-directions-lines.mjs --dry|--apply
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect, saveTranscript } from '../audit/data-contract.mjs'
import { extractDialogueAnchors } from '../../packages/domain/dist/index.js'

const APPLY = process.argv.includes('--apply')
const MIMO_KEY = fs.readFileSync(path.join(process.env.USERPROFILE ?? os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
import os from 'node:os'
const CACHE = 'temp/mimo-frag-cache'
const ISLAND_DIR = 'temp/anchor-islands'
const STORE = 'temp/runtime/media-store/duolinting-media'

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
const hearIsland = async (cid, audio, a, b) => {
  const id = `d-${cid}-${a.toFixed(2)}-${b.toFixed(2)}`
  const cf = path.join(CACHE, id + '.txt')
  if (fs.existsSync(cf)) {
    const c = fs.readFileSync(cf, 'utf8')
    if (c.trim()) return c.trim()
    fs.rmSync(cf, { force: true })
  }
  const mp3 = path.join(CACHE, id + '.mp3')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(b - a),
    '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
  let text = ''
  try { text = await mimoRaw(mp3); calls++ } catch { text = '' }
  if (text.trim()) fs.writeFileSync(cf, text)
  fs.rmSync(mp3, { force: true })
  return text.trim()
}

// ── 标准 CET-6 Directions 模板（音频念的就是这些，属考试固定文本） ──
const TEMPLATES = [
  { key: 'open-A', text: 'College English Test Band 6, Part 2, Listening Comprehension, Section A: Directions.' },
  { key: 'open-BC', text: 'College English Test Band 6, Part 3, Listening Comprehension, Section C: Directions.' },
  { key: 'dir-A-2conv', text: 'In this section, you will hear two long conversations. At the end of each conversation, you will hear four questions. Both the conversation and the questions will be spoken only once. After you hear a question, you must choose the best answer from the four choices marked A, B, C and D. Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.' },
  { key: 'dir-A-2pass', text: 'In this section, you will hear two passages. At the end of each passage, you will hear three or four questions. Both the passage and the questions will be spoken only once. After you hear a question, you must choose the best answer from the four choices marked A, B, C and D. Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.' },
  { key: 'dir-A-3news', text: 'In this section, you will hear three news reports. At the end of each news report, you will hear two or three questions. Both the news report and the questions will be spoken only once. After you hear a question, you must choose the best answer from the four choices marked A, B, C and D. Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.' },
  { key: 'dir-B-2pass', text: 'In this section, you will hear two passages. At the end of each passage, you will hear three or four questions. Both the passage and the questions will be read to you only once. After you hear a question, you must choose the best answer from the four choices marked A, B, C and D. Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.' },
  { key: 'dir-C-3rec', text: 'In this section, you will hear three recordings of lectures or talks followed by three or four questions. The recordings will be played only once. After you hear a question, you must choose the best answer from the four choices marked A, B, C and D. Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.' },
  { key: 'tail', text: 'Then mark the corresponding letter on Answer Sheet 1 with a single line through the centre.' },
]
const NUM_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20 }
const toks = (t) => String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
/** 复合数词归一：tokenizer 把 "twenty-two" 拆成 twenty+two，先合并成 22 再做任何
 *  数字提取（实测 #56 @1303 "nineteen to twenty-two" 被误提取成 19 to 20）。 */
const normNumToks = (arr) => {
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const w = arr[i]
    if (w === 'twenty' && arr[i + 1] && NUM_WORD[arr[i + 1]] !== undefined && NUM_WORD[arr[i + 1]] < 10) {
      out.push(String(20 + NUM_WORD[arr[i + 1]])); i++; continue
    }
    out.push(w)
  }
  return out
}
/** 覆盖率=片段方向：岛转写的 token 有多少出现在模板里。
 *  无行语音被切成多个小岛、每岛只是模板的一句（"College English Test Band Six."），
 *  模板侧覆盖率必然低（0.33）——片段侧 ≥0.7 即认领该岛，连续同模板岛合并成完整一行。 */
const overlapOf = (heard, tpl) => {
  const h = toks(heard), t = new Set(toks(tpl))
  return h.filter((w) => t.has(w)).length / Math.max(h.length, 1)
}
/** 转写 → 匹配产物：{key} 模板 / {announce} 播报 / null。
 *  播报段（"Questions sixteen to nineteen are based on the recording…"）不在
 *  TEMPLATES 里——数字与材料类型从转写提取，文本按播报句式重建（缺播报行=缺锚点）。 */
const matchSegment = (heard) => {
  const h = normNumToks(toks(heard))
  const has = (w) => h.includes(w)
  const qi = h.findIndex((w) => w === 'question' || w === 'questions')
  if (qi >= 0 && h.slice(qi).includes('based')) {
    const val = (w) => (w == null ? null : NUM_WORD[w] ?? (/^\d+$/.test(w) ? +w : null))
    const n1 = val(h[qi + 1]), conn2 = h[qi + 2], n2 = val(h[qi + 3])
    if (n1 !== null && (conn2 === 'to' || conn2 === 'and') && n2 !== null && n2 >= n1 && n1 >= 1 && n2 <= 25) {
      const type = has('recording') ? 'recording' : has('news') ? 'news report' : has('conversation') ? 'conversation' : 'passage'
      return { announce: `Questions ${n1} to ${n2} are based on the ${type} you have just heard.` }
    }
  }
  if (has('mark') && has('letter')) return { key: 'tail' }
  if (has('band') || (has('listening') && has('comprehension'))) return { key: 'open-A' }
  if (has('recording') || has('recordings') || has('lecture') || has('talks')) return { key: 'dir-C-3rec' }
  if (has('news') || has('reports')) return { key: 'dir-A-3news' }
  if (has('conversation') || has('conversations')) return { key: 'dir-A-2conv' }
  if (has('passage') || has('passages')) return { key: 'dir-B-2pass' }
  if (has('section') && has('c')) return { key: 'open-BC' }
  if (has('section') && has('a')) return { key: 'open-A' }
  return null
}

// ── 主流程 ──
const conn = await connect()
const [rows] = await conn.query('select id, title, category_id, audio_object_name, transcript_json from exercises where id between 53 and 62 order by id')
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')
const report = []
let totalAdd = 0

for (const row of rows) {
  const cid = row.id
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const audio = path.join(STORE, String(row.audio_object_name || '').replace(/^.*?audio\//, 'audio/'))
  const { islands, duration } = JSON.parse(fs.readFileSync(path.join(ISLAND_DIR, cid + '.json'), 'utf8'))
  const anchors = extractDialogueAnchors(lines.map((l) => ({ id: l.id, start: l.start, end: l.end, text: l.text })))
  // 无行 ≥2.5s 岛；范围=课程开头 45s 或 锚点起点前 3s 内开始（贴锚点组的 Directions 段）
  const gaps = islands.filter(([a, b]) => {
    if (b - a < 2.5) return false
    const covered = lines.some((l) => l.start < b - 0.3 && l.end > a + 0.3)
    if (covered) return false
    return a <= 45 || anchors.some((an) => a > an.start - 30 && a < an.start + 3)
  })
  if (!gaps.length) continue
  const added = []
  let lastKey = null, lastKeyAt = -1e9
  for (const [a, b] of gaps) {
    const heard = await hearIsland(cid, audio, a, b)
    if (!heard) { report.push({ cid, t: a, verdict: 'no-heard' }); continue }
    let m = matchSegment(heard)
    // 回退：Directions 连续朗读的中段（"After you hear a question…"）无关键词，
    // 12s 内上一段的 key 延续（整个 Directions 就是同一篇模板）
    if (!m && a - lastKeyAt <= 12 && lastKey) m = { key: lastKey }
    if (m?.key) { lastKey = m.key; lastKeyAt = a }
    if (m?.announce) {
      const prev = added[added.length - 1]
      if (prev && a - prev.end < 8 && prev.text === m.announce) { prev.end = +b.toFixed(2); continue }
      added.push({ start: +a.toFixed(2), end: +b.toFixed(2), text: m.announce, cov: 1 })
      continue
    }
    const tpl = m?.key ? TEMPLATES.find((t) => t.key === m.key) : null
    const cov = tpl ? overlapOf(heard, tpl.text) : 0
    if (!tpl || cov < 0.55) { report.push({ cid, t: +a.toFixed(1), verdict: 'no-template', heard: heard.slice(0, 80), key: m?.key ?? null, cov: +cov.toFixed(2) }); continue }
    // 相邻已补行合并（同一 Directions 连续朗读被停顿切开，≤8s 且同模板）
    const prev = added[added.length - 1]
    if (prev && a - prev.end < 8 && prev.text === tpl.text) { prev.end = +b.toFixed(2); continue }
    added.push({ start: +a.toFixed(2), end: +b.toFixed(2), text: tpl.text, cov: +cov.toFixed(2) })
  }
  if (!added.length) continue
  // 插入（时间序）+ 单调收敛
  for (const nl of added) {
    const idx = lines.findIndex((l) => l.start > nl.start)
    lines.splice(idx < 0 ? lines.length : idx, 0, { id: 'new', start: nl.start, end: nl.end, text: nl.text })
  }
  lines.sort((a, b) => a.start - b.start)
  lines.forEach((l, i) => { l.id = `l${i + 1}` })
  const needOf = (l) => Math.min(Math.max(toks(l.text).filter((w) => w.length >= 2).length * 0.28, 0.3), 20)
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], l = lines[i]
    if (l.start < p.end - 0.001) p.end = +Math.max(l.start, p.start + Math.max(0.18, needOf(p) * 0.35 + 0.2)).toFixed(2)
    if (l.end <= l.start) l.end = +(l.start + 0.3).toFixed(2)
  }
  totalAdd += added.length
  report.push({ cid, verdict: 'added', n: added.length, lines: added.map((x) => ({ t: x.start, cov: x.cov, text: x.text.slice(0, 50) })) })
  console.log(`#${cid}「${row.title}」补 ${added.length} 行`)
  for (const a of added) console.log(`   @${a.start} cov=${a.cov}「${a.text.slice(0, 46)}…」`)
}
console.log(`\n══ 合计补行 ${totalAdd}；MiMo 调用 ${calls}（失败 ${fails}）══`)
fs.writeFileSync('temp/directions-add-report.json', JSON.stringify(report, null, 1))
if (!APPLY) { console.log('DRY 结束'); await conn.end(); process.exit(0) }

// 按课写库（重读最新行集合走契约）
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const todayPrefix = `${today}.`
let ok = 0, failed = 0
const nextVersionOf = new Map()
for (const row of rows) {
  const rep = report.find((r) => r.cid === row.id && r.verdict === 'added')
  if (!rep) continue
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const audio = path.join(STORE, String(row.audio_object_name || '').replace(/^.*?audio\//, 'audio/'))
  const { islands } = JSON.parse(fs.readFileSync(path.join(ISLAND_DIR, row.id + '.json'), 'utf8'))
  // 重新执行补行（与 dry 相同逻辑，读 DB 最新态）
  const anchors = extractDialogueAnchors(lines.map((l) => ({ id: l.id, start: l.start, end: l.end, text: l.text })))
  const gaps = islands.filter(([a, b]) => {
    if (b - a < 2.5) return false
    const covered = lines.some((l) => l.start < b - 0.3 && l.end > a + 0.3)
    if (covered) return false
    return a <= 45 || anchors.some((an) => a > an.start - 30 && a < an.start + 3)
  })
  const added = []
  let lastKey = null, lastKeyAt = -1e9
  for (const [a, b] of gaps) {
    const heard = await hearIsland(row.id, audio, a, b)
    if (!heard) continue
    let m = matchSegment(heard)
    if (!m && a - lastKeyAt <= 12 && lastKey) m = { key: lastKey }
    if (m?.key) { lastKey = m.key; lastKeyAt = a }
    if (m?.announce) {
      const prev = added[added.length - 1]
      if (prev && a - prev.end < 8 && prev.text === m.announce) { prev.end = +b.toFixed(2); continue }
      added.push({ start: +a.toFixed(2), end: +b.toFixed(2), text: m.announce })
      continue
    }
    const tpl = m?.key ? TEMPLATES.find((t) => t.key === m.key) : null
    const cov = tpl ? overlapOf(heard, tpl.text) : 0
    if (!tpl || cov < 0.55) continue
    const prev = added[added.length - 1]
    if (prev && a - prev.end < 8 && prev.text === tpl.text) { prev.end = +b.toFixed(2); continue }
    added.push({ start: +a.toFixed(2), end: +b.toFixed(2), text: tpl.text })
  }
  if (!added.length) continue
  for (const nl of added) {
    const idx = lines.findIndex((l) => l.start > nl.start)
    lines.splice(idx < 0 ? lines.length : idx, 0, { id: 'new', start: nl.start, end: nl.end, text: nl.text })
  }
  lines.sort((a, b) => a.start - b.start)
  lines.forEach((l, i) => { l.id = `l${i + 1}` })
  const needOf = (l) => Math.min(Math.max(toks(l.text).filter((w) => w.length >= 2).length * 0.28, 0.3), 20)
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], l = lines[i]
    if (l.start < p.end - 0.001) p.end = +Math.max(l.start, p.start + Math.max(0.18, needOf(p) * 0.35 + 0.2)).toFixed(2)
    if (l.end <= l.start) l.end = +(l.start + 0.3).toFixed(2)
  }
  const seedPath = seedOf(row.category_id)
  if (!nextVersionOf.has(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
    nextVersionOf.set(seedPath, seed.version.startsWith(todayPrefix)
      ? `${todayPrefix}${Number(seed.version.slice(todayPrefix.length)) + 1}`
      : `${todayPrefix}1`)
  }
  try {
    await saveTranscript({
      conn, cid: row.id, lines, version: nextVersionOf.get(seedPath), seedPath,
      expect: { lineDelta: [0, added.length], allowUntranslatedGrow: true, note: `Directions 补行 ${added.length}（模板文本，MiMo 对号）` },
      dryRun: false,
    })
    ok++
  } catch (e) { failed++; console.error(`✗ #${row.id} ${e.message}`) }
}
console.log(`\n══ 落库 ${ok} 成功 / ${failed} 失败 ══`)
await conn.end()
