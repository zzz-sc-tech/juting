// 不变式门禁：DB（或任一历史 seed）vs 基线快照。
// 事故背景：09-30 修复管线把全库译文静默冲掉，现有门禁（只查"修复目标"）全程绿灯。
// 本门禁查的是反方向——「不该变的有没有变」。
//
// 用法：
//   node scripts/audit/check-invariants.mjs                     # DB vs 基线（每轮数据修复后必跑）
//   node scripts/audit/check-invariants.mjs --rebuild-baseline  # 健康态重建基线（合法变更后）
//   node scripts/audit/check-invariants.mjs --against <file>    # 审计任意 seed 快照（含 git show 出的历史版）
//   node scripts/audit/check-invariants.mjs --heal              # 从基线译文映射自动回填丢失译文
import fs from 'node:fs'
import { connect, collectStats, checkAgainstBaseline, translationGuard, BASELINE_PATH } from './data-contract.mjs'

const args = process.argv.slice(2)
const REBUILD = args.includes('--rebuild-baseline')
const HEAL = args.includes('--heal')
const againstIdx = args.indexOf('--against')
const againstFile = againstIdx >= 0 ? args[againstIdx + 1] : null

const conn = await connect()

// 数据源：DB 或指定 seed 文件
let courses = []
if (againstFile) {
  const seed = JSON.parse(fs.readFileSync(againstFile, 'utf8'))
  courses = seed.exercises.map((e) => ({ id: e.id, title: e.title, lines: e.transcript_json }))
  console.log(`审计对象：${againstFile}（v${seed.version}，${courses.length} 门）`)
} else {
  const [rows] = await conn.query("SELECT id,title,transcript_json FROM exercises WHERE status='published' ORDER BY sort_order")
  courses = rows.map((r) => ({ id: r.id, title: r.title, lines: r.transcript_json }))
}

if (REBUILD) {
  const baseline = {}
  for (const c of courses) baseline[c.id] = collectStats(c.lines)
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 1))
  const totalTrans = Object.values(baseline).reduce((s, b) => s + b.withTranslation, 0)
  console.log(`基线已重建：${Object.keys(baseline).length} 门 / ${totalTrans} 句译文 → ${BASELINE_PATH}`)
  await conn.end()
  process.exit(0)
}

const baseline = fs.existsSync(BASELINE_PATH)
  ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  : null
if (!baseline) {
  console.error(`无基线（${BASELINE_PATH}）。先跑 --rebuild-baseline 建立健康态快照。`)
  await conn.end()
  process.exit(1)
}

let failCourses = 0
const healUpdates = []
for (const c of courses) {
  const stats = collectStats(c.lines)
  const { fails, warns } = checkAgainstBaseline(c.id, stats, baseline, c.lines)
  if (HEAL && !againstFile) {
    // 基线译文映射兜底回填（G1 的自动修复形态）
    const losses = translationGuard(c.lines, baseline[c.id].transMap || {}, '基线')
    if (losses.length) {
      for (const l of c.lines) {
        if (!l.translation && baseline[c.id].transMap?.[l.text]) l.translation = baseline[c.id].transMap[l.text]
      }
      healUpdates.push(`#${c.id} 回填 ${losses.length} 句`)
    }
  }
  if (fails.length) {
    failCourses++
    console.log(`❌ #${c.id} ${c.title}`)
    for (const f of fails.slice(0, 8)) console.log('   ' + f)
  } else if (warns.length) {
    console.log(`⚠️  #${c.id} ${c.title}`)
    for (const w of warns) console.log('   ' + w)
  }
}
console.log(`\n════════ 不变式门禁 ════════`)
console.log(`共 ${courses.length} 门：${failCourses ? `FAIL ${failCourses}` : 'PASS 全部'}${healUpdates.length ? `；--heal 回填：${healUpdates.join('、')}` : ''}`)

if (HEAL && healUpdates.length && !againstFile) {
  for (const c of courses) {
    // 回填后统一落库（走契约通道的简化路径：仅补译文，行数/时间不动）
    const stats = collectStats(c.lines)
    if (stats.withTranslation >= (baseline[c.id]?.withTranslation ?? 0)) {
      await conn.query('UPDATE exercises SET transcript_json=? WHERE id=?', [JSON.stringify(c.lines), c.id])
    }
  }
  console.log('回填已写入 DB（seed 未动——正式提交请走 saveTranscript 或重导 preset）')
}
await conn.end()
process.exit(failCourses && !HEAL ? 1 : 0)
