/**
 * 真题答案钥匙导入器：把文本格式的听力答案解析成题号→字母映射，写入课程。
 *
 * 支持的答案文本格式（可混用，顺序无所谓）：
 *   1-5 ACBDA 6-10 BCADB          （区间 + 连续字母，出版答案最常见的写法）
 *   1. A  2. C  3. B              （逐题写法）
 *   16-25 A C B D A ...           （区间内字母用空格分隔也可以）
 *
 * 输入文件（--file）为 JSON：{ "课程标题或课程ID": "答案文本", ... }。
 * 课程匹配：纯数字按课程 ID 匹配，否则按课程标题精确匹配。
 *
 * 默认 dry-run 只打印解析结果；确认无误后加 --apply 写库。
 * 写库走 updateExerciseAnswerKey 的同一套清洗规则（1-25 题号、A-D 字母），
 * 脏数据会被丢弃并告警。
 *
 * 用法：node scripts/local/import-answer-key.mjs --file temp/answers.json [--apply]
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const argOf = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
};
const apply = process.argv.includes('--apply');
const file = argOf('--file');
if (!file) {
    console.error('用法：node scripts/local/import-answer-key.mjs --file <answers.json> [--apply]');
    process.exit(1);
}
const entries = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

// ── 解析答案文本 ────────────────────────────────────────────
/**
 * 把一段答案文本解析成 { 题号: 字母 }。两种写法可混用：
 * 区间式 "1-5 ACBDA"（字母间允许空白）、逐题式 "1. A"。
 * 解析不了的片段原样收进 problems，由调用方决定是否报错。
 */
export const parseAnswerText = (text) => {
    const normalized = String(text).toUpperCase().replace(/[，、]/g, ',');
    const key = {};
    const problems = [];

    // 区间式：1-5 ACBDA / 16–20 A C B D A
    const rangePattern = /(\d{1,2})\s*[-–—~至]\s*(\d{1,2})\s*[:：]?\s*((?:[A-D][\s,]*){2,})/g;
    for (const match of normalized.matchAll(rangePattern)) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        const letters = match[3].replace(/[^A-D]/g, '');
        if (!(start >= 1 && end >= start && end <= 25 && end - start + 1 === letters.length)) {
            problems.push(`区间不匹配: "${match[0].trim()}"（${letters.length} 个字母对 ${start}-${end}）`);
            continue;
        }
        for (let n = start; n <= end; n += 1) {
            key[n] = letters[n - start];
        }
    }

    // 逐题式：1. A / 2、C —— 题号后必须带分隔符，不会与区间式 "5 ACBDA" 的字母打架
    const singlePattern = /(\d{1,2})\s*[.、．:：)]\s*([A-D])(?![A-D])/g;
    for (const match of normalized.matchAll(singlePattern)) {
        const n = Number(match[1]);
        if (!(n >= 1 && n <= 25)) continue;
        key[n] = match[2];
    }

    return { key, problems };
};

// ── 主流程 ─────────────────────────────────────────────────
const envFile = [path.join(repositoryRoot, 'temp', 'runtime', 'portable.env'),
    path.join(repositoryRoot, 'backend', '.env'), path.join(repositoryRoot, '.env')]
    .find((candidate) => fs.existsSync(candidate));
const fileEnvironment = {};
dotenv.config({ path: envFile, processEnv: fileEnvironment, quiet: true });
const environment = { ...fileEnvironment, ...process.env };

const connection = await mysql.createConnection({
    host: (environment.MYSQL_HOST || '127.0.0.1').trim(),
    port: Number(environment.MYSQL_PORT || '3306'),
    user: (environment.MYSQL_USER || environment.MYSQL_USERNAME || 'root').trim(),
    password: environment.MYSQL_PASSWORD || '',
    database: (environment.MYSQL_DATABASE || 'duolinting_app_dev').trim(),
});

const [courses] = await connection.query('select id, title, answer_key_json from exercises');
const byTitle = new Map(courses.map((row) => [row.title, row]));
const byId = new Map(courses.map((row) => [String(row.id), row]));

let pending = 0;
const parsed = [];
for (const [courseRef, text] of Object.entries(entries)) {
    const course = /^\d+$/.test(courseRef) ? byId.get(courseRef) : byTitle.get(courseRef);
    if (!course) {
        console.error(`⚠ 找不到课程：${courseRef}`);
        pending += 1;
        continue;
    }
    const { key, problems } = parseAnswerText(text);
    const count = Object.keys(key).length;
    if (count === 0) {
        console.error(`⚠ ${course.title}：一个答案都没解析出来，原文：${String(text).slice(0, 80)}`);
        pending += 1;
        continue;
    }
    if (count !== 25) {
        console.error(`⚠ ${course.title}：只解析出 ${count}/25 题${problems.length ? '；' + problems.join('；') : ''}`);
        pending += 1;
    }
    parsed.push({ course, key, text });
}

console.log(`\n解析完成：${parsed.length} 门课待写入，${pending} 门有问题需处理。`);
for (const { course, key } of parsed) {
    const summary = Array.from({ length: 25 }, (_, i) => key[i + 1] ?? '·').join('');
    console.log(`  [${course.id}] ${course.title} → ${summary}${course.answer_key_json ? '（已有旧答案，将被覆盖）' : ''}`);
}

if (!apply) {
    console.log('\n[dry-run] 未写库。确认无误后加 --apply 重新运行。');
    await connection.end();
    process.exit(pending > 0 ? 2 : 0);
}

for (const { course, key } of parsed) {
    await connection.query('update exercises set answer_key_json = ? where id = ?',
        [JSON.stringify(key), course.id]);
}
console.log(`\n[apply] 已写入 ${parsed.length} 门课。`);
await connection.end();
process.exit(pending > 0 ? 2 : 0);
