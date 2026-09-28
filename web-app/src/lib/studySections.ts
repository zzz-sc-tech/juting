import type { DialogueAnchor, TranscriptLine } from '@juting/shared'

/**
 * 精听内容的「锚点分组」：指令行（Section/Conversation/Passage/Recording 报头、
 * Directions 介绍、Question 题干播报）不作为学习句子，只作为分组标签固定；
 * 正文句按所属锚点归组，句列表按组折叠，避免长真题上百句滚动不过来。
 */
export type StudySection = {
  /** 组 id：锚点 id；首锚点之前的开场组固定为 'lead'。 */
  id: string
  /** 组对应的锚点；开场组为 null。 */
  anchor: DialogueAnchor | null
  label: string
  /** 该组指令行原文（介绍/题干播报），折叠列表展开时以弱化样式展示。 */
  introText: string
  /** 该组的正文句（不含指令行）。 */
  lines: TranscriptLine[]
}

export const buildStudySections = (
  fullLines: readonly TranscriptLine[],
  anchors: readonly DialogueAnchor[],
  studyLines: readonly TranscriptLine[],
  leadLabel: string,
): StudySection[] => {
  const ordered = [...anchors].sort((left, right) => left.start - right.start)
  const fullTextById = new Map(fullLines.map((line) => [line.id, line.text]))

  // 预建全部组（开场组在最前，锚点组按时间序），保证顺序稳定。
  const lead: StudySection = {
    id: 'lead',
    anchor: null,
    label: leadLabel,
    introText: '',
    lines: [],
  }
  const byId = new Map<string, StudySection>([['lead', lead]])
  const orderedSections: StudySection[] = [lead]
  for (const anchor of ordered) {
    const section: StudySection = {
      id: anchor.id,
      anchor,
      label: anchor.label,
      introText: anchor.lineIds
        .map((id) => fullTextById.get(id) ?? '')
        .filter(Boolean)
        .join(' / '),
      lines: [],
    }
    byId.set(anchor.id, section)
    orderedSections.push(section)
  }

  // 正文句归组：属于「起始位置 ≤ 句 start 的最后一个锚点」；首锚点之前归开场组。
  const sectionOf = (start: number): StudySection => {
    let current = lead
    for (const anchor of ordered) {
      if (anchor.start <= start + 1e-6) {
        current = byId.get(anchor.id) ?? lead
      } else {
        break
      }
    }
    return current
  }

  for (const line of studyLines) {
    sectionOf(line.start).lines.push(line)
  }

  return orderedSections
}
