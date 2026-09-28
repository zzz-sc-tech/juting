// 原文校对批量应用：已发布课程 × 听力原文 md → 词级对齐 → 正文字幕升级为原文文本
//
// 用法：
//   node scripts/content/yuanwen-apply.mjs              # 干跑（默认，只报告不写库）
//   node scripts/content/yuanwen-apply.mjs --apply      # 真正写库（通过质量门禁的课程）
//   node scripts/content/yuanwen-apply.mjs --only=13,14 # 只处理指定课程 id（先小范围试跑）
//
// 安全约束（2026-09-27 数据事故后加）：
//   1. 默认干跑，必须显式 --apply 才写库。
//   2. 每门课先 ffprobe 真实音频时长，交给 synthesizeTranscript 强钳制时间轴。
//   3. 质量门禁：命中率 < MIN_HIT_RATE 或时间轴超出音频 → 跳过并告警，绝不静默写库。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mysql = require('mysql2/promise')

const BASE = 'http://127.0.0.1:8100'
const YUANWEN_ROOT = process.env.YUANWEN_DIR ?? './原文（改成你的听力原文目录，或用 YUANWEN_DIR 环境变量）'
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`)

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? '')
    .split(',').filter(Boolean).map(Number)

// ── 读 backend/.env ──────────────────────────────────────────
const envOf = (src, key) => {
    for (const line of src.split('\n')) {
        const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`))
        if (m) return m[1].replace(/^["']|["']$/g, '')
    }
    return undefined
}
const envSrc = fs.existsSync('backend/.env') ? fs.readFileSync('backend/.env', 'utf8') : ''
const MEDIA_LOCAL_DIR = envOf(envSrc, 'MEDIA_LOCAL_DIR') ?? 'temp/runtime/media-store/duolinting-media'
const ASR_FFMPEG_BIN = envOf(envSrc, 'ASR_FFMPEG_BIN')
const FFPROBE = process.env.FFPROBE ??
    (ASR_FFMPEG_BIN ? path.join(path.dirname(ASR_FFMPEG_BIN), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe')

const { parseYuanwenMd, synthesizeTranscript, buildAsrWordTimeline, MIN_HIT_RATE } =
    await import('./yuanwen-lib.mjs')

const j = async (res) => {
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { raw: text.slice(0, 200) } }
}

/** 探真实音频时长；失败返回 NaN（调用方回退到 ASR 缓存终点）。 */
const probeDuration = (objectName) => {
    const file = path.join(MEDIA_LOCAL_DIR, objectName)
    if (!fs.existsSync(file)) return NaN
    try {
        const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
            { encoding: 'utf8' })
        const v = parseFloat(out.trim())
        return Number.isFinite(v) ? v : NaN
    } catch { return NaN }
}

// 从课程标题提取考试键：年份 + 月份 + 套号
const examKeyOf = (title) => {
    const year = title.match(/(\d{4})/)?.[1]
    const month = title.match(/[年.](\d{1,2})月/)?.[1]?.padStart(2, '0')
    const set = title.match(/第(\d+)套/)?.[1] ?? (title.includes('全1套') || title.includes('全1') ? '1' : null)
    if (!year || !month || !set) return null
    return `${year}-${month}:${set}`
}

const db = await mysql.createConnection({
    host: envOf(envSrc, 'MYSQL_HOST') ?? '127.0.0.1',
    port: Number(envOf(envSrc, 'MYSQL_PORT') ?? 3307),
    user: envOf(envSrc, 'MYSQL_USER') ?? envOf(envSrc, 'MYSQL_USERNAME') ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? envOf(envSrc, 'MYSQL_PASSWORD') ?? '',
    database: envOf(envSrc, 'MYSQL_DATABASE') ?? 'duolinting_app_dev',
})

// 索引所有 md 文件：examKey → md 路径
const mdIndex = new Map()
function scanMd(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { scanMd(full); continue }
        if (!entry.name.endsWith('.md') || entry.name.startsWith('00-')) continue
        const year = entry.name.match(/(\d{4})/)?.[1]
        const month = entry.name.match(/[年.](\d{1,2})月/)?.[1]?.padStart(2, '0')
        const set = entry.name.match(/第(\d+)套/)?.[1] ?? '1'
        if (year && month) mdIndex.set(`${year}-${month}:${set}`, full)
    }
}
scanMd(YUANWEN_ROOT)
log(`原文索引：${mdIndex.size} 套 | 模式：${APPLY ? '写库(--apply)' : '干跑(不写库)'}${ONLY.length ? ` | 限定 id ${ONLY.join(',')}` : ''}`)

const login = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@duolinting.local', password: 'duolinting2026' }),
}).then(j)
const adminAuth = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }

const all = await fetch(`${BASE}/api/v1/admin/exercises`, { headers: adminAuth }).then(j)
let upgraded = 0
let skippedNoMd = 0
let gated = 0
const gateFailures = []
for (const summary of all) {
    if (summary.status !== 'published') continue
    if (ONLY.length && !ONLY.includes(summary.id)) continue
    const examKey = examKeyOf(summary.title)
    const mdPath = examKey ? mdIndex.get(examKey) : null
    if (!mdPath) { skippedNoMd += 1; continue }

    const detail = await fetch(`${BASE}/api/v1/admin/exercises/${summary.id}`, { headers: adminAuth }).then(j)
    const objectKey = new URL(detail.audioUrl, BASE).searchParams.get('key')
    const jobRows = (await db.query(
        'select result_json from media_asr_jobs where object_name = ? and status = ? order by id desc limit 1',
        [objectKey, 'succeeded'],
    ))[0]
    if (!jobRows[0]) { log(`⚠ ${summary.title} 无 ASR 缓存，跳过`); continue }
    const segments = JSON.parse(jobRows[0].result_json)

    // 真实音频时长：优先 ffprobe，失败回退到 ASR 缓存最后一段的终点
    let audioDuration = probeDuration(objectKey)
    let durSource = 'ffprobe'
    if (!Number.isFinite(audioDuration)) {
        const last = segments[segments.length - 1]
        audioDuration = Number(last?.end) || null
        durSource = 'ASR终点(回退)'
    }

    const mdSentences = parseYuanwenMd(fs.readFileSync(mdPath, 'utf8'))
    const asrTimeline = buildAsrWordTimeline(segments)
    // 传入 segments：用于补回原文未收录的官方播报句（题组/节次锚点原料）
    const { lines: aligned, stats } = synthesizeTranscript(mdSentences, asrTimeline, { audioDuration, segments })

    // ── 质量门禁 ──
    if (!stats.ok) {
        gated += 1
        const reason = stats.hitRate < MIN_HIT_RATE
            ? `命中率 ${(stats.hitRate * 100).toFixed(1)}% < ${(MIN_HIT_RATE * 100).toFixed(0)}%`
            : `时间轴越界 ${stats.maxEnd.toFixed(0)}s > 音频 ${audioDuration.toFixed(0)}s`
        gateFailures.push(`#${summary.id} ${summary.title}：${reason}`)
        log(`⛔ ${summary.title} 未过门禁，跳过（${reason}）`)
        continue
    }

    const lines = aligned.map((m, index) => ({
        id: `l${index + 1}`,
        start: m.start, end: m.end, text: m.text,
        translation: '', translations: {}, answers: [], keywords: [],
    }))

    if (!APPLY) {
        log(`✓[干跑] ${summary.title}: 原文 ${lines.length} 句（含播报行 ${stats.instructionRows}），命中率 ${(stats.hitRate * 100).toFixed(1)}%，` +
            `锚点 ${stats.anchorCount}，时间轴 0→${stats.maxEnd.toFixed(0)}s / 音频 ${audioDuration.toFixed(0)}s（${durSource}）`)
        upgraded += 1
        continue
    }

    const put = await fetch(`${BASE}/api/v1/admin/exercises/${summary.id}/transcript`, {
        method: 'PUT', headers: adminAuth, body: JSON.stringify({ lines }),
    }).then(j)
    if (!put.ok) { log(`⚠ ${summary.title} 写入失败: ${JSON.stringify(put).slice(0, 100)}`); continue }
    upgraded += 1
    log(`✓ ${summary.title}: ${detail.lines.length} 句 → 新 ${lines.length} 句（含播报行 ${stats.instructionRows}），` +
        `命中率 ${(stats.hitRate * 100).toFixed(1)}%，时间轴 0→${stats.maxEnd.toFixed(0)}s / 音频 ${audioDuration.toFixed(0)}s`)
}

log(`原文校对完成：${APPLY ? '写入' : '干跑通过'} ${upgraded} 门，无原文跳过 ${skippedNoMd} 门，门禁拦截 ${gated} 门`)
if (gateFailures.length) log('门禁拦截明细：\n  ' + gateFailures.join('\n  '))
await db.end()
console.log(APPLY ? 'YUANWEN APPLY DONE' : 'YUANWEN DRY-RUN DONE（未写库，确认后加 --apply）')
