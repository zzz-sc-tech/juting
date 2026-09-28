import { useCallback, useEffect, useState } from 'react'
import { type AdminSection } from '../../components/admin/AdminWorkspaceNav'
import { useAdminLanguage } from '../../i18n/AdminLanguageProvider'
import type { ContentAdminProps } from '../../components/admin/content-workspace/types'

type WorkspaceDataOptions = Pick<ContentAdminProps, 'adminToken' | 'exercises' | 'onEnsureCatalog' | 'onEnsureExercises'> & {
  localizedNotify: ContentAdminProps['onNotify']
  activeSection: AdminSection
}

// 单机版工作区数据：只剩目录加载与课程列表补载。
// 上游的协同待办、站内通知、反馈中心与增长分析数据源已随协同体系移除。
export function useWorkspaceData({
  onEnsureCatalog,
  onEnsureExercises,
  localizedNotify,
  activeSection,
}: WorkspaceDataOptions) {
  const { t } = useAdminLanguage()

  const [isCatalogLoading, setIsCatalogLoading] = useState(false)
  const [catalogLoadError, setCatalogLoadError] = useState('')

  const refreshWorkspaceCatalog = useCallback(async () => {
    setIsCatalogLoading(true)
    setCatalogLoadError('')
    try {
      await onEnsureCatalog()
    } catch (error) {
      const message = error instanceof Error ? error.message : t('目录数据加载失败')
      setCatalogLoadError(message)
      localizedNotify(message, 'error')
      throw error
    } finally {
      setIsCatalogLoading(false)
    }
  }, [localizedNotify, onEnsureCatalog, t])

  useEffect(() => {
    void refreshWorkspaceCatalog().catch(() => undefined)
  }, [activeSection, refreshWorkspaceCatalog])

  useEffect(() => {
    // 制课工作台按“内容分类 → 学习系列 → 课程”逐级选择，需要完整课程列表。
    if (activeSection !== 'importer') {
      return
    }

    void onEnsureExercises().catch((error) => {
      localizedNotify(error instanceof Error ? error.message : '课程数据加载失败', 'error')
    })
  }, [activeSection, onEnsureExercises, localizedNotify])

  return {
    isCatalogLoading,
    catalogLoadError,
    refreshWorkspaceCatalog,
  }
}
