/**
 * 行级文本缺陷清理（2026-10-26 追加轮 ④）。
 *
 * 11.8（fix-announcement-fragments）之后残留的文本层缺陷，全库扫描四类：
 *  L 三明治泄漏：未被锚点消费、但前后行都是指令行的短行（域层模式表外的变体，
 *    如 #1012 l53 复数 "Both the conversations..."、#1043 l114 "Listen to the audio..."）。
 *    与前行内容重叠 ≥60% → 幻影变体，删；否则并入前行文本，行数 −1；
 *  T 指令拆裂尾：前行为指令行的尾巴碎片（"Only once." / "A, B, C, and D." /
 *    "through the centre."），并入前行，行数 −1（#1012/#30/#37）；
 *  A 播报断口拆裂：前一行是裸 "Questions N to M." 头、本行以数字/are 开头的
 *    "…are based on…" 残片（#1008 "twenty-|1" 断口）——MiMo 听证重建整句
 *    （题号以音频为准，后随题干号旁证），合并，行数 −1；
 *  D 重复前缀：行首 2~4 token 紧接着原样重复（#1009 "At the At the end…"）——
 *    MiMo 听证念一遍则去重，行数不变。
 *
 * 岛文本缓存复用 11.8 的 temp/mimo-frag-cache/（f-{cid}-{a}-{b} 命名）与
 * temp/anchor-islands/。写库走 saveTranscript，lineDelta 按课精确声明。
 *
 * 用法：
 *   node scripts/content/fix-fragment-lines.mjs --dry
 *   node scripts/content/fix-fragment-lines.mjs --apply
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect, saveTranscript } from '../audit/data-contract.mjs'
import { extractDialogueAnchors } from '../../packages/domain/dist/index.js'

const APPLY = process.argv.includes('--apply')
const MIMO_KEY = fs.readFileSync(path.join(os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
const MIMO_BASE = process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1'
const CACHE = 'temp/mimo-frag-cache'
const ISLAND_DIR = 'temp/anchor-islands'
const STORE = 'temp/runtime/media-store/duolinting-media'
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
        body: JSON.stringify({ model: 'mimo-v2.5-asr',
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'mp3' } }] }] }),
      })
      if (res.status === 429) {
        if (attempt === 3) { fails++; throw new Error('429 重试耗尽') }
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
const transcribe = async (cid, audio, a, b) => {
  const id = `f-${cid}-${a.toFixed(2)}-${b.toFixed(2)}`
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

// ── 词工具（与其余脚本同源） ──────────────────────────────────
const NUM_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23, 'twenty-four': 24, 'twenty-five': 25 }
// 归一化键表：先剥非字母数字再查（"twenty-one"→"twentyone" 直接查 NUM_WORD 会漏，11.8 同款坑）
const NUM_NORM = new Map(Object.entries(NUM_WORD).map(([k, v]) => [k.replace(/[^a-z0-9]/g, ''), v]))
const numOf = (s) => {
  const t = String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (/^\d+$/.test(t)) return +t
  return NUM_NORM.get(t) ?? NUM_WORD[t] ?? null
}
const words = (t) => String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
const contentWords = (t) => words(t).filter((w) => w.length >= 2)

/** 指令拆裂尾形态（前行为指令行时才认）：Only once. / A, B, C, and D. / through the centre. */
const FRAG_TAIL_RE = /^(?:only\s+once|[a-d](?:\s*,\s*(?:and\s+)?[a-d]){1,3}|through\s+the\s+cent(?:er|re))\.?\s*$/i
/** 播报断口残片：数字/are 开头的 "…are based on…"（11.8 的 TAIL_RE 锚 ^are 漏掉数字头） */
const ANN_FRAG_RE = /^(?:\d{1,2}\s+)?(?:are\s+)?based\s+on\s+the\s+(?:news\s+report|conversation|passage|recording)/i
/** 裸播报头（无动词无 based，供断口配对）：Questions N to M. */
const BARE_HEAD_RE = /^questions?\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?)\s*(?:to|and|-|–)\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?)\.?\s*$/i
/** 行首重复前缀（2~4 token 原样紧跟重复） */
const doubledPrefixOf = (t) => {
  const w = String(t).trim().split(/\s+/)
  for (let L = 2; L <= 4 && 2 * L <= w.length; L++) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const a = w.slice(0, L).map(norm).join(' ')
    const b = w.slice(L, 2 * L).map(norm).join(' ')
    if (a && a === b) return { len: L, text: w.slice(0, L).join(' ') }
  }
  return null
}
/** 行中重复片段（任意位置 1~3 token 紧跟重复，容忍单复数差："conversations Conversation"）。
 *  ⚠ 句界守卫：第一份以 .!?;: 结尾 = 跨句首词重复（"…eyes. parent's eyes."），
 *  不属去重范畴（另类缺陷，报告单列）。
 *  ⚠ 合法重复防御靠听证的序列计数（见 D 规则）：really really / had had / that that /
 *  "people, people from"（同位语）音频里同样念两遍，不得去重。 */
const dedupMidOf = (t) => {
  const raw = String(t).trim().split(/\s+/)
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const eq = (a, b) => a === b || a + 's' === b || a === b + 's'
  for (let L = 1; L <= 3; L++) {
    for (let i = 0; i + 2 * L <= raw.length; i++) {
      const A = raw.slice(i, i + L).map(norm)
      const B = raw.slice(i + L, i + 2 * L).map(norm)
      if (!A.join(' ') || A.some((w) => w.length < 3)) continue
      if (/[.!?;:]$/.test(raw[i + L - 1])) continue
      if (A.every((w, k) => eq(w, B[k]))) {
        return { at: i, len: L, text: raw.slice(0, i + L).join(' ') + ' ' + raw.slice(i + 2 * L).join(' '), dup: raw.slice(i, i + L).join(' ') }
      }
    }
  }
  return null
}
/** 重复片段（token 序列）在 token 流里的相邻出现次数 */
const seqCount = (tokens, seq) => {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const eq = (a, b) => a === b || a + 's' === b || a === b + 's'
  const T = tokens.map(norm)
  const S = seq.map(norm)
  let n = 0
  for (let i = 0; i + S.length <= T.length; i++) {
    if (S.every((w, k) => eq(w, T[i + k]))) n++
  }
  return n
}
/** 词重叠率：frag 的内容词有多大比例出现在 host 里 */
const overlap = (frag, host) => {
  const f = contentWords(frag), h = new Set(contentWords(host))
  if (!f.length) return 1
  return f.filter((w) => h.has(w)).length / f.length
}

const needOf = (ln) => {
  const wc = contentWords(String(ln.text)).length
  return Math.min(Math.max(wc * 0.28, 0.3), 20)
}
const r2 = (v) => Math.round(v * 100) / 100

// ── 主流程 ────────────────────────────────────────────────────
const conn = await connect()
const [rows] = await conn.query(
  'select id, title, category_id, audio_object_name, transcript_json from exercises order by id')
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')

const stats = { leakDel: 0, leakMerge: 0, tailMerge: 0, announceFix: 0, dedup: 0 }
const results = []
const log = []

for (const row of rows) {
  const cid = row.id
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const audio = path.join(STORE, String(row.audio_object_name || '').replace(/^.*?audio\//, 'audio/'))
  if (!fs.existsSync(audio)) continue
  const islF = path.join(ISLAND_DIR, `${cid}.json`)
  if (!fs.existsSync(islF)) continue
  const { islands, duration } = JSON.parse(fs.readFileSync(islF, 'utf8'))
  const anchors = extractDialogueAnchors(lines.map((l) => ({ id: l.id, start: l.start, end: l.end, text: l.text })))
  const consumedSet = new Set(anchors.flatMap((a) => a.lineIds))
  const isConsumed = (l) => consumedSet.has(l.id)
  const islandAt = (t) => islands.find(([a, b]) => t > a - 1.5 && t < b)
  const hearAt = async (t) => {
    const is = islandAt(t)
    return is ? await transcribe(cid, audio, is[0], is[1]) : ''
  }
  /** 行跨度全听证：拼接所有与 [start,end] 相交的岛（逐岛缓存）。单词计数判定必须
   *  听全行——只听行首一个岛时行尾的重复词计数成 0，verdict 空过（实测 66 条误报）。 */
  const hearLine = async (l) => {
    const parts = []
    for (const [a, b] of islands) {
      if (b > l.start - 0.3 && a < l.end + 0.3 && b - a >= 0.5) parts.push(await transcribe(cid, audio, a, b))
    }
    return parts.join(' ')
  }

  let changed = 0
  const touched = []
  // 按行序扫描；行删除用标记法（最后统一过滤），避免下标位移
  const dead = new Set()

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const t = String(l.text).trim()
    const prev = lines[i - 1], next = lines[i + 1]

    // ── A 播报断口残片（前一行是裸播报头） ──
    if (ANN_FRAG_RE.test(t) && prev && BARE_HEAD_RE.test(String(prev.text).trim()) && !dead.has(prev.id)) {
      const heard = await hearAt(l.start)
      const m = heard.match(/^questions?\s+(\S+)\s*(?:to|and|-|–)\s*(\S+)\s+are\s+based\s+on\s+(.*)$/i)
      let full = null
      if (m && numOf(m[1]) !== null && numOf(m[2]) !== null) {
        const a = numOf(m[1]), b = numOf(m[2])
        // 旁证：后随题干号须落在区间内（防 MiMo 听错区间）
        let cover = null
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const qm = String(lines[j].text).match(/^(?:Q\s*(\d+)|[Qq]uestion\s+(\d+))/)
          if (qm) { cover = Number(qm[1] ?? qm[2]); break }
        }
        const ok = cover === null || (cover >= a && cover <= b)
        if (ok) full = `Questions ${a} to ${b} are based on ${m[3].trim().replace(/[.。]\s*$/, '')}.`
      }
      if (!full) {
        // 兜底：断口是复合数词切位（"twenty-|1"）——前行尾词 + 残片头数字用 '-' 接回再归一
        const pt = String(prev.text).trim().replace(/[.。]\s*$/, '')
        const joined = /^\d/.test(t) && /\b(twenty|thirty)\b/i.test(pt) ? `${pt}-${t}` : `${pt} ${t}`
        full = joined
          .replace(/\b(twenty|thirty)[-\s]+(\d{1,2})\b/gi, (mm, w, d) => String(numOf(w) + Number(d)))
          .replace(/^(?:[Qq]uestions?)\s+(\S+)\s*(?:to|and|[-–])\s*(\S+)/i, (mm2, x1, x2) => {
            const a2 = numOf(x1), b2 = numOf(x2)
            return `Questions ${a2 ?? x1} to ${b2 ?? x2}`
          })
      }
      prev.text = full
      prev.end = Math.max(prev.end, l.end)
      dead.add(l.id)
      touched.push(`播报断口合并→「${full.slice(0, 44)}」`)
      stats.announceFix++
      changed++
      continue
    }

    // ── D 重复文本（行首前缀 / 行中片段）──
    // 必须在泄漏规则之前（#1009 实测：带重复前缀的行先被三明治规则并入前行，病句带进好行）。
    // 听证 = 序列计数：重复片段在音频 token 流中出现次数 < 文本中出现次数才去重——
    // "really really / had had / that that / people, people from"（同位语）音频同样念
    // 两遍，词集合覆盖判定分不出来（实测 38 条误报），必须数出现次数。
    const dbl = doubledPrefixOf(t)
    const mid = dbl ? null : dedupMidOf(t)
    if (dbl || mid) {
      const onceText = dbl ? t.slice(dbl.text.length).trim() : mid.text
      // 计数用的重复片段：前缀重复用 dbl.text；行中重复必须用 mid.dup
      // （mid.text 是去重后的全文——首版误用它当 seq，听证变成 0<1 空过，#61/#1038 实测翻车）
      const seq = (dbl ? dbl.text : mid.dup).split(/\s+/)
      const heard = await hearLine(l)
      const textN = seqCount(String(t).split(/\s+/), seq)
      const heardN = seqCount(words(heard), seq)
      // 正向证据 + 少一份：heardN=0 说明没听到任何一份（行没听全/ASR 漏词），不动
      if (heardN >= 1 && heardN < textN) {
        l.text = onceText
        touched.push(`重复文本去除（"${(dbl ? dbl : mid).dup ?? (dbl ? dbl.text : mid.dup)}"，音频 ${heardN}/${textN} 份）→「${onceText.slice(0, 36)}」`)
        stats.dedup++
        changed++
        continue   // 去重后独立保留；多数行修复后即被域层模式消费，下一轮不再命中
      }
    }

    // ── T 指令拆裂尾（前行为指令行） ──
    if (FRAG_TAIL_RE.test(t) && prev && isConsumed(prev) && !dead.has(prev.id) && overlap(t, prev.text) < 0.6) {
      prev.text = `${String(prev.text).trim().replace(/[.。]\s*$/, '')} ${t}`
      prev.end = Math.max(prev.end, l.end)
      dead.add(l.id)
      touched.push(`拆裂尾并入前行→「…${t.slice(0, 20)}」`)
      stats.tailMerge++
      changed++
      continue
    }

    // ── L 三明治泄漏（未被消费但前后都是指令行） ──
    if (!isConsumed(l) && prev && next && isConsumed(prev) && isConsumed(next) && !dead.has(prev.id)
      && contentWords(t).length <= 14 && !ANN_FRAG_RE.test(t) && !FRAG_TAIL_RE.test(t)) {
      if (overlap(t, prev.text) >= 0.6) {
        // 幻影变体：内容已被前行覆盖（#1043 实测），且音频里没有这段独立内容才删
        const heard = await hearAt(l.start)
        const heardOnce = contentWords(heard).length && overlap(t, heard) < 0.5
        if (heardOnce) {
          dead.add(l.id)
          touched.push(`幻影变体删除（音频无此段）→「${t.slice(0, 30)}」`)
          stats.leakDel++
          changed++
          continue
        }
      }
      // 并入前行（真变体，如复数 "Both the conversations..."）
      const heard = await hearAt(l.start)
      if (heard && overlap(t, heard) >= 0.4) {
        prev.text = `${String(prev.text).trim().replace(/\s*$/, '')} ${t}`
        prev.end = Math.max(prev.end, l.end)
        dead.add(l.id)
        touched.push(`泄漏变体并入前行→「${t.slice(0, 30)}」`)
        stats.leakMerge++
        changed++
        continue
      }
    }
  }

  if (!changed) continue
  let out = lines.filter((l) => !dead.has(l.id))
  // 单调化（合并可能造成重叠）：收缩梯度同主精修器
  const seal = () => {
    for (let i = 1; i < out.length; i++) {
      const p = out[i - 1], li = out[i]
      if (li.start < p.end - 0.001) {
        if (li.start - p.start >= needOf(p)) p.end = r2(li.start)
        else if (li.start - p.start >= Math.max(0.18, needOf(p) * 0.35 + 0.2)) p.end = r2(li.start)
        else li.start = r2(p.end)
      }
      if (li.end <= li.start) li.end = r2(li.start + 0.3)
    }
  }
  seal()
  for (let i = 0; i < out.length; i++) {
    const li = out[i], need = needOf(li)
    if (li.end - li.start >= need - 0.01) continue
    const nx = i + 1 < out.length ? out[i + 1].start : duration
    if (nx - li.start >= need - 0.01) li.end = r2(li.start + need)
    else li.end = r2(Math.min(duration, li.start + Math.max(0.18, need * 0.35 + 0.2)))
  }
  seal()
  out = out.map((l, i) => ({ ...l, id: `l${i + 1}` }))
  results.push({ row, lines: out, deletes: dead.size })
  log.push(`#${cid}「${row.title}」${touched.join('；')}`)
}
for (const l of log) console.log(l)
console.log(`\n══ ${results.length} 门待写：断口 ${stats.announceFix} / 拆裂尾 ${stats.tailMerge} / 泄漏删 ${stats.leakDel} / 泄漏并 ${stats.leakMerge} / 去重 ${stats.dedup}`)
console.log(`══ MiMo 调用 ${calls}（失败 ${fails}）══`)

if (!APPLY) { console.log('DRY 结束'); await conn.end(); process.exit(0) }

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const todayPrefix = `${today}.`
const nextVersionOf = new Map()
let ok = 0, failed = 0
for (const { row, lines, deletes } of results) {
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
      expect: { lineDelta: [-deletes, -deletes], note: `行级文本缺陷清理（${deletes} 行删除/合并）` },
      dryRun: false,
    })
    ok++
  } catch (e) { failed++; console.error(`✗ #${row.id} ${e.message}`) }
}
console.log(`\n══ 落库 ${ok} 成功 / ${failed} 失败 ══`)
await conn.end()
console.log('记得：check-invariants --rebuild-baseline + 全门禁')
