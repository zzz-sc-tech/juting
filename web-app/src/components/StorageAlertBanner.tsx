import { CircleAlert, Database, ShieldAlert } from 'lucide-react'
import { useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../i18n/LanguageProvider'
import { getStorageIssue, subscribeStorageIssue } from '../lib/storageSafety'

/**
 * 存储故障常驻横幅。
 *
 * 「写不进去」这类故障原先被 6 个模块的 `catch {}` 全部吞掉，用户唯一能
 * 察觉的方式是「昨天学的今天没了」。这里把它变成页面顶部一条无法忽略的
 * 提示，并给一个直达数据导出的入口。
 *
 * 不自动消失：故障解除前它得一直在（设置页处理完后刷新即消失）。
 */
export function StorageAlertBanner() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const issue = useSyncExternalStore(subscribeStorageIssue, getStorageIssue, getStorageIssue)

  if (!issue) return null

  if (issue.kind === 'quota') {
    return (
      <Banner
        tone="danger"
        icon={<CircleAlert aria-hidden="true" size={16} />}
        text={t('storage.quota')}
        actionLabel={t('storage.quotaAction')}
        onAction={() => navigate('/settings')}
      />
    )
  }

  if (issue.kind === 'write-failed') {
    return (
      <Banner
        tone="danger"
        icon={<ShieldAlert aria-hidden="true" size={16} />}
        text={t('storage.unavailable')}
        actionLabel={t('storage.quotaAction')}
        onAction={() => navigate('/settings')}
      />
    )
  }

  return (
    <Banner
      tone={issue.blocking ? 'danger' : 'warning'}
      icon={<Database aria-hidden="true" size={16} />}
      text={
        issue.dropped > 0
          ? t('storage.corruptPartial', { count: issue.dropped })
          : t('storage.corrupt')
      }
      actionLabel={t('storage.corruptAction')}
      onAction={() => navigate('/settings')}
    />
  )
}

function Banner({
  tone,
  icon,
  text,
  actionLabel,
  onAction,
}: {
  tone: 'warning' | 'danger'
  icon: ReactNode
  text: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className={`storage-alert storage-alert-${tone}`} role="alert">
      <span className="storage-alert-icon">{icon}</span>
      <span className="storage-alert-text">{text}</span>
      <button className="storage-alert-action" onClick={onAction} type="button">
        {actionLabel}
      </button>
    </div>
  )
}
