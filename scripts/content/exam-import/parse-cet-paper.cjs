// 从「英语真题在线」的试卷 PDF 文本里抽听力 1–25 题的题干与选项。
// 版式不统一，踩过的坑都写在注释里：
//   · 题号标点有 "."、"．"、"、" 三种；选项标号有 "A)"、"A."、"A）"
//   · 2015 年卷是两栏（A、C 同行），2016 年卷多是单栏（一行一个）
//   · 2015 年卷 Section C 是听写（26–35 填空），2016 年卷 Section C 仍是选择题（16–25）
//   · 个别卷子丢了 "Listening Comprehension" 标题、丢了题号、甚至把 25 题标成 24 题
const clean = (text) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/([A-Za-z])5(?=\s|$)/g, "$1'") // OCR：speakers5 → speakers'
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim()

const QUESTION_START = /^\s*(\d{1,2})\s*[.．、]\s*(?=[A-D]\s*[).）])/
const SECTION_HEAD = /^Section\s+[ABC]\b/i
const NOISE =
  /^(Directions|注意|Questions?\s*\d|Passage\s+\w+|Part\s+[ⅠⅡⅢⅣVX]|六级真题|大学英语六级考试真题)/i

const isNoise = (line) => {
  const text = line.trim()
  if (!text) return true
  if (/^\d{1,3}$/.test(text)) return true
  if (/六级真题|大学英语六级考试真题/.test(text)) return true
  return NOISE.test(text)
}

const parseListening = (rawText) => {
  const lines = rawText.split(/\r?\n/)
  // 起点：优先 Listening Comprehension 标题；2016 年第 2 套缺这行，退到第一处带「you will hear」的 Section A
  let startIdx = lines.findIndex((line) => /Listening Comprehension/i.test(line))
  if (startIdx < 0) {
    startIdx = lines.findIndex(
      (line, index) =>
        /^Section\s+A\b/i.test(line.trim()) &&
        /you will hear/i.test((lines[index + 1] ?? '') + (lines[index + 2] ?? '')),
    )
  }
  if (startIdx < 0) throw new Error('找不到听力部分')

  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/Part\s+[ⅢIVX]+|Reading Comprehension/i.test(lines[i])) {
      endIdx = i
      break
    }
  }

  const blocks = []
  let current = null
  // 节标题之后到下一道题之前是指令，不能并进上一题的选项
  let inInstruction = false
  for (const line of lines.slice(startIdx, endIdx)) {
    if (SECTION_HEAD.test(line.trim())) {
      current = null
      inInstruction = true
      continue
    }
    const match = QUESTION_START.exec(line)
    if (match) {
      const n = Number(match[1])
      inInstruction = false
      if (n >= 1 && n <= 25) {
        current = { n, text: line.slice(match[0].length) }
        blocks.push(current)
      } else {
        current = null
      }
      continue
    }
    if (inInstruction) continue
    if (current && !isNoise(line)) current.text += '\n' + line
  }

  const parsed = []
  for (const block of blocks) {
    const flat = block.text.replace(/\n/g, ' ')
    const marks = [...flat.matchAll(/(?:^|\s)([A-D])\s*[).．）]\s*/g)].map((m) => ({
      letter: m[1],
      index: m.index + (m[0].startsWith(' ') ? 1 : 0),
    }))
    if (marks.length < 4) continue
    const options = {}
    for (let i = 0; i < 4; i += 1) {
      const mark = marks[i]
      const next = marks[i + 1]
      const body = flat.slice(mark.index, next ? next.index : flat.length)
      options[mark.letter] = clean(body.replace(/^[A-D]\s*[).．）]\s*/, ''))
    }
    parsed.push({ n: block.n, options })
  }

  // 同一题号出现多次（PDF 把 25 题标成 24 题）时：第一次保留，重复的顺延到下一个空号
  const byNumber = new Map()
  for (const question of parsed) {
    let target = question.n
    if (byNumber.has(target)) {
      let next = target + 1
      while (next <= 25 && byNumber.has(next)) next += 1
      if (next > 25) continue
      target = next
    }
    byNumber.set(target, { n: target, options: question.options })
  }
  return [...byNumber.values()].sort((a, b) => a.n - b.n)
}

module.exports = { parseListening, clean }
