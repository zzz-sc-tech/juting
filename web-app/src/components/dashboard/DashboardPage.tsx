import { Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../../i18n/LanguageProvider'
import { useCatalog } from '../../hooks/useCatalog'
import { useCategoryExercises } from '../../hooks/useCategoryExercises'
import {
  loadDailyGoal,
  loadLocalActivity,
  loadStoredStudyStore,
  localDayString,
  type LocalDailyActivity,
} from '../../lib/progressStore'
import type { CatalogExerciseSummary, StudyStore } from '@juting/shared'
import { TopBar } from '../TopBar'

/** 每日掌握目标（句）：设置页可配置，默认 10。 */
const CHART_DAYS = 14

const percentOf = (mastered: number, total: number) =>
  total > 0 ? Math.min(100, Math.round((mastered / total) * 100)) : 0

/** 从本地活动记录算连续学习天数：从今天往回数连续非零天；今天还没学则从昨天起算（不断签）。 */
const calcStreak = (activity: LocalDailyActivity) => {
  const dayMs = 24 * 60 * 60 * 1000
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const keyOf = (date: Date) => localDayString(date)
  const countOf = (date: Date) => activity[keyOf(date)] ?? 0

  let cursor = new Date(today)
  if (countOf(cursor) === 0) {
    cursor = new Date(cursor.getTime() - dayMs)
    if (countOf(cursor) === 0) {
      return 0
    }
  }
  let streak = 0
  while (countOf(cursor) > 0) {
    streak += 1
    cursor = new Date(cursor.getTime() - dayMs)
  }
  return streak
}

type CourseProgressEntry = {
  exercise: CatalogExerciseSummary
  mastered: number
  total: number
  percent: number
}

/**
 * 仪表盘首页（/home）：本地数据驱动的学习概览——统计卡、14 天掌握曲线、
 * 每日目标环、继续学习与课程完成度。不依赖任何账号。
 */
export function DashboardPage() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [store] = useState<StudyStore>(loadStoredStudyStore)
  const [dailyGoal] = useState(loadDailyGoal)
  const [activity] = useState<LocalDailyActivity>(loadLocalActivity)
  const { catalog } = useCatalog(undefined)
  const { exercisesByCategory, loadExercises } = useCategoryExercises(undefined)

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

  const courseProgressList = useMemo<CourseProgressEntry[]>(() => {
    const entries: CourseProgressEntry[] = []
    for (const exercise of allExercises) {
      const progress = store.progressByExercise[exercise.id]
      const started = progress && Object.keys(progress.lines).length > 0
      if (!started) {
        continue
      }
      const total = exercise.lineCount || 0
      const mastered = Object.values(progress.lines).filter((line) => line.mastered).length
      entries.push({
        exercise,
        mastered,
        total,
        percent: percentOf(mastered, total),
      })
    }
    return entries.sort((left, right) => right.percent - left.percent)
  }, [allExercises, store.progressByExercise])

  const todayKey = localDayString()
  const todayCount = activity[todayKey] ?? 0
  const streak = useMemo(() => calcStreak(activity), [activity])
  const totalMastered = useMemo(
    () =>
      Object.values(store.progressByExercise).reduce(
        (sum, progress) =>
          sum + Object.values(progress.lines).filter((line) => line.mastered).length,
        0,
      ),
    [store.progressByExercise],
  )
  const activeCourseCount = courseProgressList.length

  const continueEntry = useMemo<CourseProgressEntry | null>(() => {
    if (!store.activeExerciseId) {
      return null
    }
    return courseProgressList.find((entry) => entry.exercise.id === store.activeExerciseId) ?? null
  }, [courseProgressList, store.activeExerciseId])

  const chart = useMemo(() => {
    const dayMs = 24 * 60 * 60 * 1000
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const points: Array<{ day: string; label: string; count: number }> = []
    for (let offset = CHART_DAYS - 1; offset >= 0; offset -= 1) {
      const date = new Date(today.getTime() - offset * dayMs)
      const key = localDayString(date)
      points.push({
        day: key,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        count: activity[key] ?? 0,
      })
    }
    return points
  }, [activity])

  const goalPercent = percentOf(todayCount, dailyGoal)

  const openCourse = (exercise: CatalogExerciseSummary) => {
    navigate(`/courses/${exercise.categoryId}/chapters/${exercise.id}?stage=intensive`)
  }

  return (
    <div className="dashboard-page">
      <TopBar active="home" />
      <div className="dashboard-container">
        <header className="dashboard-hero">
          <h1>{t('dashboard.title')}</h1>
          <p>{t('dashboard.goal.line', { count: todayCount, goal: dailyGoal })}</p>
        </header>

        <div className="dashboard-layout">
          <div className="dashboard-main">
            <section className="dashboard-stat-strip" aria-label={t('dashboard.title')}>
              <div className="dashboard-stat">
                <strong className="dashboard-stat-value">{todayCount}</strong>
                <span className="dashboard-stat-label">{t('dashboard.stat.today')}</span>
              </div>
              <div className="dashboard-stat">
                <strong className="dashboard-stat-value">{streak}</strong>
                <span className="dashboard-stat-label">{t('dashboard.stat.streak')}</span>
              </div>
              <div className="dashboard-stat">
                <strong className="dashboard-stat-value">{totalMastered}</strong>
                <span className="dashboard-stat-label">{t('dashboard.stat.total')}</span>
              </div>
              <div className="dashboard-stat">
                <strong className="dashboard-stat-value">{activeCourseCount}</strong>
                <span className="dashboard-stat-label">{t('dashboard.stat.courses')}</span>
              </div>
            </section>

            <section className="dashboard-card dashboard-chart-card">
              <div className="dashboard-card-head">
                <div>
                  <h2>{t('dashboard.chart.title')}</h2>
                  <span className="dashboard-card-subtitle">{t('dashboard.chart.subtitle')}</span>
                </div>
              </div>
              <MasteryChart points={chart} />
            </section>

            <section className="dashboard-card dashboard-continue-card">
              <div className="dashboard-card-head">
                <h2>{t('dashboard.continue.title')}</h2>
              </div>
              {continueEntry ? (
                <div className="dashboard-continue-body">
                  <div className="dashboard-continue-info">
                    <strong>{continueEntry.exercise.title}</strong>
                    <span>
                      {t('dashboard.continue.progress', {
                        mastered: continueEntry.mastered,
                        total: continueEntry.total,
                      })}
                    </span>
                    <span className="dashboard-progress-track">
                      <span
                        className="dashboard-progress-fill"
                        style={{ width: `${continueEntry.percent}%` }}
                      />
                    </span>
                  </div>
                  <button
                    className="dashboard-primary-button"
                    onClick={() => openCourse(continueEntry.exercise)}
                    type="button"
                  >
                    <Play size={16} aria-hidden="true" />
                    {t('dashboard.continue.action')}
                  </button>
                </div>
              ) : (
                <p className="dashboard-empty">{t('dashboard.continue.empty')}</p>
              )}
            </section>
          </div>

          <aside className="dashboard-side">
            <section className="dashboard-card dashboard-goal-card">
              <div className="dashboard-card-head">
                <h2>{t('dashboard.goal.title')}</h2>
              </div>
              <div className="dashboard-goal-body">
                <GoalRing percent={goalPercent} />
                <p className="dashboard-goal-count">
                  {goalPercent >= 100
                    ? t('dashboard.goal.done')
                    : t('dashboard.goal.progress', { current: todayCount, target: dailyGoal })}
                </p>
              </div>
            </section>

            <section className="dashboard-card dashboard-courses-card">
              <div className="dashboard-card-head">
                <h2>{t('dashboard.courses.title')}</h2>
              </div>
              {courseProgressList.length > 0 ? (
                <ul className="dashboard-course-list">
                  {courseProgressList.slice(0, 5).map((entry) => (
                    <li key={entry.exercise.id}>
                      <button onClick={() => openCourse(entry.exercise)} type="button">
                        <span className="dashboard-course-title">{entry.exercise.title}</span>
                        <span className="dashboard-progress-track">
                          <span
                            className="dashboard-progress-fill"
                            style={{ width: `${entry.percent}%` }}
                          />
                        </span>
                        <span className="dashboard-course-percent">
                          {t('dashboard.courses.progress', { percent: entry.percent })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dashboard-empty">{t('dashboard.courses.empty')}</p>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}

/** 近 14 天掌握曲线：手写 SVG 折线 + soft 面积，不引图表库。 */
function MasteryChart({ points }: { points: Array<{ day: string; label: string; count: number }> }) {
  const { t } = useLanguage()
  const width = 560
  const height = 170
  const padX = 18
  const padTop = 16
  const padBottom = 26
  const maxValue = Math.max(...points.map((point) => point.count), 1)
  const stepX = (width - padX * 2) / (points.length - 1)
  const yOf = (count: number) =>
    padTop + (1 - count / maxValue) * (height - padTop - padBottom)
  const coords = points.map((point, index) => ({
    x: padX + index * stepX,
    y: yOf(point.count),
    ...point,
  }))
  const linePath = coords
    .map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.x.toFixed(1)},${coord.y.toFixed(1)}`)
    .join(' ')
  const areaPath = `${linePath} L${coords[coords.length - 1]?.x.toFixed(1)},${height - padBottom} L${padX},${height - padBottom} Z`
  const hasData = points.some((point) => point.count > 0)

  return (
    <div className="dashboard-chart">
      {hasData ? (
        <svg
          aria-hidden="true"
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <path className="dashboard-chart-area" d={areaPath} />
          <path className="dashboard-chart-line" d={linePath} />
          {coords.map((coord) => (
            <circle
              className="dashboard-chart-dot"
              cx={coord.x}
              cy={coord.y}
              key={coord.day}
              r={3.5}
            />
          ))}
          {coords.map((coord, index) =>
            index % 2 === 0 || index === coords.length - 1 ? (
              <text className="dashboard-chart-label" key={coord.label} x={coord.x} y={height - 8}>
                {coord.label}
              </text>
            ) : null,
          )}
        </svg>
      ) : (
        <p className="dashboard-empty">{t('dashboard.chart.empty')}</p>
      )}
    </div>
  )
}

/** 每日目标进度环。 */
function GoalRing({ percent }: { percent: number }) {
  const radius = 38
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.min(percent, 100) / 100)
  return (
    <svg aria-hidden="true" className="dashboard-goal-ring" viewBox="0 0 100 100">
      <circle className="dashboard-goal-track" cx="50" cy="50" r={radius} />
      <circle
        className="dashboard-goal-fill"
        cx="50"
        cy="50"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
      />
      <text className="dashboard-goal-percent" textAnchor="middle" x="50" y="58">
        {percent}%
      </text>
    </svg>
  )
}
