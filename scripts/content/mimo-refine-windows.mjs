/**
 * 正文行滑窗词级钉位（2026-10-26 追加轮，用户授权扩 MiMo 预算）。
 *
 * 背景：岛级管线下，深在合并岛内部的正文行（retime 比例摊铺残留，如 #25 一门 76 条）
 * 与零间隙并岛的 interior 行，起点在岛中部、能量不可分——岛级修正到此为止。
 * 本脚本用「滑窗转写 + 头部命中」逼近词级时间戳：
 *   1. 对含错位行的岛，滑 2.0s 窗（步 1.2s）逐窗转写（缓存，复用主精修器的 -f 细分段缓存）；
 *   2. 行的前 3 个词出现在某窗文本头部（前 ~5 token，约 1.5s）→ 行起点在该窗内；
 *   3. 二分细化：窗内 +0/+0.75s 探针（1.5s 窗）取最小头命中起点；
 *   4. 岛内按行序单调认领（转写文本顺序=音频顺序），防串位与插队；
 *   5. 写库走 saveTranscript 契约（lineDelta [0,0]），单调化收缩梯度同主精修器。
 *
 * 目标：正文行 onset>1.2 且深在岛内；interior 锚点源行与区间首句（上一行终点伸入
 * 包含岛 ≥0.7s）。开场报头/题干残留仍归主精修器管，本脚本不重复处理。
 *
 * 用法：
 *   node scripts/content/mimo-refine-windows.mjs --dry
 *   node scripts/content/mimo-refine-windows.mjs --apply
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect, saveTranscript } from '../audit/data-contract.mjs'
import { extractDialogueAnchors } from '../../packages/domain/dist/index.js'

const APPLY = process.argv.includes('--apply')
const DEBUG = process.argv.includes('--debug')

const SR = 16000, FRAME = 0.05, THRESH = 0.004
const CACHE = 'temp/mimo-window-cache'
const MAIN_CACHE = 'temp/mimo-refine-cache-lines'
const ISLAND_DIR = 'temp/anchor-islands'
const STORE = 'temp/runtime/media-store/duolinting-media'
const WORK = 'temp/mimo-windows-out.json'
fs.mkdirSync(CACHE, { recursive: true })

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
/** 窗口转写（缓存键：课程+窗起点+窗长；空结果不落缓存——下次运行可重试失败窗） */
const hearWindow = async (cid, audio, a, len) => {
  const id = `w-${cid}-${a.toFixed(2)}-${len.toFixed(2)}`
  const cf = path.join(CACHE, id + '.txt')
  if (fs.existsSync(cf)) {
    const c = fs.readFileSync(cf, 'utf8')
    if (c.trim()) return c
    fs.rmSync(cf, { force: true })   // 空缓存=上次调用失败，删掉重试
  }
  const mp3 = path.join(CACHE, id + '.mp3')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(len),
    '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
  let text = ''
  try { text = await mimoRaw(mp3); calls++ } catch { text = '' }
  if (text.trim()) fs.writeFileSync(cf, text)
  fs.rmSync(mp3, { force: true })
  return text
}

const r2 = (v) => Math.round(v * 100) / 100
const islandsOf = (audio, cacheId) => {
  const st = fs.statSync(audio)
  const sig = `${st.size}|${st.mtimeMs}`
  const cf = path.join(ISLAND_DIR, cacheId + '.json')
  if (fs.existsSync(cf)) {
    const c = JSON.parse(fs.readFileSync(cf, 'utf8'))
    if (c.sig === sig) return c
  }
  throw new Error(`岛缓存缺失：${cacheId}（先跑 temp/audit-anchor-unit.mjs）`)
}

// ── token 归一（与主精修器一致） ──────────────────────────────
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
const SPEAKER_RE = /^(?:[MW]:\s*)+/i
/** 匹配键：全行 token（含题号标签——题干音频以 "Question N" 起），剥说话人前缀 */
const keyOf = (t) => toks(String(t).trim().replace(SPEAKER_RE, '')).slice(0, 6)
/** 头部命中：needle 前 3 词连续出现在窗口 token 的前 headLim 位 */
const headHit = (winToks, needle, headLim) => {
  const need = Math.min(3, needle.length)
  if (need < 2) return -1
  for (let k = 0; k + need <= Math.min(winToks.length, headLim); k++) {
    let q = 0
    for (let t = 0; t < need; t++) { if (winToks[k + t] === needle[t]) q++; else break }
    if (q >= need) return k
  }
  return -1
}
const needOf = (ln) => {
  const wc = toks(String(ln.text).replace(SPEAKER_RE, '')).filter((w) => w.length >= 2).length
  return Math.min(Math.max(wc * 0.28, 0.3), 20)
}

// ── 主流程 ────────────────────────────────────────────────────
const conn = await connect()
const [rows] = await conn.query(
  'select id, title, category_id, audio_object_name, transcript_json from exercises order by id')
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')

const stats = { targets: 0, pinned: 0, refined: 0, skip: 0, guardBlocked: 0 }
const payload = []
const makeChain = () => {
  let p = Promise.resolve()
  return (fn) => new Promise((resolve, reject) => {
    p = p.then(async () => { try { resolve(await fn()) } catch (e) { reject(e) } })
    p = p.catch(() => {})
  })
}
const chains = [makeChain(), makeChain()]

const jobs = rows.map((row) => async () => {
  const cid = row.id
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const audio = path.join(STORE, String(row.audio_object_name || '').replace(/^.*?audio\//, 'audio/'))
  if (!fs.existsSync(audio)) return
  const { islands, duration } = islandsOf(audio, String(cid))
  const starts05 = islands.filter(([a, b]) => b - a >= 0.5).map(([a]) => a)
  if (!starts05.length) return
  const nearest = (t) => starts05.reduce((p, a) => Math.abs(a - t) < Math.abs(p - t) ? a : p, starts05[0])

  const anchors = extractDialogueAnchors(lines.map((l) => ({ id: l.id, start: l.start, end: l.end, text: l.text })))
  const consumed = new Set(anchors.flatMap((a) => a.lineIds))
  const sectionOf = (start) => { let cur = null; for (const a of anchors) { if (a.start <= start + 1e-6) cur = a; else break } return cur }

  // ── 目标收集 ──
  // 1) 正文行深位：onset>1.2 且行 start 在岛内（主精修器的岛级手段管不了的行）
  // 2) interior 首句/锚点源行：上一行终点伸入包含岛 ≥0.7s 且 onset>1.2
  const interiorOf = (l) => {
    const idx = lines.findIndex((x) => x.id === l.id)
    if (idx <= 0) return false
    const is = islands.find(([a, b]) => l.start > a && l.start < b)
    return !!is && lines[idx - 1].end > is[0] + 0.7
  }
  const targets = []
  const addTarget = (l, kind) => {
    if (l.end - l.start < 1.0) return
    const key = keyOf(l.text)
    if (key.length < 2) return
    const is = islands.find(([a, b]) => l.start > a && l.start < b)
    if (!is) return
    targets.push({ line: l, kind, island: is, key })
  }
  for (const l of lines) {
    if (consumed.has(l.id)) continue
    const d = l.start - nearest(l.start)
    if (d > 1.2) addTarget(l, 'deep')
  }
  for (const a of anchors) {
    const opener = lines.find((l) => Math.abs(l.start - a.start) <= 0.06)
    if (opener && interiorOf(opener) && opener.start - nearest(opener.start) > 1.2) addTarget(opener, 'interior-anchor')
    const mine = lines.filter((l) => !consumed.has(l.id) && sectionOf(l.start) === a)
    if (mine.length) {
      const first = mine.reduce((p, l) => l.start < p.start ? l : p, mine[0])
      if (interiorOf(first) && first.start - nearest(first.start) > 1.2) addTarget(first, 'interior-first')
    }
  }
  if (!targets.length) return
  stats.targets += targets.length

  // ── 按岛分桶，岛内滑窗 ──
  const byIsland = new Map()
  for (const t of targets) {
    const k = t.island[0]
    if (!byIsland.has(k)) byIsland.set(k, [])
    byIsland.get(k).push(t)
  }
  // 预载主精修器的 -f 细分段缓存（同岛的免费窗）
  const preloaded = []
  const mainFiles = fs.existsSync(MAIN_CACHE) ? fs.readdirSync(MAIN_CACHE).filter((f) => f.startsWith(`l-${cid}-`) && f.endsWith('-f.txt')) : []
  for (const f of mainFiles) {
    const m = f.match(/^l-\d+-([\d.]+)-([\d.]+)-f\.txt$/)
    if (!m) continue
    preloaded.push({ a: +m[1], len: +m[2] - +m[1], toks: toks(fs.readFileSync(path.join(MAIN_CACHE, f), 'utf8')) })
  }

  const moves = []
  const detail = []
  const origStart = new Map(lines.map((l) => [l.id, l.start]))
  for (const [isStart, bucket] of byIsland) {
    const [isA, isB] = bucket[0].island
    // 岛内行序（数组序 = 转写文本序）：单调约束下逐行定位
    const ordered = [...bucket].sort((x, y) => x.line.start - y.line.start)
    let lowerBound = isA - 0.05
    // 非目标行也是序约束（其当前位置视为真值）
    const inIslandLines = lines.filter((l) => l.start > isA - 0.05 && l.start < isB)
    for (const t of ordered) {
      const { line, key } = t
      const hi = Math.min(line.start + 0.5, isB - 0.1)
      if (hi <= lowerBound + 0.2) { stats.skip++; continue }
      // 非目标邻居约束：本行与上一非目标行之间
      const prevNb = inIslandLines.filter((l) => l !== line && l.start < line.start).pop()
      if (prevNb && prevNb.start > lowerBound) lowerBound = Math.max(lowerBound, prevNb.start + 0.25)
      // 粗扫：滑 2.0s 窗、步 1.2s——网格锚定岛起点（与行位置无关），
      // 否则行移动后窗键漂移、每轮产生新窗且结果轻微不同，永不收敛（实测 33 门/50 行/轮）。
      let onset = null
      const coarse = []
      for (let k = 0; ; k++) {
        const a2 = r2(isA + k * 1.2)
        if (a2 >= isB - 0.4) break
        const len = r2(Math.min(2.0, isB - a2))
        if (len < 0.6) break
        if (a2 > hi + 1.5) break   // 行搜索上界之外不再扫
        coarse.push({ a: a2, len })
      }
      for (const p of preloaded) {
        if (p.a >= lowerBound - 0.3 && p.a + p.len <= isB + 0.5 && p.a < hi + 1.5) coarse.push({ a: p.a, len: p.len, toks: p.toks })
      }
      coarse.sort((x, y) => x.a - y.a)
      let hitWin = null
      for (const w of coarse) {
        const wt = w.toks ?? toks(await hearWindow(cid, audio, w.a, w.len))
        if (headHit(wt, key, 6) >= 0) { hitWin = { a: w.a, len: w.len }; break }
      }
      if (hitWin) {
        // 细化：窗内 +0/+0.75s 的 1.5s 探针，取最小头命中
        onset = hitWin.a
        for (const off of [0, 0.75]) {
          const t0 = r2(hitWin.a + off)
          if (t0 >= hitWin.a + hitWin.len - 0.2) break
          const wt = toks(await hearWindow(cid, audio, t0, 1.5))
          if (headHit(wt, key, 4) >= 0) { onset = t0; break }
          if (off === 0) onset = r2(hitWin.a + 0.75)
        }
        stats.refined++
      } else {
        stats.skip++
        if (DEBUG) console.log(`    SKIP-W #${cid} ${line.id}@${line.start.toFixed(1)} 岛[${isA},${isB}] key=${JSON.stringify(key)}`)
        continue
      }
      onset = r2(Math.max(onset, lowerBound))
      if (Math.abs(onset - line.start) < 0.35) { lowerBound = onset + 0.25; continue }
      detail.push(`${t.kind} ${line.start.toFixed(1)} → ${onset.toFixed(1)} 「${String(line.text).slice(0, 30)}」`)
      moves.push({ id: line.id, from: line.start, to: onset })
      line.start = onset
      line.end = r2(Math.max(line.end, onset + 0.8))
      lowerBound = onset + 0.25
      stats.pinned++
    }
  }
  if (!moves.length) return

  // ── 单调化（与主精修器同款收缩梯度） ──
  lines.sort((a, b) => a.start - b.start)
  const floorOf = (l) => Math.max(0.18, needOf(l) * 0.35 + 0.2)
  const seal = () => {
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i - 1]
      const l = lines[i]
      if (l.start < p.end - 0.001) {
        if (l.start - p.start >= needOf(p)) p.end = r2(l.start)
        else if (l.start - p.start >= floorOf(p)) p.end = r2(l.start)
        else l.start = r2(p.end)
      }
      if (l.end <= l.start) l.end = r2(l.start + 0.3)
    }
  }
  seal()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const need = needOf(l)
    if (l.end - l.start >= need - 0.01) continue
    const nextStart = i + 1 < lines.length ? lines[i + 1].start : duration
    if (nextStart - l.start >= need - 0.01) l.end = r2(l.start + need)
    else l.end = r2(Math.min(duration, l.start + Math.max(0.18, need * 0.35 + 0.2)))
  }
  seal()

  // 以 seal 之后的实际位移为准重列 moves：钉位被单调化推回的（前一行时长下限顶住）
  // 是稳定无操作，不计入变更，否则复跑永远显示同样的"变更"（实测 23 条/轮的假阳性）。
  const effective = lines
    .filter((l) => Math.abs((origStart.get(l.id) ?? l.start) - l.start) > 0.05)
    .map((l) => ({ id: l.id, from: r2(origStart.get(l.id)), to: l.start }))
  if (!effective.length) return
  payload.push({ cid, cat: row.category_id, title: row.title, moves: effective, lines })
  console.log(`#${cid}「${row.title}」滑窗钉位 ${effective.length} 行`)
  for (const d of detail.slice(0, 3)) console.log('   ' + d)
  if (detail.length > 3) console.log(`   …共 ${detail.length} 处`)
})
await Promise.all(jobs.map((j, i) => chains[i % 2](j)))

console.log(`\n══ ${payload.length} 门有变更；目标 ${stats.targets}，钉位 ${stats.pinned}（含细化 ${stats.refined}），放弃 ${stats.skip}`)
console.log(`══ MiMo 调用 ${calls}（失败 ${fails}）══`)
fs.writeFileSync(WORK, JSON.stringify(payload))
console.log(`已写出 ${WORK}（${APPLY ? '' : 'dry——加 --apply 落库'}）`)

if (APPLY) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const todayPrefix = `${today}.`
  const nextVersionOf = new Map()
  let ok = 0, failed = 0
  for (const { cid, cat, moves, lines } of payload) {
    const seedPath = seedOf(cat)
    if (!nextVersionOf.has(seedPath)) {
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
      nextVersionOf.set(seedPath, seed.version.startsWith(todayPrefix)
        ? `${todayPrefix}${Number(seed.version.slice(todayPrefix.length)) + 1}`
        : `${todayPrefix}1`)
    }
    const nextVersion = nextVersionOf.get(seedPath)
    try {
      await saveTranscript({
        conn, cid, lines, version: nextVersion, seedPath,
        expect: { lineDelta: [0, 0], note: `滑窗词级钉位：${moves.length} 行` },
        dryRun: false,
      })
      ok++
    } catch (e) { failed++; console.error(`✗ #${cid} ${e.message}`) }
  }
  console.log(`\n══ 落库 ${ok} 成功 / ${failed} 失败 ══`)
}
await conn.end()
