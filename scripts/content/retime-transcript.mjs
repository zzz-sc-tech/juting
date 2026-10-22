/**
 * 字幕时间轴重建：长停顿切块 + MiMo 出文本 + whisper 出时间。
 *
 * 为什么需要它（2026-10-21 复核结论）：
 *   whisper 对整段 20 分钟音频做分段时，段边界会横跨 15～20 秒的答题停顿；
 *   `buildAsrWordTimeline` 在段内按字符长度比例铺词，词被摊进静音；
 *   整句漏识的行再退化成插值，插值区间含停顿 → 被压到 0.5 秒。
 *   既有门禁（单调/重叠/负时长）只查时间戳自洽，查不出这类问题。
 *
 * 做法：
 *   1. 能量检测（-48 dBFS）得到语音岛，岛间隙 <0.35s 合并。
 *   2. 按 >3s 的长停顿切块，块内再按「最大停顿」切成 ≤55s 的小块——
 *      块内没有长停顿，whisper 的分段才落在真实语音上。
 *   3. 每个小块：whisper -ml 1 -sow 出词级时间；MiMo 出准确文本（有标点、不丢词）；
 *      MiMo 词 → whisper 词单调对齐，按 whisper **分段**锚点 + 段内字符比例定时。
 *   4. 全课 MiMo 词序 → seed 文本词对齐 → 行 start/end；
 *      未对齐行在前后锚点之间按词数分配。
 *   5. 轻吸附：行起止若离语音段边界 ≤0.45s 就贴过去。
 *
 * 用法（在仓库根目录跑）：
 *   node scripts/content/retime-transcript.mjs cet4 --ids 1038 --verbose
 *   node scripts/content/retime-transcript.mjs cet4 --apply
 *   node scripts/content/retime-transcript.mjs cet4 --no-resume   # 忽略缓存重算
 *
 * 依赖：
 *   - 本机 MySQL（127.0.0.1:3307）里 media_asr_jobs 有该课的成功任务（whisper 分段）
 *   - ~/.zcode/asr/mimo.key（MiMo ASR 凭证）
 *   - temp/asr/whisper-bin/Release/whisper-cli.exe + temp/asr/ggml-small-q5_1.bin
 *
 * 输出：temp/retime-cache/<cid>.json（缓存，可断点续跑）
 *       --apply 时另写 temp/retime-<key>.json，交给 apply-retime 落库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const key = process.argv[2] || 'cet4'
const APPLY = process.argv.includes('--apply')
const VERBOSE = process.argv.includes('--verbose')
const RESUME = !process.argv.includes('--no-resume')
const idsIdx = process.argv.indexOf('--ids')
const only = idsIdx >= 0 ? process.argv[idsIdx + 1].split(',').map(Number) : null

const SR = 16000
const FRAME = 0.05
const THRESH = 0.004
const GAP_MERGE = 0.35
const MIN_ISLAND = 0.12
const LONG_PAUSE = 3.0      // 切块停顿阈值
const BLOCK_MAX = 55        // 小块最长秒数（MiMo 60s 上限留余量）
const PAD = 0.20
const SEC_PER_WORD = 0.28
const WHISPER = 'temp/asr/whisper-bin/Release/whisper-cli.exe'
const MODEL = 'temp/asr/ggml-small-q5_1.bin'
const WORKERS = 2

const CACHE_VERSION = 4
const CACHE = 'temp/retime-cache'
const WORK = 'temp/retime-work'
fs.mkdirSync(CACHE, { recursive: true })
fs.mkdirSync(WORK, { recursive: true })

const seed = JSON.parse(fs.readFileSync(`presets/${key}/seed.json`, 'utf8'))
const lib = await import('./yuanwen-lib.mjs')

// ── MiMo（全局单并发，按文档教训）────────────────────────────
const MIMO_KEY = fs.readFileSync(path.join(os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
const MIMO_BASE = process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1'
let mimoChain = Promise.resolve()
let mimoCalls = 0, mimoFails = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
      const t = await res.text()
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`)
      const c = JSON.parse(t).choices?.[0]?.message?.content ?? ''
      if (c.trim()) return c.trim()
      throw new Error('空结果')
    } catch (e) {
      if (attempt === 3) throw e
      await sleep(1500 * (attempt + 1))
    }
  }
}
const mimo = (file) => {
  const p = mimoChain.then(async () => {
    mimoCalls++
    try { return await mimoRaw(file) }
    catch (e) { mimoFails++; throw e }
    finally { await sleep(120) }
  })
  mimoChain = p.catch(() => {})
  return p
}

// ── 工具 ────────────────────────────────────────────────────
const tokens = (t) => String(t).match(/[A-Za-z0-9']+/g) || []
const wordCount = (t) => (String(t).replace(/^[A-Z]:\s*/, '').match(/[a-zA-Z0-9']+/g) || []).filter((w) => w.length >= 2).length

const speechMask = (audioPath) => {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audioPath,
    '-ar', String(SR), '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 30 })
  const n = raw.length / 2
  const per = Math.round(SR * FRAME)
  const mask = []
  for (let i = 0; i + per <= n; i += per) {
    let sum = 0
    for (let j = i; j < i + per; j++) { const v = raw.readInt16LE(j * 2) / 32768; sum += v * v }
    mask.push(Math.sqrt(sum / per) >= THRESH ? 1 : 0)
  }
  return { mask, duration: n / SR }
}
const overlapOf = (mask, a, b) => {
  const i0 = Math.max(0, Math.floor(a / FRAME)), i1 = Math.min(mask.length, Math.ceil(b / FRAME))
  if (i1 <= i0) return 0
  let h = 0; for (let i = i0; i < i1; i++) h += mask[i]
  return h / (i1 - i0)
}

/** 语音岛 → 按长停顿切块 → 再切成 ≤BLOCK_MAX 的小块 */
const buildBlocks = (islands, duration) => {
  const chunks = []
  let cur = null
  for (const [a, b] of islands) {
    if (!cur) { cur = [a, b]; continue }
    if (a - cur[1] > LONG_PAUSE) { chunks.push(cur); cur = [a, b] }
    else cur[1] = b
  }
  if (cur) chunks.push(cur)
  // 块内再切分：超长时在「附近最大的岛间停顿」处切，避免切在句子中间
  const blocks = []
  for (const [ca, cb] of chunks) {
    const inside = islands.filter(([a, b]) => b > ca && a < cb)
    if (!inside.length) continue
    let start = 0
    while (start < inside.length) {
      const base = inside[start][0]
      // 找最远可达下标
      let end = start
      while (end + 1 < inside.length && inside[end + 1][1] - base <= BLOCK_MAX) end++
      if (end + 1 < inside.length) {
        // 在 [start+1, end] 里挑停顿最大的切点；没有就用 end
        let bestCut = end, bestGap = -1
        for (let k = start + 1; k <= end; k++) {
          const gap = inside[k][0] - inside[k - 1][1]
          if (gap > bestGap) { bestGap = gap; bestCut = k - 1 }
        }
        if (bestCut < start) bestCut = start
        blocks.push([inside[start][0], inside[bestCut][1]])
        start = bestCut + 1
      } else {
        blocks.push([inside[start][0], inside[end][1]])
        start = end + 1
      }
    }
  }
  return blocks.map(([a, b]) => [Math.max(0, a - PAD), Math.min(duration, b + PAD)])
}

// ── 单课处理 ────────────────────────────────────────────────
const processCourse = async (ex) => {
  const cacheFile = path.join(CACHE, `${ex.id}.json`)
  if (RESUME && fs.existsSync(cacheFile)) {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    if (c.version === CACHE_VERSION) return c
  }
  const audioPath = `presets/${key}/media/${ex.audio_object_name}`
  if (!fs.existsSync(audioPath)) return { cid: ex.id, error: 'audio missing' }

  const { mask, duration } = speechMask(audioPath)
  const islands = []
  {
    const tmp = []
    let st = null
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && st === null) st = i
      if (!mask[i] && st !== null) { tmp.push([st * FRAME, i * FRAME]); st = null }
    }
    if (st !== null) tmp.push([st * FRAME, mask.length * FRAME])
    for (const is of tmp) {
      const last = islands[islands.length - 1]
      if (last && is[0] - last[1] < GAP_MERGE) last[1] = is[1]
      else islands.push([...is])
    }
    for (let i = islands.length - 1; i >= 0; i--) if (islands[i][1] - islands[i][0] < MIN_ISLAND) islands.splice(i, 1)
  }
  if (!islands.length) return { cid: ex.id, error: 'no speech' }

  const blocks = buildBlocks(islands, duration)

  // 每个小块：whisper 词时间 + MiMo 文本 → MiMo 词时间
  const mimoWords = []
  const blockStats = []
  let whisperWords = 0, mimoChars = 0, mimoBlockFail = 0, alignHit = 0, alignTotal = 0

  for (let bi = 0; bi < blocks.length; bi++) {
    const [a, b] = blocks[bi]
    const tag = `${ex.id}-${bi}`
    const wav = path.join(WORK, `${tag}.wav`)
    const mp3 = path.join(WORK, `${tag}.mp3`)
    const base = path.join(WORK, `${tag}`)
    let wwords = []
    let mtext = ''
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(b - a),
        '-i', audioPath, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', wav, '-y'], { stdio: 'ignore' })
      execFileSync(WHISPER, ['-m', MODEL, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', base, '-nt', '-t', '8'], { stdio: 'ignore' })
      const tr = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')).transcription
      wwords = tr.map((s) => ({
        w: s.text.trim(),
        s: s.offsets.from / 1000 + a,
        e: s.offsets.to / 1000 + a,
      })).filter((x) => x.w && !/^[.,?!;:'"()\-–—]+$/.test(x.w) && !/^\[.*\]$/.test(x.w))
      whisperWords += wwords.length

      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(b - a),
        '-i', audioPath, '-ar', String(SR), '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
      mtext = await mimo(mp3)
      mimoChars += mtext.length
    } catch (e) {
      mimoBlockFail++
    } finally {
      for (const f of [wav, mp3, `${base}.json`]) fs.rmSync(f, { force: true })
    }

    const mw = tokens(mtext)
    blockStats.push({ a: +a.toFixed(1), b: +b.toFixed(1), wh: wwords.length, mi: mw.length, mtext: mtext.slice(0, 80) })
    if (!mw.length || !wwords.length) {
      // MiMo 失败/空 → 回退用 whisper 词（至少时间是对的）
      for (const x of wwords) mimoWords.push({ w: x.w, s: x.s, e: x.e, src: 'w' })
      continue
    }

    // 块内 MiMo 词 → 时间：按字符比例铺到该块覆盖的语音岛上（不依赖 whisper 词时间，
    // 因为短块内 whisper 会把整句塌缩到同一时间戳）
    const blockIslands = islands.filter(([ia, ib]) => ib > a && ia < b)
    const spansInBlock = blockIslands.length ? blockIslands : [[a, b]]
    const totalChars = mw.reduce((x, w) => x + w.length, 0) || 1
    let charAcc = 0
    const blockStart = spansInBlock[0][0]
    const blockEnd = spansInBlock[spansInBlock.length - 1][1]
    const toSpeechLocal = (t) => {
      let acc = 0
      for (const [ia, ib] of spansInBlock) {
        if (t < ia) return acc
        if (t <= ib) return acc + (t - ia)
        acc += ib - ia
      }
      return acc
    }
    const speechLen = spansInBlock.reduce((x, [ia, ib]) => x + (ib - ia), 0) || 1
    const fromSpeechLocal = (c) => {
      let acc = 0
      for (const [ia, ib] of spansInBlock) {
        const d = ib - ia
        if (c <= acc + d) return ia + Math.max(0, c - acc)
        acc += d
      }
      return blockEnd
    }
    alignTotal += mw.length
    alignHit += mw.length
    for (let i = 0; i < mw.length; i++) {
      const w = mw[i]
      const c0 = speechLen * (charAcc / totalChars)
      charAcc += w.length
      const c1 = speechLen * (charAcc / totalChars)
      mimoWords.push({ w, s: fromSpeechLocal(c0), e: fromSpeechLocal(c1), src: 'p' })
    }
  }

  // 未命中的 MiMo 词按前后命中词插值
  for (let i = 0; i < mimoWords.length; i++) {
    if (mimoWords[i].s !== null) continue
    let a = i - 1
    while (a >= 0 && mimoWords[a].s === null) a--
    let b = i + 1
    while (b < mimoWords.length && mimoWords[b].s === null) b++
    const lo = a >= 0 ? mimoWords[a].e : 0
    const hi = b < mimoWords.length ? mimoWords[b].s : duration
    const span = Math.max(0.05, (hi - lo) / Math.max(1, b - a))
    const off = i - a
    mimoWords[i].s = Math.min(hi, lo + span * (off - 0.5))
    mimoWords[i].e = Math.min(hi, lo + span * (off + 0.5))
  }

  // seed 文本词 → MiMo 词 → 行时间
  const textWords = []
  const lineOf = []
  for (const l of ex.transcript_json) {
    for (const w of tokens(String(l.text).replace(/^[A-Z]:\s*/, ''))) { textWords.push(w); lineOf.push(l.id) }
  }
  const { map: tmap } = lib.alignWordsWithAnchors(textWords, mimoWords.map((x) => x.w))

  const lineSpan = new Map()
  let lineHit = 0
  for (let i = 0; i < textWords.length; i++) {
    const j = tmap[i]
    if (j < 0 || !mimoWords[j] || mimoWords[j].s === null) continue
    lineHit++
    const lid = lineOf[i]
    const cur = lineSpan.get(lid)
    if (!cur) lineSpan.set(lid, { s: mimoWords[j].s, e: mimoWords[j].e })
    else { cur.s = Math.min(cur.s, mimoWords[j].s); cur.e = Math.max(cur.e, mimoWords[j].e) }
  }

  const lines = ex.transcript_json
  const spans = lines.map((l) => lineSpan.get(l.id) || null)

  // 未对齐行：铺进前后锚点之间（按词数）
  for (let i = 0; i < spans.length; i++) {
    if (spans[i]) continue
    let a = i - 1
    while (a >= 0 && !spans[a]) a--
    let b = i + 1
    while (b < spans.length && !spans[b]) b++
    const lo = a >= 0 ? spans[a].e : 0
    const hi = b < spans.length ? spans[b].s : duration
    const run = []
    for (let k = a + 1; k <= b - 1; k++) run.push(Math.max(1, wordCount(lines[k].text)))
    const totalW = run.reduce((x, y) => x + y, 0) || 1
    const avail = Math.max(hi - lo, run.length * 0.35)
    let cur = lo
    for (let k = a + 1; k <= b - 1; k++) {
      const share = (Math.max(1, wordCount(lines[k].text)) / totalW) * avail
      spans[k] = { s: cur, e: cur + Math.max(0.35, share) }
      cur = spans[k].e
    }
    i = b - 1
  }

  // 轻吸附：行起止若离某个语音段边界很近（≤0.45s），贴过去；否则保持
  {
    const TOL = 0.45
    const nearest = (t, pick) => {
      let best = null
      for (const [ia, ib] of islands) {
        const v = pick === 's' ? ia : ib
        const d = Math.abs(v - t)
        if (!best || d < best.d) best = { v, d }
      }
      return best && best.d <= TOL ? best.v : t
    }
    for (const sp of spans) {
      if (!sp) continue
      const ns = nearest(sp.s, 's')
      const ne = nearest(sp.e, 'e')
      if (ne > ns + 0.15) { sp.s = ns; sp.e = ne }
    }
  }

  // 单调化 + 最小时长（按词数，取 0.6 倍保守值）
  const out = []
  let prev = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const w = wordCount(l.text)
    const minDur = w >= 6 ? w * SEC_PER_WORD * 0.6 : 0.3
    let s = Math.max(spans[i].s, prev)
    let e = Math.max(spans[i].e, s + 0.25)
    if (e - s < minDur) e = Math.min(duration, s + minDur)
    if (e <= s) e = s + 0.25
    out.push({ ...l, start: +s.toFixed(2), end: +e.toFixed(2) })
    prev = out[i].end
  }

  // 指标
  let oldBad = 0, newBad = 0, oldSilent = 0, newSilent = 0, oldComp = 0, newComp = 0
  for (let i = 0; i < out.length; i++) {
    const o = lines[i], n = out[i]
    const ovO = overlapOf(mask, o.start, o.end), ovN = overlapOf(mask, n.start, n.end)
    if (ovO < 0.2) oldBad++
    if (ovN < 0.2) newBad++
    if (ovO === 0) oldSilent++
    if (ovN === 0) newSilent++
    const w = wordCount(o.text)
    if (w >= 6 && o.end - o.start < w * SEC_PER_WORD * 0.35) oldComp++
    if (w >= 6 && n.end - n.start < w * SEC_PER_WORD * 0.35) newComp++
  }

  const result = {
    version: CACHE_VERSION,
    cid: ex.id,
    title: ex.title,
    blocks: blocks.length,
    lines: out.length,
    whisperWords,
    mimoWords: mimoWords.length,
    mimoChars,
    mimoBlockFail,
    alignRate: alignTotal ? alignHit / alignTotal : 0,
    lineHitRate: textWords.length ? lineHit / textWords.length : 0,
    oldBad, newBad, oldSilent, newSilent, oldComp, newComp,
    blockStats,
    out,
  }
  fs.writeFileSync(cacheFile, JSON.stringify(result))
  return result
}

// ── 主循环（2 并发）─────────────────────────────────────────
const targets = seed.exercises.filter((e) => !only || only.includes(e.id))
const results = []
let idx = 0
const worker = async () => {
  while (true) {
    const i = idx++
    if (i >= targets.length) break
    const ex = targets[i]
    const t0 = Date.now()
    try {
      const r = await processCourse(ex)
      results.push(r)
      if (r.error) { console.log(`✗ #${r.cid} ${r.error}`); continue }
      const secs = ((Date.now() - t0) / 1000).toFixed(0)
      console.log(`✓ #${r.cid} ${r.title} 块${r.blocks} 行${r.lines} 对齐${(100 * r.alignRate).toFixed(0)}% 行命中${(100 * r.lineHitRate).toFixed(0)}% | ov ${r.oldBad}→${r.newBad} 静音 ${r.oldSilent}→${r.newSilent} 压缩 ${r.oldComp}→${r.newComp} (${secs}s)`)
      if (VERBOSE) {
        for (const l of r.out) {
          const o = ex.transcript_json.find((x) => x.id === l.id)
          if (o && Math.abs(l.start - o.start) > 5) console.log(`    ${l.id} ${o.start.toFixed(1)}→${l.start.toFixed(1)} 「${l.text.slice(0, 45)}」`)
        }
      }
    } catch (e) {
      console.log(`✗ #${ex.id} ${e.message.slice(0, 120)}`)
      results.push({ cid: ex.id, error: e.message })
    }
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker))

const ok = results.filter((r) => !r.error)
const sum = (f) => ok.reduce((s, r) => s + (r[f] ?? 0), 0)
console.log(`\n══ ${ok.length}/${targets.length} 课完成，MiMo 调用 ${mimoCalls}（失败 ${mimoFails}）══`)
console.log(`语音重叠<20%   ${sum('oldBad')} → ${sum('newBad')}`)
console.log(`完全静音       ${sum('oldSilent')} → ${sum('newSilent')}`)
console.log(`压缩           ${sum('oldComp')} → ${sum('newComp')}`)
console.log(`MiMo 对齐率    ${(100 * sum('alignRate') / Math.max(1, ok.length)).toFixed(1)}%`)
console.log(`行命中率       ${(100 * sum('lineHitRate') / Math.max(1, ok.length)).toFixed(1)}%`)

if (APPLY) {
  fs.writeFileSync(`temp/retime-${key}.json`, JSON.stringify(ok.map((r) => ({ cid: r.cid, lines: r.out })), null, 1))
  console.log(`\n已写出 temp/retime-${key}.json`)
}
