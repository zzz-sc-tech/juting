/**
 * 原文对齐引擎（v2，2026-09-27 重写）
 *
 * 职责：把「听力原文 md」的正确文本与「ASR 分段」的时间轴对齐，
 * 合成 = 原文文本 + ASR 时间 的完美字幕。
 *
 * md 格式（听力原文标准结构）：
 *   # 英语六级 2026年06月 第1套 · 听力原文   ← H1 元数据，丢弃
 *   > 含 Section A 长对话 2 篇 ……            ← 引用块元数据，丢弃
 *   ## CONVERSATION 1          ← 分节头（转为锚点标签行）
 *   M: Hello, Doctor.          ← 说话人行（一段可含多句）
 *   Q1. What do we learn...?   ← 题干行（转为锚点标签，不进学习内容）
 *   ## PASSAGE 1
 *   Kate Atkinson was born...  ← 正文段落（按句切分）
 *
 * ── v1 的致命缺陷（2026-09-27 数据事故根因，已复现）────────────────
 * v1 用「单向游标 + 字符袋相似度 ≥0.75」做贪心对齐，且窗口只能向前
 * （[cursor, cursor+120)），命中即把游标推到命中位置之后，**永不回溯**。
 * 于是任何一次虚假模糊匹配都会把游标推到真实位置之前：
 *   "place"→"people"(0.83)、"both"→"book"(0.75)、"with"→"this"(0.75) …
 * 实测 #13：md 第 39 个词时游标已到 ASR 第 1063 个词（内容的 1.5% 处
 * 却消耗了音频的 36%），此后 md 词的真实对应全落在游标之后 → 永久失配。
 * 结果：38 门课平均命中率仅 9.9%，大量句子无命中 → 退化到 `idx*4`
 * 均匀兜底（每句恰好 4.0s）→ 时间轴溢出音频 +488s ~ +792s。
 *
 * ── v2 的对策 ────────────────────────────────────────────────────
 * 1. 相似度改为**编辑距离比率**，并对短词强制长度/首尾字符门限 —— 消除
 *    "both/book" 这类字符袋误判。
 * 2. 对齐改为**锚点 + 分段全局 DP（Needleman-Wunsch 单调对齐）**：
 *    先用 3-gram 精确匹配 + 最长递增子序列求高置信锚点链，再在锚点之间
 *    做局部全局对齐。全程单调且可回溯，不存单向漂移。
 * 3. 无命中句不再用 `idx*4` 均匀铺排，改为**按词数比例在相邻锚点间插值**。
 * 4. 时间轴强制钳制在 [0, audioDuration]，越界即报错而非静默写库。
 * 5. 输出对齐质量统计（命中率 / 锚点数 / 最大溢出差），供调用方做门禁。
 */
import fs from 'node:fs'

// ── md 解析 ──────────────────────────────────────────────────

/** 把一段文本切分成句子（缩写保护：Mr./Dr. 等不切）。 */
export const splitSentences = (text) => {
    const protectedText = text
        .replace(/\b(Mr|Mrs|Ms|Dr|Prof|St)\./g, '$1\u0001')
        .replace(/\b([A-Z])\./g, '$1\u0001')
    const parts = protectedText
        .split(/(?<=[.!?])\s+(?=[A-Z"'“]|$)/)
        .map((part) => part.replace(/\u0001/g, '.').trim())
        .filter(Boolean)
    return parts.length > 0 ? parts : [text.trim()]
}

/** md 中的元数据行：H1 标题 / 引用块 / 表格 / 代码围栏 / HTML 注释，都不是听力内容。 */
const METADATA_LINE = /^(#\s|>\s?|\||`{3,}|<!--)/
/** 说话人前缀（对齐时剔除，展示时保留）。 */
const SPEAKER_TAG = /^((?:W|M|Woman|Man|Speaker\s*\d*)(?:\s*[12])?)\s*[:：]\s*/i
/** 题干行前缀。 */
const QUESTION_LINE = /^Q\d+[.。:：]?/i
/**
 * 题干标签「Q6.」。听力原文里它是题干的印刷编号，不是句子边界——
 * 若交给 splitSentences 会被切成独立的一行「Q6.」（时长只有最小值，精听里很突兀），
 * 故先摘下标签、切完句再拼回第一个句子。
 */
const QUESTION_LABEL = /^(Q\d+)[.。:：]\s+/

/**
 * 解析听力原文 md 为扁平句列表。
 * @returns {Array<{text:string, rawText:string, speaker:string|null, section:string,
 *                  isSectionHead:boolean, isQuestion:boolean}>}
 */
export const parseYuanwenMd = (mdContent) => {
    const sentences = []
    let currentSection = '开场'
    for (const rawLine of mdContent.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        if (METADATA_LINE.test(line)) continue
        if (line === '---') continue

        const header = line.match(/^##\s+(.+)$/)
        if (header) {
            currentSection = header[1].trim()
            // 分节头本身也进句列表（标记为节标签），对齐后作为锚点行
            sentences.push({
                text: currentSection, rawText: currentSection, speaker: null,
                section: currentSection, isSectionHead: true, isQuestion: false,
            })
            continue
        }

        const tag = line.match(SPEAKER_TAG)
        const speaker = tag ? tag[1].toUpperCase() : null
        let body = (tag ? line.slice(tag[0].length) : line).trim()
        if (!body) continue
        const isQuestion = QUESTION_LINE.test(body)
        // 摘下题干标签，避免 "Q6." 被切成独立行
        let labelPrefix = ''
        const ql = body.match(QUESTION_LABEL)
        if (ql) {
            labelPrefix = `${ql[1]}. `
            body = body.slice(ql[0].length).trim()
        }
        if (!body) continue
        let first = true
        for (const sentence of splitSentences(body)) {
            const display = first && speaker ? `${speaker}: ${sentence}` : sentence
            sentences.push({
                // 展示文本：说话人前缀只挂在本行首句；题干标签同理
                text: (first ? labelPrefix : '') + display,
                // 对齐文本：剔除说话人前缀与题干标签，避免 "w"/"m"/"q6" 污染词流
                rawText: sentence,
                speaker,
                section: currentSection,
                isSectionHead: false,
                isQuestion,
            })
            first = false
        }
    }
    return sentences
}

// ── 归一化 ────────────────────────────────────────────────────

export const normalizeWord = (word) =>
    word.toLowerCase().replace(/[^a-z0-9'一-龥ぁ-んァ-ヶ가-힣]+/g, '')

export const tokenize = (text) =>
    (text.match(/[a-zA-Z0-9']+|[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? [])
        .map(normalizeWord)
        .filter((w) => w.length > 0)

// ── 词间相似度（v2：编辑距离比率 + 长度/首尾门限）────────────────

const MISMATCH = -1.2

/** Levenshtein 距离比率：1 = 完全相同，0 = 毫无关系。 */
const levRatio = (a, b) => {
    const la = a.length
    const lb = b.length
    if (la === 0 || lb === 0) return 0
    let prev = new Uint16Array(lb + 1)
    let cur = new Uint16Array(lb + 1)
    for (let j = 0; j <= lb; j++) prev[j] = j
    for (let i = 1; i <= la; i++) {
        cur[0] = i
        const ca = a.charCodeAt(i - 1)
        for (let j = 1; j <= lb; j++) {
            const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
            const del = prev[j] + 1
            const ins = cur[j - 1] + 1
            const sub = prev[j - 1] + cost
            cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub)
        }
        const t = prev
        prev = cur
        cur = t
    }
    return 1 - prev[lb] / Math.max(la, lb)
}

/**
 * 词对相似度打分。门限刻意收紧：v1 的字符袋相似度会把
 * "both"→"book"（3/4 字符重合）判成 0.75 命中，是漂移的元凶。
 */
export const wordSimilarity = (a, b) => {
    if (a === b) return 3
    const la = a.length
    const lb = b.length
    if (la < 2 || lb < 2) return MISMATCH
    const maxLen = la > lb ? la : lb
    if (Math.abs(la - lb) > maxLen * 0.34) return MISMATCH
    // 首字符或尾字符至少一侧相同，才值得算编辑距离（廉价前置门限）
    if (a.charCodeAt(0) !== b.charCodeAt(0) &&
        a.charCodeAt(la - 1) !== b.charCodeAt(lb - 1)) return MISMATCH
    const r = levRatio(a, b)
    if (r >= 0.9) return 1.6
    if (la >= 5 && r >= 0.8) return 1.2
    if (la >= 6 && r >= 0.72) return 0.8
    return MISMATCH
}

// ── 单调对齐：锚点 + 分段全局 DP ──────────────────────────────

const GAP_MD = -0.4   // md 词无 ASR 对应（原文有、录音没念，或 ASR 识别缺失）
const GAP_ASR = -0.25 // ASR 词无 md 对应（试音/报头/题号播报/幻觉）

/** 3-gram 精确匹配 + 最长递增子序列 → 高置信单调锚点链。 */
const buildAnchors = (mdWords, asrWords, k = 3) => {
    if (mdWords.length < k || asrWords.length < k) return []
    const kgramIndex = new Map()
    for (let i = 0; i + k <= mdWords.length; i++) {
        const key = mdWords[i] + ' ' + mdWords[i + 1] + ' ' + mdWords[i + 2]
        const arr = kgramIndex.get(key)
        if (arr) arr.push(i)
        else kgramIndex.set(key, [i])
    }
    const cand = []
    for (let j = 0; j + k <= asrWords.length; j++) {
        const key = asrWords[j] + ' ' + asrWords[j + 1] + ' ' + asrWords[j + 2]
        const arr = kgramIndex.get(key)
        if (!arr) continue
        const expected = (j / asrWords.length) * mdWords.length
        let best = -1
        let bestD = Infinity
        for (const i of arr) {
            const d = Math.abs(i - expected)
            if (d < bestD) { bestD = d; best = i }
        }
        cand.push({ i: best, j })
    }
    if (cand.length === 0) return []

    // 最长递增子序列（按 md 索引严格递增）
    const tails = []      // tails[l] = 该长度下最小的 i 所在的 cand 下标
    const prevIdx = new Int32Array(cand.length).fill(-1)
    for (let c = 0; c < cand.length; c++) {
        const v = cand[c].i
        let lo = 0
        let hi = tails.length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (cand[tails[mid]].i < v) lo = mid + 1
            else hi = mid
        }
        if (lo > 0) prevIdx[c] = tails[lo - 1]
        tails[lo] = c
    }
    const chain = []
    for (let c = tails.length > 0 ? tails[tails.length - 1] : -1; c >= 0; c = prevIdx[c]) {
        chain.push(cand[c])
    }
    chain.reverse()

    // 稀疏化：只保留密度合理的锚点（相邻锚点跨度比例接近全局比例）
    const globalRatio = asrWords.length / mdWords.length
    const kept = []
    for (const a of chain) {
        if (kept.length === 0) { kept.push(a); continue }
        const p = kept[kept.length - 1]
        const di = a.i - p.i
        const dj = a.j - p.j
        if (di < k || dj < k) continue
        const localRatio = dj / di
        if (localRatio < globalRatio * 0.35 || localRatio > globalRatio * 2.8) continue
        kept.push(a)
    }
    return kept
}

/** 段内全局单调对齐（Needleman-Wunsch），返回段内 md→ASR 局部索引。 */
const alignSegment = (mdWords, asrWords) => {
    const la = mdWords.length
    const lb = asrWords.length
    const res = new Int32Array(la).fill(-1)
    if (la === 0 || lb === 0) return res
    // 退化保护：段过大时不做逐格 DP（正常锚点覆盖下不会触发）
    if (la * lb > 4_000_000) {
        for (let i = 0; i < la; i++) {
            const j = Math.min(lb - 1, Math.round((i * lb) / la))
            res[i] = j
        }
        return res
    }
    const width = lb + 1
    const NEG = -1e9
    const dp = new Float32Array((la + 1) * width).fill(NEG)
    const dir = new Uint8Array((la + 1) * width)
    dp[0] = 0
    for (let i = 1; i <= la; i++) dp[i * width] = GAP_MD * i
    for (let j = 1; j <= lb; j++) dp[j] = GAP_ASR * j

    for (let i = 1; i <= la; i++) {
        const mw = mdWords[i - 1]
        const row = i * width
        const prow = (i - 1) * width
        for (let j = 1; j <= lb; j++) {
            const diag = dp[prow + j - 1] + wordSimilarity(mw, asrWords[j - 1])
            const up = dp[prow + j] + GAP_MD
            const left = dp[row + j - 1] + GAP_ASR
            let best = diag
            let d = 0
            if (up > best) { best = up; d = 1 }
            if (left > best) { best = left; d = 2 }
            dp[row + j] = best
            dir[row + j] = d
        }
    }

    let i = la
    let j = lb
    while (i > 0 || j > 0) {
        if (i === 0) { j--; continue }
        if (j === 0) { i--; continue }
        const d = dir[i * width + j]
        if (d === 0) {
            // 对角线一步「提升了总分」才记为命中：相似度为负的强行配对不会提升总分，
            // 因此这一步天然过滤掉了 MISMATCH 配对。
            if (dp[i * width + j] > dp[(i - 1) * width + j - 1]) res[i - 1] = j - 1
            i--
            j--
        } else if (d === 1) {
            i--
        } else {
            j--
        }
    }
    return res
}

/**
 * 单调词对齐：md 词流 → ASR 词索引（-1 = 无对应）。
 * 锚点定骨架，段内 DP 填空隙，全程单调可回溯。
 */
export const alignWordsWithAnchors = (mdWords, asrWords) => {
    const mdToAsr = new Int32Array(mdWords.length).fill(-1)
    if (mdWords.length === 0 || asrWords.length === 0) return { map: mdToAsr, anchors: [] }
    const anchors = buildAnchors(mdWords, asrWords)

    // 锚点把两条词流切成若干待对齐段（含头段与尾段）
    const segments = []
    let mdStart = 0
    let asrStart = 0
    for (const a of anchors) {
        if (a.i > mdStart && a.j > asrStart) segments.push([mdStart, a.i, asrStart, a.j])
        for (let t = 0; t < 3; t++) {
            if (a.i + t < mdWords.length && a.j + t < asrWords.length) mdToAsr[a.i + t] = a.j + t
        }
        mdStart = a.i + 3
        asrStart = a.j + 3
    }
    if (mdStart < mdWords.length && asrStart < asrWords.length) {
        segments.push([mdStart, mdWords.length, asrStart, asrWords.length])
    }

    for (const [m0, m1, a0, a1] of segments) {
        const local = alignSegment(mdWords.slice(m0, m1), asrWords.slice(a0, a1))
        for (let t = 0; t < local.length; t++) {
            if (local[t] >= 0) mdToAsr[m0 + t] = a0 + local[t]
        }
    }
    return { map: mdToAsr, anchors }
}

/** 兼容入口：只返回 md→ASR 索引表。 */
export const alignWords = (mdWords, asrWords) => alignWordsWithAnchors(mdWords, asrWords).map

// ── ASR 分段 → 词时间映射 ─────────────────────────────────────

/** 把 ASR 分段展开成词时间表：每词 {word, start, end}，段内按字符长度比例分配。 */
export const buildAsrWordTimeline = (segments) => {
    const timeline = []
    for (const seg of segments) {
        const words = tokenize(seg.text)
        if (words.length === 0) continue
        const span = Math.max(0.2, (Number(seg.end) || 0) - (Number(seg.start) || 0))
        const totalChars = words.reduce((sum, w) => sum + w.length, 0)
        let cursor = Number(seg.start) || 0
        for (const word of words) {
            const dur = span * (word.length / totalChars)
            timeline.push({ word, start: cursor, end: cursor + dur })
            cursor += dur
        }
    }
    return timeline
}

// ── 官方播报句：原文 md 不收录，但音频里有，且是锚点原料 ──────────

const EN_ORDINAL = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+)'
/** 题组播报：「Questions one to four are based on the conversation you have just heard.」→ 锚点 Q1–4 */
const ANNOUNCE_RANGE = new RegExp(
    `questions?\\s+${EN_ORDINAL}\\s*(?:to|through|–|—|-)\\s*${EN_ORDINAL}\\b`, 'i')
/** 节次播报：「Section A Directions」→ 锚点 Section A */
const ANNOUNCE_SECTION = /section\s+[a-d]\b(?:\s*,?\s*directions)?/i
/**
 * 保留规则。`trim: true` 只取播报句本身——whisper 常把播报与紧随的题干塞进同一段，
 * 整段照搬会把题干搬进来与原文重复。`trim: false` 保留整段：指令说明段（"In this
 * section, you will hear…"）本身就占 30 秒，原文 md 不收，不保留就是一段无字幕空档。
 */
const ANNOUNCE_RULES = [
    { re: ANNOUNCE_RANGE, trim: true },
    { re: ANNOUNCE_SECTION, trim: true },
    { re: /\bin this section\b[^.]{0,80}?you will hear\b/i, trim: false },
    { re: /\bboth the (?:conversation|passage|recording)s? and the questions\b/i, trim: false },
]

/** 节次报头：吞并播报块时遇到它就停，别把下一个 section 的开头卷进来。 */
const HEADER_STOP = /\b(?:text|conversation|passage|recording|lecture|talk|section)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[0-9]+|[a-d])\b/i
/** 播报块最长向后吞并的时长（秒），防止在幻觉课程上无限蔓延。 */
const RUN_MAX_SECONDS = 60
/** 段的 ASR 词里与原文对齐命中的比例超过它就认为"原文已收录"，停止吞并。 */
const MATCHED_STOP = 0.35

/**
 * 报头行最长时长（秒）。whisper 会把 "Recording three" 这类短句的 DTW 词时间
 * 拉伸到整段（实测有 7～15 秒的），照单全收会让一行 "RECORDING 3" 盖住后面的正文。
 * "Recording three." 正常读出来约 1.2 秒，3 秒已足够宽松。
 */
const MAX_HEADER_SECONDS = 3

/** 长空档补填：只有 ≥ 该秒数的空档才补，别把正常的句间停顿填满。 */
const MIN_GAP_SECONDS = 4
/** 单次合成最多补填的行数，防幻觉课程把空档铺满。 */
const MAX_GAP_ROWS = 40

/**
 * whisper 会为非语音片段产出纯标记分段（`[silence]`、`[BLANK_AUDIO]`、`(upbeat music)`）。
 * 它们不是内容，绝不能当字幕行写进去（实测 #47 漏过一行 `[silence]`）。
 */
const isNonSpeechMarker = (text) => /^\s*[[(][^\])]{0,40}[\])]\s*$/.test(String(text ?? ''))

/**
 * 把「原文没收录、但音频确实念了」的内容补进残留的长空档。
 *
 * 判据与播报行保留完全一致：该段 ASR 词与原文对齐命中的比例低 → 原文没有这段内容。
 * 与播报行保留的区别是它按「空档」驱动而不是按「规则」驱动，因此能兜住原文与音频
 * 不完全同源的情形（措辞不同的题干、md 摘编掉的段落），不必为此写新规则。
 *
 * @returns {number} 补填的行数
 */
const fillLongGaps = (rows, segments, asrTimeline, matchedAsrIdx) => {
    if (!Array.isArray(segments) || segments.length === 0 || rows.length < 2) return 0
    const coverRatio = (seg) => {
        let hit = 0
        let total = 0
        for (let i = 0; i < asrTimeline.length; i++) {
            const w = asrTimeline[i]
            if (w.start < seg.start - 0.01 || w.end > seg.end + 0.01) continue
            total += 1
            if (matchedAsrIdx.has(i)) hit += 1
        }
        return total === 0 ? 1 : hit / total
    }
    const textKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')

    const additions = []
    for (let i = 1; i < rows.length; i++) {
        const from = rows[i - 1].end
        const to = rows[i].start
        if (to - from < MIN_GAP_SECONDS) continue
        for (const seg of segments) {
            const start = Math.max(Number(seg.start) || 0, from)
            const end = Math.min(Number(seg.end) || 0, to)
            if (end - start < 0.5) continue
            const text = String(seg.text ?? '').trim()
            if (!text) continue
            if (isNonSpeechMarker(text)) continue
            if (coverRatio(seg) > MATCHED_STOP) continue
            // 与紧邻的前后行同文的不补（whisper 重复转写同一句时会这样）
            const key = textKey(text)
            if (key === textKey(rows[i - 1].text) || key === textKey(rows[i].text)) continue
            additions.push({ at: i, start, end, text, section: rows[i].section })
            if (additions.length >= MAX_GAP_ROWS) break
        }
        if (additions.length >= MAX_GAP_ROWS) break
    }
    if (additions.length === 0) return 0

    // 从后往前插入，避免下标位移
    for (let k = additions.length - 1; k >= 0; k--) {
        const a = additions[k]
        rows.splice(a.at, 0, {
            text: a.text,
            section: a.section,
            isSectionHead: false,
            isQuestion: false,
            isInstruction: true,
            start: Math.round(a.start * 1000) / 1000,
            end: Math.round(a.end * 1000) / 1000,
        })
    }
    for (let i = 1; i < rows.length; i++) {
        if (rows[i].start < rows[i - 1].end) rows[i].start = rows[i - 1].end
        if (rows[i].end <= rows[i].start) rows[i].end = rows[i].start + 0.3
    }
    return additions.length
}

/**
 * 从 ASR 分段里挑出「原文 md 未收录的官方播报句/指令说明段」，用于补回锚点并消除空档。
 *
 * 判据不是词表比对而是**对齐结果**：该段覆盖的 ASR 词如果几乎没有与原文对齐命中，
 * 说明原文里确实没有这段内容 → 值得保留。这样既能补回锚点，又不会与原文重复。
 *
 * 指令说明段（"In this section, you will hear…"）会被 whisper 切成 5～6 个连续小段，
 * 只捕获第一段会留下 30 秒空档，因此命中后要**向后吞并**，直到遇见下一个节次报头
 * 或已经对齐上原文的正文。
 *
 * @param {Array} segments 原始 ASR 分段
 * @param {Set<number>} matchedAsrIdx 已与原文对齐命中的 ASR 词索引集合
 */
export const extractAnnouncementRows = (segments, matchedAsrIdx) => {
    // 预处理：分词、词索引区间
    const items = []
    let wordCursor = 0
    for (const seg of segments) {
        const text = String(seg.text ?? '')
        const words = tokenize(text)
        const wordStart = wordCursor
        wordCursor += words.length
        items.push({ seg, text, words, wordStart, wordEnd: wordCursor })
    }

    /** 段内 [fromChar, toChar) 区间的命中情况。 */
    const hitStats = (item, fromChar, toChar) => {
        const len = Math.max(1, item.text.length)
        const a = item.wordStart + Math.floor((item.words.length * fromChar) / len)
        const b = Math.min(item.wordEnd, item.wordStart + Math.ceil((item.words.length * toChar) / len))
        let hit = 0
        let total = 0
        for (let k = a; k < b; k++) {
            total++
            if (matchedAsrIdx.has(k)) hit++
        }
        return { hit, total }
    }
    /** 该段是否"原文已收录"。 */
    const isCoveredByMd = (item) => {
        const { hit, total } = hitStats(item, 0, item.text.length)
        return total === 0 || hit / total > MATCHED_STOP
    }

    const rows = []
    const consumed = new Set()
    const push = (start, end, text) => {
        const s = Number(start)
        const e = Number(end)
        if (isNonSpeechMarker(text)) return
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) rows.push({ start: s, end: e, text: text.trim() })
    }

    for (let i = 0; i < items.length; i++) {
        if (consumed.has(i)) continue
        const item = items[i]
        if (!item.text || item.words.length === 0) continue

        let best = null
        for (const rule of ANNOUNCE_RULES) {
            const m = item.text.match(rule.re)
            if (m && (best === null || m.index < best.index)) best = { index: m.index, trim: rule.trim }
        }
        if (!best) continue

        // 播报本体：trim 规则只取到该句结束；whisper 常把播报与紧随的题干塞进同一段，
        // 整段照搬会把题干一并搬入，与原文重复。
        const rawTail = item.text.slice(best.index)
        const stop = best.trim ? rawTail.search(/[.!?](?:\s|$)/) : -1
        const announceText = (stop >= 0 ? rawTail.slice(0, stop + 1) : rawTail).trim()
        if (announceText.length < 8) continue
        const toChar = best.index + announceText.length
        const self = hitStats(item, best.index, toChar)
        if (self.total === 0 || self.hit / self.total > MATCHED_STOP) continue

        const spanOf = (it, fromChar, toChar) => {
            const len = Math.max(1, it.text.length)
            const s = Number(it.seg.start) || 0
            const e = Number(it.seg.end) || s
            return [s + ((e - s) * fromChar) / len, s + ((e - s) * toChar) / len]
        }
        const [s0, e0] = spanOf(item, best.index, toChar)
        push(s0, e0, announceText)

        // 同一段里「报头句之后」常还跟着指令说明正文（"Section C. Directions. In this
        // section, you will hear three recordings…"）——whisper 会把两者塞进同一段。
        // trim 规则只保留到报头句末，剩余正文不补回就是一段十几到二十几秒的无字幕
        // 空档（实测 #47/#52 的 Section C 各留 23/26 秒）。判据与向后吞并一致：
        // 剩余词几乎没有与原文对齐命中，才说明原文确实没收录。
        // 注意别把题干搬进来——题组播报后的题干是原文已收录的，命中率会高于阈值。
        if (best.trim && toChar < item.text.length) {
            const tail = item.text.slice(toChar).trim()
            const rest = hitStats(item, toChar, item.text.length)
            if (tail.length >= 20 && rest.total > 0 && rest.hit / rest.total <= MATCHED_STOP) {
                const [ts, te] = spanOf(item, toChar, item.text.length)
                const nx = items[i + 1]
                const end = Math.min(te, nx ? Number(nx.seg.start) : Infinity)
                if (end - ts >= 0.3) push(ts, end, tail)
            }
        }

        // 向后吞并同一播报块的后续小段（指令说明段跨段）
        for (let k = i + 1; k < items.length; k++) {
            const nx = items[k]
            if (!nx.text || nx.words.length === 0) continue
            if (HEADER_STOP.test(nx.text)) break
            if (NX_UNIT_START.test(nx.text)) break
            if (isCoveredByMd(nx)) break
            if ((Number(nx.seg.end) || 0) - s0 > RUN_MAX_SECONDS) break
            push(nx.seg.start, nx.seg.end, nx.text)
            consumed.add(k)
        }
    }
    return rows
}

/** 题组播报的第一句（"Question one, …"）说明播报块已结束，进入题干。 */
const NX_UNIT_START = /^\s*(?:and\s+)?questions?\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+)\b/i

// ── 分节报头定位 ─────────────────────────────────────────────
// md 的 `## CONVERSATION 1` / `## PASSAGE 2` / `## RECORDING 3` 这类标题行不参与词对齐
// （见 synthesizeTranscript 里对 isSectionHead 的跳过），插值落点会偏 0.5～2.4 秒。
// 但报头在音频里是真实播报，ASR 有精确时间，所以按「报头词对」就近认领。

const NUMBER_WORD_TO_DIGIT = {
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
    seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
}

/** 报头词归一：去标点、统一小写、英文数字词 → 阿拉伯数字（ASR 时而 "two" 时而 "2"）。 */
const headerToken = (token) => {
    const t = String(token ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    return NUMBER_WORD_TO_DIGIT[t] ?? t
}

/**
 * 在 ASR 词级时间轴上定位报头（"Conversation 1" / "Recording two" …）的真实播报区间。
 *
 * @param {Array} asrTimeline buildAsrWordTimeline 的输出
 * @param {string} headerText md 标题文本，如 "CONVERSATION 1"
 * @param {number} hintTime 插值给出的期望位置，多个候选时就近认领
 * @param {number} [maxDrift=120] 允许偏离 hintTime 的最大秒数，避免认到别处的同名报头
 * @returns {{start:number,end:number}|null}
 */
export const locateHeaderSpan = (asrTimeline, headerText, hintTime, maxDrift = 120) => {
    const parts = tokenize(headerText).map(headerToken).filter(Boolean)
    if (parts.length < 2) return null
    let best = null
    for (let j = 0; j + parts.length <= asrTimeline.length; j++) {
        let hit = true
        for (let k = 0; k < parts.length; k++) {
            if (headerToken(asrTimeline[j + k].word) !== parts[k]) { hit = false; break }
        }
        if (!hit) continue
        const start = Number(asrTimeline[j].start)
        const end = Number(asrTimeline[j + parts.length - 1].end)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
        const drift = Number.isFinite(hintTime) ? Math.abs(start - hintTime) : 0
        if (best === null || drift < best.drift) best = { start, end, drift }
    }
    if (!best) return null
    if (Number.isFinite(hintTime) && best.drift > maxDrift) return null
    return { start: best.start, end: best.end }
}

// ── 合成：原文句 + ASR 时间 → 字幕行 ─────────────────────────

/** 对齐质量门限：命中率低于此值视为对齐失败，调用方必须拒绝写库。 */
export const MIN_HIT_RATE = 0.7

/**
 * 核心合成：md 句列表 + ASR 词时间 → 带时间与分节的字幕行。
 *
 * @param {Array} mdSentences parseYuanwenMd 的输出
 * @param {Array} asrTimeline buildAsrWordTimeline 的输出
 * @param {{audioDuration?:number}} [options] 音频真实时长（秒）。给了就强钳制时间轴。
 * @returns {{lines:Array, stats:object}} lines 为字幕行；stats 含对齐质量指标。
 */
export const synthesizeTranscript = (mdSentences, asrTimeline, options = {}) => {
    const audioDuration = Number.isFinite(options.audioDuration) ? options.audioDuration : null
    const mdWords = []
    mdSentences.forEach((sentence, index) => {
        // 报头标签行（CONVERSATION 1 / PASSAGE 2 …）是锚点原料，不参与词对齐
        if (sentence.isSectionHead) return
        for (const word of tokenize(sentence.rawText ?? sentence.text)) {
            mdWords.push({ word, sentenceIndex: index })
        }
    })
    const asrWords = asrTimeline.map((entry) => entry.word)
    const { map: mdToAsr, anchors } = alignWordsWithAnchors(mdWords.map((entry) => entry.word), asrWords)

    // 每句收集命中词的 ASR 时间与词数
    const per = mdSentences.map(() => ({ hits: 0, words: 0, start: Infinity, end: -Infinity }))
    let matchedWords = 0
    const matchedAsrIdx = new Set()
    mdWords.forEach((entry, wordIndex) => {
        per[entry.sentenceIndex].words++
        const asrIdx = mdToAsr[wordIndex]
        if (asrIdx === -1 || asrIdx === undefined) return
        const t = asrTimeline[asrIdx]
        if (!t) return
        matchedWords++
        matchedAsrIdx.add(asrIdx)
        const s = per[entry.sentenceIndex]
        s.hits++
        s.start = Math.min(s.start, t.start)
        s.end = Math.max(s.end, t.end)
    })
    const hitRate = mdWords.length > 0 ? matchedWords / mdWords.length : 0

    // 控制点 = 有命中的句子（取其命中词时间中点）
    const controls = []
    mdSentences.forEach((_, index) => {
        const t = per[index]
        if (t.hits > 0 && Number.isFinite(t.start)) {
            controls.push({ idx: index, time: (t.start + t.end) / 2 })
        }
    })

    // 无命中句按**词数比例**在相邻控制点之间插值（v1 的 idx*4 均匀铺排已废弃）
    const weight = (from, to) => {
        let sum = 0
        for (let k = from; k <= to; k++) sum += per[k].words
        return sum
    }
    const timeAt = (idx) => {
        if (controls.length === 0) return null
        if (idx <= controls[0].idx) return controls[0].time
        for (let k = 0; k < controls.length - 1; k++) {
            const a = controls[k]
            const b = controls[k + 1]
            if (idx >= a.idx && idx <= b.idx) {
                if (idx === a.idx) return a.time
                const wAll = weight(a.idx, b.idx)
                const wPart = wAll > 0 ? weight(a.idx, idx) : idx - a.idx
                const frac = wAll > 0 ? wPart / wAll : (idx - a.idx) / (b.idx - a.idx)
                return a.time + frac * (b.time - a.time)
            }
        }
        return controls[controls.length - 1].time
    }

    // 生成行：起点优先用命中词的实测 start，无命中则用插值；
    // 全程单调，并强钳制在音频时长内。
    const ceiling = audioDuration ?? Infinity
    const result = []
    let prevEnd = 0
    const minDur = 0.5
    for (let i = 0; i < mdSentences.length; i++) {
        const sentence = mdSentences[i]
        const t = per[i]
        const measured = t.hits > 0 && Number.isFinite(t.start) ? t.start : null
        const interp = timeAt(i)

        // 分节报头：不参与词对齐，但 ASR 里有它的真实播报位置，优先用它。
        // 报头位置常落在上一行的跨度内（原文行铺满时间轴），必须从上一行切出来，
        // 否则会被单调钳制推后、并在前面留出一截无字幕空洞。
        if (sentence.isSectionHead) {
            const span = locateHeaderSpan(asrTimeline, sentence.text, interp)
            if (span) {
                let hs = Math.max(0, span.start)
                let he = Math.max(hs + minDur, Math.min(span.end, hs + MAX_HEADER_SECONDS))
                if (Number.isFinite(ceiling)) he = Math.min(he, ceiling)
                for (let k = result.length - 1; k >= 0; k--) {
                    const l = result[k]
                    if (l.end <= hs) break
                    if (l.start < hs) l.end = hs
                    else { l.start = he; if (l.end < l.start + 0.15) l.end = l.start + 0.3 }
                }
                prevEnd = he
                result.push({
                    text: sentence.text,
                    section: sentence.section,
                    isSectionHead: true,
                    isQuestion: false,
                    start: Math.round(hs * 1000) / 1000,
                    end: Math.round(he * 1000) / 1000,
                })
                continue
            }
        }

        let start = measured ?? interp
        if (start === null || !Number.isFinite(start)) start = prevEnd
        start = Math.max(start, prevEnd)
        if (Number.isFinite(ceiling)) start = Math.min(start, Math.max(0, ceiling - minDur))

        const nextMeasured = (() => {
            for (let k = i + 1; k < mdSentences.length; k++) {
                if (per[k].hits > 0 && Number.isFinite(per[k].start)) return per[k].start
            }
            return null
        })()
        const nextInterp = timeAt(i + 1)
        let end = nextMeasured ?? nextInterp
        if (end === null || !Number.isFinite(end) || end <= start) end = start + minDur
        end = Math.max(start + minDur, Math.min(end, ceiling))
        if (end <= start) end = start + minDur
        prevEnd = end
        result.push({
            text: sentence.text,
            section: sentence.section,
            isSectionHead: Boolean(sentence.isSectionHead),
            isQuestion: Boolean(sentence.isQuestion),
            start: Math.round(start * 1000) / 1000,
            end: Math.round(end * 1000) / 1000,
        })
    }

    // 补回原文未收录的官方播报句（题组「Questions N to M…」、节次「Section A…」），
    // 它们不在 md 里，却是 dialogueAnchors 生成题组/节次锚点的唯一原料。
    //
    // 注意：原文行是**无缝铺满**整条时间轴的（每行 end = 下一行 start），所以播报行
    // 不能"插进空隙"，必须先从原文行的跨度里把它占用的区间切出来，否则会被夹成零长度。
    let instructionRows = 0
    if (Array.isArray(options.segments) && options.segments.length > 0) {
        const seen = []
        const extras = extractAnnouncementRows(options.segments, matchedAsrIdx)
            .sort((a, b) => a.start - b.start)
            .filter((ex) => {
                // 同一句播报在 ASR 里可能被重复转写，去重避免锚点重名
                const key = ex.text.toLowerCase().replace(/[^a-z]/g, '')
                if (seen.some((s) => s.key === key && Math.abs(s.start - ex.start) < 90)) return false
                seen.push({ key, start: ex.start })
                return true
            })
        // 已定位到 ASR 真实位置的报头行，插播报行时优先保护它们
        const headerSpans = result.filter((l) => l.isSectionHead).map((l) => ({ start: l.start, end: l.end }))
        for (const ex of extras) {
            let s0 = ex.start
            let e0 = ex.end
            // 报头行优先：播报行的区间不得盖住报头——Section C 的指令说明段常与
            // "Recording 1" 同段，照原样插入会把报头挤成零长度，随后被残行清理掉。
            for (const h of headerSpans) {
                if (e0 <= h.start || s0 >= h.end) continue
                if (s0 < h.start) e0 = Math.min(e0, h.start)
                else s0 = Math.max(s0, h.end)
            }
            if (e0 - s0 < 0.3) continue
            // 从被覆盖的原文行里切出该区间
            for (const l of result) {
                if (l.end <= s0 || l.start >= e0) continue
                if (l.start < s0) {
                    l.end = Math.min(l.end, s0)
                } else {
                    l.start = Math.max(l.start, e0)
                }
            }
            let at = result.findIndex((l) => l.start >= e0)
            if (at === -1) at = result.length
            const prev = at > 0 ? result[at - 1] : null
            const next = at < result.length ? result[at] : null
            let s = s0
            let e = e0
            if (prev) s = Math.max(s, prev.end)
            if (next) e = Math.min(e, next.start)
            if (e - s < 0.3) continue
            result.splice(at, 0, {
                text: ex.text,
                section: next?.section ?? prev?.section ?? '开场',
                isSectionHead: false,
                isQuestion: false,
                isInstruction: true,
                start: Math.round(s * 1000) / 1000,
                end: Math.round(e * 1000) / 1000,
            })
            instructionRows++
        }
        // 清理被切得过短的残行，并重新保证单调不重叠
        for (let i = result.length - 1; i >= 0; i--) {
            if (result[i].end - result[i].start < 0.15) result.splice(i, 1)
        }
        for (let i = 1; i < result.length; i++) {
            if (result[i].start < result[i - 1].end) result[i].start = result[i - 1].end
            if (result[i].end <= result[i].start) result[i].end = result[i].start + 0.3
        }

        // 补填残留的长空档。原文 md 与音频不完全同源时（实测 #24 的 md 去重词 726
        // 少于音频 878，题干还是另写的），那一段既没有原文可对齐、也不属于上面几类
        // 播报，就会留下一截无字幕空档（#24 / #41 各有约 23 秒）。判据与播报行保留
        // 一致：空档里 ASR 有内容、且这些词几乎没与原文对齐命中 → 是原文没收录的
        // 音频内容，补回来比留空好（补回来的是音频真正念的话）。
        const inserted = fillLongGaps(result, options.segments, asrTimeline, matchedAsrIdx)
        instructionRows += inserted
    }

    const maxEnd = result.length > 0 ? Math.max(...result.map((l) => l.end)) : 0
    const stats = {
        mdWordCount: mdWords.length,
        asrWordCount: asrWords.length,
        matchedWords,
        hitRate,
        controls: controls.length,
        anchorCount: anchors.length,
        instructionRows,
        maxEnd,
        audioDuration,
        overflow: audioDuration ? maxEnd - audioDuration : null,
        ok: hitRate >= MIN_HIT_RATE &&
            (audioDuration === null || maxEnd <= audioDuration + 1),
    }
    return { lines: result, stats }
}
