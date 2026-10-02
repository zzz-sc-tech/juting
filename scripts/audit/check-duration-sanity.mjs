// ═══════════════════════════════════════════════════════════════
// 时长健全性硬门禁 —— 2026-10-02 时长压缩伤清零后的防复发制度。
//
// 背景：压缩伤（如 #27 l71 十九个词压成 0.3 秒）曾长期藏在 layer2 的
// B-rate「警告」里被当成计分天然误报整类放过（两次漏检的根因）。
// 铁律：任何警告必须逐条闭环成「修复/确认为真误报」二选一——本门禁把
// 该类问题从警告升级为 FAIL。
//
// 判据：每行预期时长 = 有效词数 × 0.28s（自然听力语速 2.5~3.5 词/s 的保守下界），
//       实际时长 < 预期 × 0.35 → FAIL（即有效语速 > 10 词/s，只能是压缩/吞句）。
// 豁免：标记行（CONVERSATION/PASSAGE/RECORDING/TALK/LECTURE/Section X 的
//       0.3s 属吸附设计）；无有效 token 的行。
// 基线：temp/duration-sanity-baseline.json 记录现存违例为已知（历史遗留，另案处理），
//       之后只对新违例 FAIL。合法处理后 --rebuild-baseline 重建。
// 用法: node scripts/audit/check-duration-sanity.mjs [--rebuild-baseline]
//   退出码：新违例 > 0 → 1（并入四门禁流程）
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs'
import mysql from 'mysql2/promise'

const REBUILD = process.argv.includes('--rebuild-baseline')
const SEC_PER_WORD = 0.28 // 预期时长的保守语速
const FLOOR = 0.35 // 实际 < 预期×0.35 判压缩（>10 词/s）
const MARKER = /^(CONVERSATION|PASSAGE|RECORDING|TALK|LECTURE)\s+\d+|^Section\s+[ABC]/i
const BASELINE_PATH = 'temp/duration-sanity-baseline.json'

// 有效词数：去掉说话人前缀（M:/W:），单字符词（I/a/M）不计——短插话天然短，不设防
const wordCount = (t) => ((String(t).replace(/^[A-Z]:\s*/, '').match(/[a-zA-Z0-9']+/g) || []).filter((w) => w.length >= 2)).length

const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3307, database: 'duolinting_app_dev', user: 'duolinting', password: process.env.MYSQL_PASSWORD || 'duolinting' })
const [rows] = await conn.query('SELECT id,title,transcript_json FROM exercises ORDER BY id')
await conn.end()

const violations = []
for (const row of rows) {
  for (const l of row.transcript_json) {
    const dur = Number(l.end) - Number(l.start)
    if (!(dur > 0)) continue // 时间非法由 T5/layer2 管
    if (MARKER.test(String(l.text).trim())) continue
    const words = wordCount(l.text)
    if (!words) continue
    const expected = words * SEC_PER_WORD
    if (dur < expected * FLOOR) violations.push({ cid: row.id, id: l.id, dur: +dur.toFixed(2), expected: +expected.toFixed(2), words, wps: +(words / dur).toFixed(1), text: String(l.text).slice(0, 50) })
  }
}

const baseline = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : {}
const fresh = violations.filter((v) => !baseline[`${v.cid}:${v.id}`])

if (REBUILD) {
  const next = {}
  for (const v of violations) next[`${v.cid}:${v.id}`] = { dur: v.dur, expected: v.expected }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 1))
}

console.log('\n════════ 时长健全性门禁 ════════')
console.log(`共 ${rows.length} 门：违例 ${violations.length} 条（已知 ${violations.length - fresh.length}，新增 ${fresh.length}）`)
for (const v of violations) {
  const known = !fresh.includes(v)
  console.log(`${known ? '·已知' : '❌新增'} #${v.cid} ${v.id} ${v.dur}s < 预期${v.expected}s（${v.words}词，${v.wps}词/s）「${v.text}…」`)
}
if (REBUILD) console.log(`基线已重建 → ${BASELINE_PATH}`)
if (fresh.length) { console.log('FAIL'); process.exit(1) }
console.log('PASS')
