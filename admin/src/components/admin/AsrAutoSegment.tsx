import { Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AsrProviderStatus,
  MediaAsrJob,
} from '@juting/shared'
import type { AdminNoticeTone } from './AdminFeedback'
import { AsrHardwareSetup } from './AsrHardwareSetup'
import { apiClient } from '../../lib/apiClient'
import { useAdminLanguage } from '../../i18n/AdminLanguageProvider'

/**
 * 制课工作台的「自动切分」面板：把课程已绑定的媒体交给后端本机的
 * whisper.cpp 做离线识别，生成带时间戳的 SRT。识别结果可以直接导入为
 * 逐句字幕草稿，也可以先填入下方字幕文本框人工微调后再导入。
 * 缓存由后端保证：同一音频同一参数只识别一次。
 */
type AsrAutoSegmentProps = {
  adminToken: string
  /** 课程 id；新课程先上传媒体（自动创建草稿课程）后才有。 */
  exerciseId?: number
  disabled?: boolean
  onNotify: (message: string, tone?: AdminNoticeTone) => void
  /** 把 SRT 填入字幕导入文本框，供检查/微调后手动导入。 */
  onFillDraft: (srtText: string) => void
  /** 跳过草稿框，直接把 SRT 导入为逐句字幕草稿。 */
  onImportSrt: (srtText: string) => void
}

const languageOptions = [
  { value: 'auto', labelKey: '自动检测' },
  { value: 'en', labelKey: '英语' },
  { value: 'zh', labelKey: '中文' },
] as const

const isActiveStatus = (job: MediaAsrJob | null) =>
  job !== null && (job.status === 'pending' || job.status === 'running')

export function AsrAutoSegment({
  adminToken,
  exerciseId,
  disabled = false,
  onNotify,
  onFillDraft,
  onImportSrt,
}: AsrAutoSegmentProps) {
  const { t } = useAdminLanguage()
  const [provider, setProvider] = useState<AsrProviderStatus | null>(null)
  const [language, setLanguage] = useState<string>('auto')
  const [job, setJob] = useState<MediaAsrJob | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [startError, setStartError] = useState('')
  // 轮询句柄放 ref，组件卸载或任务结束都能可靠停止。
  const pollTimerRef = useRef<number | null>(null)

  // 拉取引擎状态；一键准备完成后也会再次调用，界面随即反映新装好的资源。
  const refreshProvider = useCallback(async () => {
    try {
      const status = await apiClient.getAsrStatus(adminToken)
      setProvider(status)
    } catch {
      setProvider(null)
    }
  }, [adminToken])

  useEffect(() => {
    void refreshProvider()
  }, [refreshProvider])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    stopPolling()
    if (!job || !isActiveStatus(job)) {
      return
    }

    pollTimerRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const latest = await apiClient.getAsrJob(job.id, adminToken)
          setJob(latest)
          if (latest.status === 'succeeded') {
            onNotify(
              t('识别完成，共 {{count}} 句', { count: latest.segmentCount ?? 0 }),
              'success',
            )
          } else if (latest.status === 'failed') {
            onNotify(
              `${t('识别失败')}：${latest.errorMessage ?? t('未知错误')}`,
              'error',
            )
          }
        } catch {
          // 单次轮询失败（网络抖动等）不终止任务，下一次轮询会继续。
        }
      })()
    }, 2000)

    return stopPolling
  }, [adminToken, job, onNotify, stopPolling, t])

  useEffect(() => stopPolling, [stopPolling])

  const handleStart = async () => {
    if (!exerciseId) {
      onNotify(t('请先上传媒体并保存课程后再自动切分'), 'error')
      return
    }

    setIsStarting(true)
    setStartError('')
    try {
      const result = await apiClient.startAsrJob(exerciseId, { language }, adminToken)
      setJob(result.job)
      if (result.cacheHit) {
        onNotify(t('命中缓存：该音频已识别过，直接复用结果'), 'success')
      } else {
        onNotify(t('已开始本地识别，音频不会离开部署机器'), 'info')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('自动切分启动失败')
      setStartError(message)
      onNotify(message, 'error')
    } finally {
      setIsStarting(false)
    }
  }

  const active = isActiveStatus(job)
  const succeeded = job?.status === 'succeeded'
  const canStart = Boolean(provider?.configured) && Boolean(exerciseId) && !active && !disabled && !isStarting

  return (
    <details className="subtitle-import asr-panel" open>
      <summary>
        <span className="subtitle-import-title">{t('自动切分（语音识别）')}</span>
        <span className="subtitle-import-formats">{provider?.model ? provider.model : 'whisper.cpp'}</span>
      </summary>

      <div className="subtitle-import-body">
        <div className="subtitle-import-intro">
          <strong>{t('本地离线识别引擎')}</strong>
          <span>{t('音频只在部署本机识别，不会上传第三方服务')}</span>
        </div>

        <AsrHardwareSetup
          adminToken={adminToken}
          onInstalled={() => void refreshProvider()}
          onNotify={onNotify}
          provider={provider}
        />

        {!provider?.configured && (
          <p className="asr-panel-warning">
            {t('尚未就绪：请先在上方下载识别引擎与模型，装好后即可直接开始自动切分')}
          </p>
        )}

        <div className="asr-panel-controls">
          <label className="field">
            <span>{t('识别语言')}</span>
            <select
              className="asr-language-select"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              disabled={active || isStarting}
            >
              {languageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="command-button ai-action-button asr-start-button"
            disabled={!canStart}
            onClick={() => void handleStart()}
            title={provider?.configured
              ? t('对当前课程媒体执行本地语音识别，生成逐句时间轴')
              : t('未启用：需要在后端部署 whisper.cpp 并配置 ASR 环境变量')}
            type="button"
          >
            <Sparkles size={15} aria-hidden="true" />
            {active || isStarting ? t('识别中') : t('开始自动切分')}
          </button>
        </div>

        {active && (
          <p className="asr-panel-status" aria-live="polite">
            {job?.status === 'running' ? t('识别中') : t('排队中')}
            {typeof job?.progress === 'number' && job.progress > 0
              ? ` · ${job.progress}%`
              : ''}
          </p>
        )}

        {succeeded && job && (
          <div className="asr-panel-result">
            <p className="asr-panel-status">
              {job.segmentCount} {t('句已识别')}
              {typeof job.durationMs === 'number' && job.durationMs > 0
                ? ` · ${Math.round(job.durationMs / 1000)}s`
                : ''}
            </p>
            <div className="asr-panel-actions">
              <button
                className="command-button"
                onClick={() => onImportSrt(job.srtText ?? '')}
                type="button"
              >
                {t('导入为逐句字幕')}
              </button>
              <button
                className="mini-command secondary"
                onClick={() => {
                  onFillDraft(job.srtText ?? '')
                  onNotify(t('结果已填入字幕草稿框，可检查后点击「导入为逐句字幕」'), 'info')
                }}
                type="button"
              >
                {t('填入字幕草稿框')}
              </button>
            </div>
          </div>
        )}

        {job?.status === 'failed' && startError === '' && (
          <p className="asr-panel-warning" role="alert">
            {t('识别失败')}：{job.errorMessage ?? t('未知错误')}
          </p>
        )}
        {startError !== '' && (
          <p className="asr-panel-warning" role="alert">
            {startError}
          </p>
        )}
      </div>
    </details>
  )
}
