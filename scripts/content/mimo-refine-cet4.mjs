/**
 * 四级：MiMo 逐岛转写精修题干/播报行时间（对齐六级 11.6 的做法）。
 *
 * 背景：全量岛审计发现四级 1631 条题干/播报行中 53 条偏晚（截开头，最重
 * 6.8s——#1012/#1024 整套题干晚 5~6s）+ 179 条偏早。四级走的是 retime 管线
 * （MiMo 按块出文本、词按字符比例铺岛），同样的比例假设缺陷。
 *
 * 与六级差异：
 *  - 数据源是 DB 里的**已有课程**，写回必须走 data-contract 的 saveTranscript
 *    契约通道（先 dry 后 apply，expect.lineDelta=[0,0]，行数字段一律不动），
 *    不能像六级新课那样整包 upsert；
 *  - 只精修审计标记的错位行（±1.2s 之外）所在的区域，控制调用量。
 *
 * 用法：
 *   node scripts/content/mimo-refine-cet4.mjs --dry
 *   node scripts/content/mimo-refine-cet4.mjs --apply
 * 落库后：check-invariants --rebuild-baseline + 全门禁。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const APPLY = process.argv.includes('--apply')
const ONLY = (() => { const i = process.argv.indexOf('--ids'); return i >= 0 ? process.argv[i + 1].split(',').filter(Boolean).map(Number) : null })()

const SR = 16000
const FRAME = 0.05
const THRESH = 0.004
const MIN_CALL_ISLAND = 0.7
const FLAG_TOL = 1.2
const MIMO_KEY = fs.readFileSync(path.join(os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
const MIMO_BASE = process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1'
const CACHE = 'temp/mimo-refine-cache4'
const STORE = 'temp/runtime/media-store/duolinting-media'
const WORK = 'temp/mimo-cet4-out.json'
fs.mkdirSync(CACHE, { recursive: true })

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
      if (res.status === 429) { await sleep(4000 * (attempt + 1)); continue }
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
}
/** 双并发：两条串行链交替领课 */
const makeChain = () => {
  let p = Promise.resolve()
  return (fn) => new Promise((resolve, reject) => {
    p = p.then(async () => { try { resolve(await fn()) } catch (e) { reject(e) } })
    p = p.catch(() => {})
  })
}

const speechIslands = (audio) => {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audio,
    '-ar', String(SR), '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 30 })
  const n = raw.length / 2
  const per = Math.round(SR * FRAME)
  const mask = []
  for (let i = 0; i + per <= n; i += per) {
    let s = 0
    for (let j = 0; j < per; j++) { const v = raw.readInt16LE((i + j) * 2) / 32768; s += v * v }
    mask.push(Math.sqrt(s / per) >= THRESH ? 1 : 0)
  }
  const rawIs = []
  let st = null
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && st === null) st = i
    if (!mask[i] && st !== null) { rawIs.push([st * FRAME, i * FRAME]); st = null }
  }
  if (st !== null) rawIs.push([st * FRAME, mask.length * FRAME])
  const islands = []
  for (const is of rawIs) {
    const last = islands[islands.length - 1]
    if (last && is[0] - last[1] < 0.35) last[1] = is[1]
    else islands.push([...is])
  }
  for (let i = islands.length - 1; i >= 0; i--) if (islands[i][1] - islands[i][0] < 0.12) islands.splice(i, 1)
  return { islands, duration: n / SR }
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
const Q_LABEL = /^(?:Q\s*(\d+)|Question\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\s](?:one|two|three|four|five))?))[.。:：,，]?\s*/i
const isSnap = (t) => Q_LABEL.test(String(t).trim()) || /based\s+on/i.test(t)
const needOf = (ln) => {
  const wc = toks(String(ln.text).replace(/^[A-Z]{1,3}:\s*/, '')).filter((w) => w.length >= 2).length
  return Math.min(Math.max(wc * 0.28, 0.3), 20)
}

const conn = await connect()
const [rows] = await conn.query("select id, title, audio_object_name, transcript_json from exercises where category_id = 9 order by id")
const targets = rows.filter((r) => !ONLY || ONLY.includes(r.id))
console.log(`四级 ${targets.length} 门待精修（${APPLY ? 'APPLY' : 'DRY'}）`)

const payload = []
const chains = [makeChain(), makeChain()]
const jobs = targets.map((row, idx) => async () => {
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const audio = path.join(STORE, row.audio_object_name)
  if (!fs.existsSync(audio)) { console.error(`✗ #${row.id} 无音频`); return }
  const { islands, duration } = speechIslands(audio)
  const starts = islands.map(([a]) => a)
  const nearest = (t) => starts.reduce((p, a) => Math.abs(a - t) < Math.abs(p - t) ? a : p, starts[0])
  // 只精修错位行
  const flagged = lines.filter((l) => isSnap(l.text) && Math.abs(l.start - nearest(l.start)) > FLAG_TOL)
  if (!flagged.length) return
  const regions = []
  for (const l of flagged) {
    const r = regions[regions.length - 1]
    if (r && l.start - 8 <= r.hi) r.hi = Math.max(r.hi, l.end + 8)
    else regions.push({ lo: Math.max(0, l.start - 8), hi: Math.min(duration, l.end + 8) })
  }
  const islandsTxt = new Map()
  for (const r of regions) {
    for (let idx = 0; idx < islands.length; idx++) {
      const [a, e2] = islands[idx]
      if (e2 <= r.lo || a >= r.hi || e2 - a < MIN_CALL_ISLAND || islandsTxt.has(idx)) continue
      const id = `c4-${row.id}-${a.toFixed(2)}-${e2.toFixed(2)}`
      const cf = path.join(CACHE, id + '.txt')
      if (fs.existsSync(cf)) { islandsTxt.set(idx, fs.readFileSync(cf, 'utf8')); continue }
      const mp3 = path.join(CACHE, id + '.mp3')
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(e2 - a),
        '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
      let text = ''
      try { text = await mimoRaw(mp3); calls++ } catch { text = '' }
      fs.writeFileSync(cf, text)
      fs.rmSync(mp3, { force: true })
      islandsTxt.set(idx, text)
    }
  }
  const tokCache = new Map()
  const islandToks = (idx) => {
    if (!tokCache.has(idx)) tokCache.set(idx, toks(islandsTxt.get(idx) ?? ''))
    return tokCache.get(idx)
  }
  /** 返回 {len, pos}：needle 在岛 token 里的最长连续命中及其位置 */
  const hitAt = (ct, needle) => {
    let best = { len: 0, pos: -1 }
    for (let k = 0; k + Math.min(needle.length, 4) <= ct.length; k++) {
      let q = 0
      for (let t = 0; t < Math.min(needle.length, 8); t++) { if (k + t < ct.length && ct[k + t] === needle[t]) q++; else break }
      if (q > best.len) best = { len: q, pos: k }
    }
    return best
  }
  // ── 匹配池：{start, end, text}（细分后的岛取代原岛）──
  const pool = []
  for (const [idx, txt] of islandsTxt) pool.push({ start: islands[idx][0], end: islands[idx][1], text: txt })
  const poolToks = pool.map((c) => toks(c.text))

  /** 细分一个岛：窗口内重算能量，按 0.18s 间隙切，逐段转写 */
  const fineSplit = async (c) => {
    const out = []
    try {
      const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(c.start), '-t', String(c.end - c.start),
        '-i', audio, '-ar', String(SR), '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 28 })
      const n = raw.length / 2
      const per = Math.round(SR * FRAME)
      const mask = []
      for (let i = 0; i + per <= n; i += per) {
        let sq = 0
        for (let j = 0; j < per; j++) { const v = raw.readInt16LE((i + j) * 2) / 32768; sq += v * v }
        mask.push(Math.sqrt(sq / per) >= THRESH ? 1 : 0)
      }
      const rawIs = []
      let st = null
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] && st === null) st = i
        if (!mask[i] && st !== null) { rawIs.push([st * FRAME + c.start, i * FRAME + c.start]); st = null }
      }
      if (st !== null) rawIs.push([st * FRAME + c.start, mask.length * FRAME + c.start])
      const subs = []
      for (const is of rawIs) {
        const last = subs[subs.length - 1]
        if (last && is[0] - last[1] < 0.18) last[1] = is[1]
        else subs.push([...is])
      }
      for (const [a, e2] of subs) {
        if (e2 - a < 0.4) continue
        const id = `c4-${row.id}-${a.toFixed(2)}-${e2.toFixed(2)}-f`
        const cf = path.join(CACHE, id + '.txt')
        let text = ''
        if (fs.existsSync(cf)) text = fs.readFileSync(cf, 'utf8')
        else {
          const mp3 = path.join(CACHE, id + '.mp3')
          execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(e2 - a),
            '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
          try { text = await mimoRaw(mp3); calls++ } catch { text = '' }
          fs.writeFileSync(cf, text)
          fs.rmSync(mp3, { force: true })
        }
        out.push({ start: +a.toFixed(2), end: +e2.toFixed(2), text })
      }
    } catch { /* 细分失败就退回整岛 */ }
    return out.length ? out : [c]
  }

  // 第一遍：粗匹配，找需要细分的岛（同岛多行 或 正文前还有别的内容）
  const pre = []
  for (const l of flagged) {
    const raw = String(l.text).trim()
    const body = raw.replace(Q_LABEL, '').replace(/^[^a-z0-9]+/i, '')
    const lt = toks(body)
    if (lt.length < 3) continue
    let best = null
    for (let ci = 0; ci < pool.length; ci++) {
      if (!pool[ci].text) continue
      const h = hitAt(poolToks[ci], lt)
      if (h.len < Math.min(lt.length, 4)) continue
      const d = Math.abs(pool[ci].start - l.start)
      if (d > 10) continue
      if (!best || d < best.d) best = { ci, d, pos: h.pos }
    }
    pre.push({ l, raw, lt, best })
  }
  const byIsland = new Map()
  for (const it of pre) {
    if (!it.best) continue
    const arr = byIsland.get(it.best.ci) ?? []
    arr.push(it)
    byIsland.set(it.best.ci, arr)
  }
  const splitMap = new Map() // 原 ci → 细分后的池条目数组
  for (const [ci, items] of byIsland) {
    const needSplit = items.length >= 2 || items.some((it) => it.best.pos >= 4)
    if (!needSplit) continue
    const subs = await fineSplit(pool[ci])
    splitMap.set(ci, subs)
  }
  if (splitMap.size) {
    // 重建池：替换被细分的岛
    const newPool = []
    for (let ci = 0; ci < pool.length; ci++) {
      const subs = splitMap.get(ci)
      if (subs) { for (const sub of subs) { newPool.push(sub) } } else newPool.push(pool[ci])
    }
    pool.length = 0
    pool.push(...newPool)
    poolToks.length = 0
    poolToks.push(...pool.map((c) => toks(c.text)))
  }

  // 第二遍：正式匹配（时间序 + 认领岛起点，防相邻行抢同岛）
  const claimed = new Set()
  const order = [...pre].sort((a, b) => a.l.start - b.l.start)
  let moved = 0
  const detail = []
  for (const it of order) {
    const { l, raw, lt } = it
    let best = null
    for (let ci = 0; ci < pool.length; ci++) {
      if (!pool[ci].text) continue
      const h = hitAt(poolToks[ci], lt)
      if (h.len < Math.min(lt.length, 4)) continue
      const d = Math.abs(pool[ci].start - l.start)
      if (d > 10) continue
      if (!best || d < best.d) best = { ci, d }
    }
    // 标签岛兜底（±20s）
    if (!best) {
      const qm = raw.match(Q_LABEL)
      if (qm) {
        const n = numOf(qm[1] ?? qm[2])
        for (let ci = 0; ci < pool.length; ci++) {
          if (!pool[ci].text) continue
          if (Math.abs(pool[ci].start - l.start) > 20) continue
          const kt = poolToks[ci]
          for (let t = 0; t < kt.length - 1; t++) {
            if ((kt[t] === 'question' || kt[t] === 'questions') && numOf(kt[t + 1]) === n
              && kt[t + 2] !== 'to' && kt[t + 2] !== 'through') { best = { ci, d: Math.abs(pool[ci].start - l.start) }; break }
          }
          if (best) break
        }
      }
      if (!best) continue
    }
    // 认领：被占的岛换下一个含正文的空岛
    if (claimed.has(pool[best.ci].start)) {
      let alt = null
      for (let ci = 0; ci < pool.length; ci++) {
        if (!pool[ci].text || claimed.has(pool[ci].start)) continue
        const h = hitAt(poolToks[ci], lt)
        if (h.len < Math.min(lt.length, 4)) continue
        const d = Math.abs(pool[ci].start - l.start)
        if (d > 10) continue
        if (!alt || d < alt.d) alt = { ci, d }
      }
      if (alt) best = alt
    }
    // 位置占岛（匹配失败也防后行抢占）
    for (const c of pool) {
      if (claimed.has(c.start)) continue
      if (Math.abs(c.start - l.start) <= 1.2) { claimed.add(c.start); break }
    }
    const target = pool[best.ci]
    if (claimed.has(target.start)) continue
    let onset = target.start
    let end = target.end
    // 题号标签岛回溯（排除组播报）
    const qm = raw.match(Q_LABEL)
    if (qm) {
      const n = numOf(qm[1] ?? qm[2])
      for (let ci = best.ci - 1; ci >= 0 && pool[best.ci].start - pool[ci].end <= 3.5; ci--) {
        const kt = poolToks[ci]
        for (let t = 0; t < kt.length - 1; t++) {
          if ((kt[t] === 'question' || kt[t] === 'questions') && numOf(kt[t + 1]) === n) {
            if (kt[t + 2] === 'to' || kt[t + 2] === 'through') break
            if (!claimed.has(pool[ci].start)) { onset = pool[ci].start; end = target.end }
            ci = -1
            break
          }
        }
        if (ci === -1) break
      }
    }
    claimed.add(onset)
    if (Math.abs(onset - l.start) <= 0.15) continue
    detail.push(`${l.start.toFixed(1)} → ${onset.toFixed(1)} 「${raw.slice(0, 34)}」`)
    l.start = +onset.toFixed(2)
    l.end = +Math.max(end, onset + 0.8).toFixed(2)
    moved++
  }

  // 单调化（数组顺序 = 时间顺序）+ 时长下限
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1]
    const l = lines[i]
    if (l.start < p.end - 0.001) {
      if (l.start - p.start >= needOf(p)) p.end = +l.start.toFixed(2)
      else l.start = +p.end.toFixed(2)
    }
    if (l.end <= l.start) l.end = +(l.start + 0.3).toFixed(2)
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const need = needOf(l)
    if (l.end - l.start >= need - 0.01) continue
    const nextStart = i + 1 < lines.length ? lines[i + 1].start : duration
    if (nextStart - l.start >= need - 0.01) l.end = +(l.start + need).toFixed(2)
    else l.end = +Math.min(duration, l.start + Math.max(0.18, need * 0.35 + 0.2)).toFixed(2)
  }
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1]
    const l = lines[i]
    if (l.start < p.end - 0.001) {
      if (l.start - p.start >= needOf(p)) p.end = +l.start.toFixed(2)
      else l.start = +p.end.toFixed(2)
    }
    if (l.end <= l.start) l.end = +(l.start + 0.3).toFixed(2)
  }
  if (moved) {
    payload.push({ cid: row.id, lines, moved })
    console.log(`#${row.id}「${row.title}」错位 ${flagged.length} → 修正 ${moved}`)
    for (const d of detail.slice(0, 4)) console.log('   ' + d)
  }
})
await Promise.all(jobs.map((j, i) => chains[i % 2](j)))

console.log(`\n══ ${payload.length} 门有修正；共移动 ${payload.reduce((s, p) => s + p.moved, 0)} 行；MiMo 调用 ${calls}（失败 ${fails}）══`)
fs.writeFileSync(WORK, JSON.stringify(payload.map(({ cid, lines }) => ({ cid, lines }))))
console.log(`已写出 ${WORK}`)

if (APPLY) {
  const seedPath = 'presets/cet4/seed.json'
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const todayPrefix = `${today}.`
  const nextVersion = seed.version.startsWith(todayPrefix)
    ? `${todayPrefix}${Number(seed.version.slice(todayPrefix.length)) + 1}`
    : `${todayPrefix}1`
  console.log(`seed cet4 v${seed.version} → v${nextVersion}（${payload.length} 课）`)
  let ok = 0, failed = 0
  for (const { cid, lines } of payload) {
    const old = seed.exercises.find((e) => e.id === cid)
    if (!old || old.transcript_json.length !== lines.length) { console.error(`✗ #${cid} 行数不一致`); failed++; continue }
    const merged = old.transcript_json.map((o, i) => ({ ...o, start: lines[i].start, end: lines[i].end }))
    try {
      await saveTranscript({
        conn, cid, lines: merged, version: nextVersion, seedPath,
        expect: { lineDelta: [0, 0], note: 'MiMo 逐岛精修题干/播报行时间' },
        dryRun: false,
      })
      ok++
    } catch (e) { failed++; console.error(`✗ #${cid} ${e.message}`) }
  }
  console.log(`\n══ 落库 ${ok} 成功 / ${failed} 失败（v${nextVersion}）══`)
}
await conn.end()
