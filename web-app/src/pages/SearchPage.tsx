import { Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { apiClient } from '../lib/apiClient'
import { loadCatalogBundle } from '../lib/catalogBundle'
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

/** 命中行 + 所属课程标题（搜索页渲染用）。 */
type SearchLineHit = SearchLine & { courseTitle: string }

type IndexState =
  | { status: 'idle' }
  | { status: 'building'; done: number; total: number }
  | { status: 'ready' }
  | { status: 'failed' }

// 模块级缓存：挂载共享，页面切换不重建
let cachedIndex: SearchIndex | null = null
let buildingPromise: Promise<SearchIndex> | null = null

/**
 * 单批并发数：全量课程逐课串行要 0.4-0.9s，分批并发可压掉一半以上。
 * 8 是本机 Express 的舒适区——再高（16/32 实测）没有进一步收益，反而会挤占学习页的播放请求。
 */
const INDEX_CONCURRENCY = 8

const buildIndex = (onProgress: (done: number, total: number) => void): Promise<SearchIndex> => {
  if (cachedIndex) return Promise.resolve(cachedIndex)
  if (buildingPromise) return buildingPromise

  buildingPromise = (async () => {
    // 目录与课程表来自共享目录包（与生词本/全局复习同一份缓存），
    // 不再各自 getCatalog + 逐系列列举
    const bundle = await loadCatalogBundle()
    const courses: SearchCourse[] = []
    for (const category of bundle.categories) {
      for (const exercise of bundle.byCategory[category.id] ?? []) {
        courses.push({ id: exercise.id, seriesId: category.id, title: exercise.title })
      }
    }
    const total = courses.length
    const lines: SearchLine[] = []
    // 分批并发：Promise.all 保持输入顺序，索引里的课程顺序与串行版一致（结果排序依赖它）
    for (let start = 0; start < total; start += INDEX_CONCURRENCY) {
      const batch = courses.slice(start, start + INDEX_CONCURRENCY)
      const chunks = await Promise.all(
        batch.map(async (course): Promise<SearchLine[]> => {
          try {
            const exercise = await apiClient.getExercise(course.id, 'zh-CN')
            return exercise.lines.map((line) => ({
              courseId: course.id,
              lineId: line.id,
              text: line.text,
              start: line.start,
            }))
          } catch {
            // 单课失败不拖垮整个索引：这门课搜不到，其余照常
            return []
          }
        }),
      )
      for (const chunk of chunks) lines.push(...chunk)
      onProgress(Math.min(start + batch.length, total), total)
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
 * 首页示例词：必须是语料里真实高频出现的词（197 套转写里 airbnb 出现 0 次，
 * 新用户照着 placeholder 输入只会得到「没有匹配的结果」，直接判定搜索坏了）。
 * 计数口径：presets 下 cet4/cet6 的 seed.json 正文行，注释里是该词的命中行数。
 */
const SUGGESTED_WORDS = [
  'research', // 217
  'university', // 118
  'company', // 130
  'interview', // 36
  'weather', // 27
  'travel', // 40
]

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

  // 内联包装：react-hooks/use-memo 不接受裸函数引用；loadStoredStudyStore 无参，行为不变
  const store = useMemo(() => loadStoredStudyStore(), [])
  const vocabEntries = useMemo(() => collectVocabEntries(store.progressByExercise), [store])

  const results = useMemo(() => {
    const q = debounced
    if (!q || indexState.status !== 'ready' || !cachedIndex) return null
    const lower = q.toLowerCase()
    // 一次遍历同时取结果与总数（原先 filter 跑两遍、7690 行扫两轮）；
    // 课程标题预建 Map，避免每条命中都 courses.find（D5）
    const titleByCourse = new Map(cachedIndex.courses.map((course) => [course.id, course.title]))
    const lineHits: SearchLineHit[] = []
    let lineTotal = 0
    for (const line of cachedIndex.lines) {
      if (!line.text.toLowerCase().includes(lower)) continue
      lineTotal += 1
      if (lineHits.length < RESULT_LIMIT) {
        lineHits.push({
          ...line,
          courseTitle: titleByCourse.get(line.courseId) ?? `#${line.courseId}`,
        })
      }
    }
    const lineTruncated = lineTotal > RESULT_LIMIT
    const vocabHits = vocabEntries.filter((entry) => entry.word.toLowerCase().includes(lower)).slice(0, 20)
    const courseHits = cachedIndex.courses
      .filter((course) => course.title.toLowerCase().includes(lower))
      .slice(0, 10)
    return {
      lineHits,
      lineTruncated,
      vocabHits,
      courseHits,
      empty: lineHits.length === 0 && vocabHits.length === 0 && courseHits.length === 0,
    }
  }, [debounced, indexState.status, vocabEntries])

  const jumpToLine = (courseId: number, lineId: string) => {
    const course = cachedIndex?.courses.find((item) => item.id === courseId)
    if (!course) return
    // 必须带 stage=intensive：无 stage 会落回泛听页，不消费选中行
    navigate(`/courses/${course.seriesId}/chapters/${courseId}?line=${lineId}&stage=intensive`)
  }

  return (
    <div className="settings-page">
      <TopBar active="search" />
      <div className="settings-container">
        <header className="settings-header">
          <h1 className="settings-title">{t('search.title')}</h1>
          <span className="global-review-total">{t('search.subtitle')}</span>
        </header>

        <div className="search-box">
          <Search className="search-box-icon" size={20} aria-hidden="true" />
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

        {!query && indexState.status === 'ready' && (
          <div className="search-suggest">
            <span className="search-suggest-label">{t('search.suggestLabel')}</span>
            {SUGGESTED_WORDS.map((word) => (
              <button
                className="search-suggest-chip"
                key={word}
                onClick={() => setQuery(word)}
                type="button"
              >
                {word}
              </button>
            ))}
          </div>
        )}

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
            {results.empty && (
              <div className="search-empty">
                <p className="page-empty-title">{t('search.empty')}</p>
                <p className="page-empty-text">{t('search.emptyHint')}</p>
                <div className="search-suggest">
                  {SUGGESTED_WORDS.slice(0, 4).map((word) => (
                    <button
                      className="search-suggest-chip"
                      key={word}
                      onClick={() => setQuery(word)}
                      type="button"
                    >
                      {word}
                    </button>
                  ))}
                </div>
              </div>
            )}

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
                        /* 带上查询词：生词本据此做本地筛选，用户点进来直接看到那个词 */
                        onClick={() => navigate(`/vocabulary?q=${encodeURIComponent(entry.word)}`)}
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
