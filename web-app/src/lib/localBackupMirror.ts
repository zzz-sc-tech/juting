// 学习存档自动镜像：把 localStorage 里的完整学习数据定期 POST 给后端落盘。
//
// 背景（2026-10-28）：单机版学习进度只存在浏览器 localStorage，浏览器配置一丢
// 就全没。后端提供 /api/v1/system/local-backup（temp/runtime/local-backups/
// 一天一份滚动保留 30 天），文件格式与「设置 → 数据备份」手动导出完全一致，
// 恢复走同一导入通道。
//
// 触发时机：启动后 8s 首次（避开首屏关键请求）；此后每 10 分钟；pagehide 时
// 用 keepalive 兜底补一次（页面关闭前最后的变化）。
import { exportAll } from './dataBackup'

const ENDPOINT = '/api/v1/system/local-backup'
const FIRST_DELAY_MS = 8_000
const INTERVAL_MS = 10 * 60_000

let started = false
let inFlight = false

const mirror = (keepalive = false): void => {
  if (inFlight) {
    return
  }
  inFlight = true
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(exportAll()),
    keepalive,
  })
    .catch(() => {
      // 后端未起/网络抖动：静默，下个周期再试（镜像是安全网，不打扰用户）
    })
    .finally(() => {
      inFlight = false
    })
}

/** 应用根组件挂载时调用一次（重复调用幂等）。 */
export const startLocalBackupMirror = (): void => {
  if (started) {
    return
  }
  started = true
  window.setTimeout(() => {
    mirror()
    window.setInterval(() => mirror(), INTERVAL_MS)
  }, FIRST_DELAY_MS)
  window.addEventListener('pagehide', () => mirror(true))
}
