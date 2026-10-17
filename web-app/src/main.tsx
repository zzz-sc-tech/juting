import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { LanguageProvider } from './i18n/LanguageProvider.tsx'
import { initTheme } from './lib/theme'
import { snapshotForAutobackup } from './lib/dataBackup'

// 首帧渲染前套好主题属性，避免纸墨书房一闪再跳成晨报
initTheme()
// 启动时把进度快照进 autobackup 环形缓冲（2 份），误清缓存时有兜底
snapshotForAutobackup()
// 长驻会话（挂着听一整天）也需要新快照：每 10 分钟补一份，内容没变则内部跳过
window.setInterval(snapshotForAutobackup, 10 * 60 * 1000)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 最外层再兜一层：App / Provider 自身崩掉时也不白屏（路由级兜底在 App 内部） */}
    <ErrorBoundary scope="界面">
      <LanguageProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </LanguageProvider>
    </ErrorBoundary>
  </StrictMode>,
)
