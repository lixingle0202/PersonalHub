import { render, screen, waitFor } from '@testing-library/react'
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
  summaries: Object.fromEntries(['media', 'development', 'consulting', 'learning', 'diet', 'games'].map((key) => [key, { title: '暂无重点', count: 0 }])),
}

describe('application shell', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => String(input).includes('/home') ? json(emptyHome) : json([]))
  })

  it('shows all nine primary navigation items', async () => {
    render(<MemoryRouter><App /></MemoryRouter>)
    for (const label of [
      '首页总览', '今日计划', '自媒体', '开发工作', '咨询工作',
      '学习计划', '饮食计划', '游戏娱乐', '数据与设置',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(await screen.findByText('今天，专注最重要的事')).toBeInTheDocument()
  })

  it('navigates between primary pages', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><App /></MemoryRouter>)
    await user.click(screen.getByRole('link', { name: /开发工作/ }))
    expect(await screen.findByRole('heading', { name: '开发工作', level: 3 })).toBeInTheDocument()
    expect(await screen.findByText('按项目管理功能需求、任务、问题、里程碑和开发日志')).toBeInTheDocument()
  })

  it('refreshes the current page after quick-create succeeds', async () => {
    const user = userEvent.setup()
    let homeReads = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/home')) { homeReads += 1; return json(emptyHome) }
      if (String(input).endsWith('/agenda') && init?.method === 'POST') return json({ id: 'a1' })
      return json([])
    })
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(await screen.findByText('今天，专注最重要的事')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '快速新增' }))
    const title = await screen.findByLabelText('标题或内容')
    await user.type(title, '快速创建事项')
    await user.click(screen.getByRole('button', { name: /创\s*建/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/agenda') && init?.method === 'POST')).toBe(true))
    await waitFor(() => expect(homeReads).toBeGreaterThanOrEqual(2))
  })
})
