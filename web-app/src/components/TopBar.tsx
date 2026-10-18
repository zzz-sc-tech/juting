import { Search, Settings } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../i18n/LanguageProvider'

type TopBarProps = {
  /** 当前所在导航：首页（仪表盘）/ 学习页 / 难点复习 / 生词本 / 搜索 / 设置。 */
  active?: 'home' | 'study' | 'review' | 'vocabulary' | 'search' | 'settings'
}

// 本地免登录模式：顶栏 = 品牌入口 + 首页/学习切换 + 设置；语言切换在设置页。
export function TopBar({ active }: TopBarProps) {
  const { t } = useLanguage()
  const navigate = useNavigate()

  return (
    <header className="topbar">
      <button
        /* 可见文字是「句听 + 听力课程」两行，读屏只读品牌名会丢掉副标题 */
        aria-label={`${t('brand')} · ${t('courseLabel')}`}
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
        <button
          className={active === 'review' ? 'topbar-nav-item active' : 'topbar-nav-item'}
          onClick={() => navigate('/review')}
          type="button"
        >
          {t('topbar.review')}
        </button>
        <button
          className={active === 'vocabulary' ? 'topbar-nav-item active' : 'topbar-nav-item'}
          onClick={() => navigate('/vocabulary')}
          type="button"
        >
          {t('topbar.vocabulary')}
        </button>
      </nav>
      <div className="topbar-actions">
        {/* 管理后台入口已移除（2026-10-11 用户裁定）：38 套真题开箱即用，学习端零依赖后台；
            制课/课程管理仍可用——浏览器直接访问 <host>:8102（应用本体保留）。 */}
        <button
          aria-current={active === 'search' ? 'page' : undefined}
          aria-label={t('search.title')}
          className={active === 'search' ? 'account-trigger active' : 'account-trigger'}
          onClick={() => navigate('/search')}
          title={t('search.title')}
          type="button"
        >
          <Search size={16} aria-hidden="true" />
        </button>
        <button
          aria-current={active === 'settings' ? 'page' : undefined}
          aria-label={t('settings.title')}
          className={active === 'settings' ? 'account-trigger active' : 'account-trigger'}
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
