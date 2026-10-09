import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

const emptyHome = {
  date: '2026-09-30', stats: { total: 0, completed: 0, completion_rate: 0, must: 0, overdue: 0, due_soon: 0 },
  agenda: [], quick_notes: [],
  summaries: Object.fromEntries(['learning', 'diet'].map((key) => [key, { title: '暂无重点', count: 0 }])),
}

describe('application shell', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => String(input).includes('/home') ? json(emptyHome) : json([]))
  })

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
