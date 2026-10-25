/**
 * 修复被截断/拆裂的题组播报行（四六级全库）。
 *
 * 形态（2026-10-26 全库扫描，正文句里合法的 "based on" 已排除）：
 *  A 截断头：「Questions 9 to 11 are」/「questions five to eight are based on the」
 *    —— 句子被切掉尾巴，行数不变，只补全文本；
 *  B 无头残片：「Are based on the passage you have just heard.」（#1011）
 *    —— 头整个丢失，MiMo 转写补全整句，行数不变；
 *  C 拆裂对：「Questions three and four are based.」+「Based on the news report…」（#1045）
 *    —— 两行并一行，行数 -1，走 lineDelta=[-K,0] 契约声明。
 *
 * 文本以 MiMo 逐岛转写为准（音频词图 > 现存文本），同时把行起点吸附到所在岛
 * （残片行的起点常随截断一起偏晚，实测 #1011 偏 2s）。
 *
 * 用法：
 *   node scripts/content/fix-announcement-fragments.mjs --dry
 *   node scripts/content/fix-announcement-fragments.mjs --apply
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const APPLY = process.argv.includes('--apply')
const SR = 16000
const FRAME = 0.05
const THRESH = 0.004
const MIMO_KEY = fs.readFileSync(path.join(os.homedir(), '.zcode', 'asr', 'mimo.key'), 'utf8').trim()
const MIMO_BASE = process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1'
const CACHE = 'temp/mimo-frag-cache'
const STORE = 'temp/runtime/media-store/duolinting-media'
fs.mkdirSync(CACHE, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let calls = 0
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
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const c = JSON.parse(t).choices?.[0]?.message?.content ?? ''
      if (c.trim()) return c.trim()
      throw new Error('空结果')
    } catch (e) {
      if (attempt === 3) throw e
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
  const islands = []
  for (const is of rawIs) {
    const last = islands[islands.length - 1]
    if (last && is[0] - last[1] < 0.35) last[1] = is[1]
    else islands.push([...is])
  }
  for (let i = islands.length - 1; i >= 0; i--) if (islands[i][1] - islands[i][0] < 0.12) islands.splice(i, 1)
  return islands
}

const NUM_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23, 'twenty-four': 24, 'twenty-five': 25 }
const NUM_NORM = new Map(Object.entries(NUM_WORD).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v]))
const numOf = (s) => {
  const t = String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (/^\d+$/.test(t)) return +t
  return NUM_NORM.get(t) ?? NUM_WORD[t] ?? null
}

/**
 * 播报头形态（锚定的规范前缀）：「Questions N to M」后只允许跟播报尾词的
 * 任意前缀（are / are based. / are based on the … / … you have just heard.）。
 * 不锚定的话题干标签「Question twenty-one.」会被解析成范围 20-21（实测误报）。
 */
const N_ALT = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[\\s-](?:one|two|three|four|five))?)'
const HEAD_RE = new RegExp(
  '^questions?\\s+' + N_ALT + '\\s*(?:to|and|-|\\u2013)\\s*' + N_ALT
  + '\\s*(?:are\\.?\\s*(?:based\\.?\\s*(?:on\\s+the\\s*(?:news\\s+report|conversation|passage|recording|following\\s+conversation)?\\s*(?:you\\s*(?:have\\s*(?:just\\s*(?:heard\\.?)?)?)?)?)?)?)?$',
  'i')

/** 播报尾形态：Are based on the… / Based on the news report…（排除正文的 Based on the findings/that/available data） */
const TAIL_RE = /^(?:are\s+)?based\s+on\s+the\s+(?:news\s+report|conversation|passage|recording|following)/i

const conn = await connect()
const [rows] = await conn.query('select id, category_id, title, audio_object_name, transcript_json from exercises order by id')
const presetOf = (cat) => (cat === 9 ? 'cet4' : 'cet6')

const jobs = []
for (const r of rows) {
  const lines = typeof r.transcript_json === 'string' ? JSON.parse(r.transcript_json) : r.transcript_json
  for (let i = 0; i < lines.length; i++) {
    const t = String(lines[i].text || '').trim()
    const hasRange = HEAD_RE.test(t)
    const hasFull = /based\s+on/i.test(t) && /you\s+have\s+just\s+heard/i.test(t)
    const isHeadFrag = hasRange && !hasFull          // A：头形态但句子不完整
    const isTailFrag = TAIL_RE.test(t) && !hasRange  // B/C：尾形态
    if (!isHeadFrag && !isTailFrag) continue
    jobs.push({ row: r, lines, i, line: lines[i], kind: isHeadFrag ? 'head' : 'tail', text: t })
  }
}
console.log(`检出残片行 ${jobs.length} 处：`)
for (const j of jobs) console.log(`  #${j.row.id}(${presetOf(j.row.category_id)}) [${j.kind}] 「${j.text.slice(0, 46)}」`)

// 逐课修复
const byCourse = new Map()
for (const j of jobs) {
  if (!byCourse.has(j.row.id)) byCourse.set(j.row.id, j.row)
  byCourse.get(j.row.id).__jobs = (byCourse.get(j.row.id).__jobs ?? []).concat(j)
}

const results = [] // { row, lines, merges, preset }
for (const [cid, row] of byCourse) {
  const jobsHere = row.__jobs
  delete row.__jobs
  const lines = jobsHere[0].lines
  const audio = path.join(STORE, row.audio_object_name)
  if (!fs.existsSync(audio)) { console.error(`✗ #${cid} 无音频`); continue }
  const islands = speechIslands(audio)
  let merges = 0
  const touched = []
  const consumed = new Set() // 已被配对合并吃掉的行对象

  /** 转写单个岛（带缓存） */
  const transcribe = async (isl) => {
    const id = `f-${cid}-${isl[0].toFixed(2)}-${isl[1].toFixed(2)}`
    const cf = path.join(CACHE, id + '.txt')
    if (fs.existsSync(cf)) return fs.readFileSync(cf, 'utf8').trim()
    const mp3 = path.join(CACHE, id + '.mp3')
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(isl[0]), '-t', String(isl[1] - isl[0]),
      '-i', audio, '-ac', '1', '-b:a', '64k', mp3, '-y'], { stdio: 'ignore' })
    let text = ''
    try { text = await mimoRaw(mp3); calls++ } catch { text = '' }
    fs.writeFileSync(cf, text)
    fs.rmSync(mp3, { force: true })
    return text.trim()
  }
  /** 期望题号范围：原行有就用原行；没有就从后一行题干号推断（该号应落在范围内） */
  const expectedCover = (j) => {
    const m = j.text.match(HEAD_RE)
    if (m) return { a: numOf(m[1]), b: numOf(m[2]) }
    const nxt = j.lines[j.lines.indexOf(j.line) + 1]
    const nm = String(nxt?.text ?? '').match(/^(?:Q\s*(\d+)|Question\s+(\d+))/i)
    const n = nm ? Number(nm[1] ?? nm[2]) : null
    return n ? { cover: n } : null
  }
  /** 岛文本是否可作为本行的播报句（完整句，或前缀句可模板补全），返回最终文本或 null */
  const asAnnouncement = (text, exp, preset, near = false) => {
    const m = text.match(/^questions?\s+(\S+)\s*(?:to|and|-|–)\s*(\S+)/i)
    if (!m || numOf(m[1]) === null || numOf(m[2]) === null) return null
    const a = numOf(m[1]); const b = numOf(m[2])
    if (exp?.a !== undefined) {
      if (a !== exp.a || b !== exp.b) {
        // 近距岛（≤10s）题号不一致时以音频为准（事实源仲裁：音频 > 原文）——
        // 实测 #16 原行写 "Questions 22 to 25"，音频念 "twenty-three to twenty-five"，
        // 原文的题号范围本身就是错的。远距岛仍严格要求一致（防串到别的题组）。
        if (!near) return null
        if (/based\s+on/i.test(text) && /you\s+have\s+just\s+heard/i.test(text)) {
          console.error(`  ⚠ 题号以音频为准：原「${exp.a}-${exp.b}」→ 音频「${a}-${b}」`)
        } else return null
      }
    } else if (exp?.cover !== undefined) {
      if (!(exp.cover >= a && exp.cover <= b)) return null
    }
    if (/based\s+on/i.test(text) && /you\s+have\s+just\s+heard/i.test(text)) return text.trim()
    // 转写只有半句（实测 #35 岛只出 "Questions five to eight."）：按题号段推类型补模板句
    const t = preset === 'cet4'
      ? (b <= 7 ? 'news report' : b <= 15 ? 'conversation' : 'passage')
      : (b <= 8 ? 'conversation' : b <= 15 ? 'passage' : 'recording')
    return `Questions ${a} to ${b} are based on the ${t} you have just heard.`
  }

  // 按行序处理：头行先处理并直接吞掉相邻尾行，尾行任务后到时跳过
  jobsHere.sort((a, b) => a.i - b.i)
  for (const j of jobsHere) {
    // 按行对象引用判重：配对合并 splice 后数组下标会位移（实测尾行任务错打到题干行）
    if (consumed.has(j.line)) continue
    const rowStart = j.line.start
    // 候选岛：±15s 内全部 ≥0.5s 岛，按距离排序逐个转写，取第一个能构成播报句的
    // 两级窗口：±15s（正常情况）；不够再 ±40s（末尾几组播报行在旧管线里
    // 可能被放偏 20s+，实测 #16/#21/#22/#26/#27）
    const candsOf = (win) => islands
      .filter(([a, b]) => b - a >= 0.5 && a <= rowStart + win && b >= rowStart - win)
      .map(([a, b]) => ({ a, b, d: Math.min(Math.abs(a - rowStart), Math.abs(b - rowStart)) }))
      .sort((x, y) => x.d - y.d)
    const cand = [...candsOf(15), ...candsOf(40).filter((c) => Math.abs(c.a - rowStart) > 15 && Math.abs(c.b - rowStart) > 15)]
    const exp = expectedCover(j)
    const preset = presetOf(row.category_id)
    let isl = null
    let text = null
    for (const cd of cand) {
      const t = await transcribe([cd.a, cd.b])
      const full = t ? asAnnouncement(t, exp, preset, cd.d <= 10) : null
      if (process.env.DBG_FRAG && t) console.error('   [cand ' + cd.a.toFixed(1) + '~' + cd.b.toFixed(1) + ' d=' + cd.d.toFixed(1) + ' exp=' + JSON.stringify(exp) + '] ' + (full ? 'HIT' : 'no: ' + t.slice(0, 44)))
      if (full) { isl = [cd.a, cd.b]; text = full; break }
    }
    if (!isl) { console.error(`✗ #${cid} 残片行 @${rowStart.toFixed(0)}s ±40s 内找不到播报岛`); continue }
    const l = j.line
    const li = j.lines.indexOf(l)
    const prev = j.lines[li - 1]
    const next = j.lines[li + 1]
    if (j.kind === 'head' && next && TAIL_RE.test(String(next.text).trim()) && !HEAD_RE.test(String(next.text).trim())) {
      // C 拆裂对：尾巴行并入头行
      l.text = text
      l.start = +Math.min(l.start, isl[0]).toFixed(2)
      l.end = +Math.max(next.end, isl[1]).toFixed(2)
      consumed.add(next)
      j.lines.splice(j.lines.indexOf(next), 1)
      merges++
      touched.push(`合并对→「${text.slice(0, 40)}」`)
    } else {
      // A/B：只补全文本 + 吸附岛界
      l.text = text
      l.start = +isl[0].toFixed(2)
      l.end = +isl[1].toFixed(2)
      touched.push(`补全→「${text.slice(0, 40)}」`)
    }
  }
  if (!touched.length) continue
  // 单调化（合并/吸附可能造成与邻行重叠）：重叠时收回前行终点，不得低于其可读时长
  const needOf = (ln) => {
    const wc = (String(ln.text).replace(/^[A-Z]{1,3}:\s*/, '').match(/[a-zA-Z0-9']+/g) || []).filter((w) => w.length >= 2).length
    return Math.min(Math.max(wc * 0.28, 0.3), 20)
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
  for (let i = 0; i < lines.length; i++) lines[i].id = `l${i + 1}`
  results.push({ row, lines, merges, preset: presetOf(row.category_id) })
  console.log(`#${cid}「${row.title}」: ${touched.join('；')}`)
}

console.log(`\n══ ${results.length} 门待写（合并 ${results.reduce((s, r) => s + r.merges, 0)} 对）；MiMo 调用 ${calls} ══`)
fs.writeFileSync('temp/frag-fix-out.json', JSON.stringify(results.map((r) => ({ cid: r.row.id, preset: r.preset, merges: r.merges }))))
if (!APPLY) { console.log('DRY 结束'); await conn.end(); process.exit(0) }

// 落库：按 preset 分组升版本
for (const preset of ['cet4', 'cet6']) {
  const group = results.filter((r) => r.preset === preset)
  if (!group.length) continue
  const seedPath = `presets/${preset}/seed.json`
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const pfx = `${today}.`
  const nextVersion = seed.version.startsWith(pfx)
    ? `${pfx}${Number(seed.version.slice(pfx.length)) + 1}`
    : `${pfx}1`
  let ok = 0
  for (const { row, lines, merges } of group) {
    // lines 本身就是 DB 行对象的浅拷贝（带全部旧字段），文本/时间已就地修正
    try {
      await saveTranscript({
        conn, cid: row.id, lines, version: nextVersion, seedPath,
        expect: { lineDelta: [-merges, 0], note: `播报残片修复（补全 ${lines.length ? '' : ''}文本/合并拆裂对）` },
        dryRun: false,
      })
      ok++
    } catch (e) { console.error(`✗ #${row.id} ${e.message}`) }
  }
  console.log(`${preset} v${seed.version} → v${nextVersion}：${ok}/${group.length} 门写入`)
}
await conn.end()
console.log('记得：check-invariants --rebuild-baseline + 全门禁')
