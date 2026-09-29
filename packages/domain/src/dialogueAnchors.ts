/**
 * 对话锚点（Dialogue Anchor）：从字幕行文本里识别考试听力的「指令句」，
 * 生成可点击的对话级定位点。典型来源是四六级真题音频中的中文指令，例如：
 *   - 听下面一段对话，回答第8至11题。
 *   - 请听下面第一段独白。
 *   - 第一节 / 现在你有10秒钟的时间阅读这三小题。
 * 也兼容英文指令（Text 1 / Conversation One / Section A）。
 *
 * 设计要点：
 * - 纯函数、零依赖：TranscriptLine（学习端）、DraftLine（管理后台）、ASR 结果
 *   都能直接作为输入，只要求 id/start/end/text 四个字段。
 * - 锚点从「当前字幕」推导而不是单独存储：创作者在校波台上修正指令句文本后，
 *   学习端下一次打开课程就会得到修正后的锚点，不存在两份数据漂移的问题。
 *   因此创作者应保留音频里的指令句字幕（它们本身就是很好的分节标记）。
 * - 相邻的指令行合并为一个锚点：ASR 常把一条指令拆成两行（例如
 *   「听下面一段对话，回答第8至11题。」+「现在你有10秒钟时间阅读这三小题。」），
 *   学习者点一次就该跳到指令块的开头。
 */

export type DialogueAnchorKind =
  /** 大题节，如「第一节」 */
  | 'section'
  /** 对话 */
  | 'dialogue'
  /** 独白 */
  | 'monologue'
  /** 短文/材料（第三部分常见） */
  | 'passage'
  /** 明确题号区间，如「回答第8至11题」 */
  | 'question-range'
  /** 英文指令，如 Text 1 / Conversation One */
  | 'text'

export type DialogueAnchor = {
  /** 稳定 id，按出现顺序 da-1、da-2…… */
  id: string
  kind: DialogueAnchorKind
  /** 展示标签，如「第8–11题」「对话 2」「第一节」「Text 1」 */
  label: string
  /** 锚点起始时间（秒）：点击后从这里播放 */
  start: number
  /** 锚点结束时间（秒）：下一个锚点的开始或最后一条字幕的结束，用于高亮当前区间 */
  end: number
  /** 组成该锚点的字幕行 id（含被合并的相邻指令行） */
  lineIds: string[]
}

/** 锚点提取的最小输入形状；TranscriptLine / DraftLine 均天然满足。 */
export type AnchorSourceLine = {
  id: string
  start: number
  end: number
  text: string
}

const fullDigitMap: Record<string, string> = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
}

const normalizeDigits = (value: string) =>
  value.replace(/[０-９]/g, (char) => fullDigitMap[char] ?? char)

const chineseDigitMap: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/**
 * 解析中文序数（一~九十九）或阿拉伯/全角数字；解析失败返回 null。
 * 听力题号最多到 25 题、材料到十几段，百位以上的支持没有必要，也便于拦截误匹配。
 */
const parseCjkOrdinal = (raw: string): number | null => {
  const value = normalizeDigits(raw).trim()
  if (!value) {
    return null
  }

  if (/^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10)
    return parsed >= 1 && parsed <= 99 ? parsed : null
  }

  if (/^[零一二两三四五六七八九十]{1,3}$/.test(value)) {
    if (value === '零') {
      return null
    }
    const tenIndex = value.indexOf('十')
    if (tenIndex < 0) {
      return chineseDigitMap[value] ?? null
    }
    const tensPart = value.slice(0, tenIndex)
    const onesPart = value.slice(tenIndex + 1)
    const tens = tensPart ? chineseDigitMap[tensPart] : 1
    const ones = onesPart ? chineseDigitMap[onesPart] : 0
    if (tens === undefined || ones === undefined || (tensPart && tens === 0)) {
      return null
    }
    const result = tens * 10 + ones
    return result >= 1 && result <= 99 ? result : null
  }

  return null
}

const ENGLISH_WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
}

const ORDINAL = '[0-9０-９一二两三四五六七八九十]{1,3}'

/**
 * 指令分类结果。rank 越高信息量越大：同一行同时命中「对话」和「题号」时
 * 优先用题号做标签（四六级真题里题号是最稳定的定位信息）。
 */
type InstructionMatch = {
  kind: DialogueAnchorKind
  label: string
  rank: number
  /**
   * 仅作「合并候选」：自己不新起锚点，尽量并入前一个指令块。
   * 用于说明段续行、阅读小题提示 —— 它们的标签只为"万不得已要新起锚点"时兜底，
   * 判断能否并入要看这个标记，而不是"标签是否为空"（标签可能是 'Directions'）。
   */
  mergeOnly?: boolean
}

const QUESTION_RANGE_PATTERN = new RegExp(
  `(?:回答|请看|看|做|完成)[^。；;\\n]{0,12}第?\\s*(${ORDINAL})\\s*[至到和~～\\-—]\\s*第?\\s*(${ORDINAL})\\s*(?:小)?\\s*题`,
)
/**
 * 单题指令（看第9题 / 完成 10 题）。编号不接受「两」：量词两出现在
 * 「这两小题」「阅读这两题」里，是复数指代而不是题号。
 */
const SINGLE_QUESTION_NUMBER = '[0-9０-９一二三四五六七八九十]{1,3}'
const SINGLE_QUESTION_PATTERN = new RegExp(
  `(?:回答|请看|看|听|做|完成|阅读)\\s*(?:下面|以下|这两小|这两|这三小|这三|这|本)?\\s*(?:的)?\\s*第?\\s*(${SINGLE_QUESTION_NUMBER})\\s*(?:小)?\\s*题`,
)
/** 「现在你有5秒钟时间看第1题」「现在，你有10秒钟的时间阅读这三小题。」 */
const READ_TIME_QUESTION_PATTERN = new RegExp(
  `现在.{0,14}(?:第?\\s*(${SINGLE_QUESTION_NUMBER})\\s*(?:小)?\\s*题|这两小题|这三小题|这一小题)`,
)

const SECTION_PATTERN = new RegExp(
  `(?:^|[，。,\\s])(?:请?听.{0,6})?第\\s*(${ORDINAL})\\s*(节|部分)`,
)

/**
 * 「听下面一段对话」里的「一段」是不定冠词，不能当作编号；
 * 只有「第N段」或「N≥二」的裸数字（如「听两段对话」，罕见）才算显式编号。
 */
const MATERIAL_PATTERN = new RegExp(
  `(?:请听|听|下面请听|请注意听)[^。；;\\n]{0,10}?第\\s*(${ORDINAL})\\s*(?:段|篇)\\s*(对话|独白|短文|材料|会话|文章|录音|课文)` +
    `|(?:请听|听|下面请听|请注意听)[^。；;\\n]{0,8}(${ORDINAL})\\s*(对话|独白|短文|材料|会话|文章|录音|课文)` +
    `|(?:请听|听|下面请听)[^。；;\\n]{0,6}一段\\s*(对话|独白|短文|材料|会话|文章|录音|课文)`,
)

const TEXT_PATTERN =
  /^[\s\-\u2013\u2014>*•]*(text|conversation|passage|recording|lecture|talk|section)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+|[a-d])\b\s*[.:,]?\s*$/i

/**
 * 指令头前缀：「Section A - Directions」「Section A (Directions)」「Section A)」「Conversation 1 - Welcome ...」——只认头部，限长防误报。
 * 允许行首出现短横/圆点列表符：ASR/修复管线会给题干与报头行加「- 」前缀
 * （2025年6月第1套实测整批「- Conversation two.」「- Questions one to four …」）。
 */
const TEXT_HEAD_PATTERN =
  /^[\s\-\u2013\u2014>*•]*(text|conversation|passage|recording|lecture|talk|section)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+|[a-d])\b(?:\s*[-\u2013\u2014:,)（(]\s*|\s+directions\b|\s*$)/i

/**
 * 报头与说明段被 whisper 塞进同一行、行长超过上面限长门槛的那种：
 * 「Section C, directions, in this section you will hear 3 recordings of lectures or talks followed by …」。
 * 只要「Section X」后面紧跟 directions / in this section，仍按节次报头处理。
 */
const LONG_SECTION_HEAD_PATTERN =
  /^\s*section\s+([a-d])\b[^.!?]{0,40}?(?:directions\b|in this section\b)/i

/** 英文真题题干指令：「Questions one to four are based on ...」（六级原音频的官方播报形式）。 */
const EN_QUESTIONS_RANGE_PATTERN =
  /^[\s\-\u2013\u2014>*•]*questions?\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+)\s*(?:to|through|–|—|-)\s*(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+)\b/i
const EN_SINGLE_QUESTION_PATTERN =
  /^[\s\-\u2013\u2014>*•]*questions?\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+)\b/i

/** 原文 md 的题干写法：「Q1. What is the …」/「Q12: …」/「Q3。…」。 */
const EN_Q_LABEL_PATTERN = /^[\s\-\u2013\u2014>*•]*q\s*([0-9]{1,2})\s*[.。:：,，)]\s*\S/i

/**
 * 四六级「指令说明段」的续行片段。音频里这段只有首行带「Section X Directions」头，
 * whisper 常把余下部分切成 4～6 行，文本形如：
 *   "In this section you will hear two long conversations. At the end of each conversation you will hear"
 *   "four questions. Both the conversation and the questions will be spoken only once. After"
 *   "C and D. Then mark the corresponding letter on answer sheet 1 with a single line through" / "the center."
 * 这些行必须被认作指令行，否则会跟着报头锚点漏进逐句精听的学习句。
 */
const EN_DIRECTIONS_LINE_PATTERN = new RegExp(
  '^\\s*(?:' +
    'directions\\b' +
    '|in this section\\b' +
    '|(?:three|four)\\s+questions\\b' +
    '|you hear a question\\b' +
    '|c and d\\b' +
    '|choices marked\\b' +
    '|(?:spoken|played) only once\\b' +
    '|a single line through\\b' +
    '|talks?\\s+followed\\b' +
    '|(?:passage|recording|conversation)s?,\\s*you will hear\\b' +
    '|at the end of each (?:conversation|passage|recording|section)\\b' +
    '|after you hear a question\\b' +
    '|the cent(?:er|re)\\s*[.。]?$' +
  ')',
  'i',
)

const enWordToNumber = (raw: string): number | null => {
  const value = raw.toLowerCase()
  if (ENGLISH_WORD_NUMBERS[value] !== undefined) {
    return ENGLISH_WORD_NUMBERS[value]
  }
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10)
  }
  return null
}

/**
 * 指令相关字的繁转简映射。whisper 的中文识别结果即使有提示词偏置，
 * 仍可能输出繁体（聽下面一段對話），指令匹配必须同时兼容两种字形；
 * 只映射指令语句里实际出现的字，避免引入完整繁简转换表。
 */
const instructionT2sMap: Record<string, string> = {
  聽: '听', 請: '请', 對: '对', 話: '话', 題: '题', 獨: '独',
  節: '节', 會: '会', 課: '课', 錄: '录', 兩: '两', 閱: '阅',
  讀: '读', 這: '这', 幾: '几', 現: '现', 鐘: '钟', 個: '个',
  們: '们', 種: '种', 後: '后', 時: '时', 間: '间',
}

const normalizeInstructionText = (value: string) =>
  normalizeDigits(value).replace(
    /[聽請對話題獨節會課錄兩閱讀這幾現鐘個們種後時間]/g,
    (char) => instructionT2sMap[char] ?? char,
  )

const MATERIAL_KIND_LABELS: Record<string, string> = {
  对话: '对话',
  会话: '对话',
  独白: '独白',
  短文: '短文',
  材料: '材料',
  文章: '短文',
  录音: '材料',
  课文: '短文',
}

const materialKindToAnchorKind = (kind: string): DialogueAnchorKind => {
  if (kind === '对话' || kind === '会话') {
    return 'dialogue'
  }
  if (kind === '独白') {
    return 'monologue'
  }
  return 'passage'
}

/** 从锚点标签解析「Q19」/「Q19–22」/「第19题」/「第19–22题」形态的题号区间；其他形态返回 null。 */
const parseQuestionRangeLabel = (
  label: string,
): { first: number; last: number; cjk: boolean } | null => {
  const qMatch = label.match(/^Q(\d{1,2})(?:[–—-](\d{1,2}))?$/)
  if (qMatch) {
    const first = Number.parseInt(qMatch[1], 10)
    const last = qMatch[2] ? Number.parseInt(qMatch[2], 10) : first
    return first >= 1 && last >= first && last <= 99
      ? { first, last, cjk: false }
      : null
  }
  const cjkMatch = label.match(/^第(\d{1,2})(?:[–—-](\d{1,2}))?题$/)
  if (cjkMatch) {
    const first = Number.parseInt(cjkMatch[1], 10)
    const last = cjkMatch[2] ? Number.parseInt(cjkMatch[2], 10) : first
    return first >= 1 && last >= first && last <= 99
      ? { first, last, cjk: true }
      : null
  }
  return null
}

/**
 * 相邻题干句（「Q19. …」后面跟「Q20. …」）并进前一个题号块时，把题号区间
 * 向外扩展，而不是被下面的「标签只升不降」吞掉——否则区间指令句缺失的课程
 * （如 2017年6月第1套的 Recording 2）整段只剩第一个题号的锚点，Q20–22 就
 * 从锚点条上消失了（38 门课 24 门有此缺口，2026-09-29 审计）。
 * 返回扩展后的标签；无法按题号区间处理时返回 null（走原有的只升不降覆盖）。
 */
const extendQuestionRangeLabel = (
  previousLabel: string,
  incomingLabel: string,
): string | null => {
  const previous = parseQuestionRangeLabel(previousLabel)
  if (!previous) {
    return null
  }
  const incoming = incomingLabel.match(/^Q(\d{1,2})$/) ?? incomingLabel.match(/^第(\d{1,2})题$/)
  if (!incoming) {
    return null
  }
  const number = Number.parseInt(incoming[1], 10)
  if (!Number.isInteger(number) || number < 1 || number > 99) {
    return null
  }
  // 区间内的重复题干（题组播报后跟 Qn.）：吸收进块，标签不动
  if (number >= previous.first && number <= previous.last) {
    return previousLabel
  }
  const first = Math.min(previous.first, number)
  const last = Math.max(previous.last, number)
  if (first === last) {
    return previousLabel
  }
  return previous.cjk ? `第${first}–${last}题` : `Q${first}–${last}`
}

/** 判断单行字幕是否为指令行，命中则返回分类与标签候选。 */
const matchInstruction = (rawText: string): InstructionMatch | null => {
  const text = normalizeInstructionText(rawText.trim())
  if (!text) {
    return null
  }

  // 指令头前缀：以 Section A / Conversation 1 等开头的中短行（官方播报的指令头）。
  const headMatch = text.match(TEXT_HEAD_PATTERN)
  if (headMatch && text.length <= 90) {
    const ordinalRaw = headMatch[2].toLowerCase()
    const wordNumber = ENGLISH_WORD_NUMBERS[ordinalRaw]
    const number = wordNumber ?? (/^\d+$/.test(ordinalRaw) ? Number.parseInt(ordinalRaw, 10) : null)
    const head = headMatch[1].toLowerCase()
    const label = number !== null
      ? `${head.charAt(0).toUpperCase()}${head.slice(1)} ${number}`
      : `${head.charAt(0).toUpperCase()}${head.slice(1)} ${ordinalRaw.toUpperCase()}`
    return { kind: 'text', label, rank: 1 }
  }

  // 英文指令独占一行（Text 1 / Conversation One / Section A）。
  const englishMatch = text.match(TEXT_PATTERN)
  if (englishMatch) {
    const head = englishMatch[1].toLowerCase()
    const ordinalRaw = englishMatch[2].toLowerCase()
    const wordNumber = ENGLISH_WORD_NUMBERS[ordinalRaw]
    const number = wordNumber ?? (/^\d+$/.test(ordinalRaw) ? Number.parseInt(ordinalRaw, 10) : null)
    const label = number !== null
      ? `${head.charAt(0).toUpperCase()}${head.slice(1)} ${number}`
      : `${head.charAt(0).toUpperCase()}${head.slice(1)} ${ordinalRaw.toUpperCase()}`
    return { kind: 'text', label, rank: 2 }
  }

  const enRangeMatch = text.match(EN_QUESTIONS_RANGE_PATTERN)
  if (enRangeMatch) {
    const first = enWordToNumber(enRangeMatch[1])
    const last = enWordToNumber(enRangeMatch[2])
    if (first !== null && last !== null && last >= first) {
      const label = last > first ? `Q${first}–${last}` : `Q${first}`
      return { kind: 'question-range', label, rank: 4 }
    }
  }

  const enSingleMatch = text.match(EN_SINGLE_QUESTION_PATTERN)
  if (enSingleMatch) {
    const number = enWordToNumber(enSingleMatch[1])
    if (number !== null) {
      return { kind: 'question-range', label: `Q${number}`, rank: 3 }
    }
  }

  const rangeMatch = text.match(QUESTION_RANGE_PATTERN)
  if (rangeMatch) {
    const first = parseCjkOrdinal(rangeMatch[1])
    const last = parseCjkOrdinal(rangeMatch[2])
    if (first !== null && last !== null && last >= first) {
      const label = last > first ? `第${first}–${last}题` : `第${first}题`
      return { kind: 'question-range', label, rank: 4 }
    }
  }

  // 单题指令在材料指令之前判断：让「听下面一段对话，回答第9题」这类
  // 混合句优先拿到更精确的题号标签，而不是笼统的「对话」。
  const singleMatch = text.match(SINGLE_QUESTION_PATTERN)
  if (singleMatch) {
    const ordinal = parseCjkOrdinal(singleMatch[1])
    if (ordinal !== null) {
      return { kind: 'question-range', label: `第${ordinal}题`, rank: 3 }
    }
  }

  const materialMatch = text.match(MATERIAL_PATTERN)
  if (materialMatch) {
    // MATERIAL_PATTERN 三个分支只有一个会命中；命中的分组位置决定序数与材料类型。
    const explicitOrdinal = materialMatch[1] ?? materialMatch[3] ?? null
    const kind = materialMatch[2] ?? materialMatch[4] ?? materialMatch[5] ?? ''
    const kindLabel = MATERIAL_KIND_LABELS[kind]
    if (kindLabel) {
      const anchorKind = materialKindToAnchorKind(kind)
      const ordinal = explicitOrdinal ? parseCjkOrdinal(explicitOrdinal) : null
      if (explicitOrdinal && ordinal !== null) {
        return { kind: anchorKind, label: `${kindLabel} ${ordinal}`, rank: 3 }
      }
      // 「一段」没有编号，交给调用方按出现顺序补号（label 留待填充）。
      return { kind: anchorKind, label: kindLabel, rank: 3 }
    }
  }

  const sectionMatch = text.match(SECTION_PATTERN)
  if (sectionMatch) {
    const ordinal = parseCjkOrdinal(sectionMatch[1])
    if (ordinal !== null) {
      return { kind: 'section', label: `第${ordinal}${sectionMatch[2]}`, rank: 1 }
    }
  }

  const readTimeMatch = text.match(READ_TIME_QUESTION_PATTERN)
  if (readTimeMatch) {
    const ordinal = readTimeMatch[1] ? parseCjkOrdinal(readTimeMatch[1]) : null
    if (ordinal !== null) {
      return { kind: 'question-range', label: `第${ordinal}题`, rank: 2 }
    }
    // 「阅读这两小题/这三小题」没有具体题号：不给标签，仅作为合并候选跟随前一条指令。
    return { kind: 'question-range', label: '', rank: 2, mergeOnly: true }
  }

  // 原文 md 的题干写法「Q1. What is the …」。旧 ASR 稿里题干是「Question one, what …」，
  // 已被上面的英文题干模式识别；换成官方原文后写成「Qn.」，不补这条就会漏进逐句精听
  // 的学习句（实测一门课 25 行）。给出 Qn 标签：若前一行是题组播报（rank 4 的 Q1–4），
  // 标签不会被覆盖，只是把这几行并入那个锚点。
  const qLabelMatch = text.match(EN_Q_LABEL_PATTERN)
  if (qLabelMatch) {
    const number = Number.parseInt(qLabelMatch[1], 10)
    if (Number.isInteger(number) && number > 0) {
      return { kind: 'question-range', label: `Q${number}`, rank: 3 }
    }
  }

  // 报头与说明段同段（行长超限，上面的头部模式会因限长而漏判）：
  // 「Section C, directions, in this section you will hear 3 recordings …」
  const longSectionMatch = text.match(LONG_SECTION_HEAD_PATTERN)
  if (longSectionMatch) {
    return { kind: 'text', label: `Section ${longSectionMatch[1].toUpperCase()}`, rank: 1 }
  }

  // 指令说明段的续行（"In this section, you will hear…"、"…spoken only once." …）。
  // 这段在音频里只有第一行带「Section X Directions」头，其余 4～6 行是纯正文式片段；
  // 不认它们就会跟着「Section A」锚点一起漏进逐句精听（实测一门课 15 行）。
  // 给一个低 rank 的可读标签：能并进报头锚点时不会覆盖其标签（rank 不比它大），
  // 万一前面没有报头行可并（whisper 没产出报头），也不会退化成 "question-range" 这种词。
  if (EN_DIRECTIONS_LINE_PATTERN.test(text)) {
    return { kind: 'question-range', label: 'Directions', rank: 1, mergeOnly: true }
  }

  return null
}

const sortByStart = (lines: readonly AnchorSourceLine[]): AnchorSourceLine[] =>
  [...lines]
    .filter((line) => Number.isFinite(line.start))
    .sort((left, right) => left.start - right.start)

/** 锚点标签的兜底显示名：宁可给一个可读中文，也不要落回 kind 的英文枚举值。 */
const FALLBACK_LABELS: Record<DialogueAnchorKind, string> = {
  section: '小节',
  dialogue: '对话',
  monologue: '独白',
  passage: '短文',
  'question-range': '题目',
  text: '提示',
}

/**
 * 从字幕行提取对话锚点。
 * - 连续出现的指令行合并为同一个锚点（点击一次即跳到指令块开头）。
 * - 「听下面一段对话」这类无编号指令按出现顺序自动编号：对话 1、对话 2……
 *   同类的有编号指令（第N段）优先使用其自带编号。
 * - 锚点区间覆盖到下一个锚点开始（或最后一行结束），学习端据此高亮当前区间。
 */
export const extractDialogueAnchors = (
  lines: readonly AnchorSourceLine[],
): DialogueAnchor[] => {
  // ASR 常把正文句尾和题干播报连在同一行（「...positive change. Questions 12 to
  // 15 are based on ...」）：按最后一个句界拆开，题干部分按文本长度近似起点，
  // 否则该题组锚点会整体丢失。
  const expanded: AnchorSourceLine[] = []
  for (const line of sortByStart(lines)) {
    const midMatch = line.text.match(
      /^(.+[.!?]["')]?\s+)((?:Questions?|questions?)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+)[\s\S]*)$/,
    )
    if (midMatch && midMatch[2].length >= 12) {
      const span = Math.max(0, line.end - line.start)
      const splitStart = line.start + span * (midMatch[1].length / line.text.length)
      // 首片沿用原行 id：消费端按「锚点 lineIds 是否包含行 id」剔除指令行，
      // 若首片用虚拟 id，原行会因 id 失配而漏回逐句精听。
      expanded.push({ id: line.id, start: line.start, end: splitStart, text: midMatch[1].trim() })
      expanded.push({ id: line.id + '-b', start: splitStart, end: line.end, text: midMatch[2].trim() })
      continue
    }
    // 句尾报头：原文对齐常把下一个节次报头粘在题干播报行的尾部
    // （「Question eight. What does …? Section B.」）——不拆开，Section B 锚点就丢了。
    // 与上面的句中 Questions 拆分同一手法：报头独立成行，时间按文本比例切分。
    const tailHeaderMatch = line.text.match(
      /^(.+[.!?]["')]?\s+)((?:Section|Conversation|Passage|Recording|Talk|Part)\s+(?:one|two|three|four|five|[0-9]+|[a-d])\b)\s*[.,!?:\-–—]*$/i,
    )
    if (tailHeaderMatch && tailHeaderMatch[1].trim().length >= 10) {
      const span = Math.max(0, line.end - line.start)
      const splitStart = line.start + span * (tailHeaderMatch[1].length / line.text.length)
      expanded.push({ id: line.id, start: line.start, end: splitStart, text: tailHeaderMatch[1].trim() })
      expanded.push({ id: line.id + '-b', start: splitStart, end: line.end, text: tailHeaderMatch[2].trim() })
      continue
    }
    expanded.push(line)
  }
  const sorted = sortByStart(expanded)
  type Draft = {
    kind: DialogueAnchorKind
    label: string
    rank: number
    start: number
    lastLine: AnchorSourceLine
    lineIds: string[]
  }

  const drafts: Draft[] = []
  // 只有上一条字幕行也属于指令块时才允许合并；中间夹了正文就另起新锚点。
  let previousLineWasInstruction = false
  for (const line of sorted) {
    const match = matchInstruction(line.text)
    if (!match) {
      previousLineWasInstruction = false
      continue
    }

    const previous = drafts[drafts.length - 1]
    // 题号播报（question-range）跟在内容段尾部，并入前块；
    // 内容段报头（Section/Conversation/Passage/Recording 等）永远新起锚点——
    // 否则「Conversation two」会被上一题的题号块吞掉，用户就跳不到正文了。
    const startsNewBlock = match.kind !== 'question-range'
    // 无标签的「仅合并候选」（说明段续行、阅读小题提示）还要能跨过 ASR 的换行碎片：
    // 音频里这段被切成 "section you will hear…"、"the centre."、"played only once…"
    // 这类片段，中间夹一条认不出来的碎片就会把 previousLineWasInstruction 打断，
    // 链条一断，续行就自己成了一个标签为 kind 字符串的锚点（实测 17 门课 20 处）。
    // 用时间窗兜住：只允许并进「最近 30 秒内还活着」的块，避免跨越正文误并。
    const bridgeSeconds = 30
    const canBridge = match.mergeOnly === true && previous !== undefined &&
      line.start - previous.lastLine.end <= bridgeSeconds
    if (previous && (previousLineWasInstruction || canBridge) && !startsNewBlock) {
      // 相邻题号播报合并进前一个锚点；标签取信息量更高（rank 更大且非空）的那条。
      previous.lineIds.push(line.id)
      previous.lastLine = line
      // 连续题干句先尝试向外扩展题号区间（Q19. + Q20. + … → Q19–22）；
      // 扩展成功（含区间内吸收）就把块升到区间级，后面的同 rank 题干继续扩展。
      const extendedLabel = extendQuestionRangeLabel(previous.label, match.label)
      if (extendedLabel !== null) {
        previous.label = extendedLabel
        previous.kind = 'question-range'
        previous.rank = Math.max(previous.rank, 4)
      } else if (match.label && match.rank > previous.rank) {
        // 标签只升不降：高信息量（rank 大且非空）的指令覆盖低信息量的，
        // 例如「Section A」+「Question one,...」相邻时保留题号而不是节名。
        previous.label = match.label
        previous.kind = match.kind
        previous.rank = match.rank
      }
    } else {
      drafts.push({
        kind: match.kind,
        label: match.label,
        rank: match.rank,
        start: line.start,
        lastLine: line,
        lineIds: [line.id],
      })
    }
    previousLineWasInstruction = true
  }

  const isMaterialKind = (kind: DialogueAnchorKind) =>
    kind === 'dialogue' || kind === 'monologue' || kind === 'passage'

  // 为无编号的「一段对话/独白/短文」按同类顺序补号；显式编号（对话 2）参与种子，
  // 避免「第二段对话」后跟「一段对话」时自动编号撞成「对话 1」。
  const counters = new Map<string, number>()
  for (const draft of drafts) {
    if (!isMaterialKind(draft.kind)) {
      continue
    }
    const numbered = draft.label.match(/^(.+?)\s*(\d+)$/)
    if (numbered) {
      const key = numbered[1].trim()
      counters.set(key, Math.max(counters.get(key) ?? 0, Number.parseInt(numbered[2], 10)))
    }
  }

  const anchors: DialogueAnchor[] = drafts.map((draft, index) => {
    let { label } = draft
    if (isMaterialKind(draft.kind) && !/\d/.test(label)) {
      const next = (counters.get(label) ?? 0) + 1
      counters.set(label, next)
      label = `${label} ${next}`
    }

    return {
      id: `da-${index + 1}`,
      kind: draft.kind,
      // 兜底标签用可读中文：直接落回 kind 会在锚点条上显示成 "question-range" 这种词
      // （实测 17 门课 20 处，都是"没有报头行可并"的说明段续行）。见 FALLBACK_LABELS。
      label: label || FALLBACK_LABELS[draft.kind] || draft.kind,
      start: draft.start,
      // end 先占位为本锚点最后一行的结束；下面统一改为「下一个锚点开始」。
      end: draft.lastLine.end,
      lineIds: [...draft.lineIds],
    }
  })

  for (let index = 0; index < anchors.length - 1; index += 1) {
    anchors[index].end = Math.max(anchors[index].end, anchors[index + 1].start)
  }

  // 同名节次锚点去重：有些音频开头会先念一遍节名总览
  // （"In this part, there are three sections. You will hear two long conversations
  //  in section A, two passages in section B, and three lectures or talks in Section C."），
  // 于是「Section A / Section C」会和后面真正的节次报头重名，锚点条上多出同名按钮
  // （实测 #43 就是这样；已确认那段确有语音，不是幻觉）。
  // 保留最后一个（那才是真正的节次起点），把前面那块的 lineIds **并入**它——
  // 绝不能直接丢弃：丢弃会让那几行不在任何锚点的 lineIds 里，从而漏进逐句精听。
  const lastIndexByLabel = new Map<string, number>()
  anchors.forEach((anchor, index) => {
    if (anchor.kind === 'section' || anchor.kind === 'text') {
      lastIndexByLabel.set(anchor.label, index)
    }
  })
  const startById = new Map<string, number>()
  for (const line of sorted) startById.set(line.id, line.start)
  const deduped: DialogueAnchor[] = []
  anchors.forEach((anchor, index) => {
    const last = lastIndexByLabel.get(anchor.label)
    if ((anchor.kind === 'section' || anchor.kind === 'text') && last !== undefined && last !== index) {
      // 合并后按时间排序，避免分组标题里出现乱序文本
      anchors[last].lineIds = [...new Set([...anchors[last].lineIds, ...anchor.lineIds])]
        .sort((left, right) => (startById.get(left) ?? 0) - (startById.get(right) ?? 0))
      return
    }
    deduped.push(anchor)
  })
  // 去重后原 id 会留空洞，重新连续编号
  deduped.forEach((anchor, index) => {
    anchor.id = `da-${index + 1}`
  })

  // 题号锚点的重叠合并：题干句链在内容行处断开后，会新起一个与前面区间
  // 指令重叠的题号锚点（如「Q16–18」之后题干句又扩出同名块；#14/#24/#28 实测）。
  // 保留先出现者（区间指令句在题组开头，点击跳转语义正确），后续重叠块的
  // lineIds 并入它，标签取两者区间的并集（锚点覆盖完整性优先）。
  const mergedRanges: DialogueAnchor[] = []
  for (const anchor of deduped) {
    const previous = mergedRanges[mergedRanges.length - 1]
    if (
      anchor.kind === 'question-range' &&
      previous?.kind === 'question-range'
    ) {
      const a = parseQuestionRangeLabel(previous.label)
      const b = parseQuestionRangeLabel(anchor.label)
      if (a && b && b.first <= a.last && a.first <= b.last) {
        previous.lineIds = [...new Set([...previous.lineIds, ...anchor.lineIds])]
          .sort(
            (left, right) =>
              (startById.get(left) ?? 0) - (startById.get(right) ?? 0),
          )
        previous.end = Math.max(previous.end, anchor.end)
        const first = Math.min(a.first, b.first)
        const last = Math.max(a.last, b.last)
        previous.label =
          first === last
            ? a.cjk || b.cjk
              ? `第${first}题`
              : `Q${first}`
            : a.cjk || b.cjk
              ? `第${first}–${last}题`
              : `Q${first}–${last}`
        continue
      }
    }
    mergedRanges.push(anchor)
  }

  return mergedRanges.filter(
    (anchor) =>
      Number.isFinite(anchor.start) &&
      Number.isFinite(anchor.end) &&
      anchor.end >= anchor.start,
  )
}

/** 找到某一时刻所处的锚点（用于播放时高亮当前对话区间）。 */
export const findDialogueAnchorAtTime = (
  anchors: readonly DialogueAnchor[],
  time: number,
): DialogueAnchor | null =>
  anchors.find((anchor) => time >= anchor.start && time < anchor.end) ?? null
