/**
 * 课程字幕重建工具：对指定课程重跑本地 ASR（走后端正式管线，顺带回填缓存），
 * 用断句合并 v4 重建字幕时间轴，写回后再跑原文对齐恢复官方文本。
 *
 * 背景：早期合并管线在部分课程上留下巨句（>20s）/微碎片（<0.7s）/题干播报
 * 拦腰截断；ASR 缓存已丢失，唯一可靠修复 = 重跑识别。单门约 4 分钟（8845H）。
 *
 * 用法：node scripts/local/repair-course-asr.mjs --ids 24 [--apply]
 *       默认干跑只排队不写库？不——排队即真实转写（CPU 代价已在队列里），
 *       --apply 控制的是「是否把新字幕写库」；不加 --apply 时转写完成后只打印对比。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE = 'http://127.0.0.1:8100'
const POLL_MS = 20_000
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`)

const APPLY = process.argv.includes('--apply')
const idsIndex = process.argv.indexOf('--ids')
if (idsIndex < 0) {
    console.error('用法：node scripts/local/repair-course-asr.mjs --ids 24,50 [--apply]')
    process.exit(1)
}
const IDS = process.argv[idsIndex + 1].split(',').map(Number).filter(Number.isInteger)

const j = async (res) => {
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { raw: text.slice(0, 200) } }
}

// ── 断句合并 v4（与 scripts/content/batch-asr-publish.mjs 保持同一套规则）──
const INSTRUCTION_HEAD =
    /^(\s*(section|conversation|passage|recording|lecture|talk|text|part|questions?)\s+([a-z]+|[0-9]+|[a-d])\b|\s*(听|请听|下面请听|请注意听|听下面|下面|现在|第[一二三四五六七八九十]+[节部分]|回答第?))/i
const HEADER_ONLY =
    /^(college english test\b.*|(section\s*[a-d0-9]+|text\s+[0-9]+|conversation\s+(one|two|[0-9]+)|passage\s+(one|two|[0-9]+)|recording\s+(one|two|three|[0-9]+)|talk\s+[0-9]*|part\s+[a-d0-9]+)([\s.,!?:-]+directions?)?|directions?)[\s.,!?:-]*$/i

const mergeSegments = (segments) => {
    const lines = []
    for (const seg of segments) {
        const text = seg.text.trim()
        if (!text) continue
        const startsInstruction = INSTRUCTION_HEAD.test(text)
        const isHeaderOnly = HEADER_ONLY.test(text)
        const endsSentence = /[.!?]["')]?\s*$/.test(text)
        const last = lines[lines.length - 1]

        const headDelim = text.match(
            /^((?:section|conversation|passage|recording|lecture|talk|text|part)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|[0-9]+|[a-d])\s*[,.\-–—:]\s*)(.+)$/i,
        )
        if (headDelim && headDelim[1].length <= 24 && headDelim[2].trim()) {
            const headPart = headDelim[1].trim()
            const restPart = headDelim[2].trim()
            const span = seg.end - seg.start
            const headDur = Math.max(1.2, span * (headPart.length / text.length))
            lines.push({ start: seg.start, end: seg.start + headDur, text: headPart, _open: false })
            lines.push({ start: seg.start + headDur, end: seg.end, text: restPart, _open: true })
            continue
        }

        const headSentence = text.match(
            /^((?:section|conversation|passage|recording|lecture|talk|text|part)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|[0-9]+|[a-d])(?:\s*[-–—:,]\s*(?:directions?)?)?[^.!]{0,70}[.!?])\s*(.+)$/i,
        )
        if (headSentence && headSentence[1].length <= 80 && headSentence[2].trim()) {
            const headPart = headSentence[1].trim()
            const restPart = headSentence[2].trim()
            const span = seg.end - seg.start
            const headDur = Math.max(0.8, span * (headPart.length / text.length))
            lines.push({ start: seg.start, end: seg.start + headDur, text: headPart, _open: false })
            lines.push({ start: seg.start + headDur, end: seg.end, text: restPart, _open: !/[.!?]["')]?$/.test(restPart) })
            continue
        }

        if (!last || startsInstruction || isHeaderOnly || !last._open) {
            lines.push({ start: seg.start, end: seg.end, text, _open: !endsSentence && !isHeaderOnly })
            continue
        }
        last.end = seg.end
        last.text = `${last.text} ${text}`.replace(/\s+/g, ' ').trim()
        last._open = !endsSentence && last.text.length <= 160
    }
    for (const line of lines) delete line._open
    return remergeShortLines(lines)
}

const REMERGE_MARKER =
    /^\s*(?:Q\s?\d+|Questions?\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))\s*[.。:：]?\s*$/i
const isProtectedLine = (text) => {
    const t = String(text).trim()
    if (!t || /[一-鿿]/.test(t)) return true
    if (/^(SECTION|CONVERSATION|PASSAGE|RECORDING|TALK|TEXT|PART)/i.test(t)) return true
    if (/^(QUESTIONS?|Q)\s*\d/i.test(t)) return true
    if (/^\d+\.?$/.test(t)) return true
    if (/BASED\s+ON/i.test(t)) return true
    if (/^(NOW\s+LISTEN|LISTENING\s|DIRECTIONS|THAT\s+IS\s+THE\s+END|THIS\s+IS\s+THE\s+END|END\s+OF\s+THE)/i.test(t)) return true
    return false
}
const wordCountOf = (text) => String(text).trim().split(/\s+/).filter(Boolean).length
const speakerOf = (text) => {
    const m = String(text).match(/^([A-Z]{1,3}):\s*/)
    return m ? m[1] : null
}
const speakerCompatible = (a, b) => {
    const sa = speakerOf(a.text)
    const sb = speakerOf(b.text)
    if (sa && sb) return sa === sb
    if (sa || sb) return false
    return true
}

function remergeShortLines(lines, minWords = 6, maxChars = 220) {
    const content = (l) => !isProtectedLine(l.text)
    const out = []
    for (const cur of lines) {
        const last = out[out.length - 1]
        if (
            content(cur) && wordCountOf(cur.text) < minWords && last &&
            content(last) && speakerCompatible(cur, last) &&
            last.text.length + cur.text.length + 1 <= maxChars
        ) {
            last.end = cur.end
            last.text = `${last.text.trim()} ${cur.text.trim()}`
            continue
        }
        out.push({ ...cur })
    }
    for (let i = out.length - 2; i >= 0; i--) {
        const cur = out[i]
        if (
            content(cur) && wordCountOf(cur.text) < minWords && i + 1 < out.length &&
            content(out[i + 1]) && speakerCompatible(cur, out[i + 1]) &&
            cur.text.length + out[i + 1].text.length + 1 <= maxChars
        ) {
            out[i + 1].start = cur.start
            out[i + 1].text = `${cur.text.trim()} ${out[i + 1].text.trim()}`
            out.splice(i, 1)
        }
    }
    for (let i = 0; i < out.length; i++) {
        if (!REMERGE_MARKER.test(out[i].text)) continue
        let j = i + 1
        while (j < out.length && REMERGE_MARKER.test(out[j].text)) j++
        const markers = out.slice(i, j)
        const target = out[j]
        const markerText = markers.map((m) => m.text.trim()).join(' ')
        if (target && content(target)) {
            target.start = markers[0].start
            target.text = `${markerText} ${target.text.trim()}`
            out.splice(i, j - i)
        } else if (markers.length > 1) {
            out[i] = { ...markers[0], end: markers[markers.length - 1].end, text: markerText }
            out.splice(i + 1, j - i - 1)
        }
    }
    return out
}

// ── 主流程 ─────────────────────────────────────────────────
const login = async () => {
    const r = await fetch(`${BASE}/api/v1/admin/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@duolinting.local', password: 'duolinting2026' }),
    }).then(j)
    if (!r.data?.token) throw new Error(`登录失败: ${r.message ?? ''}`)
    return { authorization: `Bearer ${r.data.token}` }
}
const adminAuth = await login()
log('管理员登录成功。')

for (const id of IDS) {
    const detail = await fetch(`${BASE}/api/v1/admin/exercises/${id}`, { headers: adminAuth }).then(j).catch(() => null)
    const title = detail?.exercise?.title ?? detail?.title ?? `#${id}`
    log(`── 课程 ${id} ${title} ──`)

    const q = await fetch(`${BASE}/api/v1/admin/exercises/${id}/asr-jobs`, {
        method: 'POST', headers: adminAuth, body: JSON.stringify({ language: 'auto' }),
    }).then(j)
    if (!q.job?.id) {
        log(`✗ 排队失败: ${q.message ?? JSON.stringify(q).slice(0, 120)}`)
        continue
    }
    log(`已排队 jobId=${q.job.id}（约 4 分钟/门，期间可 Ctrl+C 退出，缓存会保留）`)

    let job = null
    while (true) {
        await new Promise((r) => setTimeout(r, POLL_MS))
        job = await fetch(`${BASE}/api/v1/admin/asr-jobs/${q.job.id}`, { headers: adminAuth }).then(j).catch(() => null)
        if (job?.status === 'succeeded' || job?.status === 'failed') break
        log(`  ${job?.status ?? '?'} ${job?.progress != null ? job.progress + '%' : ''}`)
    }
    if (job.status !== 'succeeded') {
        log(`✗ 识别失败: ${job.errorMessage ?? ''}`)
        continue
    }
    const segments = job.segments ?? []
    log(`识别完成：${segments.length} 段原始切分`)

    const merged = mergeSegments(segments)
    const lines = merged.map((m, index) => ({
        id: `l${index + 1}`,
        start: Math.round(m.start * 1000) / 1000,
        end: Math.round(m.end * 1000) / 1000,
        text: m.text, translation: '', translations: {}, answers: [], keywords: [],
    }))
    const abnormal = lines.filter((l) => l.end - l.start > 20 || l.end - l.start < 0.7)
    log(`合并后 ${lines.length} 句；异常时长句 ${abnormal.length} 个`)
    abnormal.slice(0, 5).forEach((l) => log(`  ${l.start}-${l.end} ${(l.end - l.start).toFixed(1)}s ${JSON.stringify(l.text.slice(0, 60))}`))

    if (!APPLY) {
        log(`[dry-run] 未写库。新字幕样例（前 5 句）：`)
        lines.slice(0, 5).forEach((l) => log(`  ${l.start}-${l.end} ${JSON.stringify(l.text.slice(0, 70))}`))
        continue
    }
    const put = await fetch(`${BASE}/api/v1/admin/exercises/${id}/transcript`, {
        method: 'PUT', headers: { ...adminAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ lines }),
    }).then(j)
    log(put.ok ? `✓ 新字幕已写库（${lines.length} 句）。下一步跑原文对齐：node scripts/content/yuanwen-apply.mjs --only ${id} --apply`
        : `✗ 写库失败: ${JSON.stringify(put).slice(0, 120)}`)
}
