import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 进度存档的「不许静默丢数据」契约（A1 / A2）。
 *
 * 这两条曾经真的出过事：JSON 坏一次 → 800ms 后整仓被空数据覆盖；
 * 配额满 → 6 个模块全部 catch 吞掉，用户以为在学，其实什么都没存。
 * 这里守住：坏档必须留档 + 暂停写盘；写失败必须能被观察到。
 */

const storeKey = 'juting.web.progress.v1'

const makeStorage = (seed: Record<string, string> = {}) => {
  const map = new Map<string, string>(Object.entries(seed))
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  } as Storage
  return { map, storage }
}

/** 每次重新加载模块：progressStore 的「暂停写盘」是模块级状态，测试间必须隔离。 */
const setup = async (seed: Record<string, string> = {}) => {
  const { map, storage } = makeStorage(seed)
  globalThis.localStorage = storage
  vi.resetModules()
  const progressStore = await import('./progressStore')
  const storageSafety = await import('./storageSafety')
  // dataBackup 在加载时注册「裁快照」空间回收器，与 main.tsx 的真实加载路径一致
  await import('./dataBackup')
  return { map, progressStore, storageSafety }
}

beforeEach(() => {
  vi.resetModules()
})

describe('loadStoredStudyStore', () => {
  it('合法存档原样读出', async () => {
    const raw = JSON.stringify({
      activeExerciseId: 13,
      progressByExercise: { '13': { lines: { l1: { mastered: true } } } },
    })
    const { progressStore } = await setup({ [storeKey]: raw })
    const store = progressStore.loadStoredStudyStore()
    expect(store.activeExerciseId).toBe(13)
    expect(store.progressByExercise['13'].lines.l1.mastered).toBe(true)
    expect(progressStore.isProgressWriteBlocked()).toBe(false)
  })

  it('JSON 坏掉时：返回空仓库 + 原始字符串隔离另存 + 暂停写盘', async () => {
    const { map, progressStore } = await setup({ [storeKey]: '{broken' })
    const store = progressStore.loadStoredStudyStore()

    expect(store).toEqual({ activeExerciseId: '', progressByExercise: {} })
    // 关键：原键一个字节都没被改写（否则 800ms 后被空仓库覆盖，永久不可恢复）
    expect(map.get(storeKey)).toBe('{broken')
    const quarantine = [...map.keys()].filter((key) => key.startsWith('juting.web.progress.corrupt.'))
    expect(quarantine).toHaveLength(1)
    expect(map.get(quarantine[0])).toBe('{broken')
    expect(progressStore.isProgressWriteBlocked()).toBe(true)
  })

  it('暂停写盘期间 persistStudyStore 不落盘，恢复后才写', async () => {
    const { map, progressStore } = await setup({ [storeKey]: '[]' })
    progressStore.loadStoredStudyStore()

    expect(progressStore.persistStudyStore({ activeExerciseId: 7, progressByExercise: {} })).toBe(false)
    expect(map.get(storeKey)).toBe('[]')

    progressStore.resumeProgressWrites()
    expect(progressStore.persistStudyStore({ activeExerciseId: 7, progressByExercise: {} })).toBe(true)
    expect(JSON.parse(map.get(storeKey) ?? '{}').activeExerciseId).toBe(7)
  })

  it('顶层是数组（结构不符）同样按整块损坏处理', async () => {
    const { progressStore } = await setup({ [storeKey]: '[1,2,3]' })
    progressStore.loadStoredStudyStore()
    expect(progressStore.isProgressWriteBlocked()).toBe(true)
  })

  it('部分课程缺 lines：丢弃该课、隔离原始数据，但不锁写盘（其余进度要能继续存）', async () => {
    const raw = JSON.stringify({
      activeExerciseId: '',
      progressByExercise: {
        '1': { lines: { a: { mastered: true } } },
        '2': { lastLineId: 'x' },
      },
    })
    const { map, progressStore } = await setup({ [storeKey]: raw })
    const store = progressStore.loadStoredStudyStore()

    expect(Object.keys(store.progressByExercise)).toEqual(['1'])
    expect(progressStore.getLastDroppedCount()).toBe(1)
    expect(progressStore.isProgressWriteBlocked()).toBe(false)
    expect([...map.keys()].some((key) => key.startsWith('juting.web.progress.corrupt.'))).toBe(true)
  })
})

describe('storageSafety', () => {
  it('配额溢出：置 quota 标志并返回 false', async () => {
    const { progressStore, storageSafety } = await setup({ [storeKey]: '{"progressByExercise":{}}' })
    globalThis.localStorage.setItem = () => {
      const error = new Error('full') as Error & { name: string }
      error.name = 'QuotaExceededError'
      throw error
    }
    progressStore.loadStoredStudyStore()
    expect(progressStore.persistStudyStore({ activeExerciseId: '', progressByExercise: {} })).toBe(false)
    expect(storageSafety.getStorageIssue()?.kind).toBe('quota')
  })

  it('隐私模式（非配额异常）区分为 write-failed', async () => {
    const { storageSafety } = await setup()
    globalThis.localStorage.setItem = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    expect(storageSafety.safeSetItem('k', 'v')).toBe(false)
    expect(storageSafety.getStorageIssue()?.kind).toBe('write-failed')
  })

  it('配额溢出时先回收旧快照再重试', async () => {
    const snapshots = JSON.stringify([
      { at: '2026-10-17T10:00:00.000Z', progress: { progressByExercise: {} }, activity: {} },
      { at: '2026-10-17T09:00:00.000Z', progress: { progressByExercise: {} }, activity: {} },
    ])
    const { map, progressStore } = await setup({
      [storeKey]: '{"progressByExercise":{}}',
      'juting.web.autobackup.v1': snapshots,
    })
    progressStore.loadStoredStudyStore()

    // 第一次写主数据抛配额；裁掉一份快照后放行
    let attempts = 0
    const originalSet = globalThis.localStorage.setItem.bind(globalThis.localStorage)
    globalThis.localStorage.setItem = (key: string, value: string) => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error('full') as Error & { name: string }
        error.name = 'QuotaExceededError'
        throw error
      }
      originalSet(key, value)
    }

    progressStore.persistStudyStore({ activeExerciseId: 3, progressByExercise: {} })
    const kept = JSON.parse(map.get('juting.web.autobackup.v1') ?? '[]')
    expect(kept).toHaveLength(1)
    expect(JSON.parse(map.get(storeKey) ?? '{}').activeExerciseId).toBe(3)
  })
})
