import { Layout } from 'antd'
import { useCallback, useState } from 'react'
import { useCatalogActions } from '../hooks/content-workspace/useCatalogActions'
import { useImporterNavigation } from '../hooks/content-workspace/useImporterNavigation'
import { useWorkspaceData } from '../hooks/content-workspace/useWorkspaceData'
import { useAdminLanguage } from '../i18n/AdminLanguageProvider'
import { apiClient } from '../lib/apiClient'
import { AudioLessonImporter } from './AudioLessonImporter'
import type { AdminNoticeTone } from './admin/AdminFeedback'
import { AdminWorkspaceNav } from './admin/AdminWorkspaceNav'
import { CourseManager } from './admin/CourseManager'
import { DirectoryManager } from './admin/DirectoryManager'
import type { ContentAdminProps } from './admin/content-workspace/types'

export function ContentAdmin({
  adminToken,
  categoryGroups,
  categories,
  exercises,
  onRefreshCatalog,
  onEnsureCatalog,
  onEnsureExercises,
  onNotify,
  adminUser,
  onLogout,
  onRegisterBeforeLogout,
  onRequestConfirm,
  onRequestUnsavedLeaveConfirm,
}: ContentAdminProps) {
  const { t } = useAdminLanguage()
  const localizedNotify = useCallback((message: string, tone?: AdminNoticeTone) => {
    onNotify(t(message), tone)
  }, [onNotify, t])
  const {
    activeSection,
    importerDraft,
    setImporterDraft,
    setImporterHasUnsavedChanges,
    saveImporterBeforeLeaveRef,
    changeSection,
    openImporterForCategory,
    openImporterForExercise,
  } = useImporterNavigation({
    adminUser,
    categories,
    exercises,
    onRequestConfirm,
    onRequestUnsavedLeaveConfirm,
    onRegisterBeforeLogout,
  })
  const {
    categoryForm,
    setCategoryForm,
    categoryGroupForm,
    setCategoryGroupForm,
    isSaving,
    saveCategoryGroup,
    saveCategory,
    deleteCategoryGroup,
    deleteCategory,
    moveCategoryGroup,
    moveCategory,
    deleteCourse,
    moveCourse,
  } = useCatalogActions({
    adminToken,
    categoryGroups,
    categories,
    onRefreshCatalog,
    onEnsureExercises,
    onRequestConfirm,
    localizedNotify,
  })
  const {
    isCatalogLoading,
    catalogLoadError,
    refreshWorkspaceCatalog,
  } = useWorkspaceData({
    adminToken,
    exercises,
    onEnsureCatalog,
    onEnsureExercises,
    localizedNotify,
    activeSection,
  })

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)

  return (
    <>
      <Layout className="admin-workspace-layout" hasSider>
        <Layout.Sider
          breakpoint="lg"
          collapsed={isSidebarCollapsed}
          collapsedWidth={72}
          collapsible
          onCollapse={setIsSidebarCollapsed}
          trigger={null}
          width={248}
          theme="light"
        >
          <AdminWorkspaceNav
            activeSection={activeSection}
            adminUser={adminUser}
            collapsed={isSidebarCollapsed}
            onCollapsedChange={setIsSidebarCollapsed}
            onLogout={onLogout}
            onSectionChange={(section) => void changeSection(section)}
          />
        </Layout.Sider>
        <Layout.Content className="admin-workspace-content" aria-label={t('内容管理')}>

      {activeSection === 'importer' && (
        <AudioLessonImporter
          adminToken={adminToken}
          categoryGroups={categoryGroups}
          categories={categories}
          exercises={exercises}
          draft={importerDraft}
          onRefreshCatalog={onRefreshCatalog}
          onStatusChange={localizedNotify}
          onDraftConsumed={() => setImporterDraft(null)}
          onUnsavedChangesChange={setImporterHasUnsavedChanges}
          onRegisterSaveBeforeLeave={(handler) => {
            saveImporterBeforeLeaveRef.current = handler
          }}
          adminRole={adminUser.role}
        />
      )}

      {activeSection === 'directory' && (
        <DirectoryManager
          adminToken={adminToken}
          categoryGroups={categoryGroups}
          categories={categories}
          categoryGroupForm={categoryGroupForm}
          categoryForm={categoryForm}
          isSaving={isSaving}
          onNotify={localizedNotify}
          onCategoryGroupFormChange={setCategoryGroupForm}
          onCategoryFormChange={setCategoryForm}
          onSaveCategoryGroup={saveCategoryGroup}
          onSaveCategory={saveCategory}
          onEditCategoryGroup={setCategoryGroupForm}
          onEditCategory={setCategoryForm}
          onDeleteCategoryGroup={deleteCategoryGroup}
          onDeleteCategory={deleteCategory}
          onMoveCategoryGroup={moveCategoryGroup}
          onMoveCategory={moveCategory}
          onRefresh={onRefreshCatalog}
          onRequestConfirm={onRequestConfirm}
        />
      )}

      {activeSection === 'courses' && (
        <CourseManager
          adminToken={adminToken}
          categoryGroups={categoryGroups}
          categories={categories}
          isCatalogLoading={isCatalogLoading}
          catalogLoadError={catalogLoadError}
          onRefreshCatalog={refreshWorkspaceCatalog}
          isSaving={isSaving}
          onCreateCourse={(categoryId) => {
            void openImporterForCategory(categoryId)
          }}
          onEditCourse={(exercise) => {
            void openImporterForExercise(exercise)
          }}
          onDeleteCourse={deleteCourse}
          onMoveCourse={moveCourse}
          onRenameCourse={async (exercise, title) => {
            try {
              await apiClient.createExercise(
                {
                  id: exercise.id,
                  categoryId: exercise.categoryId,
                  title,
                  source: exercise.source,
                  sourceUrl: exercise.sourceUrl,
                  difficulty: exercise.difficulty,
                  durationLabel: exercise.durationLabel,
                  mediaType: exercise.mediaType,
                  audioUrl: exercise.audioUrl,
                  coverImageUrl: exercise.coverImageUrl,
                  summary: exercise.summary,
                  sortOrder: exercise.sortOrder,
                  // 透传原状态，避免把 archived 课程改回 published
                  status: exercise.status,
                },
                adminToken,
              )
              await onRefreshCatalog()
              localizedNotify('课程名称已更新', 'success')
            } catch (error) {
              localizedNotify(error instanceof Error ? error.message : '课程名称更新失败', 'error')
              throw error
            }
          }}
          canManageCourses={adminUser.role === 'super_admin'}
          onNotify={localizedNotify}
        />
      )}
        </Layout.Content>
      </Layout>
    </>
  )
}
