import { beforeEach, describe, expect, it } from 'vitest'
import {
  addDrillWrong,
  clearDrillWrong,
  drillWrongList,
  loadDrillWrong,
  normalizeDrillWrong,
  removeDrillWrong,
  wrongKey,
} from './drillWrong'

/**
 * 专项错题本：答错入队、答对出队、次数累加、脏数据丢弃。
 * 这本账直接决定「我的错题」里还剩什么，宁可丢条目也不能留垃圾。
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

describe('normalizeDrillWrong', () => {
  it('保留合法条目，丢弃缺字段/越界/非对象', () => {
    const store = normalizeDrillWrong({
      good: { exerciseId: 13, n: 9, wrongCount: 2, lastWrongAt: '2026-10-29T10:00:00.000Z' },
      noId: { n: 3, wrongCount: 1, lastWrongAt: '' },
      zeroN: { exerciseId: 13, n: 0, wrongCount: 1, lastWrongAt: '' },
      overN: { exerciseId: 13, n: 26, wrongCount: 1, lastWrongAt: '' },
      notObject: 'oops',
    })
    expect(Object.keys(store ?? {})).toEqual(['13:9'])
    expect(store?.['13:9'].wrongCount).toBe(2)
  })

  it('键按内容重建，不信外部写进来的 key', () => {
    const store = normalizeDrillWrong({ 'weird-key': { exerciseId: 7, n: 16, wrongCount: 1 } })
    expect(store?.['7:16']).toEqual({
      exerciseId: 7,
      n: 16,
      wrongCount: 1,
      lastWrongAt: '',
    })
  })

  it('非对象返回 null', () => {
    expect(normalizeDrillWrong([])).toBeNull()
    expect(normalizeDrillWrong('x')).toBeNull()
    expect(normalizeDrillWrong(null)).toBeNull()
  })
})

describe('增删与读盘', () => {
  beforeEach(() => {
    installStorage()
  })

  it('同一题答错两次累加次数并刷新时间', () => {
    addDrillWrong(13, 9, '2026-10-01T00:00:00.000Z')
    addDrillWrong(13, 9, '2026-10-05T00:00:00.000Z')
    const store = loadDrillWrong()
    expect(store[wrongKey(13, 9)].wrongCount).toBe(2)
    expect(store[wrongKey(13, 9)].lastWrongAt).toBe('2026-10-05T00:00:00.000Z')
  })

  it('答对即出队；删除不存在的题不报错', () => {
    addDrillWrong(13, 9)
    addDrillWrong(14, 3)
    removeDrillWrong(13, 9)
    expect(Object.keys(loadDrillWrong())).toEqual(['14:3'])
    expect(() => removeDrillWrong(99, 1)).not.toThrow()
    expect(Object.keys(loadDrillWrong())).toEqual(['14:3'])
  })

  it('清空后为空', () => {
    addDrillWrong(13, 9)
    clearDrillWrong()
    expect(loadDrillWrong()).toEqual({})
  })

  it('脏 JSON 退回空表，不抛错', () => {
    installStorage({ 'juting.web.drill-wrong.v1': '{broken' })
    expect(loadDrillWrong()).toEqual({})
  })
})

describe('drillWrongList', () => {
  it('按最后答错时间倒序（最近的先补）', () => {
    const list = drillWrongList({
      '1:1': { exerciseId: 1, n: 1, wrongCount: 1, lastWrongAt: '2026-10-01T00:00:00.000Z' },
      '2:2': { exerciseId: 2, n: 2, wrongCount: 1, lastWrongAt: '2026-10-09T00:00:00.000Z' },
      '3:3': { exerciseId: 3, n: 3, wrongCount: 1, lastWrongAt: '2026-10-05T00:00:00.000Z' },
    })
    expect(list.map((entry) => entry.exerciseId)).toEqual([2, 3, 1])
  })
})
