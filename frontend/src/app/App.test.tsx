import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { theme } from 'antd'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { AppearanceProvider, applyAppearance, loadAppearance } from './theme'
import type { AppSettings } from '../api/settings'

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

function ThemeProbe() {
  const { token } = theme.useToken()
  return <output data-testid="page-background">{token.colorBgContainer}</output>
}

const emptyHome = {
  date: '2026-09-30', stats: { total: 0, completed: 0, completion_rate: 0, must: 0, overdue: 0, due_soon: 0 },
  agenda: [], quick_notes: [],
  summaries: Object.fromEntries(['learning', 'diet'].map((key) => [key, { title: '暂无重点', count: 0 }])),
}

describe('application shell', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    applyAppearance({ theme_mode: 'light', theme_color: '#5b6cff' })
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => String(input).includes('/home') ? json(emptyHome) : json([]))
  })

  it('keeps automatically saved dark mode across all pages and startup, and can switch back to light', async () => {
    const user = userEvent.setup()
    let settings: AppSettings = {
      nickname: '学生', theme_mode: 'light', theme_color: '#5b6cff', week_starts_on: 1,
      default_work_start: '09:00', default_work_end: '18:00', default_study_minutes: 60, custom_categories: {},
    }
    let finishFirstSave!: () => void
    let writes = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/settings')) {
        if (init?.method === 'PATCH') {
          const changes = JSON.parse(String(init.body))
          if (++writes === 1) return new Promise<Response>((resolve) => {
            finishFirstSave = () => { settings = { ...settings, ...changes }; void json(settings).then(resolve) }
          })
          settings = { ...settings, ...changes }
        }
        return json(settings)
      }
      if (url.endsWith('/bootstrap')) return json({ local_token: 'test-token', database_path: 'D:/test.db' })
      if (url.includes('/home')) return json(emptyHome)
      if (url.endsWith('/diet/profile')) return json({ height_cm: null, weight_kg: null })
      if (url.includes('/diet/health/')) return json({ water_ml: 0, feeling: '', weight_kg: null })
      return json([])
    })
    const view = render(<AppearanceProvider><MemoryRouter initialEntries={['/settings']}><App /><ThemeProbe /></MemoryRouter></AppearanceProvider>)
    fireEvent.click(await screen.findByText('个性化设置'))
    fireEvent.click(await screen.findByRole('switch', { name: '深色模式' }))
    await waitFor(() => expect(finishFirstSave).toBeTypeOf('function'))

    // Leave before the request completes; unmounting settings must not undo the choice.
    await user.click(screen.getByRole('link', { name: '首页总览' }))
    expect(await screen.findByText('今天，专注最重要的事', {}, { timeout: 10000 })).toBeInTheDocument()
    expect(document.body).toHaveClass('dark-mode')
    expect(screen.getByTestId('page-background')).toHaveTextContent('#232b3c')
    await act(async () => finishFirstSave())
    await waitFor(() => expect(settings.theme_mode).toBe('dark'))

    for (const [page, content] of [
      ['今日计划', '新增计划'], ['学习计划', '新建学习目标'], ['饮食计划', '个人身体资料与热量估算'], ['数据与设置', '个性化设置'],
    ]) {
      await user.click(screen.getByRole('link', { name: page }))
      expect(await (page === '今日计划' || page === '学习计划'
        ? screen.findByRole('button', { name: content }, { timeout: 10000 })
        : screen.findByText(content, {}, { timeout: 10000 }))).toBeInTheDocument()
      expect(screen.getByRole('link', { name: page })).toHaveAttribute('aria-current', 'page')
      expect(document.body).toHaveClass('dark-mode')
      expect(screen.getByTestId('page-background')).toHaveTextContent('#232b3c')
    }
    fireEvent.click(screen.getByText('个性化设置'))
    expect(await screen.findByRole('switch', { name: '深色模式' })).toBeChecked()
    view.unmount()

    // Simulate a new application startup by resetting memory, then reading persisted settings.
    applyAppearance({ theme_mode: 'light', theme_color: '#5b6cff' })
    await loadAppearance()
    render(<AppearanceProvider><MemoryRouter initialEntries={['/settings']}><App /><ThemeProbe /></MemoryRouter></AppearanceProvider>)
    fireEvent.click(await screen.findByText('个性化设置'))
    expect(await screen.findByRole('switch', { name: '深色模式' })).toBeChecked()
    expect(document.body).toHaveClass('dark-mode')
    expect(screen.getByTestId('page-background')).toHaveTextContent('#232b3c')

    fireEvent.click(screen.getByRole('switch', { name: '深色模式' }))
    await waitFor(() => expect(settings.theme_mode).toBe('light'))
    await user.click(screen.getByRole('link', { name: '首页总览' }))
    expect(await screen.findByText('今天，专注最重要的事')).toBeInTheDocument()
    expect(document.body).not.toHaveClass('dark-mode')
    expect(screen.getByTestId('page-background')).toHaveTextContent('#ffffff')
  }, 60000)

  it('shows only the five retained primary navigation items', async () => {
    render(<MemoryRouter><App /></MemoryRouter>)
    for (const label of [
      '首页总览', '今日计划', '学习计划', '饮食计划', '数据与设置',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    for (const removed of ['自媒体', '开发工作', '咨询工作', '游戏娱乐']) {
      expect(screen.queryByRole('link', { name: removed })).not.toBeInTheDocument()
    }
    expect(await screen.findByText('今天，专注最重要的事')).toBeInTheDocument()
  })

  it('navigates between primary pages', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><App /></MemoryRouter>)
    await user.click(screen.getByRole('link', { name: /学习计划/ }))
    expect(await screen.findByRole('heading', { name: '学习计划', level: 3 })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '新建学习目标' })).toBeEnabled()
  })

  it('exposes one current navigation destination and updates it after navigation', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><App /></MemoryRouter>)
    const navigation = screen.getByRole('navigation', { name: '主导航' })
    expect(within(navigation).getByRole('link', { name: '首页总览' })).toHaveAttribute('aria-current', 'page')
    await user.click(within(navigation).getByRole('link', { name: '今日计划' }))
    expect(await screen.findByRole('heading', { level: 3, name: '今日计划' })).toBeInTheDocument()
    expect(within(navigation).getByRole('link', { name: '今日计划' })).toHaveAttribute('aria-current', 'page')
    expect(within(navigation).getByRole('link', { name: '首页总览' })).not.toHaveAttribute('aria-current')
    expect(navigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })

  it('lets keyboard users skip navigation and focus the main content', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><App /></MemoryRouter>)
    await user.tab()
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it.each(['/media', '/development', '/consulting', '/games'])('redirects removed route %s to the overview', async (route) => {
    render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
    expect(await screen.findByText('今天，专注最重要的事')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '首页总览', level: 3 })).toBeInTheDocument()
  })

  it('refreshes the current page after quick-create succeeds', async () => {
    let homeReads = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/home')) { homeReads += 1; return json(emptyHome) }
      if (String(input).endsWith('/agenda') && init?.method === 'POST') return json({ id: 'a1' })
      return json([])
    })
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(await screen.findByText('今天，专注最重要的事')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '快速新增' }))
    const title = await screen.findByLabelText('标题或内容')
    fireEvent.change(title, { target: { value: '新事项' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/agenda') && init?.method === 'POST')).toBe(true))
    await waitFor(() => expect(homeReads).toBeGreaterThanOrEqual(2))
  })
})
