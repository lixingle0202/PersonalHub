import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { message } from 'antd'
import dayjs from 'dayjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { calendarRange, type Meal } from '../components/DietCalendar'
import { DietPage } from './DietPage'

const meal = (id: string, overrides: Partial<Meal> = {}): Meal => ({
  id, meal_date: '2026-10-07', meal_type: 'lunch', dish_id: null,
  custom_name: '米饭', dish_name: '米饭', actual_food: '', status: 'pending', ...overrides,
})

// Ant Design uses a shared title ID in test mode; locate each dialog by its visible title.
function dialogWithTitle(title: string) {
  return screen.getByText(title).closest('[role="dialog"]') as HTMLElement
}

function mockApi(initial: Meal[] = [], deleteFails: boolean | (() => boolean) = false) {
  let meals = [...initial]
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    let body: unknown = []
    if (url.pathname.includes('/diet/meals/') && init?.method === 'DELETE') {
      if (typeof deleteFails === 'function' ? deleteFails() : deleteFails) return new Response(JSON.stringify({ detail: '删除失败，请重试' }), { status: 500 })
      meals = meals.filter((entry) => !url.pathname.endsWith(`/${entry.id}`))
      body = {}
    } else if (url.pathname.includes('/diet/meals/') && init?.method === 'PATCH') {
      const values = JSON.parse(String(init.body)) as Partial<Meal>
      meals = meals.map((entry) => url.pathname.endsWith(`/${entry.id}`) ? { ...entry, ...values, dish_name: values.custom_name ?? '' } : entry)
      body = meals[0]
    } else if (url.pathname.endsWith('/diet/meals') && init?.method === 'POST') {
      const values = JSON.parse(String(init.body)) as Partial<Meal>
      const created = meal('created', { ...values, dish_name: values.custom_name ?? '' })
      meals.push(created)
      body = created
    } else if (url.pathname.endsWith('/diet/meals')) {
      body = meals.filter((entry) => entry.meal_date >= url.searchParams.get('start_date')! && entry.meal_date <= url.searchParams.get('end_date')!)
    } else if (url.pathname.includes('/health/')) {
      body = { log_date: '2026-10-07', water_ml: 0, weight_kg: null, feeling: '' }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

describe('diet monthly calendar and manual changes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T12:00:00+08:00'))
    setLocalToken('test-token')
  })
  afterEach(async () => {
    await act(async () => message.destroy())
    vi.useRealTimers()
  })

  it.each([
    ['2026-10-01', '2026-09-28', '2026-11-01'],
    ['2026-08-01', '2026-07-27', '2026-09-06'],
    ['2026-12-01', '2026-11-30', '2027-01-03'],
    ['2028-02-01', '2028-01-31', '2028-03-05'],
    ['2027-02-01', '2027-02-01', '2027-02-28'],
  ])('covers every day of %s in complete Monday-to-Sunday weeks', (month, start, end) => {
    const range = calendarRange(dayjs(month))
    expect(range.start.format('YYYY-MM-DD')).toBe(start)
    expect(range.end.format('YYYY-MM-DD')).toBe(end)
    expect(range.start.day()).toBe(1)
    expect(range.end.day()).toBe(0)
  })

  it('renders a monthly calendar with adjacent dates and highlights today', async () => {
    const fetchMock = mockApi([meal('boundary', { meal_date: '2026-09-28', custom_name: '燕麦', dish_name: '燕麦' })])
    render(<DietPage />)
    const calendar = await screen.findByRole('table', { name: '饮食月历' })
    expect(within(calendar).getAllByRole('columnheader').map((heading) => heading.textContent)).toEqual(['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
    expect(within(calendar).getAllByRole('cell')).toHaveLength(35)
    expect(screen.getByRole('cell', { name: '2026-10-07' })).toHaveAttribute('aria-current', 'date')
    expect(screen.getByRole('cell', { name: '2026-09-28' })).toHaveClass('calendar-other-month')
    expect(screen.getByText('燕麦')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('start_date=2026-09-28&end_date=2026-11-01'))).toBe(true)
  })

  it('changes the requested date range when navigating months and returning to today', async () => {
    const fetchMock = mockApi()
    render(<DietPage />)
    await screen.findByRole('table', { name: '饮食月历' })
    fireEvent.click(screen.getByLabelText('上一月'))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('start_date=2026-08-31&end_date=2026-10-04'))).toBe(true))
    expect(screen.getByText('2026年9月')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('下一月'))
    await screen.findByText('2026年10月')
    fireEvent.click(screen.getByLabelText('下一月'))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('start_date=2026-10-26&end_date=2026-12-06'))).toBe(true))
    fireEvent.click(screen.getByText('回到今天'))
    expect(await screen.findByText('2026年10月')).toBeInTheDocument()
  })

  it('shows actual food and allows expanding every meal, including repeated meal types', async () => {
    mockApi([
      meal('one', { meal_type: 'breakfast', custom_name: '燕麦', dish_name: '燕麦', actual_food: '牛奶燕麦' }),
      meal('two', { custom_name: '沙拉', dish_name: '沙拉' }),
      meal('three', { custom_name: '面条', dish_name: '面条' }),
      meal('four', { meal_type: 'dinner', custom_name: '蒸鱼', dish_name: '蒸鱼' }),
    ])
    render(<DietPage />)
    expect(await screen.findByText('实际 · 早餐')).toBeInTheDocument()
    expect(screen.getByText('实际：牛奶燕麦')).toBeInTheDocument()
    expect(screen.queryByText('面条')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('另有 2 餐'))
    expect(screen.getByText('面条')).toBeInTheDocument()
    expect(screen.getByText('蒸鱼')).toBeInTheDocument()
    fireEvent.click(screen.getByText('收起'))
    expect(screen.queryByText('蒸鱼')).not.toBeInTheDocument()
  })

  it('does not let a slower previous-month response replace the selected month', async () => {
    const fetchMock = mockApi([meal('new-month', { meal_date: '2026-12-12', custom_name: '十二月餐食', dish_name: '十二月餐食' })])
    const normalRequest = fetchMock.getMockImplementation()!
    let releasePrevious: ((response: Response) => void) | undefined
    fetchMock.mockImplementation((input, init) => String(input).includes('start_date=2026-10-26')
      ? new Promise<Response>((resolve) => { releasePrevious = resolve }) : normalRequest(input, init))
    render(<DietPage />)
    await screen.findByRole('table', { name: '饮食月历' })
    fireEvent.click(screen.getByLabelText('下一月'))
    await waitFor(() => expect(releasePrevious).toBeDefined())
    fireEvent.click(screen.getByLabelText('下一月'))
    expect(await screen.findByText('十二月餐食')).toBeInTheDocument()
    await act(async () => releasePrevious!(new Response(JSON.stringify([meal('old-month', { meal_date: '2026-11-10', dish_name: '旧月份餐食' })]))))
    expect(screen.getByText('2026年12月')).toBeInTheDocument()
    expect(screen.getByText('十二月餐食')).toBeInTheDocument()
    expect(screen.queryByText('旧月份餐食')).not.toBeInTheDocument()
  })

  it('creates a meal for the selected empty date and meal type', async () => {
    const fetchMock = mockApi()
    render(<DietPage />)
    fireEvent.click(await screen.findByLabelText('安排 2026-10-12 早餐'))
    expect(screen.getByLabelText('日期')).toHaveValue('2026-10-12')
    expect(screen.getByTitle('早餐')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('或填写其他餐食'), { target: { value: '燕麦粥' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '创建' }))
    expect(await screen.findByText('燕麦粥')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/meals') && init?.method === 'POST' && JSON.parse(String(init.body)).meal_date === '2026-10-12' && JSON.parse(String(init.body)).meal_type === 'breakfast')).toBe(true)
  })

  it('saves manual changes and follows a meal moved into another month', async () => {
    const fetchMock = mockApi([meal('one')])
    render(<DietPage />)
    fireEvent.click(await screen.findByLabelText('修改 2026-10-07 午餐'))
    fireEvent.change(screen.getByLabelText('或填写其他餐食'), { target: { value: '鸡胸肉沙拉' } })
    fireEvent.change(screen.getByLabelText('实际饮食（可选）'), { target: { value: '蔬菜沙拉' } })
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-11-10' } })
    fireEvent.keyDown(screen.getByLabelText('日期'), { key: 'Enter', code: 'Enter' })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/meals/one') && init?.method === 'PATCH' && JSON.parse(String(init.body)).meal_date === '2026-11-10' && JSON.parse(String(init.body)).actual_food === '蔬菜沙拉')).toBe(true))
    expect(await screen.findByText('2026年11月')).toBeInTheDocument()
    expect(await screen.findByText('鸡胸肉沙拉')).toBeInTheDocument()
    expect(screen.getByText('实际：蔬菜沙拉')).toBeInTheDocument()
  })

  it('requires confirmation for deletion and removes only that meal', async () => {
    const fetchMock = mockApi([meal('one'), meal('two', { meal_type: 'dinner', custom_name: '蒸鱼', dish_name: '蒸鱼' })])
    render(<DietPage />)
    fireEvent.click(await screen.findByLabelText('修改 2026-10-07 午餐'))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByLabelText('删除这餐'))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    const firstConfirmation = within(dialogWithTitle('确认删除这餐？'))
    fireEvent.click(firstConfirmation.getByRole('button', { name: /取\s*消/ }))
    expect(screen.getByText('米饭')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    fireEvent.click(dialog.getByLabelText('删除这餐'))
    const confirmation = within(dialogWithTitle('确认删除这餐？')).getByRole('button', { name: /确\s*认/ })
    await act(async () => fireEvent.click(confirmation))
    await waitFor(() => expect(screen.queryByText('米饭')).not.toBeInTheDocument())
    expect(screen.getByText('蒸鱼')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/meals/one') && init?.method === 'DELETE')).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the meal and editor visible when deletion fails', async () => {
    const fetchMock = mockApi([meal('one')], true)
    render(<DietPage />)
    fireEvent.click(await screen.findByLabelText('修改 2026-10-07 午餐'))
    fireEvent.click(within(screen.getByRole('dialog')).getByLabelText('删除这餐'))
    const confirmation = within(dialogWithTitle('确认删除这餐？')).getByRole('button', { name: /确\s*认/ })
    await act(async () => fireEvent.click(confirmation))
    expect(await screen.findByText('删除失败，请重试')).toBeInTheDocument()
    expect(dialogWithTitle('修改饮食安排')).toBeInTheDocument()
    expect(screen.getByText('米饭')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/meals/one') && init?.method === 'DELETE')).toBe(true)
    expect(screen.getByLabelText('或填写其他餐食')).toHaveValue('米饭')
  })

  it('allows a failed delete to be retried without losing unsaved meal edits', async () => {
    let failDelete = true
    const fetchMock = mockApi([meal('one')], () => failDelete)
    render(<DietPage />)
    fireEvent.click(await screen.findByLabelText('修改 2026-10-07 午餐'))
    fireEvent.change(screen.getByLabelText('或填写其他餐食'), { target: { value: '尚未保存的修改' } })
    fireEvent.click(screen.getByLabelText('删除这餐'))
    const confirmation = within(dialogWithTitle('确认删除这餐？'))
    await act(async () => fireEvent.click(confirmation.getByRole('button', { name: /确\s*认/ })))
    expect(await confirmation.findByText('删除失败，请重试')).toBeInTheDocument()
    expect(screen.getByLabelText('或填写其他餐食')).toHaveValue('尚未保存的修改')
    failDelete = false
    await act(async () => fireEvent.click(confirmation.getByRole('button', { name: /确\s*认/ })))
    await waitFor(() => expect(screen.queryByText('米饭')).not.toBeInTheDocument())
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('blocks duplicate deletion and editor actions while the delete request is pending', async () => {
    const fetchMock = mockApi([meal('one')])
    const normalRequest = fetchMock.getMockImplementation()!
    let releaseDelete: (() => Promise<void>) | undefined
    fetchMock.mockImplementation((input, init) => init?.method === 'DELETE'
      ? new Promise<Response>((resolve) => { releaseDelete = async () => resolve(await normalRequest(input, init)) })
      : normalRequest(input, init))
    render(<DietPage />)
    fireEvent.click(await screen.findByLabelText('修改 2026-10-07 午餐'))
    const editor = within(screen.getByRole('dialog', { name: '修改饮食安排' }))
    fireEvent.click(editor.getByLabelText('删除这餐'))
    const confirmationDialog = dialogWithTitle('确认删除这餐？')
    const confirmation = within(confirmationDialog)
    const confirm = confirmation.getByRole('button', { name: /确\s*认/ })
    fireEvent.click(confirm)
    expect(confirm).toBeDisabled()
    expect(confirmation.getByRole('button', { name: /取\s*消/ })).toBeDisabled()
    expect(editor.getByLabelText('保存修改')).toBeDisabled()
    expect(editor.getByLabelText('取消')).toBeDisabled()
    fireEvent.click(confirm)
    fireEvent.keyDown(confirmationDialog, { key: 'Escape', keyCode: 27 })
    expect(confirmationDialog).toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
    await act(async () => releaseDelete!())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('米饭')).not.toBeInTheDocument()
  })
})
