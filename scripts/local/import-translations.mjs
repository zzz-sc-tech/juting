/**
 * 译文导入器：把 temp/translations/tl_<id>.json（{"原英文":"中文译文"}）
 * 合并进对应课程字幕的 translation 字段。
 *
 * 匹配策略（两级）：先按原文精确匹配，失败再按归一化文本（小写+空白折叠）
 * 匹配；两极都 miss 的句子保留空译文并在报告中列出。
 *
 * 用法：node scripts/local/import-translations.mjs [--apply]
 * 导入后需重导 preset（seed 含 translation 字段）并重启后端不需要（字幕实时读库）。
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

const tlDir = path.join(root, 'temp', 'translations');
const files = fs.readdirSync(tlDir).filter((f) => /^tl_\d+\.json$/.test(f));
if (files.length === 0) {
    console.error('temp/translations/ 下没有 tl_<id>.json');
    process.exit(1);
}

const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

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

let totalLines = 0;
let totalMatched = 0;
const report = [];
for (const file of files) {
    const id = Number(file.match(/tl_(\d+)\.json/)[1]);
    const dict = JSON.parse(fs.readFileSync(path.join(tlDir, file), 'utf8'));
    const exactMap = new Map(Object.entries(dict));
    const normMap = new Map(Object.entries(dict).map(([k, v]) => [normalize(k), v]));

    const [rows] = await c.query('select transcript_json, title from exercises where id = ?', [id]);
    if (rows.length === 0) {
        console.error(`⚠ 课程 ${id} 不存在（跳过 ${file}）`);
        continue;
    }
    const transcript = typeof rows[0].transcript_json === 'string'
        ? JSON.parse(rows[0].transcript_json)
        : rows[0].transcript_json;

    let matched = 0;
    const missed = [];
    for (const line of transcript) {
        const text = String(line.text ?? '');
        let zh = exactMap.get(text) ?? null;
        if (zh == null) zh = normMap.get(normalize(text)) ?? null;
        if (zh != null && zh.trim()) {
            line.translation = zh;
            matched += 1;
        } else {
            missed.push(text);
        }
    }
    totalLines += transcript.length;
    totalMatched += matched;
    report.push({ id, title: rows[0].title, total: transcript.length, matched, missed });
    console.log(`[${id}] ${rows[0].title}: ${matched}/${transcript.length} 句有译文`);

    if (APPLY) {
        await c.query('update exercises set transcript_json = ? where id = ?',
            [JSON.stringify(transcript), id]);
    }
}
await c.end();

const missedSamples = report.flatMap((r) => r.missed.slice(0, 3).map((m) => `[${r.id}] ${m.slice(0, 60)}`));
console.log(`\n合计：${totalMatched}/${totalLines} 句（覆盖率 ${(totalMatched / totalLines * 100).toFixed(1)}%）`);
if (missedSamples.length > 0) {
    console.log('未匹配样例：');
    missedSamples.slice(0, 10).forEach((m) => console.log('  ' + m));
}
if (!APPLY) console.log('[dry-run] 未写库，加 --apply 生效。');
