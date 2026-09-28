import { Menu, Select, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { BookOpen, GraduationCap, Layers3, LogOut, PanelLeftClose, PanelLeftOpen, UserRound, type LucideIcon } from 'lucide-react'
import type { AdminUser } from '@juting/shared'
import { adminUiLocaleLabels, useAdminLanguage } from '../../i18n/AdminLanguageProvider'

export type AdminSection = 'directory' | 'courses' | 'importer'

// 单机版侧栏：只保留目录结构与课程管理。
// 制课工作台（importer）只作为“课程管理”里某门课程的编辑页入口，不在侧栏出现。
const adminSections: Array<{
  id: Exclude<AdminSection, 'importer'>
  label: string
  Icon: LucideIcon
}> = [
  {
    id: 'directory',
    label: '目录结构',
    Icon: Layers3,
  },
  {
    id: 'courses',
    label: '课程管理',
    Icon: BookOpen,
  },
]

type AdminWorkspaceNavProps = {
  activeSection: AdminSection
  adminUser: AdminUser
  collapsed?: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onLogout: () => void
  onSectionChange: (section: AdminSection) => void
}

export function AdminWorkspaceNav({
  activeSection,
  adminUser,
  collapsed = false,
  onCollapsedChange,
  onLogout,
  onSectionChange,
}: AdminWorkspaceNavProps) {
  const { t, uiLocale, setUiLocale } = useAdminLanguage()
  const workspaceItems: MenuProps['items'] = adminSections.map(({
    id,
    label,
    Icon,
  }) => ({
    key: id,
    icon: <Icon size={17} aria-hidden="true" />,
    label: t(label),
  }))

  const menuItems: MenuProps['items'] = [
    {
      className: 'admin-menu-collapse',
      icon: collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />,
      key: 'collapse',
      label: collapsed ? t('展开侧栏') : t('收起侧栏'),
      title: collapsed ? t('展开侧栏') : t('收起侧栏'),
    },
    {
      className: 'admin-menu-brand',
      disabled: true,
      icon: <img alt="" className="admin-menu-brand-icon" src="/juting-icon.svg" />,
      key: 'brand',
      label: collapsed ? 'JuTing' : `JuTing ${t('管理后台')}`,
    },
    ...workspaceItems,
    {
      className: 'admin-menu-learner',
      icon: <GraduationCap size={17} aria-hidden="true" />,
      key: 'learner-app',
      label: t('前往学习端'),
    },
    { type: 'divider' },
    {
      className: 'admin-menu-account',
      icon: <UserRound size={17} aria-hidden="true" />,
      key: 'account',
      label: collapsed ? t('后台账号') : `${adminUser.displayName} · ${t('超级管理员')}`,
      popupClassName: 'admin-account-popup',
      children: [
        {
          className: 'admin-account-language-item',
          key: 'language',
          label: (
            <div className="admin-account-language" onClick={(event) => event.stopPropagation()}>
              <Typography.Text type="secondary">{t('界面语言')}</Typography.Text>
              <Select
                aria-label={t('界面语言')}
                onChange={setUiLocale}
                onClick={(event) => event.stopPropagation()}
                options={(Object.keys(adminUiLocaleLabels) as Array<keyof typeof adminUiLocaleLabels>).map((locale) => ({
                  label: adminUiLocaleLabels[locale],
                  value: locale,
                }))}
                size="small"
                value={uiLocale}
              />
            </div>
          ),
        },
        {
          icon: <LogOut size={16} aria-hidden="true" />,
          key: 'logout',
          label: t('退出登录'),
        },
      ],
    },
  ]

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'collapse') {
      onCollapsedChange(!collapsed)
      return
    }
    if (key === 'logout') {
      onLogout()
      return
    }
    // 与学习端顶栏「管理后台」按钮对称：同标签跳回学习端首页
    if (key === 'learner-app') {
      window.location.href = `${window.location.protocol}//${window.location.hostname}:8101/`
      return
    }
    if (key === 'language') {
      return
    }
    if (key !== 'account') {
      onSectionChange(key as AdminSection)
    }
  }

  return (
    <div className="admin-workspace-nav">
      <Menu
        className={collapsed ? 'admin-workspace-menu is-collapsed' : 'admin-workspace-menu'}
        items={menuItems}
        mode="vertical"
        onClick={handleMenuClick}
        selectedKeys={[activeSection]}
      />
    </div>
  )
}
