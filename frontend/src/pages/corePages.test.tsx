import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import type { AgendaItem } from '../types'
import { HomePage } from './HomePage'
import { TodayPage } from './TodayPage'
import { DevelopmentPage } from './DevelopmentPage'

const agenda: AgendaItem[] = [{
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

  it('puts only learning and diet overviews and plans inside the home agenda card', async () => {
    const retainedAgenda = [
      { ...agenda[0], id: 'learn-1', title: '练习函数', module: 'learning', source_type: 'learning_task', source_id: 'task-1' },
      { ...agenda[0], id: 'meal-1', title: '午餐：鸡胸肉沙拉', module: 'diet', source_type: 'meal_plan', source_id: 'meal-1' },
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({
      date: '2026-09-30',
      stats: { total: 2, completed: 0, completion_rate: 0, must: 2, overdue: 0, due_soon: 0 },
      agenda: retainedAgenda,
      quick_notes: [{ id: 'n1', content: '记录灵感', is_important: false, is_archived: false, converted_type: null, converted_id: null, created_at: '2026-09-30T00:00:00Z' }],
      summaries: {
        media: { title: '待发布 1 条', count: 1 }, development: { title: '1 个项目', count: 0 },
        consulting: { title: '待跟进 1 条', count: 1 }, learning: { title: '当前目标：物理、安卓', count: 2, detail: '今日暂无学习任务' },
        diet: { title: '下一餐午餐', count: 1 },
      },
    }))
    render(<MemoryRouter><HomePage /></MemoryRouter>)
    const agendaCard = (await screen.findByText('今日计划')).closest('.ant-card')
    expect(agendaCard).not.toBeNull()
    const agendaArea = within(agendaCard as HTMLElement)
    for (const title of ['练习函数', '午餐：鸡胸肉沙拉']) {
      expect(agendaArea.getByText(title)).toBeInTheDocument()
    }
    expect(screen.getByText('记录灵感')).toBeInTheDocument()
    for (const label of ['学习计划', '饮食计划']) {
      expect(agendaArea.getAllByText(label).length).toBeGreaterThan(0)
    }
    for (const summary of ['当前目标：物理、安卓', '今日暂无学习任务', '下一餐午餐']) {
      expect(agendaArea.getByText(summary)).toBeInTheDocument()
    }
    expect(screen.queryByText('模块摘要')).not.toBeInTheDocument()
    expect(screen.queryByText('逾期事项')).not.toBeInTheDocument()
    expect(screen.queryByText('游戏娱乐')).not.toBeInTheDocument()
    expect(screen.queryByText('游戏：休闲游戏')).not.toBeInTheDocument()
  })

  it('toggles a completed item back to pending from the home overview', async () => {
    const user = userEvent.setup()
    let current = { ...agenda[0], module: 'learning', source_type: 'learning_task', source_id: 'task-1' }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/agenda/a1/complete') && init?.method === 'POST') {
        current = { ...current, status: 'completed', completed_at: '2026-10-21T01:00:00Z' }
        return json(current)
      }
      if (url.endsWith('/agenda/a1/reopen') && init?.method === 'POST') {
        current = { ...current, status: 'pending', completed_at: null }
        return json(current)
      }
      return json({
        date: '2026-10-21',
        stats: { total: 1, completed: current.status === 'completed' ? 1 : 0, completion_rate: current.status === 'completed' ? 100 : 0, must: current.status === 'pending' ? 1 : 0, overdue: 0, due_soon: 0 },
        agenda: [current], quick_notes: [],
        summaries: {
          media: { title: '暂无内容', count: 0 }, development: { title: '暂无项目', count: 0 },
          consulting: { title: '暂无咨询', count: 0 }, learning: { title: '当前目标：测试', count: 1 },
          diet: { title: '暂无饮食安排', count: 0 },
        },
      })
    })
    render(<MemoryRouter><HomePage /></MemoryRouter>)

    await user.click(await screen.findByLabelText('完成 完成核心闭环'))
    await user.click(await screen.findByLabelText('恢复未完成 完成核心闭环'))
    expect(await screen.findByLabelText('完成 完成核心闭环')).not.toBeChecked()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agenda/a1/complete', expect.objectContaining({ method: 'POST' }))
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agenda/a1/reopen', expect.objectContaining({ method: 'POST' }))
  }, 30000)

  it('edits and deletes a quick note from the home overview', async () => {
    const user = userEvent.setup()
    let quickNotes = [{ id: 'n1', content: '写eda作业', is_important: false, is_archived: false, converted_type: null, converted_id: null, created_at: '2026-09-30T00:00:00Z' }]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/quick-notes/n1') && init?.method === 'PATCH') {
        quickNotes = [{ ...quickNotes[0], ...JSON.parse(String(init.body)) }]
        return json(quickNotes[0])
      }
      if (url.endsWith('/quick-notes/n1') && init?.method === 'DELETE') {
        const deleted = quickNotes[0]
        quickNotes = []
        return json(deleted)
      }
      return json({
        date: '2026-09-30',
        stats: { total: 0, completed: 0, completion_rate: 0, must: 0, overdue: 0, due_soon: 0 },
        agenda: [], quick_notes: quickNotes,
        summaries: {
          media: { title: '暂无内容', count: 0 }, development: { title: '暂无项目', count: 0 },
          consulting: { title: '暂无咨询', count: 0 }, learning: { title: '暂无学习目标', count: 0 },
          diet: { title: '暂无饮食安排', count: 0 },
        },
      })
    })
    render(<MemoryRouter><HomePage /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: '修改备忘：写eda作业' }))
    const input = screen.getByLabelText('编辑备忘内容')
    await user.clear(input)
    await user.type(input, '完成 EDA 作业')
    await user.click(screen.getByRole('button', { name: '保存备忘修改' }))
    expect(await screen.findByText('完成 EDA 作业')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/quick-notes/n1', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ content: '完成 EDA 作业' }),
    }))

    await user.click(screen.getByRole('button', { name: '删除备忘：完成 EDA 作业' }))
    await user.click(await screen.findByRole('button', { name: '确认删除备忘：完成 EDA 作业' }))
    await waitFor(() => expect(screen.queryByText('完成 EDA 作业')).not.toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/quick-notes/n1', expect.objectContaining({ method: 'DELETE' }))
  }, 30000)

  it('toggles completion in both directions from the today page', async () => {
    const user = userEvent.setup()
    let current = { ...agenda[0] }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/agenda/a1/complete') && init?.method === 'POST') {
        current = { ...current, status: 'completed', completed_at: '2026-10-21T01:00:00Z' }
        return json(current)
      }
      if (url.endsWith('/agenda/a1/reopen') && init?.method === 'POST') {
        current = { ...current, status: 'pending', completed_at: null }
        return json(current)
      }
      return json([current])
    })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByLabelText('完成 完成核心闭环'))
    await user.click(await screen.findByLabelText('恢复未完成 完成核心闭环'))
    expect(await screen.findByLabelText('完成 完成核心闭环')).not.toBeChecked()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agenda/a1/complete', expect.objectContaining({ method: 'POST', headers: expect.any(Headers) }))
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agenda/a1/reopen', expect.objectContaining({ method: 'POST', headers: expect.any(Headers) }))
  }, 30000)

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
