import { Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CatalogExerciseSummary } from '@juting/shared'
import { TopBar } from '../components/TopBar'
import { apiClient } from '../lib/apiClient'
import { loadStoredStudyStore, persistStudyStore } from '../lib/progressStore'
import type { StudyStore } from '@juting/shared'
import { collectVocabEntries } from '../lib/vocab'
import { useLanguage } from '../i18n/LanguageProvider'

/**
 * 生词本（/vocabulary）：跨课程聚合收藏的生词（词 + 收藏时原句），
 * 删除直接落盘。新增入口在精听句卡（听写时顺手收）。
 */
export function VocabularyPage() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [store, setStore] = useState(loadStoredStudyStore)
  const [titles, setTitles] = useState<Record<number, string>>({})

  useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const catalog = await apiClient.getCatalog('zh-CN')
        const next: Record<number, string> = {}
        for (const category of catalog.categories) {
          const exercises = (await apiClient.getCategoryExercises(category.id, 'zh-CN')) as CatalogExerciseSummary[]
          for (const exercise of exercises) {
            next[exercise.id] = exercise.title
          }
        }
        if (mounted) setTitles(next)
      } catch {
        // 标题缺省不阻断列表
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  const entries = useMemo(
    () => collectVocabEntries(store.progressByExercise).sort((a, b) => a.courseId - b.courseId),
    [store.progressByExercise],
  )

  const remove = (courseId: number, word: string) => {
    setStore((current) => {
      const courseProgress = current.progressByExercise[courseId]
      if (!courseProgress?.vocabulary?.[word]) {
        return current
      }
      const vocabulary = { ...courseProgress.vocabulary }
      delete vocabulary[word]
      const next: StudyStore = {
        ...current,
        progressByExercise: {
          ...current.progressByExercise,
          [courseId]: { ...courseProgress, vocabulary },
        },
      }
      persistStudyStore(next)
      return next
    })
  }

  return (
    <div className="settings-page">
      <TopBar />
      <div className="settings-container">
        <header className="settings-header">
          <button aria-label={t('settings.back')} className="settings-back" onClick={() => navigate('/home')} type="button">
            ←
          </button>
          <h1 className="settings-title">{t('vocab.title')}</h1>
          <span className="global-review-total">{t('vocab.count', { count: entries.length })}</span>
        </header>

        {entries.length === 0 ? (
          <p className="dashboard-empty">{t('vocab.empty')}</p>
        ) : (
          <ul className="vocab-list">
            {entries.map((entry) => (
              <li className="vocab-row" key={`${entry.courseId}|${entry.word}`}>
                <div className="vocab-main">
                  <strong className="vocab-word">{entry.word}</strong>
                  <span className="vocab-context">{entry.context}</span>
                  <span className="vocab-course">{titles[entry.courseId] ?? `#${entry.courseId}`}</span>
                </div>
                <button
                  aria-label={t('vocab.delete')}
                  className="vocab-delete"
                  onClick={() => remove(entry.courseId, entry.word)}
                  title={t('vocab.delete')}
                  type="button"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
