// 生成「点词查词典」用的精简内置词典：只收录本库 38 课转写出现的词，
// 但每个词条保留完整信息（音标/词性/中文释义/考试标签 + 本库语境例句）。
// 用法：node scripts/content/gen-vocab-dict.mjs [ecdict.csv 路径]
//   csv 默认 temp/ecdict.csv，可用 ECDICT_CSV 环境变量或首个参数覆盖。
//   完整 csv 约 77 万行 / 63MB（raw.githubusercontent.com 直连不通时走
//   ghproxy.net 代理 + curl -C - 断点续传，见 temp/dl-ecdict.sh）。
// 数据源：ECDICT（MIT，skywind3000）+ presets/cet6/seed.json（本库语料）。
// 输出：web-app/src/lib/generated/vocabDict.ts（构建产物，进 git；
//   seed 或 ECDICT 更新后重跑本脚本，勿手改生成文件）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const csvPath = path.resolve(
  process.argv[2] ?? process.env.ECDICT_CSV ?? path.join(root, 'temp/ecdict.csv'),
)
const seedPath = path.join(root, 'presets/cet6/seed.json')
// cet4 也要收：词典按「本库出现的词」生成，只读 cet6 会让四级语料有 37% 的词查不到释义
const seedPaths = [seedPath, path.join(root, 'presets/cet4/seed.json')]
const outPath = path.join(root, 'web-app/src/lib/generated/vocabDict.ts')

/** 每个词条最多保留几条本库语境（例句多了体积膨胀，展示也戴不下） */
const MAX_CTX = 6

// ─────────────────────────────────────────────────────────────
// 1. 读本库语料：词形集合 + 每个词形出现在哪些课的哪些句
//    （分词规则与 gen-dictation-vocab.mjs 完全一致：小写 + 连字符/撇号保留）
// ─────────────────────────────────────────────────────────────
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
const formSet = new Set()
/** @type {Map<string, Array<[number, string]>>} 词形 → [课id, 行id][] */
const formOccurrences = new Map()
// 合并 cet6 + cet4 的语料（课程 id 在两库间不重叠，可安全合并）
const allExercises = seedPaths.flatMap((p) => JSON.parse(fs.readFileSync(p, 'utf8')).exercises)
for (const ex of allExercises) {
  for (const line of ex.transcript_json) {
    for (const raw of line.text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []) {
      formSet.add(raw)
      const list = formOccurrences.get(raw)
      if (list) {
        if (list.length < 64) list.push([ex.id, line.id])
      } else {
        formOccurrences.set(raw, [[ex.id, line.id]])
      }
    }
  }
}
console.log(`[seed] ${allExercises.length} 课（cet6+cet4），唯一词形 ${formSet.size} 个`)

// ─────────────────────────────────────────────────────────────
// 2. 启发式词形还原候选（仅用于「哪些行可能要保留」与兜底解析；
//    精确还原靠 ECDICT exchange 字段，见第 3 步）
// ─────────────────────────────────────────────────────────────
const heuristicCandidates = (form) => {
  const out = [form]
  const add = (s) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s)
  }
  if (form.endsWith('ies') && form.length > 4) add(form.slice(0, -3) + 'y') // studies→study
  if (form.endsWith('es') && form.length > 3) {
    add(form.slice(0, -2)) // boxes→box / watches→watch
    add(form.slice(0, -1)) // goes→goe（多数不命中，无害）
  } else if (form.endsWith('s') && !form.endsWith('ss') && form.length > 2) {
    add(form.slice(0, -1)) // cats→cat
  }
  if (form.endsWith('ied') && form.length > 4) add(form.slice(0, -3) + 'y') // studied→study
  if (form.endsWith('ed') && form.length > 3) {
    add(form.slice(0, -1)) // hoped→hope / walked→walke
    const doubled = form.match(/^(.*[bcdfglmnprstz])\1ed$/) // stopped→stop
    if (doubled) add(doubled[1])
    add(form.slice(0, -2)) // walked→walk / filled→fill
  }
  if (form.endsWith('ing') && form.length > 4) {
    add(form.slice(0, -3) + 'e') // hoping→hope / making→make
    const doubled = form.match(/^(.*[bcdfglmnprstz])\1ing$/) // running→run
    if (doubled) add(doubled[1])
    add(form.slice(0, -3)) // walking→walk
  }
  if (form.endsWith('ly') && form.length > 3) add(form.slice(0, -2)) // quickly→quick
  if (form.endsWith('er') && form.length > 3) add(form.slice(0, -2)) // faster→fast
  if (form.endsWith('est') && form.length > 4) add(form.slice(0, -3)) // fastest→fast
  return out
}

// exchange 字段（ECDICT 自带词形表）→ 逆映射：变形 → 头词。
// 例 "abandon" 行：d:abandoned/p:abandoned/i:abandoning/3:abandons
//     "go" 行：i:going/p:went/d:gone/3:goes（p=过去式，d=过去分词）
// ECDICT 里只有复数/时态/比较级这几类变形指向明确；0/1 是「词形变体」，
// 方向不可靠（colleges 行会通过它把 college 指到 colleges），不参与逆映射。
const EXCHANGE_TYPES = new Set(['p', 'd', 'i', '3', 's', 'r', 't'])

// ─────────────────────────────────────────────────────────────
// 3. 扫 ECDICT csv：只保留两类行——
//    a. 行首词本身是候选词（词形或其启发式还原）；
//    b. 行的 exchange 里出现了本库词形（精确还原来源）。
// ─────────────────────────────────────────────────────────────
const candidateWords = new Set()
for (const form of formSet) {
  for (const c of heuristicCandidates(form)) candidateWords.add(c)
}

/** @type {Map<string, {ph:string; pos:string; zh:string; tag:string; score:number}>} */
const rows = new Map()
/** @type {Map<string, string>} 变形 → 头词（exchange 逆映射） */
const exchangeMap = new Map()
let csvLines = 0

/** RFC4180 状态机：处理引号包裹字段内的逗号/换行/"" 转义。 */
function* parseCsv(text) {
  let field = ''
  let record = []
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      record.push(field)
      field = ''
    } else if (ch === '\n') {
      record.push(field)
      yield record
      record = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field || record.length) {
    record.push(field)
    yield record
  }
}

const richness = (r) =>
  (r[1] ? 2 : 0) + (r[3] ? 2 : 0) + (r[9] === '1' ? 1 : 0) + (r[6] === '1' ? 1 : 0)

const csvText = fs.readFileSync(csvPath, 'utf8')
for (const record of parseCsv(csvText)) {
  csvLines += 1
  if (csvLines === 1) continue // 表头
  const word = record[0]?.toLowerCase()
  if (!word) continue
  const keepRow = candidateWords.has(word)
  let exchangeHitsForm = false
  const exchange = record[10]
  if (exchange) {
    for (const token of exchange.split('/')) {
      const idx = token.indexOf(':')
      if (idx <= 0) continue
      if (!EXCHANGE_TYPES.has(token.slice(0, idx))) continue
      const form = token.slice(idx + 1).toLowerCase()
      if (formSet.has(form)) {
        exchangeHitsForm = true
        if (!exchangeMap.has(form)) exchangeMap.set(form, word)
      }
    }
  }
  if (!keepRow && !exchangeHitsForm) continue
  const entry = {
    ph: record[1] ?? '',
    zh: record[3] ?? '',
    tag: record[7] ?? '',
    score: richness(record),
  }
  const existing = rows.get(word)
  if (!existing || entry.score > existing.score) rows.set(word, entry)
}
console.log(`[csv] 解析 ${csvLines - 1} 行；命中保留 ${rows.size} 行，exchange 逆映射 ${exchangeMap.size} 条`)

// ─────────────────────────────────────────────────────────────
// 4. 解析每个词形 → 头词。
//    优先用词形自己的词条；但 ECDICT 里大量变形词条只是交叉引用桩
//    （"studies" → n. 研究；学习；学业（study的复数）、"children" → pl. 孩子），
//    这种桩对学习者没用，升级到词元的完整词条更好。
// ─────────────────────────────────────────────────────────────
/**
 * 交叉引用桩：只有指路语（「（college复数形式）」「（study的复数）」「见 xxx」），
 * 学习者看了等于没看。另有「无音标且释义极短」的薄条目同样不值得留。
 * 注意别用「释义字数少」一刀切——「n. 学院, 大学, 学会」才 10 个字符却是好词条。
 */
const STUB_RE = /(复数|单数|过去式|过去分词|现在分词|比较级|最高级)形式|的(复数|单数|过去式|过去分词|现在分词|比较级|最高级)|见\s|^[a-z]{1,4}\.\s*$/
const isStub = (row) =>
  !row ||
  !row.zh ||
  STUB_RE.test(row.zh) ||
  (!row.ph && row.zh.replace(/\s+/g, '').length < 8)

/** @type {Map<string, string>} 词形 → 头词 */
const formToHead = new Map()
const missed = []

/**
 * 复合词/所有格的词根候选：
 *   company's → company；apple's → apple；four-inch → inch / four
 * 这些形态在 ECDICT 里通常没有独立词条，但学习者点它们时想知道的是词根本义。
 */
const rootCandidates = (form) => {
  const out = []
  // 所有格：xxx's / xxxs'
  const poss = form.match(/^([a-z][a-z'-]*)['’]s?$/)
  if (poss) out.push(poss[1])
  // 连字符复合词：逐段拆，取最长且 ≥3 字符的段
  if (form.includes('-')) {
    const segs = form.split('-').filter((s) => s.length >= 3)
    segs.sort((a, b) => b.length - a.length)
    out.push(...segs)
  }
  // 去掉结尾多余单引号
  const bare = form.replace(/['’]+$/, '')
  if (bare !== form && bare.length >= 3) out.push(bare)
  return [...new Set(out)].filter((c) => c !== form)
}

for (const form of [...formSet].sort()) {
  const direct = rows.get(form)
  const viaExchange = exchangeMap.get(form)
  const viaHeuristic = heuristicCandidates(form).find(
    (cand) => cand !== form && rows.has(cand),
  )
  if (direct && !isStub(direct)) {
    formToHead.set(form, form)
    continue
  }
  const head = (viaExchange && rows.has(viaExchange) ? viaExchange : undefined) ?? viaHeuristic
  if (head) {
    formToHead.set(form, head)
    continue
  }
  if (direct) {
    formToHead.set(form, form)
    continue
  }
  // 复合词/所有格：回退到词根（词根本身有完整词条才算）
  const root = rootCandidates(form).find((c) => {
    const row = rows.get(c)
    return row && !isStub(row)
  })
  if (root) {
    formToHead.set(form, root)
    continue
  }
  missed.push(form)
}

// ─────────────────────────────────────────────────────────────
// 5. 汇总词条：头词 → 完整信息 + 本库语境（按头词聚合所有词形的出现）
// ─────────────────────────────────────────────────────────────
const TAG_PRIORITY = ['cet6', 'ky', 'cet4', 'toefl', 'ielts', 'gk', 'zk', 'gre']
const pickTag = (raw) => {
  for (const key of TAG_PRIORITY) {
    if (raw.split(/\s+/).includes(key)) return key
  }
  return ''
}
/** 中文释义行首的词性标记（vt./n./a.…），ECDICT 无独立 pos 列，从释义提取 */
const LEADING_POS = /^([a-z]{1,5}\.)/

/**
 * ECDICT 的 translation 字段里存的是**字面转义序列** \n（反斜杠+n），
 * 不是真换行。原样透传会让侧栏显示「放纵\nn. 放任」这种脏文本
 * （实测 56.8% 词条中招），这里统一还原成真换行，交给 CSS pre-line 渲染。
 */
const normalizeZh = (raw) => raw.replace(/\\r?n/g, '\n')

/** @type {Map<string, {w:string; ph:string; pos:string; zh:string; tag:string; ctx:Array<[number,string]>}>} */
const entries = new Map()
/** @type {Map<string, string[]>} 头词 → 解析到它的全部词形 */
const formsByHead = new Map()
for (const [form, head] of formToHead) {
  const list = formsByHead.get(head)
  if (list) list.push(form)
  else formsByHead.set(head, [form])
}

/**
 * 语境取句：先跨课各取首句（跨课例句才有「跳到另一课」的价值，
 * 本课的句子用户本来就看得见），再按原顺序补齐剩余名额。
 */
const pickCtx = (occurrences) => {
  const out = []
  const has = (occ) => out.some(([c, l]) => c === occ[0] && l === occ[1])
  const seenCourses = new Set()
  for (const occ of occurrences) {
    if (out.length >= MAX_CTX) break
    if (seenCourses.has(occ[0]) || has(occ)) continue
    seenCourses.add(occ[0])
    out.push(occ)
  }
  for (const occ of occurrences) {
    if (out.length >= MAX_CTX) break
    if (has(occ)) continue
    out.push(occ)
  }
  return out
}

for (const [head, forms] of formsByHead) {
  const row = rows.get(head)
  const firstLine = normalizeZh(row?.zh ?? '').split('\n')[0] ?? ''
  // 词元自身的语境优先于其变形词形
  const ordered = [head, ...forms.filter((form) => form !== head)]
  const occurrences = []
  for (const form of ordered) {
    for (const occ of formOccurrences.get(form) ?? []) occurrences.push(occ)
  }
  entries.set(head, {
    w: head,
    ph: row?.ph ?? '',
    pos: LEADING_POS.exec(firstLine)?.[1] ?? '',
    zh: normalizeZh(row?.zh ?? ''),
    tag: row ? pickTag(row.tag) : '',
    ctx: pickCtx(occurrences),
  })
}

// ─────────────────────────────────────────────────────────────
// 6. 产出 TS（词条按头词排序；词形→头词映射只收「词形≠头词」的部分）
// ─────────────────────────────────────────────────────────────
const formMap = {}
for (const [form, head] of formToHead) {
  if (form !== head) formMap[form] = head
}

const entryLines = [...entries.keys()].sort().map((key) => {
  const e = entries.get(key)
  const parts = [`"w":${JSON.stringify(e.w)}`]
  if (e.ph) parts.push(`"ph":${JSON.stringify(e.ph)}`)
  if (e.pos) parts.push(`"pos":${JSON.stringify(e.pos)}`)
  parts.push(`"zh":${JSON.stringify(e.zh)}`)
  if (e.tag) parts.push(`"tag":${JSON.stringify(e.tag)}`)
  if (e.ctx.length) parts.push(`"ctx":${JSON.stringify(e.ctx)}`)
  return `  ${JSON.stringify(key)}:{${parts.join(',')}},`
})

const out = `// 自动生成（scripts/content/gen-vocab-dict.mjs）——勿手改；ECDICT/seed 更新后重跑。
// 点词查词典的精简内置词典：只收本库 38 课转写出现的词（${formSet.size} 词形 →
// ${entries.size} 词条），词条信息来自 ECDICT（MIT），例句语境来自本库转写。
// 体积刻意精简：不要把完整 ECDICT 打进包。
export type VocabEntry = {
  /** 词条头词（小写） */
  w: string
  /** 音标（ECDICT 原形态，含 ASCII 变体，直接展示） */
  ph?: string
  /** 词性（从释义行首提取的首个标记，如 vt./n.） */
  pos?: string
  /** 中文释义（ECDICT translation 原样，换行已保留） */
  zh: string
  /** 考试标签（cet6/ky/cet4/toefl/ielts/gk/zk/gre，取最高优先级的一个） */
  tag?: string
  /** 本库语境：[课id, 行id][]，最多 ${MAX_CTX} 条；行文本按课 id 从目录接口取 */
  ctx?: [number, string][]
}

/** 词条表：键为头词（含本身就是词条的常见词形）。 */
export const VOCAB_DICT: Record<string, VocabEntry> = {
${entryLines.join('\n')}
}

/** 词形 → 头词（仅收录「词形解析后与头词不同」的映射，如 boxes→box）。
 *  点词查词走 lib/vocabDict.ts 的三级回退：本表 → 头词表 → 启发式还原。 */
export const VOCAB_FORM_MAP: Record<string, string> = {
${Object.keys(formMap).sort().map((k) => `  ${JSON.stringify(k)}:${JSON.stringify(formMap[k])},`).join('\n')}
}
`
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, out, 'utf8')

// ─────────────────────────────────────────────────────────────
// 7. 统计与验收
// ─────────────────────────────────────────────────────────────
const directCount = [...formToHead].filter(([f, h]) => f === h).length
const exchangeCount = [...formToHead].filter(
  ([f, h]) => f !== h && exchangeMap.get(f) === h,
).length
const heuristicCount = formToHead.size - directCount - exchangeCount
const missRate = (missed.length / formSet.size) * 100
console.log(`[resolve] 词形 ${formSet.size}：直接命中 ${directCount}，exchange ${exchangeCount}，启发式 ${heuristicCount}，未命中 ${missed.length}（${missRate.toFixed(2)}%）`)
if (missed.length) {
  console.log(`[miss] 未命中词形：${missed.join(' ')}`)
}
console.log(`[out] 词条 ${entries.size}，词形映射 ${Object.keys(formMap).length} → ${path.relative(root, outPath)}（${(fs.statSync(outPath).size / 1024).toFixed(0)} KB）`)

// 验收判据：常见抽样词必须命中；未命中率应 < 5%
for (const sample of ['world', 'the', 'research', 'professor']) {
  const hit = formToHead.has(sample)
  if (!hit) console.error(`[FAIL] 抽样词 ${sample} 未命中——csv 可能不完整（应为约 77 万行）`)
}
if (missRate >= 5) {
  console.error(`[FAIL] 未命中率 ${missRate.toFixed(2)}% ≥ 5%`)
  process.exitCode = 1
}
if (csvLines - 1 < 700000) {
  console.error(`[FAIL] csv 仅 ${csvLines - 1} 行（应约 77 万行）——文件不完整`)
  process.exitCode = 1
}
