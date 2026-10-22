/**
 * 时间轴语音重叠门禁：字幕行的时间区间必须落在真实语音上。
 *
 * 背景（2026-10-21）：四级语料重建后，whisper 的分段边界横跨 15～20 秒答题停顿，
 * 段内词按字符比例铺开时被摊进静音；对齐失败的播报句/题干再退化成插值，被压到
 * 0.4～1 秒。既有门禁（单调/重叠/负时长）全部通过——它们只查时间戳自洽，
 * 不查「时间戳是否对应真实语音」。本门禁补上这一环。
 *
 * 判据：以 -48 dBFS 能量检测出语音段；每行区间与该语音段的重叠率 <20% 记为可疑。
 * 用法: node scripts/audit/check-timeline-speech-overlap.mjs <cet4|cet6> [--out file.json]
 *   退出码：可疑行占比 > 2% → 1
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const key = process.argv[2] || 'cet4'
const outIdx = process.argv.indexOf('--out')
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : `temp/timeline-overlap-${key}.json`
const seed = JSON.parse(fs.readFileSync(`presets/${key}/seed.json`, 'utf8'))

const SR = 8000
const FRAME = 0.05
const THRESH = 0.004

const speechMask = (audioPath) => {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audioPath,
    '-ar', String(SR), '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 30 })
  const per = Math.round(SR * FRAME)
  const mask = []
  for (let i = 0; i + per <= raw.length / 2; i += per) {
    let sum = 0
    for (let j = i; j < i + per; j++) { const v = raw.readInt16LE(j * 2) / 32768; sum += v * v }
    mask.push(Math.sqrt(sum / per) >= THRESH ? 1 : 0)
  }
  return mask
}

const overlap = (mask, start, end) => {
  const a = Math.max(0, Math.floor(start / FRAME))
  const b = Math.min(mask.length, Math.ceil(end / FRAME))
  if (b <= a) return 0
  let hit = 0
  for (let i = a; i < b; i++) hit += mask[i]
  return hit / (b - a)
}

const classify = (text) => {
  const t = String(text).trim()
  if (/^questions?\s+[\w-]+\s*(to|-|and)\s*[\w-]+\s+are based on/i.test(t)) return 'announce'
  if (/^questions?\s+[\w-]+\s*[.:：]?\s*$/i.test(t)) return 'q-stub'
  if (/^[A-D]\.$/.test(t)) return 'option-label'
  if (/^(section|conversation|passage|news report|recording|directions|college english)/i.test(t)) return 'header'
  if (/^that'?s the end|^this is the end/i.test(t)) return 'end'
  return 'content'
}

const all = []
for (const ex of seed.exercises) {
  const audioPath = `presets/${key}/media/${ex.audio_object_name}`
  if (!fs.existsSync(audioPath)) { console.error('missing', audioPath); continue }
  const mask = speechMask(audioPath)
  // 语音岛
  const islands = []
  let st = null
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && st === null) st = i
    if (!mask[i] && st !== null) { islands.push([st * FRAME, i * FRAME]); st = null }
  }
  if (st !== null) islands.push([st * FRAME, mask.length * FRAME])
  // 合并 <0.3s 空隙
  const merged = []
  for (const is of islands) {
    const last = merged[merged.length - 1]
    if (last && is[0] - last[1] < 0.3) last[1] = is[1]
    else merged.push([...is])
  }
  for (const l of ex.transcript_json) {
    const dur = l.end - l.start
    const ov = overlap(mask, l.start, l.end)
    all.push({
      cid: ex.id, lid: l.id, start: l.start, end: l.end, dur: +dur.toFixed(2),
      ov: +ov.toFixed(3), kind: classify(l.text), text: String(l.text).slice(0, 80),
    })
  }
}

fs.writeFileSync(outPath, JSON.stringify(all, null, 0))
const bad = all.filter((r) => r.ov < 0.2)
const zero = all.filter((r) => r.ov === 0)
const byKind = {}
for (const r of bad) byKind[r.kind] = (byKind[r.kind] || 0) + 1
const kindTotals = {}
for (const r of all) kindTotals[r.kind] = (kindTotals[r.kind] || 0) + 1
console.log(`${key}: ${all.length} 行，重叠<20% ${bad.length}（${(100 * bad.length / all.length).toFixed(1)}%），完全静音 ${zero.length}`)
console.log('按类型：')
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} ${String(v).padStart(4)} / ${kindTotals[k]}  (${(100 * v / kindTotals[k]).toFixed(0)}%)`)
}
const short = all.filter((r) => r.ov < 0.2 && r.dur < 2)
const long = all.filter((r) => r.ov < 0.2 && r.dur >= 2)
console.log(`  其中短行(<2s) ${short.length}，长行 ${long.length}`)
console.log(`输出 → ${outPath}`)

if (bad.length / all.length > 0.02) { console.log('FAIL'); process.exit(1) }
console.log('PASS')
