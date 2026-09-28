import type { ContentLocale, LocalizedDirectoryContent, LocalizedExerciseContent } from '@juting/shared'

type DirectoryText = { name: string; description?: string; localizations?: Partial<Record<ContentLocale, LocalizedDirectoryContent>> }
type CourseText = { title: string; summary?: string; localizations?: Partial<Record<ContentLocale, LocalizedExerciseContent>> }

// Display-only resolution: English lives in the base fields. Never feed these labels back into edit forms.
export function directoryName(item: DirectoryText | undefined, locale: ContentLocale): string {
  return (locale === 'en-US' ? undefined : item?.localizations?.[locale]?.name?.trim()) || item?.name || ''
}
export function directoryDescription(item: DirectoryText | undefined, locale: ContentLocale): string {
  return (locale === 'en-US' ? undefined : item?.localizations?.[locale]?.description?.trim()) || item?.description || ''
}
export function courseTitle(item: CourseText | undefined, locale: ContentLocale): string {
  return (locale === 'en-US' ? undefined : item?.localizations?.[locale]?.title?.trim()) || item?.title || ''
}

