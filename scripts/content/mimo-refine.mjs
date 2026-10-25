/**
 * 用 MiMo 逐岛转写精修题干/播报行的时间（新建课程管线的收尾精修步）。
 *
 * 为什么需要：岛级钉位只保证行起点落在**某个**岛起点上，两种情况修不了——
 * ① 行的真实起点在岛中部（与前句间隔 0.4~1.2s，能量岛按 0.35s 阈值合并了）；
 * ② whisper 把该句转写丢了（词序匹配失败，行只能插值）。
 * MiMo 文本比 whisper 准得多但不出时间戳——所以把音频**按岛切开逐岛转写**：
 * 哪个岛的文本包含该行正文，起点就是那个岛的起点；题号标签（"Question one."）
 * 常独立占一个岛，回溯取标签岛的起点。
 *
 * 注意不能按间隙合并成簇再转写：对话的话轮间隙与播报前间隙同为 ~1.1s，
 * 合并链会把整段对话吞成一簇（实测 #53 播报被「修正」到 8 秒前）。
 *
 * 只处理题干/播报行（锚点与逐句点击的目标）；正文行已由 DP 对齐覆盖。
 * 每岛转写带缓存（temp/mimo-refine-cache/），重跑只补缺。
 *
 * 用法：
 *   node scripts/content/mimo-refine.mjs --dir temp/cet6-1516           # 预演（只报告）
 *   node scripts/content/mimo-refine.mjs --dir temp/cet6-1516 --apply   # 写回 temp/incoming-transcripts.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const argOf = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const dir = argOf('--dir')
const APPLY = process.argv.includes('--apply')
const ONLY = argOf('--ids')?.split(',').filter(Boolean) ?? null
if (!dir) { console.error('用法：node scripts/content/mimo-refine.mjs --dir <目录> [--ids k1,k2] [--apply]'); process.exit(2) }

const SR = 16000
const FRAME = 0.05
const THRESH = 0.004
const GAP_MERGE = 0.35
const MIN_ISLAND = 0.12
const MIN_CALL_ISLAND = 0.7 // <0.7s 的岛不转写（题干至少 1.5s，只有标签词时命中靠邻岛）
const MIMO_KEY = fs.readFileSync(path.join(os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
const MIMO_BASE = process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1'
const CACHE = 'temp/mimo-refine-cache'
fs.mkdirSync(CACHE, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let calls = 0, fails = 0
const mimo = async (file) => {
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
    if (last && is[0] - last[1] < GAP_MERGE) last[1] = is[1]
    else islands.push([...is])
  }
  for (let i = islands.length - 1; i >= 0; i--) if (islands[i][1] - islands[i][0] < MIN_ISLAND) islands.splice(i, 1)
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
const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '')
/** 数字词归一（twelve→12、twenty three→23）：MiMo 常写英文数字、行文本是阿拉伯数字，
 *  不归一的话播报行正文匹配不上（实测 "Questions 12 to 15" vs "Questions twelve to fifteen"） */
const normToks = (arr) => {
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const a = numOf(arr[i]) !== null ? String(numOf(arr[i])) : norm(arr[i])
    if (a === '20' || a === '30') {
      const bNext = i + 1 < arr.length ? numOf(arr[i + 1]) : null
      if (bNext !== null && bNext < 10 && numOf(arr[i + 1]) !== 20 && numOf(arr[i + 1]) !== 30) { out.push(String(20 + bNext)); i++; continue }
    }
    if (a) out.push(a)
  }
  return out
}
const toks = (t) => normToks(String(t).split(/[^A-Za-z0-9]+/).filter(Boolean))
const Q_LABEL = /^(?:Q\s*(\d+)|Question\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\s](?:one|two|three|four|five))?))[.。:：,，]\s*/i
const isSnap = (t) => Q_LABEL.test(String(t).trim()) || /based\s+on/i.test(t)

const built = JSON.parse(fs.readFileSync('temp/incoming-transcripts.json', 'utf8'))
let moved = 0, kept = 0, noMatch = 0

const run = async () => {
for (const b of built) {
  if (ONLY && !ONLY.includes(b.key)) continue
  const audio = path.join(dir, 'audio', `${b.key}.ogg`)
  const { islands, duration } = speechIslands(audio)
  const cands = b.lines.map((l, i) => ({ i, l })).filter(({ l }) => isSnap(l.text))
  // 区域：候选行 ±8s 合并 → 区域内的岛逐个转写
  const regions = []
  for (const { l } of cands) {
    const r = regions[regions.length - 1]
    if (r && l.start - 8 <= r.hi) r.hi = Math.max(r.hi, l.end + 8)
    else regions.push({ lo: Math.max(0, l.start - 8), hi: Math.min(duration, l.end + 8) })
  }
  const islandsTxt = new Map() // 岛下标 → MiMo 文本
  for (const r of regions) {
    for (let idx = 0; idx < islands.length; idx++) {
      const [a, e2] = islands[idx]
      if (e2 <= r.lo || a >= r.hi) continue
      if (e2 - a < MIN_CALL_ISLAND || islandsTxt.has(idx)) continue
      const id = `${b.key}-${a.toFixed(2)}-${e2.toFixed(2)}`
      const cf = path.join(CACHE, id + '.txt')
      if (fs.existsSync(cf)) { islandsTxt.set(idx, fs.readFileSync(cf, 'utf8')); continue }
      const mp3 = path.join(CACHE, id + '.mp3')
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(e2 - a),
        '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
      let text = ''
      try { text = await mimo(mp3); calls++ } catch { text = '' }
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
  /** 岛 token 里是否包含 needle 前 min(4,len) 词的连续序列，返回最长命中 */
  const hitLen = (idx, needle) => {
    const ct = islandToks(idx)
    let best = 0
    for (let k = 0; k + Math.min(needle.length, 4) <= ct.length; k++) {
      let q = 0
      for (let t = 0; t < Math.min(needle.length, 8); t++) { if (k + t < ct.length && ct[k + t] === needle[t]) q++; else break }
      if (q > best) best = q
    }
    return best
  }

  const corrected = []
  for (const { i, l } of cands) {
    const raw = String(l.text).trim()
    const body = raw.replace(Q_LABEL, '').replace(/^[^a-z0-9]+/i, '')
    const lt = toks(body)
    if (lt.length < 3) continue
    // 正文匹配：命中前 4 词的岛里取离当前定位最近的
    let best = null
    for (const [idx, txt] of islandsTxt) {
      if (!txt) continue
      const h = hitLen(idx, lt)
      if (h < Math.min(lt.length, 4)) continue
      const d = Math.abs(islands[idx][0] - l.start)
      if (d > 10) continue // 距离上限：题干正文多是通用句式（"What does the man say…"），远处同名岛会串位（实测 Q1 配到 25s 外 Q3 的岛）
      if (!best || d < best.d) best = { idx, d }
    }
    if (!best) {
      // 兜底：只搜题号标签岛（"Question sixteen."），窗口放宽到 ±20s。
      // 仍要排除组播报（题号后跟 to）。实测 2016-06-1 的 Q16 正文匹配失败
      // （其岛在区域之外），标签岛在 20s 内能找到。
      const qm2 = raw.match(Q_LABEL)
      if (qm2) {
        const n = numOf(qm2[1] ?? qm2[2])
        let lab = null
        for (const [idx, txt] of islandsTxt) {
          if (!txt) continue
          const kt = islandToks(idx)
          if (Math.abs(islands[idx][0] - l.start) > 20) continue
          for (let t = 0; t < kt.length - 1; t++) {
            if ((kt[t] === 'question' || kt[t] === 'questions') && numOf(kt[t + 1]) === n
              && kt[t + 2] !== 'to' && kt[t + 2] !== 'through') { lab = idx; break }
          }
          if (lab !== null) break
        }
        if (lab !== null) {
          best = { idx: lab, d: Math.abs(islands[lab][0] - l.start) }
        }
      }
      if (!best) { noMatch++; continue }
    }
    let onset = islands[best.idx][0]
    let end = islands[best.idx][1]
    // 题号标签岛回溯：标签（"Question one."）常独立成岛，在正文岛之前 3.5s 内
    const qm = raw.match(Q_LABEL)
    if (qm) {
      const n = numOf(qm[1] ?? qm[2])
      for (let k = best.idx - 1; k >= 0 && islands[best.idx][0] - islands[k][1] <= 3.5; k--) {
        const kt = islandToks(k)
        for (let t = 0; t < kt.length - 1; t++) {
          if ((kt[t] === 'question' || kt[t] === 'questions') && numOf(kt[t + 1]) === n) {
            // 排除组播报："Questions one TO four…"的 "questions one" 不是 Q1 的
            // 标签（实测 2016-12-1 的 Q1 被拉回播报起点，真实在 169.9）
            if (kt[t + 2] === 'to' || kt[t + 2] === 'through') break
            onset = islands[k][0]
            k = -1
            break
          }
        }
        if (k === -1) break
      }
    }
    if (Math.abs(onset - l.start) <= 0.15 && Math.abs(end - l.end) <= 1.0) { kept++; continue }
    corrected.push({ from: l.start, to: onset, text: l.text })
    l.start = +onset.toFixed(2)
    l.end = +Math.max(end, onset + 0.8).toFixed(2)
    moved++
  }
  // 单调化：重叠时收回前一行终点（不得低于其可读时长）
  const needOf = (ln) => {
    const wc = toks(String(ln.text).replace(/^[A-Z]{1,3}:\s*/, '')).filter((w) => w.length >= 2).length
    return Math.min(Math.max(wc * 0.28, 0.3), 20)
  }
  b.lines.sort((x, y) => x.start - y.start)
  for (let i = 1; i < b.lines.length; i++) {
    const p = b.lines[i - 1]
    const l = b.lines[i]
    if (l.start < p.end) {
      if (l.start - p.start >= needOf(p)) p.end = +l.start.toFixed(2)
      else l.start = +p.end.toFixed(2)
    }
    if (l.end <= l.start) l.end = +(l.start + 0.3).toFixed(2)
  }
  // 时长下限：修正后的终点是岛尾，长题干可能被压短（实测 13 词题干只剩 1.1s
  // 触发时长门禁）——与构建管线同规则补足
  for (let i = 0; i < b.lines.length; i++) {
    const l = b.lines[i]
    const need = needOf(l)
    if (l.end - l.start >= need - 0.01) continue
    const nextStart = i + 1 < b.lines.length ? b.lines[i + 1].start : duration
    if (nextStart - l.start >= need - 0.01) l.end = +(l.start + need).toFixed(2)
    else l.end = +Math.min(duration, l.start + Math.max(0.18, need * 0.35 + 0.2)).toFixed(2)
  }
  // 最终严格单调化（补足可能造成 0.1~0.2s 重叠残留）
  for (let i = 1; i < b.lines.length; i++) {
    const p = b.lines[i - 1]
    const l = b.lines[i]
    if (l.start < p.end - 0.001) {
      if (l.start - p.start >= needOf(p)) p.end = +l.start.toFixed(2)
      else l.start = +p.end.toFixed(2)
    }
    if (l.end <= l.start) l.end = +(l.start + 0.3).toFixed(2)
  }
  for (let i = 0; i < b.lines.length; i++) b.lines[i].id = `l${i + 1}`
  if (corrected.length) {
    console.log(`${b.key}: 修正 ${corrected.length} 行`)
    for (const c of corrected.slice(0, 10)) console.log(`   ${c.from.toFixed(1)} → ${c.to.toFixed(1)}  「${String(c.text).slice(0, 40)}」`)
  }
}

console.log(`\n══ 移动 ${moved} 行 / 保持 ${kept} / 无匹配 ${noMatch}；MiMo 调用 ${calls} 次（失败 ${fails}）══`)
if (APPLY) {
  fs.writeFileSync('temp/incoming-transcripts.json', JSON.stringify(built, null, 1))
  console.log('已写回 temp/incoming-transcripts.json')
}
}
run()
