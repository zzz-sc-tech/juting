import { useCallback, useEffect, useState } from 'react'
import type { CatalogResponse } from '@juting/domain'
import { apiClient } from '../lib/apiClient'
import type { ContentLocale } from '@juting/domain'

const emptyCatalog: CatalogResponse = {
  categoryGroups: [],
  categories: [],
  exercises: [],
}

export function useCatalog(contentLocale?: ContentLocale, authToken?: string) {
  const [catalog, setCatalog] = useState<CatalogResponse>(emptyCatalog)
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)

  const reload = useCallback(() => setReloadNonce((value) => value + 1), [])

  useEffect(() => {
    let mounted = true

    apiClient
      .getCatalog(contentLocale, authToken)
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
  }, [authToken, contentLocale, reloadNonce])

  return {
    catalog,
    reload,
    catalogLoadFailed,
  }
}
