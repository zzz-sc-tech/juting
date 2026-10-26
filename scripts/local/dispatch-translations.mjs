/**
 * 批量翻译调度器（2026-10-26 立，沉淀自译文补全轮的两次翻车：16 并发撞 1302 限频、
 * 手工派发漏批次）。
 *
 * 三段式：
 *   1. 盘点缺口：task-{cid}.json 的 need 行 vs out-{cid}.json 已产出；
 *   2. 生成批次计划：每批 ≤--batch 门（默认 3——实测 16 并发必撞限频），产出
 *      batch-{n}-prompt.txt（可直接粘给会话内 Agent 工具或 zcode CLI）；
 *   3. --exec：用 zcode CLI 逐批串行执行（默认 dry 只出计划）。
 *
 * 用法：
 *   node scripts/local/dispatch-translations.mjs                     # 盘点+出计划
 *   node scripts/local/dispatch-translations.mjs --exec              # 按计划执行
 *   选项：--tasks-dir temp/translations --batch 3 --timeout-min 30
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tasksDir = argOf('--tasks-dir') ?? 'temp/translations';
const BATCH = Number(argOf('--batch') ?? 3);
const TIMEOUT_MIN = Number(argOf('--timeout-min') ?? 30);
const EXEC = process.argv.includes('--exec');
function argOf(k) { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; }

// ── 1. 盘点 ──
const tasks = fs.readdirSync(tasksDir).filter((f) => /^task-\d+\.json$/.test(f)).sort();
const missing = [], complete = [];
for (const f of tasks) {
    const cid = f.match(/^task-(\d+)\.json$/)[1];
    const task = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
    const need = new Set(task.lines.filter((l) => l.need).map((l) => l.id));
    if (!need.size) { complete.push({ cid, n: 0 }); continue; }
    const of = path.join(tasksDir, `out-${cid}.json`);
    let ok = false;
    if (fs.existsSync(of)) {
        try {
            const outs = JSON.parse(fs.readFileSync(of, 'utf8'));
            ok = outs.length === need.size && outs.every((o) => need.has(o.id) && String(o.translation ?? '').trim());
        } catch { ok = false; }
    }
    (ok ? complete : missing).push({ cid, n: need.size });
}
console.log(`[dispatch] 已完成 ${complete.length} 门；缺口 ${missing.length} 门 / ${missing.reduce((s, x) => s + x.n, 0)} 句`);
if (!missing.length) { console.log('[dispatch] 无缺口，收工'); process.exit(0); }

// ── 2. 批次计划 + 提示词 ──
const batches = [];
for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
const promptFor = (group) => `你是大学英语四/六级听力真题的中文译者。任务：把 ${group.length} 门课的未译字幕行全部译成简体中文。

依次处理这些任务文件（每份结构：{cid, title, preset, lines:[{id, text, need:true} | {id, text, translation, need:false}]}，只译 need:true 的行；need:false 行带现有译文，是风格与术语参考）：
${group.map((x) => path.resolve(tasksDir, `task-${x.cid}.json`)).join('\n')}

翻译规则（严格遵守）：
1. 行首 "M: " / "W: " 说话人前缀原样保留，只译后面内容；
2. 行首 "Q3. " / "Question 3: " 题号标签原样保留，只译题干正文；
3. 考试听力直译风格：简洁书面语、不意译扩写；人名地名用通用译名（无通用译名保留英文）；
4. 专有名词参照同文件 need:false 行已有译法；无先例的常见者用通用译名，否则保留英文；
5. 数字用阿拉伯数字；金额/时间单位照译（dollars→美元）。

每门课的输出写到 ${path.resolve(tasksDir, 'out-{cid}.json').replace('{cid}', '对应课程号')}：
JSON 数组 [{"id":"l123","translation":"……"}]，覆盖该课全部 need:true 行，一条不漏一条不多，无注释无 markdown。

完成后回复一行：${group.length} 门共完成 N 条。`;

batches.forEach((group, i) => {
    const pf = path.join(tasksDir, `batch-${i + 1}-prompt.txt`);
    fs.writeFileSync(pf, promptFor(group));
    console.log(`  批 ${i + 1}: ${group.map((x) => x.cid + '(' + x.n + ')').join(' ')} → ${pf}`);
});

// ── 3. 执行（zcode CLI 串行，批间天然限频） ──
if (EXEC) {
    let zcode;
    try { execFileSync('zcode', ['--version'], { stdio: 'ignore' }); zcode = 'zcode'; } catch {
        console.error('[dispatch] ✗ zcode CLI 不可用——拿上面的 batch-*-prompt.txt 在会话内用 Agent 工具派发');
        process.exit(1);
    }
    for (let i = 0; i < batches.length; i++) {
        console.log(`[dispatch] 执行批 ${i + 1}/${batches.length}…`);
        try {
            execFileSync(zcode, ['-p', fs.readFileSync(path.join(tasksDir, `batch-${i + 1}-prompt.txt`), 'utf8')],
                { stdio: 'inherit', timeout: TIMEOUT_MIN * 60000 });
        } catch (e) {
            console.error(`[dispatch] ⚠ 批 ${i + 1} 异常（${e.message.slice(0, 80)}）——产出以盘点为准，重跑本脚本自动跳过已完成`);
        }
    }
    console.log('[dispatch] 执行完毕——重跑本脚本（不带 --exec）复核缺口');
}
