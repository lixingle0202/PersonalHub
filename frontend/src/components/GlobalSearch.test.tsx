import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { searchPayload } from '../test/searchFixtures'
import { GlobalSearch } from './GlobalSearch'

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
function Location() { const loc = useLocation(); return <div data-testid="location">{loc.pathname}{loc.search}{loc.hash}</div> }
function mount() { return render(<MemoryRouter><GlobalSearch /><Location /></MemoryRouter>) }
function query(value = '查看昨天的运动记录') {
  fireEvent.change(screen.getByRole('searchbox', { name: '全局搜索' }), { target: { value } })
  fireEvent.keyDown(screen.getByRole('searchbox', { name: '全局搜索' }), { key: 'Enter', code: 'Enter' })
}
beforeEach(() => { vi.restoreAllMocks(); setLocalToken('token') })

it('prevents the opening Enter key from activating the dialog close button', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(searchPayload()))
  mount()
  const input = screen.getByRole('searchbox', { name: '全局搜索' })
  fireEvent.change(input, { target: { value: '学习' } })
  const event = createEvent.keyDown(input, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
  fireEvent(input, event)
  expect(event.defaultPrevented).toBe(true)
  expect(await screen.findByText('识别出的条件，可修改')).toBeInTheDocument()
})

it('shows interpreted filters and navigates to the dated original activity', async () => {
  const payload = searchPayload([{ id: 'd1', module: 'home', type: '日常记录', title: '跑八百米', snippet: '', path: '/?date=2026-11-06&activity=d1#daily-activities', date: '2026-11-06' }])
  payload.interpretation = { ...payload.interpretation, category: 'exercise', start_date: '2026-11-06', end_date: '2026-11-06' }
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(payload))
  mount(); query()
  expect(await screen.findByText('跑八百米')).toBeInTheDocument()
  expect(screen.getByLabelText('类别')).toHaveValue('exercise')
  expect(screen.getByLabelText('开始日期')).toHaveValue('2026-11-06')
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('offset_minutes='), expect.objectContaining({ signal: expect.any(AbortSignal) }))
  fireEvent.click(screen.getByText('跑八百米'))
  expect(screen.getByTestId('location')).toHaveTextContent('/?date=2026-11-06&activity=d1#daily-activities')
})

it('shows comparison evidence without adding manual and timer durations', async () => {
  const payload = searchPayload()
  payload.interpretation.mode = 'compare'
  payload.comparison.evidence = [{ id: 's1', module: 'learning', type: '学习记录', title: '英语复述', snippet: '手动记录20分钟', path: '/learning?item=g2&tab=sessions&record=s1' }]
  payload.comparison.evidence_count = 1
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(payload))
  mount(); query('这周学习计划与实际对照')
  expect(await screen.findByText('50%')).toBeInTheDocument()
  expect(screen.getByText('20 分钟')).toBeInTheDocument()
  expect(screen.getByText('15 分钟')).toBeInTheDocument()
  expect(screen.queryByText('35 分钟')).not.toBeInTheDocument()
  expect(screen.getByText(/分别展示、不相加/)).toBeInTheDocument()
  fireEvent.click(screen.getByText('英语复述'))
  expect(screen.getByTestId('location')).toHaveTextContent('/learning?item=g2&tab=sessions&record=s1')
})

it('keeps unknown durations different from explicitly recorded zero', async () => {
  const payload = searchPayload()
  payload.interpretation.mode = 'compare'
  payload.comparison.manual_learning_minutes = null
  payload.comparison.focus_minutes = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(payload))
  mount(); query('学习对照')
  expect(await screen.findByText('未记录')).toBeInTheDocument()
  expect(screen.getByText('0 分钟')).toBeInTheDocument()
})

it('sends user-corrected conditions to the backend', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(searchPayload()))
  mount(); query('学习')
  await screen.findByText('识别出的条件，可修改')
  fireEvent.change(screen.getByLabelText('关键词'), { target: { value: 'MATLAB' } })
  fireEvent.change(screen.getByLabelText('完成状态'), { target: { value: 'pending' } })
  fireEvent.click(screen.getByRole('button', { name: '按条件查询' }))
  await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('keyword=MATLAB') && String(input).includes('status_filter=pending'))).toBe(true))
})

it('reports request errors and supports retry', async () => {
  let failed = true
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => failed ? json({ detail: '数据服务暂不可用' }, 503) : json(searchPayload()))
  mount(); query('学习')
  expect(await screen.findByRole('alert')).toHaveTextContent('数据服务暂不可用')
  failed = false
  fireEvent.click(screen.getByRole('button', { name: '重试查询' }))
  expect(await screen.findByText('识别出的条件，可修改')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('ignores an older response after a newer query has finished', async () => {
  let resolveFirst: ((value: Response) => void) | undefined
  const slow = new Promise<Response>((resolve) => { resolveFirst = resolve })
  const newPayload = searchPayload([{ id: 'new', module: 'home', type: '备忘', title: '新结果', snippet: '', path: '/' }])
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => String(input).includes('q=first') ? slow : json(newPayload))
  mount(); query('first')
  fireEvent.change(screen.getByRole('searchbox', { name: '自然语言查询' }), { target: { value: 'second' } })
  fireEvent.keyDown(screen.getByRole('searchbox', { name: '自然语言查询' }), { key: 'Enter', code: 'Enter' })
  expect(await screen.findByText('新结果')).toBeInTheDocument()
  resolveFirst!(new Response(JSON.stringify(searchPayload([{ id: 'old', module: 'home', type: '备忘', title: '旧结果', snippet: '', path: '/' }]))))
  await waitFor(() => expect(screen.queryByText('旧结果')).not.toBeInTheDocument())
})
