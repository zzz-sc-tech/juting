import { VOCAB_DICT, VOCAB_FORM_MAP, type VocabEntry } from './generated/vocabDict'

export type { VocabEntry }

/**
 * 点词查词典的运行时查词（纯函数，无 IO）。
 *
 * 数据是构建期生成的（scripts/content/gen-vocab-dict.mjs）：
 * VOCAB_DICT 按头词收录（本库 38 课出现的词），VOCAB_FORM_MAP 是精确的
 * 词形→头词映射。这里做三级回退，保证「点到的任何词形」都能查到：
 *   1. 原词形（含本身是词条的常见词形）；
 *   2. VOCAB_FORM_MAP 精确映射（boxes→box，构建期用 ECDICT exchange 解析）；
 *   3. 启发式还原兜底（查不到映射的手输词，如复数/时态后缀）。
 */
const normalize = (raw: string): string => raw.toLowerCase().replace(/['’]/g, '')

const heuristicCandidates = (form: string): string[] => {
  const out = [form]
  const add = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s)
  }
  if (form.endsWith('ies') && form.length > 4) add(form.slice(0, -3) + 'y')
  if (form.endsWith('es') && form.length > 3) {
    add(form.slice(0, -2))
    add(form.slice(0, -1))
  } else if (form.endsWith('s') && !form.endsWith('ss') && form.length > 2) {
    add(form.slice(0, -1))
  }
  if (form.endsWith('ied') && form.length > 4) add(form.slice(0, -3) + 'y')
  if (form.endsWith('ed') && form.length > 3) {
    add(form.slice(0, -1))
    const doubled = /^(.*[bcdfglmnprstz])\1ed$/.exec(form)
    if (doubled) add(doubled[1])
    add(form.slice(0, -2))
  }
  if (form.endsWith('ing') && form.length > 4) {
    add(form.slice(0, -3) + 'e')
    const doubled = /^(.*[bcdfglmnprstz])\1ing$/.exec(form)
    if (doubled) add(doubled[1])
    add(form.slice(0, -3))
  }
  if (form.endsWith('ly') && form.length > 3) add(form.slice(0, -2))
  if (form.endsWith('er') && form.length > 3) add(form.slice(0, -2))
  if (form.endsWith('est') && form.length > 4) add(form.slice(0, -3))
  return out
}

/**
 * 缩写还原（键是去撇号后的形态，因为 normalize 已把撇号去掉）。
 * ECDICT 只有原形，听力文本里却是缩写——不还原的话 don't/can't/isn't
 * 全都查不到，而它们恰恰是点得最多的词。专有名词所有格（Kodak's）
 * 不在表内，仍按「未收录」优雅降级。
 */
const CONTRACTIONS: Record<string, string> = {
  arent: 'be',
  wasnt: 'be',
  werent: 'be',
  isnt: 'be',
  aint: 'be',
  im: 'i',
  ive: 'i',
  dont: 'do',
  doesnt: 'do',
  didnt: 'do',
  hasnt: 'have',
  havent: 'have',
  hadnt: 'have',
  wont: 'will',
  wouldnt: 'will',
  cant: 'can',
  couldnt: 'can',
  shouldnt: 'should',
  mustnt: 'must',
  neednt: 'need',
  thatll: 'will',
  itll: 'it',
  theyll: 'they',
  wed: 'we',
  weve: 'we',
  youre: 'you',
  youve: 'you',
  youll: 'you',
  youd: 'you',
  theyre: 'they',
  theyve: 'they',
  theyd: 'they',
  hed: 'he',
  whos: 'who',
  whove: 'who',
  thats: 'that',
  theres: 'there',
  whats: 'what',
  wheres: 'where',
  // 转写里单独的撇号词元（didn' / doesn'），去撇号后就是这些形态
  aren: 'be',
  weren: 'be',
  isn: 'be',
  wasn: 'be',
  doesn: 'do',
  didn: 'do',
  wouldn: 'will',
  couldn: 'can',
  shouldn: 'should',
  hadn: 'have',
  haven: 'have',
  hasn: 'have',
  won: 'will',
}

export const lookupVocab = (raw: string): VocabEntry | undefined => {
  const word = normalize(raw)
  const hit = (key: string): VocabEntry | undefined =>
    VOCAB_DICT[key] ?? VOCAB_DICT[VOCAB_FORM_MAP[key] ?? '']
  const direct = hit(word)
  if (direct) return direct
  for (const candidate of heuristicCandidates(word)) {
    const found = hit(candidate)
    if (found) return found
  }
  const contracted = hit(CONTRACTIONS[word] ?? '')
  return contracted
}
