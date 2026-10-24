/**
 * 把 build-transcript-from-md 的产物入库（新建课程）。
 *
 * 走的是项目现成通道：写 seed → 跑 scripts/local/import-preset.mjs 做 upsert。
 * 不用 data-contract.saveTranscript：那个函数是给「已有课程改行」用的，
 * 要求 DB 里先存在该课程（实测新建时全部报「课程不存在」）。
 *
 * 做什么：
 *   1. 音频复制进 presets/cet6/media/audio/<日期>/，生成 .dlt-meta.json
 *   2. 组装 exercise 对象写进 seed
 *   3. 调 import-preset.mjs 落库
 *
 * 不做什么：
 *   - 不生成 questions_json / answer_key_json（这批素材只有原文，没有选项与答案）。
 *     前端在 questions 为空时自动隐藏「考试模式」入口，精听/泛听不受影响。
 *
 * 用法：
 *   node scripts/content/import-incoming.mjs --dir temp/cet6-1516 --dry
 *   node scripts/content/import-incoming.mjs --dir temp/cet6-1516 --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const argOf = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const dir = argOf('--dir')
const APPLY = process.argv.includes('--apply')
if (!dir) { console.error('用法：node scripts/content/import-incoming.mjs --dir <目录> [--apply]'); process.exit(2) }

const PRESET = 'cet6'
const SEED_PATH = `presets/${PRESET}/seed.json`
const MEDIA_ROOT = `presets/${PRESET}/media`
const DATE_DIR = new Date().toISOString().slice(0, 10).replace(/-/g, '/')
const OBJECT_DIR = `audio/${DATE_DIR}`

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
const built = JSON.parse(fs.readFileSync('temp/incoming-transcripts.json', 'utf8'))
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'))

const existingIds = new Set(seed.exercises.map((e) => e.id))
const maxId = Math.max(...seed.exercises.map((e) => e.id))
// 2015/2016 早于现有最早场次（2017-06，sort_order=10），排在最前
const minSort = Math.min(...seed.exercises.map((e) => e.sort_order))
// 幂等：同一段音频（audio_object_name 相同）重跑时更新原课程，不再另起新 id。
// 首次导入后调时间轴是常规操作，按「永远 append」写会造出成批重复课程。
const byAudio = new Map(seed.exercises.map((e) => [e.audio_object_name, e]))
// 新课程的 sort 基线：紧跟在上一批 2015/2016 课程之前（首批占 -90..0）
const nextSortBase = Math.min(minSort, 0)

const durationLabel = (secs) => {
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const nextVersion = (() => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const p = `${today}.`
  return seed.version.startsWith(p)
    ? `${p}${Number(seed.version.slice(p.length)) + 1}`
    : `${p}1`
})()

let ok = 0, failed = 0
const created = []

const sorted = [...manifest.sets].sort((a, b) =>
  (a.year - b.year) || (a.month - b.month) || (a.set - b.set))
let nextNewId = maxId + 1

for (const [i, set] of sorted.entries()) {
  const b = built.find((x) => x.key === set.key)
  if (!b) { console.error(`✗ ${set.key} 没有构建结果`); failed++; continue }
  if (!b.stats.ok) { console.error(`✗ ${set.key} 命中率不足（${(100 * b.stats.hitRate).toFixed(1)}%）`); failed++; continue }

  const existing = byAudio.get(`${OBJECT_DIR}/${set.key}.ogg`)
    ?? seed.exercises.find((e) => e.audio_object_name?.endsWith(`/${set.key}.ogg`))
  const id = existing ? existing.id : nextNewId++
  if (!existing && existingIds.has(id)) { console.error(`✗ #${id} id 冲突`); failed++; continue }

  const objName = `${OBJECT_DIR}/${set.key}.ogg`
  const src = path.join(dir, 'audio', `${set.key}.ogg`)
  const dst = path.join(MEDIA_ROOT, objName)

  if (APPLY) {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    fs.writeFileSync(`${dst}.dlt-meta.json`, JSON.stringify({ contentType: 'audio/ogg' }, null, 2) + '\n')
  }

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'json', src], { encoding: 'utf8' }))
  const dur = Number(probe.format?.duration) || 0

  const exercise = {
    id,
    category_id: 1,
    title: set.title,
    source: set.sourceFile ?? `${set.key}.ogg`,
    source_url: null,
    difficulty: 'intermediate',
    duration_label: durationLabel(dur),
    media_type: 'audio',
    audio_object_name: objName,
    audio_url: `/api/v1/media/objects?key=${encodeURIComponent(objName)}`,
    cover_image_url: null,
    summary: '',
    localizations_json: {},
    answer_key_json: {},
    transcript_json: b.lines.map((l) => ({ id: l.id, start: l.start, end: l.end, text: l.text })),
    status: 'published',
    claim_blocked: 0,
    // 已存在的课程保持原排序位；新课程按年份顺序排在这批的最前
    sort_order: existing ? existing.sort_order : nextSortBase - (sorted.length - i) * 10,
    questions_json: [],
  }

  console.log(`${APPLY ? '→' : '·'} #${id}${existing ? '（更新）' : ''} ${set.title}  行${b.lines.length} 时长${durationLabel(dur)} 排序${exercise.sort_order}`)

  if (existing) {
    Object.assign(existing, exercise)
  } else {
    seed.exercises.push(exercise)
  }
  created.push({ id, title: set.title })
  ok++
}

if (!APPLY) {
  console.log(`\n══ 预演：${ok} 套可入库 / ${failed} 失败 ══`)
  process.exit(0)
}

if (!ok) { console.error('没有可入库的课程'); process.exit(1) }

seed.version = nextVersion
seed.generatedAt = new Date().toISOString()
fs.writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2))
console.log(`\nseed 已写入（v${nextVersion}），调用 import-preset 落库…`)

try {
  const out = execFileSync(process.execPath, ['scripts/local/import-preset.mjs', '--preset', PRESET],
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(out.split('\n').filter((l) => /课程|导入|✓|完成/.test(l)).join('\n'))
} catch (e) {
  console.error('import-preset 失败：', (e.stderr || e.message).slice(0, 600))
  process.exit(1)
}

console.log(`\n══ 已入库 ${ok} 套（id ${created[0].id}~${created[created.length - 1].id}）══`)
console.log('记得重建基线并跑门禁')
