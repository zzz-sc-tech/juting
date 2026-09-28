/**
 * 全库字幕切分质量审计：扫全部已发布课程，按缺陷签名打分：
 *   A. 巨句（>20s，正文疑似被并进一段）
 *   B. 微碎片（<0.7s，说话人切换处被切碎）
 *   C. 题干播报拦腰断（"Questions N. ..." 结尾无问号且下一句以小写续行）
 *   D. 题组播报缺失（Q12–15 这类 "…based on the passage" 句不存在）
 * 输出每门课的缺陷计数与嫌疑行，供 repair-course-asr.mjs 排队重建。
 *
 * 用法：node scripts/local/audit-segment-quality.mjs [--min-score 3]
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const minScore = Number(process.argv[process.argv.indexOf('--min-score') + 1] ?? 1);

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
const [rows] = await c.query(
    "select id, title, transcript_json from exercises where status = 'published' order by id",
);

const report = [];
for (const row of rows) {
    const t = typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json;
    const defects = { giant: [], fragment: [], midSplit: [], missingGroup: [] };

    t.forEach((line, i) => {
        const dur = line.end - line.start;
        const words = String(line.text).trim().split(/\s+/).filter(Boolean).length;
        // A. 巨句：正文行时长远超朗读速度（题干播报 Q+选项朗读 20s 属正常，排除）
        const isQuestionReadout = /^(?:Q\s?\d+|Questions?\s+\d+)/i.test(line.text.trim())
        if (dur > 15 && !isQuestionReadout && words < dur * 2.2) defects.giant.push({ i, ...line });
        // B. 微碎片：非报头的 0.7s 内短行
        if (dur < 0.7 && words > 0 && !/^(SECTION|CONVERSATION|PASSAGE|RECORDING|TALK|PART)/i.test(line.text)) {
            defects.fragment.push({ i, ...line });
        }
        // C. 题干播报拦腰断：以 "Question(s) N." 开头、无结尾标点，且下一句以小写/助动词续行
        const next = t[i + 1];
        if (
            next &&
            /^(?:Questions?\s+\d+\.?)\s+[A-Z]/.test(line.text) &&
            !/[.!?]["')]?$/.test(line.text.trim()) &&
            /^[a-z]/.test(next.text.trim())
        ) {
            defects.midSplit.push({ i, ...line, nextText: next.text });
        }
    });

    // D. 题组播报缺失：1-25 应有 6 组（1-4/5-8/9-11或9-12/12-15/16-18/19-21/22-25），
    //    按听力题号结构检查 "…based on the …" 播报句是否齐（Section C 的 3 组最常缺）
    const groupAnnouncements = t.filter((l) => /based on (the )?(conversation|passage|recording)/i.test(l.text)).length;

    const score = defects.giant.length + defects.fragment.length + defects.midSplit.length;
    if (score >= minScore || groupAnnouncements < 6) {
        report.push({ id: row.id, title: row.title, total: t.length, defects, groupAnnouncements, score });
    }
}
await c.end();

if (report.length === 0) {
    console.log('全部课程切分质量正常。');
    process.exit(0);
}
for (const r of report.sort((a, b) => b.score - a.score)) {
    console.log(`\n[${r.id}] ${r.title} — ${r.total} 句，缺陷分 ${r.score}，题组播报 ${r.groupAnnouncements}/6`);
    for (const g of r.defects.giant.slice(0, 3)) console.log(`  巨句 ${g.start}-${g.end} (${(g.end - g.start).toFixed(0)}s) ${JSON.stringify(g.text.slice(0, 55))}`);
    for (const f of r.defects.fragment.slice(0, 3)) console.log(`  碎片 ${f.start}-${f.end} (${(f.end - f.start).toFixed(1)}s) ${JSON.stringify(f.text.slice(0, 55))}`);
    for (const m of r.defects.midSplit.slice(0, 3)) console.log(`  题干截断 ${JSON.stringify(m.text.slice(0, 55))} → ${JSON.stringify((m.nextText ?? '').slice(0, 40))}`);
}
console.log(`\n建议重建（按缺陷分降序）：${report.map((r) => r.id).join(',')}`);
