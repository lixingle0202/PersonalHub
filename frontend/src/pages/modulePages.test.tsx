import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import dayjs from 'dayjs'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { ConsultingPage } from './ConsultingPage'
import { DietPage } from './DietPage'
import { LearningPage } from './LearningPage'
import { MediaPage } from './MediaPage'
import { visibleSearchResults } from '../components/GlobalSearch'

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

describe('domain-specific module pages', () => {
  beforeEach(() => { setLocalToken('test-token'); vi.restoreAllMocks() })

  it('renders the self-media production board instead of a generic task list', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json([{ id: 'm1', title: 'Python 学习路线', platform: '公众号', content_type: '文章', stage: 'creating', outline: '', body: '', reference_links: '', publish_link: '', target_date: '2026-10-01', published_at: null, notes: '' }]))
    render(<MemoryRouter><MediaPage /></MemoryRouter>)
    expect(await screen.findByText('Python 学习路线')).toBeInTheDocument()
    for (const label of ['灵感', '准备中', '创作中', '待发布', '已发布']) expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('renders consulting needs, staged solution, communication and follow-up areas', async () => {
    const summary = { id: 'c1', title: 'Python 学习计划', client_name: '用户A', contact: '', original_question: '想学 Python', stage: 'drafting', background: '', goal: '完成项目', current_state: '', constraints: '', overall_advice: '', resources: '', notes: '', next_followup_date: '2026-10-07' }
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith('/consultations')) return json([summary])
      return json({ ...summary, plan_stages: [{ id: 's1', title: '基础阶段', goal: '掌握语法', steps: '练习', schedule: '四周' }], communications: [], followups: [] })
    })
    render(<MemoryRouter><ConsultingPage /></MemoryRouter>)
    expect((await screen.findAllByText('Python 学习计划')).length).toBeGreaterThan(0)
    expect(await screen.findByText('需求整理')).toBeInTheDocument()
    for (const label of ['分阶段方案', '沟通记录', '跟进']) expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('renders learning route, tasks, sessions and resources with progress', async () => {
    const goal = { id: 'g1', name: '学习 Python', goal: '完成项目', start_date: null, target_date: null, estimated_minutes: 2400, progress: 50, progress_is_manual: false }
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => String(input).endsWith('/goals') ? json([goal]) : json({ ...goal, sections: [{ id: 's1', name: '语法基础', is_completed: true }], tasks: [], sessions: [], resources: [] }))
    render(<MemoryRouter><LearningPage /></MemoryRouter>)
    expect((await screen.findAllByText('学习 Python')).length).toBeGreaterThan(0)
    for (const label of ['学习计划', '学习记录', '笔记与资料']) expect(await screen.findByText(label)).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('50% · 点击修改')).toBeInTheDocument()
  })

  it('edits a selected learning goal', async () => {
    let goal = { id: 'g1', name: '学习 Python', goal: '完成项目', start_date: null, target_date: null, estimated_minutes: 2400, progress: 20, progress_is_manual: false }
    const details = () => ({ ...goal, sections: [], tasks: [], sessions: [], resources: [] })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        goal = { ...goal, ...body, progress_is_manual: 'progress' in body ? true : goal.progress_is_manual }
        return json(details())
      }
      return url.endsWith('/goals') ? json([goal]) : json(details())
    })
    render(<MemoryRouter><LearningPage /></MemoryRouter>)

    fireEvent.click(await screen.findByRole('button', { name: '编辑学习目标 学习 Python' }))
    const name = await screen.findByLabelText('学习主题')
    fireEvent.change(name, { target: { value: 'Python 实战' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => {
      if (!String(input).endsWith('/learning/goals/g1') || init?.method !== 'PATCH') return false
      return JSON.parse(String(init.body)).name === 'Python 实战'
    })).toBe(true))
    expect((await screen.findAllByText('Python 实战')).length).toBeGreaterThanOrEqual(2)
  })

  it('saves manual learning progress from the right panel', async () => {
    let goal = { id: 'g1', name: '学习 Python', goal: '完成项目', start_date: null, target_date: null, estimated_minutes: 2400, progress: 20, progress_is_manual: false }
    const details = () => ({ ...goal, sections: [], tasks: [], sessions: [], resources: [] })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        goal = { ...goal, ...body, progress_is_manual: 'progress' in body ? true : goal.progress_is_manual }
        return json(details())
      }
      return url.endsWith('/goals') ? json([goal]) : json(details())
    })
    render(<MemoryRouter><LearningPage /></MemoryRouter>)

    const progress = await screen.findByLabelText('学习进度')
    fireEvent.change(progress, { target: { value: '65' } })
    fireEvent.click(screen.getByRole('button', { name: '保存进度' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => {
      if (!String(input).endsWith('/learning/goals/g1') || init?.method !== 'PATCH') return false
      return JSON.parse(String(init.body)).progress === 65
    })).toBe(true))
    expect(await screen.findByText('65%')).toBeInTheDocument()
    expect(screen.getByText('65% · 点击修改')).toBeInTheDocument()
    expect(screen.getByText('手动进度')).toBeInTheDocument()
  })

  it('clears all learning plans only after confirmation', async () => {
    const user = userEvent.setup()
    const goal = { id: 'g1', name: '学习 Python', goal: '完成项目', start_date: null, target_date: null, estimated_minutes: 2400, progress: 20, progress_is_manual: false }
    let cleared = false
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/learning/reset') && init?.method === 'POST') {
        cleared = true
        return json({ cancelled_goals: 1, cancelled_tasks: 0, cancelled_agenda: 0 })
      }
      if (url.endsWith('/learning/goals')) return json(cleared ? [] : [goal])
      return json({ ...goal, sections: [], tasks: [], sessions: [], resources: [] })
    })
    render(<MemoryRouter><LearningPage /></MemoryRouter>)
    expect(await screen.findByText('学习 Python')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清零全部学习计划' }))
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/learning/reset'))).toBe(false)
    await user.click(screen.getByRole('button', { name: /确\s*认/ }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/learning/reset') && init?.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.queryByText('学习 Python')).not.toBeInTheDocument())
    expect(screen.getByText('选择或创建学习目标')).toBeInTheDocument()
  })

  it('renders a monthly meal calendar plus dishes, shopping and daily records', async () => {
    const mealDate = dayjs().startOf('week').add(1, 'day').format('YYYY-MM-DD')
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('/dishes')) return json([{ id: 'd1', name: '番茄炒蛋', instructions: '', nutrition_notes: '', notes: '', ingredients: [] }])
      if (url.includes('/meals')) return json([{ id: 'meal1', meal_date: mealDate, meal_type: 'dinner', dish_id: 'd1', custom_name: '', dish_name: '番茄炒蛋', actual_food: '', status: 'pending' }])
      if (url.includes('/health/')) return json({ log_date: '2026-09-30', water_ml: 1500, weight_kg: null, feeling: '' })
      return json([])
    })
    render(<MemoryRouter><DietPage /></MemoryRouter>)
    expect(await screen.findByRole('table', { name: '饮食月历' })).toBeInTheDocument()
    for (const label of ['常用菜品', '购物清单', '每日记录']) expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getAllByText('番茄炒蛋').length).toBeGreaterThan(0)
  })

  it('opens a meal cell and saves changed food through the meal update API', async () => {
    const mealDate = dayjs().startOf('week').add(1, 'day').format('YYYY-MM-DD')
    let meal = { id: 'meal1', meal_date: mealDate, meal_type: 'lunch', dish_id: null, custom_name: '米饭', dish_name: '米饭', actual_food: '', status: 'pending' }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/diet/meals/meal1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as typeof meal
        meal = { ...meal, ...body, dish_name: body.custom_name }
        return json(meal)
      }
      if (url.includes('/dishes')) return json([])
      if (url.includes('/meals')) return json([meal])
      if (url.includes('/health/')) return json({ log_date: mealDate, water_ml: 0, weight_kg: null, feeling: '' })
      return json([])
    })
    render(<MemoryRouter><DietPage /></MemoryRouter>)

    fireEvent.click(await screen.findByLabelText(`修改 ${mealDate} 午餐`))
    const editor = await screen.findByRole('dialog', { name: '修改饮食安排' })
    expect(editor).toBeInTheDocument()
    const editorArea = within(editor)
    const customName = editorArea.getByLabelText('或填写其他餐食')
    expect(customName).toHaveValue('米饭')
    fireEvent.change(customName, { target: { value: '鸡胸肉沙拉' } })
    fireEvent.click(editorArea.getByLabelText('保存修改'))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => {
      if (!String(input).endsWith('/diet/meals/meal1') || init?.method !== 'PATCH') return false
      return JSON.parse(String(init.body)).custom_name === '鸡胸肉沙拉'
    })).toBe(true))
    expect(await screen.findByText('鸡胸肉沙拉')).toBeInTheDocument()
  })

  it('opens an empty meal cell with its date and meal type preselected', async () => {
    const mealDate = dayjs().startOf('week').add(1, 'day').format('YYYY-MM-DD')
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('/health/')) return json({ log_date: mealDate, water_ml: 0, weight_kg: null, feeling: '' })
      return json([])
    })
    render(<MemoryRouter><DietPage /></MemoryRouter>)

    fireEvent.click(await screen.findByLabelText(`安排 ${mealDate} 早餐`))
    expect(await screen.findByRole('dialog', { name: '安排一餐' })).toBeInTheDocument()
    expect(screen.getByLabelText('日期')).toHaveValue(mealDate)
    expect(screen.getByLabelText('餐次')).toHaveValue('breakfast')
  })

  it('clears every meal plan only after confirmation', async () => {
    const user = userEvent.setup()
    const mealDate = dayjs().startOf('week').add(1, 'day').format('YYYY-MM-DD')
    const meal = { id: 'meal1', meal_date: mealDate, meal_type: 'dinner', dish_id: null, custom_name: '火锅', dish_name: '火锅', actual_food: '', status: 'pending' }
    let cleared = false
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.endsWith('/diet/reset') && init?.method === 'POST') {
        cleared = true
        return json({ cancelled_meals: 1, cancelled_agenda: 1 })
      }
      if (url.includes('/dishes')) return json([])
      if (url.includes('/meals')) return json(cleared ? [] : [meal])
      if (url.includes('/health/')) return json({ log_date: mealDate, water_ml: 0, weight_kg: null, feeling: '' })
      return json([])
    })
    render(<MemoryRouter><DietPage /></MemoryRouter>)
    expect(await screen.findByText('火锅')).toBeInTheDocument()

    await user.click(screen.getByLabelText('清零全部饮食计划'))
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/diet/reset'))).toBe(false)
    await user.click(within(screen.getByRole('tooltip')).getByRole('button', { name: /确\s*认/ }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/reset') && init?.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.queryByText('火锅')).not.toBeInTheDocument())
    expect(screen.getAllByText('未安排').length).toBeGreaterThan(0)
  })

  it('keeps retired game records out of user-visible module results', () => {
    expect(visibleSearchResults([
      { id: 'game1', module: 'games', type: '游戏', title: '示例游戏', snippet: '第二章', path: '/games?item=game1' },
    ])).toEqual([])
  })
})
