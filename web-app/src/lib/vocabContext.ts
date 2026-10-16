import { useEffect, useMemo, useState } from 'react'
import { apiClient } from './apiClient'

/**
 * 词典侧栏「本库例句」的取文本能力。
 *
 * 生成词条里只存了语境坐标（课 id + 行 id），不存句子本身——句子就是全库
 * 转写，重复一份会让词典体积翻倍。当前课的句子调用方已经在内存里，直接传；
 * 其它课的句子按需从目录接口拉一次，会话内缓存。
 */

/** courseId → lineId → 行文本 */
const cache = new Map<number, Record<string, string>>()
const pending = new Map<number, Promise<Record<string, string>>>()
/** 拉取失败的课：不再重试，界面据此显示「加载失败」而不是一直「加载中」 */
const failed = new Set<number>()

/** 该课的例句是否已确认拉取失败（区别于「还在加载」）。 */
export const hasVocabContextFailed = (courseId: number): boolean => failed.has(courseId)

const loadCourseLines = (courseId: number): Promise<Record<string, string>> => {
  const cached = cache.get(courseId)
  if (cached) return Promise.resolve(cached)
  const inflight = pending.get(courseId)
  if (inflight) return inflight
  const request = apiClient
    .getExercise(courseId, 'zh-CN')
    .then((exercise) => {
      const lines: Record<string, string> = {}
      for (const line of exercise.lines) lines[line.id] = line.text
      cache.set(courseId, lines)
      return lines
    })
    .catch(() => {
      // 取不到就把这课标记为空并记为失败，避免每次开侧栏都重试；释义照常展示
      cache.set(courseId, {})
      failed.add(courseId)
      return {} as Record<string, string>
    })
    .finally(() => pending.delete(courseId))
  pending.set(courseId, request)
  return request
}

/**
 * 按语境坐标取行文本，返回 `${courseId}:${lineId}` → 文本 的映射。
 * 拉取中/失败的坐标不出现在结果里，调用方据此显示占位。
 */
export const useVocabContextLines = (
  ctx: readonly (readonly [number, string])[] | undefined,
  localLines?: Record<number, Record<string, string>>,
): Record<string, string> => {
  const [fetched, setFetched] = useState<Record<string, string>>({})

  const missing = useMemo(() => {
    const ids: number[] = []
    for (const [courseId] of ctx ?? []) {
      if (localLines?.[courseId] || cache.has(courseId) || ids.includes(courseId)) continue
      ids.push(courseId)
    }
    return ids
  }, [ctx, localLines])

  // 用字符串做依赖：调用方每次渲染都新建数组时也不会反复发请求
  const missingKey = missing.join(',')
  useEffect(() => {
    if (!missingKey) return
    let alive = true
    for (const courseId of missingKey.split(',').map(Number)) {
      void loadCourseLines(courseId).then((lines) => {
        if (!alive || !Object.keys(lines).length) return
        setFetched((current) => {
          const next = { ...current }
          for (const [lineId, text] of Object.entries(lines)) {
            next[`${courseId}:${lineId}`] = text
          }
          return next
        })
      })
    }
    return () => {
      alive = false
    }
  }, [missingKey])

  return useMemo(() => {
    const result = { ...fetched }
    for (const [courseId, lineId] of ctx ?? []) {
      const key = `${courseId}:${lineId}`
      // 本课的行文本调用方已经在内存里
      const local = localLines?.[courseId]?.[lineId]
      if (local) {
        result[key] = local
        continue
      }
      // 其它课：回读模块级缓存。侧栏每次开关都是重新挂载（组件 state 会丢），
      // 而 missing 计算里 cache.has() 会跳过已缓存的课——不回读的话
      // 「第二次打开同一个词」就永远停在「例句加载中」。
      const cached = cache.get(courseId)?.[lineId]
      if (cached) result[key] = cached
    }
    return result
  }, [ctx, fetched, localLines])
}