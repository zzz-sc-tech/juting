import { Play, ChevronRight, CircleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../../i18n/LanguageProvider'
import { getAllAttempts, getLatestByCourse } from '../../lib/examHistory'
import { aggregateWrong } from '../../lib/wrongStats'
import { useCatalog } from '../../hooks/useCatalog'
import { useCategoryExercises } from '../../hooks/useCategoryExercises'
import {
  formatListenDuration,
  loadListenTime,
} from '../../lib/listenTime'
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
  // 所听时长（localStorage 落盘值；进入首页时重新读一次，够新鲜）
  const [listenTime] = useState(loadListenTime)
  const { catalog, catalogLoadFailed, catalogLoading, reload: reloadCatalog } = useCatalog(undefined)
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
      const total = exercise.contentLineCount ?? exercise.lineCount ?? 0
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
  const todayListenMs = listenTime.byDay[todayKey] ?? 0
  const listenDurationLabel = formatListenDuration(listenTime.totalMs)
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

  // 模拟实战成绩档案：近 10 场平均 / 累计场数 / 最近一场
  const examStats = useMemo(() => {
    const latestByCourse = getLatestByCourse()
    const entries = Object.entries(latestByCourse)
      .map(([exerciseId, attempt]) => {
        const exercise = allExercises.find((item) => item.id === Number(exerciseId))
        return exercise
          ? {
              exerciseId: Number(exerciseId),
              title: exercise.title,
              // 系列 id 必须跟着课程走：写死 1 会让四级（category 9）的课跳错课（B2）
              categoryId: exercise.categoryId,
              attempt,
            }
          : null
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => right.attempt.date.localeCompare(left.attempt.date))
    const recent = entries.slice(0, 10)
    const avg = recent.length
      ? Math.round((recent.reduce((sum, entry) => sum + entry.attempt.score, 0) / recent.length) * 10) / 10
      : 0
    return { entries, avg, count: entries.length, last: entries[0] ?? null }
  }, [allExercises])

  // 反复错题：历次实战 wrong[] 跨场次累计，取最常错的 5 题（需考过 2 次以上才算"反复"）
  const wrongTop = useMemo(() => {
    const all = getAllAttempts()
    const stats = aggregateWrong(all)
      .filter((stat) => stat.attemptCount >= 2 || stat.wrongCount >= 2)
      .slice(0, 5)
    return stats.map((stat) => {
      const exercise = allExercises.find((item) => item.id === stat.courseId)
      return { ...stat, title: exercise?.title ?? `#${stat.courseId}`, categoryId: exercise?.categoryId ?? 1 }
    })
  }, [allExercises])

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

  // 首页三个数字必须互相自洽：今日掌握 ≤ 累计掌握；今日有掌握则在学课程 ≥ 1。
  // 曾经出现过「今日 4 / 累计 0 / 在学 0」同屏（统计口径不同源），
  // 用户第一反应是数据坏了。开发期把不自洽喊出来，别让它再悄悄出现。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (todayCount > totalMastered) {
      console.warn('[dashboard] 今日掌握数大于累计掌握数', { todayCount, totalMastered })
    }
    if (todayCount > 0 && activeCourseCount === 0) {
      console.warn('[dashboard] 今日有掌握但没有任何在学课程', { todayCount })
    }
  }, [todayCount, totalMastered, activeCourseCount])

  const openCourse = (exercise: CatalogExerciseSummary) => {
    navigate(`/courses/${exercise.categoryId}/chapters/${exercise.id}?stage=intensive`)
  }

  return (
    <div className="dashboard-page">
      <TopBar active="home" />
      <div className="dashboard-container">
        <header className="dashboard-hero">
          <h1>{t('dashboard.title')}</h1>
          {/* 首屏第一眼应该是「今天做了多少」——28px 主数字 + 4px 进度条，
              原先这里是 14px 灰字，而 24px 的累计时长抢了视觉首位 */}
          <div className="dashboard-hero-goal">
            <div className="dashboard-hero-goal-head">
              <span className="dashboard-hero-count">
                <strong>{todayCount}</strong>
                <span>{t('dashboard.goal.suffix', { goal: dailyGoal })}</span>
              </span>
              <span className="dashboard-hero-goal-label">
                {goalPercent >= 100 ? t('dashboard.goal.done') : t('dashboard.goal.title')}
              </span>
            </div>
            <span className="dashboard-hero-track">
              <span className="dashboard-hero-fill" style={{ width: `${goalPercent}%` }} />
            </span>
          </div>
        </header>

        <div className="dashboard-layout">
          <div className="dashboard-main">
            <section className="dashboard-stat-strip" aria-label={t('dashboard.title')}>
              <div className="dashboard-stat">
                <strong className="dashboard-stat-value">
                  {streak}
                  <span className="dashboard-stat-unit">{t('dashboard.stat.unit.days')}</span>
                </strong>
                <span className="dashboard-stat-label">{t('dashboard.stat.streak')}</span>
              </div>
              {/* 0 值统计不占视觉位：新用户看到三个 0 只会以为页面没加载完 */}
              {totalMastered > 0 && (
                <div className="dashboard-stat">
                  <strong className="dashboard-stat-value">{totalMastered}</strong>
                  <span className="dashboard-stat-label">{t('dashboard.stat.total')}</span>
                </div>
              )}
              {activeCourseCount > 0 && (
                <div className="dashboard-stat">
                  <strong className="dashboard-stat-value">{activeCourseCount}</strong>
                  <span className="dashboard-stat-label">{t('dashboard.stat.courses')}</span>
                </div>
              )}
              {(listenTime.totalMs > 0 || todayListenMs > 0) && (
                <div className="dashboard-stat">
                  <strong className="dashboard-stat-value is-secondary">{listenDurationLabel}</strong>
                  <span className="dashboard-stat-label">
                    {t('dashboard.stat.listenLabel', { today: Math.floor(todayListenMs / 60_000) })}
                  </span>
                </div>
              )}
            </section>

            {/* 继续学习卡提到趋势图上方：它才是这一页的「下一步」 */}
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
              ) : catalogLoadFailed ? (
                <div className="dashboard-continue-body">
                  {/* 断网时不能一边显示「今日 7 句」一边说「还没有开始任何课程」——
                      那会让用户以为本地数据丢了 */}
                  <p className="dashboard-empty">{t('dashboard.continue.loadFailed')}</p>
                  <button
                    className="dashboard-primary-button is-ghost"
                    onClick={() => reloadCatalog()}
                    type="button"
                  >
                    {t('dashboard.continue.retry')}
                  </button>
                </div>
              ) : catalogLoading ? (
                <p className="dashboard-empty">{t('dashboard.continue.loading')}</p>
              ) : (
                <div className="dashboard-continue-body">
                  <p className="dashboard-empty">{t('dashboard.continue.empty')}</p>
                  {/* 零数据时全站唯一的主 CTA：没有它，新用户点「开始复习」
                      会进到空态再弹回首页，转两圈走不出去 */}
                  <button
                    className="dashboard-primary-button"
                    onClick={() => navigate('/courses')}
                    type="button"
                  >
                    <Play size={16} aria-hidden="true" />
                    {t('dashboard.continue.startFirst')}
                  </button>
                </div>
              )}
            </section>

            <section className="dashboard-card dashboard-chart-card">
              <div className="dashboard-card-head">
                <div>
                  <h2>{t('dashboard.chart.title')}</h2>
                  <span className="dashboard-card-subtitle">{t('dashboard.chart.subtitle')}</span>
                </div>
                <span className="dashboard-card-subtitle">
                  {t('dashboard.chart.summary', {
                    days: CHART_DAYS,
                    count: chart.reduce((sum, point) => sum + point.count, 0),
                  })}
                </span>
              </div>
              <MasteryChart points={chart} />
            </section>
          </div>

          <aside className="dashboard-side">
            <section className="dashboard-card dashboard-exam-card" aria-label={t('dashboard.examCardTitle')}>
              <div className="dashboard-card-head">
                <h2>{t('dashboard.examCardTitle')}</h2>
                {examStats.count > 0 && (
                  <span className="dashboard-card-subtitle">
                    {t('dashboard.examAvg', { avg: examStats.avg })} · {t('dashboard.examCount', { count: examStats.count })}
                  </span>
                )}
              </div>
              {examStats.entries.length > 0 ? (
                <ul className="dashboard-exam-list">
                  {examStats.entries.slice(0, 5).map((entry) => (
                    <li key={entry.exerciseId}>
                      <button
                        onClick={() => navigate(`/courses/${entry.categoryId}/chapters/${entry.exerciseId}?stage=exam`)}
                        type="button"
                      >
                        <span className="dashboard-course-title">{entry.title}</span>
                        <span className="dashboard-exam-bar">
                          <span
                            className="dashboard-exam-bar-fill"
                            style={{ width: `${Math.round((entry.attempt.score / entry.attempt.total) * 100)}%` }}
                          />
                        </span>
                        <span className="dashboard-exam-score">{entry.attempt.score}/{entry.attempt.total}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dashboard-empty">{t('dashboard.examEmpty')}</p>
              )}
            </section>

            <section className="dashboard-card dashboard-wrong-card" aria-label={t('dashboard.wrong.title')}>
              <div className="dashboard-card-head">
                <h2>{t('dashboard.wrong.title')}</h2>
                {wrongTop.length > 0 && (
                  <span className="dashboard-card-subtitle">{t('dashboard.wrong.hint')}</span>
                )}
              </div>
              {wrongTop.length > 0 ? (
                <ul className="dashboard-wrong-list">
                  {wrongTop.map((stat) => (
                    <li key={`${stat.courseId}:${stat.questionNo}`}>
                      <button
                        /* 点进去直接停在那一题（实战舞台的定位练习），
                           原先只到精听首页，用户还得自己找回题号 */
                        onClick={() =>
                          navigate(
                            `/courses/${stat.categoryId}/chapters/${stat.courseId}?stage=exam&q=${stat.questionNo}`,
                          )
                        }
                        type="button"
                      >
                        <CircleAlert size={14} aria-hidden="true" className="dashboard-wrong-icon" />
                        <span className="dashboard-wrong-main">
                          <span className="dashboard-course-title">
                            {t('dashboard.wrong.item', { title: stat.title, no: stat.questionNo })}
                          </span>
                          <span className="dashboard-wrong-meta">
                            {t('dashboard.wrong.meta', { wrong: stat.wrongCount, attempts: stat.attemptCount, section: stat.section })}
                          </span>
                        </span>
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dashboard-empty">{t('dashboard.wrong.empty')}</p>
              )}
            </section>

            <section className="dashboard-card dashboard-review-card" aria-label={t('topbar.review')}>
              <div className="dashboard-card-head">
                <h2>{t('topbar.review')}</h2>
              </div>
              {/* 还没有任何在学课程时，这里不该是全页唯一实心按钮——
                  否则新用户的第一动作变成「去复习还没学过的课」 */}
              <button
                className={
                  courseProgressList.length === 0
                    ? 'dashboard-review-cta ghost'
                    : 'dashboard-review-cta'
                }
                onClick={() => navigate('/review')}
                type="button"
              >
                {t('globalReview.reviewHere')}
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </section>

            {/* 只有一门在学课程时，「课程完成度」和上面「继续学习」说的是同一件事，
                整张卡只输出一句空话；≥2 门时它才是「多课进度」的独立视图。 */}
            {courseProgressList.length >= 2 && (
              <section className="dashboard-card dashboard-courses-card">
                <div className="dashboard-card-head">
                  <h2>{t('dashboard.courses.title')}</h2>
                </div>
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
              </section>
            )}
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
          {/* 三条基线（0 / 半 / 顶）：没有基线时折线悬空，读者无从判断量级 */}
          {[0, 0.5, 1].map((ratio) => (
            <line
              className="dashboard-chart-grid"
              key={ratio}
              x1={padX}
              x2={width - padX}
              y1={yOf(maxValue * ratio)}
              y2={yOf(maxValue * ratio)}
            />
          ))}
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

/** 每日目标进度环已并入首页 hero 的进度条（同一个数字不再画三遍）。 */
