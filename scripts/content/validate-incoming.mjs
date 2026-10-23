/**
 * 入库前校验：检查「新场次素材」是否满足入库条件。
 *
 * 用于外部 agent 交付的初步文件（音频 + 听力原文 md）。它不写任何数据，
 * 只读 + 报告；任何一项 FAIL 都必须在入库前修掉，否则下游对齐/锚点会静默出错。
 *
 * 目录约定（相对仓库根）：
 *   <dir>/manifest.json          场次清单
 *   <dir>/audio/<key>.ogg        已转码的 opus（单声道）
 *   <dir>/audio/<key>.ogg.dlt-meta.json
 *   <dir>/yuanwen/<key>.md       听力原文
 *
 * manifest.json 结构：
 *   { "preset": "cet6",
 *     "sets": [ { "key": "cet6-2015-06-1", "year": 2015, "month": 6, "set": 1,
 *                 "title": "2015年6月 第1套", "sourceFile": "原文件名.mp3" } ] }
 *
 * 用法：
 *   node scripts/content/validate-incoming.mjs temp/cet6-1516
 *   node scripts/content/validate-incoming.mjs temp/cet6-1516 --json
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseYuanwenMd, tokenize } from './yuanwen-lib.mjs'

const dir = process.argv[2]
const AS_JSON = process.argv.includes('--json')
if (!dir) { console.error('用法：node scripts/content/validate-incoming.mjs <目录> [--json]'); process.exit(2) }

const problems = []
const warnings = []
const fail = (key, msg) => problems.push({ key, msg })
const warn = (key, msg) => warnings.push({ key, msg })

// ── manifest ────────────────────────────────────────────────
const manifestPath = path.join(dir, 'manifest.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`缺少 ${manifestPath}`)
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (!Array.isArray(manifest.sets) || !manifest.sets.length) {
  console.error('manifest.sets 为空')
  process.exit(1)
}

const ffprobe = (file) => JSON.parse(execFileSync('ffprobe',
  ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'format=duration:stream=codec_name,channels,sample_rate', '-of', 'json', file], { encoding: 'utf8' }))

// 允许出现的分节头（锚点提取器认这些形态）
const SECTION_HEAD = /^(?:section\s+[a-d]|conversation\s+(?:one|two|three|[0-9]+)|passage\s+(?:one|two|three|[0-9]+)|recording\s+(?:one|two|three|[0-9]+)|news\s+report\s+(?:one|two|three|[0-9]+)|lecture\s+[0-9]+|talk\s+[0-9]+|text\s+[0-9]+)\s*$/i

const report = []

for (const set of manifest.sets) {
  const { key } = set
  const entry = { key, ok: true, audio: null, md: null }

  // ── 音频 ─────────────────────────────────────────────────
  const ogg = path.join(dir, 'audio', `${key}.ogg`)
  const meta = `${ogg}.dlt-meta.json`
  if (!fs.existsSync(ogg)) fail(key, `缺少音频 ${path.relative(dir, ogg)}`)
  else {
    try {
      const p = ffprobe(ogg)
      const st = p.streams?.[0] ?? {}
      const dur = Number(p.format?.duration)
      if (st.codec_name !== 'opus') fail(key, `编码是 ${st.codec_name}，要求 opus`)
      if (Number(st.channels) !== 1) fail(key, `声道数 ${st.channels}，要求单声道`)
      if (!(dur > 0)) fail(key, '音频时长无效')
      if (Number(st.sample_rate) !== 48000) warn(key, `采样率 ${st.sample_rate}（opus 通常 48000）`)
      entry.audio = { codec: st.codec_name, channels: st.channels, duration: +dur.toFixed(1) }
    } catch (e) {
      fail(key, `ffprobe 失败：${e.message.split('\n')[0]}`)
    }
    if (!fs.existsSync(meta)) fail(key, `缺少旁车 ${path.basename(meta)}`)
    else {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'))
      if (m.contentType !== 'audio/ogg') fail(key, `旁车 contentType=${m.contentType}，要求 audio/ogg`)
    }
  }

  // ── 原文 md ──────────────────────────────────────────────
  const mdPath = path.join(dir, 'yuanwen', `${key}.md`)
  if (!fs.existsSync(mdPath)) fail(key, `缺少原文 ${path.relative(dir, mdPath)}`)
  else {
    const raw = fs.readFileSync(mdPath, 'utf8')
    const lines = raw.split('\n')

    // 1) 只允许 ASCII 引号（弯引号会把 haven't 拆成 haven + t）
    const curly = lines.filter((l) => /[\u2018\u2019\u201C\u201D]/.test(l))
    if (curly.length) fail(key, `${curly.length} 行含弯引号 ’‘“”（必须换成 ASCII ' 和 "）`)

    // 2) 不能有中文（原文 md 只放英文）
    const cjk = lines.filter((l) => /[\u4e00-\u9fff]/.test(l))
    if (cjk.length) fail(key, `${cjk.length} 行含中文（解析/译文不能混进原文）`)

    // 3) 不能有选项标签（A. B. C. D.）——那是题目选项，不是听力原文
    const opts = lines.filter((l) => /^\s*[A-D][.、)．]\s/.test(l))
    if (opts.length) fail(key, `${opts.length} 行是选项标签（A./B./C./D.），应剔除`)

    // 4) 分节头格式
    const heads = lines.map((l) => l.trim()).filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim())
    if (!heads.length) fail(key, '没有任何 "## 分节头"')
    for (const h of heads) {
      if (!SECTION_HEAD.test(h)) fail(key, `分节头「${h}」不被锚点提取器识别（要求 Section A / Conversation 1 / Passage 1 / Recording 1 / News Report 1 形式）`)
    }
    if (!heads.some((h) => /^section\s+[a-d]$/i.test(h))) warn(key, '没有 Section A/B/C 分节头')

    // 5) 题干编号必须 1..25 连续
    //    parseYuanwenMd 只认 "Q1." 形式；"Question 1." 会被当成正文句，
    //    因此后者能用但会告警（题干行应统一写成 Q 形式）。
    const qNums = []
    let longForm = 0
    for (const l of lines) {
      const m = l.trim().match(/^Q\s*(\d+)\s*[.。:：]/i)
      if (m) { qNums.push(Number(m[1])); continue }
      const m2 = l.trim().match(/^Question\s+(\d+)\s*[.。:：]/i)
      if (m2) { qNums.push(Number(m2[1])); longForm++ }
    }
    if (longForm) warn(key, `${longForm} 行题干写成 "Question N."，解析器只把 "QN." 当题干；建议统一为 Q 形式`)
    if (!qNums.length) fail(key, '没有任何 "Q1." 形式的题干行')
    else {
      const uniq = [...new Set(qNums)].sort((a, b) => a - b)
      const missing = []
      for (let n = 1; n <= 25; n++) if (!uniq.includes(n)) missing.push(n)
      if (missing.length) fail(key, `题干缺号：${missing.join(',')}`)
      if (uniq.length > 25) warn(key, `题干 ${uniq.length} 个（应 25 个）`)
      if (qNums.length !== uniq.length) warn(key, `题干有重复编号（${qNums.length} 行 / ${uniq.length} 个号）`)
    }

    // 6) 解析器实测
    const parsed = parseYuanwenMd(raw)
    const body = parsed.filter((s) => !s.isSectionHead)
    const words = body.reduce((n, s) => n + tokenize(s.rawText ?? s.text).length, 0)
    if (!body.length) fail(key, '解析结果为空')
    if (entry.audio?.duration && words) {
      const wps = words / entry.audio.duration
      if (wps < 1.2 || wps > 4.5) fail(key, `语速异常：${wps.toFixed(2)} 词/秒（正常 1.8~3.2）——原文与音频可能不匹配或漏段`)
      else if (wps < 1.6 || wps > 3.6) warn(key, `语速偏低/偏高：${wps.toFixed(2)} 词/秒`)
    }
    entry.md = { sections: heads.length, questions: [...new Set(qNums)].length, words, lines: body.length }
  }

  if (problems.some((p) => p.key === key)) entry.ok = false
  report.push(entry)
}

// ── 输出 ────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({ ok: problems.length === 0, report, problems, warnings }, null, 2))
} else {
  console.log(`\n══ 校验 ${dir}：${manifest.sets.length} 套 ══\n`)
  for (const r of report) {
    const a = r.audio ? `${r.audio.codec}/${r.audio.channels}ch ${r.audio.duration}s` : '音频缺失'
    const m = r.md ? `${r.md.sections} 节 / ${r.md.questions} 题 / ${r.md.words} 词` : '原文缺失'
    console.log(`${r.ok ? '✓' : '✗'} ${r.key.padEnd(18)} ${a.padEnd(26)} ${m}`)
  }
  if (problems.length) {
    console.log(`\n── FAIL ${problems.length} 项 ──`)
    for (const p of problems) console.log(`  ✗ ${p.key}: ${p.msg}`)
  }
  if (warnings.length) {
    console.log(`\n── 警告 ${warnings.length} 项 ──`)
    for (const w of warnings) console.log(`  ! ${w.key}: ${w.msg}`)
  }
  console.log(problems.length ? '\nFAIL' : '\nPASS')
}
process.exit(problems.length ? 1 : 0)
