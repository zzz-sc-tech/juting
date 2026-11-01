/**
 * cet4 题干指针重建（seed 级，离线）：presets/cet4/seed.json 的
 * questions_json[].stemLineId 按字幕文本重新指向同号「Question N.」播报行。
 *
 * 背景（2026-11-01 确认）：四级字幕在 10-15~10-25 重建战役（f619b7e 全量重建等）
 * 后行 id 全部重排，questions_json 里的指针没人跟着重映射——v20261014.50 时
 * 1160/1225 正确，重建后只剩 16/1225（与接手方修的六级题干错位同病、四级版）。
 * 当前字幕里 1216/1225 题有同号播报行，文本匹配即可重指；其余 9 题音频没念
 * 题干，保留现指针（落在材料区，语义可接受）。
 *
 * 与 scripts/content/rebuild-question-stems.mjs（DB 版）同口径；本脚本直接改
 * seed 文件，不需要起数据库。幂等：已指向正确行的题不动。
 *
 * 用法：node scripts/content/rebuild-cet4-stems-seed.mjs [--apply]
 *   默认 dry（只打印报告），--apply 才写回。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.join(root, 'presets', 'cet4', 'seed.json');

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const LABEL = /^(?:question|q)\s*\.?\s*(\d{1,2}|[a-z-]+)\b/i;

const questionNo = (text) => {
  const match = LABEL.exec(String(text).trim());
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const value = /^\d+$/.test(raw) ? Number(raw) : WORDS[raw];
  return value >= 1 && value <= 25 ? value : null;
};
const parse = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw);

const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
let changedCourses = 0;
let changedQuestions = 0;
let alreadyOk = 0;
let fallback = 0;

for (const exercise of seed.exercises) {
  const questions = parse(exercise.questions_json);
  if (!Array.isArray(questions) || questions.length === 0) continue;
  const index = new Map();
  for (const line of exercise.transcript_json) {
    const n = questionNo(line.text);
    if (n !== null && !index.has(n)) index.set(n, line.id);
  }

  let touched = 0;
  const next = questions.map((question) => {
    const lineId = index.get(Number(question.n));
    if (!lineId) {
      fallback += 1;
      return question;
    }
    if (lineId === question.stemLineId) {
      alreadyOk += 1;
      return question;
    }
    touched += 1;
    return { ...question, stemLineId: lineId };
  });
  if (touched === 0) continue;

  console.log(`${exercise.id}\t${exercise.title ?? ''}\t改 ${touched}/${questions.length}`);
  changedCourses += 1;
  changedQuestions += touched;
  exercise.questions_json = JSON.stringify(next);
}

console.log(
  `\n合计：改 ${changedQuestions} 条（${changedCourses} 门）｜已正确 ${alreadyOk}｜无播报行保持 ${fallback}`,
);

if (!APPLY) {
  console.log('（dry 预览，--apply 写回）');
  process.exit(0);
}

seed.version = '20261101.1';
seed.generatedAt = new Date().toISOString();
fs.writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
console.log(`已写回 ${file}（version → ${seed.version}）`);
