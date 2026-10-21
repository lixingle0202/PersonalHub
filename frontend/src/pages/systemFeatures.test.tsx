import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { GlobalSearch } from '../components/GlobalSearch'
import { quickCreateEndpoint, quickCreateTargets } from '../components/QuickCreate'
import { SettingsPage } from './SettingsPage'

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>
}

describe('system-wide features', () => {
  beforeEach(() => {
    setLocalToken('test-token')
    vi.restoreAllMocks()
    document.body.className = ''
    document.documentElement.style.removeProperty('--primary-color')
  })

  it('maps every retained quick-create target to its own domain endpoint', () => {
    expect(quickCreateTargets.map((item) => item.value)).toEqual(['agenda', 'note', 'learning', 'diet'])
    expect(quickCreateEndpoint('agenda', {})).toBe('/agenda')
    expect(quickCreateEndpoint('note', {})).toBe('/quick-notes')
    expect(quickCreateEndpoint('learning', { parent_id: 'g1' })).toBe('/learning/goals/g1/tasks')
    expect(quickCreateEndpoint('diet', {})).toBe('/diet/meals')
  })

  it('filters removed modules from search and opens a retained result', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json([
      { id: 'p1', module: 'development', type: '项目', title: '个人中心', snippet: '本地应用', path: '/development?project=p1' },
      { id: 'game1', module: 'games', type: '游戏', title: '示例游戏', snippet: '已经退出', path: '/games?item=game1' },
      { id: 'g1', module: 'learning', type: '学习目标', title: 'Python 入门', snippet: '每天练习', path: '/learning?item=g1' },
    ]))
    render(<MemoryRouter initialEntries={['/']}><GlobalSearch /><LocationProbe /></MemoryRouter>)

    await user.type(screen.getByRole('searchbox', { name: '全局搜索' }), '计划')
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Python 入门')).toBeInTheDocument()
    expect(screen.queryByText('个人中心')).not.toBeInTheDocument()
    expect(screen.queryByText('示例游戏')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/search?q=%E8%AE%A1%E5%88%92', expect.any(Object))
    await user.click(screen.getByText('Python 入门'))
    expect(screen.getByTestId('location')).toHaveTextContent('/learning')
  })

  it('loads, applies and saves local preferences', async () => {
    let settings = {
      nickname: '我', theme_mode: 'light', theme_color: '#1677ff', week_starts_on: 1,
      default_work_start: '09:00', default_work_end: '18:00', default_study_minutes: 60,
      custom_categories: {},
    }
    let savedPayload: Record<string, unknown> | null = null
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/bootstrap')) return json({ app_name: 'Personal Hub', version: '0.1.0', local_token: 'new-token', database_path: 'D:/data/personal_hub.db' })
      if (url.endsWith('/settings') && init?.method === 'PATCH') {
        savedPayload = JSON.parse(String(init.body)) as Record<string, unknown>
        settings = { ...settings, ...savedPayload } as typeof settings
        return json(settings)
      }
      if (url.endsWith('/settings')) return json(settings)
      if (url.endsWith('/backups') || url.endsWith('/trash')) return json([])
      return json({}, 404)
    })

    const view = render(<MemoryRouter initialEntries={['/settings']}><Routes><Route path="/settings" element={<SettingsPage />} /></Routes></MemoryRouter>)
    expect(await screen.findByDisplayValue('D:/data/personal_hub.db')).toBeInTheDocument()
    fireEvent.click(screen.getByText('个性化设置'))
    const nickname = await screen.findByLabelText('昵称')
    fireEvent.change(nickname, { target: { value: '新名字' } })
    fireEvent.change(screen.getByLabelText('主题颜色'), { target: { value: '#22aa77' } })
    fireEvent.click(screen.getByRole('switch', { name: '深色模式' }))
    expect(document.body).toHaveClass('dark-mode')
    expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#22aa77')
    await waitFor(() => expect(savedPayload).toMatchObject({ theme_mode: 'dark', theme_color: '#22aa77' }))
    expect(screen.getByLabelText('昵称')).toHaveValue('新名字')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() => expect(savedPayload).toMatchObject({ nickname: '新名字', theme_mode: 'dark', theme_color: '#22aa77' }))
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/settings') && init?.method === 'PATCH')).toBe(true)
    expect(document.body).toHaveClass('dark-mode')
    view.unmount()
    render(<MemoryRouter initialEntries={['/settings']}><Routes><Route path="/settings" element={<SettingsPage />} /></Routes></MemoryRouter>)
    fireEvent.click(await screen.findByText('个性化设置'))
    expect(await screen.findByRole('switch', { name: '深色模式' })).toBeChecked()
    expect(screen.getByLabelText('主题颜色')).toHaveValue('#22aa77')
  })

  it('keeps the selected appearance after an automatic save fails and allows retrying', async () => {
    let failSave = true
    let settings = {
      nickname: '', theme_mode: 'light', theme_color: '#1677ff', week_starts_on: 1,
      default_work_start: '09:00', default_work_end: '18:00', default_study_minutes: 60,
      custom_categories: {},
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/bootstrap')) return json({ app_name: 'Personal Hub', version: '0.1.0', local_token: 'new-token', database_path: 'D:/data/personal_hub.db' })
      if (url.endsWith('/settings') && init?.method === 'PATCH') {
        if (failSave) return json({ detail: '暂时无法保存设置' }, 503)
        settings = { ...settings, ...JSON.parse(String(init.body)) }
        return json(settings)
      }
      if (url.endsWith('/settings')) return json(settings)
      if (url.endsWith('/backups') || url.endsWith('/trash')) return json([])
      return json({}, 404)
    })

    const view = render(<MemoryRouter initialEntries={['/settings']}><Routes><Route path="/settings" element={<SettingsPage />} /></Routes></MemoryRouter>)
    fireEvent.click(await screen.findByText('个性化设置'))
    fireEvent.click(await screen.findByRole('switch', { name: '深色模式' }))
    expect(document.body).toHaveClass('dark-mode')
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法保存设置')
    expect(screen.getByRole('alert')).toHaveTextContent('点击“保存设置”重试')
    expect(screen.getByRole('switch', { name: '深色模式' })).toBeChecked()
    failSave = false
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(settings.theme_mode).toBe('dark'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    view.unmount()
    expect(document.body).toHaveClass('dark-mode')
  })

  it('shows verified backups and creates a manual backup', async () => {
    const settings = {
      nickname: '', theme_mode: 'light', theme_color: '#1677ff', week_starts_on: 1,
      default_work_start: '09:00', default_work_end: '18:00', default_study_minutes: 60,
      custom_categories: {},
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/bootstrap')) return json({ app_name: 'Personal Hub', version: '0.1.0', local_token: 'new-token', database_path: 'D:/data/personal_hub.db' })
      if (url.endsWith('/settings')) return json(settings)
      if (url.endsWith('/backups/example.db/restore')) return json({ restored: 'example.db' })
      if (url.endsWith('/backups') && init?.method === 'POST') return json({ name: 'new.db' }, 201)
      if (url.endsWith('/backups')) return json([{ name: 'example.db', created_at: '2026-09-30T08:00:00Z', size_bytes: 4096, sha256: '1234567890abcdef', kind: 'manual' }])
      if (url.includes('/trash/') && init?.method === 'POST') return json({})
      if (url.endsWith('/trash')) return json([{ type: 'agenda', id: 'a1', module: 'today', label: '计划', title: '已删除事项', deleted_at: '2026-09-30T09:00:00Z' }])
      return json({}, 404)
    })

    render(<MemoryRouter initialEntries={['/settings']}><Routes><Route path="/settings" element={<SettingsPage />} /></Routes></MemoryRouter>)
    expect(await screen.findByText('手动备份')).toBeInTheDocument()
    expect(screen.getByText('已删除事项')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复此备份' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '立即备份' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/backups') && init?.method === 'POST')).toBe(true))
  })

  it('restores a trash item from data management', async () => {
    const settings = {
      nickname: '', theme_mode: 'light', theme_color: '#1677ff', week_starts_on: 1,
      default_work_start: '09:00', default_work_end: '18:00', default_study_minutes: 60,
      custom_categories: {},
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/bootstrap')) return json({ app_name: 'Personal Hub', version: '0.1.0', local_token: 'new-token', database_path: 'D:/data/personal_hub.db' })
      if (url.endsWith('/settings')) return json(settings)
      if (url.endsWith('/backups')) return json([])
      if (url.includes('/trash/') && init?.method === 'POST') return json({})
      if (url.endsWith('/trash')) return json([{ type: 'agenda', id: 'a1', module: 'today', label: '计划', title: '已删除事项', deleted_at: '2026-09-30T09:00:00Z' }])
      return json({}, 404)
    })

    render(<MemoryRouter initialEntries={['/settings']}><Routes><Route path="/settings" element={<SettingsPage />} /></Routes></MemoryRouter>)
    expect(await screen.findByText('已删除事项')).toBeInTheDocument()

    const restore = screen.getByRole('button', { name: /^恢\s*复$/ })
    expect(restore).toBeEnabled()
    fireEvent.click(restore)
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/trash/agenda/a1/restore') && init?.method === 'POST')).toBe(true))
  })
})
