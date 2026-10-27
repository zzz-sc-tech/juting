/**
 * 正文行偏晚归因验证（2026-10-27 ②深挖收口）：对已转写课的"偏晚>2s"正文行逐行
 * 做词流验证，判定其是否已在词位（±0.35s）。
 *
 * 结论数据（19 门）：340 行偏晚>2s 中 **301 行已在词位**（零间隙并岛的岛起点
 * 参照系伪差，行真实起点正确）、21 行过短无法可靠匹配、17 行词流无命中（ASR
 * 变体/归因脚本的 Q 标签不展开）、1 行歧义。→ 词级钉位无剩余可观收益，
 * 77 门补转写性价比不成立（178 行同比例 ~88% 预计已在位）。
 *
 * 真实正文行对齐口径（词位验证）：(15362 + 301) / 16357 ≈ **95.8%**
 * （主审计口径 93.97% 的差距即岛参照系伪差）。
 *
 * 用法：node temp/verify-body-onword.mjs   （只读，不改数据）
 */
import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { extractDialogueAnchors } from '../packages/domain/dist/index.js'

const NUM_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 }
const norm = (w) => { const s = String(w).toLowerCase().replace(/[^a-z0-9']/g, ''); return /^\d+$/.test(s) ? String(+s) : (NUM_WORD[s] !== undefined ? String(NUM_WORD[s]) : s) }

const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3307, user: 'root', password: process.env.MYSQL_PASSWORD || '', database: 'duolinting_app_dev' })
const [rows] = await conn.query('select id, transcript_json from exercises order by id')
await conn.end()
const wmIds = fs.readdirSync('temp/wordmap-v2').filter((f) => /^\d+\.json$/.test(f)).map((f) => f.replace('.json', ''))

const stats = { 在词位: 0, 短行: 0, 词流无命中: 0, 歧义或偏移: 0, 总计: 0 }
for (const row of rows) {
  if (!wmIds.includes(String(row.id))) continue
  const L = row.transcript_json
  const isl = JSON.parse(fs.readFileSync(path.join('temp/anchor-islands', row.id + '.json'), 'utf8')).islands
  const starts = isl.filter(([x, y]) => y - x >= 0.5).map(([x]) => x)
  const nearest = (t) => starts.reduce((p, x) => Math.abs(x - t) < Math.abs(p - t) ? x : p, starts[0])
  const anchors = extractDialogueAnchors(L.map((l) => ({ id: l.id, start: l.start, end: l.end, text: l.text })))
  const consumed = new Set(anchors.flatMap((x) => x.lineIds))
  const flow = JSON.parse(fs.readFileSync('temp/wordmap-v2/' + row.id + '.json', 'utf8')).words.map((w) => ({ w: norm(w.text), start: w.start }))
  for (const l of L) {
    if (consumed.has(l.id)) continue
    if (l.start - nearest(l.start) <= 2) continue
    stats['总计']++
    const needle = String(l.text).trim().replace(/^[MW]:\s*/i, '').split(/[^A-Za-z0-9']+/).filter(Boolean).map(norm).slice(0, 8)
    if (needle.length < 3) { stats['短行']++; continue }
    let bestHit = 0, bestT = null
    for (let i = 0; i < flow.length; i++) {
      if (flow[i].start > l.start + 15) break
      if (flow[i].start < l.start - 15) continue
      let j = 0, k = i, hit = 0
      while (j < needle.length && k < flow.length) { if (flow[k].w === needle[j]) { hit++; j++; k++ } else break }
      if (hit > bestHit) { bestHit = hit; bestT = flow[i].start }
    }
    if (bestHit < 3) { stats['词流无命中']++; continue }
    if (Math.abs(bestT - l.start) < 0.35) stats['在词位']++
    else stats['歧义或偏移']++
  }
}
console.log(JSON.stringify(stats, null, 1))
const rate = stats['在词位'] / Math.max(stats['总计'], 1)
console.log(`\n在词位率 ${(100 * rate).toFixed(1)}%——"偏晚>2s"主体是岛起点参照系伪差，行真实起点正确`)
fs.writeFileSync('temp/body-late-attribution.json', JSON.stringify(stats, null, 1))
