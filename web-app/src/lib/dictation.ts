/**
 * 听写判定引擎（纯函数，无 DOM 依赖）。
 *
 * 四层判定方案（2026-10-11 定稿）：
 * 1. 专名/数字预置不判分——考试惯例，考内容词不考名字拼写；
 * 2. 内容词严格 diff——音近词（their/there）是六级考点，绝不宽容；
 * 3. 长词拼写宽容（≥7 字母编辑距离 1 且「错拼不成词」）——只放 typo，
 *    不放 though/through 这类双方都是真词的混淆（靠全库词表判定）；
 * 4. 虚词降权——弱读听不清是物理现实，标灰不计入实词正确率。
 * 另：英美拼写变体/数字逗号判前归一；严格模式 = 无预置 + 标点计入。
 */
import { DICTATION_CORPUS } from './generated/dictationVocab'

const CORPUS: ReadonlySet<string> = new Set(DICTATION_CORPUS)

/** 英美变体：判前把双方都归一到同一形态（后缀规则 + 少量整词表）。 */
const VARIANT_WORD_MAP: Record<string, string> = {
  colour: 'color', behaviour: 'behavior', labour: 'labor', neighbour: 'neighbor',
  honour: 'honor', favour: 'favor', harbour: 'harbor', rumour: 'rumor',
  centre: 'center', metre: 'meter', theatre: 'theater', fibre: 'fiber', litre: 'liter',
  defence: 'defense', licence: 'license', offence: 'offense', practise: 'practice',
  travelled: 'traveled', travelling: 'traveling', cancelled: 'canceled', cancelling: 'canceling',
  modelling: 'modeling', labelled: 'labeled', fuelled: 'fueled',
}

const normalizeWord = (raw: string): string => {
  let w = raw.toLowerCase()
  // 数字：去千分位逗号（1,956 → 1956）
  if (/\d/.test(w)) w = w.replace(/,/g, '')
  // 英式 -ise 家族 → -ize（后缀规则安全）
  w = w.replace(/(i[sz](?:e|es|ed|ing|ation|ations))$/, (m) => m.replace(/s/g, 'z'))
  w = VARIANT_WORD_MAP[w] ?? w
  // 撇号双方都去（don't / dont 等价）
  w = w.replace(/['’]/g, '')
  return w
}

/** 虚词表：弱读功能词，错/漏标灰不计入实词分母。 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'nor',
  'so', 'as', 'than', 'then', 'if', 'because', 'when', 'while', 'where', 'which',
  'who', 'whom', 'whose', 'that', 'this', 'these', 'those', 'there', 'here',
  'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'done', 'doing', 'has', 'have', 'had', 'having',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'not', 'no', 'yes', 'he', 'she', 'they', 'them', 'their', 'his', 'her', 'hers',
  'we', 'us', 'our', 'you', 'your', 'i', 'me', 'my', 'mine',
  'with', 'from', 'into', 'onto', 'about', 'over', 'under', 'up', 'down', 'out',
  'by', 'via', 'per', 'such', 'own', 'same', 'too', 'very', 'just', 'also',
  'both', 'either', 'neither', 'all', 'any', 'some', 'most', 'more', 'less',
  'what', 'how', 'why', 'again', 'once',
])

export const isFunctionWord = (raw: string): boolean => FUNCTION_WORDS.has(normalizeWord(raw))

/** 音近混淆对（六级听力高频考点）：替换错判红，不受虚词灰档/拼写宽容吸收。 */
const HOMOPHONE_WORDS: ReadonlySet<string> = new Set([
  'their', 'there', 'theyre', 'theyll', 'theirs',
  'to', 'too', 'two',
  'its', 'his',
  'your', 'youre', 'yours',
  'hear', 'here',
  'than', 'then',
  'weather', 'whether',
  'weak', 'week',
  'passed', 'past',
])

const TOKEN_RE = /[A-Za-z£$][A-Za-z0-9£$'%.,-]*|\d[\d,.%]*/g

/** 分词 + 保留原文形态（渲染 diff 用原词，比对用归一形）。 */
const tokenize = (text: string): Array<{ raw: string; norm: string }> => {
  const out: Array<{ raw: string; norm: string }> = []
  for (const m of text.match(TOKEN_RE) ?? []) {
    // 去掉裹进来的句读点（词尾 . , 尾随连字符），£/$ 保留在 raw、归一时去掉
    const raw = m.replace(/[.,]+$/, '').replace(/-+$/, '')
    if (!raw) continue
    out.push({ raw, norm: normalizeWord(raw.replace(/[£$%]/g, '')) })
  }
  return out
}

export type GivenSpan = { start: number; end: number; text: string }

const TITLE_RE = /^(?:Dr|Prof|Mr|Mrs|Ms|Miss|Sir|St)\.$/
const PREFIX_START_RE = /^(?:[WM]\s*:|-\s*)/

/**
 * 专名/数字预置范围（宁严勿滥——漏掉的落回严格判，误报会白送分）。
 * 判据：数字串（含 £$%,.）、缩写（U.S./UK/BBC）、头衔+姓名、
 * 相邻大写词对（New Look / Harvey Whitehouse）、句中非句首的单个大写词
 * （排除 I 及其缩写、星期月份——那是可学词汇）。
 */
export const findGivenSpans = (text: string): GivenSpan[] => {
  const spans: GivenSpan[] = []
  const words = [...text.matchAll(/\b[A-Za-z£$][A-Za-z0-9£$'.,-]*\d*\b|\d[\d,.%]*/g)]
  const noteSentenceStart = (idx: number) => {
    // 前文是句终标点/行首/说话人前缀之后的第一个词 = 句首
    const before = text.slice(Math.max(0, idx - 4), idx)
    if (idx === 0 || /[.?!]["']?\s*$/.test(before) || PREFIX_START_RE.test(text.slice(0, idx).split(/\s+/).slice(-2).join(' ') + ' ')) {
      return true
    }
    return false
  }
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]
    const token = w[0]
    // 数字/金额
    if (/^[£$]?\d[\d,.%]*$/.test(token)) {
      spans.push({ start: w.index, end: w.index + token.length, text: token })
      continue
    }
    // 缩写：U.S. / UK / BBC（≥2 大写字母）
    if (/^[A-Z]{2,}(?:\.[A-Z]{2,})*\.?$/.test(token) && token.replace(/\./g, '').length >= 2) {
      spans.push({ start: w.index, end: w.index + token.length, text: token })
      continue
    }
    // 头衔
    if (TITLE_RE.test(token)) {
      spans.push({ start: w.index, end: w.index + token.length, text: token })
      continue
    }
    if (!/^[A-Z][a-z'’-]+/.test(token)) continue
    if (token === 'I' || /^I'(m|ve|ll|d)$/.test(token)) continue
    const next = words[i + 1]?.[0] ?? ''
    const prev = words[i - 1]?.[0] ?? ''
    // 相邻大写词对（New Look / Harvey Whitehouse）；前邻是头衔也并入
    const pairNext = /^[A-Z]/.test(next) && !/^I$/.test(next)
    const afterTitle = TITLE_RE.test(prev)
    if (pairNext || afterTitle) {
      spans.push({ start: w.index, end: w.index + token.length, text: token })
      continue
    }
    // 句中非句首单大写词（Workplace / Boston）
    if (!noteSentenceStart(w.index)) {
      spans.push({ start: w.index, end: w.index + token.length, text: token })
    }
  }
  return spans
}

const editDistance = (a: string, b: string): number => {
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > 2) return 3
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j += 1) dp[0][j] = j
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[m][n]
}

export type WordVerdict = {
  raw: string
  /** pass=正确；given=预置不判分；fn=虚词(灰)；near=拼写宽容(橙)；miss=漏(红)；extra=多写(红) */
  kind: 'pass' | 'given' | 'fn' | 'near' | 'miss' | 'extra'
  /** near/miss 的对照（正确词） */
  expect?: string
}

export type DictationResult = {
  words: WordVerdict[]
  /** 实词正确数（pass+near）/ 实词总数（不含 given/fn/extra） */
  contentPass: number
  contentTotal: number
  passed: boolean
}

/** 比对用户输入与原句。givenNorms 来自 findGivenSpans 的分词归一集。 */
export const judgeDictation = (
  lineText: string,
  userInput: string,
  givenNorms: ReadonlySet<string> = new Set(),
): DictationResult => {
  const expected = tokenize(lineText)
  const actual = tokenize(userInput)
  // LCS 对齐（归一形态）
  const n = expected.length
  const m = actual.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = expected[i].norm === actual[j].norm
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const matchedExpected = new Array<boolean>(n).fill(false)
  const matchedActual = new Array<boolean>(m).fill(false)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (expected[i].norm === actual[j].norm) {
      matchedExpected[i] = true
      matchedActual[j] = true
      i += 1
      j += 1
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  // 未匹配的按邻近配成替换对（同位换词 vs 漏词/多词）
  const pendingExpected: number[] = []
  const pendingActual: number[] = []
  const substitution: Array<{ e: number; a: number }> = []
  for (let k = 0; k < n; k += 1) if (!matchedExpected[k]) pendingExpected.push(k)
  for (let k = 0; k < m; k += 1) if (!matchedActual[k]) pendingActual.push(k)
  let pe = 0
  let pa = 0
  while (pe < pendingExpected.length && pa < pendingActual.length) {
    const eIdx = pendingExpected[pe]
    const aIdx = pendingActual[pa]
    // 邻近判据：下一对已匹配位置之间
    const nextE = pendingExpected[pe + 1]
    if (nextE === undefined || nextE > aIdx + 1 || true) {
      // 简化：顺序配对（LCS 之后剩余基本同位）
      substitution.push({ e: eIdx, a: aIdx })
      pe += 1
      pa += 1
    }
  }

  const words: WordVerdict[] = []
  let contentPass = 0
  let contentTotal = 0
  const emit = (v: WordVerdict) => {
    words.push(v)
    if (v.kind === 'pass' || v.kind === 'near') contentPass += 1
    if (v.kind !== 'given' && v.kind !== 'fn') {
      if (v.kind !== 'extra') contentTotal += 1
    }
  }

  // 先按 expected 顺序产出；替换对在原位产出，extra 收尾附加
  const subsByExpected = new Map(substitution.map((s) => [s.e, s.a]))
  const consumedActual = new Set(substitution.map((s) => s.a))
  for (let k = 0; k < n; k += 1) {
    if (matchedExpected[k]) {
      if (givenNorms.has(expected[k].norm)) {
        emit({ raw: expected[k].raw, kind: 'given' })
      } else {
        emit({ raw: expected[k].raw, kind: 'pass' })
      }
      continue
    }
    const aIdx = subsByExpected.get(k)
    if (aIdx !== undefined) {
      const e = expected[k]
      const a = actual[aIdx]
      if (givenNorms.has(e.norm) || givenNorms.has(a.norm)) {
        emit({ raw: e.raw, kind: 'given' })
        continue
      }
      // 音近对：考点级错误，最先判红（their/there、to/too、hear/here）
      if (HOMOPHONE_WORDS.has(e.norm) && HOMOPHONE_WORDS.has(a.norm) && e.norm !== a.norm) {
        emit({ raw: e.raw, kind: 'miss', expect: a.raw })
        continue
      }
      // 虚词灰档只适用于预期词本身是虚词：预期实词被写成虚词（hear→here
      // 类）必须判红，否则实词错误被虚词规则白送
      if (FUNCTION_WORDS.has(e.norm)) {
        emit({ raw: e.raw, kind: 'fn', expect: a.raw })
        continue
      }
      const longEnough = Math.max(e.norm.length, a.norm.length) >= 7
      if (longEnough && editDistance(e.norm, a.norm) <= 1 && !CORPUS.has(a.norm)) {
        emit({ raw: e.raw, kind: 'near', expect: a.raw })
        continue
      }
      emit({ raw: e.raw, kind: 'miss', expect: a.raw })
      continue
    }
    // 无配对：漏词
    if (givenNorms.has(expected[k].norm)) {
      emit({ raw: expected[k].raw, kind: 'given' })
    } else if (FUNCTION_WORDS.has(expected[k].norm)) {
      emit({ raw: expected[k].raw, kind: 'fn' })
    } else {
      emit({ raw: expected[k].raw, kind: 'miss' })
    }
  }
  for (let k = 0; k < m; k += 1) {
    if (matchedActual[k] || consumedActual.has(k)) continue
    emit({ raw: actual[k].raw, kind: 'extra' })
  }

  return {
    words,
    contentPass,
    contentTotal,
    passed: contentTotal > 0 && contentPass === contentTotal,
  }
}

/** 预置范围的归一词集（judgeDictation 的 givenNorms 入参）。 */
export const givenNormsOf = (text: string): Set<string> => {
  const norms = new Set<string>()
  for (const span of findGivenSpans(text)) {
    for (const t of tokenize(span.text)) norms.add(t.norm)
  }
  return norms
}

/** 提示：首字母 + 词长（w______）。 */
export const wordHint = (word: string): string => {
  const letters = word.replace(/[^A-Za-z]/g, '')
  return letters.length <= 1 ? word : `${letters[0]}${'_'.repeat(Math.max(1, letters.length - 1))}`
}

/** 严格模式：标点序列比对（词级 diff 之外的附加检查）。 */
export const punctuationDiff = (lineText: string, userInput: string): string[] => {
  const take = (s: string) => (s.match(/[.,?!;:]/g) ?? [])
  const expectedP = take(lineText)
  const actualP = take(userInput)
  const diffs: string[] = []
  if (expectedP.length !== actualP.length) {
    diffs.push(`标点数不符（原文 ${expectedP.length} / 你 ${actualP.length}）`)
  } else {
    for (let k = 0; k < expectedP.length; k += 1) {
      if (expectedP[k] !== actualP[k]) {
        diffs.push(`第 ${k + 1} 个标点应为「${expectedP[k]}」`)
      }
    }
  }
  return diffs
}
