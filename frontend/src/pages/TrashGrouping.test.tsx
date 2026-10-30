import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import type { TrashItem } from '../components/TrashPanel'
import { SettingsPage } from './SettingsPage'

const deleted = '2026-10-01T08:00:00Z'
const task: TrashItem = { type: 'learning_task', id: 't1', module: 'learning', label: '学习任务', title: '精读英语文章', details: '标注生词并写三句摘要', plan_date: '2026-10-01', status: 'completed', deleted_at: deleted }
const secondTask: TrashItem = { ...task, id: 't2', title: '订正阅读练习', details: '整理错误原因', status: 'pending' }
const plan: TrashItem = { type: 'learning_goal', id: 'g1', module: 'learning', label: '学习计划', title: '英语阅读计划', deleted_at: deleted, parent_deleted: true, children: [task, secondTask] }
const list: TrashItem = {
  type: 'shopping_list', id: 's1', module: 'diet', label: '购物清单', title: '本月采购', deleted_at: deleted, parent_deleted: true,
  children: [{ type: 'shopping_item', id: 'egg', module: 'diet', label: '购物项', title: '鸡蛋', details: '10个', status: 'completed', deleted_at: deleted }, { type: 'shopping_item', id: 'tomato', module: 'diet', label: '购物项', title: '番茄', details: '2斤', deleted_at: deleted }],
}

function mockTrash(initial: TrashItem[], failCategory = false) {
  let rows = structuredClone(initial)
  let fail = failCategory
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    let body: unknown = {}
    let status = 200
    if (url.endsWith('/settings')) body = { nickname: '', theme_mode: 'light', theme_color: '#5b6cff', week_starts_on: 1, default_work_start: '09:00', default_work_end: '18:00', default_study_minutes: 60, custom_categories: {} }
    else if (url.endsWith('/bootstrap')) body = { local_token: 'test-token', database_path: '独立个人空间' }
    else if (url.endsWith('/backups')) body = []
    else if (url.endsWith('/trash')) body = rows
    else if (url.includes('/trash/categories/') && init?.method === 'POST') {
      if (fail) { status = 503; body = { detail: '恢复暂时失败，请重试' } }
      else rows = rows.filter((row) => row.module !== url.split('/').at(-2))
    } else if (url.includes('/trash/') && init?.method === 'POST') {
      const id = url.split('/').at(-2)
      rows = rows.filter((row) => row.id !== id).map((row) => ({
        ...row, parent_deleted: row.children?.some((child) => child.id === id) ? false : row.parent_deleted,
        children: row.children?.filter((child) => child.id !== id),
      }))
    } else if (url.includes('/trash/') && init?.method === 'DELETE') {
      const id = url.split('/').at(-1)
      rows = rows.filter((row) => row.id !== id).map((row) => ({ ...row, children: row.children?.filter((child) => child.id !== id) }))
    } else status = 404
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  })
  return { fetch, retry: () => { fail = false } }
}

function renderSettings() {
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>)
}

async function openLearningPlan() {
  fireEvent.click(await screen.findByRole('button', { name: '查看学习回收站' }))
  fireEvent.click(within(await screen.findByRole('article', { name: plan.title })).getByRole('button', { name: '查看内容' }))
  return screen.getByRole('dialog')
}

describe('grouped recycle bin', () => {
  beforeEach(() => { vi.restoreAllMocks(); setLocalToken('test-token'); configure({ asyncUtilTimeout: 10000 }) })

  it('starts with categories, then plans, then detailed entries', async () => {
    mockTrash([plan, list])
    renderSettings()
    expect(await screen.findByRole('button', { name: '查看学习回收站' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看饮食回收站' })).toBeInTheDocument()
    expect(screen.queryByText(plan.title)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看学习回收站' }))
    expect(await screen.findByText(plan.title)).toBeInTheDocument()
    expect(screen.queryByText(task.title)).not.toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('article', { name: plan.title })).getByRole('button', { name: '查看内容' }))
    expect(await screen.findByText(task.details!)).toBeInTheDocument()
    expect(screen.getByText('2026-10-01 · 已完成')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '恢复整个计划' })).toBeEnabled()
  }, 60000)

  it('restores one task and keeps the remaining plan available across reloads', async () => {
    const { fetch } = mockTrash([plan, list])
    const view = renderSettings()
    await openLearningPlan()
    fireEvent.click(within(screen.getByRole('article', { name: task.title })).getByRole('button', { name: '恢复此项' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: task.title })).not.toBeInTheDocument(), { timeout: 10000 })
    expect(screen.getByRole('article', { name: secondTask.title })).toBeInTheDocument()
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/trash/learning_task/t1/restore') && init?.method === 'POST')).toBe(true)
    view.unmount()
    renderSettings()
    await openLearningPlan()
    expect(screen.queryByRole('article', { name: task.title })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回学习大类' }))
    expect(screen.queryByRole('button', { name: '永久删除计划' })).not.toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('article', { name: plan.title })).getByRole('button', { name: '恢复整个计划' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 10000 })
    expect(await screen.findByRole('button', { name: '查看饮食回收站' })).toBeInTheDocument()
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/trash/learning_goal/g1/restore') && init?.method === 'POST')).toBe(true)
  }, 60000)

  it('restores a category in one request without restoring another category', async () => {
    const { fetch } = mockTrash([plan, { ...plan, id: 'g2', title: '另一计划' }, list])
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '恢复学习全部内容' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '查看学习回收站' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '查看饮食回收站' })).toBeInTheDocument()
    expect(fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/trash/categories/learning/restore') && init?.method === 'POST')).toHaveLength(1)
  }, 60000)

  it('keeps category contents on failure and allows retrying', async () => {
    const api = mockTrash([plan, list], true)
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '恢复饮食全部内容' }))
    expect(await screen.findByText('恢复暂时失败，请重试')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看饮食回收站' })).toBeInTheDocument()
    api.retry()
    fireEvent.click(screen.getByRole('button', { name: '恢复饮食全部内容' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '查看饮食回收站' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '查看学习回收站' })).toBeInTheDocument()
  }, 60000)

  it('supports individual and whole shopping-list recovery inside the diet category', async () => {
    const { fetch } = mockTrash([list])
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '查看饮食回收站' }))
    fireEvent.click(within(await screen.findByRole('article', { name: list.title })).getByRole('button', { name: '查看内容' }))
    expect(screen.getByText('10个')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('article', { name: '鸡蛋' })).getByRole('button', { name: '恢复此项' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: '鸡蛋' })).not.toBeInTheDocument(), { timeout: 10000 })
    expect(screen.getByRole('article', { name: '番茄' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复整个清单' }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/trash/shopping_list/s1/restore') && init?.method === 'POST')).toBe(true)
  }, 60000)

  it('keeps empty deleted plans recoverable and hides destructive group deletion after a partial restore', async () => {
    mockTrash([{ ...plan, children: [] }])
    renderSettings()
    await openLearningPlan()
    expect(screen.getByText('没有可单独恢复的内容，可直接恢复整个计划。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复整个计划' }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
  }, 60000)
})
