import { useCallback, useEffect, useState } from 'react'
import type { CatalogExerciseSummary, ContentLocale } from '@juting/domain'
import { apiClient } from '../lib/apiClient'
import { useCatalog } from './useCatalog'

/**
 * 专项刷题的数据源：需要「完整摘要」（含 questions / answerKey），
 * 而出题只需要题库，不依赖逐句字幕——字幕（题干时间轴）由页面在出题那一刻
 * 单独取详情，避免一进页面就拉 38 门课的字幕。
 *
 * 注意：不要复用 useCategoryExercises —— 它带 view=summary，
 * questions/answerKey 是详情级字段，那条路径拿到的题池永远是空的。
 */
const EFFECTIVE_LOCALE: ContentLocale = 'zh-CN'

const exercisesCache = new Map<number, CatalogExerciseSummary[]>()
const inflight = new Map<number, Promise<CatalogExerciseSummary[]>>()

const fetchFullExercises = (categoryId: number): Promise<CatalogExerciseSummary[]> => {
  const cached = exercisesCache.get(categoryId)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(categoryId)
  if (running) return running
  const request = apiClient
    .getCategoryExercises(categoryId, EFFECTIVE_LOCALE)
    .then((list) => {
      exercisesCache.set(categoryId, list)
      inflight.delete(categoryId)
      return list
    })
    .catch((error: unknown) => {
      inflight.delete(categoryId)
      throw error
    })
  inflight.set(categoryId, request)
  return request
}

type DrillDataStatus = 'loading' | 'ready' | 'error'

export function useDrillData() {
  const { catalog, catalogLoadFailed, catalogLoading, reload: reloadCatalog } = useCatalog()
  const [exercises, setExercises] = useState<CatalogExerciseSummary[]>([])
  const [status, setStatus] = useState<DrillDataStatus>('loading')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (catalogLoading) return
    if (catalogLoadFailed) {
      setStatus('error')
      return
    }
    const categories = catalog.categories
    if (categories.length === 0) {
      // 目录回来了但一门课都没有：不是加载中，是空题库
      setExercises([])
      setStatus('ready')
      return
    }
    let mounted = true
    setStatus('loading')
    // 用 allSettled：某一门课的摘要挂了，其他课的题照样能练——
    // 专项刷题的题池是「越多越好」，没有理由为了一门课把整页打成错误态
    Promise.allSettled(categories.map((category) => fetchFullExercises(category.id)))
      .then((results) => {
        if (!mounted) return
        const lists = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        )
        if (lists.length === 0) {
          setStatus('error')
          return
        }
        setExercises(lists.flat())
        setStatus('ready')
      })
      .catch(() => {
        if (!mounted) return
        setStatus('error')
      })
    return () => {
      mounted = false
    }
  }, [catalog.categories, catalogLoadFailed, catalogLoading, nonce])

  const reload = useCallback(() => {
    exercisesCache.clear()
    inflight.clear()
    setExercises([])
    setStatus('loading')
    reloadCatalog()
    setNonce((value) => value + 1)
  }, [reloadCatalog])

  return { exercises, status, reload }
}
