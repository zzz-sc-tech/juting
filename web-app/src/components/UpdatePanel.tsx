import { Download, Info, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLanguage } from '../i18n/LanguageProvider'
import { resolveApiUrl } from '../lib/apiClient'

/**
 * 设置页「关于句听」区块：在页面内完成检查更新与一键覆盖安装。
 *
 * 页面本身不能操作本机文件，真正的下载/解压/覆盖安装由 句听.exe（托盘启动器）执行：
 * 后端把动作写进 temp/runtime/launcher-cmd.json，启动器消费后把版本与进度写回
 * launcher-status.json，本组件按秒轮询 /api/v1/system/update 呈现。
 * 更新过程中服务会被停掉（请求失败属预期），服务恢复后本页自动刷新。
 */

type UpdateInfo = {
  available?: boolean
  version?: string
  current?: string
  sizeMb?: number
  releaseUrl?: string
  phase?: string
  progress?: number
  message?: string
  error?: string | null
  checkedAt?: number
}

type UpdateState = {
  version: string
  launcherRunning: boolean
  serviceState: string | null
  update: UpdateInfo | null
  releaseUrl: string
}

const STATUS_URL = '/api/v1/system/update'
const CHECK_URL = '/api/v1/system/update/check'
const APPLY_URL = '/api/v1/system/update/apply'
const POLL_MS = 1000
// 轮询请求必须自带超时：更新期间服务会短暂不可用，若 fetch 一直挂着，
// 浏览器同源连接池（上限约 6 条）会被占满，之后所有请求都排队等死，页面再也无法恢复。
const fetchWithTimeout = (url: string, init?: RequestInit, timeoutMs = 4000) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })

export function UpdatePanel() {
  const { t } = useLanguage()
  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 点「立即更新」那一刻的本地版本号；空串表示本页没发起过更新（如更新中途刷新过页面）
  const appliedVersion = useRef('')

  // 读取启动器上报的版本与更新状态；服务不可达时返回 null（更新重启期属正常）
  const load = useCallback(async (): Promise<UpdateState | null> => {
    try {
      const response = await fetchWithTimeout(resolveApiUrl(STATUS_URL), { cache: 'no-store' })
      if (!response.ok) return null
      const data = (await response.json()) as UpdateState
      if (alive.current) setState(data)
      return data
    } catch {
      return null
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  // poll 的自引用中转：轮询定时器回调里要调用 poll 自身，直接写 poll(intervalMs)
  // 会被 react-hooks 判定为「声明前访问」（自递归闭包）。放 ref 里打破声明顺序依赖。
  const pollRef = useRef<((intervalMs?: number) => void) | null>(null)

  const poll = useCallback((intervalMs = POLL_MS) => {
    stopPolling()
    timer.current = setTimeout(async () => {
      await load()
      if (alive.current) pollRef.current?.(intervalMs)
    }, intervalMs)
  }, [load, stopPolling])

  useEffect(() => {
    pollRef.current = poll
  }, [poll])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
      stopPolling()
    }
  }, [load, stopPolling])

  const update = state?.update ?? null
  const phase = update?.phase ?? ''
  // 启动器上报的活跃阶段（检查/下载/解压/安装）。更新中途页面被刷新后
  // applying 会复位，此时只能靠 phase 驱动轮询与恢复监测，页面才不会变成死页。
  const phaseActive = ['checking', 'downloading', 'extracting', 'applying'].includes(phase)

  // 检查中 / 更新中都按秒轮询进度；state 还没成功加载过时也轮询
  // （服务重启期间打开本页可自愈），加载成功且无动作时停表。
  useEffect(() => {
    if (!checking && !applying && !phaseActive && state !== null) return
    poll()
    return stopPolling
  }, [checking, applying, phaseActive, state, poll, stopPolling])

  // 服务恢复（安装完成、句听重启完）后自动刷新本页。
  // 关键 1：必须先观察到停服（请求失败）才允许判定「恢复」——下载/解压阶段服务
  //   全程在线，只看「load 成功 + 页面可达」会在下载中途就误刷新：重载后
  //   applying 复位、轮询与恢复监测全部停止，页面从此永远停在旧版本。
  // 关键 2：本地版本号相对点更新时发生变化，也可判定重启完成（双保险）。
  // 关键 3：刷新前确认前端也就绪，避免刷进错误页后无法自愈。
  useEffect(() => {
    if (!applying && !phaseActive) return
    let sawOutage = false
    const watch = setInterval(async () => {
      const latest = await load()
      if (!latest) {
        sawOutage = true // 停服窗口内请求失败属预期
        return
      }
      const versionChanged = appliedVersion.current !== '' && latest.version !== appliedVersion.current
      if (!sawOutage && !versionChanged) return
      const webReady = await fetchWithTimeout('/', { cache: 'no-store' }, 4000)
        .then((response) => response.ok)
        .catch(() => false)
      if (!webReady) return
      clearInterval(watch)
      setApplying(false)
      setRecovered(true)
      setTimeout(() => window.location.reload(), 1500)
    }, 3000)
    return () => clearInterval(watch)
  }, [applying, phaseActive, load])

  // 更新失败（启动器上报 error）时解除「更新中」状态，否则检查按钮被永久禁用
  useEffect(() => {
    if (phase === 'error' && applying) setApplying(false)
  }, [phase, applying])

  const handleCheck = async () => {
    setChecking(true)
    setNotice(null)
    try {
      const response = await fetchWithTimeout(resolveApiUrl(CHECK_URL), { method: 'POST' }, 8000)
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        setNotice(payload?.message ?? t('settings.updateFailed'))
        setChecking(false)
        return
      }
      // 后端只是把命令交给启动器，等它把结果写回来
      const deadline = Date.now() + 20000
      const before = state?.update?.checkedAt ?? 0
      while (alive.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        const latest = await load()
        const phase = latest?.update?.phase
        if (!latest) break
        if ((latest.update?.checkedAt ?? 0) > before && ['available', 'uptodate', 'error'].includes(phase ?? '')) break
      }
      if (alive.current) setChecking(false)
    } catch {
      if (alive.current) {
        setChecking(false)
        setNotice(t('settings.updateFailed'))
      }
    }
  }

  const handleApply = async () => {
    setApplying(true)
    setNotice(null)
    // 记住当前版本号：重启完成后版本号变化是「更新已装好」的判定依据之一
    appliedVersion.current = state?.version ?? ''
    try {
      const response = await fetchWithTimeout(resolveApiUrl(APPLY_URL), { method: 'POST' }, 8000)
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        setNotice(payload?.message ?? t('settings.updateFailed'))
        setApplying(false)
      }
      // 成功即进入「更新中」：界面靠轮询 + 服务恢复后自动刷新推进
    } catch {
      if (alive.current) {
        setNotice(t('settings.updateFailed'))
        setApplying(false)
      }
    }
  }

  const progress = Math.max(0, Math.min(100, Number(update?.progress ?? 0)))
  const updating = applying || ['downloading', 'extracting', 'applying'].includes(phase)
  const showRestartHint = applying && ['applying'].includes(phase)
  const canCheck = state?.launcherRunning !== false && !updating

  return (
    <section className="settings-card">
      <h2 className="settings-card-title">
        <Info size={15} />
        {t('settings.about')}
      </h2>

      <div className="settings-update-row">
        <span className="settings-field-label">
          {t('settings.version')} v{state?.version ?? '—'}
        </span>
        <button
          className="settings-update-button"
          disabled={!canCheck || checking}
          onClick={() => void handleCheck()}
          type="button"
        >
          <RefreshCw size={14} />
          {checking ? t('settings.checking') : t('settings.checkUpdate')}
        </button>
      </div>

      {state?.launcherRunning === false && (
        <p className="settings-field-hint">{t('settings.updateLauncherMissing')}</p>
      )}
      {state?.launcherRunning === false && (
        <a
          className="settings-update-link"
          href={state.releaseUrl}
          rel="noreferrer"
          target="_blank"
        >
          {t('settings.updateReleaseLink')}
        </a>
      )}

      {!updating && !checking && update?.available && (
        <div className="settings-update-notice">
          <span>
            {t('settings.newVersion')} v{update.version}
            {update.sizeMb ? `（${t('settings.updateSize')} ${update.sizeMb} MB）` : ''}
          </span>
          <button className="settings-update-button primary" onClick={() => void handleApply()} type="button">
            <Download size={14} />
            {t('settings.updateNow')}
          </button>
        </div>
      )}
      {!updating && !checking && update && !update.available && update.phase === 'uptodate' && (
        <p className="settings-field-hint">{t('settings.upToDate')}</p>
      )}

      {updating && (
        <div className="settings-update-progress">
          <div className="settings-update-progress-label">
            {update?.message || t('settings.checking')}
          </div>
          <div
            aria-hidden="true"
            className="settings-update-track"
            role="progressbar"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress}
          >
            <div className="settings-update-fill" style={{ width: `${progress}%` }} />
          </div>
          <p className="settings-field-hint">
            {recovered
              ? t('settings.updateDone')
              : showRestartHint
                ? t('settings.updateRestarting')
                : t('settings.updateReady')}
          </p>
        </div>
      )}

      {notice && <p className="settings-update-error">{notice}</p>}

      {!updating && update?.phase === 'error' && (
        <p className="settings-update-error">{update.message || update.error || t('settings.updateFailed')}</p>
      )}

      {!updating && !notice && !update?.available && (
        <p className="settings-field-hint">{t('settings.updateIdleHint')}</p>
      )}
    </section>
  )
}
