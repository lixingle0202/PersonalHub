import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { LearningPage } from './LearningPage'

type Task = { id: string; title: string; details?: string; estimated_minutes?: number; section_id?: string | null; agenda_id?: string | null; plan_date: string | null; status: string | null }
type Goal = {
  id: string; name: string; goal: string; start_date: string | null; target_date: string | null
  estimated_minutes: number; progress: number; progress_is_manual: boolean
  sections: Array<{ id: string; name: string; is_completed: boolean }>
  tasks: Task[]; sessions: never[]; resources: never[]
}
type Write = { method: string; path: string; body: Record<string, unknown> }

function goal(id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    id, name: id === 'g1' ? 'Python 入门' : '英语阅读', goal: id === 'g1' ? '完成一个小项目' : '每天读一篇文章',
    start_date: '2026-10-08', target_date: '2026-10-31', estimated_minutes: 600,
    progress: 20, progress_is_manual: false, sections: [{ id: `${id}-s1`, name: '基础阶段', is_completed: false }],
    tasks: [
      { id: `${id}-t1`, title: '练习基础语法', plan_date: '2026-10-10', status: 'pending' },
      { id: `${id}-t2`, title: '阅读示例项目', plan_date: '2026-10-11', status: 'pending' },
    ], sessions: [], resources: [], ...overrides,
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function mockLearning(options: {
  goals?: Goal[]; failures?: Record<string, number>; holdDelete?: string; holdDetail?: string
} = {}) {
  let goals = structuredClone(options.goals ?? [goal('g1'), goal('g2')])
  const failures = { ...options.failures }
  const writes: Write[] = []
  let releaseDelete: (() => void) | undefined
  let releaseDetail: (() => void) | undefined
  let heldDetail = false
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    const method = (init?.method ?? 'GET').toUpperCase()
    const values = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    if (method !== 'GET') writes.push({ method, path, body: values })
    if (failures[`${method} ${path}`]) {
      failures[`${method} ${path}`]--
      return json({ detail: '暂时无法保存，请重试' }, 503)
    }
    if (method === 'GET' && path === '/learning/goals') return json(goals.map(({ tasks: _tasks, sections: _sections, sessions: _sessions, resources: _resources, ...summary }) => summary))
    const goalId = path.match(/^\/learning\/goals\/([^/]+)$/)?.[1]
    if (goalId) {
      const item = goals.find((entry) => entry.id === goalId)
      if (!item) return json({ detail: '目标不存在' }, 404)
      if (method === 'GET') {
        const response = json(item)
        if (options.holdDetail === goalId && !heldDetail) {
          heldDetail = true
          return new Promise<Response>((resolve) => { releaseDetail = () => resolve(response) })
        }
        return response
      }
      if (method === 'PATCH') {
        Object.assign(item, values)
        return json(item)
      }
      if (method === 'DELETE') {
        const remove = () => {
          goals = goals.filter((entry) => entry.id !== goalId)
          return json({ ...item, status: 'cancelled' })
        }
        if (options.holdDelete === path) return new Promise<Response>((resolve) => { releaseDelete = () => resolve(remove()) })
        return remove()
      }
    }
    const taskId = path.match(/^\/learning\/tasks\/([^/]+)$/)?.[1]
    if (taskId) {
      const owner = goals.find((entry) => entry.tasks.some((task) => task.id === taskId))
      const item = owner?.tasks.find((task) => task.id === taskId)
      if (!owner || !item) return json({ detail: '任务不存在' }, 404)
      if (method === 'PATCH') {
        Object.assign(item, values)
        if ('plan_date' in values) item.status = item.plan_date ? 'pending' : null
        return json(item)
      }
      if (method === 'DELETE') {
        const remove = () => {
          owner.tasks = owner.tasks.filter((task) => task.id !== taskId)
          return json({ ...item, status: 'cancelled' })
        }
        if (options.holdDelete === path) return new Promise<Response>((resolve) => { releaseDelete = () => resolve(remove()) })
        return remove()
      }
    }
    const sectionId = path.match(/^\/learning\/sections\/([^/]+)$/)?.[1]
    if (sectionId) {
      const owner = goals.find((entry) => entry.sections.some((section) => section.id === sectionId))
      const section = owner?.sections.find((entry) => entry.id === sectionId)
      if (!owner || !section) return json({ detail: '章节不存在' }, 404)
      if (method === 'PATCH') { Object.assign(section, values); return json(section) }
      if (method === 'DELETE') {
        owner.sections = owner.sections.filter((entry) => entry.id !== sectionId)
        return json(section)
      }
    }
    const taskGoalId = path.match(/^\/learning\/goals\/([^/]+)\/tasks$/)?.[1]
    if (taskGoalId && method === 'POST') {
      const owner = goals.find((entry) => entry.id === taskGoalId)
      if (!owner) return json({ detail: '目标不存在' }, 404)
      const task: Task = {
        id: `${taskGoalId}-added-${owner.tasks.length + 1}`,
        title: String(values.title), details: String(values.details ?? ''),
        plan_date: String(values.plan_date ?? ''), status: 'pending',
        section_id: values.section_id ? String(values.section_id) : null,
        estimated_minutes: values.estimated_minutes ? Number(values.estimated_minutes) : undefined,
      }
      owner.tasks.push(task)
      return json(task, 201)
    }
    const agendaId = path.match(/^\/agenda\/([^/]+)\/(complete|reschedule)$/)?.[1]
    if (agendaId && method === 'POST') {
      const task = goals.flatMap((entry) => entry.tasks).find((entry) => entry.agenda_id === agendaId)
      if (!task) return json({ detail: '今日计划不存在' }, 404)
      task.status = path.endsWith('/complete') ? 'completed' : 'pending'
      return json({ id: agendaId, status: task.status })
    }
    return json({ detail: `未预期的请求 ${method} ${path}` }, 404)
  })
  return {
    fetchMock, writes,
    releaseDelete: () => { expect(releaseDelete).toBeDefined(); releaseDelete!() },
    releaseDetail: () => { expect(releaseDetail).toBeDefined(); releaseDetail!() },
  }
}

async function editor(title: string) {
  const element = (await screen.findByText(title, { exact: true, selector: '.ant-modal-title' })).closest<HTMLElement>('[role="dialog"]')
  expect(element).not.toBeNull()
  await waitFor(() => expect(element).toBeVisible())
  return within(element!)
}

async function openGoal(name = 'Python 入门') {
  fireEvent.click(await screen.findByLabelText(`编辑学习目标 ${name}`))
  return editor('编辑学习目标')
}

async function openTask(title = '练习基础语法') {
  fireEvent.click(await screen.findByRole('tab', { name: '学习计划' }))
  fireEvent.click(await screen.findByLabelText(`编辑学习任务 ${title}`))
  return editor('编辑学习任务')
}

function renderLearning() {
  render(<MemoryRouter><LearningPage /></MemoryRouter>)
}

function changeDate(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
  fireEvent.blur(input)
}

describe('individual learning plan and task changes', () => {
  beforeEach(() => { vi.restoreAllMocks(); setLocalToken('learning-test-token') })

  it('shows imported task instructions and keeps them editable', async () => {
    const { writes } = mockLearning({ goals: [goal('g1', { tasks: [{ id: 'g1-t1', title: '变量和数据类型', details: '学习 Python 基础语法、变量和运算符', estimated_minutes: 45, plan_date: '2026-10-10', status: 'pending' }] })] })
    renderLearning()
    fireEvent.click(await screen.findByRole('tab', { name: '学习计划' }))
    expect(await screen.findByText('学习 Python 基础语法、变量和运算符')).toBeInTheDocument()
    expect(screen.getByText(/预计 45 分钟/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('编辑学习任务 变量和数据类型'))
    const dialog = await editor('编辑学习任务')
    fireEvent.change(dialog.getByLabelText('任务详情'), { target: { value: '完成 3 个变量练习' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(writes.some((write) => write.path === '/learning/tasks/g1-t1' && write.body.details === '完成 3 个变量练习')).toBe(true))
    expect(await screen.findByText('完成 3 个变量练习')).toBeInTheDocument()
  })

  it('shows daily tasks with their full instructions and toggles completion both ways', async () => {
    const api = mockLearning({ goals: [goal('g1', { tasks: [{ id: 'g1-t1', title: '变量练习', details: '先读变量说明\n再写三个例子', estimated_minutes: 45, section_id: 'g1-s1', agenda_id: 'agenda-1', plan_date: '2026-10-10', status: 'pending' }] })] })
    renderLearning()
    expect(await screen.findByRole('tab', { name: '学习计划' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '学习路线' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '学习任务' })).not.toBeInTheDocument()
    expect(await screen.findByText(/先读变量说明/)).toHaveTextContent('再写三个例子')
    expect(screen.getByText(/预计 45 分钟/)).toBeInTheDocument()
    const checkbox = screen.getByRole('checkbox', { name: '完成学习任务 变量练习' })
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox).toBeChecked())
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox).not.toBeChecked())
    expect(api.writes.filter((entry) => entry.path.startsWith('/agenda/'))).toEqual([
      { method: 'POST', path: '/agenda/agenda-1/complete', body: {} },
      { method: 'POST', path: '/agenda/agenda-1/reschedule', body: { plan_date: '2026-10-10' } },
    ])
    fireEvent.click(screen.getByLabelText('编辑学习任务 变量练习'))
    const dialog = await editor('编辑学习任务')
    fireEvent.change(dialog.getByLabelText('任务详情'), { target: { value: '完成五道练习' } })
    fireEvent.change(dialog.getByLabelText('预计分钟'), { target: { value: '60' } })
    fireEvent.click(dialog.getByLabelText('保存修改'))
    await waitFor(() => expect(api.writes.some((entry) => entry.path === '/learning/tasks/g1-t1' && entry.body.details === '完成五道练习' && entry.body.estimated_minutes === 60)).toBe(true))
    expect(await screen.findByText('完成五道练习')).toBeInTheDocument()
  }, 70000)

  it('merges a linked stage into its daily task and lets it be edited there', async () => {
    mockLearning({ goals: [goal('g1', { tasks: [{ id: 'g1-t1', title: '语法训练', section_id: 'g1-s1', plan_date: '2026-10-10', status: 'pending' }] })] })
    renderLearning()
    const task = (await screen.findByLabelText('编辑学习任务 语法训练')).closest('.learning-task')!
    expect(screen.queryByRole('heading', { name: '学习阶段' })).not.toBeInTheDocument()
    expect(within(task as HTMLElement).getByLabelText('修改学习章节 基础阶段')).toBeInTheDocument()
    fireEvent.click(within(task as HTMLElement).getByLabelText('修改学习章节 基础阶段'))
    expect((await editor('编辑学习章节')).getByLabelText('章节名称')).toHaveValue('基础阶段')
  })

  it('keeps an emptied date and adds multiple tasks from the plus beside that date', async () => {
    const api = mockLearning({ goals: [goal('g1', {
      start_date: '2026-10-13', target_date: '2026-10-15',
      tasks: [
        { id: 'g1-t13', title: '十三日任务', plan_date: '2026-10-13', status: 'pending' },
        { id: 'g1-t14', title: '十四日任务', plan_date: '2026-10-14', status: 'pending' },
        { id: 'g1-t15', title: '十五日任务', plan_date: '2026-10-15', status: 'pending' },
      ],
    })] })
    renderLearning()
    fireEvent.click(await screen.findByLabelText('编辑学习任务 十四日任务'))
    fireEvent.click((await editor('编辑学习任务')).getByLabelText('删除此任务'))
    fireEvent.click((await editor('确认删除此学习任务？')).getByLabelText('确认删除'))
    await waitFor(() => expect(screen.queryByLabelText('编辑学习任务 十四日任务')).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: '2026-10-14' })).toBeInTheDocument()
    expect(screen.getByText('当天暂无任务，点击日期旁的 ＋ 添加。')).toBeInTheDocument()

    for (const title of ['重新安排十四日', '追加十四日练习']) {
      fireEvent.click(screen.getByLabelText('添加 2026-10-14 学习任务'))
      const form = await editor('安排学习任务')
      expect(form.getByLabelText('计划日期')).toHaveValue('2026-10-14')
      fireEvent.change(form.getByLabelText('学习任务'), { target: { value: title } })
      fireEvent.click(form.getByLabelText('创建'))
      expect(await screen.findByLabelText(`编辑学习任务 ${title}`)).toBeInTheDocument()
    }
    expect(api.writes.filter((entry) => entry.method === 'POST' && entry.path === '/learning/goals/g1/tasks')).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ title: '重新安排十四日', plan_date: '2026-10-14' }) }),
      expect.objectContaining({ body: expect.objectContaining({ title: '追加十四日练习', plan_date: '2026-10-14' }) }),
    ])
  }, 70000)

  it('edits and deletes an imported chapter while keeping its daily task available', async () => {
    const { writes } = mockLearning({ goals: [goal('g1')] })
    renderLearning()
    fireEvent.click(await screen.findByLabelText('修改学习章节 基础阶段'))
    const firstEditor = await editor('编辑学习章节')
    fireEvent.change(firstEditor.getByLabelText('章节名称'), { target: { value: '基础训练' } })
    fireEvent.click(firstEditor.getByLabelText('保存修改'))
    expect(await screen.findByLabelText('修改学习章节 基础训练')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('修改学习章节 基础训练'))
    fireEvent.click((await editor('编辑学习章节')).getByLabelText('删除此章节'))
    fireEvent.click((await editor('确认删除此学习章节？')).getByLabelText('确认删除'))
    await waitFor(() => expect(screen.queryByLabelText('修改学习章节 基础训练')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: '学习计划' }))
    expect(screen.getByLabelText('编辑学习任务 练习基础语法')).toBeInTheDocument()
    expect(writes.some((entry) => entry.method === 'DELETE' && entry.path === '/learning/sections/g1-s1')).toBe(true)
  }, 60000)

  it('saves every editable goal field to the goal that was opened', async () => {
    const api = mockLearning()
    renderLearning()
    const area = await openGoal('英语阅读')
    expect(area.getByLabelText('学习主题')).toHaveValue('英语阅读')
    expect(area.getByLabelText('学习目标')).toHaveValue('每天读一篇文章')
    fireEvent.change(area.getByLabelText('学习主题'), { target: { value: '英语精读' } })
    fireEvent.change(area.getByLabelText('学习目标'), { target: { value: '独立读完一本英文书' } })
    changeDate(area.getByLabelText('开始日期'), '2026-10-12')
    changeDate(area.getByLabelText('计划完成'), '2026-11-20')
    fireEvent.change(area.getByLabelText('预计投入分钟'), { target: { value: '1200' } })
    await act(async () => fireEvent.click(area.getByLabelText('保存修改')))

    await waitFor(() => expect(api.writes).toContainEqual({
      method: 'PATCH', path: '/learning/goals/g2', body: expect.objectContaining({
        name: '英语精读', goal: '独立读完一本英文书', start_date: '2026-10-12', target_date: '2026-11-20', estimated_minutes: 1200,
      }),
    }))
    expect(await screen.findByLabelText('编辑学习目标 英语精读')).toBeInTheDocument()
    expect(screen.getByLabelText('编辑学习目标 Python 入门')).toBeInTheDocument()
    expect(screen.getByText('独立读完一本英文书')).toBeInTheDocument()
    expect(api.writes.some((write) => write.path === '/learning/goals/g1')).toBe(false)
  })

  it('cancels goal deletion without losing the draft or sending a delete request', async () => {
    const api = mockLearning()
    renderLearning()
    const area = await openGoal()
    fireEvent.change(area.getByLabelText('学习主题'), { target: { value: '还没保存的 Python 计划' } })
    fireEvent.click(area.getByLabelText('删除此计划'))
    expect(api.writes).toHaveLength(0)
    fireEvent.click((await editor('确认删除此学习计划？')).getByLabelText('取消删除'))

    expect(area.getByLabelText('学习主题')).toHaveValue('还没保存的 Python 计划')
    expect(area.getByLabelText('学习主题')).toBeVisible()
    expect(area.getByLabelText('保存修改')).toBeEnabled()
    expect(screen.getByLabelText('编辑学习目标 Python 入门')).toBeInTheDocument()
    expect(api.writes).toHaveLength(0)
  })

  it('retains a failed goal deletion for retry, then selects the remaining goal', async () => {
    const api = mockLearning({ failures: { 'DELETE /learning/goals/g1': 1 } })
    renderLearning()
    const area = await openGoal()
    fireEvent.change(area.getByLabelText('学习目标'), { target: { value: '删除失败也保留的草稿' } })
    fireEvent.click(area.getByLabelText('删除此计划'))
    const confirmation = await editor('确认删除此学习计划？')
    await act(async () => fireEvent.click(confirmation.getByLabelText('确认删除')))
    expect(await screen.findByText('暂时无法保存，请重试')).toBeInTheDocument()
    expect(area.getByLabelText('学习目标')).toHaveValue('删除失败也保留的草稿')
    expect(area.getByLabelText('学习目标')).toBeVisible()
    expect(screen.getByLabelText('编辑学习目标 Python 入门')).toBeInTheDocument()

    await act(async () => fireEvent.click(confirmation.getByLabelText('确认删除')))
    await waitFor(() => expect(screen.queryByLabelText('编辑学习目标 Python 入门')).not.toBeInTheDocument())
    expect(screen.getByLabelText('编辑学习目标 英语阅读')).toHaveClass('selected')
    expect(await screen.findByText('每天读一篇文章', { selector: 'div.ant-typography' })).toBeInTheDocument()
    expect(api.writes.filter((write) => write.method === 'DELETE')).toHaveLength(2)
    expect(api.writes.every((write) => write.path === '/learning/goals/g1')).toBe(true)
  })

  it('shows the empty state after deleting the final goal', async () => {
    const api = mockLearning({ goals: [goal('g1')] })
    renderLearning()
    const area = await openGoal()
    fireEvent.click(area.getByLabelText('删除此计划'))
    const confirmation = await editor('确认删除此学习计划？')
    await act(async () => fireEvent.click(confirmation.getByLabelText('确认删除')))

    expect(await screen.findByText('选择或创建学习目标')).toBeInTheDocument()
    expect(screen.queryByLabelText('编辑学习目标 Python 入门')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('学习进度')).not.toBeInTheDocument()
    expect(api.writes).toEqual([{ method: 'DELETE', path: '/learning/goals/g1', body: {} }])
  })

  it.each([
    { kind: 'goal', path: '/learning/goals/g1', title: '确认删除此学习计划？', remove: '删除此计划' },
    { kind: 'task', path: '/learning/tasks/g1-t1', title: '确认删除此学习任务？', remove: '删除此任务' },
  ])('blocks repeated deletion, saving and closing while a $kind deletion is pending', async ({ kind, path, title, remove }) => {
    const api = mockLearning({ holdDelete: path })
    renderLearning()
    const area = kind === 'goal' ? await openGoal() : await openTask()
    fireEvent.click(area.getByLabelText(remove))
    const confirmation = await editor(title)
    const confirmButton = confirmation.getByLabelText('确认删除')
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)
    await waitFor(() => expect(api.writes.filter((write) => write.method === 'DELETE')).toHaveLength(1))
    expect(confirmButton).toBeDisabled()
    expect(confirmation.getByLabelText('取消删除')).toBeDisabled()
    expect(area.getByLabelText('保存修改')).toBeDisabled()
    expect(area.getByLabelText('取消')).toBeDisabled()
    fireEvent.click(confirmation.getByLabelText('取消删除'))
    fireEvent.keyDown(confirmButton.closest('[role="dialog"]')!, { key: 'Escape', code: 'Escape', keyCode: 27 })
    fireEvent.click(confirmButton.closest('.ant-modal-wrap')!)
    expect(confirmButton).toBeVisible()
    expect(area.getByLabelText(remove)).toBeVisible()

    await act(async () => api.releaseDelete())
    await waitFor(() => expect(screen.queryByLabelText(kind === 'goal' ? '编辑学习目标 Python 入门' : '编辑学习任务 练习基础语法')).not.toBeInTheDocument())
    expect(api.writes.filter((write) => write.method === 'DELETE')).toEqual([{ method: 'DELETE', path, body: {} }])
  })

  it('edits task title and date, then clears its date explicitly without changing another task', async () => {
    const api = mockLearning({ goals: [goal('g1')] })
    renderLearning()
    let area = await openTask()
    expect(area.getByLabelText('学习任务')).toHaveValue('练习基础语法')
    expect(area.getByLabelText('计划日期')).toHaveValue('2026-10-10')
    fireEvent.change(area.getByLabelText('学习任务'), { target: { value: '编写一个命令行程序' } })
    changeDate(area.getByLabelText('计划日期'), '2026-11-05')
    await act(async () => fireEvent.click(area.getByLabelText('保存修改')))
    expect(await screen.findByLabelText('编辑学习任务 编写一个命令行程序')).toBeInTheDocument()

    area = await openTask('编写一个命令行程序')
    expect(area.getByLabelText('计划日期')).toHaveValue('2026-11-05')
    fireEvent.click(within(area.getByLabelText('计划日期').closest<HTMLElement>('.ant-picker')!).getByLabelText(/clear|清除/i))
    await act(async () => fireEvent.click(area.getByLabelText('保存修改')))

    await waitFor(() => expect(api.writes.filter((write) => write.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/learning/tasks/g1-t1', body: expect.objectContaining({ title: '编写一个命令行程序', plan_date: '2026-11-05' }) },
      { method: 'PATCH', path: '/learning/tasks/g1-t1', body: expect.objectContaining({ title: '编写一个命令行程序', plan_date: null }) },
    ]))
    expect(screen.getByLabelText('编辑学习任务 阅读示例项目')).toBeInTheDocument()
    expect(screen.getByLabelText('编辑学习目标 Python 入门')).toBeInTheDocument()
    area = await openTask('编写一个命令行程序')
    expect(area.getByLabelText('计划日期')).toHaveValue('')
  })

  it('cancels task deletion while keeping the edited title and date', async () => {
    const api = mockLearning()
    renderLearning()
    const area = await openTask()
    fireEvent.change(area.getByLabelText('学习任务'), { target: { value: '尚未保存的任务标题' } })
    changeDate(area.getByLabelText('计划日期'), '2026-11-01')
    fireEvent.click(area.getByLabelText('删除此任务'))
    expect(api.writes).toHaveLength(0)
    fireEvent.click((await editor('确认删除此学习任务？')).getByLabelText('取消删除'))

    expect(area.getByLabelText('学习任务')).toHaveValue('尚未保存的任务标题')
    expect(area.getByLabelText('学习任务')).toBeVisible()
    expect(area.getByLabelText('计划日期')).toHaveValue('2026-11-01')
    expect(area.getByLabelText('保存修改')).toBeEnabled()
    expect(api.writes).toHaveLength(0)
  })

  it('keeps a failed task deletion editable and removes only that task after retry', async () => {
    const api = mockLearning({ goals: [goal('g1')], failures: { 'DELETE /learning/tasks/g1-t1': 1 } })
    renderLearning()
    const area = await openTask()
    fireEvent.change(area.getByLabelText('学习任务'), { target: { value: '失败后保留的任务' } })
    fireEvent.click(area.getByLabelText('删除此任务'))
    const confirmation = await editor('确认删除此学习任务？')
    await act(async () => fireEvent.click(confirmation.getByLabelText('确认删除')))
    expect(await screen.findByText('暂时无法保存，请重试')).toBeInTheDocument()
    expect(area.getByLabelText('学习任务')).toHaveValue('失败后保留的任务')
    expect(area.getByLabelText('学习任务')).toBeVisible()
    expect(screen.getByLabelText('编辑学习任务 练习基础语法')).toBeInTheDocument()

    await act(async () => fireEvent.click(confirmation.getByLabelText('确认删除')))
    await waitFor(() => expect(screen.queryByLabelText('编辑学习任务 练习基础语法')).not.toBeInTheDocument())
    expect(screen.getByLabelText('编辑学习任务 阅读示例项目')).toBeInTheDocument()
    expect(screen.getByLabelText('编辑学习目标 Python 入门')).toHaveClass('selected')
    expect(screen.getByText('完成一个小项目')).toBeInTheDocument()
    expect(api.writes.filter((write) => write.method === 'DELETE')).toEqual([
      { method: 'DELETE', path: '/learning/tasks/g1-t1', body: {} },
      { method: 'DELETE', path: '/learning/tasks/g1-t1', body: {} },
    ])
  })

  it('ignores an older goal detail response while saving the newly opened goal', async () => {
    const api = mockLearning({ holdDetail: 'g1' })
    renderLearning()
    await waitFor(() => expect(api.fetchMock.mock.calls.some(([input]) => String(input).endsWith('/learning/goals/g1'))).toBe(true))
    const area = await openGoal('英语阅读')
    expect(await screen.findByText('每天读一篇文章', { selector: 'div.ant-typography' })).toBeInTheDocument()
    fireEvent.change(area.getByLabelText('学习主题'), { target: { value: '英语进阶' } })
    await act(async () => api.releaseDetail())
    expect(screen.queryByText('完成一个小项目')).not.toBeInTheDocument()
    expect(area.getByLabelText('学习主题')).toHaveValue('英语进阶')
    await act(async () => fireEvent.click(area.getByLabelText('保存修改')))

    expect(await screen.findByLabelText('编辑学习目标 英语进阶')).toHaveClass('selected')
    expect(screen.getByText('每天读一篇文章')).toBeInTheDocument()
    expect(api.writes.filter((write) => write.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/learning/goals/g2', body: expect.objectContaining({ name: '英语进阶' }) },
    ])
  })
})
