import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { DashboardPage } from './components/dashboard/DashboardPage'
import { SettingsPage } from './components/SettingsPage'
import { StudyPage } from './features/study/StudyPage'
import { GlobalReviewPage } from './pages/GlobalReviewPage'
import { VocabularyPage } from './pages/VocabularyPage'

function App() {
  return (
    <Routes>
      <Route path="/home" element={<DashboardPage />} />
      <Route path="/" element={<Navigate to="/home" replace />} />
      <Route path="/courses" element={<StudyPage />} />
      <Route path="/courses/:seriesId" element={<StudyPage />} />
      <Route path="/courses/:seriesId/chapters/:exerciseId" element={<StudyPage />} />
      <Route path="/review" element={<GlobalReviewPage />} />
      <Route path="/vocabulary" element={<VocabularyPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  )
}

export default App
