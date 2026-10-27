/**
 * 正文/题干漏句补行（2026-10-27 追加轮③收尾）：六级十套 whisper 漏转写的 24 段。
 * 文本来源：官方原文对号（滑窗子句对齐）为 20 段；#62 两段音频版本与原文不同，
 * 忠实音频（整段听证转写）；Directions 中段 4 段用标准模板。
 * 译文为本次新增学习句配套（考试直译风格）。
 * 用法：--dry / --apply
 */
import fs from 'node:fs'
import { connect, saveTranscript } from '../audit/data-contract.mjs'

const APPLY = process.argv.includes('--apply')
// {cid, t(段起点), text, zh}——end 取所在岛尾，脚本内算
const ITEMS = [
  { cid: 53, t: 990.4, text: 'Good transportation networks, and eager customers.', zh: '便利的交通网络，和充满渴望的顾客。' },
  { cid: 54, t: 519.1, text: 'Yet even as they mourned Willy, says Herzog.', zh: '赫尔佐格说，就在人们哀悼威利的同时。' },
  { cid: 54, t: 529.5, text: 'With the bare change in labels from "pet" to "pest".', zh: '随着标签从"宠物"到"害虫"的微小变化。' },
  { cid: 54, t: 705, text: 'Each generates heat and light to dwarf the Consolidated Edison Company.', zh: '每一座都发光发热，令爱迪生联合电气公司相形见绌。' },
  { cid: 54, t: 1179, text: 'If they are to acquire aural language.', zh: '如果他们要习得有声语言的话。' },
  { cid: 54, t: 1191.8, text: 'Although the words themselves are beyond their understanding.', zh: '尽管这些词本身超出了他们的理解力。' },
  { cid: 55, t: 152.8, text: 'What does the man say about the job in the States?', zh: '男士对在美国的那份工作说了什么？' },
  { cid: 55, t: 572, text: 'What does the passage say about the international coffee institute?', zh: '关于国际咖啡协会，短文说了什么？' },
  { cid: 55, t: 1209.7, text: 'Seventy-five percent of them go on to die from secondary cancers.', zh: '其中 75% 会接着死于继发性癌症。' },
  { cid: 55, t: 1230.7, text: 'Professor Seymour hopes that one day it will be applied to all cancers.', zh: '西摩教授希望有一天它能应用于所有癌症。' },
  { cid: 55, t: 1441.7, text: 'HarperCollins says it took the action to protect the growing e-book industry.', zh: '哈珀柯林斯说，此举是为了保护不断增长的电子书产业。' },
  { cid: 56, t: 533.8, text: 'I\'m not against elitism, but I happen to like having people who are more eager to learn.', zh: '我不反对精英主义，只是我恰好喜欢有更强学习意愿的人。' },
  { cid: 57, t: 748.8, text: 'Before a final choice is made, prior to a national campaign.', zh: '在作出最终选择之前，也就是在全国范围展开之前。' },
  { cid: 57, t: 1600.3, text: 'And analyzing the difficulties you are having with a situation or a person.', zh: '并分析你在某个处境或某个人身上遇到的困难。' },
  { cid: 58, t: 543.8, text: 'We\'re no longer living together at the end of the semester.', zh: '到学期末，我们就不再住在一起了。' },
  { cid: 58, t: 741.1, text: 'There\'s an unpleasant factor when people find out meat is grown in a lab.', zh: '当人们发现肉是实验室里培养出来的，会有不适的因素。' },
  { cid: 60, t: 26.2, text: 'After you hear a question, you must choose the best answer from the four choices marked A, B, C and D.', zh: '' },
  { cid: 59, t: 603.2, text: 'What is the International Labor Organization\'s report mainly about?', zh: '国际劳工组织的报告主要关于什么？' },
  { cid: 60, t: 614.8, text: 'What is the long-held view about mothers\' sleeping with new-born babies?', zh: '关于母亲与新生儿同睡，长期以来的主流看法是什么？' },
  { cid: 60, t: 786.9, text: 'Accelerating the extinction of native languages.', zh: '加速了本土语言的消亡。' },
  { cid: 60, t: 1566, text: 'Published in the Proceedings of the National Academy of Sciences.', zh: '发表于《美国国家科学院院刊》。' },
  { cid: 61, t: 745.3, text: 'Then consider what else she could buy with the same money.', zh: '然后想想用同样的钱她还能买些什么。' },
  { cid: 62, t: 463.4, text: 'After you hear a question, you must choose the best answer from the four choices marked A, B, C and D.', zh: '' },
  { cid: 62, t: 806.6, text: 'Eighteen thousand four hundred and thirty-four centenarians died in two thousand.', zh: '18344 名百岁老人死于 2000 年，' },
  { cid: 62, t: 812.1, text: 'Whereas twenty-five thousand nine hundred and fourteen died in two thousand and five.', zh: '而 25914 人死于 2005 年。' },
]

const conn = await connect()
const [rows] = await conn.query('select id, category_id, audio_object_name, transcript_json from exercises where id between 53 and 62')
const seedOf = (cat) => (cat === 9 ? 'presets/cet4/seed.json' : 'presets/cet6/seed.json')
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const todayPrefix = `${today}.`
const nextVersionOf = new Map()
let totalAdd = 0, ok = 0, failed = 0

// 按课分组执行
const byCid = new Map()
for (const it of ITEMS) { if (!byCid.has(it.cid)) byCid.set(it.cid, []); byCid.get(it.cid).push(it) }

for (const row of rows) {
  const items = byCid.get(row.id)
  if (!items) continue
  const lines = (typeof row.transcript_json === 'string' ? JSON.parse(row.transcript_json) : row.transcript_json).map((l) => ({ ...l }))
  const islands = JSON.parse(fs.readFileSync(`temp/anchor-islands/${row.id}.json`, 'utf8')).islands
  const log = []
  let added = 0
  for (const it of items) {
    // DB 现状覆盖检查（听感轮可能已补过同段）
    if (lines.some((l) => l.start < it.t + 0.4 && l.end > it.t - 0.4)) { log.push(`@${it.t} 已覆盖跳过`); continue }
    const is = islands.find(([a, b]) => it.t > a - 1.5 && it.t < b)
    const end = is ? Math.min(+is[1].toFixed(2), it.t + 30) : it.t + 3
    const idx = lines.findIndex((l) => l.start > it.t)
    lines.splice(idx < 0 ? lines.length : idx, 0, { id: 'new', start: it.t, end, text: it.text, ...(it.zh ? { translation: it.zh } : {}) })
    log.push(`@${it.t}「${it.text.slice(0, 36)}…」`)
    added++
  }
  if (!added) continue
  lines.sort((a, b) => a.start - b.start)
  lines.forEach((l, i) => { l.id = `l${i + 1}` })
  const needOf = (l) => Math.min(Math.max((String(l.text).match(/[A-Za-z0-9']+/g) || []).filter((w) => w.length >= 2).length * 0.28, 0.3), 20)
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], l = lines[i]
    if (l.start < p.end - 0.001) {
      if (l.start - p.start >= Math.max(0.18, needOf(p) * 0.35 + 0.2)) p.end = +l.start.toFixed(2)
      else l.start = +p.end.toFixed(2)
    }
    if (l.end <= l.start) l.end = +(l.start + 0.3).toFixed(2)
  }
  totalAdd += added
  console.log(`#${row.id}: ${log.join('；')}`)
  if (!APPLY) continue
  const seedPath = seedOf(row.category_id)
  if (!nextVersionOf.has(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
    nextVersionOf.set(seedPath, seed.version.startsWith(todayPrefix)
      ? `${todayPrefix}${Number(seed.version.slice(todayPrefix.length)) + 1}` : `${todayPrefix}1`)
  }
  try {
    await saveTranscript({ conn, cid: row.id, lines, version: nextVersionOf.get(seedPath), seedPath,
      expect: { lineDelta: [0, added], allowUntranslatedGrow: true, note: `正文/题干漏句补行 ${added}（原文对号+译文）` }, dryRun: false })
    ok++
  } catch (e) { failed++; console.error(`✗ #${row.id} ${e.message}`) }
}
console.log(`\n══ 补行 ${totalAdd}；落库 ${ok} / 失败 ${failed}（${APPLY ? 'APPLY' : 'DRY'}）══`)
await conn.end()
