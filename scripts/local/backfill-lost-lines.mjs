/**
 * 丢失行回填器：对重建课程，把「v1 官方底稿有、现库没有」的行按 v1 时间
 * 回填到现库（夹在现库邻行之间），消除内容空档。
 *
 * 背景：whisper 各轮识别漏听区域不同；和解后个别区域两个可用轮恰好都漏，
 * v1 里该区域的正文行在现库消失。这些行的文本在 v1 底稿（官方原文）、
 * 时间在原始 ASR——都有真值来源，直接回填。
 *
 * 判定「丢失」：v1 行的归一化文本不出现在现库全文（归一化拼接）中。
 * 回填后对 <0.75s 的非保护碎片做一次并入邻行。
 *
 * 用法：node scripts/local/backfill-lost-lines.mjs --ids 41,50,... --apply
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
const IDS = idsIndex >= 0 ? process.argv[idsIndex + 1].split(',').map(Number).filter(Number.isInteger) : [];

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

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
    return false;
};

for (const id of IDS) {
    const seedEx = seed.exercises.find((e) => e.id === id);
    if (!seedEx) {
        console.error(`[${id}] seed 无此课程`);
        continue;
    }
    const v1Lines = typeof seedEx.transcript_json === 'string'
        ? JSON.parse(seedEx.transcript_json)
        : seedEx.transcript_json;
    const [rows] = await c.query('select transcript_json, title from exercises where id = ?', [id]);
    const cur = typeof rows[0].transcript_json === 'string'
        ? JSON.parse(rows[0].transcript_json)
        : rows[0].transcript_json;

    // 现库全文（归一化），用于判断 v1 行是否已存在
    const curNormText = normalize(cur.map((l) => l.text).join(' '));
    const lost = [];
    for (const line of v1Lines) {
        const norm = normalize(line.text);
        if (norm && !curNormText.includes(norm)) {
            lost.push(line);
        }
    }
    if (lost.length === 0) {
        console.log(`[${id}] ${rows[0].title}: 无丢失行`);
        continue;
    }

    // 连续的丢失行组成团，按团回填（时间 = 首行 start ~ 末行 end），夹在现库邻行之间
    const groups = [];
    for (const line of lost) {
        const last = groups[groups.length - 1];
        if (last && line.start - last[last.length - 1].end < 3) {
            last.push(line);
        } else {
            groups.push([line]);
        }
    }

    let inserted = 0;
    for (const group of groups) {
        const gs = group[0].start;
        const ge = group[group.length - 1].end;
        // 与现库行重叠则跳过（时间被占用，说明内容其实以其他形态存在）
        const overlaps = cur.some((l) => l.start < ge - 0.3 && l.end > gs + 0.3);
        if (overlaps) {
            console.log(`  [skip] ${gs.toFixed(1)}-${ge.toFixed(1)} 与现库行重叠`);
            continue;
        }
        // 按字符占比把区间分配给组内各行（保持 v1 相对节奏）
        let cursor = gs;
        const total = group.reduce((sum, l) => sum + Math.max(0.5, l.end - l.start), 0);
        for (const line of group) {
            const dur = Math.max(0.5, line.end - line.start);
            const span = (ge - cursor) * (dur / total);
            const lineEnd = Math.min(ge, cursor + span);
            cur.push({
                ...line,
                start: Math.round(cursor * 1000) / 1000,
                end: Math.round(lineEnd * 1000) / 1000,
            });
            cursor = lineEnd;
            inserted += 1;
        }
        cur.sort((a, b) => a.start - b.start);
    }

    // 碎片合并：<0.75s 非保护行并入同说话人前邻行
    const final = [];
    for (const line of cur) {
        const last = final[final.length - 1];
        const dur = line.end - line.start;
        if (dur < 0.75 && last && !isProtected(line.text) && !isProtected(last.text)) {
            const sp = speakerOf(line.text);
            const spLast = speakerOf(last.text);
            if ((!sp || !spLast) || sp === spLast) {
                last.end = line.end;
                last.text = `${last.text.trim()} ${line.text.trim()}`.replace(/\s+/g, ' ');
                continue;
            }
        }
        final.push({ ...line });
    }
    // 重排 id
    const lines = final.map((l, index) => ({
        id: `l${index + 1}`,
        start: Math.round(l.start * 1000) / 1000,
        end: Math.round(l.end * 1000) / 1000,
        text: l.text, translation: l.translation ?? '', translations: l.translations ?? {},
        answers: l.answers ?? [], keywords: l.keywords ?? [],
    }));

    console.log(`[${id}] ${rows[0].title}: 回填 ${inserted} 行（${lost.length} 行丢失，${lost.length - inserted} 行因时间重叠跳过）→ 共 ${lines.length} 行`);
    if (APPLY && inserted > 0) {
        await c.query('update exercises set transcript_json = ? where id = ?', [JSON.stringify(lines), id]);
    }
}
await c.end();
if (!APPLY) console.log('[dry-run] 未写库，加 --apply 生效。');
