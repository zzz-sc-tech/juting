/**
 * 专项刷题用到的单课详情（只要题干时间轴，不碰学习进度）。
 *
 * 为什么要单独一层缓存 + 预取：一道题能不能播、跳到精听落在哪一行，
 * 都要等这一份详情（约 70KB）回来才知道。等用户点开再请求，会有半秒空窗；
 * 在答本题时顺手把「下一题那门课」的详情取好，换题时直接命中。
 */
import type { ListeningExercise } from '@juting/shared'
import { apiClient } from './apiClient'

const cache = new Map<number, ListeningExercise>()
const inflight = new Map<number, Promise<ListeningExercise>>()

export const getCachedExerciseDetail = (exerciseId: number): ListeningExercise | undefined =>
  cache.get(exerciseId)

export const fetchExerciseDetail = (exerciseId: number): Promise<ListeningExercise> => {
  const cached = cache.get(exerciseId)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(exerciseId)
  if (running) return running
  const request = apiClient
    .getExercise(exerciseId, 'zh-CN')
    .then((exercise) => {
      cache.set(exerciseId, exercise)
      inflight.delete(exerciseId)
      return exercise
    })
    .catch((error: unknown) => {
      inflight.delete(exerciseId)
      throw error
    })
  inflight.set(exerciseId, request)
  return request
}

/** 静默预取：失败无所谓，等真正需要时会再请求一次并给出空态。 */
export const prefetchExerciseDetail = (exerciseId: number | null | undefined): void => {
  if (!exerciseId || cache.has(exerciseId) || inflight.has(exerciseId)) return
  void fetchExerciseDetail(exerciseId).catch(() => {
    // 预取失败不打扰用户
  })
}
