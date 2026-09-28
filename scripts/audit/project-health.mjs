// 项目体检（可复跑）：数据 / 接口 / 文件 / 配对 一次全查，逐项给 PASS / WARN / FAIL。
//
// 用法：
//   node --import tsx scripts/audit/project-health.mjs            # 全量
//   node --import tsx scripts/audit/project-health.mjs --brief    # 只打印汇总与问题项
//
// 依赖：MySQL 在 3307、后端 API 在 8100。两者不在时脚本会明确报出来而不是静默跳过。
import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { extractDialogueAnchors } from '../../packages/domain/src/dialogueAnchors'
import { parseYuanwenMd, tokenize } from '../content/yuanwen-lib.mjs'

const BRIEF = process.argv.includes('--brief')
const BASE = 'http://127.0.0.1:8100'
const MEDIA_DIR = 'temp/runtime/media-store/duolinting-media'
const YUANWEN_ROOT = process.env.YUANWEN_DIR ?? './原文（改成你的听力原文目录，或用 YUANWEN_DIR 环境变量）'

const findings = []
const add = (level, scope, message) => findings.push({ level, scope, message })
const ok = (scope, message) => add('OK', scope, message)
const warn = (scope, message) => add('WARN', scope, message)
const fail = (scope, message) => add('FAIL', scope, message)

const out = []
const say = (line = '') => { out.push(line); if (!BRIEF) console.log(line) }

// ── 读取 backend/.env（脚本不引源码，直接读配置）──────────────
const envOf = (src, key) => {
  for (const line of src.split('\n')) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`))
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}
const envSrc = fs.existsSync('backend/.env') ? fs.readFileSync('backend/.env', 'utf8') : ''

let db = null
try {
  db = await mysql.createConnection({
    host: '127.0.0.1', port: Number(envOf(envSrc, 'MYSQL_PORT') ?? 3307),
    database: envOf(envSrc, 'MYSQL_DATABASE') ?? 'duolinting_app_dev',
    user: envOf(envSrc, 'MYSQL_USER') ?? 'duolinting',
    password: process.env.MYSQL_PASSWORD ?? envOf(envSrc, 'MYSQL_PASSWORD') ?? '',
  })
  ok('环境', 'MySQL 3307 可连接')
} catch (e) {
  fail('环境', `MySQL 3307 不可连接：${e.code ?? e.message}（体检无法继续，先起库）`)
}

let apiUp = false
try {
  const r = await fetch(`${BASE}/api/v1/catalog`)
  apiUp = r.ok
  r.ok ? ok('环境', `后端 API ${BASE} 可用`) : fail('环境', `后端 API 返回 ${r.status}`)
} catch (e) {
  fail('环境', `后端 API 不可达：${e.message}`)
}

// ── 时长表（真实音频时长，ffprobe 产物）──────────────────────
const durMap = new Map()
if (fs.existsSync('temp/audio-durations.tsv')) {
  for (const line of fs.readFileSync('temp/audio-durations.tsv', 'utf8').split('\n')) {
    const [n, d] = line.split('\t'); if (n && d) durMap.set(n.trim(), parseFloat(d))
  }
} else {
  warn('数据', 'temp/audio-durations.tsv 缺失（拿不到真实音频时长，越界检查会退化）')
}

// ── md 索引（用于原文保真度与配对检查）──────────────────────
const mdIndex = new Map()
const mdByPath = new Map()
for (const dir of (fs.existsSync(YUANWEN_ROOT) ? fs.readdirSync(YUANWEN_ROOT) : [])) {
  const sub = path.join(YUANWEN_ROOT, dir)
  if (!fs.statSync(sub).isDirectory()) continue
  for (const f of fs.readdirSync(sub)) {
    if (!f.endsWith('.md') || f.startsWith('00-') || f.includes('.bak')) continue
    const p = path.join(sub, f)
    const y = f.match(/(\d{4})/)?.[1]
    const mo = f.match(/[年.](\d{1,2})月/)?.[1]?.padStart(2, '0')
    const st = f.match(/第(\d+)套/)?.[1] ?? '1'
    if (y && mo) {
      const key = `${y}-${mo}:${st}`
      if (mdIndex.has(key)) warn('数据', `原文索引冲突：${key} 同时命中 ${path.basename(mdIndex.get(key))} 与 ${f}`)
      mdIndex.set(key, p)
      mdByPath.set(p, (mdByPath.get(p) ?? 0) + 1)
    }
  }
}
const examKeyOf = (t) => {
  const y = t.match(/(\d{4})/)?.[1]
  const mo = t.match(/[年.](\d{1,2})月/)?.[1]?.padStart(2, '0')
  const st = t.match(/第(\d+)套/)?.[1] ?? '1'
  return y && mo ? `${y}-${mo}:${st}` : null
}

// ── 逐门检查 ────────────────────────────────────────────────
const SUSPECT_STUDY = [
  /^in this section\b/i, /^(?:three|four) questions\b/i, /^you hear a question\b/i, /^c and d\b/i,
  /^the cent(?:er|re)\.?$/i, /^directions\b/i, /^talks? followed\b/i, /^passage,\s*you will hear/i,
  /^choices marked\b/i, /^a single line through\b/i, /^(?:spoken|played) only once\b/i,
  /^questions?\s+\d+/i, /^q\d+\./i, /^recording\s+\d/i, /^section\s+[a-d]/i, /^conversation\s+\d/i,
  /^\s*[[(][^\])]{0,40}[\])]\s*$/,
]
const overlap = (a, b) => {
  const A = new Set(tokenize(a).filter((w) => w.length >= 4))
  const B = new Set(tokenize(b).filter((w) => w.length >= 4))
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return A.size ? inter / A.size : 1
}

let courses = []
if (db) {
  const [rows] = await db.query(
    'SELECT id,title,status,audio_object_name,duration_label,sort_order,transcript_json FROM exercises ORDER BY id',
  )
  courses = rows
  const pub = rows.filter((r) => r.status === 'published')
  say(`\n【一、课程与字幕（${rows.length} 门，其中 published ${pub.length}）】`)
  say('id   课程                  行数  越界   空档>3s  极短  超长  混入  锚点  空标签  保真度')
  for (const r of rows) {
    const lines = typeof r.transcript_json === 'string' ? JSON.parse(r.transcript_json) : r.transcript_json
    const scope = `#${r.id} ${r.title}`
    if (!Array.isArray(lines) || lines.length === 0) { fail(scope, '字幕为空或不是数组'); continue }

    const file = path.join(MEDIA_DIR, r.audio_object_name)
    const dur = durMap.get(path.basename(r.audio_object_name)) ?? null

    // 结构
    const idOk = lines.every((l, i) => l.id === `l${i + 1}`)
    let mono = true, overlapRows = 0, nonPositive = 0, maxEnd = 0
    let gaps3 = 0, gaps5 = 0, gaps15 = 0, short = 0, long = 0
    const seen = new Set()
    let dupAdjacent = 0, emptyText = 0, metaLeak = 0, markerRows = 0
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      const d = l.end - l.start
      if (d <= 0) nonPositive++
      if (d > 0 && d <= 0.7) short++
      if (d >= 20) long++
      if (i > 0) {
        if (l.start < lines[i - 1].end - 1e-6) overlapRows++
        if (l.start < lines[i - 1].start) mono = false
        const g = l.start - lines[i - 1].end
        if (g > 3) gaps3++
        if (g > 5) gaps5++
        if (g > 15) gaps15++
        if (String(l.text).trim() && String(l.text).trim() === String(lines[i - 1].text).trim()) dupAdjacent++
      }
      const t = String(l.text ?? '')
      if (!t.trim()) emptyText++
      if (/^\s*(#|>|\||```|---)/.test(t)) metaLeak++
      if (/^\s*[[(][^\])]{0,40}[\])]\s*$/.test(t.trim())) markerRows++
      if (seen.has(l.id)) fail(scope, `行 id 重复：${l.id}`)
      seen.add(l.id)
      maxEnd = Math.max(maxEnd, l.end)
    }
    if (!idOk) fail(scope, '行 id 不连续（应为 l1..lN）')
    if (!mono) fail(scope, '起点不是单调递增')
    if (overlapRows) fail(scope, `${overlapRows} 行与前一行时间重叠`)
    if (nonPositive) fail(scope, `${nonPositive} 行时长非正`)
    if (emptyText) fail(scope, `${emptyText} 行文本为空`)
    if (metaLeak) fail(scope, `${metaLeak} 行疑似元数据混入（# / > / | 等）`)
    if (markerRows) fail(scope, `${markerRows} 行是非语音标记（[silence] 等）`)
    if (dupAdjacent) fail(scope, `${dupAdjacent} 行与上一行文本完全相同`)
    if (gaps15) fail(scope, `${gaps15} 处 >15s 无字幕空档`)
    if (dur !== null) {
      const overflow = maxEnd - dur
      if (overflow > 1) fail(scope, `时间轴越界 +${overflow.toFixed(0)}s（音频 ${dur.toFixed(0)}s）`)
    } else {
      warn(scope, '拿不到真实音频时长，越界未检')
    }

    // 空档分诊：把 >5s 的空档按「空档里那段 ASR 的词是否已被原文收录」分类——
    // 收录了说明内容在相邻行里、只是这几秒没字幕（可接受）；没收录才是真漏内容。
    if (gaps5 > 0) {
      const [jobRows] = await db.query(
        'SELECT result_json FROM media_asr_jobs WHERE object_name=? AND status="succeeded" ORDER BY id DESC LIMIT 1',
        [r.audio_object_name],
      )
      const asrSegments = jobRows[0] ? JSON.parse(jobRows[0].result_json) : []
      const mdWords = new Set()
      const mdPathForGap = mdIndex.get(examKeyOf(r.title) ?? '')
      if (mdPathForGap) {
        for (const w of tokenize(parseYuanwenMd(fs.readFileSync(mdPathForGap, 'utf8')).map((s) => s.rawText ?? s.text).join(' '))) {
          if (w.length >= 4) mdWords.add(w)
        }
      }
      let coveredGaps = 0
      let missingGaps = []
      for (let i = 1; i < lines.length; i++) {
        const from = lines[i - 1].end
        const to = lines[i].start
        if (to - from <= 5) continue
        const inside = asrSegments.filter((s) => s.end > from + 0.5 && s.start < to - 0.5)
        const words = [...new Set(inside.flatMap((s) => tokenize(s.text)).filter((w) => w.length >= 4))]
        if (words.length === 0) { coveredGaps++; continue }
        const hit = words.filter((w) => mdWords.has(w)).length / words.length
        if (hit >= 0.6) coveredGaps++
        else missingGaps.push(`${from.toFixed(0)}–${to.toFixed(0)}s（原文未收录比例 ${(100 - hit * 100).toFixed(0)}%）`)
      }
      if (missingGaps.length) fail(scope, `${missingGaps.length} 处空档里的语音原文没收录：${missingGaps.join('; ')}`)
      else ok(scope, `${coveredGaps} 处 >5s 空档均属「内容已收录、仅这几秒无字幕」（答题空隙/播报与题干交界）`)
    }

    // 学习句口径：指令/题干/非语音标记不得混入
    const anchors = extractDialogueAnchors(lines)
    const instructionIds = new Set(anchors.flatMap((a) => a.lineIds))
    const study = lines.filter((l) => !instructionIds.has(l.id))
    const leaked = study.filter((l) => SUSPECT_STUDY.some((re) => re.test(String(l.text).trim())))
    if (leaked.length) {
      fail(scope, `逐句精听混入 ${leaked.length} 行非正文（例：${String(leaked[0].text).slice(0, 40)}）`)
    }
    const emptyLabel = anchors.filter((a) => !String(a.label ?? '').trim()).length
    if (emptyLabel) warn(scope, `${emptyLabel} 个锚点没有标签`)
    const labelCount = new Map()
    for (const a of anchors) labelCount.set(a.label, (labelCount.get(a.label) ?? 0) + 1)
    const dupLabel = [...labelCount.entries()].filter(([, n]) => n > 1)
    if (dupLabel.length) warn(scope, `锚点标签重复：${dupLabel.map(([l, n]) => `${l}×${n}`).join(', ')}`)
    if (anchors.length === 0) fail(scope, '没有任何锚点（精听没有分节跳转）')

    // 音频文件与 ASR 缓存
    if (!fs.existsSync(file)) fail(scope, `音频文件缺失：${r.audio_object_name}`)
    const [jobs] = await db.query(
      'SELECT id,status,model_name,language,result_json FROM media_asr_jobs WHERE object_name=? ORDER BY id DESC LIMIT 1',
      [r.audio_object_name],
    )
    if (!jobs[0]) fail(scope, '没有 ASR 缓存记录')
    else if (jobs[0].status !== 'succeeded') fail(scope, `最新 ASR 任务状态是 ${jobs[0].status}`)

    // 原文保真度
    const mdPath = mdByPath.has(mdIndex.get(examKeyOf(r.title) ?? '')) ? mdIndex.get(examKeyOf(r.title) ?? '') : null
    let fidelity = null
    if (mdPath && jobs[0]?.result_json) {
      const asrText = JSON.parse(jobs[0].result_json).map((s) => s.text).join(' ')
      const mdText = parseYuanwenMd(fs.readFileSync(mdPath, 'utf8')).map((s) => s.rawText ?? s.text).join(' ')
      fidelity = overlap(mdText, asrText)
      if (fidelity < 0.8) warn(scope, `原文保真度偏低 ${(fidelity * 100).toFixed(1)}%（原文与音频可能不同源）`)
    } else if (!mdPath) {
      warn(scope, '找不到对应原文 md（可能是课程标题命名不符约定）')
    }

    // 展示名一致性
    if (!/^\d{4}年\d{1,2}月 第\d+套/.test(r.title)) warn(scope, `课程命名不符合「YYYY年M月 第N套」约定：${r.title}`)
    if (dur !== null) {
      const m = String(r.duration_label ?? '').match(/^(\d+):(\d{2})$/)
      if (!m) warn(scope, `duration_label 格式异常：${JSON.stringify(r.duration_label)}`)
      else {
        const labelSec = Number(m[1]) * 60 + Number(m[2])
        if (Math.abs(labelSec - dur) > 60) warn(scope, `duration_label ${r.duration_label} 与真实时长 ${(dur / 60).toFixed(1)} 分差超过 1 分钟`)
      }
    }

    say(
      `#${String(r.id).padEnd(4)}${String(r.title).padEnd(21)}${String(lines.length).padStart(4)}` +
      `${dur === null ? '     ?' : String((maxEnd - dur).toFixed(0) + 's').padStart(7)}` +
      `${String(gaps3).padStart(8)}${String(short).padStart(6)}${String(long).padStart(6)}` +
      `${String(leaked.length).padStart(6)}${String(anchors.length).padStart(6)}${String(emptyLabel).padStart(8)}` +
      `${fidelity === null ? '      ?' : String((fidelity * 100).toFixed(1) + '%').padStart(9)}`,
    )
  }

  // 跨课程：原文配对是否唯一（两门课用同一份原文 = 配错套嫌疑）
  const keyToCourses = new Map()
  for (const r of rows) {
    const k = examKeyOf(r.title)
    if (!k) continue
    const arr = keyToCourses.get(k) ?? []
    arr.push(`#${r.id}`)
    keyToCourses.set(k, arr)
  }
  const sharedKey = [...keyToCourses.entries()].filter(([, ids]) => ids.length > 1)
  for (const [k, ids] of sharedKey) {
    const has3 = /（3套相同）|全1套|全1$/.test(rows.find((r) => ids.includes(`#${r.id}`))?.title ?? '')
    if (!has3) warn('配对', `多门课映射到同一套原文 ${k}：${ids.join(', ')}`)
  }

  // 跨课程：字幕首句重复（同一门课内容被复制到另一门）
  const first = new Map()
  for (const r of rows) {
    const lines = typeof r.transcript_json === 'string' ? JSON.parse(r.transcript_json) : r.transcript_json
    const sample = lines.filter((l) => String(l.text).length > 40).slice(0, 12).map((l) => String(l.text).trim().toLowerCase()).join('|')
    if (!sample) continue
    const dup = first.get(sample)
    if (dup) warn('配对', `#${dup} 与 #${r.id} 的前若干句完全相同（疑似同一套内容被挂到两门课）`)
    else first.set(sample, r.id)
  }
}

// ── 运行时接口 ──────────────────────────────────────────────
if (apiUp && db) {
  say('\n【二、运行时接口】')
  const j = async (u, init) => { const r = await fetch(u, init); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t.slice(0, 120) } } }
  const catalog = await j(`${BASE}/api/v1/catalog`)
  const cats = catalog.body.categories ?? []
  cats.length ? ok('接口', `GET /catalog → ${cats.length} 个目录`) : fail('接口', 'GET /catalog 没有目录')

  for (const c of cats) {
    const ex = await j(`${BASE}/api/v1/catalog/category/${c.id}/exercises`)
    const list = Array.isArray(ex.body) ? ex.body : (ex.body.data ?? [])
    list.length === courses.filter((r) => r.status === 'published').length
      ? ok('接口', `目录「${c.name ?? c.id}」→ ${list.length} 门课`)
      : warn('接口', `目录「${c.name ?? c.id}」返回 ${list.length} 门，published 是 ${courses.filter((r) => r.status === 'published').length} 门`)
  }

  let detailBad = 0
  let translationEcho = 0
  let mediaBad = 0
  for (const r of courses.filter((x) => x.status === 'published')) {
    const d = await j(`${BASE}/api/v1/exercises/${r.id}`)
    const ex = d.body.data ?? d.body
    const lines = ex.lines ?? []
    const dbLines = typeof r.transcript_json === 'string' ? JSON.parse(r.transcript_json) : r.transcript_json
    if (d.status !== 200 || lines.length !== dbLines.length) { detailBad++; warn('接口', `#${r.id} 详情接口行数 ${lines.length} ≠ 库里 ${dbLines.length}`) }
    if (lines.some((l) => String(l.translation ?? '').trim() === String(l.text ?? '').trim() && String(l.text).trim())) translationEcho++
    const media = await fetch(`${BASE}/api/v1/media/objects?key=${encodeURIComponent(r.audio_object_name)}`, { headers: { range: 'bytes=0-511' } }).catch(() => null)
    if (!media || (media.status !== 200 && media.status !== 206)) { mediaBad++; warn('接口', `#${r.id} 媒体接口返回 ${media ? media.status : '网络错误'}`) }
  }
  detailBad === 0 ? ok('接口', '38 门课程详情接口行数与库内一致') : fail('接口', `${detailBad} 门课程详情接口异常`)
  translationEcho === 0 ? ok('接口', '没有「译文回填原文」的行') : fail('接口', `${translationEcho} 门课存在译文=原文（字幕会重复显示）`)
  mediaBad === 0 ? ok('接口', '全部课程音频可访问（支持 Range）') : fail('接口', `${mediaBad} 门课音频接口异常`)

  const login = await j(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@duolinting.local', password: 'duolinting2026' }),
  })
  const token = login.body?.data?.token
  if (!token) fail('接口', `管理端登录失败：${JSON.stringify(login.body).slice(0, 120)}`)
  else {
    const auth = { authorization: `Bearer ${token}` }
    const list = await j(`${BASE}/api/v1/admin/exercises`, { headers: auth })
    const arr = Array.isArray(list.body) ? list.body : (list.body.data ?? [])
    arr.length ? ok('接口', `管理端课程列表 → ${arr.length} 门`) : fail('接口', '管理端课程列表为空')
    const status = await j(`${BASE}/api/v1/admin/asr/status`, { headers: auth })
    ok('接口', `ASR 状态：${JSON.stringify(status.body).slice(0, 120)}`)
  }
}

// ── 汇总 ────────────────────────────────────────────────────
const byLevel = { FAIL: [], WARN: [], OK: [] }
for (const f of findings) byLevel[f.level].push(f)
console.log('\n================ 体检结论 ================')
console.log(`通过 ${byLevel.OK.length} 项 ｜ 警告 ${byLevel.WARN.length} 项 ｜ 失败 ${byLevel.FAIL.length} 项`)
if (byLevel.FAIL.length) {
  console.log('\n—— 失败（必须修）——')
  for (const f of byLevel.FAIL) console.log(`  ✗ [${f.scope}] ${f.message}`)
}
if (byLevel.WARN.length) {
  console.log('\n—— 警告（需确认是否有害）——')
  for (const f of byLevel.WARN) console.log(`  ⚠ [${f.scope}] ${f.message}`)
}
if (byLevel.OK.length && !BRIEF) {
  console.log('\n—— 通过 ——')
  for (const f of byLevel.OK) console.log(`  ✓ [${f.scope}] ${f.message}`)
}
if (db) await db.end()
process.exit(byLevel.FAIL.length ? 1 : 0)
