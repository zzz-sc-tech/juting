import { beforeEach, describe, expect, it } from 'vitest'
import {
  accuracyOf,
  emptyDrillStats,
  loadDrillStats,
  normalizeDrillStats,
  recordDrillAnswer,
  resetDrillStats,
} from './drillStats'

/**
 * 专项刷题累计：逐 Section 计数、畸形数据归零、正确率口径。
 * 与 examHistory 分账是设计裁定——这里只验证「自己的账自己记」。
 */

const installStorage = (seed: Record<string, string> = {}) => {
  const map = new Map<string, string>(Object.entries(seed))
  globalThis.localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  } as Storage
  return map
}

describe('normalizeDrillStats', () => {
  it('空对象补成三个 Section 全零', () => {
    expect(normalizeDrillStats({})).toEqual(emptyDrillStats())
  })

  it('缺 Section 的补零，其余保留', () => {
    const stats = normalizeDrillStats({ C: { correct: 4, wrong: 1 } })
    expect(stats?.C).toEqual({ correct: 4, wrong: 1 })
    expect(stats?.A).toEqual({ correct: 0, wrong: 0 })
  })

  it('负数/小数/字符串一律归零，不把脏值当真', () => {
    const stats = normalizeDrillStats({ A: { correct: -3, wrong: '2' }, B: { correct: 2.7, wrong: 1 } })
    expect(stats?.A).toEqual({ correct: 0, wrong: 0 })
    expect(stats?.B).toEqual({ correct: 2, wrong: 1 })
  })

  it('非对象直接判空（数组、字符串、null）', () => {
    expect(normalizeDrillStats([])).toBeNull()
    expect(normalizeDrillStats('x')).toBeNull()
    expect(normalizeDrillStats(null)).toBeNull()
  })
})

describe('累计与读盘', () => {
  beforeEach(() => {
    installStorage()
  })

  it('答对答错分别累加，且立刻可读', () => {
    recordDrillAnswer('C', true)
    recordDrillAnswer('C', true)
    recordDrillAnswer('C', false)
    const stats = loadDrillStats()
    expect(stats.C).toEqual({ correct: 2, wrong: 1 })
    expect(stats.A).toEqual({ correct: 0, wrong: 0 })
  })

  it('清空后回到全零', () => {
    recordDrillAnswer('A', true)
    resetDrillStats()
    expect(loadDrillStats()).toEqual(emptyDrillStats())
  })

  it('存储里是脏 JSON 时退回全零，不抛错', () => {
    installStorage({ 'juting.web.drill-stats.v1': '{oops' })
    expect(loadDrillStats()).toEqual(emptyDrillStats())
  })
})

describe('accuracyOf', () => {
  it('没做过返回 null（界面显示 — 而不是 0%）', () => {
    expect(accuracyOf({ correct: 0, wrong: 0 })).toBeNull()
  })

  it('四舍五入到整数百分比', () => {
    expect(accuracyOf({ correct: 2, wrong: 1 })).toBe(67)
    expect(accuracyOf({ correct: 3, wrong: 1 })).toBe(75)
    expect(accuracyOf({ correct: 1, wrong: 0 })).toBe(100)
  })
})
