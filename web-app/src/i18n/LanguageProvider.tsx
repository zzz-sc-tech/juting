import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { messages, type MessageKey } from './messages'

// 单语产品：界面与学习内容语言固定简体中文（六级备考工具，受众即中文用户）。
// 译文按 zh-CN 恒定回填，不再有「内容语言设成英文导致译文不显示」的坑；
// t() 消息表机制保留，历史多语言文案仍在 messages/ 里，未再接切换入口。
const UI_LOCALE = 'zh-CN' as const
const CONTENT_LOCALE = 'zh-CN' as const

type LanguageContextValue = {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  uiLocale: typeof UI_LOCALE
  contentLocale: typeof CONTENT_LOCALE
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const value = useMemo<LanguageContextValue>(
    () => ({
      uiLocale: UI_LOCALE,
      contentLocale: CONTENT_LOCALE,
      t: (key, values) => {
        // 语义 key 查消息表；查不到说明有组件漏配 key，原样返回 key 便于排查。
        let message = messages[UI_LOCALE][key] ?? messages['en-US'][key] ?? key
        if (values) {
          for (const [name, value2] of Object.entries(values)) {
            message = message.replaceAll(`{{${name}}}`, String(value2))
          }
        }
        return message
      },
    }),
    [],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (!context) {
    throw new Error('useLanguage must be used inside LanguageProvider')
  }
  return context
}
