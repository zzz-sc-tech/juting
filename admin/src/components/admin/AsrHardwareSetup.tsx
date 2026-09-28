import { Cpu, Download, HardDrive, MonitorSmartphone } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AsrInstallTask, AsrProviderStatus } from '@juting/shared'
import type { AdminNoticeTone } from './AdminFeedback'
import { apiClient } from '../../lib/apiClient'
import { useAdminLanguage } from '../../i18n/AdminLanguageProvider'

/**
 * 「本机识别方案」面板：把硬件探测结果与推荐方案直接摊开给用户看，
 * 并提供一键准备（下载模型 / 下载 whisper 可执行文件）。
 *
 * 设计意图：新用户不必读安装文档，也不必手工试线程数——打开制课台就能看到
 * 「你的机器适合什么」，点一下把资源装好，后端自动写入 .env。
 */
type AsrHardwareSetupProps = {
  adminToken: string
  provider: AsrProviderStatus | null
  onNotify: (message: string, tone?: AdminNoticeTone) => void
  /** 安装完成后回调，让外层重新拉取引擎状态。 */
  onInstalled: () => void
}

const formatGb = (value: number) => (Number.isFinite(value) ? `${value} GB` : '—')

const formatMb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

export function AsrHardwareSetup({
  adminToken,
  provider,
  onNotify,
  onInstalled,
}: AsrHardwareSetupProps) {
  const { t } = useAdminLanguage()
  const [task, setTask] = useState<AsrInstallTask | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const pollRef = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const hardware = provider?.hardware
  const recommendation = provider?.recommendation
  const binaryReady = Boolean(hardware?.install.binaryFound)
  const modelReady = Boolean(hardware?.install.modelFound)

  const startInstall = async (kind: 'model' | 'binary') => {
      setIsStarting(true)
      try {
        const started = await apiClient.startAsrInstall(
          { kind, tier: recommendation?.modelTier },
          adminToken,
        )
        setTask(started)
        stopPolling()
        pollRef.current = window.setInterval(async () => {
          try {
            const latest = await apiClient.getAsrInstallTask(started.id, adminToken)
            setTask(latest)
            if (latest.status === 'done') {
              stopPolling()
              onNotify(t('本地识别资源已装好，配置已自动写入'), 'success')
              onInstalled()
            } else if (latest.status === 'failed') {
              stopPolling()
              onNotify(`${t('准备失败')}：${latest.message}`, 'error')
            }
          } catch {
            stopPolling()
          }
        }, 1500)
      } catch (error) {
        onNotify(error instanceof Error ? error.message : t('准备失败'), 'error')
      } finally {
        setIsStarting(false)
      }
  }


  if (!hardware || !recommendation) {
    return null
  }

  const busy = task?.status === 'downloading' || task?.status === 'extracting'

  return (
    <div className="asr-setup">
      <div className="asr-setup-hardware">
        <p className="asr-setup-title">{t('本机硬件与推荐方案')}</p>
        <ul className="asr-setup-specs">
          <li>
            <Cpu size={14} aria-hidden="true" />
            <span>{hardware.cpuModel || t('未知处理器')}</span>
            <em>{hardware.cpuCores} {t('逻辑核心')}</em>
          </li>
          <li>
            <HardDrive size={14} aria-hidden="true" />
            <span>{t('内存')}</span>
            <em>{formatGb(hardware.totalMemoryGb)}</em>
          </li>
          <li>
            <MonitorSmartphone size={14} aria-hidden="true" />
            <span>{hardware.gpuName || t('未检测到独立显卡')}</span>
            <em>{t(recommendation.gpuAdviceCode)}</em>
          </li>
        </ul>
        <p className="asr-setup-plan">
          {t('推荐方案')}：
          <strong>
            {recommendation.modelFileName} · {recommendation.threads} {t('线程')}
          </strong>
        </p>
        <ul className="asr-setup-reasons">
          {recommendation.reasonCodes.map((code) => (
            <li key={code}>{t(code)}</li>
          ))}
          {!hardware.ffmpegAvailable && (
            <li className="asr-setup-reason-warn">{t('未检测到 ffmpeg：转写前需先安装它')}</li>
          )}
        </ul>
      </div>

      <div className="asr-setup-actions">
        <div className="asr-setup-state">
          <span className={binaryReady ? 'asr-state-dot ok' : 'asr-state-dot'} />
          {t('识别引擎')}：{binaryReady ? t('已就绪') : t('未安装')}
        </div>
        {!binaryReady && (
          <button
            className="command-button"
            disabled={busy || isStarting}
            onClick={() => void startInstall('binary')}
            type="button"
          >
            <Download size={15} aria-hidden="true" />
            {t('下载识别引擎')}
          </button>
        )}

        <div className="asr-setup-state">
          <span className={modelReady ? 'asr-state-dot ok' : 'asr-state-dot'} />
          {t('识别模型')}：{modelReady ? t('已就绪') : t('未安装')}
        </div>
        {!modelReady && (
          <button
            className="command-button ai-action-button"
            disabled={busy || isStarting}
            onClick={() => void startInstall('model')}
            type="button"
          >
            <Download size={15} aria-hidden="true" />
            {t('下载推荐模型')}（{recommendation.estimatedDownloadMb} MB）
          </button>
        )}

        <p className="asr-setup-hint">
          {t('一键准备后自动写入配置，无需手工编辑；模型默认从 hf-mirror 下载，支持断点续传')}
        </p>
      </div>

      {busy && task && (
        <div className="asr-setup-progress" aria-live="polite">
          <div className="asr-setup-progress-bar">
            <span style={{ width: `${task.percent}%` }} />
          </div>
          <p>
            {task.status === 'extracting' ? t('解压中') : t('下载中')} · {task.label}
            {task.totalBytes > 0 && (
              <>
                {' '}
                {formatMb(task.receivedBytes)} / {formatMb(task.totalBytes)}（{task.percent}%）
              </>
            )}
          </p>
        </div>
      )}
    </div>
  )
}
