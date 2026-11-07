import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { HomePage } from './HomePage'
import { TodayPage } from './TodayPage'
import { LearningPage } from './LearningPage'

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }))
beforeEach(() => { vi.restoreAllMocks(); setLocalToken('test-token') })

it('opens the searched agenda date instead of silently falling back to today', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json([
    { id: 'a1', title: '历史事项', plan_date: '2026-01-10', bucket: 'scheduled', status: 'pending', module: 'general', notes: '', priority: 'normal' },
  ]))
  render(<MemoryRouter initialEntries={['/today?date=2026-01-10&item=a1']}><TodayPage /></MemoryRouter>)
  expect(await screen.findByText('历史事项')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/agenda?date=2026-01-10', expect.any(Object))
  expect(document.getElementById('agenda-a1')).toHaveAttribute('data-search-target', 'true')
})

it('loads the historical daily activity and highlights its source record', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).includes('/daily-activities?date=2026-01-10')) return json([
      { id: 'd1', activity_date: '2026-01-10', content: '历史跑八百米', category: 'exercise', source_text: '原始描述', created_at: '' },
    ])
    return json({ date: '2026-11-07', stats: { total: 0, completed: 0, completion_rate: 0, must: 0 }, agenda: [], quick_notes: [], daily_activities: [], summaries: { learning: { count: 0, title: '' }, diet: { count: 0, title: '' } } })
  })
  render(<MemoryRouter initialEntries={['/?date=2026-01-10&activity=d1']}><HomePage /></MemoryRouter>)
  expect(await screen.findByText('历史跑八百米')).toBeInTheDocument()
  expect(screen.getByLabelText('日常记录日期')).toHaveValue('2026-01-10')
  expect(document.getElementById('activity-d1')).toHaveAttribute('data-search-target', 'true')
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/daily-activities?date=2026-01-10', expect.any(Object))
})

it('selects the searched goal and its learning-record tab', async () => {
  const goals = [{ id: 'g1', name: '第一个目标', goal: '' }, { id: 'g2', name: '目标英语', goal: '检索目标详情' }]
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).endsWith('/learning/goals')) return json(goals)
    if (String(input).endsWith('/learning/goals/g2')) return json({ ...goals[1], progress: 0, estimated_minutes: 0, sections: [], tasks: [], sessions: [{ id: 's1', studied_on: '2026-11-06', actual_minutes: 20, notes: '检索到的复述笔记', next_step: '' }], resources: [] })
    return json({ seconds: 0, running: null })
  })
  render(<MemoryRouter initialEntries={['/learning?item=g2&tab=sessions&record=s1']}><LearningPage /></MemoryRouter>)
  expect(await screen.findByText('检索到的复述笔记')).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: '学习记录' })).toHaveAttribute('aria-selected', 'true')
  expect(document.getElementById('study-session-s1')).toHaveAttribute('data-search-target', 'true')
})
