import { ArrowLeft, Database, Download, Newspaper, Play, Target, Upload } from 'lucide-react'
import { useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../i18n/LanguageProvider'
import {
  downloadBackup,
  getLastExportAt,
  importAll,
  parseBackup,
  type BackupFile,
} from '../lib/dataBackup'
import { DEFAULT_DAILY_GOAL, loadDailyGoal, persistDailyGoal } from '../lib/progressStore'
import {
  applyTheme,
  getStoredTheme,
  persistTheme,
  type UiTheme,
} from '../lib/theme'
import {
  loadUserPrefs,
  persistUserPrefs,
  RATE_OPTIONS,
  type UserPrefs,
} from '../lib/userPrefs'
import { SettingsSelect } from './SettingsSelect'
import { TopBar } from './TopBar'
import { UpdatePanel } from './UpdatePanel'

/**
 * 设置页：挂在 TopBar 下面，与主学习页共用同一个应用外壳。
 * 本地免登录模式：只保留主题、播放/字幕默认值、每日目标等本机偏好；
 * 均持久化在 localStorage。界面与内容语言固定中文（无切换项）。
 */
export function SettingsPage() {
  const navigate = useNavigate()
  const { t } = useLanguage()
  const [dailyGoal, setDailyGoal] = useState(loadDailyGoal)
  const [theme, setTheme] = useState<UiTheme>(getStoredTheme)
  const [prefs, setPrefs] = useState<UserPrefs>(loadUserPrefs)
  // 数据备份区：选完文件先挂起，由用户选覆盖/合并后才真正写入
  const [pendingBackup, setPendingBackup] = useState<BackupFile | null>(null)
  const [backupMessage, setBackupMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [lastExportAt, setLastExportAt] = useState(getLastExportAt)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDailyGoalChange = (value: number) => {
    setDailyGoal(value)
    persistDailyGoal(value)
  }

  const handleThemeChange = (value: UiTheme) => {
    setTheme(value)
    applyTheme(value)
    persistTheme(value)
  }

  const handlePrefsChange = (patch: Partial<UserPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch }
      persistUserPrefs(next)
      return next
    })
  }

  const showHideOptions = () => [
    { value: 'show', label: t('settings.show') },
    { value: 'hide', label: t('settings.hide') },
  ]

  const formatExportTime = (iso: string) => {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const handleExport = () => {
    downloadBackup()
    setLastExportAt(getLastExportAt())
    setBackupMessage({ kind: 'ok', text: t('settings.data.exportDone') })
  }

  const handlePickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = '' // 允许连续选同一个文件
    if (!file) return
    setBackupMessage(null)
    file.text()
      .then((text) => {
        const backup = parseBackup(text)
        setPendingBackup(backup)
        setBackupMessage({
          kind: 'ok',
          text: t('settings.data.parsed', { date: backup.exportedAt ? formatExportTime(backup.exportedAt) : '—' }),
        })
      })
      .catch((error: unknown) => {
        setPendingBackup(null)
        setBackupMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : t('settings.data.importFailed'),
        })
      })
  }

  const runImport = (mode: 'replace' | 'merge') => {
    if (!pendingBackup) return
    const result = importAll(pendingBackup, mode)
    if (!result.ok) {
      setBackupMessage({ kind: 'error', text: result.error ?? t('settings.data.importFailed') })
      return
    }
    const skippedNote = result.skipped.length > 0
      ? ` ${t('settings.data.skippedNote', { parts: result.skipped.join('、') })}`
      : ''
    setBackupMessage({ kind: 'ok', text: `${t('settings.data.importDone')}${skippedNote}` })
    setPendingBackup(null)
    // React state 还是旧数据，直接刷新最可靠
    window.setTimeout(() => window.location.reload(), 900)
  }

  return (
    <div className="settings-page">
      <TopBar />

      <div className="settings-container">
        <header className="settings-header">
          <button
            aria-label={t('settings.back')}
            className="settings-back"
            onClick={() => navigate(-1)}
            type="button"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="settings-title">{t('settings.title')}</h1>
        </header>

        <section className="settings-card">
          <h2 className="settings-card-title">
            <Newspaper size={15} />
            {t('settings.theme')}
          </h2>
          <label className="settings-field">
            <span className="settings-field-label">{t('settings.theme')}</span>
            <SettingsSelect
              ariaLabel={t('settings.theme')}
              onChange={(value) => handleThemeChange(value as UiTheme)}
              options={[
                { value: 'paper', label: t('settings.themePaper') },
                { value: 'gazette', label: t('settings.themeGazette') },
                { value: 'minimal', label: t('settings.themeMinimal') },
                { value: 'exam', label: t('settings.themeExam') },
              ]}
              value={theme}
            />
          </label>
        </section>

        <section className="settings-card">
          <h2 className="settings-card-title">
            <Play size={15} />
            {t('settings.playbackSection')}
          </h2>
          <label className="settings-field">
            <span className="settings-field-label">{t('settings.defaultRate')}</span>
            <SettingsSelect
              ariaLabel={t('settings.defaultRate')}
              onChange={(value) => handlePrefsChange({ defaultPlaybackRate: Number(value) })}
              options={RATE_OPTIONS.map((rate) => ({ value: String(rate), label: `${rate}x` }))}
              value={String(prefs.defaultPlaybackRate)}
            />
          </label>
          <p className="settings-field-hint">{t('settings.defaultRateDescription')}</p>
          <label className="settings-field">
            <span className="settings-field-label">{t('settings.lyricsDefault')}</span>
            <SettingsSelect
              ariaLabel={t('settings.lyricsDefault')}
              onChange={(value) => handlePrefsChange({ lyricsDefault: value === 'show' })}
              options={showHideOptions()}
              value={prefs.lyricsDefault ? 'show' : 'hide'}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{t('settings.translationDefault')}</span>
            <SettingsSelect
              ariaLabel={t('settings.translationDefault')}
              onChange={(value) => handlePrefsChange({ translationDefault: value === 'show' })}
              options={showHideOptions()}
              value={prefs.translationDefault ? 'show' : 'hide'}
            />
          </label>
          <p className="settings-field-hint">{t('settings.translationDefaultDescription')}</p>
        </section>

        <section className="settings-card">
          <h2 className="settings-card-title">
            <Target size={15} />
            {t('settings.dailyGoal')}
          </h2>
          <label className="settings-field">
            <span className="settings-field-label">{t('settings.dailyGoalDescription')}</span>
            <input
              className="settings-goal-input"
              max={500}
              min={1}
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10)
                handleDailyGoalChange(Number.isInteger(value) && value >= 1 ? value : DEFAULT_DAILY_GOAL)
              }}
              type="number"
              value={dailyGoal}
            />
          </label>
        </section>

        <section className="settings-card">
          <h2 className="settings-card-title">
            <Database size={15} />
            {t('settings.data.title')}
          </h2>
          <p className="settings-field-hint">{t('settings.data.hint')}</p>
          <div className="settings-data-actions">
            <button className="settings-data-button" onClick={handleExport} type="button">
              <Download size={14} aria-hidden="true" />
              {t('settings.data.export')}
            </button>
            <button className="settings-data-button" onClick={() => fileInputRef.current?.click()} type="button">
              <Upload size={14} aria-hidden="true" />
              {t('settings.data.import')}
            </button>
            <input
              accept=".json,application/json"
              hidden
              onChange={handlePickFile}
              ref={fileInputRef}
              type="file"
            />
          </div>
          {lastExportAt && (
            <p className="settings-field-hint">
              {t('settings.data.lastExport', { time: formatExportTime(lastExportAt) })}
            </p>
          )}
          {pendingBackup && (
            <div className="settings-data-import-choose">
              <span>{t('settings.data.chooseMode')}</span>
              <div className="settings-data-actions">
                <button className="settings-data-button primary" onClick={() => runImport('replace')} type="button">
                  {t('settings.data.replace')}
                </button>
                <button className="settings-data-button" onClick={() => runImport('merge')} type="button">
                  {t('settings.data.merge')}
                </button>
              </div>
            </div>
          )}
          {backupMessage && (
            <p className={backupMessage.kind === 'ok' ? 'settings-data-ok' : 'settings-data-error'}>
              {backupMessage.text}
            </p>
          )}
        </section>

        <UpdatePanel />
      </div>
    </div>
  )
}
