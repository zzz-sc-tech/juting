import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
// 首页是默认落地页，保持静态 import：拆出去反而多一次请求
import { DashboardPage } from './components/dashboard/DashboardPage'
import { ErrorBoundary } from './components/ErrorBoundary'
import { StorageAlertBanner } from './components/StorageAlertBanner'

// 其余页面按路由懒加载（命名导出要转成 default，否则报 Element type is invalid）。
// 收益主要来自 StudyPage（五舞台 + 波形）与生词本页（1.3MB 词典）。
const StudyPage = lazy(() => import('./features/study/StudyPage').then((m) => ({ default: m.StudyPage })))
const GlobalReviewPage = lazy(() => import('./pages/GlobalReviewPage').then((m) => ({ default: m.GlobalReviewPage })))
const VocabularyPage = lazy(() => import('./pages/VocabularyPage').then((m) => ({ default: m.VocabularyPage })))
const SearchPage = lazy(() => import('./pages/SearchPage').then((m) => ({ default: m.SearchPage })))
const SettingsPage = lazy(() => import('./components/SettingsPage').then((m) => ({ default: m.SettingsPage })))

function App() {
  return (
    <ErrorBoundary>
      {/* 存储故障常驻横幅：写盘失败/数据损坏时置顶提示，任何页面都看得到 */}
      <StorageAlertBanner />
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/home" element={<DashboardPage />} />
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/courses" element={<StudyPage />} />
          <Route path="/courses/:seriesId" element={<StudyPage />} />
          <Route path="/courses/:seriesId/chapters/:exerciseId" element={<StudyPage />} />
          <Route path="/review" element={<GlobalReviewPage />} />
          <Route path="/vocabulary" element={<VocabularyPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}

/**
 * 路由切块的加载态：不白屏、不抢视线。
 * 只依赖主包样式（styles/route-states.css），这里不 import 任何重组件。
 */
function RouteLoading() {
  return (
    <div className="route-loading" role="status" aria-live="polite">
      <span className="route-loading-bar" aria-hidden="true" />
      <span className="route-loading-text">载入中…</span>
    </div>
  )
}

export default App
