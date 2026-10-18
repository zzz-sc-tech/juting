import { useCallback, useEffect, useState } from 'react'
import type { CatalogResponse } from '@juting/domain'
import { apiClient } from '../lib/apiClient'
import type { ContentLocale } from '@juting/domain'

const emptyCatalog: CatalogResponse = {
  categoryGroups: [],
  categories: [],
  exercises: [],
}

// 模块级缓存：学习页与仪表盘各自挂载 useCatalog，共享同一份结果/进行中的请求，
// 避免同一份目录被请求两次。失败不留缓存，下次挂载或 reload 自然重试。
type CatalogCacheEntry = {
  data?: CatalogResponse
  promise?: Promise<CatalogResponse>
}
const catalogCache = new Map<string, CatalogCacheEntry>()

/** 供 lib/catalogBundle 复用同一份缓存（导出用，不要在组件里直接调）。 */
export function fetchCatalogCached(
  cacheKey: string,
  contentLocale?: ContentLocale,
  authToken?: string,
) {
  let entry = catalogCache.get(cacheKey)
  if (entry?.data) {
    // 已经拉过：直接复用结果（原先只看 promise，导致「完成后再取」会重新请求）
    return Promise.resolve(entry.data)
  }
  if (entry?.promise) {
    return entry.promise
  }

  const promise = apiClient
    .getCatalog(contentLocale, authToken)
    .then((remoteCatalog) => {
      catalogCache.set(cacheKey, { data: remoteCatalog })
      return remoteCatalog
    })
    .catch((error: unknown) => {
      catalogCache.delete(cacheKey)
      throw error
    })
  entry = { promise }
  catalogCache.set(cacheKey, entry)
  return promise
}

/**
 * 单语产品：界面与内容恒为 zh-CN。
 *
 * 缓存键归一的关键：仪表盘传 `undefined`、学习页传 `'zh-CN'`，如果各自成键，
 * 同一份目录会被请求两次且永不命中（D1）。这里把两者统一成 zh-CN——
 * 既归一了缓存键，也让请求 URL 一致。
 */
const EFFECTIVE_LOCALE: ContentLocale = 'zh-CN'

export function useCatalog(contentLocale?: ContentLocale, authToken?: string) {
  const locale = contentLocale ?? EFFECTIVE_LOCALE
  const cacheKey = `${locale}:${authToken ?? 'anonymous'}`
  const [catalog, setCatalog] = useState<CatalogResponse>(
    () => catalogCache.get(cacheKey)?.data ?? emptyCatalog,
  )
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false)
  // 没有 loading 标志时，请求还没回来就先渲染「暂无课程 / 请先在管理端添加」，
  // 网慢的用户会以为数据被清了（I-02）。
  const [catalogLoading, setCatalogLoading] = useState(
    () => !catalogCache.get(cacheKey)?.data,
  )
  const [reloadNonce, setReloadNonce] = useState(0)

  const reload = useCallback(() => {
    catalogCache.delete(cacheKey)
    setReloadNonce((value) => value + 1)
  }, [cacheKey])

  useEffect(() => {
    const cached = catalogCache.get(cacheKey)
    if (cached?.data) {
      setCatalog(cached.data)
      setCatalogLoadFailed(false)
      setCatalogLoading(false)
      return
    }

    let mounted = true
    setCatalogLoading(true)

    fetchCatalogCached(cacheKey, locale, authToken)
      .then((remoteCatalog) => {
        if (!mounted) {
          return
        }

        setCatalog(remoteCatalog)
        setCatalogLoadFailed(false)
        setCatalogLoading(false)
      })
      .catch(() => {
        if (!mounted) {
          return
        }

        setCatalogLoadFailed(true)
        setCatalogLoading(false)
      })

    return () => {
      mounted = false
    }
  }, [authToken, cacheKey, locale, reloadNonce])

  return {
    catalog,
    reload,
    catalogLoadFailed,
    catalogLoading,
  }
}
