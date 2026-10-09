// UI序号 → seed 行 id 反查工具（报障定位用）
// 用法: node ui2line.mjs <课号> <界面序号> [<界面序号2> ...]
// 界面序号 = 学习端句列表/字幕角标显示的 1-based 可见序号（指令句已隐藏）
const { extractDialogueAnchors } = require('../../packages/domain/dist/dialogueAnchors.js');
const seed = require('../../presets/cet6/seed.json');

const [, , cidArg, ...nums] = process.argv;
if (!cidArg || !nums.length) {
  console.error('用法: node ui2line.mjs <课号> <界面序号> [序号2 ...]  例: node ui2line.mjs 14 111');
  process.exit(1);
}
const cid = Number(cidArg);
const ex = seed.exercises.find(e => e.id === cid);
if (!ex) { console.error(`课 ${cid} 不存在`); process.exit(1); }
const anchors = extractDialogueAnchors(ex.transcript_json);
const consumed = new Set(anchors.flatMap(a => a.lineIds));
const visible = ex.transcript_json.filter(l => !consumed.has(l.id));
const all = ex.transcript_json;
console.log(`课${cid} ${ex.title}: 总行 ${all.length}, 指令行 ${consumed.size}, 可见行 ${visible.length}`);
for (const n of nums) {
  const i = Number(n) - 1;
  if (i < 0 || i >= visible.length) { console.log(`UI ${n}: 超出范围`); continue; }
  const line = visible[i];
  const pos = all.findIndex(l => l.id === line.id) + 1;
  const instrBefore = all.slice(0, pos - 1).filter(l => consumed.has(l.id)).length;
  console.log(`UI ${n} -> seed ${line.id} (数组位 ${pos}, 前方指令行 ${instrBefore})`);
  console.log(`   [${line.start.toFixed(2)}, ${line.end.toFixed(2)}] ${line.text.slice(0, 100)}`);
}
