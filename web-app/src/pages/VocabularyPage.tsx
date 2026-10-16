import { Trash2 } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CatalogExerciseSummary } from '@juting/shared'
import { TopBar } from '../components/TopBar'
import { VocabSidebar } from '../components/VocabSidebar'
import { apiClient } from '../lib/apiClient'
import { splitClickableWords } from '../lib/clickableText'
import { loadStoredStudyStore, persistStudyStore } from '../lib/progressStore'
import type { StudyStore } from '@juting/shared'
import { collectVocabEntries } from '../lib/vocab'
import { lookupVocab } from '../lib/vocabDict'
import type { MessageKey } from '../i18n/messages'
import { useLanguage } from '../i18n/LanguageProvider'

/** ECDICT tag → 文案键（生成脚本只输出这几种） */
const TAG_MESSAGE_KEYS: Record<string, MessageKey> = {
  cet6: 'vocab.tag.cet6',
  ky: 'vocab.tag.ky',
  cet4: 'vocab.tag.cet4',
  toefl: 'vocab.tag.toefl',
  ielts: 'vocab.tag.ielts',
  gk: 'vocab.tag.gk',
  zk: 'vocab.tag.zk',
  gre: 'vocab.tag.gre',
}

/**
 * 生词本（/vocabulary）：跨课程聚合收藏的生词（词 + 收藏时原句），
 * 删除直接落盘。新增入口是精听句卡里点句中的单词（词典侧栏一键收藏），
 * 手动输入入口仍在。列表带音标/释义，点词或点原句里的词都能看详情。
 */
export function VocabularyPage() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [store, setStore] = useState(loadStoredStudyStore)
  const [titles, setTitles] = useState<Record<number, string>>({})
  /** courseId → seriesId（例句跳转要拼 /courses/:seriesId/chapters/:courseId） */
  const [seriesOf, setSeriesOf] = useState<Record<number, number>>({})
  const [courseFilter, setCourseFilter] = useState('all')
  /** 侧栏看的是哪个词、归到哪一课、以及收藏时要记的原句（都取自点开的那一行） */
  const [dictTarget, setDictTarget] = useState<{
    word: string
    courseId: number
    context: string
  } | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const catalog = await apiClient.getCatalog('zh-CN')
        const next: Record<number, string> = {}
        const series: Record<number, number> = {}
        for (const category of catalog.categories) {
          const exercises = (await apiClient.getCategoryExercises(category.id, 'zh-CN')) as CatalogExerciseSummary[]
          for (const exercise of exercises) {
            next[exercise.id] = exercise.title
            series[exercise.id] = category.id
          }
        }
        if (!mounted) return
        setTitles(next)
        setSeriesOf(series)
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

  const courseOptions = useMemo(() => {
    const ids = [...new Set(entries.map((entry) => entry.courseId))].sort((a, b) => a - b)
    return ids.map((id) => ({
      id,
      count: entries.filter((entry) => entry.courseId === id).length,
    }))
  }, [entries])

  const visible = useMemo(
    () =>
      courseFilter === 'all'
        ? entries
        : entries.filter((entry) => String(entry.courseId) === courseFilter),
    [entries, courseFilter],
  )

  const remove = (courseId: number, word: string) => {
    setStore((current) => {
      const courseProgress = current.progressByExercise[courseId]
      // 删除同样忽略大小写：侧栏的「已收藏」判定就是忽略大小写的
      const key = Object.keys(courseProgress?.vocabulary ?? {}).find(
        (item) => item.toLowerCase() === word.toLowerCase(),
      )
      if (!courseProgress || !key) {
        return current
      }
      const vocabulary = { ...courseProgress.vocabulary }
      delete vocabulary[key]
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
    // 侧栏开着的正是被删的那个词：删完收起，免得停在一个空壳上
    setDictTarget((current) =>
      current?.word.toLowerCase() === word.toLowerCase() ? null : current,
    )
  }

  /**
   * 侧栏的「加入」归到点开的那一行所在课，收藏时原句也用**那一行自己的原句**
   * —— vocabulary 的 value 语义就是「这个词被收藏时所在的那句话」。
   */
  const addToCourse = (courseId: number, context: string, word: string) => {
    setStore((current) => {
      const courseProgress = current.progressByExercise[courseId]
      if (!courseProgress) return current
      const existingKey = Object.keys(courseProgress.vocabulary ?? {}).find(
        (key) => key.toLowerCase() === word.toLowerCase(),
      )
      if (existingKey) return current
      const next: StudyStore = {
        ...current,
        progressByExercise: {
          ...current.progressByExercise,
          [courseId]: {
            ...courseProgress,
            vocabulary: { ...courseProgress.vocabulary, [word]: context },
          },
        },
      }
      persistStudyStore(next)
      return next
    })
  }

  const dictWordSaved = useMemo(() => {
    if (!dictTarget) return false
    const target = dictTarget.word.toLowerCase()
    return entries.some((entry) => entry.word.toLowerCase() === target)
  }, [dictTarget, entries])

  // 把某一课的词删光后，筛选下拉还留着那个已不存在的课号——列表会整片空白且无解释
  useEffect(() => {
    if (courseFilter === 'all') return
    if (!courseOptions.some((option) => String(option.id) === courseFilter)) {
      setCourseFilter('all')
    }
  }, [courseFilter, courseOptions])

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
          <>
            {courseOptions.length > 1 && (
              <div className="vocab-filter">
                <label className="sr-only" htmlFor="vocab-course-filter">
                  {t('vocab.filterLabel')}
                </label>
                <select
                  id="vocab-course-filter"
                  onChange={(event) => setCourseFilter(event.target.value)}
                  value={courseFilter}
                >
                  <option value="all">{`${t('vocab.filterAll')}（${entries.length}）`}</option>
                  {courseOptions.map((option) => (
                    <option key={option.id} value={String(option.id)}>
                      {`${titles[option.id] ?? `#${option.id}`}（${option.count}）`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <ul className="vocab-list">
              {visible.map((entry) => {
                const lex = lookupVocab(entry.word)
                return (
                  <li className="vocab-row" key={`${entry.courseId}|${entry.word}`}>
                    <div className="vocab-main">
                      <div className="vocab-lex">
                        <button
                          className="vocab-word"
                          onClick={() => setDictTarget({ word: entry.word, courseId: entry.courseId, context: entry.context })}
                          title={t('vocab.clickHint')}
                          type="button"
                        >
                          {entry.word}
                        </button>
                        {lex?.ph && <span className="vocab-lex-phonetic">{`/${lex.ph}/`}</span>}
                        {lex?.tag && TAG_MESSAGE_KEYS[lex.tag] && (
                          <span className={`vocab-tag vocab-tag-${lex.tag}`}>
                            {t(TAG_MESSAGE_KEYS[lex.tag])}
                          </span>
                        )}
                      </div>
                      {lex?.zh ? (
                        <p className="vocab-lex-zh">{lex.zh}</p>
                      ) : (
                        <span className="vocab-missing">{t('vocab.notInDict')}</span>
                      )}
                      <p className="vocab-context">
                        {splitClickableWords(entry.context).map((part, index) =>
                          part.type === 'word' ? (
                            <span
                              className="clickable-word"
                              key={`${index}-${part.text}`}
                              onClick={() => setDictTarget({ word: part.text, courseId: entry.courseId, context: entry.context })}
                              title={t('vocab.clickHint')}
                            >
                              {part.text}
                            </span>
                          ) : (
                            <Fragment key={`${index}-gap`}>{part.text}</Fragment>
                          ),
                        )}
                      </p>
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
                )
              })}
            </ul>
          </>
        )}
      </div>

      {dictTarget && (
        <VocabSidebar
          courseTitles={titles}
          onAdd={(word) => addToCourse(dictTarget.courseId, dictTarget.context, word)}
          onClose={() => setDictTarget(null)}
          onJumpToLine={(courseId, lineId) => {
            // 系列映射还没从目录接口回来就别跳——宁可点不动，也不要把用户丢到 /courses/0
            const seriesId = seriesOf[courseId]
            if (!seriesId) return
            // 必须带 stage=intensive：无 stage 会落回泛听页，那一页根本不消费选中行
            navigate(`/courses/${seriesId}/chapters/${courseId}?line=${lineId}&stage=intensive`)
          }}
          onRemove={(word) => {
            const target = word.toLowerCase()
            const owned =
              entries.find(
                (item) =>
                  item.courseId === dictTarget.courseId &&
                  item.word.toLowerCase() === target,
              ) ?? entries.find((item) => item.word.toLowerCase() === target)
            if (owned) remove(owned.courseId, owned.word)
          }}
          saved={dictWordSaved}
          word={dictTarget.word}
        />
      )}
    </div>
  )
}