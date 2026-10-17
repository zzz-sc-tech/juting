import { Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CatalogExerciseSummary } from '@juting/shared'
import { TopBar } from '../components/TopBar'
import { apiClient } from '../lib/apiClient'
import { loadStoredStudyStore } from '../lib/progressStore'
import { collectVocabEntries } from '../lib/vocab'
import { lookupVocab } from '../lib/vocabDict'
import { useLanguage } from '../i18n/LanguageProvider'

/**
 * 跨课搜索（/search）：38 课 × 7690 句的全文检索，外加生词与课程标题。
 *
 * 推荐方案是纯前端本地索引（零后端改动）：首次进入时经目录接口拉全量转写，
 * 内存里建一份扁平数组；includes 过滤在这个量级 < 5ms，不需要倒排索引。
 * 索引缓存为模块级变量——页面切换不重建，刷新页面才重建。
 * 全量拉取约 2MB / 3-8 秒，必须显示进度（"正在建立索引 12/38"），否则用户以为卡死。
 */

type SearchLine = {
  courseId: number
  lineId: string
  text: string
  start: number
}

type SearchCourse = {
  id: number
  seriesId: number
  title: string
}

type SearchIndex = {
  lines: SearchLine[]
  courses: SearchCourse[]
}

type IndexState =
  | { status: 'idle' }
  | { status: 'building'; done: number; total: number }
  | { status: 'ready' }
  | { status: 'failed' }

// 模块级缓存：挂载共享，页面切换不重建
let cachedIndex: SearchIndex | null = null
let buildingPromise: Promise<SearchIndex> | null = null

const buildIndex = (onProgress: (done: number, total: number) => void): Promise<SearchIndex> => {
  if (cachedIndex) return Promise.resolve(cachedIndex)
  if (buildingPromise) return buildingPromise

  buildingPromise = (async () => {
    const catalog = await apiClient.getCatalog('zh-CN')
    // 先把课程表拉齐（summary 级，廉价），得到 总课数 与 series 映射
    const courses: SearchCourse[] = []
    for (const category of catalog.categories) {
      const exercises = (await apiClient.getCategoryExercises(category.id, 'zh-CN')) as CatalogExerciseSummary[]
      for (const exercise of exercises) {
        courses.push({ id: exercise.id, seriesId: category.id, title: exercise.title })
      }
    }
    const total = courses.length
    let done = 0
    const lines: SearchLine[] = []
    for (const course of courses) {
      try {
        const exercise = await apiClient.getExercise(course.id, 'zh-CN')
        for (const line of exercise.lines) {
          lines.push({ courseId: course.id, lineId: line.id, text: line.text, start: line.start })
        }
      } catch {
        // 单课失败不拖垮整个索引：这门课搜不到，其余照常
      }
      done += 1
      onProgress(done, total)
    }
    const index: SearchIndex = { lines, courses }
    cachedIndex = index
    buildingPromise = null
    return index
  })().catch((error: unknown) => {
    buildingPromise = null
    throw error
  })

  return buildingPromise
}

/** 命中片段高亮：把 q 的出现处拆出来交给 <mark>。 */
const highlightParts = (text: string, query: string): Array<{ text: string; hit: boolean }> => {
  if (!query) return [{ text, hit: false }]
  const parts: Array<{ text: string; hit: boolean }> = []
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  let cursor = 0
  for (;;) {
    const at = lowerText.indexOf(lowerQuery, cursor)
    if (at < 0) {
      if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false })
      break
    }
    if (at > cursor) parts.push({ text: text.slice(cursor, at), hit: false })
    parts.push({ text: text.slice(at, at + query.length), hit: true })
    cursor = at + query.length
  }
  return parts
}

const Highlighted = ({ text, query }: { text: string; query: string }) => (
  <>
    {highlightParts(text, query).map((part, index) =>
      part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
    )}
  </>
)

const RESULT_LIMIT = 60

/**
 * 跨课搜索页：句子 / 生词 / 课程标题 三组结果，句子可跳精听定位。
 */
export function SearchPage() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  // 立即消费的搜索词（250ms 防抖后的 query）
  const [debounced, setDebounced] = useState('')
  const [indexState, setIndexState] = useState<IndexState>({ status: cachedIndex ? 'ready' : 'idle' })
  const inputRef = useRef<HTMLInputElement>(null)

  // 挂载即建索引（已建好则跳过）；进度实时刷到界面上
  useEffect(() => {
    if (cachedIndex) return
    let alive = true
    setIndexState({ status: 'building', done: 0, total: 38 })
    buildIndex((done, total) => {
      if (alive) setIndexState({ status: 'building', done, total })
    })
      .then(() => {
        if (alive) setIndexState({ status: 'ready' })
      })
      .catch(() => {
        if (alive) setIndexState({ status: 'failed' })
      })
    return () => {
      alive = false
    }
  }, [])

  // 输入防抖
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const store = useMemo(loadStoredStudyStore, [])
  const vocabEntries = useMemo(() => collectVocabEntries(store.progressByExercise), [store])

  const results = useMemo(() => {
    const q = debounced
    if (!q || indexState.status !== 'ready' || !cachedIndex) return null
    const lower = q.toLowerCase()
    const lineHits = cachedIndex.lines
      .filter((line) => line.text.toLowerCase().includes(lower))
      .slice(0, RESULT_LIMIT)
      .map((line) => ({
        ...line,
        courseTitle: cachedIndex?.courses.find((course) => course.id === line.courseId)?.title ?? `#${line.courseId}`,
      }))
    const lineTruncated =
      cachedIndex.lines.filter((line) => line.text.toLowerCase().includes(lower)).length > RESULT_LIMIT
    const vocabHits = vocabEntries.filter((entry) => entry.word.toLowerCase().includes(lower)).slice(0, 20)
    const courseHits = cachedIndex.courses.filter((course) => course.title.toLowerCase().includes(lower)).slice(0, 10)
    return { lineHits, lineTruncated, vocabHits, courseHits, empty: lineHits.length === 0 && vocabHits.length === 0 && courseHits.length === 0 }
  }, [debounced, indexState.status, vocabEntries])

  const jumpToLine = (courseId: number, lineId: string) => {
    const course = cachedIndex?.courses.find((item) => item.id === courseId)
    if (!course) return
    // 必须带 stage=intensive：无 stage 会落回泛听页，不消费选中行
    navigate(`/courses/${course.seriesId}/chapters/${courseId}?line=${lineId}&stage=intensive`)
  }

  return (
    <div className="settings-page">
      <TopBar />
      <div className="settings-container">
        <header className="settings-header">
          <h1 className="settings-title">{t('search.title')}</h1>
          <span className="global-review-total">{t('search.subtitle')}</span>
        </header>

        <div className="search-box">
          <Search className="search-box-icon" size={16} aria-hidden="true" />
          <input
            aria-label={t('search.placeholder')}
            autoComplete="off"
            className="search-box-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('search.placeholder')}
            ref={inputRef}
            type="search"
            value={query}
          />
          {query && (
            <button aria-label={t('search.clear')} className="search-box-clear" onClick={() => setQuery('')} type="button">
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        {indexState.status === 'building' && (
          <p className="search-status">
            {t('search.building', { done: indexState.done, total: indexState.total })}
          </p>
        )}
        {indexState.status === 'failed' && (
          <p className="search-status error">{t('search.failed')}</p>
        )}

        {results && debounced && (
          <div className="search-results">
            {results.empty && <p className="dashboard-empty">{t('search.empty')}</p>}

            {results.courseHits.length > 0 && (
              <section className="search-group">
                <h2 className="search-group-title">{t('search.groupCourses')}</h2>
                <ul className="search-list">
                  {results.courseHits.map((course) => (
                    <li key={course.id}>
                      <button
                        className="search-row"
                        onClick={() => navigate(`/courses/${course.seriesId}/chapters/${course.id}?stage=intensive`)}
                        type="button"
                      >
                        <Highlighted query={debounced} text={course.title} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {results.vocabHits.length > 0 && (
              <section className="search-group">
                <h2 className="search-group-title">{t('search.groupVocab')}</h2>
                <ul className="search-list">
                  {results.vocabHits.map((entry) => (
                    <li key={`${entry.courseId}|${entry.word}`}>
                      <button
                        className="search-row"
                        onClick={() => navigate('/vocabulary')}
                        type="button"
                      >
                        <span className="search-vocab-word">
                          <Highlighted query={debounced} text={entry.word} />
                        </span>
                        <span className="search-vocab-meaning">{lookupVocab(entry.word)?.zh ?? ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {results.lineHits.length > 0 && (
              <section className="search-group">
                <h2 className="search-group-title">
                  {t('search.groupLines', { count: results.lineTruncated ? `${RESULT_LIMIT}+` : String(results.lineHits.length) })}
                </h2>
                <ul className="search-list">
                  {results.lineHits.map((line) => (
                    <li key={`${line.courseId}:${line.lineId}`}>
                      <button className="search-row" onClick={() => jumpToLine(line.courseId, line.lineId)} type="button">
                        <span className="search-row-course">{line.courseTitle}</span>
                        <span className="search-row-text">
                          <Highlighted query={debounced} text={line.text} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
