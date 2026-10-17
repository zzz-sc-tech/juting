import { Trash2 } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CatalogExerciseSummary } from '@juting/shared'
import { TopBar } from '../components/TopBar'
import { VocabSidebar } from '../components/VocabSidebar'
import { apiClient } from '../lib/apiClient'
import { splitClickableWords } from '../lib/clickableText'
import { loadStoredStudyStore, persistStudyStore } from '../lib/progressStore'
import type { StudyStore } from '@juting/shared'
import { collectVocabEntries } from '../lib/vocab'
import { capturePositions, playFlip } from '../lib/flip'
import { lookupVocab } from '../lib/vocabDict'
import {
  blankContext,
  dueWords,
  loadVocabReview,
  recordVocabVerdict,
  registerVocabWords,
  registerVocabWordsDueNow,
  scheduleBadgeOf,
  unregisterVocabWord,
  type VocabReviewState,
} from '../lib/vocabReview'
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
  // ---- 生词复习调度（旁路键 vocab-review.v1，见 lib/vocabReview.ts）----
  const [reviewState, setReviewState] = useState<VocabReviewState>(loadVocabReview)
  const [reviewQueue, setReviewQueue] = useState<string[]>([])
  const [reviewIdx, setReviewIdx] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [reviewDone, setReviewDone] = useState(0) // >0 = 本次复习完成的词数（0=不在复习模式）
  // 列表增删动画（FLIP，见 lib/flip.ts）：删除前记 First，提交后平滑上移
  const listRef = useRef<HTMLUListElement>(null)
  const prevVocabKeysRef = useRef<Set<string>>(new Set())
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

  // 老数据迁移：没有复习记录的词补登记并标记「今日可复习」（ensureVocabEntries 幂等，
  // 新收藏的词在收藏瞬间已被登记，不会被这里的 dueNow 扫到）
  useEffect(() => {
    if (entries.length === 0) return
    const state = loadVocabReview()
    const next = registerVocabWordsDueNow(entries.map((entry) => entry.word))
    if (next !== state) {
      setReviewState(next)
    }
  }, [entries])

  // 今日待复习队列（到期未掌握的词）
  const dueList = useMemo(
    () => dueWords(reviewState, entries.map((entry) => entry.word)),
    [reviewState, entries],
  )

  const startReview = () => {
    setReviewQueue(dueList)
    setReviewIdx(0)
    setRevealed(false)
    setReviewDone(0)
  }

  const handleVerdict = (known: boolean) => {
    const word = reviewQueue[reviewIdx]
    if (!word) return
    const next = recordVocabVerdict(word, known ? 'known' : 'unknown')
    setReviewState(next)
    setRevealed(false)
    if (reviewIdx + 1 >= reviewQueue.length) {
      setReviewDone(reviewQueue.length)
      setReviewQueue([])
      setReviewIdx(0)
    } else {
      setReviewIdx((current) => current + 1)
    }
  }

  const quitReview = () => {
    setReviewQueue([])
    setReviewDone(0)
    setReviewIdx(0)
    setRevealed(false)
  }

  const reviewEntry = useMemo(() => {
    const word = reviewQueue[reviewIdx]
    if (!word) return null
    return entries.find((entry) => entry.word.toLowerCase() === word) ?? null
  }, [entries, reviewIdx, reviewQueue])

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

  /** 状态提交（原 remove 的 React 部分）；动画包装在 remove 里。 */
  const commitRemove = (courseId: number, word: string) => {
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

  // 收藏新词 → 新行缩小淡入（FLIP 的新增分支逻辑，等 React 提交后对新节点播放）
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const nextKeys = new Set<string>()
    const added: string[] = []
    for (const entry of entries) {
      const k = `${entry.courseId}|${entry.word.toLowerCase()}`
      nextKeys.add(k)
      if (!prevVocabKeysRef.current.has(k)) added.push(k)
    }
    prevVocabKeysRef.current = nextKeys
    if (added.length === 0) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const k of added) {
          const el = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`)
          el?.animate(
            [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'scale(1)' }],
            { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
          )
        }
      })
    })
  }, [entries])

  const remove = (courseId: number, word: string) => {
    // 同步清掉复习调度记录（同词再收藏会重新排队）
    unregisterVocabWord(word)
    const list = listRef.current
    if (!list) {
      commitRemove(courseId, word)
      return
    }
    const first = capturePositions(list)
    const row = list.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(`${courseId}|${word.toLowerCase()}`)}"]`,
    )
    if (!row) {
      commitRemove(courseId, word)
      return
    }
    // 先淡出 120ms（比 FLIP 的 200ms 短，不拖沓），塌陷交给 React 提交后的 FLIP
    row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' })
    window.setTimeout(() => {
      commitRemove(courseId, word)
      playFlip(list, first)
    }, 120)
  }

  /**
   * 侧栏的「加入」归到点开的那一行所在课，收藏时原句也用**那一行自己的原句**
   * —— vocabulary 的 value 语义就是「这个词被收藏时所在的那句话」。
   */
  const addToCourse = (courseId: number, context: string, word: string) => {
    // 复习调度登记：新收藏的词按默认间隔明天才进复习队列
    registerVocabWords([word])
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
            {/* 复习入口：N>0 高亮可点，N=0 灰字提示 */}
            <div className="vocab-review-entry">
              {dueList.length > 0 ? (
                <button className="vocab-review-start" onClick={startReview} type="button">
                  {t('vocab.review.entry', { count: dueList.length })}
                </button>
              ) : (
                <span className="vocab-review-none">{t('vocab.review.none')}</span>
              )}
            </div>

            {/* 复习视图：挖空原句 → 显示答案 → 认识/不认识 */}
            {reviewQueue.length > 0 && reviewEntry && (
              <div className="vocab-review-card">
                <div className="vocab-review-head">
                  <span>
                    {t('vocab.review.progress', { current: reviewIdx + 1, total: reviewQueue.length })}
                  </span>
                  <button className="vocab-review-quit" onClick={quitReview} type="button">
                    {t('vocab.review.quit')}
                  </button>
                </div>
                <p className="vocab-review-course">
                  {titles[reviewEntry.courseId] ?? `#${reviewEntry.courseId}`}
                </p>
                <p className="vocab-review-context">{blankContext(reviewEntry.context, reviewEntry.word)}</p>
                {revealed ? (
                  <>
                    <p className="vocab-review-answer">
                      <strong>{reviewEntry.word}</strong>
                      {lookupVocab(reviewEntry.word)?.zh && (
                        <span className="vocab-review-meaning">{lookupVocab(reviewEntry.word)?.zh}</span>
                      )}
                    </p>
                    <p className="vocab-review-context-full">{reviewEntry.context}</p>
                    <div className="vocab-review-actions">
                      <button
                        className="vocab-review-btn unknown"
                        onClick={() => handleVerdict(false)}
                        type="button"
                      >
                        {t('vocab.review.unknown')}
                      </button>
                      <button
                        className="vocab-review-btn known"
                        onClick={() => handleVerdict(true)}
                        type="button"
                      >
                        {t('vocab.review.known')}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="vocab-review-actions">
                    <button className="vocab-review-btn primary" onClick={() => setRevealed(true)} type="button">
                      {t('vocab.review.showAnswer')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 本次复习完成 */}
            {reviewDone > 0 && (
              <div className="vocab-review-card">
                <p className="vocab-review-finished">{t('vocab.review.done', { count: reviewDone })}</p>
              </div>
            )}

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

            <ul className="vocab-list" ref={listRef}>
              {visible.map((entry) => {
                const lex = lookupVocab(entry.word)
                const badge = scheduleBadgeOf(reviewState[entry.word.toLowerCase()])
                return (
                  <li
                    className="vocab-row"
                    data-key={`${entry.courseId}|${entry.word.toLowerCase()}`}
                    key={`${entry.courseId}|${entry.word}`}
                  >
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
                        {badge && (
                          <span className={`vocab-review-badge ${badge.kind}`}>
                            {badge.kind === 'mastered'
                              ? t('vocab.review.mastered')
                              : badge.kind === 'today'
                                ? t('vocab.review.today')
                                : t('vocab.review.later', { days: badge.days })}
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