/**
 * 译文补全收集器：把 temp/translations/out-{cid}.json 的译文合并进各课字幕行，
 * 走 saveTranscript 契约写入（lineDelta [0,0]，先 dry 后 apply）。
 *
 * 校验（写入前）：
 *  - 每门课的 out 文件必须覆盖该课全部待译行（task-{cid}.json 的 need:true 集合），
 *    多余 id / 重复 id / 空译文 → 拒收该门并报告；
 *  - 译文不能等于原文（未翻译迹象）、不含 markdown 标记。
 *
 * 用法：node scripts/content/fill-translations.mjs --dry|--apply
 */
import fs from 'node:fs'
import path from 'node:path'
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const APPLY = process.argv.includes('--apply')
const DIR = 'temp/translations'

/**
 * 行是否「有可译的实质内容」——否则译文=原文合法，不作拒收条件。
 * 豁免两类（实测代理照抄是对的）：
 *  1. 纯标签行：A. / B. / C. / D. / Part 2. / Listening Comprehension. 等选项与节次标签；
 *  2. 原文本身已是中文的 ASR 残行（译者按规则仅规范标点保留）。
 */
const translatableContent = (raw) => {
  const t = String(raw).trim()
  if (/[一-鿿]/.test(t)) return false   // 已是中文
  const body = t
    .replace(/^(?:[MW]:\s*)+/i, '')
    .replace(/^(?:q\s*\d+|question\s+\d+|part\s+\d+|[A-Da-d])[.。:：,，)\s]*/i, '')
    .trim()
  const wordsIn = body.match(/[A-Za-z']+/g) ?? []
  const hasCJKWord = /[一-鿿]/.test(body)
  return hasCJKWord || wordsIn.filter((w) => w.length >= 2).length >= 2
}

const conn = await connect()
const worklist = JSON.parse(fs.readFileSync('temp/translation-worklist.json', 'utf8'))
const cids = [...worklist.cet6, ...worklist.cet4].map((x) => x.cid)
const [rows] = await conn.query(
  'select id, category_id, transcript_json from exercises where id in (' + cids.join(',') + ') order by id')
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')

let totalFilled = 0, rejected = []
const payload = []
for (const row of rows) {
  const tf = path.join(DIR, `task-${row.id}.json`)
  const of = path.join(DIR, `out-${row.id}.json`)
  if (!fs.existsSync(of)) { rejected.push(`#${row.id} 无 out 文件`); continue }
  const task = JSON.parse(fs.readFileSync(tf, 'utf8'))
  const need = new Set(task.lines.filter((l) => l.need).map((l) => l.id))
  let outs
  try { outs = JSON.parse(fs.readFileSync(of, 'utf8')) } catch (e) { rejected.push(`#${row.id} out JSON 解析失败: ${e.message}`); continue }
  const byId = new Map()
  let bad = []
  for (const o of outs) {
    if (!need.has(o.id)) { bad.push(`多余 id ${o.id}`); continue }
    if (byId.has(o.id)) { bad.push(`重复 id ${o.id}`); continue }
    const zh = String(o.translation ?? '').trim()
    const src = String(task.lines.find((l) => l.id === o.id)?.text ?? '').trim()
    if (!zh) { bad.push(`${o.id} 空译文`); continue }
    // 仅对有可译实质内容的行要求译文≠原文；纯标签/中文原文行照抄合法
    if (zh === src && translatableContent(src)) { bad.push(`${o.id} 译文=原文`); continue }
    if (/[#*`]{2,}|^\s*[-*]\s/m.test(zh)) { bad.push(`${o.id} 含 markdown`); continue }
    byId.set(o.id, zh)
  }
  const missing = [...need].filter((id) => !byId.has(id))
  if (bad.length || missing.length) { rejected.push(`#${row.id} 拒收：${bad.slice(0, 3).join('；')}${missing.length ? `；缺 ${missing.length} 条(${missing.slice(0, 3).join(',')})` : ''}`); continue }
  // 合并写入
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => {
    if (!byId.has(l.id)) return l
    // translation 与 translations 并存时只补缺的那个槽，避免双份
    if (l.translations && Object.keys(l.translations).length) return { ...l, translations: { ...l.translations, 'zh-CN': l.translations['zh-CN'] || byId.get(l.id) } }
    return { ...l, translation: l.translation || byId.get(l.id) }
  })
  payload.push({ row, lines, n: byId.size })
  totalFilled += byId.size
}
console.log(`校验通过 ${payload.length} 门 / ${totalFilled} 条；拒收 ${rejected.length} 门`)
for (const r of rejected) console.log('  ' + r)
fs.writeFileSync('temp/translations/collect-report.json', JSON.stringify({ filled: totalFilled, courses: payload.length, rejected }, null, 1))

if (APPLY && payload.length) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const todayPrefix = `${today}.`
  const nextVersionOf = new Map()
  let ok = 0, failed = 0
  for (const { row, lines, n } of payload) {
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
        expect: { lineDelta: [0, 0], allowNewFields: ['translation'], note: `译文补全 ${n} 条` },
        dryRun: false,
      })
      ok++
    } catch (e) { failed++; console.error(`✗ #${row.id} ${e.message}`) }
  }
  console.log(`\n══ 落库 ${ok} 成功 / ${failed} 失败 ══`)
}
await conn.end()
