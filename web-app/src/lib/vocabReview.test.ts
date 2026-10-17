import { describe, expect, it } from 'vitest'
import {
  MASTERED_REVIEW_COUNT,
  applyReviewVerdict,
  blankContext,
  dueAtOf,
  dueWords,
  ensureVocabEntries,
  removeVocabEntry,
  scheduleBadgeOf,
  type VocabReviewEntry,
} from './vocabReview'

/**
 * 生词复习调度：间隔阶梯、到期待复习、认识/不认识的状态转移、老数据迁移。
 * 时间一律显式传入（不摸 Date.now / localStorage），保证可重复。
 */

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 17, 0, 0, 0)

const entry = (patch: Partial<VocabReviewEntry> = {}): VocabReviewEntry => ({
  addedAt: T0,
  reviewCount: 0,
  mastered: false,
  ...patch,
})

describe('dueAtOf：间隔阶梯 1 / 3 / 7 / 15 天', () => {
  it('reviewCount 0 → 1 天后', () => {
    expect(dueAtOf(entry({ reviewCount: 0 }))).toBe(T0 + 1 * DAY)
  })

  it('reviewCount 1 → 3 天后', () => {
    expect(dueAtOf(entry({ reviewCount: 1 }))).toBe(T0 + 3 * DAY)
  })

  it('reviewCount 2 → 7 天后', () => {
    expect(dueAtOf(entry({ reviewCount: 2 }))).toBe(T0 + 7 * DAY)
  })

  it('reviewCount 3 → 15 天后', () => {
    expect(dueAtOf(entry({ reviewCount: 3 }))).toBe(T0 + 15 * DAY)
  })

  it('显式 dueAt 优先于间隔推算（「不认识」后回到明天）', () => {
    expect(dueAtOf(entry({ reviewCount: 3, dueAt: T0 + DAY }))).toBe(T0 + DAY)
  })

  it('reviewCount 越界也不会算出 NaN', () => {
    expect(dueAtOf(entry({ reviewCount: 99 }))).toBe(T0 + 15 * DAY)
  })
})

describe('applyReviewVerdict：认识 / 不认识', () => {
  it('认识：次数 +1，清掉显式 dueAt，记录复习时间', () => {
    const next = applyReviewVerdict({ apple: entry({ reviewCount: 0, dueAt: T0 }) }, 'APPLE', 'known', T0 + DAY)
    const apple = next.apple
    expect(apple.reviewCount).toBe(1)
    expect(apple.dueAt).toBeUndefined()
    expect(apple.lastReviewedAt).toBe(T0 + DAY)
    expect(apple.mastered).toBe(false)
  })

  it('认识满 4 次标记已掌握（不再排队）', () => {
    const next = applyReviewVerdict({ apple: entry({ reviewCount: 3 }) }, 'apple', 'known', T0)
    expect(next.apple.reviewCount).toBe(MASTERED_REVIEW_COUNT)
    expect(next.apple.mastered).toBe(true)
  })

  it('不认识：次数归零、明天再来、已掌握也要重新排队', () => {
    const next = applyReviewVerdict({ apple: entry({ reviewCount: 3, mastered: true }) }, 'apple', 'unknown', T0)
    expect(next.apple.reviewCount).toBe(0)
    expect(next.apple.mastered).toBe(false)
    expect(next.apple.dueAt).toBe(T0 + DAY)
  })

  it('对没有记录的词复习也能建条目（addedAt = now）', () => {
    const next = applyReviewVerdict({}, 'NewWord', 'unknown', T0)
    expect(next.newword.addedAt).toBe(T0)
    expect(next.newword.reviewCount).toBe(0)
  })

  it('词键统一小写，不产生重复条目', () => {
    const next = applyReviewVerdict({ apple: entry() }, 'Apple', 'known', T0)
    expect(Object.keys(next)).toEqual(['apple'])
  })
})

describe('ensureVocabEntries：登记与老数据迁移', () => {
  it('新词按默认间隔登记（明天到期），已有词不动（幂等）', () => {
    const state = ensureVocabEntries({}, ['apple', 'apple', 'Apple'], { now: T0 })
    expect(Object.keys(state)).toEqual(['apple'])
    expect(state.apple.addedAt).toBe(T0)
    expect(state.apple.dueAt).toBeUndefined()

    const again = ensureVocabEntries(state, ['apple'], { now: T0 + 5 * DAY })
    expect(again).toBe(state)
  })

  it('dueNow 迁移：补时间并标记今日可复习（一次性）', () => {
    const state = ensureVocabEntries({}, ['legacy'], { dueNow: true, now: T0 })
    expect(state.legacy.dueAt).toBe(T0)
    expect(dueWords(state, ['legacy'], T0)).toEqual(['legacy'])
  })
})

describe('dueWords：到期待复习', () => {
  const state = {
    apple: entry({ reviewCount: 0 }), // 明天到期
    banana: entry({ reviewCount: 2, addedAt: T0 - 8 * DAY }), // 已到期
    cherry: entry({ reviewCount: 0, mastered: true, addedAt: T0 - 30 * DAY }), // 已掌握
  }

  it('只返回未掌握且已到期的词', () => {
    expect(dueWords(state, ['apple', 'banana', 'cherry'], T0)).toEqual(['banana'])
  })

  it('大小写与重复词去重后判断', () => {
    expect(dueWords(state, ['Banana', 'banana'], T0)).toEqual(['banana'])
  })

  it('没有登记记录的词不参与排队', () => {
    expect(dueWords(state, ['durian'], T0)).toEqual([])
  })
})

describe('scheduleBadgeOf：列表角标', () => {
  it('无记录返回 null', () => {
    expect(scheduleBadgeOf(undefined, T0)).toBeNull()
  })

  it('已掌握优先显示 mastered', () => {
    expect(scheduleBadgeOf(entry({ mastered: true }), T0)).toEqual({ kind: 'mastered', days: 0 })
  })

  it('已到期显示今天', () => {
    expect(scheduleBadgeOf(entry({ reviewCount: 0, addedAt: T0 - 2 * DAY }), T0)).toEqual({ kind: 'today', days: 0 })
  })

  it('未到期显示剩余天数（向上取整）', () => {
    expect(scheduleBadgeOf(entry({ reviewCount: 1 }), T0)?.days).toBe(3)
  })
})

describe('removeVocabEntry / blankContext', () => {
  it('删除按小写键清理，同词再收藏会重新排队', () => {
    const next = removeVocabEntry({ apple: entry() }, 'Apple')
    expect(next).toEqual({})
  })

  it('挖空原句：忽略大小写、整词替换', () => {
    expect(blankContext('I like Full-time jobs.', 'full-time')).toBe('I like ______ jobs.')
  })

  it('词不在句中时原样返回，不硬挖', () => {
    expect(blankContext('I like apples.', 'banana')).toBe('I like apples.')
  })

  it('空句或空词直接返回原句', () => {
    expect(blankContext('', 'apple')).toBe('')
    expect(blankContext('apple', '')).toBe('apple')
  })
})
