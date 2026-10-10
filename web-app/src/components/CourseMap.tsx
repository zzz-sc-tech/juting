import { BookOpen, Check, CheckCheck, ChevronDown, Layers3, MoreVertical, RotateCcw, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type {
  CatalogExerciseSummary,
  ExerciseCategory,
  MaterialCategory,
} from '@juting/shared'
import { useLanguage } from '../i18n/LanguageProvider'
import type {
  ChapterProgressSummary,
  SeriesProgressSummary,
} from '../lib/progressStore'

const emptySeriesProgress: SeriesProgressSummary = {
  masteredLineCount: 0,
  percent: 0,
  totalLineCount: 0,
}

type CourseMapProps = {
  catalog: {
    categoryGroups: MaterialCategory[]
    categories: ExerciseCategory[]
  }
  selectedSeriesId: number
  activeExerciseId: number | ''
  seriesExercises: CatalogExerciseSummary[]
  chapterProgressByExercise: Record<string, ChapterProgressSummary>
  seriesProgressByCategory: Record<string, SeriesProgressSummary>
  onSeriesSelect: (seriesId: number) => void
  onExerciseSelect: (exercise: CatalogExerciseSummary) => void
  /** 章节卡 ⋯ 菜单：把该课全部可见句标为已掌握（完成后自动进「已完成」组）。 */
  onMarkExerciseDone: (exercise: CatalogExerciseSummary) => Promise<void> | void
  /** 章节卡 ⋯ 菜单：清除该课的全部本地进度（回到「未开始」）。 */
  onResetExerciseProgress: (exercise: CatalogExerciseSummary) => void
}

export function CourseMap({
  catalog,
  selectedSeriesId,
  activeExerciseId,
  seriesExercises,
  chapterProgressByExercise,
  seriesProgressByCategory,
  onSeriesSelect,
  onExerciseSelect,
  onMarkExerciseDone,
  onResetExerciseProgress,
}: CourseMapProps) {
  const { t } = useLanguage()
  // 章节按学习状态三分类：进行中 → 未开始 → 已完成（组内保持时间顺序）。
  // 做一半的排最前方便续学；完成态沉底归档。
  const chapterGroups = useMemo(() => {
    const decorate = (exercise: CatalogExerciseSummary, index: number) => {
      const progress = chapterProgressByExercise[exercise.id] ?? {
        exerciseId: exercise.id,
        masteredLineCount: 0,
        percent: 0,
        totalLineCount: exercise.lineCount,
      }
      const status =
        progress.totalLineCount > 0 && progress.percent >= 100
          ? 'done'
          : progress.percent > 0
            ? 'doing'
            : 'todo'
      return { exercise, progress, status, index }
    }
    const decorated = seriesExercises.map(decorate)
    return [
      { key: 'doing', labelKey: 'courseMap.group.doing' as const, items: decorated.filter((item) => item.status === 'doing') },
      { key: 'todo', labelKey: 'courseMap.group.todo' as const, items: decorated.filter((item) => item.status === 'todo') },
      { key: 'done', labelKey: 'courseMap.group.done' as const, items: decorated.filter((item) => item.status === 'done') },
    ]
  }, [seriesExercises, chapterProgressByExercise])
  const [seriesDialogOpen, setSeriesDialogOpen] = useState(false)
  // 章节卡 ⋯ 菜单：menuForId 当前展开的章节；confirmResetId 二次确认重置；
  // busyId 标完成请求进行中（防重复点击）。
  const [menuForId, setMenuForId] = useState<number | null>(null)
  const [confirmResetId, setConfirmResetId] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const closeChapterMenu = () => {
    setMenuForId(null)
    setConfirmResetId(null)
  }

  const handleMarkDoneClick = async (exercise: CatalogExerciseSummary) => {
    setMenuForId(null)
    setConfirmResetId(null)
    setBusyId(exercise.id)
    try {
      await onMarkExerciseDone(exercise)
    } finally {
      setBusyId(null)
    }
  }

  const visibleCategories = catalog.categories

  const visibleGroups = useMemo(
    () =>
      catalog.categoryGroups.filter((group) =>
        visibleCategories.some((series) => series.groupId === group.id),
      ),
    [catalog.categoryGroups, visibleCategories],
  )

  const selectedSeries =
    visibleCategories.find((series) => series.id === selectedSeriesId) ??
    visibleCategories[0]
  const [activeGroupId, setActiveGroupId] = useState<number>(
    selectedSeries?.groupId ?? visibleGroups[0]?.id ?? -1,
  )

  useEffect(() => {
    // Reset active group only when current selection is not "全部" and the group no longer exists
    if (activeGroupId !== -1 && !visibleGroups.some((group) => group.id === activeGroupId)) {
      setActiveGroupId(-1)
    }
  }, [activeGroupId, visibleGroups])

  const activeGroupSeries = useMemo(
    () =>
      activeGroupId === -1
        ? visibleCategories
        : visibleCategories.filter((series) => series.groupId === activeGroupId),
    [activeGroupId, visibleCategories],
  )

  const selectSeries = (seriesId: number) => {
    onSeriesSelect(seriesId)
    setSeriesDialogOpen(false)
  }

  const openSeriesDialog = () => {
    setActiveGroupId(-1)
    setSeriesDialogOpen(true)
  }

  return (
    <aside className="library-pane quest-pane" aria-label={t('courseMap.ariaLabel')}>
      <div className="pane-heading">
        <Layers3 size={18} aria-hidden="true" />
        <span>{t('courseMap.coursesHeading')}</span>
      </div>

      <button
        className="series-trigger"
        onClick={openSeriesDialog}
        type="button"
        disabled={!selectedSeries}
        aria-haspopup="dialog"
        aria-expanded={seriesDialogOpen}
      >
        <span className="series-trigger-copy">
          <strong>{selectedSeries?.name ?? t('courseMap.selectCourse')}</strong>
          {selectedSeries?.description && <small>{selectedSeries.description}</small>}
        </span>
        <ChevronDown size={40} aria-hidden="true" />
      </button>

      <div className="pane-heading compact">
        <BookOpen size={18} aria-hidden="true" />
        <span>{t('courseMap.chaptersHeading')}</span>
      </div>

      <div className="exercise-list quest-list">
        {chapterGroups.map((group) => (
          <Fragment key={group.key}>
            {group.items.length > 0 && (
              <div className="chapter-group-label" aria-hidden="true">
                {t(group.labelKey)}
                <span>{group.items.length}</span>
              </div>
            )}
            {group.items.map(({ exercise, progress, status, index }) => {
              const statusAria =
                status === 'done'
                  ? t('courseMap.chapterCompletedAria')
                  : t('courseMap.chapterProgressAria', { percent: progress.percent })
              // 行本体用 div role=button（与原 button 同类名同布局），
              // ⋯ 菜单作为真实子元素挂在行内（button 不能嵌 button，
              // 且外层包 wrapper 会破坏 .exercise-list 网格项布局）。
              return (
                <div
                  aria-label={`${index + 1} ${exercise.title}, ${statusAria}`}
                  className={
                    exercise.id === activeExerciseId
                      ? 'exercise-item quest-node active'
                      : 'exercise-item quest-node'
                  }
                  key={exercise.id}
                  onClick={() => onExerciseSelect(exercise)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onExerciseSelect(exercise)
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span className="quest-badge">{index + 1}</span>
                  <span className="exercise-main">
                    <span className="exercise-title">{exercise.title}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`chapter-status-box ${status}`}
                  >
                    {status === 'done' && <Check size={15} strokeWidth={3.5} aria-hidden="true" />}
                  </span>
                  <button
                    aria-expanded={menuForId === exercise.id}
                    aria-haspopup="menu"
                    aria-label={t('courseMap.chapterMenuAria')}
                    className="chapter-kebab"
                    disabled={busyId === exercise.id}
                    onClick={(event) => {
                      event.stopPropagation()
                      setConfirmResetId(null)
                      setMenuForId((current) => (current === exercise.id ? null : exercise.id))
                    }}
                    type="button"
                  >
                    <MoreVertical size={14} aria-hidden="true" />
                  </button>
                  {menuForId === exercise.id && (
                    <div className="chapter-menu" role="menu">
                      <button
                        disabled={busyId === exercise.id}
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleMarkDoneClick(exercise)
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <CheckCheck size={14} aria-hidden="true" />
                        {t('courseMap.markDone')}
                      </button>
                      {confirmResetId === exercise.id ? (
                        <button
                          className="danger"
                          onClick={(event) => {
                            event.stopPropagation()
                            onResetExerciseProgress(exercise)
                            closeChapterMenu()
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <RotateCcw size={14} aria-hidden="true" />
                          {t('courseMap.resetConfirm')}
                        </button>
                      ) : (
                        <button
                          onClick={(event) => {
                            event.stopPropagation()
                            setConfirmResetId(exercise.id)
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <RotateCcw size={14} aria-hidden="true" />
                          {t('courseMap.resetProgress')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>

      {menuForId !== null && (
        <div
          className="chapter-menu-backdrop"
          onClick={closeChapterMenu}
          role="presentation"
        />
      )}

      {seriesDialogOpen && (
        <div
          className="modal-backdrop series-backdrop"
          role="presentation"
          onMouseDown={() => setSeriesDialogOpen(false)}
        >
          <section
            aria-labelledby="series-dialog-title"
            aria-modal="true"
            className="series-dialog"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              aria-label={t('courseMap.closeCourseDialog')}
              className="dialog-close"
              onClick={() => setSeriesDialogOpen(false)}
              type="button"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <div className="series-dialog-head">
              <p>{t('courseMap.courseSelection')}</p>
              <h2 id="series-dialog-title">{t('courseMap.dialogTitle')}</h2>
            </div>

            <div className="series-group-tabs" aria-label={t('courseMap.materialCategories')}>
              <button
                className={activeGroupId === -1 ? 'series-group-tab active' : 'series-group-tab'}
                onClick={() => setActiveGroupId(-1)}
                type="button"
              >
                <span className="series-tab-dot" style={{ background: 'var(--ink-4)' }} aria-hidden="true" />
                {t('courseMap.allGroups')}
              </button>
              {visibleGroups.map((group) => (
                <button
                  className={
                    group.id === activeGroupId
                      ? 'series-group-tab active'
                      : 'series-group-tab'
                  }
                  key={group.id}
                  onClick={() => setActiveGroupId(group.id)}
                  title={group.description}
                  type="button"
                >
                  <span
                    className="series-tab-dot"
                    style={{ background: group.accent }}
                    aria-hidden="true"
                  />
                  {group.name}
                </button>
              ))}
            </div>

            <section className="series-group">
              <div className="series-grid">
                {activeGroupSeries.length > 0 ? (
                  activeGroupSeries.map((item) => {
                    const progress =
                      seriesProgressByCategory[item.id] ?? emptySeriesProgress
                    const completed =
                      progress.totalLineCount > 0 && progress.percent >= 100

                    return (
                      <button
                        className={
                          item.id === selectedSeriesId
                            ? 'series-option active'
                            : 'series-option'
                        }
                        key={item.id}
                        onClick={() => selectSeries(item.id)}
                        type="button"
                      >
                        <span className="series-option-copy">
                          <strong>{item.name}</strong>
                          <small>{item.description}</small>
                          <span>
                            {t('courseMap.masteredCount', {
                              mastered: progress.masteredLineCount,
                              total: progress.totalLineCount,
                            })}
                          </span>
                        </span>
                        <span
                          aria-label={
                            completed
                              ? t('courseMap.seriesCompletedAria')
                              : t('courseMap.seriesProgressAria', {
                                  percent: progress.percent,
                                })
                          }
                          className={
                            completed
                              ? 'series-progress-ring complete'
                              : 'series-progress-ring'
                          }
                          role="img"
                          style={
                            {
                              '--series-progress': `${progress.percent}%`,
                            } as CSSProperties
                          }
                        >
                          {completed ? (
                            <Check size={22} strokeWidth={4} aria-hidden="true" />
                          ) : (
                            <span>{progress.percent}%</span>
                          )}
                        </span>
                      </button>
                    )
                  })
                ) : (
                  <p className="series-empty">
                    {t('courseMap.emptyCourses')}
                  </p>
                )}
              </div>
            </section>
          </section>
        </div>
      )}
    </aside>
  )
}
