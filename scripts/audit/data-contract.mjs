// ═══════════════════════════════════════════════════════════════
// 数据契约库（transcript_json 写入红线）—— 2026-10-01 译文冲掉事故的制度化修复
//
// 背景：09-29~09-30 的修复脚本重写字幕行时只保留 id/start/end/text，
// 把全库 7778 句译文静默冲掉，三天后才从学习端界面发现。
// 根因不是某次手滑，而是：写路径没有契约、变更后没有「不该变的没变」校验。
//
// 本库三条强制线（AGENTS.md「数据写入红线」的机器实现）：
//   1. 字段契约：行的合法字段白名单 = CONTRACT_FIELDS；写入时逐行校验。
//   2. 译文透传守卫：新行文本若在旧数据/基线中带译文，新行必须保留译文
//      （按 text 匹配而非 id——重编号不豁免）。
//   3. 不变式门禁：行数漂移、译文覆盖、字段集合、id 连续、时间单调/重叠。
//
// 用法（写库脚本的标准姿势）：
//   import { connect, loadTranscript, saveTranscript } from '../audit/data-contract.mjs'
//   const conn = await connect()
//   const { lines } = await loadTranscript(conn, cid)
//   // ……只改要改的字段：lines[i] = { ...lines[i], start: 123.4 }
//   await saveTranscript({ conn, cid, lines, version: '2026xxxx.x',
//     expect: { lineDelta: [-2, 5], note: '题组块标记归位' }, dryRun: true })  // 先 dry
//   await saveTranscript({ …… dryRun: false })  // 确认后落库
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs'
import mysql from 'mysql2/promise'

export const CONTRACT_FIELDS = [
  'id', 'start', 'end', 'text',
  'translation', 'translations', 'answers', 'keywords',
]
const CONTRACT_SET = new Set(CONTRACT_FIELDS)

// 基线：健康态快照（本机 temp/，不入 git；合法变更后用 --rebuild-baseline 重建）
export const BASELINE_PATH = 'temp/invariants-baseline.json'
export const SEED_PATH = 'presets/cet6/seed.json'

export const connect = () =>
  mysql.createConnection({
    host: '127.0.0.1', port: 3307, database: 'duolinting_app_dev',
    user: 'duolinting', password: process.env.MYSQL_PASSWORD || 'duolinting',
  })

// ── 统计与检查 ──────────────────────────────────────────────

export const collectStats = (lines) => {
  const fields = new Set()
  const transMap = {}
  let withTranslation = 0
  for (const l of lines) {
    for (const k of Object.keys(l)) fields.add(k)
    const zh = (l.translation && String(l.translation).trim()) || (l.translations && l.translations['zh-CN'] && String(l.translations['zh-CN']).trim()) || ''
    if (zh) { withTranslation++; transMap[l.text] = zh }
  }
  return { lines: lines.length, withTranslation, fields: [...fields].sort(), transMap }
}

const timeChecks = (lines) => {
  const fails = []
  let prevEnd = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!(Number(l.end) > Number(l.start))) fails.push(`T5 行时间非法: ${l.id}`)
    if (Number(l.start) < prevEnd - 0.5) fails.push(`T5 时间倒挂: ${l.id} start=${l.start} < 前行 end=${prevEnd}`)
    if (i > 0 && Number(lines[i - 1].end) > Number(l.start) + 0.3) fails.push(`T5 音频级重叠: ${lines[i - 1].id} → ${l.id}`)
    prevEnd = Math.max(prevEnd, Number(l.end))
  }
  // T4 id 连续 l1..lN（全库现行约定；换约定须先改这里）
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].id !== `l${i + 1}`) { fails.push(`T4 id 不连续: 位置 ${i + 1} 是 ${lines[i].id}`); break }
  }
  return fails
}

// 译文透传守卫：新行 text 在参考数据中带译文，新行却没译文 → 事故信号
export const translationGuard = (newLines, refTransMap, refLabel = '旧数据') => {
  const losses = []
  for (const l of newLines) {
    const zh = (l.translation && String(l.translation).trim()) || (l.translations && l.translations['zh-CN']) || ''
    if (!zh && refTransMap[l.text]) losses.push(l.id)
  }
  return losses.map((id) => `G1 译文丢失: ${id}（text 在${refLabel}中带译文，新行没有）`)
}

// DB/某 seed 的全量 stats 与基线比对（check-invariants 的核心）
export const checkAgainstBaseline = (cid, stats, baseline, lines) => {
  const fails = []
  const warns = []
  const b = baseline[cid]
  if (!b) return { fails: [`T0 基线缺该课程`], warns }
  if (stats.withTranslation < b.withTranslation) fails.push(`T1 译文覆盖下降: ${stats.withTranslation} → 基线 ${b.withTranslation}（译文事故！）`)
  if (stats.withTranslation > b.withTranslation) warns.push(`T1 译文覆盖上升: ${b.withTranslation} → ${stats.withTranslation}（合法补译？记得 --rebuild-baseline）`)
  if (stats.lines < Math.floor(b.lines * 0.9)) fails.push(`T2 行数骤降: ${stats.lines} < 基线 ${b.lines}×0.9`)
  if (stats.lines > Math.ceil(b.lines * 1.15)) fails.push(`T2 行数暴涨: ${stats.lines} > 基线 ${b.lines}×1.15`)
  const newFields = stats.fields.filter((f) => !b.fields.includes(f))
  if (newFields.length) fails.push(`T3 出现契约外字段: ${newFields.join(',')}（先扩 CONTRACT_FIELDS 再写入）`)
  if (lines) fails.push(...timeChecks(lines))
  return { fails, warns }
}

// ── 读写通道 ────────────────────────────────────────────────

export const loadTranscript = async (conn, cid) => {
  const [rows] = await conn.query('SELECT id,title,transcript_json FROM exercises WHERE id=?', [cid])
  if (!rows.length) throw new Error(`课程 #${cid} 不存在`)
  const lines = rows[0].transcript_json.map((l) => ({ ...l }))
  return { title: rows[0].title, lines, stats: collectStats(lines) }
}

const loadSeed = () => JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'))

// 带护栏的落库（DB + seed 同步写；seed 每次写必须升版本号）
export const saveTranscript = async ({ conn, cid, lines, version, expect = {}, dryRun = true }) => {
  const { lineDelta = [0, 0], allowTranslationDrop = false, note = '' } = expect
  const old = await loadTranscript(conn, cid)
  const fails = []
  // 契约字段白名单
  for (const l of lines) {
    for (const k of Object.keys(l)) {
      if (!CONTRACT_SET.has(k)) fails.push(`契约外字段 ${k}（行 ${l.id}）`)
    }
  }
  // 译文透传（相对旧数据）
  const g1 = translationGuard(lines, old.stats.transMap, '旧数据')
  if (!allowTranslationDrop) fails.push(...g1.slice(0, 20))
  else if (g1.length) console.warn(`（已豁免）${g1.length} 行译文按声明丢弃`)
  // 行数变动边界必须显式声明
  const delta = lines.length - old.lines.length
  if (delta < lineDelta[0] || delta > lineDelta[1]) fails.push(`行数变动 ${delta} 超出声明范围 [${lineDelta[0]}, ${lineDelta[1]}]`)
  // 时间与 id
  fails.push(...timeChecks(lines))
  // 基线（若存在）
  if (fs.existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    const { fails: bf, warns } = checkAgainstBaseline(cid, collectStats(lines), baseline, null)
    fails.push(...bf)
    for (const w of warns) console.warn(`#${cid} ${w}`)
  }
  if (fails.length) {
    console.error(`\n❌ #${cid} 写入被红线拦截${note ? `（${note}）` : ''}：`)
    for (const f of fails.slice(0, 30)) console.error('   ' + f)
    if (dryRun) console.error('   （dry run；修好 mutator 再来）')
    throw new Error(`#${cid} 数据契约校验失败：${fails.length} 处`)
  }
  if (dryRun) {
    console.log(`✅ dry-run 通过 #${cid}：${old.lines.length} → ${lines.length} 行，译文 ${old.stats.withTranslation} → ${collectStats(lines).withTranslation}${note ? `（${note}）` : ''}`)
    return { ok: true, dryRun: true }
  }
  if (!version) throw new Error('落库必须传 seed 版本号（如 20261001.9）')
  const fixed = lines.map((l, i) => ({
    id: `l${i + 1}`,
    start: +Number(l.start).toFixed(2),
    end: +Number(l.end).toFixed(2),
    text: l.text,
    // 透传可选字段——只 spread，绝不白名单重建（译文事故的根因就是白名单）
    ...(l.translation ? { translation: l.translation } : {}),
    ...(l.translations && Object.keys(l.translations).length ? { translations: l.translations } : {}),
    ...(l.answers?.length ? { answers: l.answers } : {}),
    ...(l.keywords?.length ? { keywords: l.keywords } : {}),
  }))
  await conn.query('UPDATE exercises SET transcript_json=? WHERE id=?', [JSON.stringify(fixed), cid])
  const seed = loadSeed()
  seed.exercises.find((e) => e.id === cid).transcript_json = fixed
  seed.version = version
  seed.generatedAt = new Date().toISOString()
  const indent = 1
  fs.writeFileSync(SEED_PATH, JSON.stringify(seed, null, indent))
  console.log(`✅ 已写入 #${cid}（${fixed.length} 行）→ DB + seed v${version}`)
  return { ok: true, lines: fixed }
}
