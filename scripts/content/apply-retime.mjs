/**
 * 把 retime-transcript 的时间轴结果写回 seed + DB。
 *
 * 只改 start/end：行数、text、translation 一律不动，走 data-contract 的
 * saveTranscript 契约通道（dry 通过后才落库）。
 *
 * 用法：
 *   node scripts/content/apply-retime.mjs cet4 --dry
 *   node scripts/content/apply-retime.mjs cet4 --apply
 *
 * 前置：先跑 retime-transcript.mjs --apply 生成 temp/retime-<key>.json。
 * 落库后必须重建基线并跑门禁：
 *   node scripts/audit/check-invariants.mjs --rebuild-baseline
 *   node scripts/audit/check-invariants.mjs
 *   node scripts/audit/check-duration-sanity.mjs
 *   node scripts/audit/check-timeline-speech-overlap.mjs cet4
 */
import fs from 'node:fs'
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const key = process.argv[2] || 'cet4'
const APPLY = process.argv.includes('--apply')
const seedPath = `presets/${key}/seed.json`
const resultPath = `temp/retime-${key}.json`

if (!fs.existsSync(resultPath)) { console.error(`缺少 ${resultPath}，先跑 chunked-retime --apply`); process.exit(1) }
const payload = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
const current = seed.version

// 版本号：YYYYMMDD.N，同日递增
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const todayPrefix = `${today}.`
const nextVersion = current.startsWith(todayPrefix)
  ? `${todayPrefix}${Number(current.slice(todayPrefix.length)) + 1}`
  : `${todayPrefix}1`
console.log(`seed ${key} v${current} → v${nextVersion}（${payload.length} 课）`)

const conn = await connect()
let ok = 0, failed = 0
const failedIds = []

for (const { cid, lines } of payload) {
  const old = seed.exercises.find((e) => e.id === cid)
  if (!old) { console.error(`✗ #${cid} seed 里没有该课`); failed++; failedIds.push(cid); continue }
  if (old.transcript_json.length !== lines.length) {
    console.error(`✗ #${cid} 行数不一致 ${old.transcript_json.length} → ${lines.length}`)
    failed++; failedIds.push(cid); continue
  }
  // 逐行透传旧行，只替换 start/end（守住译文/字段）
  const merged = old.transcript_json.map((o, i) => ({
    ...o,
    start: lines[i].start,
    end: lines[i].end,
  }))
  try {
    await saveTranscript({
      conn, cid, lines: merged, version: nextVersion, seedPath,
      expect: { lineDelta: [0, 0], note: '时间轴重建（仅 start/end）' },
      dryRun: !APPLY,
    })
    ok++
  } catch (e) {
    failed++
    failedIds.push(cid)
    console.error(`✗ #${cid} ${e.message}`)
  }
}

await conn.end()
console.log(`\n══ ${ok} 成功 / ${failed} 失败 ══`)
if (failedIds.length) console.log('失败课号:', failedIds.join(' '))
if (APPLY && ok) console.log(`seed 已升到 v${nextVersion}；记得重建基线并跑门禁`)
