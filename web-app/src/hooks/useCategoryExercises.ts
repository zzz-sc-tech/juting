import { useCallback, useState } from 'react'
import type { CatalogExerciseSummary, ContentLocale } from '@juting/domain'
import { apiClient } from '../lib/apiClient'

// 模块级缓存 + 进行中请求去重：课程摘要跨组件实例共享
// （学习页与仪表盘曾各自整预取一遍全部系列）。
const exercisesCache = new Map<string, CatalogExerciseSummary[]>()
const inflightRequests = new Map<string, Promise<CatalogExerciseSummary[]>>()

export function useCategoryExercises(contentLocale?: ContentLocale, authToken?: string) {
  const [exercisesByCategory, setExercisesByCategory] = useState<
    Record<string, CatalogExerciseSummary[]>
  >({})
  const [loadingCategoryId, setLoadingCategoryId] = useState<number | null>(null)

  const cacheKeyOf = useCallback(
    (categoryId: number) =>
      `${categoryId}:${contentLocale ?? 'default'}:${authToken ?? 'anonymous'}`,
    [authToken, contentLocale],
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

    let request = inflightRequests.get(cacheKey)
    if (!request) {
      request = apiClient
        .getCategoryExercises(categoryId, contentLocale, authToken)
        .then((exercises) => {
          exercisesCache.set(cacheKey, exercises)
          inflightRequests.delete(cacheKey)
          return exercises
        })
      inflightRequests.set(cacheKey, request)
    }

    setLoadingCategoryId(categoryId)
    try {
      const exercises = await request
      setExercisesByCategory((prev) => ({
        ...prev,
        [categoryId]: exercises,
      }))
      return exercises
    } finally {
      setLoadingCategoryId(null)
    }
  }, [authToken, cacheKeyOf, contentLocale])

  const getCachedExercises = useCallback((categoryId: number) => {
    return exercisesCache.get(cacheKeyOf(categoryId))
  }, [cacheKeyOf])

  return {
    exercisesByCategory,
    loadingCategoryId,
    loadExercises,
    getCachedExercises,
  }
}
