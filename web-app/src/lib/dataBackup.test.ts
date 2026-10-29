import { beforeEach, describe, expect, it } from 'vitest'
import {
  exportAll,
  importAll,
  listAutoSnapshots,
  mergeActivity,
  mergeExamHistory,
  mergeListenTime,
  mergeProgress,
  mergeVocabReview,
  parseBackup,
  restoreAutoSnapshot,
  snapshotForAutobackup,
} from './dataBackup'

/**
 * 备份导出/导入的纯函数与校验逻辑。
 * 重点守两件曾出过事的地方：畸形文件必须拒绝；合并导入不能丢句子/生词。
 */

const valid = (data: Record<string, unknown>) => ({
  format: 'juting-backup',
  version: 1,
  exportedAt: '2026-10-17T08:00:00.000Z',
  data,
})

describe('parseBackup', () => {
  it('合法备份原样通过，并补齐 exportedAt', () => {
    const parsed = parseBackup(JSON.stringify(valid({ dailyGoal: '20' })))
    expect(parsed.format).toBe('juting-backup')
    expect(parsed.version).toBe(1)
    expect(parsed.data.dailyGoal).toBe('20')
    expect(parsed.exportedAt).toBe('2026-10-17T08:00:00.000Z')
  })

  it('非 JSON 文本抛「不是合法的 JSON」', () => {
    expect(() => parseBackup('not json at all')).toThrow(/JSON/)
  })

  it('畸形备份（缺 format）必须抛错', () => {
    expect(() => parseBackup('{"version":1,"data":{}}')).toThrow(/format/)
  })

  it('format 对但版本不支持要拒绝', () => {
    expect(() =>
      parseBackup('{"format":"juting-backup","version":2,"data":{}}'),
    ).toThrow(/version/)
  })

  it('缺 data 数据区要拒绝', () => {
    expect(() => parseBackup('{"format":"juting-backup","version":1}')).toThrow(/data/)
  })

  it('顶层是数组也要拒绝（防止把列表当备份写进存储）', () => {
    expect(() => parseBackup('[]')).toThrow(/备份格式/)
  })

  it('exportedAt 不是字符串时退化为空串，不抛错', () => {
    const parsed = parseBackup('{"format":"juting-backup","version":1,"exportedAt":1,"data":{}}')
    expect(parsed.exportedAt).toBe('')
  })
})

describe('mergeProgress', () => {
  const merged = (local: unknown, incoming: unknown) =>
    mergeProgress(local, incoming) as {
      activeExerciseId: string
      progressByExercise: Record<string, Record<string, unknown>>
    }

  it('合并时备份侧较新的新增句子要并入（曾丢数据）', () => {
    const local = { progressByExercise: { '13': { lines: { l1: { mastered: true, repeatCount: 3 } } } } }
    const incoming = { progressByExercise: { '13': { lines: { l1: {}, l2: { mastered: true } } } } }
    const result = merged(local, incoming)
    const lines = result.progressByExercise['13'].lines as Record<string, { mastered?: boolean }>
    expect(lines.l2.mastered).toBe(true)
    expect(lines.l1.mastered).toBe(true)
  })

  it('同句 mastered / unclear 取 OR，repeatCount 取 max', () => {
    const local = { progressByExercise: { '1': { lines: { a: { mastered: false, unclear: true, repeatCount: 2 } } } } }
    const incoming = { progressByExercise: { '1': { lines: { a: { mastered: true, unclear: false, repeatCount: 7 } } } } }
    const line = (merged(local, incoming).progressByExercise['1'].lines as Record<string, Record<string, unknown>>).a
    expect(line.mastered).toBe(true)
    expect(line.unclear).toBe(true)
    expect(line.repeatCount).toBe(7)
  })

  it('笔记与默写本地非空时不被备份覆盖；本地为空则采用备份', () => {
    const local = { progressByExercise: { '1': { lines: { a: { note: '本机笔记', dictation: '' } } } } }
    const incoming = { progressByExercise: { '1': { lines: { a: { note: '备份笔记', dictation: '备份默写' } } } } }
    const line = (merged(local, incoming).progressByExercise['1'].lines as Record<string, Record<string, unknown>>).a
    expect(line.note).toBe('本机笔记')
    expect(line.dictation).toBe('备份默写')
  })

  it('生词并集：两边都保留，同词时本机释义优先', () => {
    const local = { progressByExercise: { '1': { lines: {}, vocabulary: { apple: '苹果（本机）' } } } }
    const incoming = {
      progressByExercise: { '1': { lines: {}, vocabulary: { apple: '苹果（备份）', banana: '香蕉' } } },
    }
    const vocabulary = merged(local, incoming).progressByExercise['1'].vocabulary as Record<string, string>
    expect(vocabulary.apple).toBe('苹果（本机）')
    expect(vocabulary.banana).toBe('香蕉')
  })

  it('界面偏好取 updatedAt 较新的一方，extensivePasses 取 max', () => {
    const local = { progressByExercise: { '1': { lines: {}, updatedAt: '2026-10-01T00:00:00Z', lastLineId: 'l1', extensivePasses: 1 } } }
    const incoming = {
      progressByExercise: { '1': { lines: {}, updatedAt: '2026-10-10T00:00:00Z', lastLineId: 'l9', extensivePasses: 2 } },
    }
    const entry = merged(local, incoming).progressByExercise['1']
    expect(entry.lastLineId).toBe('l9')
    expect(entry.extensivePasses).toBe(2)
  })

  it('activeExerciseId 始终保留本机当前状态', () => {
    const result = merged({ activeExerciseId: 'local-id' }, { activeExerciseId: 'backup-id' })
    expect(result.activeExerciseId).toBe('local-id')
  })

  it('本机为空时以备份为基底（换机恢复）', () => {
    const result = merged(undefined, { progressByExercise: { '5': { lines: { x: { mastered: true } } } } })
    const lines = result.progressByExercise['5'].lines as Record<string, { mastered?: boolean }>
    expect(lines.x.mastered).toBe(true)
  })
})

describe('mergeActivity', () => {
  it('按日取 max，并丢弃非法日期与负值', () => {
    const result = mergeActivity(
      { '2026-10-01': 3, '2026-10-02': 1, bad: 9, '2026-10-03': -2 },
      { '2026-10-01': 5, '2026-10-02': 1, '2026-10-04': 4 },
    )
    expect(result).toEqual({ '2026-10-01': 5, '2026-10-02': 1, '2026-10-04': 4 })
  })

  it('输入不是对象时返回空表而不是抛错', () => {
    expect(mergeActivity('garbage', null)).toEqual({})
  })
})

describe('mergeExamHistory', () => {
  const attempt = (date: string, score: number, wrong: number[]) => ({
    date,
    score,
    total: 25,
    wrong,
    unanswered: 0,
    wrongBySection: { A: 0, B: 0, C: 0 },
  })

  it('逐场去重，不同场次保留（按日期+分数+错题数判重）', () => {
    const local = { '7': [attempt('2026-10-01', 20, [1, 2])] }
    const incoming = {
      '7': [attempt('2026-10-01', 20, [1, 2]), attempt('2026-10-08', 23, [4])],
    }
    const merged = mergeExamHistory(local, incoming)
    expect(merged['7']).toHaveLength(2)
    expect(merged['7'][1].date).toBe('2026-10-08')
  })

  it('畸形场次（缺日期/分数非数字）被丢弃，不污染档案', () => {
    const merged = mergeExamHistory(
      {},
      { '7': [attempt('2026-10-01', 20, [1]), { score: 'x' }, null] },
    )
    expect(merged['7']).toHaveLength(1)
  })
})

describe('importAll（合并 / 替换）', () => {
  const storage = new Map<string, string>()
  beforeEach(() => {
    storage.clear()
    globalThis.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size
      },
    } as Storage
  })

  it('replace 原样写回并记录导入键', () => {
    const backup = parseBackup(JSON.stringify(valid({ dailyGoal: '30', theme: 'exam' })))
    const result = importAll(backup, 'replace')
    expect(result.ok).toBe(true)
    expect(storage.get('juting.web.daily-goal.v1')).toBe('30')
    expect(storage.get('juting.web.theme.v1')).toBe('exam')
    expect(result.imported).toContain('juting.web.theme.v1')
  })

  it('replace 遇到畸形 progress 写不进也不报错，只记 skipped', () => {
    const backup = parseBackup(JSON.stringify(valid({ progress: { progressByExercise: 'nope' } })))
    const result = importAll(backup, 'replace')
    expect(result.ok).toBe(true)
    expect(result.skipped).toContain('progress')
    expect(storage.has('juting.web.progress.v1')).toBe(false)
  })

  it('merge 只动学习数据，不覆盖本机偏好/主题', () => {
    storage.set('juting.web.theme.v1', 'paper')
    storage.set('juting.web.progress.v1', JSON.stringify({ progressByExercise: {} }))
    const backup = parseBackup(
      JSON.stringify(valid({ progress: { progressByExercise: { '9': { lines: { a: { mastered: true } } } } }, theme: 'exam' })),
    )
    const result = importAll(backup, 'merge')
    expect(result.ok).toBe(true)
    expect(storage.get('juting.web.theme.v1')).toBe('paper')
    const progress = JSON.parse(storage.get('juting.web.progress.v1') ?? '{}')
    expect(progress.progressByExercise['9'].lines.a.mastered).toBe(true)
  })
})

// ---------- A3：导出补全 vocabReview / listenTime + 自动快照可恢复 ----------

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

const vocabReviewFixture = {
  apple: { addedAt: 1000, reviewCount: 2, mastered: false, lastReviewedAt: 2000 },
  banana: { addedAt: 1500, reviewCount: 4, mastered: true },
}

const listenTimeFixture = { totalMs: 90_000, byDay: { '2026-10-16': 60_000, '2026-10-17': 30_000 } }

describe('备份分区完整性（A3）', () => {
  let storage: Map<string, string>
  beforeEach(() => {
    storage = installStorage({
      'juting.web.progress.v1': JSON.stringify({
        activeExerciseId: 5,
        progressByExercise: { '5': { lines: { l1: { mastered: true } } } },
      }),
      'juting.web.vocab-review.v1': JSON.stringify(vocabReviewFixture),
      'juting.web.listen-time.v1': JSON.stringify(listenTimeFixture),
    })
  })

  it('导出包含生词复习与所听时长两个分区', () => {
    const backup = exportAll()
    expect(backup.data.vocabReview).toEqual(vocabReviewFixture)
    expect(backup.data.listenTime).toEqual(listenTimeFixture)
  })

  it('清空后导入可完整恢复这两个分区（换机场景）', () => {
    const backup = exportAll()
    storage.clear()
    const result = importAll(backup, 'replace')
    expect(result.ok).toBe(true)
    expect(JSON.parse(storage.get('juting.web.vocab-review.v1') ?? '{}')).toEqual(vocabReviewFixture)
    expect(JSON.parse(storage.get('juting.web.listen-time.v1') ?? '{}')).toEqual(listenTimeFixture)
  })

  it('老格式备份（无这两个分区）导入后本机值保持不变', () => {
    const oldFile = parseBackup(
      JSON.stringify({ format: 'juting-backup', version: 1, data: { theme: 'exam' } }),
    )
    const result = importAll(oldFile, 'replace')
    expect(result.ok).toBe(true)
    expect(JSON.parse(storage.get('juting.web.vocab-review.v1') ?? '{}')).toEqual(vocabReviewFixture)
    expect(JSON.parse(storage.get('juting.web.listen-time.v1') ?? '{}')).toEqual(listenTimeFixture)
  })

  it('合并时生词复习取复习次数更靠后的一方，已掌握不会被回退', () => {
    const merged = mergeVocabReview(
      { apple: { addedAt: 1000, reviewCount: 2, mastered: false } },
      { apple: { addedAt: 500, reviewCount: 3, mastered: true } },
    )
    expect(merged.apple.reviewCount).toBe(3)
    expect(merged.apple.mastered).toBe(true)
    // 首次登记时间取更早的，收藏顺序不乱
    expect(merged.apple.addedAt).toBe(500)
  })

  it('合并听时长按日取 max，不把同一段时间重复累加', () => {
    const merged = mergeListenTime(
      { totalMs: 90_000, byDay: { '2026-10-17': 30_000 } },
      { totalMs: 60_000, byDay: { '2026-10-17': 20_000, '2026-10-18': 40_000 } },
    )
    expect(merged.byDay).toEqual({ '2026-10-17': 30_000, '2026-10-18': 40_000 })
    expect(merged.totalMs).toBe(90_000)
  })
})

describe('自动快照（A3：只写不读 → 可列出/可恢复）', () => {
  let storage: Map<string, string>
  const progressOf = (courseId: string, mastered: boolean) =>
    JSON.stringify({
      activeExerciseId: Number(courseId),
      progressByExercise: {
        [courseId]: { lines: { a: { mastered }, b: { mastered: false } } },
      },
    })

  beforeEach(() => {
    storage = installStorage({
      'juting.web.progress.v1': progressOf('1', false),
      'juting.web.activity.v1': JSON.stringify({ '2026-10-16': 3 }),
    })
  })

  it('快照保留最近 2 份，摘要含课程数/句子数/已掌握数', () => {
    snapshotForAutobackup()
    storage.set('juting.web.progress.v1', progressOf('1', true))
    snapshotForAutobackup()
    storage.set('juting.web.progress.v1', progressOf('2', false))
    snapshotForAutobackup()

    const list = listAutoSnapshots()
    expect(list).toHaveLength(2)
    expect(list[0].courseCount).toBe(1)
    expect(list[0].lineCount).toBe(2)
    expect(list[0].masteredCount).toBe(0)
    expect(list[1].masteredCount).toBe(1)
  })

  it('内容未变化时不重复堆栈', () => {
    snapshotForAutobackup()
    snapshotForAutobackup()
    expect(listAutoSnapshots()).toHaveLength(1)
  })

  it('按时间戳恢复某一份快照，写回进度与学习日历', () => {
    snapshotForAutobackup()
    const older = listAutoSnapshots()[0]
    storage.set('juting.web.progress.v1', progressOf('9', true))
    storage.set('juting.web.activity.v1', JSON.stringify({ '2026-10-17': 99 }))

    expect(restoreAutoSnapshot(older.at)).toBe(true)
    expect(JSON.parse(storage.get('juting.web.progress.v1') ?? '{}').progressByExercise['1']).toBeDefined()
    expect(JSON.parse(storage.get('juting.web.activity.v1') ?? '{}')).toEqual({ '2026-10-16': 3 })
  })

  it('时间戳不存在时返回 false，不动现有数据', () => {
    expect(restoreAutoSnapshot('2000-01-01T00:00:00.000Z')).toBe(false)
    expect(JSON.parse(storage.get('juting.web.progress.v1') ?? '{}').progressByExercise['1']).toBeDefined()
  })
})

describe('备考三功能分区（专项刷题统计 / 考试日期）', () => {
  const drillStatsFixture = {
    A: { correct: 3, wrong: 1 },
    B: { correct: 0, wrong: 2 },
    C: { correct: 12, wrong: 4 },
  }

  let storage: Map<string, string>
  beforeEach(() => {
    storage = installStorage({
      'juting.web.drill-stats.v1': JSON.stringify(drillStatsFixture),
      'juting.web.exam-date.v1': '2026-12-12',
    })
  })

  it('导出包含两个新分区', () => {
    const backup = exportAll()
    expect(backup.data.drillStats).toEqual(drillStatsFixture)
    expect(backup.data.examDate).toBe('2026-12-12')
  })

  it('清空后 replace 导入可恢复', () => {
    const backup = exportAll()
    storage.clear()
    const result = importAll(backup, 'replace')
    expect(result.ok).toBe(true)
    expect(JSON.parse(storage.get('juting.web.drill-stats.v1') ?? '{}')).toEqual(drillStatsFixture)
    expect(storage.get('juting.web.exam-date.v1')).toBe('2026-12-12')
  })

  it('脏考试日期被跳过而不是写坏数据', () => {
    const file = parseBackup(
      JSON.stringify({ format: 'juting-backup', version: 1, data: { examDate: '2026-02-30' } }),
    )
    const result = importAll(file, 'replace')
    expect(result.ok).toBe(true)
    expect(result.skipped).toContain('examDate')
    expect(storage.get('juting.web.exam-date.v1')).toBe('2026-12-12')
  })

  it('合并时逐 Section 取较大值，不把两遍训练相加', () => {
    const file = parseBackup(
      JSON.stringify({
        format: 'juting-backup',
        version: 1,
        data: { drillStats: { A: { correct: 5, wrong: 0 }, C: { correct: 1, wrong: 9 } } },
      }),
    )
    importAll(file, 'merge')
    const merged = JSON.parse(storage.get('juting.web.drill-stats.v1') ?? '{}')
    // 逐项取大：correct 取 5（本机 3），wrong 取 1（备份 0）；不是相加
    expect(merged.A).toEqual({ correct: 5, wrong: 1 })
    expect(merged.C).toEqual({ correct: 12, wrong: 9 })
  })

  it('合并导入保留本机考试日期（属目标类设置，跟每日目标同族）', () => {
    const file = parseBackup(
      JSON.stringify({ format: 'juting-backup', version: 1, data: { examDate: '2027-06-12' } }),
    )
    importAll(file, 'merge')
    expect(storage.get('juting.web.exam-date.v1')).toBe('2026-12-12')
  })

  it('老备份没有这两个分区时不动本机数据', () => {
    const file = parseBackup(
      JSON.stringify({ format: 'juting-backup', version: 1, data: { theme: 'paper' } }),
    )
    importAll(file, 'replace')
    expect(storage.get('juting.web.exam-date.v1')).toBe('2026-12-12')
    expect(JSON.parse(storage.get('juting.web.drill-stats.v1') ?? '{}')).toEqual(drillStatsFixture)
  })
})

describe('专项错题本分区', () => {
  const wrongFixture = {
    '13:9': { exerciseId: 13, n: 9, wrongCount: 2, lastWrongAt: '2026-10-27T10:00:00.000Z' },
    '14:3': { exerciseId: 14, n: 3, wrongCount: 1, lastWrongAt: '2026-10-28T10:00:00.000Z' },
  }

  let storage: Map<string, string>
  beforeEach(() => {
    storage = installStorage({ 'juting.web.drill-wrong.v1': JSON.stringify(wrongFixture) })
  })

  it('导出包含错题本', () => {
    expect(exportAll().data.drillWrong).toEqual(wrongFixture)
  })

  it('replace 导入可恢复错题本', () => {
    const backup = exportAll()
    storage.clear()
    const result = importAll(backup, 'replace')
    expect(result.ok).toBe(true)
    expect(JSON.parse(storage.get('juting.web.drill-wrong.v1') ?? '{}')).toEqual(wrongFixture)
  })

  it('合并取并集：两边各自错过的题都留着，次数取大、时间取近', () => {
    const file = parseBackup(
      JSON.stringify({
        format: 'juting-backup',
        version: 1,
        data: {
          drillWrong: {
            '13:9': { exerciseId: 13, n: 9, wrongCount: 5, lastWrongAt: '2026-10-20T10:00:00.000Z' },
            '20:16': { exerciseId: 20, n: 16, wrongCount: 1, lastWrongAt: '2026-10-29T10:00:00.000Z' },
          },
        },
      }),
    )
    importAll(file, 'merge')
    const merged = JSON.parse(storage.get('juting.web.drill-wrong.v1') ?? '{}')
    expect(Object.keys(merged).sort()).toEqual(['13:9', '14:3', '20:16'])
    expect(merged['13:9'].wrongCount).toBe(5)
    // 时间取更近的一侧（本机 10-27 晚于备份 10-20）
    expect(merged['13:9'].lastWrongAt).toBe('2026-10-27T10:00:00.000Z')
  })

  it('畸形错题本整项跳过，不清空本机', () => {
    const file = parseBackup(
      JSON.stringify({ format: 'juting-backup', version: 1, data: { drillWrong: ['nope'] } }),
    )
    const result = importAll(file, 'replace')
    expect(result.skipped).toContain('drillWrong')
    expect(JSON.parse(storage.get('juting.web.drill-wrong.v1') ?? '{}')).toEqual(wrongFixture)
  })
})
