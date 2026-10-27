/**
 * 回滚词级钉位（2026-10-27 ① 返工第一步）：把 20 门实验课的行时间恢复到
 * HEAD（commit 278c755）的已验收状态——上一轮钉位脚本在写前 sort(start)+seal 前推，
 * 把若干行"传送"到邻行 end（#1012 两句互换、#1001 三句 +4s、#55 多句 +6~12s）。
 *
 * 用法：node scripts/content/restore-from-head.mjs [--apply]
 * 默认 dry：只打印每门恢复前后的行数/差异数。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { connect } from '../audit/data-contract.mjs'

const APPLY = process.argv.includes('--apply')
const CID_FILE = 'temp/wordmap-v2'

const cids = fs.readdirSync(CID_FILE).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.replace('.json', ''))).sort((a, b) => a - b)
const headSeed = (p) => JSON.parse(execFileSync('git', ['show', `HEAD:${p}`], { encoding: 'utf8', maxBuffer: 1 << 28 }))
const seeds = { 'presets/cet4/seed.json': headSeed('presets/cet4/seed.json'), 'presets/cet6/seed.json': headSeed('presets/cet6/seed.json') }

const conn = await connect()
let restored = 0
for (const [seedPath, seed] of Object.entries(seeds)) {
  const cur = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
  let dirty = false
  for (const cid of cids) {
    const headEx = seed.exercises.find((e) => e.id === cid)
    const curEx = cur.exercises.find((e) => e.id === cid)
    if (!headEx || !curEx) continue
    const head = headEx.transcript_json
    const now = curEx.transcript_json
    if (head.length !== now.length) {
      console.log(`#${cid}「${headEx.title}」行数 ${now.length} → ${head.length}（整体恢复）`)
      curEx.transcript_json = head
      dirty = true
      restored++
      if (APPLY) await conn.query('UPDATE exercises SET transcript_json=? WHERE id=?', [JSON.stringify(head), cid])
      continue
    }
    let diff = 0
    for (let i = 0; i < head.length; i++) {
      if (Math.abs(head[i].start - now[i].start) > 0.001 || Math.abs(head[i].end - now[i].end) > 0.001 || head[i].text !== now[i].text) diff++
    }
    if (!diff) continue
    console.log(`#${cid}「${headEx.title}」恢复 ${head.length} 行（差异 ${diff} 处）`)
    curEx.transcript_json = head
    dirty = true
    restored++
    if (APPLY) {
      await conn.query('UPDATE exercises SET transcript_json=? WHERE id=?', [JSON.stringify(head), cid])
    }
  }
  if (dirty && APPLY) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const prefix = `${today}.`
    cur.version = cur.version.startsWith(prefix) ? `${prefix}${Number(cur.version.slice(prefix.length)) + 1}` : `${prefix}1`
    cur.generatedAt = new Date().toISOString()
    fs.writeFileSync(seedPath, JSON.stringify(cur, null, 2))
    console.log(`✅ ${seedPath} → v${cur.version}`)
  }
}
await conn.end()
console.log(`\n══ 回滚 ${restored} 门（${APPLY ? 'APPLY' : 'DRY'}）══`)