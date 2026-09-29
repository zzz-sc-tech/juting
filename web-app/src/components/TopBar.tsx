import { Settings, Shield } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../i18n/LanguageProvider'

type TopBarProps = {
  /** 当前所在导航：首页（仪表盘）或学习页；设置页不高亮任何一项。 */
  active?: 'home' | 'study'
}

// 本地免登录模式：顶栏 = 品牌入口 + 首页/学习切换 + 设置；语言切换在设置页。
export function TopBar({ active }: TopBarProps) {
  const { t } = useLanguage()
  const navigate = useNavigate()

  return (
    <header className="topbar">
      <button
        aria-label={t('brand')}
        className="brand-lockup"
        onClick={() => navigate('/home')}
        type="button"
      >
        <div>
          <h1>{t('brand')}</h1>
          <p>{t('courseLabel')}</p>
        </div>
      </button>
      <nav className="topbar-nav" aria-label={t('topbar.learningOverview')}>
        <button
          className={active === 'home' ? 'topbar-nav-item active' : 'topbar-nav-item'}
          onClick={() => navigate('/home')}
          type="button"
        >
          {t('dashboard.nav.home')}
        </button>
        <button
          className={active === 'study' ? 'topbar-nav-item active' : 'topbar-nav-item'}
          onClick={() => navigate('/courses')}
          type="button"
        >
          {t('dashboard.nav.study')}
        </button>
      </nav>
      <div className="topbar-actions">
        <button
          className="account-trigger"
          onClick={() => {
            window.location.href = `${window.location.protocol}//${window.location.hostname}:8102/courses`;
          }}
          title={t('topbar.admin')}
          type="button"
        >
          <Shield size={16} aria-hidden="true" />
          <span>{t('topbar.admin')}</span>
        </button>
        <button
          className="account-trigger"
          onClick={() => navigate('/settings')}
          title={t('settings.title')}
          type="button"
        >
          <Settings size={16} aria-hidden="true" />
          <span>{t('settings.title')}</span>
        </button>
      </div>
    </header>
  )
}
