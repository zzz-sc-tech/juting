import { beforeEach, describe, expect, it } from 'vitest'
import { daysUntil, isValidExamDate, loadExamDate, parseDay, persistExamDate } from './examDate'

/**
 * 考试倒计时：日期校验、剩余天数（本地日界）、读写容错。
 * 这里守的是「差一天」——跨时区/夏令时用时间戳算天数必出错。
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

describe('parseDay / isValidExamDate', () => {
  it('合法日期解析出年月日', () => {
    expect(parseDay('2026-12-12')).toEqual({ year: 2026, month: 12, day: 12 })
  })

  it('不存在的日期视为非法（2026-02-30）', () => {
    expect(parseDay('2026-02-30')).toBeNull()
    expect(isValidExamDate('2026-02-30')).toBe(false)
  })

  it('格式不对一律非法', () => {
    for (const value of ['', '2026-12', '2026/12/12', '26-12-12', '2026-1-2']) {
      expect(isValidExamDate(value)).toBe(false)
    }
    expect(isValidExamDate(20261212)).toBe(false)
    expect(isValidExamDate(null)).toBe(false)
  })
})

describe('daysUntil', () => {
  const today = new Date(2026, 9, 29, 20, 30) // 2026-10-29 20:30 本地时间

  it('今天就是考试日 → 0', () => {
    expect(daysUntil('2026-10-29', today)).toBe(0)
  })

  it('临近日期按日界算，不受当前时分影响', () => {
    expect(daysUntil('2026-10-30', today)).toBe(1)
    expect(daysUntil('2026-11-01', today)).toBe(3)
  })

  it('六级考试日 2026-12-12 距 10-29 是 44 天', () => {
    expect(daysUntil('2026-12-12', today)).toBe(44)
  })

  it('已过日期返回负数（界面据此显示「已考完」）', () => {
    expect(daysUntil('2026-10-28', today)).toBe(-1)
  })

  it('非法日期返回 null', () => {
    expect(daysUntil('2026-02-30', today)).toBeNull()
  })
})

describe('读写', () => {
  beforeEach(() => {
    installStorage()
  })

  it('没设置过返回 null', () => {
    expect(loadExamDate()).toBeNull()
  })

  it('写入后能读回，清除后变 null', () => {
    persistExamDate('2026-12-12')
    expect(loadExamDate()).toBe('2026-12-12')
    persistExamDate(null)
    expect(loadExamDate()).toBeNull()
  })

  it('脏数据不写进存储', () => {
    persistExamDate('2026-13-01')
    expect(loadExamDate()).toBeNull()
  })

  it('存储里是脏值时读回 null（不把脏日期渲染成天数）', () => {
    installStorage({ 'juting.web.exam-date.v1': 'tomorrow' })
    expect(loadExamDate()).toBeNull()
  })
})
