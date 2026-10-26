/**
 * 播报题号全库对表（2026-10-26 追加轮 ②，用户授权扩 MiMo 预算）。
 *
 * 目的：全部题组播报行（"Questions N to M are based on..."）与音频实际念的
 * 题号区间逐条 diff，#16 型「原文题号范围本身是错的」冲突做终扫。
 *
 * 裁决规则（红线 4 事实源顺序：音频词图 > 官方原文 > 现存行文本）：
 *   - 播报音频区间 ≠ 播报行文本区间，且组内题干行（官方题号）与音频一致
 *     → 播报行文本是笔误，按音频修正（--apply 走 saveTranscript，lineDelta [0,0]）；
 *   - 播报音频区间独异、题干与播报文本一致 → MiMo 误听嫌疑，只列不改；
 *   - 解析不出区间（岛文本缺 "based" 签名等）→ unknown，单列。
 *
 * 岛文本优先复用 temp/mimo-refine-cache-lines/（首轮已转写大半）；
 * 连接词同时支持 to/through/and（四级 "Questions 1 and 2"、六级 "1 to 4"）。
 *
 * 用法：
 *   node scripts/content/mimo-qnum-check.mjs            # dry：只出对表
 *   node scripts/content/mimo-qnum-check.mjs --apply    # 修正确认的笔误
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const APPLY = process.argv.includes('--apply')
const SR = 16000, FRAME = 0.05, THRESH = 0.004
const CACHE = 'temp/mimo-refine-cache-lines'
const ISLAND_DIR = 'temp/anchor-islands'
const STORE = 'temp/runtime/media-store/duolinting-media'
const OUT = 'temp/qnum-check.json'
const MIMO_KEY = fs.readFileSync(path.join(os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
const MIMO_BASE = process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let calls = 0, fails = 0
const mimoRaw = async (file) => {
  const data = fs.readFileSync(file).toString('base64')
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(MIMO_BASE + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + MIMO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-asr',
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'mp3' } }] }],
        }),
      })
      if (res.status === 429) {
        if (attempt === 3) { fails++; throw new Error('429 重试耗尽') }
        await sleep(4000 * (attempt + 1)); continue
      }
      const t = await res.text()
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${t.slice(0, 100)}`)
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

const NUM_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 }
const numOf = (s) => {
  const t = String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (/^\d+$/.test(t)) return +t
  return NUM_WORD[t] ?? null
}
const normToks = (arr) => {
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const a = numOf(arr[i]) !== null ? String(numOf(arr[i])) : String(arr[i]).toLowerCase().replace(/[^a-z0-9]/g, '')
    if (a === '20' || a === '30') {
      const bNext = i + 1 < arr.length ? numOf(arr[i + 1]) : null
      if (bNext !== null && bNext < 10 && bNext !== 20 && bNext !== 30) { out.push(String(20 + bNext)); i++; continue }
    }
    if (a) out.push(a)
  }
  return out
}
const toks = (t) => normToks(String(t).split(/[^A-Za-z0-9]+/).filter(Boolean))

/**
 * 从 token 流解析「播报题号区间」。两种接受条件：
 *  a) 区间后 8 token 内有 based（"are based on ..." 播报签名，任意位置）；
 *  b) 模式就在岛文本头部（pos≤2）——"are based on..." 常跨岛（播报岛只含
 *     "Questions twelve to fifteen."），行钉在岛起点本身是位置证据。
 * 返回 [first, last] 或 null。
 */
const parseRange = (tk) => {
  for (let i = 0; i < tk.length - 1; i++) {
    if (tk[i] !== 'question' && tk[i] !== 'questions') continue
    const n1 = numOf(tk[i + 1])
    if (n1 === null || n1 < 1 || n1 > 25) continue
    let first = n1, last = n1, j = i + 2
    if (j < tk.length && (tk[j] === 'to' || tk[j] === 'through' || tk[j] === 'and') && j + 1 < tk.length) {
      const n2 = numOf(tk[j + 1])
      if (n2 !== null && n2 >= n1 && n2 <= 25) { last = n2; j += 2 }
    } else if (j < tk.length) {
      // 连字符区间 "5-8"：tokenizer 拆掉 '-' 后呈相邻数字形态
      const n2 = numOf(tk[j])
      if (n2 !== null && n2 > n1 && n2 <= 25) { last = n2; j += 1 }
    }
    for (let k = j; k < Math.min(j + 8, tk.length); k++) {
      if (tk[k] === 'based') return [first, last]
    }
    if (i <= 2) return [first, last]
  }
  return null
}
/** 播报行选行与题干终止判定用的头部正则（宽松，只判形态） */
const ANNOUNCE_RE = /^[\s\-–—>*•]*questions?\s+[0-9a-z](?:[-\s]?[0-9a-z])*\s*(?:(?:to|through|and|–|—|-)\s*[0-9a-z]+)?\b/i
/** 行文本的播报区间——与音频同源解析（toks 复合数词归一，"twenty-three"→23） */
const textRangeOf = (text) => parseRange(toks(String(text).replace(/^[\s\-–—>*•]*/, '')))

// ── 主流程 ────────────────────────────────────────────────────
const conn = await connect()
const [rows] = await conn.query(
  'select id, title, category_id, audio_object_name, transcript_json from exercises order by id')
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')

const hearIsland = async (cid, audio, a, b) => {
  const id = `l-${cid}-${a.toFixed(2)}-${b.toFixed(2)}`
  const cf = path.join(CACHE, id + '.txt')
  if (fs.existsSync(cf)) {
    const c = fs.readFileSync(cf, 'utf8')
    if (c.trim()) return c
    fs.rmSync(cf, { force: true })
  }
  const mp3 = path.join(CACHE, id + '.mp3')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(b - a),
    '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
  let text = ''
  try { text = await mimoRaw(mp3); calls++ } catch { text = '' }
  if (text.trim()) fs.writeFileSync(cf, text)
  fs.rmSync(mp3, { force: true })
  return text
}

const makeChain = () => {
  let p = Promise.resolve()
  return (fn) => new Promise((resolve, reject) => {
    p = p.then(async () => { try { resolve(await fn()) } catch (e) { reject(e) } })
    p = p.catch(() => {})
  })
}
const chains = [makeChain(), makeChain()]

const results = []   // 全量对表行
const jobs = rows.map((row) => async () => {
  const cid = row.id
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json)
  const audio = path.join(STORE, String(row.audio_object_name || '').replace(/^.*?audio\//, 'audio/'))
  if (!fs.existsSync(audio)) return
  const cacheF = path.join(ISLAND_DIR, `${cid}.json`)
  if (!fs.existsSync(cacheF)) return
  const islands = JSON.parse(fs.readFileSync(cacheF, 'utf8')).islands

  // 播报行 → 岛 → 音频区间
  const announces = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/based\s+on/i.test(l.text) && ANNOUNCE_RE.test(String(l.text).trim())) {
      announces.push({ line: l, idx: i })
    }
  }
  for (const { line, idx } of announces) {
    const is = islands.find(([a, b]) => line.start > a - 1.5 && line.start < b)
    if (!is) { results.push({ cid, title: row.title, line: line.id, text: String(line.text).slice(0, 60), textRange: textRangeOf(line.text), audioRange: null, verdict: 'no-island' }); continue }
    const heard = await hearIsland(cid, audio, is[0], is[1])
    const audioRange = heard ? parseRange(toks(heard)) : null
    const textRange = textRangeOf(line.text)
    // 组内题干（后续带 Q 标签的正文行，止于下一播报/材料头）
    const stems = []
    for (let j = idx + 1; j < lines.length && stems.length < 6; j++) {
      const t = String(lines[j].text).trim()
      if (ANNOUNCE_RE.test(t) || /^(?:section|conversation|passage|recording|news\s*report)\s/i.test(t)) break
      const qm = t.match(/^q\s*(\d{1,2})\s*[.。:：]/i) ?? t.match(/^question\s+(\d{1,2})\b/i)
      if (qm) stems.push(Number.parseInt(qm[1], 10))
    }
    results.push({ cid, title: row.title, line: line.id, t: +line.start.toFixed(1), text: String(line.text).slice(0, 60), textRange, audioRange, stems, island: [+is[0].toFixed(2), +is[1].toFixed(2)], heard: heard.slice(0, 120) })
  }
})
await Promise.all(jobs.map((j, i) => chains[i % 2](j)))

// ── 裁决 ──────────────────────────────────────────────────────
let match = 0, unknown = 0
const suspects = [], corrections = []
for (const r of results) {
  if (!r.textRange || !r.audioRange) { unknown++; r.verdict = 'unknown'; continue }
  const [ta, tb] = r.textRange, [aa, ab] = r.audioRange
  if (ta === aa && tb === ab) { match++; r.verdict = 'match'; continue }
  // 题干旁证：题干官方题号与音频区间一致 → 播报行文本笔误
  const stemsAgreeAudio = r.stems.length > 0 && r.stems.every((n) => n >= aa && n <= ab) && Math.min(...r.stems) === aa && Math.max(...r.stems) === ab
  const stemsAgreeText = r.stems.length > 0 && r.stems.every((n) => n >= ta && n <= tb) && Math.min(...r.stems) === ta && Math.max(...r.stems) === tb
  if (stemsAgreeAudio && !stemsAgreeText) {
    r.verdict = 'fix'
    corrections.push(r)
  } else if (stemsAgreeText && !stemsAgreeAudio) {
    r.verdict = 'mimo-suspect'
    suspects.push(r)
  } else {
    r.verdict = 'ambiguous'
    suspects.push(r)
  }
}
results.sort((a, b) => (a.cid - b.cid) || ((a.t ?? 0) - (b.t ?? 0)))
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), stats: { total: results.length, match, unknown, fix: corrections.length, suspect: suspects.length }, results }, null, 1))

console.log(`\n══ 对表 ${results.length} 组：一致 ${match}，待修(音频为准) ${corrections.length}，MiMo误听嫌疑/含糊 ${suspects.length}，解析不出 ${unknown}`)
for (const r of corrections) console.log(`  FIX #${r.cid} @${r.t}s 文本 Q${r.textRange[0]}–${r.textRange[1]} → 音频 Q${r.audioRange[0]}–${r.audioRange[1]}（题干旁证 ${JSON.stringify(r.stems)}）「${r.text.slice(0, 40)}」`)
for (const r of suspects) console.log(`  SUSPECT #${r.cid} @${r.t}s 文本 ${JSON.stringify(r.textRange)} vs 音频 ${JSON.stringify(r.audioRange)} 题干 ${JSON.stringify(r.stems)}「${r.heard.slice(0, 50)}」`)
console.log(`══ MiMo 调用 ${calls}（失败 ${fails}）→ ${OUT}`)

// ── 修正写库（文本里的数字原位替换；译文里的数字顺带替换） ────
if (APPLY && corrections.length) {
  const byCid = new Map()
  for (const r of corrections) {
    if (!byCid.has(r.cid)) byCid.set(r.cid, [])
    byCid.get(r.cid).push(r)
  }
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const todayPrefix = `${today}.`
  const nextVersionOf = new Map()
  let ok = 0, failed = 0
  for (const [cid, fixes] of byCid) {
    const row = rows.find((x) => x.id === cid)
    const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
    for (const f of fixes) {
      const l = lines.find((x) => x.id === f.line)
      if (!l) continue
      const [ta, tb] = f.textRange, [aa, ab] = f.audioRange
      const numToWord = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty', 21: 'twenty-one', 22: 'twenty-two', 23: 'twenty-three', 24: 'twenty-four', 25: 'twenty-five' }
      // 原位替换：把行文本/译文中出现的旧题号形态换成新题号（数字形态直接换、词形态查表换）
      const swapNums = (s) => String(s)
        .replace(new RegExp(`\\b${ta}\\b`, 'g'), String(aa))
        .replace(new RegExp(`\\b${tb}\\b`, 'g'), String(ab))
        .replace(new RegExp(`\\b${numToWord[ta]?.replace('-', '[-\\s]')}\\b`, 'gi'), (m2) => numToWord[aa] ?? m2)
        .replace(new RegExp(`\\b${numToWord[tb]?.replace('-', '[-\\s]')}\\b`, 'gi'), (m2) => numToWord[ab] ?? m2)
      l.text = swapNums(l.text)
      if (l.translation && new RegExp(`第?\\s*${ta}\\s*[至到和-]|${ta}\\s*[-至到和]`, '').test(l.translation)) {
        l.translation = String(l.translation)
          .replace(new RegExp(`(?<![0-9])${ta}(?![0-9])`, 'g'), String(aa))
          .replace(new RegExp(`(?<![0-9])${tb}(?![0-9])`, 'g'), String(ab))
      }
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
        conn, cid, lines, version: nextVersionOf.get(seedPath), seedPath,
        expect: { lineDelta: [0, 0], note: `播报题号对表：${fixes.length} 行按音频修正` },
        dryRun: false,
      })
      ok++
    } catch (e) { failed++; console.error(`✗ #${cid} ${e.message}`) }
  }
  console.log(`\n══ 落库 ${ok} 成功 / ${failed} 失败 ══`)
}
await conn.end()
