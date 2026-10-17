import { useCallback, useState } from 'react'
import type { CatalogExerciseSummary, ContentLocale } from '@juting/domain'
import { apiClient } from '../lib/apiClient'

// 模块级缓存 + 进行中请求去重：课程摘要跨组件实例共享
// （学习页与仪表盘曾各自整预取一遍全部系列）。
const exercisesCache = new Map<string, CatalogExerciseSummary[]>()
const inflightRequests = new Map<string, Promise<CatalogExerciseSummary[]>>()

/**
 * 单语产品固定 zh-CN：不传 locale 与传 'zh-CN' 归一到同一个键，
 * 否则「仪表盘 default 键 / 学习页 zh-CN 键」永远不命中（D1）。
 */
const EFFECTIVE_LOCALE: ContentLocale = 'zh-CN'

/**
 * 共享的课程列表请求（带模块级缓存与并发去重）。
 * 导出给 lib/catalogBundle 用，保证「目录包」与 hook 命中同一份缓存。
 */
export function requestCategoryExercises(
  categoryId: number,
  contentLocale?: ContentLocale,
  authToken?: string,
): Promise<CatalogExerciseSummary[]> {
  const locale = contentLocale ?? EFFECTIVE_LOCALE
  const cacheKey = `${categoryId}:${locale}:${authToken ?? 'anonymous'}`
  const cached = exercisesCache.get(cacheKey)
  if (cached) {
    return Promise.resolve(cached)
  }
  let request = inflightRequests.get(cacheKey)
  if (!request) {
    request = apiClient
      // view=summary：列表只带列表渲染需要的字段，
      // questions/answerKey/localizations 留在详情接口（C2）
      .getCategoryExercises(categoryId, locale, authToken, 'summary')
      .then((exercises) => {
        exercisesCache.set(cacheKey, exercises)
        inflightRequests.delete(cacheKey)
        return exercises
      })
      .catch((error: unknown) => {
        inflightRequests.delete(cacheKey)
        throw error
      })
    inflightRequests.set(cacheKey, request)
  }
  return request
}

export function useCategoryExercises(contentLocale?: ContentLocale, authToken?: string) {
  const locale = contentLocale ?? EFFECTIVE_LOCALE
  const [exercisesByCategory, setExercisesByCategory] = useState<
    Record<string, CatalogExerciseSummary[]>
  >({})

  const cacheKeyOf = useCallback(
    (categoryId: number) => `${categoryId}:${locale}:${authToken ?? 'anonymous'}`,
    [authToken, locale],
  )

  const loadExercises = useCallback(async (categoryId: number) => {
    const cacheKey = cacheKeyOf(categoryId)
    // 缓存命中也要回写本实例状态：新挂载的实例（如仪表盘）靠它填充自己的 map。
    const cached = exercisesCache.get(cacheKey)
    if (cached) {
      setExercisesByCategory((prev) => ({
        ...prev,
        [categoryId]: cached,
      }))
      return cached
    }

    const exercises = await requestCategoryExercises(categoryId, locale, authToken)
    setExercisesByCategory((prev) => ({
      ...prev,
      [categoryId]: exercises,
    }))
    return exercises
  }, [authToken, cacheKeyOf, locale])

  const getCachedExercises = useCallback((categoryId: number) => {
    return exercisesCache.get(cacheKeyOf(categoryId))
  }, [cacheKeyOf])

  return {
    exercisesByCategory,
    loadExercises,
    getCachedExercises,
  }
}
