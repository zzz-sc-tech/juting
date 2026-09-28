/**
 * 字幕和解器：旧字幕（官方原文+锚点全）做底，新 ASR 时间轴修边界。
 *
 * 背景：老合并管线在部分课程留下巨句/碎片/吞静音，但指令播报齐全、文本是官方原文；
 * 重跑的 whisper 时间轴真实却系统性漏听轻声报头（锚点会丢）。两者取长：
 *   1. 以旧行序列为骨架（文本、行数、指令行全保留）；
 *   2. 新旧行单调匹配（序列对齐），匹配上的旧行采用新时间轴（真实边界）；
 *   3. 旧行一对多匹配新行且旧文本含多句 → 按句拆分、按新行分配时间；
 *   4. 没匹配上的旧行（whisper 漏听的报头）保留旧时间轴，并夹在前邻句之间；
 *   5. 新行有而旧行没有的内容（whisper 幻觉）一律不采纳。
 *
 * 用法：node scripts/local/reconcile-transcript.mjs --ids 24,43,32 [--apply]
 * 旧字幕取自 presets/cet6/seed.json（git 里的发布基线）；新时间轴取当前库里的
 * 转录（repair-course-asr.mjs 写入的合并产物）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPLY = process.argv.includes('--apply');
const idsIndex = process.argv.indexOf('--ids');
const IDS = idsIndex >= 0
    ? process.argv[idsIndex + 1].split(',').map(Number).filter(Number.isInteger)
    : [];

const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for',
    'that', 'this', 'is', 'was', 'are', 'were', 'it', 'we', 'they', 'you', 'i', 'he', 'she',
    'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
    'so', 'as', 'but', 'with', 'what', 'when', 'where', 'why', 'how']);
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => normalize(s).split(' ').filter(Boolean);
const contentWords = (s) => words(s).filter((w) => !STOPWORDS.has(w));
/**
 * 包含度相似度：交集 / 较短边的实词数。选它而不是 Jaccard，是因为老巨句
 * （100 词）与单条新分段（12 词）的 Jaccard 天然只有 0.1x，永远过不了线；
 * 包含度则能正确表达"这条分段是那句话的一部分"。
 */
const similarity = (a, b) => {
    const wa = new Set(contentWords(a));
    const wb = new Set(contentWords(b));
    if (wa.size === 0 || wb.size === 0) return 0;
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter += 1;
    return inter / Math.min(wa.size, wb.size);
};
const splitSentences = (text) => {
    const parts = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
    return parts.map((p) => p.trim()).filter(Boolean);
};
const r1 = (v) => Math.round(v * 1000) / 1000;
/**
 * 按句拆分一行（全脚本唯一的句子拆分实现，所有路径统一调用）：
 * - 纯标记句（"Q12."）先回拼到后续问句，避免播报行被劈成 0.5s 碎片；
 * - 多句时按字符占比分配原行时间。
 */
const splitLineBySentences = (line) => {
    const dur = line.end - line.start;
    const sentences = splitSentences(line.text);
    for (let si = sentences.length - 2; si >= 0; si -= 1) {
        if (/^\s*(?:Q\s?\d+|Questions?\s+\d+)\s*[.。:：]?\s*$/i.test(sentences[si])) {
            sentences[si] = `${sentences[si]} ${sentences[si + 1]}`.trim();
            sentences.splice(si + 1, 1);
        }
    }
    if (sentences.length <= 1) {
        return [line];
    }
    let cursor = line.start;
    const total = sentences.reduce((sum, x) => sum + x.length, 0);
    const result = [];
    for (const sentence of sentences) {
        const span = Math.max(0.5, dur * (sentence.length / total));
        const lineEnd = Math.min(line.end, cursor + span);
        result.push({ ...line, text: sentence, start: r1(cursor), end: r1(lineEnd) });
        cursor = lineEnd;
    }
    return result;
};

// 旧字幕底稿：默认当前 seed；修复重跑时用 --old-seed 指向修复前的
// 官方文本基线（当前 seed 若已是修复后导出，会把既有缺口当真值）。
const oldSeedIdx = process.argv.indexOf('--old-seed');
const oldSeedPath = oldSeedIdx >= 0 ? path.resolve(root, process.argv[oldSeedIdx + 1]) : path.join(root, 'presets', 'cet6', 'seed.json');
const seed = JSON.parse(fs.readFileSync(oldSeedPath, 'utf8'));
const fileEnvironment = {};
dotenv.config({ path: path.join(root, 'temp', 'runtime', 'portable.env'), processEnv: fileEnvironment, quiet: true });
const env = { ...fileEnvironment, ...process.env };
const c = await mysql.createConnection({
    host: (env.MYSQL_HOST || '127.0.0.1').trim(),
    port: Number(env.MYSQL_PORT || '3306'),
    user: (env.MYSQL_USER || env.MYSQL_USERNAME || 'root').trim(),
    password: env.MYSQL_PASSWORD || '',
    database: (env.MYSQL_DATABASE || 'duolinting_app_dev').trim(),
});

for (const id of IDS) {
    const seedEx = seed.exercises.find((e) => e.id === id);
    if (!seedEx) {
        console.error(`[${id}] seed 里没有该课程，跳过`);
        continue;
    }
    const oldLines = typeof seedEx.transcript_json === 'string'
        ? JSON.parse(seedEx.transcript_json)
        : seedEx.transcript_json;
    const [rows] = await c.query('select transcript_json, audio_object_name, title from exercises where id = ?', [id]);
    // 新时间轴优先取 ASR 缓存的原始分段（信息最全），无缓存再退回当前库转录。
    let newLines = null;
    let source = '当前库转录';
    if (rows[0].audio_object_name) {
        // 汇聚该音频全部成功识别轮的分段（whisper 各轮漏听区域不同，
        // 合并多轮池让 DP 对齐在任一轮覆盖处找到匹配），按时间排序。
        const [jobs] = await c.query(
            "select result_json from media_asr_jobs where object_name = ? and status = 'succeeded'",
            [rows[0].audio_object_name],
        );
        const pool = [];
        for (const job of jobs) {
            const result = typeof job.result_json === 'string'
                ? JSON.parse(job.result_json)
                : job.result_json;
            const segs = Array.isArray(result) ? result : (result.segments ?? []);
            for (const seg of segs) {
                pool.push({ start: seg.start, end: seg.end, text: seg.text });
            }
        }
        if (pool.length > 0) {
            pool.sort((a, b) => a.start - b.start);
            newLines = pool;
            source = `ASR缓存 ${jobs.length} 轮合并 ${pool.length} 段`;
        }
    }
    if (!newLines || newLines.length === 0) {
        newLines = typeof rows[0].transcript_json === 'string'
            ? JSON.parse(rows[0].transcript_json)
            : rows[0].transcript_json;
    }
    console.log(`\n[${id}] ${rows[0].title}：旧 ${oldLines.length} 句 / 新 ${newLines.length} 段（${source}）`);

    const DEBUG = process.argv.includes('--debug');
    // ── 巨句预拆：老管线留下的多句巨行先还原成单句行（时长按字符占比），
    //    句子级行才能与新分段正确匹配；锚点指令行不拆。───
    const prepped = [];
    for (const line of oldLines) {
        const dur = line.end - line.start;
        const wc = String(line.text).trim().split(/\s+/).filter(Boolean).length;
        const isQuestionReadout = /^(?:Q\s?\d+|Questions?\s+\d+)/i.test(line.text.trim());
        if (dur > 15 && !isQuestionReadout && wc < dur * 2.2 && splitSentences(line.text).length > 1) {
            prepped.push(...splitLineBySentences(line));
        } else {
            prepped.push(line);
        }
    }

    // ── 全局单调 DP 对齐：老行(文本真值) × 新分段(时间真值) ──────
    // 贪心窗口法会被长内容行"偷"走后面老行的分段（44 处 >15s 空档的根因），
    // DP 保证：每条分段至多被认领一次、认领顺序严格单调、老行可吞并一段连续
    // 分段（≤25 条）。跳过代价 0.02，匹配收益 = 包含度 − 0.32（≥0.32 才肯认）。
    const n = prepped.length, m = newLines.length;
    const simCache = new Map();
    const runSim = (i, j, k) => {
        const key = i * 1000000 + j * 1000 + k;
        if (simCache.has(key)) return simCache.get(key);
        const joined = newLines.slice(j, k + 1).map((x) => x.text).join(' ');
        const v = similarity(prepped[i].text, joined);
        simCache.set(key, v);
        return v;
    };
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(-Infinity));
    const bt = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
    dp[0][0] = 0;
    const SKIP = 0.02;
    for (let i = 0; i <= n; i += 1) {
        for (let j = 0; j <= m; j += 1) {
            const cur = dp[i][j];
            if (cur === -Infinity) continue;
            if (j < m && cur - SKIP > dp[i][j + 1]) {
                dp[i][j + 1] = cur - SKIP;
                bt[i][j + 1] = { pi: i, pj: j, kind: 'new' };
            }
            if (i < n && cur - SKIP > dp[i + 1][j]) {
                dp[i + 1][j] = cur - SKIP;
                bt[i + 1][j] = { pi: i, pj: j, kind: 'old' };
            }
            if (i < n) {
                const kMax = Math.min(m - 1, j + 24);
                for (let k = j; k <= kMax; k += 1) {
                    const sim = runSim(i, j, k);
                    if (sim < 0.32) continue;
                    const gain = cur + sim - 0.32;
                    if (gain > dp[i + 1][k + 1]) {
                        dp[i + 1][k + 1] = gain;
                        bt[i + 1][k + 1] = { pi: i, pj: j, kind: 'match', runEnd: k };
                    }
                }
            }
        }
    }
    // 回溯：每条老行的认领段（或无）
    const oldMatched = [];
    let i = n, j = m;
    const runs = new Map();
    while (i > 0 || j > 0) {
        const b = bt[i][j];
        if (!b) break;
        if (b.kind === 'match') runs.set(b.pi, [b.pj, b.runEnd]);
        i = b.pi; j = b.pj;
    }
    for (let oi = 0; oi < n; oi += 1) {
        const run = runs.get(oi);
        oldMatched.push({ old: prepped[oi], taken: run ? Array.from({ length: run[1] - run[0] + 1 }, (_, x) => run[0] + x) : [] });
    }
    if (DEBUG) {
        let matched = 0;
        for (const om of oldMatched) if (om.taken.length) matched += 1;
        console.log(`  [dp] 老行 ${n}：匹配 ${matched}、未匹配 ${n - matched}；新分段 ${m}`);
    }

    // ── 按匹配结果重建：旧行文本全保留，时间换成真实分段边界 ────
    const out = [];
    for (const { old, taken } of oldMatched) {
        const prevEnd = out.length > 0 ? out[out.length - 1].end : 0;
        if (taken.length === 0) {
            // whisper 漏听的行（多为轻声报头）：保留旧时间轴，前推防重叠
            const start = Math.max(old.start, prevEnd);
            const end = Math.max(start + 0.8, start + Math.max(0.8, old.end - old.start));
            out.push({ ...old, start: r1(start), end: r1(end) });
            continue;
        }
        const firstNew = newLines[taken[0]];
        const lastNew = newLines[taken[taken.length - 1]];
        const start = Math.max(firstNew.start, prevEnd);
        const end = Math.max(start + 0.8, lastNew.end);
        // 一对多且老文本含多句：按句拆（标记回拼在共享函数内），时间按字符占比
        const pieces = splitLineBySentences({ ...old, start, end });
        out.push(...pieces);
    }

    // ── 插入找回：新分段有、老字幕没有的内容（如漏听的题干播报）───
    // 未被认领的分段按连续组成团；整团落在老行间隙（无重叠）且文本量足够才插入，
    // 连续重复文本视为 whisper 幻觉直接丢弃。
    const segUsed = new Array(newLines.length).fill(false);
    for (const om of oldMatched) for (const k of om.taken) segUsed[k] = true;
    {
        const free = [];
        for (let k = 0; k < newLines.length; k += 1) {
            if (!segUsed[k]) free.push(k);
        }
        let group = [];
        const flushGroup = () => {
            if (group.length === 0) return;
            const gs = newLines[group[0]].start;
            const ge = newLines[group[group.length - 1]].end;
            const texts = group.map((k) => newLines[k].text.trim());
            const uniq = new Set(texts.map((t) => normalize(t)));
            const textLen = texts.join(' ').length;
            const overlapsOut = out.some((l) => l.start < ge - 0.3 && l.end > gs + 0.3);
            const hallucinated = texts.length >= 3 && uniq.size <= Math.ceil(texts.length / 3);
            if (!overlapsOut && !hallucinated && textLen >= 20 && ge - gs >= 1.5) {
                const joined = texts.join(' ');
                out.push(...splitLineBySentences({ ...prepped[0], id: undefined, text: joined, start: gs, end: ge }));
                if (DEBUG) console.log(`  [insert] ${gs.toFixed(1)}-${ge.toFixed(1)} ${JSON.stringify(texts.join(' ').slice(0, 60))}`);
            } else if (DEBUG) {
                console.log(`  [skip] ${gs.toFixed(1)}-${ge.toFixed(1)} overlap=${overlapsOut} halluc=${hallucinated} len=${textLen}`);
            }
            group = [];
        };
        for (let k = 0; k < newLines.length; k += 1) {
            if (!segUsed[k]) {
                if (group.length === 0 || k === group[group.length - 1] + 1) {
                    group.push(k);
                } else {
                    flushGroup();
                    group.push(k);
                }
            } else {
                flushGroup();
            }
        }
        flushGroup();
        out.sort((a, b) => a.start - b.start);
    }

    // ── 终检拆分：句边界拆分 + 行中报头切割（Q21 播报吞掉 RECORDING 3 这类粘行）───
    const HEADER_MID = /\s+((?:RECORDING|CONVERSATION|PASSAGE|SECTION)\s+(?:one|two|three|four|five|[0-9]+|[A-D]))\s+(?=[A-Z"])/;
    const splitPass = (lines) => {
        const result = [];
        for (const line of lines) {
            const sentences = splitSentences(line.text);
            if (sentences.length > 1) {
                result.push(...splitLineBySentences(line));
                continue;
            }
            const mid = line.text.match(HEADER_MID);
            if (mid && dur > 2) {
                const cut = mid.index + mid[1].length;
                const ratio = cut / line.text.length;
                result.push({ ...line, text: line.text.slice(0, cut).trim(), end: r1(line.start + dur * ratio) });
                result.push({ ...line, text: line.text.slice(cut).trim(), start: r1(line.start + dur * ratio) });
                continue;
            }
            result.push(line);
        }
        return result;
    };
    const split1 = splitPass(out);
    const split2 = splitPass(split1);

    // ── 碎片后合并：<1s 的行并入同说话人邻句（与合并管线同一规则）───
    const speakerOf = (text) => {
        const m = String(text).match(/^([A-Z]{1,3}):\s*/);
        return m ? m[1] : null;
    };
    const isProtected = (text) => {
        const t = String(text).trim();
        if (!t || /[\u4e00-\u9fff]/.test(t)) return true;
        if (/^(SECTION|CONVERSATION|PASSAGE|RECORDING|TALK|TEXT|PART)\b/i.test(t)) return true;
        if (/^(QUESTIONS?|Q)\s*\d/i.test(t)) return true;
        if (/BASED\s+ON/i.test(t)) return true;
        if (/^(DIRECTIONS|NOW\s+LISTEN|THAT\s+IS\s+THE\s+END|THIS\s+IS\s+THE\s+END)/i.test(t)) return true;
        return false;
    };
    const merged = [];
    for (const line of split2) {
        const last = merged[merged.length - 1];
        const dur = line.end - line.start;
        // 受保护指令行（Section/Recording 报头、Q 播报、Directions）绝不参与碎片合并
        if (dur < 1 && last && !isProtected(line.text) && !isProtected(last.text)) {
            const sp = speakerOf(line.text);
            const spLast = speakerOf(last.text);
            const compatible = (sp && spLast) ? sp === spLast : true;
            if (compatible) {
                last.end = line.end;
                last.text = `${last.text.trim()} ${line.text.trim()}`.replace(/\s+/g, ' ');
                continue;
            }
        }
        merged.push({ ...line });
    }

    // ── 统计与写库 ────────────────────────────────────────────
    const retimed = merged.filter((line) => {
        const origin = oldLines.find((o) => o.text === line.text || o.text.includes(line.text));
        return origin && Math.abs(origin.start - line.start) > 0.05;
    }).length;
    const fragments = merged.filter((l) => l.end - l.start < 0.7).length;
    const giants = merged.filter((l) => {
        const d = l.end - l.start;
        return d > 15 && !/^(?:Q\s?\d+|Questions?\s+\d+)/i.test(l.text.trim()) && l.text.split(/\s+/).length < d * 2.2;
    }).length;
    console.log(`  和解后 ${merged.length} 句；时间轴改动 ${retimed} 处；残留碎片 ${fragments}、巨句 ${giants}`);

    if (APPLY) {
        const lines = merged.map((l, index) => ({
            id: `l${index + 1}`,
            start: Math.round(l.start * 1000) / 1000,
            end: Math.round(l.end * 1000) / 1000,
            text: l.text, translation: l.translation ?? '', translations: l.translations ?? {}, answers: l.answers ?? [], keywords: l.keywords ?? [],
        }));
        await c.query('update exercises set transcript_json = ? where id = ?', [JSON.stringify(lines), id]);
        console.log(`  ✓ 已写库`);
    }
}
await c.end();
if (!APPLY) console.log('\n[dry-run] 未写库，确认后加 --apply。');
