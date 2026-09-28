/**
 * 批量 ASR + 自动发布（完整版）：
 * 1. 找出所有「草稿且无字幕」的课程，逐门排队本地 ASR（后端串行执行，约 4.5x 实时速度）
 * 2. 每门 ASR 成功后：分段 → 智能断句合并 → 超管直写正式字幕
 * 3. 全部就绪后：单机版直接置为 published 发布（无校对/二审工作流）
 * 幂等可重跑：已有字幕跳过、进行中任务复用、失败任务重新排队
 */
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:8100'
const STALE_MS = 15 * 60 * 1000
const POLL_MS = 20_000
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`)

const j = async (res) => {
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { raw: text.slice(0, 200) } }
}

// ── 断句合并 v4 ──────────────────────────────────────────────
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

// ── 碎片句后处理（与 temp/remerge-transcripts.mjs 同一规则）──
// <6 词的英文内容句并入相邻句；裸题号行（Q1./Question one）折叠或并入后面的题目正文；
// 中文指令、报头、题干播报等锚点行永不参与合并。
const REMERGE_MARKER =
    /^\s*(?:Q\s?\d+|Questions?\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))\s*[.。:：]?\s*$/i
const isProtectedLine = (text) => {
    const t = String(text).trim()
    if (!t || /[一-鿿]/.test(t)) return true
    if (/^(SECTION|CONVERSATION|PASSAGE|RECORDING|TALK|TEXT|PART)/i.test(t)) return true
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
// 碎片句只与"同说话人（或双方都无前缀）"的邻卡合并；
// 带前缀的碎片不并入无前缀卡片（归属不明，宁可独立）。
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

// ── 登录 ─────────────────────────────────────────────────────
const login = async (email, password) => {
    const r = await fetch(`${BASE}/api/v1/admin/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
    }).then(j)
    if (!r.data?.token) throw new Error(`登录失败 ${email}: ${r.message ?? ''}`)
    return { auth: { authorization: `Bearer ${r.data.token}` }, user: r.data.user }
}

const admin = await login('admin@duolinting.local', 'duolinting2026')
const adminAuth = { ...admin.auth, 'content-type': 'application/json' }
log('管理员登录成功')

// ── 收集目标课程 ─────────────────────────────────────────────
const all = await fetch(`${BASE}/api/v1/admin/exercises`, { headers: adminAuth }).then(j)
const detailCache = new Map()
const targets = []
for (const summary of all) {
    if (summary.status !== 'draft') continue
    const detail = await fetch(`${BASE}/api/v1/admin/exercises/${summary.id}`, { headers: adminAuth }).then(j)
    detailCache.set(summary.id, detail)
    if (detail.lines.length === 0) targets.push({ id: detail.id, title: detail.title })
}
log(`待处理课程：${targets.length} 门`)
if (targets.length === 0) {
    console.log('BATCH-ASR-PUBLISH DONE（无可处理课程）')
    process.exit(0)
}

// ── 阶段 1：逐门排队 ASR ─────────────────────────────────────
const jobByExercise = new Map()
for (const target of targets) {
    const r = await fetch(`${BASE}/api/v1/admin/exercises/${target.id}/asr-jobs`, {
        method: 'POST', headers: adminAuth, body: JSON.stringify({ language: 'auto' }),
    }).then(j)
    if (r.job?.id) {
        jobByExercise.set(target.id, r.job.id)
        log(`  排队 ${target.title} (jobId=${r.job.id}, cacheHit=${r.cacheHit})`)
    } else {
        log(`  ✗ 排队失败 ${target.title}: ${r.message ?? '?'}（跳过，不进入等待循环）`)
        failed.push(target.title)
    }
}

// ── 阶段 2：等待全部识别完成并写入字幕 ───────────────────────
const remaining = new Map(targets.map((t) => [t.id, t]))
let done = 0
const failed = []
while (remaining.size > 0) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    for (const [exerciseId, target] of [...remaining]) {
        const jobId = jobByExercise.get(exerciseId)
        if (!jobId) continue
        const job = await fetch(`${BASE}/api/v1/admin/asr-jobs/${jobId}`, { headers: adminAuth }).then(j).catch(() => null)
        // 后端重启会丢内存队列：任务不存在或 20 分钟无进展 → 重新排队（幂等）
        const stale = !job || job.id === undefined ||
          (job.status !== 'succeeded' && Date.now() - new Date(job.updatedAt).getTime() > 20 * 60 * 1000)
        if (stale) {
            const re = await fetch(`${BASE}/api/v1/admin/exercises/${exerciseId}/asr-jobs`, {
                method: 'POST', headers: adminAuth, body: JSON.stringify({ language: 'auto' }),
            }).then(j).catch(() => null)
            if (re?.job?.id) {
                jobByExercise.set(exerciseId, re.job.id)
                log(`↻ 重新排队 ${target.title} (jobId=${re.job.id})`)
            }
            continue
        }
        if (job.status === 'succeeded') {
            // 断句合并 → 直写正式字幕（超管）
            const merged = mergeSegments(job.segments ?? [])
            const lines = merged.map((m, index) => ({
                id: `l${index + 1}`,
                start: Math.round(m.start * 1000) / 1000,
                end: Math.round(m.end * 1000) / 1000,
                text: m.text, translation: '', translations: {}, answers: [], keywords: [],
            }))
            const put = await fetch(`${BASE}/api/v1/admin/exercises/${exerciseId}/transcript`, {
                method: 'PUT', headers: { ...adminAuth }, body: JSON.stringify({ lines }),
            }).then(j)
            if (!put.ok) {
                log(`⚠ 字幕写入失败 ${target.title}: ${JSON.stringify(put).slice(0, 100)}`)
                failed.push(target.title)
                remaining.delete(exerciseId)
                continue
            }
            log(`✓ 字幕就绪 ${target.title}（${lines.length} 句）`)
            remaining.delete(exerciseId)
        } else if (job.status === 'failed') {
            log(`✗ 识别失败 ${target.title}: ${job.errorMessage ?? ''}`)
            failed.push(target.title)
            remaining.delete(exerciseId)
        }
    }
    if (remaining.size > 0) {
        log(`识别中... 剩余 ${remaining.size} 门`)
    }
}

// ── 阶段 3：直接发布（单机版，无工作流）────────────────────
let published = 0
for (const target of targets) {
    if (failed.includes(target.title)) continue
    const detail = await fetch(`${BASE}/api/v1/admin/exercises/${target.id}`, { headers: adminAuth }).then(j)
    if (!detail || !detail.lines) { log(`⚠ 跳过（课程读取失败）: ${target.title}`); continue }
    if (detail.status === 'published') { published += 1; continue }
    if (detail.lines.length === 0) { log(`⚠ 跳过（无字幕）: ${target.title}`); continue }

    const r = await fetch(`${BASE}/api/v1/admin/exercises`, {
        method: 'POST', headers: adminAuth,
        body: JSON.stringify({
            id: detail.id, categoryId: detail.categoryId, title: detail.title,
            source: detail.source ?? '', sourceUrl: detail.sourceUrl ?? '',
            difficulty: detail.difficulty ?? 'intermediate',
            durationLabel: detail.durationLabel ?? '', mediaType: detail.mediaType ?? 'audio',
            audioUrl: detail.audioUrl, coverImageUrl: detail.coverImageUrl ?? '',
            summary: detail.summary ?? '', sortOrder: detail.sortOrder ?? 0,
            status: 'published',
        }),
    }).then(j)
    if (r.ok) {
        published += 1
        log(`✓ 已发布 ${target.title}`)
    } else {
        log(`⚠ 发布失败 ${target.title}: ${r.message ?? JSON.stringify(r).slice(0, 100)}`)
    }
}

log(`全部完成：发布 ${published} 门 / 共 ${targets.length} 门${failed.length ? `；识别失败 ${failed.length} 门` : ''}`)
console.log('BATCH-ASR-PUBLISH DONE')
