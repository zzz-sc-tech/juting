/**
 * 从「听力原文 md + 音频」生成字幕行（新建课程用）。
 *
 * 与 retime-transcript.mjs 的区别：
 *   - retime 是「已有字幕行，只重算时间」；本脚本是「没有字幕，从原文造」。
 *   - 文本以 md 为准（官方原文），不需要 MiMo；MiMo 只在 md 缺失时才有意义。
 *
 * 为什么要切块：
 *   whisper 对整段 20 分钟音频分段时，段边界会横跨 15～20 秒答题停顿，
 *   buildAsrWordTimeline 在段内按字符比例铺词 → 词被摊进静音。
 *   按 >3s 停顿切块后，块内没有长停顿，段边界落在真实语音上。
 *
 * 用法：
 *   node scripts/content/build-transcript-from-md.mjs --dir temp/cet6-1516
 *   node scripts/content/build-transcript-from-md.mjs --dir temp/cet6-1516 --ids cet6-2015-06-1
 *   node scripts/content/build-transcript-from-md.mjs --dir temp/cet6-1516 --apply
 *
 * 输出：temp/incoming-transcripts.json（{key, lines, stats}[]）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseYuanwenMd, buildAsrWordTimeline, synthesizeTranscript, MIN_HIT_RATE } from './yuanwen-lib.mjs'

const argOf = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const dir = argOf('--dir')
const APPLY = process.argv.includes('--apply')
const ONLY = argOf('--ids')?.split(',').filter(Boolean) ?? null
if (!dir) { console.error('用法：node scripts/content/build-transcript-from-md.mjs --dir <目录> [--ids k1,k2] [--apply]'); process.exit(2) }

const SR = 16000
const FRAME = 0.05
const THRESH = 0.004
const GAP_MERGE = 0.35
const MIN_ISLAND = 0.12
const LONG_PAUSE = 3.0
const BLOCK_MAX = 55
const PAD = 0.20
const WHISPER = 'temp/asr/whisper-bin/Release/whisper-cli.exe'
const MODEL = 'temp/asr/ggml-small-q5_1.bin'
const WORK = 'temp/build-work'
fs.mkdirSync(WORK, { recursive: true })

const speechMask = (audioPath) => {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audioPath,
    '-ar', String(SR), '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 30 })
  const n = raw.length / 2
  const per = Math.round(SR * FRAME)
  const mask = []
  for (let i = 0; i + per <= n; i += per) {
    let s = 0
    for (let j = i; j < i + per; j++) { const v = raw.readInt16LE(j * 2) / 32768; s += v * v }
    mask.push(Math.sqrt(s / per) >= THRESH ? 1 : 0)
  }
  return { mask, duration: n / SR }
}

const buildIslands = (mask) => {
  const raw = []
  let st = null
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && st === null) st = i
    if (!mask[i] && st !== null) { raw.push([st * FRAME, i * FRAME]); st = null }
  }
  if (st !== null) raw.push([st * FRAME, mask.length * FRAME])
  const merged = []
  for (const is of raw) {
    const last = merged[merged.length - 1]
    if (last && is[0] - last[1] < GAP_MERGE) last[1] = is[1]
    else merged.push([...is])
  }
  return merged.filter(([a, b]) => b - a >= MIN_ISLAND)
}

/** 长停顿切块 → 块内按最大停顿再切 ≤BLOCK_MAX */
const buildBlocks = (islands, duration) => {
  const chunks = []
  let cur = null
  for (const [a, b] of islands) {
    if (!cur) { cur = [a, b]; continue }
    if (a - cur[1] > LONG_PAUSE) { chunks.push(cur); cur = [a, b] }
    else cur[1] = b
  }
  if (cur) chunks.push(cur)
  const blocks = []
  for (const [ca, cb] of chunks) {
    const inside = islands.filter(([a, b]) => b > ca && a < cb)
    if (!inside.length) continue
    let start = 0
    while (start < inside.length) {
      const base = inside[start][0]
      let end = start
      while (end + 1 < inside.length && inside[end + 1][1] - base <= BLOCK_MAX) end++
      if (end + 1 < inside.length) {
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

/**
 * 行级时间修正（synthesizeTranscript 之后跑）。
 *
 * 为什么要补这一步：
 *   synthesizeTranscript 把「未命中行」的 end 取成「下一处命中点」，导致：
 *     · 未命中行（题干、播报句）被拉长到吞掉中间整段；
 *     · 它后面的命中行只能挤在极短窗口里（实测前几行 0.5 秒）。
 *   这里按词数重新分配每行时长，并在语音岛上吸附边界。
 */
const refineTiming = (lines, mask, islands, duration) => {
  const SEC_PER_WORD = 0.28
  const wordCount = (t) => (String(t).replace(/^[A-Z]{1,3}:\s*/, '').match(/[a-zA-Z0-9']+/g) || []).filter((w) => w.length >= 2).length
  // 按**时间**排序处理，不按数组顺序。
  // md 把题干堆在末尾时（2016-12 两套），数组顺序 ≠ 时间顺序：
  // 若按数组顺序推进 prevEnd，题干会被推到音频末尾。
  const order = lines.map((l, i) => ({ i, start: Number(l.start) || 0 }))
    .sort((a, b) => a.start - b.start)
  const byOrig = new Map()
  const overlap = (a, b) => {
    const i0 = Math.max(0, Math.floor(a / FRAME))
    const i1 = Math.min(mask.length, Math.ceil(b / FRAME))
    if (i1 <= i0) return 0
    let h = 0
    for (let i = i0; i < i1; i++) h += mask[i]
    return h / (i1 - i0)
  }
  const nearest = (t, kind, tol = 0.45) => {
    let best = null
    for (const [ia, ib] of islands) {
      const v = kind === 's' ? ia : ib
      const d = Math.abs(v - t)
      if (!best || d < best.d) best = { v, d }
    }
    return best && best.d <= tol ? best.v : t
  }

  const out = []
  let prevEnd = 0
  for (const { i } of order) {
    const l = lines[i]
    const words = wordCount(l.text)
    // 播报/节次这类短标签行给固定短时长；正文按词数
    const isLabel = /^(Section [A-D]|Conversation \d|Passage \d|Recording \d|News Report \d)$/i.test(String(l.text).trim())
    const want = isLabel ? 0.9 : Math.min(Math.max(words * SEC_PER_WORD, 0.45), 30)
    // 只允许「极小的回退」，不能把整行推到上一行之后：
    // locateQuestions 给出的题干时间来自音频锚点，是权威值；
    // 若这里用 max(l.start, prevEnd) 强行单调，题干会被推离真实位置。
    let s = l.start
    if (s < prevEnd - 0.5) s = Math.max(l.start, prevEnd - 0.5)
    else if (s < prevEnd) s = prevEnd
    s = nearest(s, 's')
    if (s < prevEnd - 0.5) s = prevEnd
    // 若这一行整个落在静音里，从 cursor 往后找下一个语音段起点。
    // 不这样做的话，连续多行会挤在同一个静音区间里，
    // 整段正文被压成几秒（实测 #55 有 20+ 行被压进 6 秒）。
    if (overlap(s, s + Math.max(0.3, want)) < 0.15) {
      for (const [a] of islands) {
        if (a >= s - 0.05) { s = Math.max(a, prevEnd); break }
      }
    }
    // 从 s 起向后累计 want 秒的真实语音（允许 ≤0.6s 的句内停顿）
    let acc = 0, cursor = s, k = islands.findIndex(([a, b]) => s >= a - 0.06 && s <= b + 0.06)
    if (k < 0) k = islands.findIndex(([a]) => a > s)
    if (k < 0) k = islands.length - 1
    while (k < islands.length && acc < want) {
      const [a, b] = islands[k]
      const from = Math.max(a, cursor)
      if (from > cursor && from - cursor > 0.6 && acc > 0) break
      const take = Math.min(b - from, want - acc)
      acc += take
      cursor = from + take
      if (acc >= want - 1e-6) break
      k++
    }
    let e = acc >= want * 0.5 ? cursor : Math.min(duration, s + want)
    e = nearest(e, 'e')
    if (e <= s) e = Math.min(duration, s + Math.max(0.3, want))
    if (e <= s) e = s + 0.3
    byOrig.set(i, { start: +s.toFixed(2), end: +e.toFixed(2) })
    prevEnd = e
  }
  // 按原始数组顺序输出（行 id 与 md 顺序一致）
  for (let i = 0; i < lines.length; i++) {
    const t = byOrig.get(i) ?? { start: lines[i].start, end: lines[i].end }
    out.push({ id: `l${i + 1}`, start: t.start, end: t.end, text: lines[i].text })
  }
  return out
}

/**
 * 题干行按「Question N」播报点重新定位。
 *
 * 为什么要做：md 写 "Q1."、音频念 "Question one,"，DTW 对不齐标签词；
 * 更糟的是题干正文常与对话里的相似句子误配（实测 Q1 的正文配到了对话里
 * "…your main area of research"，行被插值到对话中间）。这里用**词级**
 * 「question + 题号」相邻序列做锚点，把行起点钉到真实播报处。
 *
 * 锚点分两种：题组播报（"Questions 16 to 18 are based on…"）和题干播报
 * （"Question 16, what does…"）。优先题干播报（组播报只是兜底）——
 * 组播报比题干早 5~10s，钉上去字幕会压在播报上。
 * 找不到锚点就保持 DTW/插值结果，不按题号比例瞎猜（实测全错）。
 */
const NUM_WORD = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five']
const numOf = (raw) => {
  const t = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (/^\d+$/.test(t)) return Number(t)
  const i = NUM_WORD.indexOf(t)
  return i >= 0 ? i + 1 : null
}
const normWord = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '')

const locateQuestions = (lines, wordSegs) => {
  const anchors = []
  for (let i = 0; i < wordSegs.length; i++) {
    if (!/^questions?$/.test(normWord(wordSegs[i].text))) continue
    for (let k = 1; k <= 2 && i + k < wordSegs.length; k++) {
      const raw = normWord(wordSegs[i + k].text)
      if (!raw) continue
      if (raw === 'number') continue // "Question number 8" 这类插入词
      const n = numOf(raw)
      if (n && n >= 1 && n <= 25) {
        // 组播报："Questions 16 to 18" → 号后面紧跟 "to"
        const isGroup = k + 1 <= 2 && i + k + 1 < wordSegs.length
          && normWord(wordSegs[i + k + 1].text) === 'to'
        anchors.push({ n, group: isGroup, start: wordSegs[i].start, end: wordSegs[i + k].end })
      }
      break
    }
  }

  const Q_RE = /^(?:Q\s*(\d+)|Question\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\s](?:one|two|three|four|five))?))\s*[.:,，]?/i
  const qNumOf = (text) => {
    const m = String(text).trim().match(Q_RE)
    if (!m) return null
    if (m[1]) return Number(m[1])
    return numOf(String(m[2]).toLowerCase().replace(/\s+/g, '-'))
  }

  // 题干逐题号处理（音频里播报是升序的）
  const result = lines.map((l) => ({ ...l }))
  const qIdx = []
  result.forEach((l, i) => { if (qNumOf(l.text)) qIdx.push(i) })
  qIdx.sort((a, b) => (qNumOf(result[a].text) ?? 99) - (qNumOf(result[b].text) ?? 99))
  const used = new Set()
  const anchorAt = new Map() // 题号 -> 钉到的起点
  let cursor = 0
  for (const i of qIdx) {
    const n = qNumOf(result[i].text)
    const hit = anchors.find((a) => a.n === n && !a.group && !used.has(a.start)
        && a.start >= cursor - 0.5)
      ?? anchors.find((a) => a.n === n && a.group && !used.has(a.start) && a.start >= cursor - 0.5)
    if (!hit) continue
    used.add(hit.start)
    cursor = hit.start
    anchorAt.set(n, hit.start)
    // 只钉行起点；结束点交给 refineTiming 按词数铺
    result[i].start = +hit.start.toFixed(2)
    result[i].end = +Math.max(hit.end, hit.start + 0.8).toFixed(2)
  }

  // 没锚点的题干（whisper 漏转写播报，实测 2016-06-1 的 "Question 9" 整句丢失）
  // 用前后已锚定题干的时间线性内插——被邻居夹住，不会像全局比例那样灾难性错位。
  for (const i of qIdx) {
    const n = qNumOf(result[i].text)
    if (!n || anchorAt.has(n)) continue
    let prevN = null; let nextN = null
    for (const k of anchorAt.keys()) { if (k < n && (prevN === null || k > prevN)) prevN = k }
    for (const k of anchorAt.keys()) { if (k > n && (nextN === null || k < nextN)) nextN = k }
    let est = null
    if (prevN !== null && nextN !== null) {
      const f = (n - prevN) / (nextN - prevN)
      est = anchorAt.get(prevN) + f * (anchorAt.get(nextN) - anchorAt.get(prevN))
    } else if (prevN !== null) {
      est = anchorAt.get(prevN) + (result[qIdx.find((j) => qNumOf(result[j].text) === prevN)].end - anchorAt.get(prevN)) + 1
    } else if (nextN !== null) {
      est = Math.max(0, anchorAt.get(nextN) - 8)
    }
    if (est === null) continue
    result[i].start = +est.toFixed(2)
    result[i].end = +(est + 0.8).toFixed(2)
  }
  return result
}

/**
 * 钉位后的题干去重：fillLongGaps 会把 ASR 念的题干（"Question one, …"）
 * 补回时间轴，与钉好位的 md 题干（"Q1. …"）同文异形，一题出现两行。
 * 按**题号**判重（正文归一不可靠：whisper 常把 "layers" 转成 "layer"，
 * 键对不上就漏删）。md 的 "Qn." 行优先保留；组播报（"…based on…"）不是题干，不删。
 */
const dedupeQuestions = (lines) => {
  const qNumOfLine = (t) => {
    const m = String(t).trim().match(/^(?:Q\s*(\d+)|Question\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[\s-](?:one|two|three|four|five))?))\s*[.:,，]/i)
    if (!m) return null
    if (m[1]) return Number(m[1])
    return numOf(String(m[2]).toLowerCase().replace(/\s+/g, '-'))
  }
  // 第一遍：收集 md（Qn. 形式）已覆盖的题号
  const mdNums = new Set()
  for (const l of lines) {
    if (/^Q\s*\d+\s*[.。:：]/.test(String(l.text).trim())) {
      const n = qNumOfLine(l.text)
      if (n) mdNums.add(n)
    }
  }
  // 第二遍：只去重 Question 形式的补充行——号已在 md 里、或补充行内部重复 → 丢弃。
  // 另删「播报+题干」粘旧行：fillLongGaps 填隙时，播报与题干间隙 <0.6s 会连成
  // 一条（"…you have just heard. Question nine, what does…"），其两半都已有
  // 独立行，纯重复。
  const seen = new Set()
  const out = []
  for (const l of lines) {
    const t = String(l.text).trim()
    // 泛化：播报句（…are based on the recording/conversation/passage…）出现在行中部
    // 就是粘旧行（填隙把上一句尾巴和播报连成一条），两半均已有独立行
    if (/\.\s*[Qq]uestions?\s+\S+\s*(?:to|-|–)\s*\S+\s+are\s+based\s+on/i.test(t)) continue
    if (/you have just heard\.\s*questions?\s/i.test(t)) continue
    const n = qNumOfLine(t)
    const isMdForm = /^Q\s*\d+\s*[.。:：]/.test(t)
    if (n && !isMdForm && !/based\s+on/i.test(t)) {
      if (mdNums.has(n) || seen.has(n)) continue
      seen.add(n)
    }
    out.push(l)
  }
  // 填隙碎片去重：whisper 重复转写/切开题干时，fillLongGaps 会在邻近塞进
  // 碎片行（实测 "devil's tower look like?"、Q22 的尾巴 "is Mel Wilson going
  // to talk about…"——48 字符，按长度上限拦不住）。判据改为不限长度：
  // 归一文本是 ±30s 内更长行的子串 → 删。
  const keyOf = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '')
  return out.filter((l) => {
    const k = keyOf(l.text)
    if (k.length < 10) return true
    if (/^Q\s*\d+/.test(String(l.text).trim())) return true
    // 不限距离：去重发生在线时间定型之前，碎片行此时可能还挂在别处
    //（实测 Q14 的尾巴碎片在去重时点距 Q14 行 40s+，30s 窗口放行了它）
    return !out.some((o) => {
      const K = keyOf(o.text)
      return K !== k && K.length > k.length && K.includes(k)
    })
  })
}

/**
 * 未朗读行收尾：把「落在静音里」的行压到相邻语音边界。
 *
 * 六级真题里 Q1–Q8 的题干常常**不朗读**（只印在试卷上），Q9 之后才念。
 * 这类行如果强行铺时间，就会占住一整段静音，点「播放本句」什么也听不到。
 * 做法：整行落在静音里 → 压成贴住下一段语音起点的极短行（0.3s）。
 * 这样它在精听里不抢戏，锚点也仍然存在。
 */
const snapSilentLines = (lines, mask, islands, duration) => {
  const FRAME_S = FRAME
  const overlap = (a, b) => {
    const i0 = Math.max(0, Math.floor(a / FRAME_S))
    const i1 = Math.min(mask.length, Math.ceil(b / FRAME_S))
    if (i1 <= i0) return 0
    let h = 0
    for (let i = i0; i < i1; i++) h += mask[i]
    return h / (i1 - i0)
  }
  const nextIslandStart = (t) => {
    // 只认 ≥0.5s 的岛：答题停顿里的呼吸/爆音会形成 0.1~0.3s 的幻影岛，
    // 钉上去等于把行压在噪声上（实测 #53 一行正文被钉到 158s 的噪声）
    for (const [a, b] of islands) if (b - a >= 0.5 && a >= t - 0.05) return a
    return null
  }
  const out = lines.map((l) => ({ ...l }))
  // 按时间顺序处理（数组顺序在「题干堆末尾」的 md 里不等于时间顺序）
  const order = out.map((l, i) => ({ i, start: Number(l.start) || 0 })).sort((a, b) => a.start - b.start)
  let cursor = 0
  for (const { i } of order) {
    const l = out[i]
    if (overlap(l.start, l.end) >= 0.15) { cursor = Math.max(cursor, l.end); continue }
    // 从 cursor 起找语音段起点（不是从 l.start 起）。
    // 若从 l.start 起找，连续多行落在同一静音区时会全部贴到同一个点，
    // 整段正文被压成几秒（实测 #55/#60 各有 20+ 行被压进 6 秒）。
    const ns = nextIslandStart(Math.max(l.start, cursor))
    if (ns === null) continue
    const isLabel = /^(Section [A-D]|Conversation \d|Passage \d|Recording \d|News Report \d)$/i.test(String(l.text).trim())
    const isQuestion = /^(?:Q\d+|Question\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))\b/i.test(String(l.text).trim())
    const words = (String(l.text).match(/[a-zA-Z0-9']+/g) || []).filter((w) => w.length >= 2).length
    const minDur = isLabel || isQuestion ? 0.3 : Math.min(Math.max(words * 0.28 * 0.6, 1.0), 20)
    const s = Math.min(Math.max(ns, cursor), duration - minDur)
    l.start = +s.toFixed(2)
    l.end = +Math.min(duration, s + minDur).toFixed(2)
    cursor = l.end
  }
  // 最终按**时间**排序输出，并强制单调。
  //
  // 为什么不再按数组顺序：2016-12 两套的 md 把 25 个题干全堆在文件末尾，
  // 数组顺序 ≠ 时间顺序。之前按数组顺序压单调，把题干全推到音频尾部
  // （实测 Q16–Q25 全落在 1550–1597s，而它们实际分布在 1060–1550s）。
  // 字幕的展示顺序本来就该是时间顺序，按时间重排是正确的。
  out.sort((a, b) => a.start - b.start)
  const needOf = (ln) => {
    const wc = (String(ln.text).replace(/^[A-Z]{1,3}:\s*/, '').match(/[a-zA-Z0-9']+/g) || [])
      .filter((w) => w.length >= 2).length
    const isShort = /^(Section [A-D]|Conversation \d|Passage \d|Recording \d|News Report \d|Q\d+|Question\s)/i.test(String(ln.text).trim())
    return isShort ? 0.3 : Math.min(Math.max(wc * 0.28, 0.3), 20)
  }
  for (let idx = 0; idx < out.length; idx++) {
    const l = out[idx]
    const p = out[idx - 1]
    if (l.start < (p?.end ?? 0)) {
      // 重叠时优先**收回前一行的终点**而不是推后本行起点：前一行的终点是
      // 词数铺排/岛累计撑出来的弹性值，而钉位行的起点是音频实测 onset。
      // 实测 2015-06-3 的 Q1 终点（铺排 173.1）压住 Q2 真实起点 171.4，
      // 旧钳制把 Q2 推到 173.1 → 点 Q2 少听 1.7 秒开头。
      // 但收回不得低于前一行自身的可读时长（实测 #55 的 11 词播报被压到
      // 0.62s 触发时长门禁）——不满足就退回推后本行。
      if (p && l.start - p.start >= needOf(p)) p.end = +l.start.toFixed(2)
      else l.start = +(p?.end ?? 0).toFixed(2)
    }
    if (l.end <= l.start) l.end = +(l.start + 0.3).toFixed(2)
    // 时长门禁：一行至少 词数×0.28s（可读速度）。被相邻行夹扁的短句
    // （实测 0.01~0.07s）：有空隙直接补足；没空隙给到 门禁压缩线的下限
    // （预期×0.35，check-duration-sanity 的 FAIL 线是 >10词/s），
    // 后续行起点顺延——级联量 ≤0.25s，被句后静音吸收，撞不到钉位题干。
    const need = needOf(l)
    if (l.end - l.start < need - 0.01) {
      const nextStart = idx + 1 < out.length ? out[idx + 1].start : duration
      if (nextStart - l.start >= need - 0.01) {
        l.end = +(l.start + need).toFixed(2)
      } else {
        const floor = Math.max(0.18, need * 0.35 + 0.2)
        l.end = +Math.min(duration, l.start + floor).toFixed(2)
      }
    }
  }
  // 邻近题干的碎片行清理（时间定型后跑）：fillLongGaps 塞进来的题干残片与
  // 题干正文常有转写差异（whisper 写 "a speaker"、md 是 "the speaker"），
  // 子串判重失效；按「±12s 内有题干行 + 词重叠 ≥70%」删。
  const tokSet = (t) => new Set(String(t).toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length >= 3))
  const qRowsAll = out.filter((x) => /^Q\s*\d+/.test(String(x.text).trim()))
  for (let i = out.length - 1; i >= 0; i--) {
    const l = out[i]
    const t = String(l.text).trim()
    if (/^(Q\s*\d+|Question\s|Section |Conversation |Passage |Recording |News Report |[WM]:)/i.test(t)) continue
    const lt = tokSet(t)
    if (lt.size < 3) continue
    const near = qRowsAll.find((q) => Math.abs(q.start - l.start) <= 12 && q !== l)
    if (!near) continue
    const qt = tokSet(near.text.replace(/^Q\s*\d+[.。:：]?\s*/i, ''))
    let hit = 0
    for (const w of lt) if (qt.has(w)) hit++
    if (hit / lt.size >= 0.7) out.splice(i, 1)
  }
  // 重编号（id 必须与展示顺序一致）
  for (let i = 0; i < out.length; i++) out[i].id = `l${i + 1}`
  return out
}

/**
 * 「题干全堆在文件末尾」的 md 排版矫正。
 *
 * 实测 cet6-2016-12 两套的 md 把 25 个题干全写在文件末尾（音频里题干是逐题
 * 朗读的、分布在整个时间轴上）。synthesizeTranscript 按 md 顺序插值，
 * 题干块会被铺到时间轴尾部；同时 ASR 念出的题干（"Question one, …"）因为
 * 与错位的 md 题干没对上，又被 extractAnnouncementRows 当播报行补回 → 同一题
 * 出现两行，且单调钳制把整块推得更乱。
 *
 * 根治办法：合成前把题干搬回各自单元的正文之后。归属依据是音频里的题组播报
 * （"Questions 16 to 18 are based on …"，按时间排序后与 md 单元顺序一一对应）
 * ——音频词图优先级高于 md 排版，符合事实源仲裁顺序。
 */
const GROUP_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 }
const groupNumOf = (s) => {
  const t = String(s).toLowerCase().replace(/[\s-]+/g, '')
  if (/^\d+$/.test(t)) return +t
  return GROUP_NUM[t] ?? NaN
}
const GROUP_RE = new RegExp(
  '\\bquestions?\\s+(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve' +
  '|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[\\s-](?:one|two|three|four|five))?)' +
  '\\s*(?:to|through|[-\u2013\u2014])\\s*(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve' +
  '|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[\\s-](?:one|two|three|four|five))?)' +
  '\\b[^.?!]{0,90}?based\\s+on', 'i')
const interleaveStackedQuestions = (mdText, segments) => {
  const lines = mdText.split('\n')
  const qIdx = []
  lines.forEach((ln, i) => { if (/^Q\d+[.。:：]/.test(ln.trim())) qIdx.push(i) })
  // 只有「题干构成文件末尾的连续区段」才需要搬；题干已内联的 md 不动
  const stacked = qIdx.length >= 20 && qIdx[qIdx.length - 1] === lines.length - 1
    && qIdx.every((v, k) => k === 0 || v === qIdx[k - 1] + 1)
  if (!stacked) return mdText
  console.error('  [题干堆末尾] 25 题堆在文件末尾，按题组播报搬回各单元正文后')

  // 1) 音频题组播报 → 范围表（按时间排序、同范围去重）
  const groups = []
  for (const s of segments) {
    const m = String(s.text).match(GROUP_RE)
    if (!m) continue
    const a = groupNumOf(m[1]); const b = groupNumOf(m[2])
    if (!(a >= 1 && b >= a && b <= 25)) continue
    if (groups.some((g) => g.a === a && g.b === b)) continue
    groups.push({ a, b, start: s.start })
  }
  groups.sort((x, y) => x.start - y.start)
  // whisper 偶尔把题组播报转写丢半句（实测 2016-12-2 的 "Questions 19 to 22" 只剩
  // 尾巴 "you have just heard"）。两个已知组之间缺的那段编号就是缺失的题组，
  // 唯一可推 → 补上；推不出的（缺 1..k 或 k..25）放弃搬动。
  const filled = []
  for (let k = 0; k < groups.length; k++) {
    filled.push(groups[k])
    const nextA = k + 1 < groups.length ? groups[k + 1].a : null
    if (nextA !== null && nextA > groups[k].b + 1) {
      const runA = groups[k].b + 1; const runB = nextA - 1
      if (runA === 1 || runB === 25) {
        console.error(`  [题干堆末尾] 缺失题组 ${runA}-${runB} 触及边界，无法唯一定位，放弃搬动`)
        return mdText
      }
      filled.push({ a: runA, b: runB, start: null })
    }
  }
  const covered = filled.length > 0 && filled[0].a === 1
    && filled.every((g, k) => g.b === (k + 1 < filled.length ? filled[k + 1].a - 1 : 25))

  // 2) md 单元头（Conversation/Passage/Recording/News Report），按出现顺序
  const units = []
  lines.forEach((ln, i) => {
    const m = ln.match(/^##\s+((?:Conversation|Passage|Recording|News Report)\s+\d+)\s*$/i)
    if (m) units.push({ name: m[1], headerIdx: i })
  })
  if (!covered || filled.length !== units.length) {
    console.error(`  [题干堆末尾] 题组 ${filled.length} 个（补齐后）/ md 单元 ${units.length} 个对不上，放弃搬动（保持原 md）`)
    return mdText
  }

  // 3) 每个单元的题干插到「正文结束处」：下一个 ## 头之前（最后一个单元即题干块之前）
  const inserts = new Map()
  units.forEach((u, k) => {
    let end = qIdx[0]
    for (let i = u.headerIdx + 1; i < qIdx[0]; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break }
    }
    const qLines = []
    for (let n = filled[k].a; n <= filled[k].b; n++) qLines.push(lines[qIdx[n - 1]])
    inserts.set(u.headerIdx, { end, qLines })
  })

  // 4) 重组：抽掉原题干块，在插入点写回
  const qSet = new Set(qIdx)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (qSet.has(i)) continue
    out.push(lines[i])
    const ins = inserts.get(i)
    if (ins && i < ins.end) for (const q of ins.qLines) out.push(q)
  }
  return out.join('\n')
}

/**
 * whisper 转写缓存：只存每块的**词文本**（词的时间戳不可信，见下）。
 *
 * 为什么不要 whisper 的时间：whisper-cli 的 token 时间戳是量化预测值，
 * 短块里会把一句话摊满整个 30s 窗口（实测 "College" 一个词占了 3.8s）。
 * retime-transcript.mjs 验证过的做法：whisper 只出文本与顺序，
 * 时间由「块内语音岛 + 字符比例」重建。
 */
const loadBlockWords = (set, audio, blocks) => {
  const cache = path.join(WORK, `${set.key}.segments.json`)
  const st = fs.statSync(audio)
  const sig = `${st.size}-${Math.round(st.mtimeMs)}`
  if (fs.existsSync(cache)) {
    try {
      const c = JSON.parse(fs.readFileSync(cache, 'utf8'))
      if (c.sig === sig && c.cacheVersion === 3 && JSON.stringify(c.blocks) === JSON.stringify(blocks.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]))) {
        return c.words
      }
    } catch { /* 坏缓存按无缓存处理 */ }
  }
  const words = []
  for (let bi = 0; bi < blocks.length; bi++) {
    const [a, b] = blocks[bi]
    const wav = path.join(WORK, `${set.key}-${bi}.wav`)
    const base = path.join(WORK, `${set.key}-${bi}`)
    const toks = []
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(b - a),
        '-i', audio, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', wav, '-y'], { stdio: 'ignore' })
      execFileSync(WHISPER, ['-m', MODEL, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', base, '-nt', '-t', '8'], { stdio: 'ignore' })
      const tr = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')).transcription
      for (const s of tr) {
        const txt = String(s.text || '').trim()
        if (!txt || /^\[.*\]$/.test(txt)) continue
        if (/^[.,?!;:'"()\-–—]+$/.test(txt)) continue
        toks.push(txt)
      }
    } finally {
      for (const f of [wav, `${base}.json`]) fs.rmSync(f, { force: true })
    }
    words.push(toks)
  }
  fs.writeFileSync(cache, JSON.stringify({
    sig, cacheVersion: 3,
    blocks: blocks.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]),
    words,
  }))
  return words
}

/**
 * 块内词 → 时间：词组与语音岛做 DP 对齐。
 *
 * 旧做法（按字符比例匀铺）对连续对话误差 ≤1s，但对「慢对话 + 紧跟快播报」的块
 * 系统性失准——实测 #53：题组播报的词被铺到 146.5s（真实语音 148.5s 起），
 * Q1 题干铺到 152.5s（真实 154.1s 起），逐句播放错位 2 秒多。
 *
 * 词序（whisper 转写顺序）和岛时长（能量检测）都是事实，唯一的自由度是
 * 「哪几个词落在哪个岛」。DP 目标：每岛的词组时长与岛时长相对误差最小，
 * 且语速落在 1.2~4.5 词/s 的合理区间。岛可以分不到词（呼吸/噪声），
 * 词必须全部落岛。DP 无解（词太多/岛太短）时退回字符比例铺排。
 */
const placeBlockWords = (toks, block, islands) => {
  const [a, b] = block
  const blockIslands = islands.filter(([ia, ib]) => ib > a && ia < b)
  const spans = blockIslands.length ? blockIslands : [[a, b]]
  const speechLen = spans.reduce((x, [ia, ib]) => x + (ib - ia), 0) || 1
  const totalChars = toks.reduce((x, w) => x + w.length, 0) || 1
  const charRate = speechLen / totalChars

  const prefix = [0]
  for (const w of toks) prefix.push(prefix[prefix.length - 1] + w.length)
  const durOf = (i, n) => Math.max(0.12, (prefix[i + n] - prefix[i]) * charRate)
  const dur = spans.map(([ia, ib]) => ib - ia)

  const N = toks.length
  const M = spans.length
  const INF = 1e18
  const dp = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(INF))
  const take = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0))
  dp[0][0] = 0
  for (let j = 0; j < M; j++) {
    for (let i = 0; i <= N; i++) {
      if (dp[i][j] >= INF) continue
      // n = 0：岛不分词（呼吸/噪声），小成本
      if (dp[i][j] + 0.02 < dp[i][j + 1]) { dp[i][j + 1] = dp[i][j] + 0.02; take[i][j + 1] = 0 }
      for (let n = 1; i + n <= N; n++) {
        const pred = durOf(i, n)
        if (pred > dur[j] * 1.9 + 0.35 && n >= 2) break // 预测时长超岛 90% 就不可能
        const wps = n / dur[j]
        let c = ((pred - dur[j]) / Math.max(0.25, dur[j])) ** 2
        if (wps > 4.5) c += 10 * (wps - 4.5)
        if (wps < 1.2) c += 6 * (1.2 - wps)
        if (dp[i][j] + c < dp[i + n][j + 1]) { dp[i + n][j + 1] = dp[i][j] + c; take[i + n][j + 1] = n }
      }
    }
  }

  let out
  if (dp[N][M] < INF) {
    // 回溯：每岛分到的词组，岛内按字符比例铺
    const assign = new Array(M)
    let i = N; let j = M
    while (j > 0) {
      const n = take[i][j]
      assign[j - 1] = n
      i -= n
      j -= 1
    }
    out = []
    for (let s = 0; s < M; s++) {
      const n = assign[s] ?? 0
      if (!n) continue
      const wi = out.length
      const chars = prefix[wi + n] - prefix[wi]
      let acc = 0
      for (let k = 0; k < n; k++) {
        const c0 = (acc / chars) * dur[s]
        acc += toks[wi + k].length
        const c1 = (acc / chars) * dur[s]
        const st = spans[s][0] + c0
        out.push({ start: +st.toFixed(3), end: +(spans[s][0] + c1).toFixed(3), text: toks[wi + k] })
      }
    }
  } else {
    // 退回：字符比例铺（与 retime 相同的旧逻辑）
    const fromSpeechLocal = (c) => {
      let acc = 0
      for (const [ia, ib] of spans) {
        const d = ib - ia
        if (c <= acc + d) return ia + Math.max(0, c - acc)
        acc += d
      }
      return spans[spans.length - 1][1]
    }
    out = []
    let charAcc = 0
    for (const w of toks) {
      const c0 = speechLen * (charAcc / totalChars)
      charAcc += w.length
      const c1 = speechLen * (charAcc / totalChars)
      const s = fromSpeechLocal(c0)
      const e = Math.max(s + 0.02, fromSpeechLocal(c1))
      out.push({ start: +s.toFixed(3), end: +e.toFixed(3), text: w })
    }
  }
  return out
}

/**
 * 词时间轴合并回伪句。直接喂单字分段，正则类消费方全是碎片。
 * 两种粒度：
 *   细（gap 0.6s）：buildAsrWordTimeline 用，词时间尽量贴真实停顿；
 *   粗（gap 1.5s）：extractAnnouncementRows / interleaveStackedQuestions 用——
 *     DP 落岛后 "Questions one" 与 "to four…" 常被 1.1s 的岛间隙切开，
 *     细粒度下题组播报的正则（"Questions N to M …"）匹配不上，播报行会整个丢失
 *     （实测 #53 的 Q1–4 播报行消失 → 锚点条少一个锚点）。
 */
const mergeWordTimeline = (wordSegs, duration, gap = 0.6) => {
  const out = []
  let cur = null
  for (const s of wordSegs) {
    if (cur && s.start - cur.end < gap) { cur.end = s.end; cur.text += ' ' + s.text }
    else { if (cur) out.push(cur); cur = { start: s.start, end: s.end, text: s.text } }
  }
  if (cur) out.push(cur)
  for (const s of out) s.end = Math.min(s.end, duration)
  return out
}

/**
 * 播报行/题干行钉到词级实测时间 + 语音岛起点。
 *
 * 词时间轴（placeBlockWords 的 DP 对齐）对整组的落岛是准的，但组边界上的
 * 1~2 个词可能被挤到相邻岛的尾部（实测 #53：题组播报的前两个词落在上一段
 * 对话岛的末尾）。这些行的真实起点是**岛起点**（播报前必有 ≥0.6s 停顿），
 * 所以：正文词序在词流里对上 → 行起点吸附到就近的岛起点（向前偏向）。
 */
const snapInstructionLines = (lines, wordSegs, islands, duration) => {
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '')
  const Q_LABEL = /^(?:Q\s*(\d+)|Question\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\s](?:one|two|three|four|five))?))[.。:：,，]\s*/i
  const isSnap = (t) => Q_LABEL.test(String(t).trim()) || /based\s+on/i.test(t)
  const wt = wordSegs.map((w) => norm(w.text))

  /**
   * 词流里找 body 的连续序列。打分：最长公共前缀优先（前 6 词），同分取离 hint 近的。
   * 只按距离选会串位——实测 2015-12-3 的 Q13/Q14 题干都以 "What does Dr. Mironov"
   * 开头，Q13 被钉到了 Q14 的位置（时间倒挂 20 秒）。
   */
  const findSeq = (needle, hint) => {
    if (needle.length < 3) return -1
    let best = -1; let bestP = 0; let bestD = Infinity
    for (let k = 0; k + 3 <= wt.length; k++) {
      let p = 0
      for (let t = 0; t < Math.min(needle.length, 6); t++) {
        if (k + t < wt.length && wt[k + t] === needle[t]) p++
        else break
      }
      if (p < Math.min(needle.length, 4)) continue
      const d = Math.abs(wordSegs[k].start - hint)
      if (p > bestP || (p === bestP && d < bestD)) { bestP = p; bestD = d; best = k }
    }
    return bestD <= 8 ? best : -1
  }
  /**
   * t 附近的岛起点，±4s 窗口内取最近（DP 边界词的落岛误差双向都实测可达 3s+：
   * 有的词早落到上一岛尾部，有的词晚落进本岛中部）。只认 ≥0.5s 的岛，
   * 排除答题停顿里的呼吸/爆音幻影岛。
   */
  const snapIsland = (t, claimed) => {
    let best = null
    for (const [a, b] of islands) {
      if (b - a < 0.5) continue
      if (claimed.has(a)) continue
      if (a >= t - 4.0 && a <= t + 4.0) {
        if (best === null || Math.abs(a - t) < Math.abs(best - t)) best = a
      }
    }
    return best
  }

  const out = lines.map((l) => ({ ...l }))
  // 按时间顺序处理并**认领**岛起点：DP 边界词误差会把相邻两行吸到同一个岛
  // （实测 2016-12-1 的 Q9 与题组播报都吸到播报岛 586.5，Q9 真实在 591.1；
  // 2015-06-3 的 Q2 被吸到 Q1 的岛 169.7，真实在 171.4）。先到先行，
  // 后到的行自动落到下一个空岛——恰好就是它的真实归属。
  const claimed = new Set()
  const order = out.map((l, i) => ({ i, s: Number(l.start) || 0 })).sort((a, b) => a.s - b.s)
  for (const { i } of order) {
    const l = out[i]
    if (!isSnap(l.text)) continue
    const body = String(l.text).trim().replace(Q_LABEL, '').replace(/^[^a-z0-9]+/i, '')
    const lt = body.split(/[^A-Za-z0-9]+/).filter(Boolean).map(norm)
    const k = findSeq(lt, l.start)
    let s = null
    let anchorT = null
    if (k >= 0) {
      // 题号标签（"Question one."）：在正文匹配点之前找 question+题号 词，
      // 有就用标签词的时间做锚（题干播报从标签词开始）
      anchorT = wordSegs[k].start
      const qm = String(l.text).match(Q_LABEL)
      if (qm) {
        for (let m = k - 1; m >= Math.max(0, k - 6); m--) {
          if (wt[m] === 'question' || wt[m] === 'questions') {
            for (let q = m + 1; q <= Math.min(wt.length - 1, m + 2); q++) {
              if (numOf(wordSegs[q].text) === numOf(qm[1] ?? qm[2])) { anchorT = wordSegs[m].start; m = -1; break }
            }
          }
          if (m === -1) break
        }
      }
      s = snapIsland(anchorT, claimed) ?? snapIsland(wordSegs[k].start, claimed)
    }
    // 位置认领：本行当前位置 ±1.2s 内的空岛占住，防后行抢占。放在 s 计算
    // **之后**——放前面会把自己的目标岛先占掉（实测 #53 播报行自占 148.45
    // 后被排除，退到 144.3）。匹配失败（k<0，whisper 转写差异大）也照占。
    for (const [a, b] of islands) {
      if (b - a < 0.5 || claimed.has(a)) continue
      if (Math.abs(a - (Number(l.start) || 0)) <= 1.2) { claimed.add(a); break }
    }
    if (process.env.DBG_SNAP) console.error(`[snap] "${String(l.text).slice(0, 40)}" k=${k} anchor=${anchorT?.toFixed(1) ?? '-'} s=${s ?? 'null'} old=${l.start.toFixed(1)}`)
    if (s === null || s > l.start + 8) continue
    claimed.add(s)
    // 终点：末个匹配词的结束，向后吸到 ≤0.7s 内的岛尾
    let endK = k
    for (let t = 0; t < lt.length && k + t < wordSegs.length; t++) {
      if (wt[k + t] === lt[t]) endK = k + t; else if (t >= 3) break
    }
    let e = wordSegs[endK].end
    for (const [, b] of islands) if (b > e && b - e <= 0.7) { e = b; break }
    if (e <= s) e = Math.min(duration, s + 0.8)
    l.start = +s.toFixed(2)
    l.end = +e.toFixed(2)
  }
  return out
}

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
const targets = manifest.sets.filter((s) => !ONLY || ONLY.includes(s.key))
const results = []

for (const set of targets) {
  const t0 = Date.now()
  const audio = path.join(dir, 'audio', `${set.key}.ogg`)
  const mdPath = path.join(dir, 'yuanwen', `${set.key}.md`)
  if (!fs.existsSync(audio) || !fs.existsSync(mdPath)) { console.error(`✗ ${set.key} 缺文件`); continue }

  const { mask, duration } = speechMask(audio)
  const islands = buildIslands(mask)
  const blocks = buildBlocks(islands, duration)

  // 逐块 whisper（带缓存，只取词文本）→ 按块内语音岛铺词时间 → 合并成伪句
  const blockWords = loadBlockWords(set, audio, blocks)
  const wordSegs = []
  for (let bi = 0; bi < blocks.length; bi++) {
    if (!blockWords[bi]?.length) continue
    wordSegs.push(...placeBlockWords(blockWords[bi], blocks[bi], islands))
  }
  const segments = mergeWordTimeline(wordSegs, duration)

  const segmentsCoarse = mergeWordTimeline(wordSegs, duration, 1.5)
  const mdSentences = parseYuanwenMd(interleaveStackedQuestions(fs.readFileSync(mdPath, 'utf8'), segmentsCoarse))
  const timeline = buildAsrWordTimeline(segments)
  const { lines, stats } = synthesizeTranscript(mdSentences, timeline, {
    audioDuration: duration,
    segments,
    // 播报提取用粗合并（防 "Questions one | to four" 被岛间隙切开）；空档补填用细粒度
    announceSegments: segmentsCoarse,
  })

  const _lq = dedupeQuestions(locateQuestions(lines, wordSegs))
  const _rt = refineTiming(_lq, mask, islands, duration)
  const out = snapSilentLines(snapInstructionLines(_rt, wordSegs, islands, duration), mask, islands, duration)
  if (process.env.DUMP_WORDS) {
    fs.writeFileSync(`temp/build-work/${set.key}.audit.json`, JSON.stringify({
      islands: islands.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]),
      words: wordSegs.map((w) => [+w.start.toFixed(2), +w.end.toFixed(2), w.text]),
    }))
  }
  if (process.env.DBG_STAGE) {
    const dump = (tag, arr) => console.error(`[${tag}] ` + arr.filter((l) => /^(?:Q\d+|Question\s)/i.test(l.text.trim())).slice(0, 8).map((l) => `Q@${l.start.toFixed(0)}`).join(' '))
    dump('合成后', lines); dump('钉位后', _lq); dump('refine后', _rt); dump('snap后', out)
    if (process.env.DBG_TEXT) {
      const needle = process.env.DBG_TEXT.toLowerCase()
      for (const [tag, arr] of [['合成后', lines], ['refine后', _rt], ['snap后', out]]) {
        const i = arr.findIndex((l) => String(l.text).toLowerCase().includes(needle))
        console.error(`[${tag} "${needle}"]` + (i < 0 ? ' 无' : arr.slice(Math.max(0, i - 1), i + 2)
          .map((l) => `\n   ${l.id} ${l.start.toFixed(2)}~${l.end.toFixed(2)} ${JSON.stringify(l.text.slice(0, 40))}`).join('')))
      }
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  const flag = stats.ok ? '✓' : '✗'
  console.log(`${flag} ${set.key}  块${blocks.length} 段${segments.length} 行${out.length} 命中${(100 * stats.hitRate).toFixed(0)}% 溢差${stats.overflow?.toFixed(1) ?? '-'}s (${secs}s)`)
  if (!stats.ok) console.log(`    hitRate=${(100 * stats.hitRate).toFixed(1)}% (<${MIN_HIT_RATE * 100}%) maxEnd=${stats.maxEnd.toFixed(1)}/${duration.toFixed(1)}`)

  results.push({ key: set.key, lines: out, stats, blocks: blocks.length, segments: segments.length })
}

const ok = results.filter((r) => r.stats.ok)
console.log(`\n══ ${ok.length}/${results.length} 套达到命中率门限 ══`)
const avg = ok.length ? ok.reduce((s, r) => s + r.stats.hitRate, 0) / ok.length : 0
console.log(`平均命中率 ${(100 * avg).toFixed(1)}%`)
if (APPLY) {
  fs.writeFileSync('temp/incoming-transcripts.json', JSON.stringify(results, null, 1))
  console.log('已写出 temp/incoming-transcripts.json')
}
