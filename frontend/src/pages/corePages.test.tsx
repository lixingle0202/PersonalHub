import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { HomePage } from './HomePage'
import { TodayPage } from './TodayPage'
import { DevelopmentPage } from './DevelopmentPage'

const agenda = [{
  id: 'a1', title: '完成核心闭环', plan_date: '2026-09-30', start_time: null,
  end_time: null, priority: 'high', bucket: 'must', status: 'pending', sort_order: 1,
  module: 'development', source_type: 'dev_task', source_id: 't1', notes: '', completed_at: null,
}]

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

describe('core pages', () => {
  beforeEach(() => {
    setLocalToken('test-token')
    vi.restoreAllMocks()
  })

  it('renders home statistics, agenda, notes and six summaries', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({
      date: '2026-09-30',
      stats: { total: 1, completed: 0, completion_rate: 0, must: 1, overdue: 0, due_soon: 0 },
      agenda,
      quick_notes: [{ id: 'n1', content: '记录灵感', is_important: false, is_archived: false, converted_type: null, converted_id: null, created_at: '2026-09-30T00:00:00Z' }],
      summaries: {
        media: { title: '待发布 1 条', count: 1 }, development: { title: '1 个项目', count: 0 },
        consulting: { title: '待跟进 1 条', count: 1 }, learning: { title: '今日学习', count: 1 },
        diet: { title: '下一餐午餐', count: 1 }, games: { title: '今日 30 分钟', count: 1 },
      },
    }))
    render(<MemoryRouter><HomePage /></MemoryRouter>)
    expect(await screen.findByText('完成核心闭环')).toBeInTheDocument()
    expect(screen.getByText('记录灵感')).toBeInTheDocument()
    for (const label of ['自媒体', '开发工作', '咨询工作', '学习计划', '饮食计划', '游戏娱乐']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('completes an item from today page through the protected API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.includes('/complete')) return json({ ...agenda[0], status: 'completed' })
      return json(agenda)
    })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await userEvent.click(await screen.findByLabelText('完成 完成核心闭环'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/agenda/a1/complete',
      expect.objectContaining({ method: 'POST', headers: expect.any(Headers) }),
    ))
  })

  it('renders development projects and their domain-specific tasks', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('/tasks')) return json([{ id: 't1', project_id: 'p1', title: '实现同步', description: '', workflow_status: 'doing', agenda_id: 'a1', plan_date: '2026-09-30', priority: 'high', bucket: 'scheduled', agenda_status: 'pending' }])
      return json([{ id: 'p1', name: 'PersonalHub', goal: '管理工作生活', description: '', status: 'active', start_date: null, due_date: null, progress: 40 }])
    })
    render(<MemoryRouter><DevelopmentPage /></MemoryRouter>)
    expect((await screen.findAllByText('PersonalHub')).length).toBeGreaterThanOrEqual(2)
    expect(await screen.findByText('实现同步')).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
  })
})
