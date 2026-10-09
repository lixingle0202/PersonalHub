import {
  CalendarOutlined,
  CoffeeOutlined,
  DashboardOutlined,
  ReadOutlined,
  SettingOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { Button, Typography } from 'antd'
import { lazy, Suspense, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { SaveStatus } from '../components/SaveStatus'
import { LearningAutoExtension } from '../components/LearningAutoExtension'
import { currentUsername, isPublicMode } from '../api/client'
import { LoadingPanel } from '../components/StatePanels'
import { loadPageModule, PageLoadErrorBoundary } from './pageLoadRecovery'

const HomePage = lazy(() => loadPageModule(() => import('../pages/HomePage').then((module) => ({ default: module.HomePage }))))
const TodayPage = lazy(() => loadPageModule(() => import('../pages/TodayPage').then((module) => ({ default: module.TodayPage }))))
const LearningPage = lazy(() => loadPageModule(() => import('../pages/LearningPage').then((module) => ({ default: module.LearningPage }))))
const DietPage = lazy(() => loadPageModule(() => import('../pages/DietPage').then((module) => ({ default: module.DietPage }))))
const SettingsPage = lazy(() => loadPageModule(() => import('../pages/SettingsPage').then((module) => ({ default: module.SettingsPage }))))
const QuickCreate = lazy(() => loadPageModule(() => import('../components/QuickCreate').then((module) => ({ default: module.QuickCreate }))))
const GlobalSearch = lazy(() => loadPageModule(() => import('../components/GlobalSearch').then((module) => ({ default: module.GlobalSearch }))))

const pages = [
  { path: '/', label: '首页总览', description: '让每一天，从容开始', icon: <DashboardOutlined /> },
  { path: '/today', label: '今日计划', description: '留出时间，专注当下', icon: <CalendarOutlined /> },
  { path: '/learning', label: '学习计划', description: '每一点积累，都通向更好的自己', icon: <ReadOutlined /> },
  { path: '/diet', label: '饮食计划', description: '认真吃饭，也认真生活', icon: <CoffeeOutlined /> },
  { path: '/settings', label: '数据与设置', description: '打造适合自己的工作空间', icon: <SettingOutlined /> },
]

export function App() {
  const [quickOpen, setQuickOpen] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)
  const location = useLocation()
  const active = pages.find((page) => page.path === location.pathname) ?? pages[0]
  const hosted = isPublicMode()
  async function logout() {
    await fetch('/api/v1/public/logout', { method: 'POST' })
    window.location.reload()
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={() => document.getElementById('main-content')?.focus()}>跳到主要内容</a>
      <aside className="app-sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">P</span>
          <div><strong>PersonalHub</strong><span className="brand-caption">生活，有条不紊</span></div>
        </div>
        <div className="nav-caption" aria-hidden="true">我的工作空间</div>
        <nav className="primary-nav" aria-label="主导航">
          {pages.map((page) => <Link to={page.path} key={page.path} aria-current={page.path === active.path ? 'page' : undefined}>
            <span className={`nav-icon nav-icon-${page.path.slice(1) || 'home'}`} aria-hidden="true">{page.icon}</span>
            <span>{page.label}</span><span className="nav-indicator" aria-hidden="true" />
          </Link>)}
        </nav>
        <div className="sidebar-footer"><SafetyCertificateOutlined aria-hidden="true" /><div><strong>{hosted ? '独立个人空间' : '本地工作空间'}</strong><span>{hosted ? '计划与记录仅你可见' : '计划与记录，安心保存在这里'}</span></div></div>
      </aside>
      <div className="app-workspace">
        <header className="app-header">
          <div className="page-heading"><Typography.Title level={3} className="page-title">{active.label}</Typography.Title><span className="page-subtitle">{active.description}</span></div>
          <div className="header-actions">
            {hosted ? <><Typography.Text>{currentUsername()}</Typography.Text><Button onClick={() => void logout()}>退出登录</Button></> : null}
            <Suspense fallback={null}><GlobalSearch /></Suspense>
            <Button type="primary" aria-label="快速新增" icon={<PlusOutlined aria-hidden="true" />} onClick={() => setQuickOpen(true)}>快速新增</Button>
            <div className="header-save-status"><SaveStatus state="saved" /></div>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className={`app-content page-${active.path.slice(1) || 'home'}`}>
          <PageLoadErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<LoadingPanel />}><Routes key={dataVersion}>
              <Route path="/" element={<HomePage />} />
              <Route path="/today" element={<TodayPage />} />
              <Route path="/learning" element={<LearningAutoExtension><LearningPage /></LearningAutoExtension>} />
              <Route path="/diet" element={<DietPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes></Suspense>
          </PageLoadErrorBoundary>
        </main>
      </div>
      {quickOpen ? <Suspense fallback={null}><QuickCreate open onClose={() => setQuickOpen(false)} onCreated={() => setDataVersion((value) => value + 1)} /></Suspense> : null}
    </div>
  )
}
