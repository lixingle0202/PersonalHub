import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { LearningAutoExtension } from './LearningAutoExtension'

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }))
}

afterEach(() => vi.restoreAllMocks())

it('shows the learning page immediately while checking and keeps notices until acknowledged', async () => {
  setLocalToken('test-token')
  let release!: () => void
  const pending = new Promise<Response>((resolve) => {
    release = () => resolve(new Response(JSON.stringify({
      shifted_goal_ids: ['goal-1'],
      notices: [{ id: 'notice-1', goal_id: 'goal-1', goal_name: '英语六级',
        triggered_on: '2026-10-04', shifted_days: 3,
        previous_first_date: '2026-10-01', new_first_date: '2026-10-04' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).endsWith('/learning/overdue/check')) return pending
    if (String(input).endsWith('/learning/overdue/reminders/notice-1/ack')) return json({ acknowledged: true })
    return json({}, 404)
  })

  render(<LearningAutoExtension><div>学习内容</div></LearningAutoExtension>)
  expect(screen.getByText('学习内容')).toBeInTheDocument()
  release()
  expect(await screen.findByText('学习计划「英语六级」已超时并自动顺延')).toBeInTheDocument()
  expect(screen.getByText('学习内容')).toBeInTheDocument()
  expect(screen.getByText(/最早一项从 2026-10-01 调整到 2026-10-04/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '确认收到 英语六级 顺延提醒' }))
  await waitFor(() => expect(screen.queryByText('学习计划「英语六级」已超时并自动顺延')).not.toBeInTheDocument())
  expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/learning/overdue/reminders/notice-1/ack') && init?.method === 'POST')).toBe(true)
})

it('leaves manual learning features usable when the overdue check fails', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ detail: '暂时无法检查' }, 503))
  render(<LearningAutoExtension><div>手动学习计划</div></LearningAutoExtension>)
  expect(await screen.findByText('手动学习计划')).toBeInTheDocument()
  expect(screen.getByText('学习计划逾期检查暂不可用')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重试检查' })).toBeEnabled()
})
