import { useMemo } from 'react'
import { BookOpenText } from 'lucide-react'
import { useLanguage } from '../../i18n/LanguageProvider'
import { calculateChapterProgress } from '../../lib/progressStore'
import { useStudySession } from './StudySessionContext'

// 章节横幅：标题 + 系列/进度信息 + 细进度条。
// quest 编号沿用 seriesExercises 的全系列序号（与课程地图同源）。
export function StudyBanner() {
  const { t } = useLanguage()
  const {
    activeExercise,
    catalog,
    chapterProgressByExercise,
    masteryPercent,
    selectedSeriesId,
    seriesExercises,
    store,
  } = useStudySession()

  const activeSeries = useMemo(
    () => catalog.categories.find((category) => category.id === selectedSeriesId),
    [catalog.categories, selectedSeriesId],
  )
  const chapterIndex = useMemo(() => {
    if (!activeExercise) {
      return 0
    }
    const index = seriesExercises.findIndex((exercise) => exercise.id === activeExercise.id)
    return index >= 0 ? index + 1 : 0
  }, [activeExercise, seriesExercises])
  const activeChapterProgress = activeExercise
    ? chapterProgressByExercise[activeExercise.id] ??
      calculateChapterProgress(
        {
          id: activeExercise.id,
          lineCount: activeExercise.lines.length,
        },
        store,
      )
    : undefined

  if (!activeExercise) {
    return null
  }

  return (
    <section className="study-chapter-banner" aria-label={t('app.chapterBanner.aria')}>
      <div className="study-chapter-banner-icon" aria-hidden="true">
        <BookOpenText size={18} />
      </div>
      <div className="study-chapter-banner-copy">
        <div className="study-chapter-banner-kicker-row">
          <p className="study-chapter-banner-kicker">{t('app.chapterBanner.kicker')}</p>
        </div>
        <strong className="study-chapter-banner-title">
          {activeExercise.title}
        </strong>
      </div>
      <div className="study-chapter-banner-metrics">
        <span>
          {activeSeries?.name ?? t('app.chapterBanner.seriesFallback')}
        </span>
        <span>
          {t('app.chapterBanner.progress', { current: chapterIndex || 1, total: Math.max(seriesExercises.length, 1) })}
        </span>
      </div>
      <div className="study-chapter-progress" aria-hidden="true">
        <span style={{ width: `${activeChapterProgress?.percent ?? masteryPercent}%` }} />
      </div>
    </section>
  )
}
