import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import dayjs from 'dayjs'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { HomePage } from '../pages/HomePage'
import type { DailyActivity } from '../types'
import { DailyActivityCard } from './DailyActivityCard'

const today = dayjs().format('YYYY-MM-DD')
const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
const beforeYesterday = dayjs().subtract(2, 'day').format('YYYY-MM-DD')
const activity = (id: string, content: string, date = today): DailyActivity => ({
  id, content, activity_date: date, category: 'exercise', source_text: content, created_at: '2026-10-28T00:00:00Z',
})
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}))
beforeEach(() => { vi.restoreAllMocks(); setLocalToken('test-token') })

it('keeps records from repeated entries together by category, including after reopening', async () => {
  const rows: DailyActivity[] = [
    { ...activity('matlab', '上午学习MATLAB'), category: 'learning' },
    activity('running', '下午跑步半小时'),
    { ...activity('dinner', '晚上去吃饭'), category: 'diet' },
  ]
  let calls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const added = calls++ === 0
      ? { ...activity('android', '上午学习安卓课'), category: 'learning' as const }
      : activity('badminton', '晚上打羽毛球')
    rows.push(added)
    return response({ items: [added], skipped: [], created: true }, 201)
  })
  const view = render(<DailyActivityCard initialDate={today} initialItems={[...rows]} />)
  for (const text of ['上午学习安卓课', '晚上打羽毛球']) {
    fireEvent.change(screen.getByLabelText('描述这一天做过的事情'), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: '整理并记录' }))
    expect(await screen.findByRole('button', { name: `修改日常记录：${text}` })).toBeInTheDocument()
  }
  const study = within(screen.getByRole('region', { name: '学习记录' }))
  expect(study.getAllByRole('listitem')).toHaveLength(2)
  expect(study.getAllByRole('listitem')[0]).toHaveTextContent('上午学习MATLAB')
  expect(study.getAllByRole('listitem')[1]).toHaveTextContent('上午学习安卓课')
  expect(study.queryByText('下午跑步半小时')).not.toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '运动记录' })).getAllByRole('listitem')).toHaveLength(2)
  expect(within(screen.getByRole('region', { name: '饮食记录' })).getAllByRole('listitem')).toHaveLength(1)
  view.unmount()
  render(<DailyActivityCard initialDate={today} initialItems={rows} />)
  expect(within(screen.getByRole('region', { name: '学习记录' })).getAllByRole('listitem')).toHaveLength(2)
})

it('records a spoken description as separate home rows, then restores them after reopening home', async () => {
  const user = userEvent.setup()
  let rows: DailyActivity[] = []
  const text = '学了英语，跑步20分钟'
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).endsWith('/daily-activities/narrate')) {
      rows = [{ ...activity('learn', '学了英语'), category: 'learning', source_text: text }, { ...activity('run', '跑步20分钟'), source_text: text }]
      return response({ items: rows, skipped: [], created: true }, 201)
    }
    return response({ date: today, stats: { total: 0, completed: 0, completion_rate: 0, must: 0, overdue: 2, due_soon: 5 },
      agenda: [], quick_notes: [], daily_activities: rows,
      summaries: { learning: { title: '暂无学习计划', count: 0 }, diet: { title: '暂无饮食安排', count: 0 } } })
  })
  const view = render(<MemoryRouter><HomePage /></MemoryRouter>)
  await user.type(await screen.findByLabelText('描述这一天做过的事情'), text)
  expect(screen.queryByText(/说说这一天实际做了什么/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '整理并记录' }))
  expect(await screen.findByRole('button', { name: '修改日常记录：学了英语' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '修改日常记录：跑步20分钟' })).toBeInTheDocument()
  const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/narrate'))!
  expect(JSON.parse(String(call[1]?.body))).toEqual({ activity_date: today, text, request_id: expect.any(String) })
  expect(screen.getByLabelText('描述这一天做过的事情')).toHaveValue('')
  view.unmount()
  render(<MemoryRouter><HomePage /></MemoryRouter>)
  expect(await screen.findByRole('button', { name: '修改日常记录：学了英语' })).toBeInTheDocument()
  expect(screen.getByLabelText('日常记录日期')).toHaveValue(today)
  expect(screen.queryByText(/项逾期|三天内到期/)).not.toBeInTheDocument()
}, 60000)

it('shows only the selected day, allows past-day additions, and preserves each date’s unfinished text', async () => {
  const user = userEvent.setup()
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (init?.method === 'POST') return response({ items: [activity('added', '散步半小时', yesterday)], skipped: [], created: true }, 201)
    return response(String(input).includes(yesterday) ? [activity('past', '昨天跑步', yesterday)] : [activity('today', '今天跑步')])
  })
  render(<DailyActivityCard initialDate={today} initialItems={[activity('today', '今天跑步')]} />)
  await user.type(screen.getByLabelText('描述这一天做过的事情'), '今天草稿')
  await user.click(screen.getByRole('button', { name: '前一天' }))
  expect(await screen.findByRole('button', { name: '修改日常记录：昨天跑步' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '修改日常记录：今天跑步' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('描述这一天做过的事情')).toHaveValue('')
  await user.type(screen.getByLabelText('描述这一天做过的事情'), '散步半小时')
  await user.click(screen.getByRole('button', { name: '整理并记录' }))
  expect(await screen.findByRole('button', { name: '修改日常记录：散步半小时' })).toBeInTheDocument()
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(JSON.parse(String(post[1]?.body)).activity_date).toBe(yesterday)
  await user.click(screen.getByRole('button', { name: '回到今天' }))
  expect(await screen.findByRole('button', { name: '修改日常记录：今天跑步' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '修改日常记录：昨天跑步' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('描述这一天做过的事情')).toHaveValue('今天草稿')
}, 60000)

it('retains a failed description and reuses its request ID on retry without duplicating rows', async () => {
  const user = userEvent.setup()
  const requests: Array<{ request_id: string }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((_, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return requests.length === 1 ? response({ detail: '记录暂时失败' }, 503)
      : response({ items: [activity('one', '散步半小时')], skipped: [], created: false })
  })
  render(<DailyActivityCard initialDate={today} />)
  await user.type(screen.getByLabelText('描述这一天做过的事情'), '散步半小时')
  await user.click(screen.getByRole('button', { name: '整理并记录' }))
  expect(await screen.findByText('记录暂时失败')).toBeInTheDocument()
  expect(screen.getByLabelText('描述这一天做过的事情')).toHaveValue('散步半小时')
  await user.click(screen.getByRole('button', { name: '整理并记录' }))
  expect(await screen.findByRole('button', { name: '修改日常记录：散步半小时' })).toBeInTheDocument()
  expect(requests[0].request_id).toBe(requests[1].request_id)
  expect(within(screen.getByRole('group', { name: '这一天的活动记录' })).getAllByRole('listitem')).toHaveLength(1)
}, 60000)

it('edits the content and category, then deletes a record through confirmation', async () => {
  const user = userEvent.setup()
  let current = activity('one', '散步半小时')
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_, init) => {
    if (init?.method === 'PATCH') current = { ...current, ...JSON.parse(String(init.body)) }
    return response(current)
  })
  render(<DailyActivityCard initialDate={today} initialItems={[current]} />)
  await user.click(screen.getByRole('button', { name: '修改日常记录：散步半小时' }))
  const editor = within(screen.getByRole('dialog'))
  await user.clear(editor.getByLabelText('修改记录内容'))
  await user.type(editor.getByLabelText('修改记录内容'), '和朋友散步')
  await user.selectOptions(editor.getByLabelText('修改记录分类'), 'leisure')
  await user.click(editor.getByRole('button', { name: '保存记录' }))
  expect(await screen.findByRole('button', { name: '修改日常记录：和朋友散步' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '运动记录' })).not.toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '休闲记录' })).getByText('和朋友散步')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/daily-activities/one', expect.objectContaining({
    method: 'PATCH', body: JSON.stringify({ content: '和朋友散步', category: 'leisure', activity_date: today }),
  }))
  await user.click(screen.getByRole('button', { name: '删除日常记录：和朋友散步' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除记录' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '修改日常记录：和朋友散步' })).not.toBeInTheDocument())
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/daily-activities/one', expect.objectContaining({ method: 'DELETE' }))
}, 60000)

it('ignores a slow older date response after the user selects another date', async () => {
  const user = userEvent.setup()
  let resolveOld: (response: Response) => void = () => {}
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => String(input).includes(yesterday)
    ? new Promise<Response>((resolve) => { resolveOld = resolve })
    : response([activity('older', '前天跑步', beforeYesterday)]))
  render(<DailyActivityCard initialDate={today} />)
  await user.click(screen.getByRole('button', { name: '前一天' }))
  await user.click(screen.getByRole('button', { name: '前一天' }))
  expect(await screen.findByRole('button', { name: '修改日常记录：前天跑步' })).toBeInTheDocument()
  await act(async () => resolveOld(new Response(JSON.stringify([activity('old', '昨天跑步', yesterday)]), { status: 200 })))
  expect(screen.getByLabelText('日常记录日期')).toHaveValue(beforeYesterday)
  expect(screen.queryByRole('button', { name: '修改日常记录：昨天跑步' })).not.toBeInTheDocument()
}, 60000)

it('keeps future-only text for correction and explains why it was not recorded', async () => {
  const user = userEvent.setup()
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => response({ items: [], skipped: ['明天打算跑步'], created: false }))
  render(<DailyActivityCard initialDate={today} />)
  fireEvent.change(screen.getByLabelText('描述这一天做过的事情'), { target: { value: '明天打算跑步' } })
  await user.click(screen.getByRole('button', { name: '整理并记录' }))
  expect(await screen.findByText('以下内容含未完成或计划表述，未记入已做事项')).toBeInTheDocument()
  expect(screen.getByLabelText('描述这一天做过的事情')).toHaveValue('明天打算跑步')
  expect(screen.queryByRole('button', { name: '修改日常记录：明天打算跑步' })).not.toBeInTheDocument()
}, 60000)
