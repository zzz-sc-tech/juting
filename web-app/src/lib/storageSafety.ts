/**
 * 本地存储健康监测（配额溢出 / 数据损坏）。
 *
 * 背景：全站 6 个模块原先都用 `catch {}` 静默吞掉写入异常，而 localStorage
 * 配额只有 5MB——配额满时最该保住的进度写入恰恰最先失败，且用户毫无感知。
 * 损坏路径同理：解析失败后 800ms 就会把空仓库写回，原始数据永久消失。
 *
 * 这里统一收口两件事：
 * 1. `safeSetItem` —— 写入失败必须置标志并通知 UI；配额满时先回收旧快照再重试。
 * 2. `quarantineCorrupt` —— 损坏的原始字符串先另存到隔离键，再交给调用方降级。
 *
 * 模块级单例（无 React 依赖），UI 侧用 `useSyncExternalStore` 订阅。
 */

export type StorageIssue =
  | { kind: 'quota'; key: string; at: number }
  | { kind: 'write-failed'; key: string; at: number }
  | {
      kind: 'corrupt'
      /** 出问题的原始存储键 */
      key: string
      /** 隔离副本的键（写隔离键也失败时为 null） */
      backupKey: string | null
      /** 体检时被丢弃的条目数（整块解析失败为 0） */
      dropped: number
      /** true = 整块无法解析，调用方应暂停写盘，等用户明确处理 */
      blocking: boolean
      at: number
    }

let currentIssue: StorageIssue | null = null
const listeners = new Set<() => void>()

/** 空间回收器：配额满时依次尝试，返回 true 表示释放了空间。 */
const reclaimers: Array<() => boolean> = []

const publish = (next: StorageIssue | null) => {
  currentIssue = next
  for (const listener of listeners) {
    listener()
  }
}

export const subscribeStorageIssue = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前问题快照（useSyncExternalStore 要求同一状态返回同一引用）。 */
export const getStorageIssue = (): StorageIssue | null => currentIssue

/** 用户明确处理后清除提示（不会删除隔离副本）。 */
export const clearStorageIssue = (): void => {
  if (currentIssue !== null) {
    publish(null)
  }
}

/** 注册空间回收器（如「把自动快照裁到 1 份」），由 dataBackup 在模块加载时注册。 */
export const registerSpaceReclaimer = (reclaimer: () => boolean): void => {
  reclaimers.push(reclaimer)
}

/**
 * 判断是否配额类错误。各浏览器命名不一：
 * Chrome/Edge `QuotaExceededError`(22)、Firefox `NS_ERROR_DOM_QUOTA_REACHED`(1014)、
 * Safari 旧版 `QUOTA_EXCEEDED_ERR`(22)。
 */
export const isQuotaExceeded = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const { name, code } = error as { name?: unknown; code?: unknown }
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    name === 'QUOTA_EXCEEDED_ERR' ||
    code === 22 ||
    code === 1014
  )
}

/**
 * 安全写入：失败时置标志并通知 UI，绝不静默；配额满时先回收再重试一次。
 * 返回是否真正写入成功。
 */
export const safeSetItem = (key: string, value: string): boolean => {
  try {
    localStorage.setItem(key, value)
    return true
  } catch (error) {
    if (isQuotaExceeded(error)) {
      let reclaimed = false
      for (const reclaim of reclaimers) {
        try {
          if (reclaim()) {
            reclaimed = true
            break
          }
        } catch {
          // 回收器自身异常不能影响主写入流程
        }
      }
      if (reclaimed) {
        try {
          localStorage.setItem(key, value)
          return true
        } catch {
          // 落到底下统一上报
        }
      }
      publish({ kind: 'quota', key, at: Date.now() })
      return false
    }
    // 隐私模式 / 存储被策略禁用：不是空间问题，文案要区分开
    publish({ kind: 'write-failed', key, at: Date.now() })
    return false
  }
}

/**
 * 把损坏的原始内容另存到隔离键（`<prefix>.corrupt.<时间戳>`），并置损坏标志。
 * 写隔离键也可能因配额失败——此时 backupKey 为 null，但仍要上报，
 * 让上层至少停止覆盖原始数据。
 */
export const quarantineCorrupt = (
  prefix: string,
  raw: string,
  options: { dropped?: number; blocking?: boolean } = {},
): string | null => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupKey = `${prefix}.corrupt.${stamp}`
  let saved: string | null = null
  try {
    localStorage.setItem(backupKey, raw)
    saved = backupKey
  } catch {
    // 写隔离键也失败（多半是同一份额配问题）：仍然要上报，
    // 至少让调用方停止覆盖原始数据，别把唯一证据一起毁掉。
  }
  publish({
    kind: 'corrupt',
    key: prefix,
    backupKey: saved,
    dropped: options.dropped ?? 0,
    blocking: options.blocking ?? false,
    at: Date.now(),
  })
  return saved
}

/** 列出本地所有隔离副本键（设置页导出用）。 */
export const listQuarantineKeys = (): string[] => {
  const keys: string[] = []
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && /\.corrupt\./.test(key)) {
        keys.push(key)
      }
    }
  } catch {
    return []
  }
  return keys.sort()
}

/** 读出全部隔离副本内容（键 → 原始字符串），供设置页一键导出。 */
export const readQuarantineCopies = (): Record<string, string> => {
  const copies: Record<string, string> = {}
  for (const key of listQuarantineKeys()) {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) copies[key] = raw
    } catch {
      // 单个键读失败不影响其他副本
    }
  }
  return copies
}
