import type { CatalogExerciseSummary, ExerciseCategory } from '@juting/domain'
import { fetchCatalogCached } from '../hooks/useCatalog'
import { requestCategoryExercises } from '../hooks/useCategoryExercises'

/**
 * 目录 + 全部课程摘要的共享加载器。
 *
 * 三处页面（生词本 / 全局复习 / 搜索）原先各自 `getCatalog` + 逐系列
 * `getCategoryExercises`，一次会话里同一份数据被拉 3–4 遍（D1）。
 * 这里直接复用 hook 的模块级缓存，所以「仪表盘拉过的目录」在生词本里
 * 不会再拉第二遍；并发调用也共享同一个 promise。
 *
 * 列表统一走 `view=summary`（C2）：只要列表字段，不背 questions/answerKey。
 */
export type CatalogBundle = {
  categories: ExerciseCategory[]
  /** courseId → seriesId（拼 /courses/:seriesId/chapters/:courseId 用） */
  seriesOf: Record<number, number>
  /** courseId → 课程标题 */
  titleOf: Record<number, string>
  /** seriesId → 该系列下的课程摘要 */
  byCategory: Record<number, CatalogExerciseSummary[]>
}

let bundlePromise: Promise<CatalogBundle> | null = null

const build = async (): Promise<CatalogBundle> => {
  const catalog = await fetchCatalogCached('zh-CN:anonymous', 'zh-CN')
  const seriesOf: Record<number, number> = {}
  const titleOf: Record<number, string> = {}
  const byCategory: Record<number, CatalogExerciseSummary[]> = {}

  for (const category of catalog.categories) {
    const exercises = await requestCategoryExercises(category.id, 'zh-CN')
    byCategory[category.id] = exercises
    for (const exercise of exercises) {
      seriesOf[exercise.id] = category.id
      titleOf[exercise.id] = exercise.title
    }
  }

  return { categories: catalog.categories, seriesOf, titleOf, byCategory }
}

/** 共享的目录包；失败不缓存，下次调用会重试。 */
export const loadCatalogBundle = (): Promise<CatalogBundle> => {
  if (!bundlePromise) {
    bundlePromise = build().catch((error: unknown) => {
      bundlePromise = null
      throw error
    })
  }
  return bundlePromise
}
