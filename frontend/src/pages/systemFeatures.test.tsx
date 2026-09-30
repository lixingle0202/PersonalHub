import { render, screen, waitFor } from '@testing-library/react'
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
    expect(quickCreateTargets.map((item) => item.value)).toEqual(['agenda', 'note', 'learning', 'diet', 'games'])
    expect(quickCreateEndpoint('agenda', {})).toBe('/agenda')
    expect(quickCreateEndpoint('note', {})).toBe('/quick-notes')
    expect(quickCreateEndpoint('learning', { parent_id: 'g1' })).toBe('/learning/goals/g1/tasks')
    expect(quickCreateEndpoint('diet', {})).toBe('/diet/meals')
    expect(quickCreateEndpoint('games', {})).toBe('/games')
  })

  it('filters removed modules from search and opens a retained result', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json([
      { id: 'p1', module: 'development', type: '项目', title: '个人中心', snippet: '本地应用', path: '/development?project=p1' },
      { id: 'g1', module: 'learning', type: '学习目标', title: 'Python 入门', snippet: '每天练习', path: '/learning?item=g1' },
    ]))
    render(<MemoryRouter initialEntries={['/']}><GlobalSearch /><LocationProbe /></MemoryRouter>)

    await user.type(screen.getByRole('searchbox', { name: '全局搜索' }), '计划')
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Python 入门')).toBeInTheDocument()
    expect(screen.queryByText('个人中心')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/search?q=%E8%AE%A1%E5%88%92', expect.any(Object))
    await user.click(screen.getByText('Python 入门'))
    expect(screen.getByTestId('location')).toHaveTextContent('/learning')
  })

  it('loads, applies and saves local preferences', async () => {
    const user = userEvent.setup()
    const settings = {
      nickname: '我', theme_mode: 'light', theme_color: '#1677ff', week_starts_on: 1,
      default_work_start: '09:00', default_work_end: '18:00', default_study_minutes: 60,
      custom_categories: {},
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/bootstrap')) return json({ app_name: 'Personal Hub', version: '0.1.0', local_token: 'new-token', database_path: 'D:/data/personal_hub.db' })
      if (url.endsWith('/settings') && init?.method === 'PATCH') return json({ ...settings, nickname: '新名字', theme_mode: 'dark' })
      if (url.endsWith('/settings')) return json(settings)
      if (url.endsWith('/backups') || url.endsWith('/trash')) return json([])
      return json({}, 404)
    })

    render(<MemoryRouter initialEntries={['/settings']}><Routes><Route path="/settings" element={<SettingsPage />} /></Routes></MemoryRouter>)
    expect(await screen.findByDisplayValue('D:/data/personal_hub.db')).toBeInTheDocument()
    await user.click(screen.getByText('个性化设置'))
    const nickname = await screen.findByLabelText('昵称')
    await user.clear(nickname)
    await user.type(nickname, '新名字')
    await user.click(screen.getByRole('switch', { name: '深色模式' }))
    await user.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/settings') && init?.method === 'PATCH')).toBe(true))
    expect(document.body).toHaveClass('dark-mode')
  })

  it('shows verified backups and trash actions in data management', async () => {
    const user = userEvent.setup()
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

    await user.click(screen.getByRole('button', { name: '立即备份' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/backups') && init?.method === 'POST')).toBe(true))

    await waitFor(() => expect(screen.getByRole('button', { name: /^恢\s*复$/ })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /^恢\s*复$/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/trash/agenda/a1/restore') && init?.method === 'POST')).toBe(true))
  })
})
