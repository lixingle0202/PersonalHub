import {
  CalendarOutlined,
  CoffeeOutlined,
  DashboardOutlined,
  ReadOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { Button, Layout, Menu, Space, Typography } from 'antd'
import { lazy, Suspense, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { SaveStatus } from '../components/SaveStatus'
import { LoadingPanel } from '../components/StatePanels'
import { loadPageModule, PageLoadErrorBoundary } from './pageLoadRecovery'

const HomePage = lazy(() => loadPageModule(() => import('../pages/HomePage').then((module) => ({ default: module.HomePage }))))
const TodayPage = lazy(() => loadPageModule(() => import('../pages/TodayPage').then((module) => ({ default: module.TodayPage }))))
const LearningPage = lazy(() => loadPageModule(() => import('../pages/LearningPage').then((module) => ({ default: module.LearningPage }))))
const DietPage = lazy(() => loadPageModule(() => import('../pages/DietPage').then((module) => ({ default: module.DietPage }))))
const SettingsPage = lazy(() => loadPageModule(() => import('../pages/SettingsPage').then((module) => ({ default: module.SettingsPage }))))
const QuickCreate = lazy(() => loadPageModule(() => import('../components/QuickCreate').then((module) => ({ default: module.QuickCreate }))))
const GlobalSearch = lazy(() => loadPageModule(() => import('../components/GlobalSearch').then((module) => ({ default: module.GlobalSearch }))))

const { Header, Sider, Content } = Layout

const pages = [
  { path: '/', label: '首页总览', icon: <DashboardOutlined /> },
  { path: '/today', label: '今日计划', icon: <CalendarOutlined /> },
  { path: '/learning', label: '学习计划', icon: <ReadOutlined /> },
  { path: '/diet', label: '饮食计划', icon: <CoffeeOutlined /> },
  { path: '/settings', label: '数据与设置', icon: <SettingOutlined /> },
]

export function App() {
  const [quickOpen, setQuickOpen] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)
  const location = useLocation()
  const active = pages.find((page) => page.path === location.pathname) ?? pages[0]
  const menuItems = pages.map((page) => ({
    key: page.path,
    icon: page.icon,
    label: <Link to={page.path}>{page.label}</Link>,
  }))

  return (
    <Layout className="app-shell">
      <Sider width={224} theme="light" className="app-sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <span>PersonalHub</span>
        </div>
        <Menu mode="inline" selectedKeys={[active.path]} items={menuItems} />
      </Sider>
      <Layout>
        <Header className="app-header">
          <Typography.Title level={3} className="page-title">{active.label}</Typography.Title>
          <Space>
            <Suspense fallback={null}><GlobalSearch /></Suspense>
            <Button type="primary" onClick={() => setQuickOpen(true)}>快速新增</Button>
            <SaveStatus state="saved" />
          </Space>
        </Header>
        <Content className="app-content">
          <PageLoadErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<LoadingPanel />}><Routes key={dataVersion}>
              <Route path="/" element={<HomePage />} />
              <Route path="/today" element={<TodayPage />} />
              <Route path="/learning" element={<LearningPage />} />
              <Route path="/diet" element={<DietPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes></Suspense>
          </PageLoadErrorBoundary>
        </Content>
      </Layout>
      {quickOpen ? <Suspense fallback={null}><QuickCreate open onClose={() => setQuickOpen(false)} onCreated={() => setDataVersion((value) => value + 1)} /></Suspense> : null}
    </Layout>
  )
}
