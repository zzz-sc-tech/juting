/**
 * 句子切词（点词查词典的纯函数）。
 *
 * 渲染不能丢字符：标点与空白原样作为 gap 输出，只把词形标成可点片段。
 * 连字符留在词内（full-time 是一个词），与词表口径一致——
 * 否则 coca-cola 只能点开 "cola" 这种碎片，coca / cola 反而查不到。
 * 撇号同样留在词内（don't 是一个词）。
 */
export type SentencePart = { type: 'word' | 'gap'; text: string }

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g

export const splitClickableWords = (text: string): SentencePart[] => {
  const parts: SentencePart[] = []
  let cursor = 0
  for (const match of text.matchAll(WORD_RE)) {
    const start = match.index ?? 0
    if (start > cursor) {
      parts.push({ type: 'gap', text: text.slice(cursor, start) })
    }
    parts.push({ type: 'word', text: match[0] })
    cursor = start + match[0].length
  }
  if (cursor < text.length) {
    parts.push({ type: 'gap', text: text.slice(cursor) })
  }
  return parts
}