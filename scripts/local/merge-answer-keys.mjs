/**
 * 答案采集结果合并器：把 temp/answers-raw/key_*.json（各采集代理的产出）
 * 合成 import-answer-key.mjs 需要的 {课程标题: 答案文本} 文件，
 * 并生成 docs/answer-key-sources.md 来源台账（每套的来源 URL 与核对结论）。
 *
 * 导入策略：仅收录 25/25 齐全且 confidence 非 unclear 的批次；
 * single（单来源）也收录但在台账中标注，便于事后抽查。
 *
 * 用法：node scripts/local/merge-answer-keys.mjs
 * 产出：temp/answers-to-import.json + docs/answer-key-sources.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawDir = path.join(root, 'temp', 'answers-raw');
const outImport = path.join(root, 'temp', 'answers-to-import.json');
const outSources = path.join(root, 'docs', 'answer-key-sources.md');

const importMap = {};
const MONTH_CN = { '03': '3', '06': '6', '07': '7', '09': '9', '12': '12' };

const files = fs.readdirSync(rawDir)
    .filter((f) => /^key_\d{4}[-_]\d{2}[-_]\d+\.json$/.test(f)).sort();
if (files.length === 0) {
    console.error('temp/answers-raw/ 下没有 key_*.json，先运行采集代理。');
    process.exit(1);
}

// 同一批次可能有多份转录（主线程 + 采集代理）：按课程去重，verified 优先。
const RANK = { verified: 2, single: 1, unclear: 0 };
const byTitle = new Map();
let ok = 0;
let skipped = 0;
const sourceLines = [];
for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
    const [year, month] = data.exam.split('-');
    let title = `${year}年${MONTH_CN[month]}月 第${data.set}套`;
    // 2023年3月特殊：三套卷内容相同，库里的课程标题带备注
    if (data.exam === '2023-03') {
        title = '2023年3月 第1套（3套相同）';
    }
    const letters = Array.from({ length: 25 }, (_, i) => data.answers?.[String(i + 1)] ?? null);
    const filled = letters.filter(Boolean).length;
    const problems = [];
    if (filled !== 25) problems.push(`仅 ${filled}/25 题`);
    if (data.confidence === 'unclear') problems.push('confidence=unclear');
    if (problems.length > 0) {
        skipped += 1;
        sourceLines.push(`| ${title} | ⏭ 跳过：${problems.join('，')} | ${data.confidence ?? '-'} | ${(data.sources ?? []).join('；')} | ${data.notes ?? ''} |`);
        continue;
    }
    const existing = byTitle.get(title);
    if (existing) {
        // 双份独立转录：逐题比对，一致则升级为 verified，不一致降级为 unclear 并记录
        const diffs = [];
        for (let i = 1; i <= 25; i += 1) {
            if (existing.answers[String(i)] !== data.answers[String(i)]) diffs.push(i);
        }
        if (diffs.length === 0) {
            existing.confidence = 'verified';
            existing.sources.push(`双份独立转录一致（${file}）`);
            existing.notes = existing.notes ? `${existing.notes}；双转录比对一致` : '双转录比对一致';
        } else {
            existing.confidence = 'unclear';
            existing.notes = `${existing.notes ?? ''}；与 ${file} 在题号 ${diffs.join('、')} 不一致，需人工复核`.trim();
        }
        continue;
    }
    byTitle.set(title, { ...data, title, letters });
}

for (const data of byTitle.values()) {
    const { title, letters } = data;
    if (data.confidence === 'unclear') {
        skipped += 1;
        sourceLines.push(`| ${title} | ⏭ 跳过：转录冲突/不确定 | ${data.confidence} | ${(data.sources ?? []).join('；')} | ${data.notes ?? ''} |`);
        continue;
    }
    importMap[title] = letters.map((letter, i) => `${i + 1}. ${letter}`).join(' ');
    ok += 1;
    sourceLines.push(`| ${title} | ✅ 已导入 | ${data.confidence} | ${(data.sources ?? []).join('；')} | ${data.notes ?? ''} |`);
}

fs.writeFileSync(outImport, `${JSON.stringify(importMap, null, 1)}\n`);
const md = [
    '# 六级听力答案钥匙来源台账',
    '',
    '> 采集方式：wehuster 真题解析 PDF（视觉转录）+ 网上第二来源交叉核对。',
    '> verified = 双来源一致；single = 仅单一来源（可信但建议抽查）；unclear = 读取困难，未导入。',
    '',
    '| 课程 | 状态 | 核对 | 来源 | 备注 |',
    '| --- | --- | --- | --- | --- |',
    ...sourceLines,
    '',
].join('\n');
fs.writeFileSync(outSources, md, 'utf8');

console.log(`合并完成：导入 ${ok} 门，跳过 ${skipped} 门。`);
console.log(`  导入文件：${outImport}`);
console.log(`  来源台账：${outSources}`);
