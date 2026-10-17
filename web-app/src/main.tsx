import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { LanguageProvider } from './i18n/LanguageProvider.tsx'
import { initTheme } from './lib/theme'
import { snapshotForAutobackup } from './lib/dataBackup'

// 首帧渲染前套好主题属性，避免纸墨书房一闪再跳成晨报
initTheme()
// 启动时把进度快照进 autobackup 环形缓冲（3 份），误清缓存时有兜底
snapshotForAutobackup()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </LanguageProvider>
  </StrictMode>,
)
