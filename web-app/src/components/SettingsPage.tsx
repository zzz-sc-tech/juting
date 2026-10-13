import { ArrowLeft, Newspaper, Play, Target } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../i18n/LanguageProvider'
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

        <UpdatePanel />
      </div>
    </div>
  )
}
