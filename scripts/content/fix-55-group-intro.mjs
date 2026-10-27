/**
 * #55 组播报行文本修复（2026-10-27）：l35 位置（152.8s）的文本被写成 Q1 题干
 * 「What does the man say about the job in the States?」，与下一条 Q1 行完全重复；
 * 而词流显示 145.92–149.88s 实际念的是组播报
 * 「Questions 1 to 4 are based on the conversation you have just heard.」。
 *
 * 处理：按组播报模板改写该行文本（去掉题干译文——播报行在库里一贯无译文），
 * 起点钉到播报首词 145.92，终点 150.0（Q1 题干 152.83 之前）。
 *
 * 注意：本脚本改完文本/起点后，必须再跑一次
 *   node scripts/content/retime-by-wordmap-v2.mjs --apply --ids 55
 * （原重复的两行在钉位时被判为同文，后一行被最小时长顶到 153.88s；
 *   文本改正后重钉才能回到 Q1 题干真实词位 152.83s）
 *
 * 用法：node scripts/content/fix-55-group-intro.mjs [--apply]
 */
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const APPLY = process.argv.includes('--apply')
const CID = 55
const INTRO = 'Questions 1 to 4 are based on the conversation you have just heard.'

const conn = await connect()
const [rows] = await conn.query('select transcript_json from exercises where id=?', [CID])
const lines = (typeof rows[0].transcript_json === 'string' ? JSON.parse(rows[0].transcript_json) : rows[0].transcript_json).map((l) => ({ ...l }))

const idx = lines.findIndex((l) => Math.abs(l.start - 152.8) < 0.5 && /^What does the man say about the job in the States\?$/.test(String(l.text).trim()))
if (idx < 0) throw new Error('未找到目标行（文本/起点不匹配），可能已修过')
const l = lines[idx]
const next = lines[idx + 1]
if (!next || !/^Q1\./.test(String(next.text).trim())) throw new Error(`下一行不是 Q1（实际：${next?.text}）`)

console.log(`修复 #${CID} ${l.id}：「${l.text}」@${l.start} → 组播报 @145.92`)
l.text = INTRO
delete l.translation
l.start = 145.92
l.end = 150
// 前一行（In fact...）原 end 被上一轮撑到 148.22，收回到播报起点
const prev = lines[idx - 1]
if (prev && prev.end > 145.92) prev.end = 145.92

const seedPath = 'presets/cet6/seed.json'
const seed = JSON.parse((await import('node:fs')).readFileSync(seedPath, 'utf8'))
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const prefix = `${today}.`
const version = seed.version.startsWith(prefix) ? `${prefix}${Number(seed.version.slice(prefix.length)) + 1}` : `${prefix}1`

await saveTranscript({ conn, cid: CID, lines, version, seedPath,
  expect: { lineDelta: [0, 0], allowUntranslatedGrow: true, note: '组播报行文本修复（l35 被错写成 Q1 题干）' },
  dryRun: !APPLY })
await conn.end()