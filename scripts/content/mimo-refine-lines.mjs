/**
 * 逐句 ↔ 锚点对应全量精修（任务书 B 阶段，四六级 97 门）。
 *
 * 与 mimo-refine-cet4.mjs（11.7）的差异：目标从「题干/播报行」扩展到
 *   P0 开场报头（每门前 2 锚点，±30s 窗口，标签词匹配）
 *   P1 锚点区间首句（正文行，±12s 窗口，前 4 词匹配，距离上限 10s）
 *   P2 锚点源行残留（onset>0.7 晚 / <-1.2 早；复用碰撞细分 + 标签回溯）
 *   P3 正文行真晚（onset>2 且行长≥1.5s 且行 start 落在岛内；只修有匹配证据的，
 *      偏早 ≤3s 不修——多带上一句尾巴风险大于收益）
 *   OOB 拆裂对/幻影标签行（锚点 lineIds 内行 start < anchor.start−0.3）：
 *      邻近同标签对（Δ≤1.3s，文本互为前缀）确定性删贫行；
 *      远距对（Δ>1.3s）MiMo 听证窗口判定幻影后删除；lineDelta 契约写入。
 *
 * 铁律（全部继承 11.6/11.7 的坑）：
 *  - 逐岛转写全落缓存 temp/mimo-refine-cache-lines/，重跑零调用；
 *  - 标签岛回溯排除组播报（"Questions one TO four" 不是 Q1 的标签）；
 *  - 同岛多行按时间序认领（先到先得，匹配失败的行也按当前位置占岛）；
 *  - 收尾单调化：重叠先收回前一行终点（不得低于可读时长 词数×0.28s），否则推后本行；
 *    时长下限 max(0.18, need×0.35+0.2)；以岛尾为上限截过的行补时长下限；
 *  - 写库一律走 saveTranscript 先 dry 后 apply，行数变化显式声明 lineDelta。
 *
 * 用法：
 *   node scripts/content/mimo-refine-lines.mjs --dry
 *   node scripts/content/mimo-refine-lines.mjs --apply
 * 落库后：check-invariants --rebuild-baseline + 全门禁。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect, saveTranscript } from '../audit/data-contract.mjs'
import { extractDialogueAnchors } from '../../packages/domain/dist/index.js'

const APPLY = process.argv.includes('--apply')
const DEBUG = process.argv.includes('--debug')
const ONLY = (() => { const i = process.argv.indexOf('--ids'); return i >= 0 ? process.argv[i + 1].split(',').filter(Boolean).map(Number) : null })()

const SR = 16000, FRAME = 0.05, THRESH = 0.004
const MIN_CALL_ISLAND = 0.7
const CACHE = 'temp/mimo-refine-cache-lines'
const ISLAND_DIR = 'temp/anchor-islands'
const STORE = 'temp/runtime/media-store/duolinting-media'
const WORK = 'temp/mimo-lines-out.json'
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
  throw new Error('不可达：重试循环必须经 return/throw 退出')
}
/** 双并发：两条串行链交替领课 */
const makeChain = () => {
  let p = Promise.resolve()
  return (fn) => new Promise((resolve, reject) => {
    p = p.then(async () => { try { resolve(await fn()) } catch (e) { reject(e) } })
    p = p.catch(() => {})
  })
}

// ── 能量岛（复用审计器的缓存与判据） ──────────────────────────
const r2 = (v) => Math.round(v * 100) / 100
const islandsOf = (audio, cacheId) => {
  const st = fs.statSync(audio)
  const sig = `${st.size}|${st.mtimeMs}`
  const cf = path.join(ISLAND_DIR, cacheId + '.json')
  if (fs.existsSync(cf)) {
    const c = JSON.parse(fs.readFileSync(cf, 'utf8'))
    if (c.sig === sig) return c
  }
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audio,
    '-ar', String(SR), '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 30 })
  const n = raw.length / 2, per = Math.round(SR * FRAME), mask = []
  for (let i = 0; i + per <= n; i += per) {
    let s = 0
    for (let j = 0; j < per; j++) { const v = raw.readInt16LE((i + j) * 2) / 32768; s += v * v }
    mask.push(Math.sqrt(s / per) >= THRESH ? 1 : 0)
  }
  const rawIs = []; let on = null
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && on === null) on = i
    if (!mask[i] && on !== null) { rawIs.push([on * FRAME, i * FRAME]); on = null }
  }
  if (on !== null) rawIs.push([on * FRAME, mask.length * FRAME])
  const islands = []
  for (const is of rawIs) {
    const last = islands[islands.length - 1]
    if (last && is[0] - last[1] < 0.35) last[1] = is[1]
    else islands.push([...is])
  }
  const kept = islands.filter(([a, b]) => b - a >= 0.12).map(([a, b]) => [r2(a), r2(b)])
  const result = { sig, duration: r2(n / SR), islands: kept }
  fs.writeFileSync(cf, JSON.stringify(result))
  return result
}

// ── token 归一（数字词归一 + 复合数词 + 说话人前缀剥离） ────────
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
/** 行文本 → 匹配键：剥说话人前缀（M:/W:）与标签头（Q1./Question 21./Section A/Conversation One/News Report Two/Passage 3/Recording One/Directions） */
const SPEAKER_RE = /^(?:[MW]:\s*)+/i
/** 数字词（长词在前 + 词边界，防 "six" 抢吃 "sixteen"） */
const NUM_ALT = 'nineteen|eighteen|seventeen|sixteen|fifteen|fourteen|thirteen|twelve|eleven|twenty(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?|ten|nine|eight|seven|six|five|four|three|two|one|\\d{1,2}'
const LABEL_HEAD_RE = new RegExp(
  '^(?:q\\s*\\d+|questions?\\s+(?:' + NUM_ALT + ')(?:\\s+(?:to|through|–|—|-)\\s+(?:' + NUM_ALT + '))?|section\\s+[a-d1-4]|conversation\\s+(?:one|two|three|1|2|3)|news\\s*reports?\\s+(?:one|two|three|1|2|3)|passages?\\s+(?:one|two|three|1|2|3)|recordings?\\s+(?:one|two|three|1|2|3)|directions\\b)\\b[.。:：,，\\-–—]?\\s*', 'i')
/** 非 Q 标签头（Section/Conversation/News Report/Passage/Recording/Directions）：锚点源行的主键 */
const NON_Q_LABEL_HEAD_RE = /^(section\s+[a-d1-4]|conversation\s+(?:one|two|three|1|2|3)|news\s*reports?\s+(?:one|two|three|1|2|3)|passages?\s+(?:one|two|three|1|2|3)|recordings?\s+(?:one|two|three|1|2|3)|directions\b)[.。:：,，\-–—]?\s*/i
/** MiMo 对短标签的同音误听变体（"Section A"→"Section Eight"；数字词与常见谐音） */
const HOMOPHONE = { a: ['8', 'eight', 'ay'], b: ['be', 'bee'], c: ['sea', 'see'], d: ['dee'],
  1: ['one', 'won'], 2: ['two', 'to', 'too'], 3: ['three'], 4: ['four', 'for'], 5: ['five'],
  6: ['six'], 7: ['seven'], 8: ['eight', 'ate'], 9: ['nine'], 10: ['ten'] }
/**
 * 行 → 有序匹配键列表。
 *  - 非Q标签行（"Section A, directions."）：先标签词（含同音变体——标签词跨微段
 *    细分时会被拆散，所以标签匹配不吃细分），后剩余正文词；
 *  - 其余（题干/正文）：剥标签头与说话人前缀后的正文词。
 * 返回 { keys, labelRow }。
 */
const keysOf = (rawText) => {
  const t = String(rawText).trim().replace(SPEAKER_RE, '')
  const keys = []
  const m = t.match(NON_Q_LABEL_HEAD_RE)
  if (m) {
    const lt = toks(m[0])
    if (lt.length >= 2) {
      keys.push(lt)
      const last = lt[lt.length - 1]
      for (const alt of HOMOPHONE[last] ?? []) keys.push([...lt.slice(0, -1), alt])
    }
    const rest = toks(t.slice(m[0].length))
    if (rest.length >= 3) keys.push(rest)
    if (keys.length) return { keys, labelRow: true }
  }
  const body = toks(t.replace(LABEL_HEAD_RE, ''))
  if (body.length >= 2) return { keys: [body], labelRow: false }
  return { keys: [toks(t)], labelRow: false }
}
const labelNumOf = (rawText) => {
  const m = String(rawText).trim().replace(SPEAKER_RE, '').match(LABEL_HEAD_RE)
  if (!m) return null
  const head = m[0]
  // "Q22." 会被 toks 融成单个 token（字母数字粘连），单独拆出题号（容忍尾标点）
  const qm = head.match(/^q\s*(\d{1,2})\b[.。:：,，\-–—]?\s*$/i)
  if (qm) return Number.parseInt(qm[1], 10)
  const words = toks(head)
  for (let i = 0; i < words.length - 1; i++) {
    if (/^(question|questions)$/.test(words[i])) {
      const n = numOf(words[i + 1])
      if (n !== null) return n
    }
  }
  return null
}
const needOf = (ln) => {
  const wc = toks(String(ln.text).replace(SPEAKER_RE, '')).filter((w) => w.length >= 2).length
  return Math.min(Math.max(wc * 0.28, 0.3), 20)
}

// ── 主流程 ────────────────────────────────────────────────────
const conn = await connect()
const [rows] = await conn.query(
  'select id, title, category_id, audio_object_name, transcript_json from exercises order by id')
const targets = rows.filter((r) => !ONLY || ONLY.includes(r.id))
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')
console.log(`97 门中待精修 ${targets.length} 门（${APPLY ? 'APPLY' : 'DRY'}）`)

const stats = { P0: 0, P1: 0, P2: 0, P3: 0, OOB_DEL: 0, OOB_FAR_DEL: 0, OOB_KEEP: 0, SKIP: 0 }
const payload = []   // { cid, cat, deletes: [lineId...], moves: [{id, from, to}], lines }

const chains = [makeChain(), makeChain()]
const jobs = targets.map((row) => async () => {
  const cid = row.id
  let lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const audio = path.join(STORE, String(row.audio_object_name || '').replace(/^.*?audio\//, 'audio/'))
  if (!fs.existsSync(audio)) { console.error(`✗ #${cid} 无音频`); return }
  const { islands, duration } = islandsOf(audio, String(cid))
  if (!islands.length) return
  const onsetStarts = islands.filter(([a, b]) => b - a >= 0.5).map(([a]) => a)
  if (!onsetStarts.length) return
  const nearestOnset = (t) => onsetStarts.reduce((p, a) => Math.abs(a - t) < Math.abs(p - t) ? a : p, onsetStarts[0])

  // ══ 第 0 步：OOB 拆裂对 / 幻影标签行处理（删行 → 内存中重算锚点） ══
  const deletes = []
  const anchorsOf = (ls) => extractDialogueAnchors(ls.map((l) => ({ id: l.id, start: l.start, end: l.end, text: l.text })))
  const byId = () => new Map(lines.map((l) => [l.id, l]))
  const lineAt = (t) => lines.find((l) => Math.abs(l.start - t) <= 0.06)
  // OOB 听证需要的额外窗口（远距对）
  const oobFarWindows = []
  {
    let anchors = anchorsOf(lines)
    for (const a of anchors) {
      const m = byId()
      const viol = a.lineIds.map((id) => m.get(id)).filter((l) => l && l.start < a.start - 0.3)
      if (!viol.length) continue
      const opener = lineAt(a.start)
      for (const v of viol) {
        const delta = a.start - v.start
        const vn = toks(v.text).join(' ')
        const on = opener ? toks(opener.text).join(' ') : ''
        // token 子集判贫：邻近对（Δ≤8s）删文本较贫一侧（互为前缀或子集）。
        // 不用 MiMo 听证——两行窗口互相污染（#59 实测把内容长行误判幻影）。
        const isSubsetPair = opener && delta <= 8 &&
          (vn.startsWith(on) || on.startsWith(vn) || on.includes(vn) || vn.includes(on))
        if (isSubsetPair) {
          const poor = vn.length <= on.length ? v : opener
          deletes.push(poor.id)
          stats.OOB_DEL++
          continue
        }
        // 远距对：MiMo 听证 v 所在窗口（opener 窗口交给后面的常规钉位流程）
        oobFarWindows.push({ v, anchor: a, lo: Math.max(0, v.start - 3), hi: Math.min(duration, v.end + 3) })
      }
    }
  }
  // 远距对听证：越界行窗口与 opener 窗口都转写，删幻影那侧（两侧都真 → 删早侧，报告记录）
  const labelWordsOf = (l) => {
    const m = String(l.text).trim().match(LABEL_HEAD_RE)
    return m ? toks(m[0]) : toks(l.text).slice(0, 2)
  }
  const hearWindow = async (lo, hi) => {
    const winIsl = islands.filter(([a, b]) => b > lo && a < hi && b - a >= MIN_CALL_ISLAND)
    let heard = ''
    for (const [a, e2] of winIsl) {
      const id = `l-${cid}-${a.toFixed(2)}-${e2.toFixed(2)}`
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
      heard += ' ' + text
    }
    return heard
  }
  const heardHasLabel = (heard, key) => {
    const ht = toks(heard)
    let hit = 0
    for (let k = 0; k + key.length <= ht.length; k++) {
      let q = 0
      for (let t = 0; t < key.length; t++) { if (ht[k + t] === key[t]) q++; else break }
      hit = Math.max(hit, q)
    }
    return hit >= Math.min(key.length, 2)
  }
  for (const w of oobFarWindows) {
    if (deletes.includes(w.v.id)) continue
    const key = labelWordsOf(w.v)
    const vReal = heardHasLabel(await hearWindow(Math.max(0, w.v.start - 3), Math.min(duration, w.v.end + 3)), key)
    const opener = lineAt(w.anchor.start)
    let openerReal = true
    if (opener && opener.id !== w.v.id) {
      openerReal = heardHasLabel(await hearWindow(Math.max(0, opener.start - 3), Math.min(duration, opener.end + 3)), labelWordsOf(opener))
    }
    if (vReal && !openerReal && opener) {
      // 真播报在越界行处、opener 是幻影：删 opener，保留 v
      deletes.push(opener.id)
      stats.OOB_FAR_DEL++
      console.log(`  #${cid} OOB 远距对：opener 幻影删（真播报在 ${w.v.start.toFixed(1)}「${String(w.v.text).slice(0, 24)}」）`)
    } else {
      // 常规：删越界行（两侧都真也删早侧——均为指令行，删行不伤学习内容）
      deletes.push(w.v.id)
      stats.OOB_FAR_DEL++
      if (vReal && openerReal) stats.OOB_KEEP++
    }
  }
  if (deletes.length) {
    lines = lines.filter((l) => !deletes.includes(l.id))
    // saveTranscript 会统一重编 id；此处保持原 id 便于 diff 追踪
  }

  // ══ 第 1 步：收集 P0–P3 目标（基于删行后的锚点重算） ══
  // 锚点起点无真实行（来自 extract 的 tail-split 虚拟行，如 #59 l109 把 Directions 与
  // "Recording One." 融在一行、锚点起点是比例切分位）：按标签文本把宿主行拆成两行，
  // 拆出的标签行走后面的 P2 钉位。lineDelta 声明计入 splits。
  let splits = 0
  {
    const wordOf = (n) => Object.entries(NUM_WORD).find(([, v]) => v === n)?.[0]
    for (let pass = 0; pass < 5; pass++) {
      let changed = false
      for (const a of anchorsOf(lines)) {
        if (lineAt(a.start)) continue
        const lm = a.label.match(/^(Section|Conversation|News Report|Passage|Recording)\s+(\d+|One|Two|Three)$/i)
        if (!lm) continue
        const num = numOf(lm[2])
        const tailRe = num !== null
          ? new RegExp('^(.*?)(\\b' + lm[1] + '\\s+(?:' + (wordOf(num) ?? lm[2]) + '|' + num + ')\\b\\.?,?\\s*)$', 'i')
          : null
        if (!tailRe) continue
        for (let i = 0; i < lines.length; i++) {
          const m2 = String(lines[i].text).match(tailRe)
          if (!m2 || m2[1].trim().length < 8) continue
          const host = lines[i]
          const span = host.end - host.start
          const at = host.start + span * (m2[1].length / String(host.text).length)
          // 拆出的标签行不带宿主译文（译文属于前半段内容）
          const { translation: _t, translations: _ts, answers: _a, keywords: _k, ...bare } = host
          const tailLine = { ...bare, id: host.id + '-t', start: r2(at), text: m2[2].trim() }
          host.end = r2(at)
          host.text = m2[1].trim()
          lines.splice(i + 1, 0, tailLine)
          splits++
          changed = true
          break
        }
        if (changed) break
      }
      if (!changed) break
    }
  }
  const anchors = anchorsOf(lines)
  const consumed = new Set(anchors.flatMap((a) => a.lineIds))
  const sectionOf = (start) => {
    let cur = null
    for (const a of anchors) { if (a.start <= start + 1e-6) cur = a; else break }
    return cur
  }
  const targetsRows = []   // { line, keys, labelRow, prio, winLo, winHi, maxDist }
  // interior：行的包含岛被上一行终点伸入 ≥0.7s（零间隙并岛，能量不可分）——审计口径
  // 同步豁免，保证修复后复跑零变更（收敛）。
  const interiorOf = (l) => {
    const idx = lines.findIndex((x) => x.id === l.id)
    if (idx <= 0) return false
    const is = islands.find(([a, b]) => l.start > a && l.start < b)
    return !!is && lines[idx - 1].end > is[0] + 0.7
  }
  const addT = (line, prio, win, maxDist) => {
    const { keys, labelRow } = keysOf(line.text)
    const kept = keys.filter((k) => k.length >= 2)
    if (!kept.length) return
    // 标签行（非 P1 首句）前向扩窗到 +65s：行被插值到上一段播报后、真标签播报在
    // 远处的场合（#30 +15s / #31 +52s 实测——后者要跨过整组题干行）。
    const fwd = labelRow && prio !== 'P1' ? 65 : win
    targetsRows.push({ line, keys: kept, labelRow, prio, win, fwd, maxDist: Math.max(maxDist, labelRow && prio !== 'P1' ? 65 : 0), onset: r2(line.start - nearestOnset(line.start)) })
  }
  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai]
    const opener = lineAt(a.start)
    const d = opener ? r2(opener.start - nearestOnset(opener.start)) : 0
    // P0：前 2 锚点（开场报头；偏晚>0.7 / 偏早>1.0）
    if (ai < 2 && opener && (d > 0.7 || d < -1.0)) addT(opener, 'P0', 45, 45)
    // P2：锚点源行残留（晚>0.7 / 早>1.2，interior 豁免）
    else if (opener && !interiorOf(opener) && (d > 0.7 || d < -1.2)) addT(opener, 'P2', 12, 10)
    // P1：区间首句（正文行，|onset|>1.5，interior 豁免）
    const mine = lines.filter((l) => !consumed.has(l.id) && sectionOf(l.start) === a)
    const first = mine.length ? mine.reduce((p, l) => l.start < p.start ? l : p, mine[0]) : null
    if (first && !interiorOf(first)) {
      const fd = r2(first.start - nearestOnset(first.start))
      if (Math.abs(fd) > 1.5) addT(first, 'P1', 12, 10)
    }
  }
  // P3：正文行真晚（onset>2、行长≥1.5s、行 start 在岛内）。
  // maxDist 25：行深在合并岛内时包含岛起点距行可达 20+s（maxDist 10 会全数拒掉）；
  // 防串位靠「pos≤3 + 首行守卫」而不是距离——见第二遍的对应注释。
  // ⚠ 岛内非首行预过滤（转写之前）：本行与包含岛起点之间还有别的行起点时，
  // 第二遍的首行守卫必然拦截——提前过滤省掉整段岛的 MiMo 转写（#25 一门就省 ~170 次）。
  // 尾巴卫生轮（2026-10-26 用户授权扩 MiMo 预算）：偏早悬浮（本行岛在行后 ≥1.8s）也修。
  for (const l of lines) {
    if (consumed.has(l.id)) continue
    if (l.end - l.start < 1.5) continue
    const d = l.start - nearestOnset(l.start)
    if (d > 2) {
      const near = islands.find(([a, b]) => l.start > a && l.start < b)
      if (!near) { addT(l, 'P3', 12, 25); continue }   // 悬浮在岛后空隙：本行音频应在更后的岛
      if (lines.some((l2) => l2 !== l && l2.start > near[0] - 0.05 && l2.start < l.start - 0.05)) continue
      addT(l, 'P3', 12, 25)
    } else if (d < -1.8) {
      addT(l, 'P3', 12, 25)
    }
  }
  if (!targetsRows.length && !deletes.length) return

  // ══ 第 2 步：目标区合并 → 逐岛转写（缓存） ══
  // ⚠ 必须先按行时间排序：targetsRows 是 P1/P2（锚点序）在前、P3（行序）在后，
  // 不排序时合并逻辑（只与上一条区域比较）会把时间乱序的区域错误吞并，
  // P3 区域整个消失、岛从不转写（#1012 实测 20 个 P3 目标全数匹配放弃）。
  const regions = []
  for (const t of [...targetsRows].sort((x, y) => x.line.start - y.line.start)) {
    const lo = Math.max(0, t.line.start - t.win), hi = Math.min(duration, t.line.end + t.fwd)
    const r = regions[regions.length - 1]
    if (r && lo <= r.hi) r.hi = Math.max(r.hi, hi)
    else regions.push({ lo, hi })
  }
  // 池内岛长下限 0.5s（与审计器起点口径一致）：开场标签播报常是 0.6s 左右的脆岛，
  // 0.7 门槛会把它整个排除在池外，P0 全数匹配放弃（#1003 实测 "Section A" 岛 0.65s）。
  const islandsTxt = new Map()
  for (const r of regions) {
    for (let idx = 0; idx < islands.length; idx++) {
      const [a, e2] = islands[idx]
      if (e2 <= r.lo || a >= r.hi || e2 - a < 0.5 || islandsTxt.has(idx)) continue
      const id = `l-${cid}-${a.toFixed(2)}-${e2.toFixed(2)}`
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
  const pool = []
  for (const [idx, txt] of islandsTxt) pool.push({ start: islands[idx][0], end: islands[idx][1], text: txt })
  const poolToks = pool.map((c) => { const t = toks(c.text); tokCache.set(c.start, t); return t })
  const hitAt = (ct, needle) => {
    let best = { len: 0, pos: -1 }
    for (let k = 0; k + Math.min(needle.length, 2) <= ct.length; k++) {
      let q = 0
      for (let t = 0; t < Math.min(needle.length, 8); t++) { if (k + t < ct.length && ct[k + t] === needle[t]) q++; else break }
      if (q > best.len) best = { len: q, pos: k }
    }
    return best
  }

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
      const rawIs = []; let st = null
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
        const id = `l-${cid}-${a.toFixed(2)}-${e2.toFixed(2)}-f`
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
        out.push({ start: r2(a), end: r2(e2), text })
      }
    } catch { /* 细分失败就退回整岛 */ }
    return out.length ? out : [c]
  }

  // ── 匹配核心：keys 按序尝试，返回 {ci, d, pos, keyIdx}（同分取近） ──
  const matchIn = (thePool, theToks, t) => {
    for (let ki = 0; ki < t.keys.length; ki++) {
      const key = t.keys[ki]
      const need = Math.min(key.length, 3)
      let best = null
      for (let ci = 0; ci < thePool.length; ci++) {
        if (!thePool[ci].text) continue
        const h = hitAt(theToks[ci], key)
        if (h.len < need) continue
        const d = Math.abs(thePool[ci].start - t.line.start)
        if (d > t.maxDist) continue
        if (!best || d < best.d) best = { ci, d, pos: h.pos, keyIdx: ki }
      }
      if (best) return best
    }
    return null
  }

  // 第一遍粗匹配 → 找需细分的岛（仅末位正文键命中且标签词后置 pos≥4，或多行碰撞；
  // 标签键不吃细分——标签词跨微段会被拆散，#43 实测整岛才是标签的家）
  const pre = []
  for (const t of targetsRows) pre.push({ ...t, best: matchIn(pool, poolToks, t) })
  const byIsland = new Map()
  for (const it of pre) {
    if (!it.best) continue
    const arr = byIsland.get(it.best.ci) ?? []
    arr.push(it)
    byIsland.set(it.best.ci, arr)
  }
  const splitMap = new Map()
  for (const [ci, items] of byIsland) {
    const needSplit = items.length >= 2 || items.some((it) =>
      it.best.keyIdx === it.keys.length - 1 && it.keys[it.best.keyIdx].length >= 3 && it.best.pos >= 4)
    if (!needSplit) continue
    splitMap.set(ci, await fineSplit(pool[ci]))
  }
  const segPool = []
  for (let ci = 0; ci < pool.length; ci++) {
    const subs = splitMap.get(ci)
    if (subs) { for (const sub of subs) segPool.push(sub) } else segPool.push(pool[ci])
  }
  const segToks = segPool.map((c) => toks(c.text))

  // 第二遍正式匹配（时间序 + 认领；细分池优先，原岛池兜底防碎片化；P3 只修有证据的）
  const claimed = new Set()
  const order = [...pre].sort((a, b) => a.line.start - b.line.start)
  const moves = []
  const detail = []
  for (const it of order) {
    const { line, prio } = it
    // 位置占岛：只在该行最终不移动时执行（无匹配 / 目标岛已被占且无替代）——
    // 放在目标检查之前会让 0.7~1.2 带内的行把自己的目标岛占掉再自我拦截（cet4 版
    // 无此问题：其目标阈值 1.2 保证了目标岛从不在 1.2 内；本轮 P2 阈值 0.7 踩中）。
    const squatNearest = () => {
      for (const p of [segPool, pool]) {
        for (const c of p) {
          if (claimed.has(c.start)) continue
          if (Math.abs(c.start - line.start) <= 1.2) { claimed.add(c.start); return }
        }
      }
    }
    let best = matchIn(segPool, segToks, it)
    let useSeg = true
    if (!best) { best = matchIn(pool, poolToks, it); useSeg = false }
    // 题号标签岛兜底（±20s，排除组播报）
    if (!best) {
      const n = labelNumOf(line.text)
      if (n !== null) {
        outer: for (const [p, pt] of [[segPool, segToks], [pool, poolToks]]) {
          for (let ci = 0; ci < p.length; ci++) {
            if (!p[ci].text) continue
            if (Math.abs(p[ci].start - line.start) > 20) continue
            const kt = pt[ci]
            for (let t = 0; t < kt.length - 1; t++) {
              if ((kt[t] === 'question' || kt[t] === 'questions') && numOf(kt[t + 1]) === n
                && kt[t + 2] !== 'to' && kt[t + 2] !== 'through') {
                best = { ci, d: Math.abs(p[ci].start - line.start), pos: t, keyIdx: 0 }
                useSeg = p === segPool
                break outer
              }
            }
          }
        }
      }
      if (!best) {
        // 形状兜底（仅标签行）：MiMo 把短标签乱听（"Passage Two"→"House H two"）时按
        // 「短岛 ≤2.5s、≤5 token、含标签数字、不含 question」认领——播报岛的形状特征。
        const lm = String(line.text).trim().match(NON_Q_LABEL_HEAD_RE)
        const numTok = lm ? (toks(lm[0]).map((w) => numOf(w) !== null ? String(numOf(w)) : w).find((w) => /^\d+$/.test(w)) ?? null) : null
        if (numTok !== null && !/question/i.test(line.text)) {
          outerShape: for (const [p, pt] of [[segPool, segToks], [pool, poolToks]]) {
            for (let ci = 0; ci < p.length; ci++) {
              if (!p[ci].text || claimed.has(p[ci].start)) continue
              if (p[ci].end - p[ci].start > 2.5) continue
              const d = Math.abs(p[ci].start - line.start)
              if (d > it.maxDist) continue
              const kt = pt[ci]
              if (kt.length > 5) continue
              if (kt.some((w) => w === 'question' || w === 'questions')) continue
              const numForms = [numTok, ...(HOMOPHONE[numTok] ?? [])]
              if (!kt.some((w) => numForms.includes(w))) continue
              best = { ci, d, pos: 0, keyIdx: 0 }
              useSeg = p === segPool
              break outerShape
            }
          }
        }
      }
      if (!best) {
        stats.SKIP++
        squatNearest()
        if (DEBUG) console.log(`    SKIP #${cid} ${prio} ${line.id}@${line.start.toFixed(1)}「${String(line.text).slice(0, 30)}」keys=${JSON.stringify(it.keys)}`)
        continue
      }
    }
    let activePool = useSeg ? segPool : pool
    let activeToks = useSeg ? segToks : poolToks
    if (claimed.has(activePool[best.ci].start)) {
      let alt = null
      for (const [p, pt] of [[segPool, segToks], [pool, poolToks]]) {
        for (let ci = 0; ci < p.length; ci++) {
          if (!p[ci].text || claimed.has(p[ci].start)) continue
          const key = it.keys[0]
          const h = hitAt(pt[ci], key)
          if (h.len < Math.min(key.length, 3)) continue
          const d = Math.abs(p[ci].start - line.start)
          if (d > it.maxDist) continue
          if (!alt || d < alt.d) alt = { ci, d, pos: h.pos, keyIdx: 0, pool: p, toks: pt }
        }
      }
      if (alt) { best = alt; activePool = alt.pool; activeToks = alt.toks }
    }
    const target = activePool[best.ci]
    if (claimed.has(target.start)) { squatNearest(); continue }
    let onset = target.start
    let end = target.end
    // 题号标签岛回溯（排除组播报）
    const n = labelNumOf(line.text)
    if (n !== null) {
      for (let ci = best.ci - 1; ci >= 0 && activePool[best.ci].start - activePool[ci].end <= 3.5; ci--) {
        const kt = activeToks[ci]
        for (let t = 0; t < kt.length - 1; t++) {
          if ((kt[t] === 'question' || kt[t] === 'questions') && numOf(kt[t + 1]) === n) {
            if (kt[t + 2] === 'to' || kt[t + 2] === 'through') break
            if (!claimed.has(activePool[ci].start)) { onset = activePool[ci].start; end = target.end }
            ci = -1
            break
          }
        }
        if (ci === -1) break
      }
    }
    claimed.add(onset)
    // 首行守卫：新起点与本行当前位置之间还有别的行起点 → 本行不是该岛区段的第一条行，
    // 钉到岛起点会插队（#1012 实测 l90 匹配到 21s 合并岛中部、其前还有 l88/l89）。
    if (lines.some((l2) => l2 !== line && l2.start > onset - 0.05 && l2.start < line.start - 0.05)) continue
    // P3 深位守卫：行的词必须就在岛/段的开头（pos≤3）——词在岛中部说明真实起点在岛中部，
    // 岛级管线无词级时间戳，不可修（残余留报告）。
    if (prio === 'P3' && best.pos > 3) continue
    // P3 政策：修偏晚 ≥1s；偏早 ≥1.5s 也修（尾巴卫生轮，2026-10-26 扩预算授权）
    if (prio === 'P3') {
      if (onset > line.start - 1.0 && onset < line.start + 1.5) continue
    }
    if (Math.abs(onset - line.start) <= 0.15) continue
    detail.push(`${prio} ${line.start.toFixed(1)} → ${onset.toFixed(1)} 「${String(line.text).slice(0, 34)}」`)
    moves.push({ id: line.id, from: line.start, to: onset })
    line.start = r2(onset)
    // 终点保持原值（保时长）：正文行常在合并岛内，钉到岛起点后若把终点拉到岛尾
    // 会吞掉同岛后续行的音频；单调化环节负责与后行衔接。
    line.end = r2(Math.max(line.end, onset + 0.8))
    stats[prio]++
  }

  // ══ 第 3 步前：移动后的二次 OOB 清扫 ══
  // P0/P2 钉位会把 opener 拉到岛起点，先前不越界的裸标签行（如 #1001 l2 "Section A."
  // @5.4 vs 钉到 6.9 的 l3）此刻落在锚点起点前 0.3s 之外——同规则删贫行。
  {
    const anchors2 = anchorsOf(lines)
    const m2 = new Map(lines.map((l) => [l.id, l]))
    const newDel = []
    for (const a of anchors2) {
      const opener = lineAt(a.start)
      if (!opener) continue
      const viol = a.lineIds.map((id) => m2.get(id)).filter((l) => l && l !== opener && l.start < a.start - 0.3 && !deletes.includes(l.id))
      for (const v of viol) {
        const vn = toks(v.text).join(' ')
        const on = toks(opener.text).join(' ')
        if (a.start - v.start <= 8 && (vn.startsWith(on) || on.startsWith(vn) || on.includes(vn) || vn.includes(on))) {
          newDel.push(v.id)
          stats.OOB_DEL++
        }
      }
    }
    if (newDel.length) {
      deletes.push(...newDel)
      lines = lines.filter((l) => !newDel.includes(l.id))
    }
  }

  // ══ 第 3 步：重排 + 单调化 + 时长下限 ══
  // 大幅前移（如 #31 CONVERSATION 2 行 +52s）会让数组序与时间序脱节，契约 T5 倒挂会拦截——
  // 按 start 稳定排序回时间序（saveTranscript 统一重编 id）。
  lines.sort((a, b) => a.start - b.start)
  // 收缩梯度：先全额可读时长；不够时降到时长健全性下限（need×0.35+0.2，门禁安全边际）。
  // 只有下限也不够才推后本行——推后会原样复刻审计超标的偏晚（题干被膨胀的播报行终点
  // 顶回岛外 0.7~6s，预演实测 57 条 A2 晚残留全由此而来）。
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

  if (moves.length || deletes.length || splits) {
    // 删行/拆行后 id 有空洞与 '-t' 后缀，统一重编 l1..lN（saveTranscript 的 T4 校验输入数组）
    lines = lines.map((l, i) => ({ ...l, id: `l${i + 1}` }))
    payload.push({ cid, cat: row.category_id, title: row.title, deletes, moves, splits, lines })
    console.log(`#${cid}「${row.title}」删 ${deletes.length} 行 / 拆 ${splits} 行 / 移 ${moves.length} 行`)
    for (const d of detail.slice(0, 3)) console.log('   ' + d)
    if (detail.length > 3) console.log(`   …共 ${detail.length} 处`)
  }
})
await Promise.all(jobs.map((j, i) => chains[i % 2](j)))

console.log(`\n══ ${payload.length} 门有变更；P0 ${stats.P0} / P1 ${stats.P1} / P2 ${stats.P2} / P3 ${stats.P3}；OOB 邻近删 ${stats.OOB_DEL} / 远距删 ${stats.OOB_FAR_DEL} / 保留 ${stats.OOB_KEEP}；匹配放弃 ${stats.SKIP}`)
console.log(`══ MiMo 调用 ${calls}（失败 ${fails}）══`)
fs.writeFileSync(WORK, JSON.stringify(payload.map(({ cid, cat, deletes, moves, splits, lines }) => ({ cid, cat, deletes, moves, splits, lines }))))
console.log(`已写出 ${WORK}（${APPLY ? '' : 'dry——加 --apply 落库'}）`)

if (APPLY) {
  // seed 版本每个文件只升一次（多课连续落库不逐课递增）
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const todayPrefix = `${today}.`
  const nextVersionOf = new Map()
  const bump = (seedPath) => {
    if (!nextVersionOf.has(seedPath)) {
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
      nextVersionOf.set(seedPath, seed.version.startsWith(todayPrefix)
        ? `${todayPrefix}${Number(seed.version.slice(todayPrefix.length)) + 1}`
        : `${todayPrefix}1`)
    }
    return nextVersionOf.get(seedPath)
  }
  let ok = 0, failed = 0
  for (const { cid, cat, deletes, moves, splits = 0, lines } of payload) {
    const seedPath = seedOf(cat)
    const nextVersion = bump(seedPath)
    const ld = splits - deletes.length
    try {
      await saveTranscript({
        conn, cid, lines, version: nextVersion, seedPath,
        expect: { lineDelta: [ld, ld], note: `逐句锚点对应精修：${moves.length} 行钉位${deletes.length ? ` + ${deletes.length} 行拆裂/幻影删除` : ''}${splits ? ` + ${splits} 行标签拆分` : ''}` },
        dryRun: false,
      })
      ok++
    } catch (e) { failed++; console.error(`✗ #${cid} ${e.message}`) }
  }
  console.log(`\n══ 落库 ${ok} 成功 / ${failed} 失败 ══`)
}
await conn.end()
