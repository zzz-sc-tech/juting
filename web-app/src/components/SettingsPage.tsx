import { ArrowLeft, Languages, Target } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ContentLocale, UiLocale } from '@juting/domain'
import { contentLocaleLabels, uiLocaleLabels, useLanguage } from '../i18n/LanguageProvider'
import { DEFAULT_DAILY_GOAL, loadDailyGoal, persistDailyGoal } from '../lib/progressStore'
import { SettingsSelect } from './SettingsSelect'
import { TopBar } from './TopBar'

/**
 * 设置页：挂在 TopBar 下面，与主学习页共用同一个应用外壳。
 * 本地免登录模式：只保留语言、每日目标等本机偏好；均持久化在 localStorage。
 */
export function SettingsPage() {
  const navigate = useNavigate()
  const { contentLocale, setContentLocale, setUiLocale, t, uiLocale } = useLanguage()
  const [dailyGoal, setDailyGoal] = useState(loadDailyGoal)

  const handleDailyGoalChange = (value: number) => {
    setDailyGoal(value)
    persistDailyGoal(value)
  }

  const handleUiLocaleChange = (locale: UiLocale) => {
    setUiLocale(locale)
  }

  const handleContentLocaleChange = (locale: ContentLocale) => {
    setContentLocale(locale)
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
            <Languages size={15} />
            {t('settings.language')}
          </h2>
          <label className="settings-field">
            <span className="settings-field-label">{t('interfaceLanguage')}</span>
            <SettingsSelect
              ariaLabel={t('interfaceLanguage')}
              onChange={(value) => handleUiLocaleChange(value as UiLocale)}
              options={Object.entries(uiLocaleLabels).map(([locale, label]) => ({ value: locale, label }))}
              value={uiLocale}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{t('contentLanguage')}</span>
            <SettingsSelect
              ariaLabel={t('contentLanguage')}
              onChange={(value) => handleContentLocaleChange(value as ContentLocale)}
              options={Object.entries(contentLocaleLabels).map(([locale, label]) => ({ value: locale, label }))}
              value={contentLocale}
            />
          </label>
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
      </div>
    </div>
  )
}
