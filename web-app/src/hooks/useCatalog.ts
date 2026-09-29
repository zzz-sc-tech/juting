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

function fetchCatalogCached(cacheKey: string, contentLocale?: ContentLocale, authToken?: string) {
  let entry = catalogCache.get(cacheKey)
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

export function useCatalog(contentLocale?: ContentLocale, authToken?: string) {
  const cacheKey = `${contentLocale ?? 'default'}:${authToken ?? 'anonymous'}`
  const [catalog, setCatalog] = useState<CatalogResponse>(
    () => catalogCache.get(cacheKey)?.data ?? emptyCatalog,
  )
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false)
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
      return
    }

    let mounted = true

    fetchCatalogCached(cacheKey, contentLocale, authToken)
      .then((remoteCatalog) => {
        if (!mounted) {
          return
        }

        setCatalog(remoteCatalog)
        setCatalogLoadFailed(false)
      })
      .catch(() => {
        if (!mounted) {
          return
        }

        setCatalogLoadFailed(true)
      })

    return () => {
      mounted = false
    }
  }, [authToken, cacheKey, contentLocale, reloadNonce])

  return {
    catalog,
    reload,
    catalogLoadFailed,
  }
}
