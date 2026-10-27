/**
 * 词级时间戳钉位 v2（2026-10-27 ① 返工）：用 ZCode speech_transcribe(cloud_asr)
 * 的词流把行起点钉到第一个词的起点。
 *
 * 与 v1 的差别（v1 造成真实回退，已回滚）：
 *   1. 不做 lines.sort(start)——文本顺序是权威的，排序会把"标签行/短句"和正文互换；
 *   2. seal 只收缩上一行的 end，**从不前推任何一行的 start**（v1 的 else 分支会把行
 *      传送到邻行 end，实测 #1001 三句 +4s、#55 一句 +12s、#1012 两句互换）；
 *   3. 命中要求"唯一出现"：同一 needle 在词流多处出现时，取离当前 start 最近的一次，
 *      且必须明显最近（次近 >3s），否则放弃该行（防"the/yes"这类高频短语串位）；
 *   4. 题干行（Q5. / Question 5:）优先钉到 "Question <num>" 的播报词位。
 *
 * 数据源：temp/wordmap-v2/{cid}.json（words: [{text,start,end}]）
 * 用法：node scripts/content/retime-by-wordmap-v2.mjs --dry|--apply [--ids 53,25]
 */
import fs from 'node:fs'
import path from 'node:path'
import { connect, saveTranscript } from '../audit/data-contract.mjs'
import { extractDialogueAnchors } from '../../packages/domain/dist/index.js'

const APPLY = process.argv.includes('--apply')
const DEBUG = process.env.DEBUG_CID ? Number(process.env.DEBUG_CID) : null
const ONLY = (() => { const i = process.argv.indexOf('--ids'); return i >= 0 ? process.argv[i + 1].split(',').filter(Boolean).map(Number) : null })()
const WORDDIR = 'temp/wordmap-v2'
const ISLAND_DIR = 'temp/anchor-islands'
const WIN = 25           // 最近命中允许的最大距离（秒）
const MIN_DELTA = 0.3    // 小于 0.3s 不动（减少噪音）
const MAX_DELTA = 12     // 超过 12s 的位移要求强证据（hit≥8 且唯一）

const NUM_WORD = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20 }
const norm = (w) => {
  const t = String(w).toLowerCase().replace(/[^a-z0-9']/g, '')
  if (/^\d+$/.test(t)) return String(+t)
  if (NUM_WORD[t] !== undefined) return String(NUM_WORD[t])
  return t
}
const SPEAKER_RE = /^(?:[MW]:\s*)+/i
const Q_RE = /^(?:Q|Question)\s*(\d+|(?:twenty|thirty|forty)(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?|(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)|(?:one|two|three|four|five|six|seven|eight|nine))\s*[.:,]?\s*/i
const TENS = { twenty: 20, thirty: 30, forty: 40 }
const UNITS = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19 }
const numOf = (s) => {
  const t = String(s).toLowerCase().trim()
  if (/^\d+$/.test(t)) return Number(t)
  const parts = t.split(/[\s-]+/).filter(Boolean)
  if (parts.length === 1) return TENS[parts[0]] ?? UNITS[parts[0]] ?? null
  const a = TENS[parts[0]], b = UNITS[parts[1]]
  return a !== undefined && b !== undefined ? a + b : null
}
const toksOf = (t) => String(t).trim().replace(SPEAKER_RE, '').replace(Q_RE, '')
  .split(/[^A-Za-z0-9']+/).filter(Boolean).map(norm).filter((w) => w.length > 0)

// 在词流的 [lo,hi] 区间扫描 needle 的连续匹配（容忍 1 词失配），返回全部命中起点
const occIn = (flow, needle, lo, hi, minHit = 3) => {
  const out = []
  for (let i = 0; i < flow.length; i++) {
    if (flow[i].start > hi) break
    if (flow[i].end < lo) continue
    let j = 0, k = i, miss = 0, hit = 0
    while (j < needle.length && k < flow.length && flow[k].start <= hi) {
      if (flow[k].w === needle[j]) { hit++; j++; k++ }
      else if (miss === 0 && j + 1 < needle.length && flow[k + 1]?.w === needle[j + 1]) { miss++; k++; continue }
      else if (miss === 0 && needle[j + 1] === flow[k].w) { miss++; j++; continue }
      else break
    }
    if (hit >= minHit) out.push({ start: flow[i].start, hit })
  }
  return out
}

// 唯一化：相邻 2s 内算同一次；保留 hit 最大者
const dedupe = (occ) => {
  const list = []
  for (const o of occ.slice().sort((a, b) => a.start - b.start)) {
    const last = list[list.length - 1]
    if (last && o.start - last.start < 2) { if (o.hit > last.hit) last.hit = o.hit; last.start = Math.min(last.start, o.start); continue }
    list.push({ ...o })
  }
  return list
}

// 题干行：取内容词位之前最近的 "question <num>" 播报（两者间隔 <6s）
const labelBefore = (flow, num, contentStart) => {
  let best = null
  for (let i = 0; i < flow.length - 1; i++) {
    if (flow[i].w !== 'question') continue
    if (flow[i + 1].w !== String(num)) continue
    const dt = contentStart - flow[i].start
    if (dt < -0.2 || dt > 6) continue
    if (best === null || flow[i].start > best) best = flow[i].start
  }
  return best
}

const conn = await connect()
const [rows] = await conn.query('select id, title, category_id, transcript_json from exercises order by id')
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const todayPrefix = `${today}.`
const nextVersionOf = new Map()
let totalMoved = 0, ok = 0, failed = 0, rejected = 0

for (const row of rows) {
  if (ONLY && !ONLY.includes(row.id)) continue
  const wf = path.join(WORDDIR, `${row.id}.json`)
  if (!fs.existsSync(wf)) continue
  const flow = JSON.parse(fs.readFileSync(wf, 'utf8')).words.map((w) => ({ w: norm(w.text), start: w.start, end: w.end }))
  if (!flow.length) continue
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const islands = JSON.parse(fs.readFileSync(path.join(ISLAND_DIR, `${row.id}.json`), 'utf8')).islands

  // ── 1. 逐行求词级目标 ──
  const targets = new Map()
  for (const l of lines) {
    const needle = toksOf(l.text).slice(0, 10)
    if (needle.length < 2) continue
    let target = null, hit = 0
    const occ = needle.length >= 3 ? dedupe(occIn(flow, needle, -1e9, 1e9)) : []
    let contentStart = null
    if (needle.length >= 3) {
      const minHit = needle.length === 4 ? 3 : Math.min(needle.length, 5)
      const strong = occ.filter((o) => o.hit >= minHit)
      if (strong.length) {
        strong.sort((a, b) => Math.abs(a.start - l.start) - Math.abs(b.start - l.start))
        const best = strong[0], second = strong[1]
        if (Math.abs(best.start - l.start) <= WIN && !(second && Math.abs(second.start - l.start) - Math.abs(best.start - l.start) < 3)) {
          contentStart = best.start; hit = best.hit
        }
      }
    }
    // 2 词短行（标签行如 "Conversation 1"）：要求整对词都命中且全库唯一
    if (contentStart === null && needle.length === 2) {
      const two = dedupe(occIn(flow, needle, -1e9, 1e9, 2).filter((o) => o.hit === 2))
      if (two.length === 1 && Math.abs(two[0].start - l.start) <= WIN) { contentStart = two[0].start; hit = 2 }
    }
    if (contentStart === null) { if (needle.length >= 3) rejected++; continue }
    const qm = String(l.text).trim().replace(SPEAKER_RE, '').match(Q_RE)
    if (qm) {
      const qn = numOf(qm[1])
      const ls = qn === null ? null : labelBefore(flow, qn, contentStart)
      target = ls !== null ? ls : contentStart
      if (ls !== null) hit = 99
    } else target = contentStart
    const delta = target - l.start
    if (DEBUG === row.id) console.log(`  [dbg] ${l.id} start=${l.start} needle=${needle.join('|')} content=${contentStart} target=${target} hit=${hit} delta=${delta.toFixed(2)}`)
    if (Math.abs(delta) > MAX_DELTA && hit < 8) { rejected++; continue }
    // 即使位移很小也登记（换序/顺序守卫需要看到它的真实词位），apply 决定是否真移动
    targets.set(l, { start: +target.toFixed(2), delta: +delta.toFixed(2), hit, apply: Math.abs(delta) >= MIN_DELTA })
  }
  if (!targets.size) continue

  // ── 2. 相邻强证据倒挂：按词位交换文本顺序（官方原文偶有与音频不符的顺序）──
  for (let pass = 0; pass < 3; pass++) {
    let swapped = false
    for (let i = 0; i < lines.length - 1; i++) {
      const a = targets.get(lines[i]), b = targets.get(lines[i + 1])
      if (a && b && a.start > b.start + 0.5) { [lines[i], lines[i + 1]] = [lines[i + 1], lines[i]]; swapped = true }
    }
    if (!swapped) break
  }

  // ── 3. 文本顺序守卫：与上一个已接受目标倒挂 >0.6s 的目标丢弃 ──
  let last = -1e9
  for (const l of lines) {
    const t = targets.get(l)
    if (!t) continue
    if (t.start < last - 0.6) { targets.delete(l); rejected++; continue }
    last = Math.max(last, t.start)
  }
  if (!targets.size) continue

  // ── 4. 应用（不排序） ──
  const moves = []
  for (const l of lines) {
    const t = targets.get(l)
    if (!t || !t.apply) continue
    moves.push({ id: l.id, from: l.start, to: t.start, hit: t.hit })
    l.start = t.start
  }

  // ── 5. seal：只收缩上一行 end，绝不前推 start ──
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], l = lines[i]
    if (l.start < p.end - 0.001) p.end = +Math.max(p.start + 0.15, l.start).toFixed(2)
  }
  // 未被钉的短行若因邻居前移而倒挂：放进前一行 end 与下一行 start 的空隙
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i]
    if (targets.has(l)) continue
    if (l.start <= lines[i + 1].start + 0.3) continue
    const floor = i > 0 ? lines[i - 1].start + 0.05 : 0
    if (i > 0 && lines[i - 1].end <= lines[i + 1].start - 0.1) {
      l.start = lines[i - 1].end
    } else {
      l.start = +Math.max(floor, lines[i + 1].start - 0.2).toFixed(2)
    }
    l.end = +Math.min(lines[i + 1].start, l.start + 1.5).toFixed(2)
  }
  // end 补齐（按时长健全门禁口径：有效词数×0.28，夹在下一行 start 内）
  const needOf = (l) => Math.min(Math.max(((String(l.text).replace(/^(?:[MW]:\s*)+/i, '').match(/[a-zA-Z0-9']+/g) || []).filter((w) => w.length >= 2).length) * 0.28, 0.3), 20)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const nx = i + 1 < lines.length ? lines[i + 1].start : Infinity
    const need = needOf(l)
    let end = l.end
    if (end - l.start < need - 0.01) end = Math.min(nx, l.start + need)
    if (end <= l.start + 0.05) end = Math.min(nx, l.start + 0.15)
    l.end = +end.toFixed(2)
  }
  // 微重叠（起点间距 <0.02 无法用收缩 end 解决时，轻推后一行起点）
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], l = lines[i]
    if (l.start >= p.end - 0.001) continue
    if (l.start - p.start >= 0.1) p.end = +l.start.toFixed(2)
    else { l.start = +(p.start + 0.05).toFixed(2); p.end = +l.start.toFixed(2) }
  }

  // ── 6. 微倒挂（<0.3s）单调化：不越前一行 end、不把 start 提前 ──
  for (let i = lines.length - 2; i >= 0; i--) {
    const a = lines[i], b = lines[i + 1]
    if (a.start < b.start - 0.001) continue
    if (!targets.get(a)?.apply) {
      const lower = i > 0 ? Math.max(lines[i - 1].end, lines[i - 1].start + 0.02) : 0
      const cand = Math.max(lower, b.start - 0.02)
      if (cand < b.start - 0.001) a.start = +cand.toFixed(2)
      else b.start = +(a.start + 0.02).toFixed(2)
    } else b.start = +(a.start + 0.02).toFixed(2)
  }

  // 末次 end 健全（微倒挂轻推过 start 之后，end 可能已被甩到 start 之前）
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const nx = i + 1 < lines.length ? lines[i + 1].start : Infinity
    if (l.end <= l.start + 0.02) l.end = +Math.min(nx, l.start + Math.max(0.15, needOf(l))).toFixed(2)
    if (l.end <= l.start) l.end = +(l.start + 0.05).toFixed(2)
  }

  // 末次单调强制：起点严格递增，且给前一行留够最小可辨识时长（≥need×0.35）
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], l = lines[i]
    const floorP = Math.max(0.12, needOf(p) * 0.35)
    if (l.start < p.start + floorP) {
      const shift = +(p.start + floorP - l.start).toFixed(2)
      l.start = +(l.start + shift).toFixed(2)
      l.end = +(l.end + shift).toFixed(2)
    }
    // 前一行 end 补到（至多）下一行 start，且不超过 need
    const want = Math.min(l.start, p.start + needOf(p))
    if (p.end < want) p.end = +want.toFixed(2)
    if (p.end > l.start) p.end = +l.start.toFixed(2)
    if (p.end <= p.start + 0.05) p.end = +Math.min(l.start, p.start + 0.1).toFixed(2)
    if (l.end <= l.start + 0.02) l.end = +(l.start + 0.1).toFixed(2)
  }

  // 顺序落定后重编 id（交换/插空之后 id 必须与数组顺序一致）
  lines.forEach((l, i) => { l.id = `l${i + 1}` })

  totalMoved += moves.length
  console.log(`#${row.id}「${row.title}」钉位 ${moves.length} 行`)
  for (const m of moves.slice(0, 3)) console.log(`   ${m.id} ${m.from.toFixed(1)} → ${m.to.toFixed(1)}（命中 ${m.hit}）`)
  if (moves.length > 3) console.log(`   …共 ${moves.length} 处`)
  if (!APPLY) {
    fs.mkdirSync('temp/wordmap-v2-preview', { recursive: true })
    fs.writeFileSync(`temp/wordmap-v2-preview/${row.id}.json`, JSON.stringify(lines, null, 1))
    continue
  }
  const seedPath = seedOf(row.category_id)
  if (!nextVersionOf.has(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
    nextVersionOf.set(seedPath, seed.version.startsWith(todayPrefix)
      ? `${todayPrefix}${Number(seed.version.slice(todayPrefix.length)) + 1}` : `${todayPrefix}1`)
  }
  try {
    await saveTranscript({ conn, cid: row.id, lines, version: nextVersionOf.get(seedPath), seedPath,
      expect: { lineDelta: [0, 0], note: `词级钉位 v2 ${moves.length} 行` }, dryRun: false })
    ok++
  } catch (e) { failed++; console.error(`✗ #${row.id} ${e.message}`) }
}
console.log(`\n══ 钉位 ${totalMoved} 行；落库 ${ok} / 失败 ${failed}；歧义丢弃 ${rejected} 行（${APPLY ? 'APPLY' : 'DRY'}）══`)
await conn.end()