/**
 * 门禁一条龙：不变式 / 时长健全 / 时间轴重叠（cet4+cet6）/ 缺题 / 单调重叠负时长。
 * 任一门 FAIL → 汇总退出码 1。数据写入后的标准验收命令：
 *
 *   node scripts/audit/check-all.mjs [--rebuild-baseline]
 *
 * 逐项可独立跑（历史用法不变）；本脚本只做编排与汇总，不重复实现判定。
 */
import { execFileSync } from 'node:child_process'

const REBUILD = process.argv.includes('--rebuild-baseline')
const gates = [
  { name: '不变式', cmd: ['node', ['scripts/audit/check-invariants.mjs', ...(REBUILD ? ['--rebuild-baseline'] : [])]] },
  { name: '时长健全', cmd: ['node', ['scripts/audit/check-duration-sanity.mjs']] },
  { name: '重叠-cet4', cmd: ['node', ['scripts/audit/check-timeline-speech-overlap.mjs', 'cet4']] },
  { name: '重叠-cet6', cmd: ['node', ['scripts/audit/check-timeline-speech-overlap.mjs', 'cet6']] },
  { name: '缺题', cmd: ['node', ['temp/v3.mjs']] },
  { name: '单调/重叠/负时长', cmd: ['node', ['temp/final-check.mjs']] },
]

const results = []
let failed = 0
for (const g of gates) {
  const t0 = Date.now()
  try {
    const out = execFileSync(g.cmd[0], g.cmd[1], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    results.push({ name: g.name, ok: true, ms: Date.now() - t0, tail: out.trim().split('\n').slice(-2).join(' | ') })
  } catch (e) {
    failed++
    results.push({ name: g.name, ok: false, ms: Date.now() - t0, tail: (e.stdout || '').trim().split('\n').slice(-4).concat((e.stderr || '').trim().split('\n').slice(-2)).join(' | ') })
  }
}
console.log('\n════════ 门禁一条龙 ════════')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}（${(r.ms / 1000).toFixed(1)}s）${r.ok ? '  ' + r.tail : '\n      ' + r.tail.replaceAll('\n', '\n      ')}`)
console.log(`══ ${results.filter((r) => r.ok).length}/${results.length} PASS${failed ? `，${failed} 门 FAIL ✗` : ' ✓'} ══`)
process.exit(failed ? 1 : 0)
