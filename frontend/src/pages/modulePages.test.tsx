import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { ConsultingPage } from './ConsultingPage'
import { DietPage } from './DietPage'
import { GamesPage } from './GamesPage'
import { LearningPage } from './LearningPage'
import { MediaPage } from './MediaPage'

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
    const goal = { id: 'g1', name: '学习 Python', goal: '完成项目', start_date: null, target_date: null, estimated_minutes: 2400, progress: 50 }
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => String(input).endsWith('/goals') ? json([goal]) : json({ ...goal, sections: [{ id: 's1', name: '语法基础', is_completed: true }], tasks: [], sessions: [], resources: [] }))
    render(<MemoryRouter><LearningPage /></MemoryRouter>)
    expect((await screen.findAllByText('学习 Python')).length).toBeGreaterThan(0)
    for (const label of ['学习路线', '学习任务', '学习记录', '笔记与资料']) expect(await screen.findByText(label)).toBeInTheDocument()
    expect(screen.getAllByText('50%').length).toBeGreaterThanOrEqual(2)
  })

  it('renders a weekly meal grid plus dishes, shopping and daily records', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('/dishes')) return json([{ id: 'd1', name: '番茄炒蛋', instructions: '', nutrition_notes: '', notes: '', ingredients: [] }])
      if (url.includes('/meals')) return json([{ id: 'meal1', meal_date: '2026-09-30', meal_type: 'dinner', dish_id: 'd1', custom_name: '', dish_name: '番茄炒蛋', actual_food: '', status: 'pending' }])
      if (url.includes('/health/')) return json({ log_date: '2026-09-30', water_ml: 1500, weight_kg: null, feeling: '' })
      return json([])
    })
    render(<MemoryRouter><DietPage /></MemoryRouter>)
    expect(await screen.findByText('每周饮食')).toBeInTheDocument()
    for (const label of ['常用菜品', '购物清单', '每日记录']) expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getAllByText('番茄炒蛋').length).toBeGreaterThan(0)
  })

  it('renders game library states and an entertainment budget', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).includes('/budget')) return json({ period_type: 'weekly', minute_limit: 300, used_minutes: 90, exceeded: false, starts_on: '2026-09-28' })
      return json([{ id: 'game1', name: '示例游戏', platform: 'PC', genre: '策略', status: 'playing', progress: '第二章', next_goal: '第三章', notes: '', rating: 8 }])
    })
    render(<MemoryRouter><GamesPage /></MemoryRouter>)
    expect(await screen.findByText('示例游戏')).toBeInTheDocument()
    for (const label of ['想玩', '正在玩', '已通关', '暂时搁置']) expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText('90/300 分钟')).toBeInTheDocument()
  })
})
