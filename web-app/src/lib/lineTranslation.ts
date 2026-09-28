import type { ContentLocale, TranscriptLine } from '@juting/shared'

/**
 * 行译文解析：权威数据在 translations[contentLocale]（后端按学习内容语言回传），
 * 旧 translation 字段仅作未升级数据的兜底。两处都为空、或译文与原文相同
 * （接口把原文回填进译文的情况）时返回空串，调用方据此隐藏译文层。
 */
export const resolveLineTranslation = (
  line: TranscriptLine,
  contentLocale: ContentLocale,
): string => {
  const localized = line.translations?.[contentLocale]
  if (localized && localized.trim() && localized !== line.text) {
    return localized
  }
  if (line.translation && line.translation.trim() && line.translation !== line.text) {
    return line.translation
  }
  return ''
}
