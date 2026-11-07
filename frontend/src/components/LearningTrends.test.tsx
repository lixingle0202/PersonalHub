import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { apiRequest } from '../api/client'
import { LearningTrends, type LearningTrendData } from './LearningTrends'

vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))
const request = vi.mocked(apiRequest)
const goals = [{ id: 'g1', name: '英语' }, { id: 'g2', name: '编程' }]
function fixture(): LearningTrendData {
  return {
    start_date: '2026-11-01', end_date: '2026-11-07',
    days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-11-0${index + 1}`,
      manual_minutes: index === 5 ? 30 : index === 6 ? 0 : null,
      focus_seconds: index === 6 ? 900 : null, planned_tasks: index === 6 ? 2 : 0, completed_tasks: index === 6 ? 1 : 0 })),
    manual: { minutes: 30, record_count: 2, active_days: 1, current_streak: 1 },
    focus: { minutes: 15, record_count: 1, active_days: 1, current_streak: 1 },
    tasks: { planned: 2, completed: 1, completion_rate: 50 },
  }
}
beforeEach(() => { request.mockReset(); request.mockResolvedValue(fixture()) })

it('shows separate sources, charts, streak, and missing versus explicit zero in daily detail', async () => {
  render(<LearningTrends goals={goals} />)
  expect(await screen.findByTestId('trend-minutes')).toHaveTextContent('30')
  expect(screen.getByTestId('trend-streak')).toHaveTextContent('1')
  expect(screen.getByTestId('trend-completion')).toHaveTextContent('50%')
  expect(screen.getByRole('img', { name: '每日学习时长柱状图' })).toBeInTheDocument()
  expect(screen.getByRole('img', { name: '2026-11-01：未记录' })).toBeInTheDocument()
  expect(screen.getByRole('img', { name: '2026-11-07：0 分钟' })).toBeInTheDocument()
  fireEvent.click(screen.getByText('专注计时', { selector: '.ant-segmented-item-label' }))
  expect(screen.getByTestId('trend-minutes')).toHaveTextContent('15')
  expect(screen.getByRole('img', { name: '2026-11-07：15 分钟' })).toBeInTheDocument()
  expect(request).toHaveBeenCalledTimes(1) // Both sources come from one read, never added together.
})

it('requests selected dates and goal and automatically refreshes on new saved data', async () => {
  const { rerender } = render(<LearningTrends goals={goals} revision={0} />)
  await screen.findByTestId('trend-minutes')
  fireEvent.click(screen.getByText('近30天'))
  await waitFor(() => expect(String(request.mock.lastCall?.[0])).toContain('days=30'))
  fireEvent.change(screen.getByLabelText('趋势学习目标'), { target: { value: 'g2' } })
  await waitFor(() => expect(String(request.mock.lastCall?.[0])).toContain('goal_id=g2'))
  const before = request.mock.calls.length
  rerender(<LearningTrends goals={goals} revision={1} />)
  await waitFor(() => expect(request.mock.calls.length).toBe(before + 1))
  rerender(<LearningTrends goals={[goals[0]]} revision={2} />)
  await waitFor(() => expect(String(request.mock.lastCall?.[0])).not.toContain('goal_id='))
})

it('ignores old responses after switching ranges', async () => {
  let release!: (data: LearningTrendData) => void
  request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve as typeof release }))
  render(<LearningTrends goals={goals} />)
  fireEvent.click(screen.getByText('近90天'))
  await screen.findByTestId('trend-minutes')
  await act(async () => {
    const old = fixture(); old.manual.minutes = 999
    release(old)
  })
  expect(screen.getByTestId('trend-minutes')).toHaveTextContent('30')
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true)
})

it('offers a retry after failure and a useful empty state', async () => {
  const empty = fixture()
  empty.manual = empty.focus = { minutes: 0, record_count: 0, active_days: 0, current_streak: 0 }
  empty.tasks = { planned: 0, completed: 0, completion_rate: null }
  empty.days = empty.days.map((day) => ({ ...day, manual_minutes: null, focus_seconds: null, planned_tasks: 0, completed_tasks: 0 }))
  request.mockRejectedValueOnce(new Error('网络暂时不可用')).mockResolvedValue(empty)
  render(<LearningTrends goals={[]} />)
  await screen.findByText('网络暂时不可用')
  fireEvent.click(screen.getByRole('button', { name: /^重\s*试$/ }))
  expect(await screen.findByText('暂无学习数据，记录学习或结束专注后即可查看')).toBeInTheDocument()
  expect(screen.getByTestId('trend-completion')).toHaveTextContent('暂无任务')
})
