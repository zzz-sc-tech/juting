/**
 * #1012 游离线删除：1391.13s 处的「Question twenty-one: What does Catherine realize
 * about her Facebook friends?」在音频里不存在（词流 1250.57s 才是真正的 Q21
 * "Question 21 what made Catherine feel bad about herself later on"；1391.15s 起是
 * Q22 木骡题），它是组播报行之后插入的一条重复题干，把 Q22 行挤成 0.02s。
 *
 * 用法：node scripts/content/del-1012-stray-q21.mjs [--apply]
 */
import fs from 'node:fs'
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const APPLY = process.argv.includes('--apply')
const CID = 1012
const NEEDLE = /^Question twenty-one: What does Catherine realize about her Facebook friends\?$/

const conn = await connect()
const [rows] = await conn.query('select transcript_json from exercises where id=?', [CID])
const lines = (typeof rows[0].transcript_json === 'string' ? JSON.parse(rows[0].transcript_json) : rows[0].transcript_json).map((l) => ({ ...l }))
const idx = lines.findIndex((l) => NEEDLE.test(String(l.text).trim()) && Math.abs(l.start - 1391.13) < 1)
if (idx < 0) throw new Error('未找到目标行（可能已删）')
if (!/^Question twenty two/i.test(String(lines[idx + 1]?.text ?? ''))) throw new Error('下一行不是 Q22，中止')
console.log(`删除 #${CID} ${lines[idx].id}：「${lines[idx].text}」@${lines[idx].start}`)
const out = lines.filter((_, i) => i !== idx).map((l, i) => ({ ...l, id: `l${i + 1}` }))

const seedPath = 'presets/cet4/seed.json'
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const prefix = `${today}.`
const version = seed.version.startsWith(prefix) ? `${prefix}${Number(seed.version.slice(prefix.length)) + 1}` : `${prefix}1`

await saveTranscript({ conn, cid: CID, lines: out, version, seedPath,
  expect: { lineDelta: [-1, -1], note: '删除游离线（重复 Q21 题干）' }, dryRun: !APPLY })
await conn.end()