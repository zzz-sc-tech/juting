import { directoryName, courseTitle } from '../../lib/localizedContent'
import { ArrowDown, ArrowUp, BookOpen, Copy, Ellipsis, FilePenLine, History, Pencil, Plus, RefreshCw, Search, Send, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Dropdown, Empty, Form, Image, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { CatalogExerciseSummary, ExerciseCategory, ExerciseSubtitleVersion, MaterialCategory } from '@juting/shared'
import { apiClient, resolveApiUrl } from '../../lib/apiClient'
import type { AdminNoticeTone } from './AdminFeedback'
import { BatchCourseImporter } from './BatchCourseImporter'
import { useAdminLanguage } from '../../i18n/AdminLanguageProvider'

type CourseManagerProps = {
  adminToken: string
  categoryGroups: MaterialCategory[]
  categories: ExerciseCategory[]
  isCatalogLoading: boolean
  catalogLoadError: string
  onRefreshCatalog: () => Promise<void>
  isSaving: boolean
  onCreateCourse: (categoryId: number) => void
  onDeleteCourse: (exercise: CatalogExerciseSummary) => void
  onEditCourse: (exercise: CatalogExerciseSummary) => void
  onMoveCourse: (exerciseId: number, direction: 'up' | 'down') => void
  onRenameCourse: (exercise: CatalogExerciseSummary, title: string) => Promise<void>
  canManageCourses?: boolean
  onNotify: (message: string, tone?: AdminNoticeTone) => void
}

type CourseStatus = 'all' | 'draft' | 'proofread' | 'published' | 'archived'

const statusLabels = { draft: '草稿', proofread: '已校对', published: '已发布', archived: '已归档' }
const statusColors = { draft: 'default', proofread: 'processing', published: 'success', archived: 'purple' } as const
const LAST_CATEGORY_STORAGE_KEY = 'duolinting.admin.last-course-category-id'

const formatSubmittedAt = (value: string | undefined, locale: string) => value
  ? new Intl.DateTimeFormat(locale, {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value))
  : ''

/** 字幕时间轴以秒存储；这里格式化成 mm:ss 便于在版本历史里阅读。 */
const formatTimestamp = (seconds: number) => {
  if (!Number.isFinite(seconds)) return ''
  const totalSeconds = Math.floor(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const rest = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${rest}`
}

/** 版本快照按正式 dltjson 2.0 结构输出，完整保留当时提交的每个字幕字段。 */
const versionToDltjson = (version: ExerciseSubtitleVersion) => JSON.stringify({
  version: '2.0',
  type: 'dltjson',
  lines: version.lines,
}, null, 2)

export function CourseManager({
  adminToken, categoryGroups, categories, isCatalogLoading, catalogLoadError, onRefreshCatalog, isSaving, onCreateCourse,
  onDeleteCourse, onEditCourse, onMoveCourse, onRenameCourse, canManageCourses = true, onNotify,
}: CourseManagerProps) {
  const { t, uiLocale } = useAdminLanguage()
  // 筛选器不提供"全部"选项：用户必须选中一个具体系列（目录加载完成前
  // 用 0 表示尚未就绪，此时不发起课程请求）。
  const [selectedGroupId, setSelectedGroupId] = useState<number>(0)
  const [selectedCategoryId, setSelectedCategoryId] = useState<number>(0)
  const [selectedStatus, setSelectedStatus] = useState<CourseStatus>('all')
  const [searchText, setSearchText] = useState('')
  const [renamingExercise, setRenamingExercise] = useState<CatalogExerciseSummary | null>(null)
  const [nextTitle, setNextTitle] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [pagedExercises, setPagedExercises] = useState<CatalogExerciseSummary[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [statusTogglingId, setStatusTogglingId] = useState<number | null>(null)
  const [versionsExercise, setVersionsExercise] = useState<CatalogExerciseSummary | null>(null)
  const [versions, setVersions] = useState<ExerciseSubtitleVersion[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const requestSerialRef = useRef(0)
  const hasRestoredLastCategoryRef = useRef(false)

  const visibleCategories = useMemo(() => categories.filter((category) => category.groupId === selectedGroupId), [categories, selectedGroupId])

  useEffect(() => {
    if (categories.length === 0) return

    if (hasRestoredLastCategoryRef.current && selectedCategoryId && categories.some((category) => category.id === selectedCategoryId)) {
      return
    }

    const storedCategoryId = Number(localStorage.getItem(LAST_CATEGORY_STORAGE_KEY))
    const initialCategory = categories.find((item) => item.id === storedCategoryId) ?? categories[0]
    hasRestoredLastCategoryRef.current = true
    setSelectedCategoryId(initialCategory.id)
    setSelectedGroupId(initialCategory.groupId)
  }, [categories, selectedCategoryId])

  const loadPage = useCallback(async () => {
    const requestSerial = ++requestSerialRef.current
    // 先加载目录并确定系列，再请求该系列课程，避免空筛选请求与目录请求竞态。
    if (categories.length === 0 || !selectedCategoryId) {
      setPagedExercises([])
      setTotal(0)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    try {
      const result = await apiClient.getAdminExercisesPage(adminToken, {
        page,
        pageSize,
        groupId: selectedGroupId,
        categoryId: selectedCategoryId,
        ...(selectedStatus === 'all' ? {} : { status: selectedStatus }),
        ...(searchText.trim() ? { search: searchText } : {}),
      })
      if (requestSerial === requestSerialRef.current) {
        setPagedExercises(result.items)
        setTotal(result.total)
      }
    } finally {
      if (requestSerial === requestSerialRef.current) setIsLoading(false)
    }
  }, [adminToken, categories, page, pageSize, searchText, selectedCategoryId, selectedGroupId, selectedStatus])

  useEffect(() => {
    void loadPage()
  }, [loadPage])

  const createTargetCategoryId = selectedCategoryId || visibleCategories[0]?.id || 0
  const resetFilters = () => {
    const firstCategory = categories[0]
    setSelectedGroupId(firstCategory?.groupId ?? 0)
    setSelectedCategoryId(firstCategory?.id ?? 0)
    setSelectedStatus('all')
    setSearchText('')
    setPage(1)
  }
  const changeGroup = (groupId: number) => {
    setSelectedGroupId(groupId)
    setPage(1)

    const firstCategory = categories.find((item) => item.groupId === groupId)
    setSelectedCategoryId(firstCategory?.id ?? 0)
    if (firstCategory) {
      localStorage.setItem(LAST_CATEGORY_STORAGE_KEY, String(firstCategory.id))
    }
  }
  const changeCategory = (categoryId: number) => {
    setSelectedCategoryId(categoryId)
    setPage(1)
    const category = categories.find((item) => item.id === categoryId)
    if (category) {
      setSelectedGroupId(category.groupId)
      localStorage.setItem(LAST_CATEGORY_STORAGE_KEY, String(category.id))
    }
  }
  const canMove = (exercise: CatalogExerciseSummary, direction: 'up' | 'down') => {
    // 注意：不能用父层全量 exercises 判断——它是按需加载的（仅制课工作台区块），
    // 直接刷新课程管理页时为空，会导致所有排序按钮被误禁用。
    // 这里基于当前分页数据判断；页边界课程的相邻项可能在上一页/下一页，
    // 此时也允许移动（真正交换由 moveCourse 用全量数据完成）。
    const siblings = pagedExercises.filter((item) => item.categoryId === exercise.categoryId).sort((left, right) => left.sortOrder - right.sortOrder)
    const index = siblings.findIndex((item) => item.id === exercise.id)
    if (index < 0) return false
    if (direction === 'up') return index > 0 || page > 1
    return index < siblings.length - 1 || page * pageSize < total
  }
  const openRenameDialog = (exercise: CatalogExerciseSummary) => {
    setRenamingExercise(exercise)
    setNextTitle(exercise.title)
  }
  const saveRename = async () => {
    if (!renamingExercise || !nextTitle.trim()) return
    setIsRenaming(true)
    try {
      await onRenameCourse(renamingExercise, nextTitle.trim())
      setRenamingExercise(null)
    } finally {
      setIsRenaming(false)
    }
  }

  // 单机版发布/下架：直接切换课程状态，不再经过校对/二审工作流。
  const toggleCourseStatus = async (exercise: CatalogExerciseSummary) => {
    const nextStatus = exercise.status === 'published' ? 'draft' : 'published'
    setStatusTogglingId(exercise.id)
    try {
      await apiClient.createExercise({
        id: exercise.id,
        categoryId: exercise.categoryId,
        title: exercise.title,
        source: exercise.source,
        sourceUrl: exercise.sourceUrl,
        difficulty: exercise.difficulty,
        durationLabel: exercise.durationLabel,
        mediaType: exercise.mediaType,
        audioUrl: exercise.audioUrl,
        coverImageUrl: exercise.coverImageUrl,
        summary: exercise.summary,
        sortOrder: exercise.sortOrder,
        status: nextStatus,
      }, adminToken)
      setPagedExercises((current) => current.map((item) => (
        item.id === exercise.id ? { ...item, status: nextStatus } : item
      )))
      onNotify(nextStatus === 'published' ? t('「{{title}}」已发布', { title: exercise.title }) : t('「{{title}}」已下架为草稿', { title: exercise.title }), 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : t('发布状态更新失败'), 'error')
    } finally {
      setStatusTogglingId(null)
    }
  }

  const openVersions = async (exercise: CatalogExerciseSummary) => {
    setVersionsExercise(exercise)
    setVersions([])
    setVersionsLoading(true)
    try {
      const result = await apiClient.getExerciseSubtitleVersions(exercise.id, adminToken)
      setVersions(result.items)
    } catch (error) {
      onNotify(error instanceof Error ? error.message : t('字幕版本历史加载失败'), 'error')
      setVersions([])
    } finally {
      setVersionsLoading(false)
    }
  }

  const versionColumns: ColumnsType<ExerciseSubtitleVersion> = [
    { title: t('版本'), dataIndex: 'versionNo', key: 'versionNo', width: 70, render: (value: number) => <Typography.Text strong>v{value}</Typography.Text> },
    {
      title: t('来源'), dataIndex: 'source', key: 'source', width: 90,
      render: (source: ExerciseSubtitleVersion['source']) => source === 'submitted'
        ? <Tag color="blue">{t('提交')}</Tag>
        : source === 'approved'
          ? <Tag color="green">{t('发布')}</Tag>
          : <Tag color="magenta">{t('回退')}</Tag>,
    },
    { title: t('操作者'), dataIndex: 'adminDisplayName', key: 'adminDisplayName', width: 120 },
    { title: t('时间'), dataIndex: 'createdAt', key: 'createdAt', width: 150, render: (value: string) => formatSubmittedAt(value, uiLocale) },
    {
      title: t('理由'),
      dataIndex: 'note',
      key: 'note',
      width: 240,
      render: (value?: string) => value ? (
        <Typography.Paragraph
          className="subtitle-version-reason"
          ellipsis={{ rows: 2, tooltip: value }}
          type="secondary"
        >
          {value}
        </Typography.Paragraph>
      ) : '—',
    },
    { title: t('句数'), dataIndex: 'lines', key: 'lineCount', width: 70, render: (lines: ExerciseSubtitleVersion['lines']) => lines.length },
    {
      title: t('操作'),
      key: 'actions',
      width: 130,
      render: (_, version) => (
        <Button icon={<Copy size={15} />} onClick={() => void copyVersionDltjson(version)} size="small">
          {t('复制 dltjson')}
        </Button>
      ),
    },
  ]

  const copyVersionDltjson = async (version: ExerciseSubtitleVersion) => {
    try {
      await navigator.clipboard.writeText(versionToDltjson(version))
      onNotify(t('dltjson 已复制到剪切板'), 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : t('复制 dltjson 失败'), 'error')
    }
  }

  const columns: ColumnsType<CatalogExerciseSummary> = [
    {
      title: t('课程'), dataIndex: 'title', key: 'title', width: 250,
      render: (_, exercise) => <Space align="start" size={8}>
        {exercise.coverImageUrl ? <Image alt={`${exercise.title} ${t('封面')}`} height={40} preview={false} src={resolveApiUrl(exercise.coverImageUrl)} width={56} style={{ borderRadius: 4, objectFit: 'cover' }} /> : <div className="course-table-cover">{exercise.mediaType === 'video' ? 'V' : 'A'}</div>}
        <Space direction="vertical" size={2}>
          <Space size={4}><Typography.Text strong>{courseTitle(exercise, uiLocale)}</Typography.Text>{canManageCourses && <Tooltip title={t('快速修改名称')}><Button icon={<Pencil size={13} />} onClick={() => openRenameDialog(exercise)} size="small" type="text" /></Tooltip>}</Space>
          <Typography.Text ellipsis={{ tooltip: exercise.summary }} type="secondary" style={{ maxWidth: 170 }}>{exercise.summary || exercise.source}</Typography.Text>
        </Space>
      </Space>,
    },
    {
      title: t('内容'), key: 'details', width: 105,
      render: (_, exercise) => <Typography.Text type="secondary">
        {exercise.mediaType === 'video' ? t('视频') : t('音频')} · {exercise.lineCount} {t('句')}
      </Typography.Text>,
    },
    {
      title: t('排序'), dataIndex: 'sortOrder', key: 'sortOrder', width: 72,
      render: (sortOrder: number) => <Typography.Text>{sortOrder}</Typography.Text>,
    },
    {
      title: t('发布状态'), dataIndex: 'status', key: 'status', width: 110,
      render: (status: Exclude<CourseStatus, 'all'>) => <Tag color={statusColors[status]}>{t(statusLabels[status])}</Tag>,
    },
    {
      title: t('完整度'), key: 'readiness', width: 100,
      render: (_, exercise) => <Space direction="vertical" size={1}>
        <Typography.Text type={exercise.audioUrl ? undefined : 'danger'}>{exercise.audioUrl ? t('媒体') : t('缺媒体')}</Typography.Text>
        <Typography.Text type={exercise.lineCount > 0 ? undefined : 'danger'}>{exercise.lineCount > 0 ? t('字幕') : t('缺字幕')}</Typography.Text>
      </Space>,
    },
    {
      title: t('操作'), key: 'actions', width: 210, fixed: 'right',
      render: (_, exercise) => <Space size={4}>
        {canManageCourses && <Button disabled={isSaving} icon={<FilePenLine size={15} />} onClick={() => onEditCourse(exercise)} size="small">{t('编辑')}</Button>}
        {canManageCourses && (
          <Tooltip title={exercise.status === 'published' ? t('下架为草稿，学习者将看不到这门课') : t('发布后学习者即可看到这门课')}>
            <Button
              disabled={isSaving || statusTogglingId === exercise.id}
              icon={<Send size={15} />}
              loading={statusTogglingId === exercise.id}
              onClick={() => void toggleCourseStatus(exercise)}
              size="small"
              type={exercise.status === 'published' ? 'default' : 'primary'}
            >
              {exercise.status === 'published' ? t('下架') : t('发布')}
            </Button>
          </Tooltip>
        )}
        <Tooltip title={t('查看字幕版本历史')}><Button icon={<History size={15} />} onClick={() => void openVersions(exercise)} size="small" type="text" /></Tooltip>
        {canManageCourses && <Tooltip title={t('在系列内上移')}><Button disabled={isSaving || !canMove(exercise, 'up')} icon={<ArrowUp size={15} />} onClick={() => onMoveCourse(exercise.id, 'up')} size="small" type="text" /></Tooltip>}
        {canManageCourses && <Tooltip title={t('在系列内下移')}><Button disabled={isSaving || !canMove(exercise, 'down')} icon={<ArrowDown size={15} />} onClick={() => onMoveCourse(exercise.id, 'down')} size="small" type="text" /></Tooltip>}
        {canManageCourses && <Dropdown menu={{ items: [
          { danger: true, disabled: isSaving, icon: <Trash2 size={15} />, key: 'delete', label: t('删除课程') },
        ], onClick: ({ key }) => { if (key === 'delete') onDeleteCourse(exercise) } }}>
          <Button icon={<Ellipsis size={17} />} size="small" type="text" />
        </Dropdown>}
      </Space>,
    },
  ]

  const selectedCategoryExists = Boolean(
    selectedCategoryId && categories.some((category) => category.id === selectedCategoryId),
  )
  const createCourseDisabledReason = isSaving
    ? t('后台正在保存、删除或调整课程顺序，请等待当前操作完成。')
    : isCatalogLoading
      ? t('正在加载内容分类和学习系列，请稍候。')
      : catalogLoadError
        ? t('目录加载失败：{{error}}', { error: catalogLoadError })
        : categoryGroups.length === 0
          ? t('当前还没有内容分类，请先到“目录结构”中新建内容分类。')
          : categories.length === 0
            ? t('已有内容分类，但还没有学习系列，请先到“目录结构”中新建学习系列。')
            : !selectedCategoryExists
              ? t('当前没有选中有效的学习系列，请重新选择学习系列或刷新页面。')
              : ''
  const createCourseDisabled = Boolean(createCourseDisabledReason)

  return <Card
    className="course-manager"
    extra={<Space>
      <Button disabled={isSaving || isLoading || isCatalogLoading} icon={<RefreshCw size={15} />} onClick={() => void onRefreshCatalog().catch(() => undefined)}>{t('刷新')}</Button>
      {canManageCourses && (
        <BatchCourseImporter
          adminToken={adminToken}
          categoryGroups={categoryGroups}
          categories={categories}
          initialCategoryId={selectedCategoryId}
          isSaving={isSaving}
          onNotify={onNotify}
          onRefreshCatalog={onRefreshCatalog}
        />
      )}
      {canManageCourses && <Tooltip title={createCourseDisabled ? createCourseDisabledReason : undefined}>
        <span>
          <Button disabled={createCourseDisabled} icon={<Plus size={15} />} onClick={() => onCreateCourse(createTargetCategoryId)} type="primary">{t('新建课程')}</Button>
        </span>
      </Tooltip>}
    </Space>}
    title={<Space><BookOpen size={18} /><span>{t('课程管理')}</span></Space>}
  >
    {createCourseDisabled && (
      <Alert
        description={createCourseDisabledReason}
        message={t('暂时无法新建课程')}
        showIcon
        style={{ marginBottom: 16 }}
        type={catalogLoadError ? 'error' : 'warning'}
      />
    )}
    <Form className="course-filter-form" layout="inline">
    <Form.Item label={t('内容分类')}><Select value={selectedGroupId || undefined} placeholder={t('选择内容分类')} onChange={(value) => changeGroup(Number(value))} options={categoryGroups.map((item) => ({ label: directoryName(item, uiLocale), value: item.id }))} /></Form.Item>
      <Form.Item label={t('学习系列')}><Select value={selectedCategoryId || undefined} placeholder={t('选择学习系列')} onChange={(value) => changeCategory(Number(value))} options={visibleCategories.map((item) => ({ label: directoryName(item, uiLocale), value: item.id }))} /></Form.Item>
      <Form.Item label={t('发布状态')}><Select value={selectedStatus} onChange={(value) => setSelectedStatus(value as CourseStatus)} options={[{ label: t('全部状态'), value: 'all' }, { label: t('草稿'), value: 'draft' }, { label: t('已校对'), value: 'proofread' }, { label: t('已发布'), value: 'published' }, { label: t('已归档'), value: 'archived' }]} /></Form.Item>
      <Form.Item><Input allowClear prefix={<Search size={15} />} placeholder={t('搜索课程标题、来源或摘要')} value={searchText} onChange={(event) => { setSearchText(event.target.value); setPage(1) }} /></Form.Item>
      <Button onClick={resetFilters} type="link">{t('重置筛选')}</Button>
    </Form>
    <Space className="course-table-summary" direction="vertical" size={2}>
      <Typography.Text strong>{t('共 {{count}} 门课程', { count: total })}</Typography.Text>
      <Typography.Text type="secondary">{t('排序仅在同一学习系列内生效。')}</Typography.Text>
    </Space>
    <div className="course-table-wrap">
    <Table
      columns={columns}
      dataSource={pagedExercises}
      loading={isLoading}
      locale={{ emptyText: <Empty description={t('当前筛选条件下还没有课程。')} /> }}
      pagination={{
        current: page,
        pageSize,
        showSizeChanger: true,
        showTotal: (count) => t('共 {{count}} 门课程', { count }),
        total,
        onChange: (nextPage, nextPageSize) => {
          setPage(nextPage)
          if (nextPageSize !== pageSize) setPageSize(nextPageSize)
        },
      }}
      rowKey="id"
      size="small"
      scroll={{ x: 1090 }}
    />
    </div>
    <Modal
      okButtonProps={{ disabled: !nextTitle.trim(), loading: isRenaming }}
      onCancel={() => setRenamingExercise(null)}
      onOk={() => void saveRename()}
      open={Boolean(renamingExercise)}
      title={t('修改课程名称')}
    >
      <Input autoFocus maxLength={160} onChange={(event) => setNextTitle(event.target.value)} onPressEnter={() => void saveRename()} value={nextTitle} />
    </Modal>

    <Modal
      footer={null}
      onCancel={() => setVersionsExercise(null)}
      open={Boolean(versionsExercise)}
      title={<Space><History size={16} /><span>{t('字幕版本历史')}</span>{versionsExercise && <Typography.Text type="secondary">{versionsExercise.title}</Typography.Text>}</Space>}
      width={1000}
    >
      <Table<ExerciseSubtitleVersion>
        className="subtitle-version-table"
        columns={versionColumns}
        dataSource={versions}
        expandable={{
          expandedRowRender: (version) => (
            <div style={{ padding: '4px 12px 8px' }}>
              <Space direction="vertical" size={12} style={{ display: 'flex' }}>
                <div>
                  <Button icon={<Copy size={15} />} onClick={() => void copyVersionDltjson(version)} size="small">
                    {t('复制 dltjson')}
                  </Button>
                </div>
                <Input.TextArea
                  aria-label={t('完整 dltjson')}
                  autoSize={{ minRows: 10, maxRows: 20 }}
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  value={versionToDltjson(version)}
                />
                {version.lines.length === 0 ? (
                  <Typography.Text type="secondary">{t('该版本没有字幕行')}</Typography.Text>
                ) : (
                  <div className="subtitle-version-lines">
                    {version.lines.map((line) => (
                      <div className="subtitle-version-line" key={line.id}>
                        <Typography.Text className="subtitle-version-time" type="secondary">
                          {formatTimestamp(line.start)} – {formatTimestamp(line.end)}
                        </Typography.Text>
                        <Typography.Text>{line.text}</Typography.Text>
                      </div>
                    ))}
                  </div>
                )}
              </Space>
            </div>
          ),
        }}
        loading={versionsLoading}
        locale={{ emptyText: <Empty description={t('还没有字幕版本记录。')} /> }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 930 }}
        size="small"
      />
    </Modal>
  </Card>
}
