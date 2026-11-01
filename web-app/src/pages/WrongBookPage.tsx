import { ChevronRight, CircleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { useCatalog } from '../hooks/useCatalog'
import { useCategoryExercises } from '../hooks/useCategoryExercises'
import { useLanguage } from '../i18n/LanguageProvider'
import type { MessageKey } from '../i18n/messages'
import type { CatalogExerciseSummary } from '@juting/shared'
import { getAllAttempts, type ExamSection } from '../lib/examHistory'
import { aggregateWrong, isRepeatedWrong } from '../lib/wrongStats'

/**
 * 错题清单（/wrong）：把仪表盘「你最常错的题」的 TOP5 铺全。
 *
 * 这里只做「清单 + 一键去重做」两件事：跨课重练本身仍由实战舞台承担
 * （定位练习会跳到该题所属部分的开头），不再造第二套做题流程。
 */

const SECTIONS: ExamSection[] = ['A', 'B', 'C']

const SECTION_LABEL: Record<ExamSection, MessageKey> = {
  A: 'wrongBook.sectionA',
  B: 'wrongBook.sectionB',
  C: 'wrongBook.sectionC',
}

const formatDay = (iso: string) => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

type WrongRow = {
  key: string
  courseId: number
  questionNo: number
  section: ExamSection
  wrongCount: number
  attemptCount: number
  lastWrongDate: string
  title: string
  categoryId: number
}

export function WrongBookPage() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const { catalog, catalogLoadFailed, catalogLoading, reload } = useCatalog(undefined)
  const { exercisesByCategory, loadExercises } = useCategoryExercises(undefined)
  const [collapsed, setCollapsed] = useState<Partial<Record<ExamSection, boolean>>>({})
  const [filter, setFilter] = useState<'all' | ExamSection>('all')

  useEffect(() => {
    for (const category of catalog.categories) {
      void loadExercises(category.id)
    }
  }, [catalog.categories, loadExercises])

  const allExercises = useMemo(() => {
    const list: CatalogExerciseSummary[] = []
    for (const exercises of Object.values(exercisesByCategory)) {
      list.push(...exercises)
    }
    return list
  }, [exercisesByCategory])

  const rows = useMemo<WrongRow[]>(() => {
    const byId = new Map(allExercises.map((exercise) => [exercise.id, exercise]))
    return aggregateWrong(getAllAttempts())
      .filter(isRepeatedWrong)
      .map((stat) => {
        const exercise = byId.get(stat.courseId)
        return {
          key: `${stat.courseId}:${stat.questionNo}`,
          courseId: stat.courseId,
          questionNo: stat.questionNo,
          section: stat.section,
          wrongCount: stat.wrongCount,
          attemptCount: stat.attemptCount,
          lastWrongDate: stat.lastWrongDate,
          title: exercise?.title ?? `#${stat.courseId}`,
          categoryId: exercise?.categoryId ?? 1,
        }
      })
      .sort(
        (left, right) =>
          right.wrongCount - left.wrongCount ||
          right.lastWrongDate.localeCompare(left.lastWrongDate) ||
          left.questionNo - right.questionNo,
      )
  }, [allExercises])

  const courseCount = useMemo(
    () => new Set(rows.map((row) => row.courseId)).size,
    [rows],
  )

  const grouped = useMemo(
    () =>
      SECTIONS.map((section) => ({
        section,
        items: rows.filter((row) => row.section === section),
      })),
    [rows],
  )

  const sectionCounts = useMemo(() => {
    const counts: Record<ExamSection, number> = { A: 0, B: 0, C: 0 }
    for (const row of rows) counts[row.section] += 1
    return counts
  }, [rows])

  const visibleGroups = useMemo(
    () => (filter === 'all' ? grouped : grouped.filter(({ section }) => section === filter)),
    [filter, grouped],
  )

  const loading = catalogLoading && allExercises.length === 0

  return (
    <div className="wrongbook-page">
      <TopBar active="home" />
      <div className="wrongbook-container">
        <header className="wrongbook-header">
          <div>
            <h1>{t('wrongBook.title')}</h1>
            <p>{t('wrongBook.subtitle')}</p>
          </div>
          {rows.length > 0 && (
            <span className="wrongbook-total">
              {t('wrongBook.summary', { count: rows.length, courses: courseCount })}
            </span>
          )}
        </header>

        {loading ? (
          <p className="wrongbook-empty">{t('wrongBook.loading')}</p>
        ) : catalogLoadFailed && allExercises.length === 0 ? (
          <div className="wrongbook-empty">
            <p>{t('wrongBook.loadFailed')}</p>
            <button className="wrongbook-retry" onClick={() => reload()} type="button">
              {t('wrongBook.retry')}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="wrongbook-empty">
            <p>{t('wrongBook.empty')}</p>
            <p className="wrongbook-empty-hint">{t('wrongBook.emptyHint')}</p>
          </div>
        ) : (
          <>
            <div className="wrongbook-filter" role="group" aria-label={t('wrongBook.filterLabel')}>
              <button
                aria-pressed={filter === 'all'}
                className={filter === 'all' ? 'wrongbook-chip active' : 'wrongbook-chip'}
                onClick={() => setFilter('all')}
                type="button"
              >
                {t('wrongBook.filterAll', { count: rows.length })}
              </button>
              {SECTIONS.map((section) => (
                <button
                  aria-pressed={filter === section}
                  className={filter === section ? 'wrongbook-chip active' : 'wrongbook-chip'}
                  key={section}
                  onClick={() => setFilter(section)}
                  type="button"
                >
                  {t(SECTION_LABEL[section])} · {sectionCounts[section]}
                </button>
              ))}
            </div>
            <div className="wrongbook-groups">
              {visibleGroups.map(({ section, items }) => {
                if (items.length === 0) return null
                // 筛到单一 Section 时无视折叠态——用户点名要看的就是它
                const isCollapsed = filter === 'all' && collapsed[section] === true
                return (
                <section className="wrongbook-group" key={section}>
                  <button
                    aria-expanded={!isCollapsed}
                    className="wrongbook-group-head"
                    onClick={() =>
                      setCollapsed((current) => ({ ...current, [section]: !isCollapsed }))
                    }
                    type="button"
                  >
                    <span className="wrongbook-group-title">{t(SECTION_LABEL[section])}</span>
                    <span className="wrongbook-group-count">
                      {t('wrongBook.sectionCount', { count: items.length })}
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className={isCollapsed ? 'wrongbook-group-chevron' : 'wrongbook-group-chevron open'}
                      size={16}
                    />
                  </button>
                  {!isCollapsed && (
                    <ul className="wrongbook-list">
                      {items.map((row) => (
                        <li key={row.key}>
                          <button
                            onClick={() =>
                              navigate(
                                `/courses/${row.categoryId}/chapters/${row.courseId}?stage=exam&q=${row.questionNo}`,
                              )
                            }
                            type="button"
                          >
                            <CircleAlert className="wrongbook-icon" size={14} aria-hidden="true" />
                            <span className="wrongbook-main">
                              <span className="wrongbook-title">
                                {t('dashboard.wrong.item', { title: row.title, no: row.questionNo })}
                              </span>
                              <span className="wrongbook-meta">
                                {t('wrongBook.meta', {
                                  wrong: row.wrongCount,
                                  attempts: row.attemptCount,
                                })}
                                {' · '}
                                {t('wrongBook.last', { date: formatDay(row.lastWrongDate) })}
                              </span>
                            </span>
                            <span className="wrongbook-action">
                              {t('wrongBook.action')}
                              <ChevronRight size={14} aria-hidden="true" />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
            {visibleGroups.every(({ items }) => items.length === 0) && (
              <p className="wrongbook-empty">{t('wrongBook.filterEmpty')}</p>
            )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
