import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { FocusTimer } from './FocusTimer'

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('learning Pomodoro', () => {
  beforeEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); setLocalToken('focus-test-token') })

  it('starts on a selected task, stops, and shows persisted daily focus time', async () => {
    let running = false
    let seconds = 0
    const writes: Array<{ path: string; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input)
      if (path.includes('/focus/start')) { writes.push({ path, body: JSON.parse(String(init?.body)) }); running = true; return json({ id: 'focus-1' }) }
      if (path.includes('/focus/stop')) { writes.push({ path, body: {} }); running = false; seconds = 1500; return json({ id: 'focus-1', seconds }) }
      return json({ date: '2026-10-09', seconds, running: running ? { id: 'focus-1', goal_id: 'goal-1', task_id: 'task-1', started_at: new Date().toISOString() } : null })
    })
    render(<FocusTimer goalId="goal-1" tasks={[{ id: 'task-1', title: '变量练习' }]} />)
    await screen.findByText('今日专注 00:00')
    fireEvent.change(screen.getByLabelText('关联学习任务'), { target: { value: 'task-1' } })
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }))
    await screen.findByRole('button', { name: '结束专注并计入时长' })
    expect(writes[0].body).toEqual({ goal_id: 'goal-1', task_id: 'task-1' })
    fireEvent.click(screen.getByRole('button', { name: '结束专注并计入时长' }))
    await waitFor(() => expect(screen.getByText('今日专注 25:00')).toBeInTheDocument())
    expect(writes).toHaveLength(2)
  })

  it('saves a custom duration and restarts an active interval from zero', async () => {
    let startedAt = new Date(Date.now() - 120_000).toISOString()
    const writes: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = String(input)
      if (path.includes('/focus/reset')) { writes.push('reset'); startedAt = new Date().toISOString(); return json({ id: 'new-focus', started_at: startedAt }) }
      return json({ date: '2026-10-09', seconds: 300, running: { id: 'focus-1', goal_id: 'goal-1', task_id: null, started_at: startedAt } })
    })
    render(<FocusTimer goalId="goal-1" tasks={[]} />)
    await screen.findByRole('button', { name: '清零重新计时' })
    fireEvent.change(screen.getByLabelText('专注分钟'), { target: { value: '40' } })
    expect(screen.getByText('番茄钟 · 40 分钟专注')).toBeInTheDocument()
    expect(window.localStorage.getItem('personalhub:focus-duration-minutes')).toBe('40')
    fireEvent.click(screen.getByRole('button', { name: '清零重新计时' }))
    await waitFor(() => expect(writes).toEqual(['reset']))
    await waitFor(() => expect(screen.getByText(/本次 00:00 · 距离 40 分钟还剩 40:00/)).toBeInTheDocument())
  })
})
