import { NavLink, Navigate, Route, Routes } from 'react-router-dom'

import LibraryPage from './pages/Library'
import SearchPage from './pages/Search'
import SettingsPage from './pages/Settings'

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <span className="app-brand-mark">素材</span>
          <span className="app-brand-name">检索与文案润色</span>
        </div>
        <nav className="app-nav">
          <NavLink to="/search">检索</NavLink>
          <NavLink to="/library">素材库</NavLink>
          <NavLink to="/settings">设置</NavLink>
        </nav>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/search" replace />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/search" replace />} />
        </Routes>
      </main>
    </div>
  )
}
