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

function mockApi(initial: Meal[] = [], deleteFails: boolean | (() => boolean) = false, initialDishes: Array<{ id: string; name: string; instructions: string; nutrition_notes: string; notes: string; ingredients: Array<{ name: string; quantity: number | null; unit: string }> }> = []) {
  let meals = [...initial]
  let dishes = [...initialDishes]
  let shopping: Array<{ id: string; name: string; start_date: string; end_date: string; items: Array<{ id: string; ingredient_name: string; quantity_text: string; is_completed: boolean }> }> = []
  let profile = { height_cm: null as number | null, weight_kg: null as number | null }
  const dishName = (values: Partial<Meal>) => values.dish_ids?.length
    ? values.dish_ids.map((id) => dishes.find((dish) => dish.id === id)?.name).filter(Boolean).join('、')
    : values.custom_name ?? ''
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    let body: unknown = []
    if (url.pathname.endsWith('/diet/shopping-lists/generate') && init?.method === 'POST') {
      const values = JSON.parse(String(init.body))
      shopping = [{ id: 'list-1', ...values, items: [{ id: 'item-1', ingredient_name: '大米', quantity_text: '200克', is_completed: false }] }, ...shopping]
      body = shopping[0]
    } else if (url.pathname.endsWith('/diet/shopping-lists') && init?.method === 'POST') {
      shopping = [{ id: 'list-1', ...JSON.parse(String(init.body)), items: [] }, ...shopping]
      body = shopping[0]
    } else if (url.pathname.endsWith('/diet/shopping-lists')) {
      body = shopping
    } else if (url.pathname.includes('/diet/shopping-lists/') && url.pathname.endsWith('/items') && init?.method === 'POST') {
      const listId = url.pathname.split('/').at(-2)
      const item = { id: 'manual-1', ...JSON.parse(String(init.body)), is_completed: false }
      shopping = shopping.map((list) => list.id === listId ? { ...list, items: [...list.items, item] } : list)
      body = item
    } else if (url.pathname.includes('/diet/shopping-items/') && init?.method === 'PATCH') {
      const itemId = url.pathname.split('/').at(-1)
      shopping = shopping.map((list) => ({ ...list, items: list.items.map((item) => item.id === itemId ? { ...item, ...JSON.parse(String(init.body)) } : item) }))
      body = {}
    } else if (url.pathname.includes('/diet/shopping-items/') && init?.method === 'DELETE') {
      const itemId = url.pathname.split('/').at(-1)
      shopping = shopping.map((list) => ({ ...list, items: list.items.filter((item) => item.id !== itemId) }))
      body = {}
    } else if (url.pathname.includes('/diet/dishes/') && init?.method === 'PATCH') {
      const values = JSON.parse(String(init.body)) as typeof dishes[number]
      dishes = dishes.map((dish) => url.pathname.endsWith(`/${dish.id}`) ? { ...dish, ...values } : dish)
      body = dishes[0]
    } else if (url.pathname.endsWith('/diet/dishes')) {
      body = dishes
    } else if (url.pathname.includes('/diet/meals/') && init?.method === 'DELETE') {
      if (typeof deleteFails === 'function' ? deleteFails() : deleteFails) return new Response(JSON.stringify({ detail: '删除失败，请重试' }), { status: 500 })
      meals = meals.filter((entry) => !url.pathname.endsWith(`/${entry.id}`))
      body = {}
    } else if (url.pathname.includes('/diet/meals/') && init?.method === 'PATCH') {
      const values = JSON.parse(String(init.body)) as Partial<Meal>
      meals = meals.map((entry) => url.pathname.endsWith(`/${entry.id}`) ? { ...entry, ...values, dish_name: dishName(values) } : entry)
      body = meals[0]
    } else if (url.pathname.endsWith('/diet/meals') && init?.method === 'POST') {
      const values = JSON.parse(String(init.body)) as Partial<Meal>
      const created = meal('created', { ...values, dish_name: dishName(values) })
      meals.push(created)
      body = created
    } else if (url.pathname.endsWith('/diet/meals')) {
      body = meals.filter((entry) => entry.meal_date >= url.searchParams.get('start_date')! && entry.meal_date <= url.searchParams.get('end_date')!)
    } else if (url.pathname.endsWith('/diet/profile')) {
      if (init?.method === 'PUT') profile = JSON.parse(String(init.body))
      body = profile
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

  it('saves height and weight and shows the estimated calories on the calendar', async () => {
    const fetchMock = mockApi([meal('one', { display_kcal: 282, calorie_source: '食材粗估' })])
    render(<DietPage />)
    expect(await screen.findByText('约 282 kcal · 食材粗估')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('身高（cm）'), { target: { value: '175' } })
    fireEvent.change(screen.getByLabelText('体重（kg）'), { target: { value: '68' } })
    fireEvent.click(screen.getByRole('button', { name: '保存身体资料' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/profile') && init?.method === 'PUT' && JSON.parse(String(init.body)).height_cm === 175)).toBe(true))
  })

  it('generates this month’s list and lets a person add and edit an item', async () => {
    const fetchMock = mockApi()
    render(<DietPage />)
    fireEvent.click(await screen.findByRole('tab', { name: '购物清单' }))
    fireEvent.click(screen.getByRole('button', { name: '按当前月份饮食生成' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '生成购物清单' })).getByRole('button', { name: '创建' }))
    expect(await screen.findByText('大米')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/shopping-lists/generate') && init?.method === 'POST' && JSON.parse(String(init.body)).start_date === '2026-10-01' && JSON.parse(String(init.body)).end_date === '2026-10-31')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '手动添加物品' }))
    const add = within(screen.getByRole('dialog', { name: '手动添加物品' }))
    fireEvent.change(add.getByLabelText('物品名称'), { target: { value: '牛奶' } })
    fireEvent.change(add.getByLabelText('数量或备注'), { target: { value: '2盒' } })
    fireEvent.click(add.getByRole('button', { name: '创建' }))
    expect(await screen.findByText('牛奶')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '修改购物项目 牛奶' }))
    const edit = within(screen.getByRole('dialog', { name: '修改购物项目' }))
    fireEvent.change(edit.getByLabelText('物品名称'), { target: { value: '酸奶' } })
    fireEvent.click(edit.getByRole('button', { name: '保存修改' }))
    expect(await screen.findByText('酸奶')).toBeInTheDocument()
    expect(screen.queryByText('牛奶')).not.toBeInTheDocument()
  }, 180000)

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
    expect(screen.getByLabelText('餐次')).toHaveValue('breakfast')
    fireEvent.change(screen.getByLabelText('或填写其他餐食'), { target: { value: '燕麦粥' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '创建' }))
    expect(await screen.findByText('燕麦粥')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/meals') && init?.method === 'POST' && JSON.parse(String(init.body)).meal_date === '2026-10-12' && JSON.parse(String(init.body)).meal_type === 'breakfast')).toBe(true)
  })

  it('selects multiple common dishes for one meal and edits a recipe', async () => {
    const fetchMock = mockApi([], false, [{ id: 'dish-1', name: '西红柿炒鸡蛋', instructions: '炒熟', nutrition_notes: '', notes: '', ingredients: [{ name: '鸡蛋', quantity: 2, unit: '个' }] }])
    render(<DietPage />)
    fireEvent.click(await screen.findByRole('button', { name: '安排一餐' }))
    const dialog = within(screen.getByRole('dialog', { name: '安排一餐' }))
    fireEvent.change(dialog.getByLabelText('餐次'), { target: { value: 'lunch' } })
    fireEvent.click(dialog.getByRole('button', { name: '选择菜品' }))
    fireEvent.click(dialog.getByRole('checkbox', { name: '西红柿炒鸡蛋' }))
    expect(dialog.getByLabelText('餐次')).toHaveValue('lunch')
    expect(dialog.getByRole('checkbox', { name: '西红柿炒鸡蛋' })).toBeChecked()
    expect(dialog.queryByLabelText('实际饮食（可选）')).not.toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/meals') && init?.method === 'POST' && JSON.parse(String(init.body)).dish_ids[0] === 'dish-1')).toBe(true))
    fireEvent.click(screen.getByRole('tab', { name: '常用菜品' }))
    fireEvent.click(screen.getByRole('button', { name: '修改菜品 西红柿炒鸡蛋' }))
    const recipe = within(screen.getByRole('dialog', { name: '修改菜品' }))
    fireEvent.change(recipe.getByLabelText('简单做法'), { target: { value: '少油炒熟' } })
    fireEvent.change(recipe.getByLabelText('食材（每行：名称 | 数量 | 单位）'), { target: { value: '鸡蛋 | 2 | 个\n番茄 | 2 | 个' } })
    fireEvent.click(recipe.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/dishes/dish-1') && init?.method === 'PATCH' && JSON.parse(String(init.body)).ingredients.length === 2)).toBe(true))
    expect(await screen.findByText('少油炒熟')).toBeInTheDocument()
  }, 70000)

  it('sorts common dishes by Chinese pinyin in the meal selector', async () => {
    mockApi([], false, [
      { id: 'dish-n', name: '农家小炒肉', instructions: '', nutrition_notes: '', notes: '', ingredients: [] },
      { id: 'dish-k', name: '可乐鸡全翅', instructions: '', nutrition_notes: '', notes: '', ingredients: [] },
      { id: 'dish-t', name: '土豆炖牛腩', instructions: '', nutrition_notes: '', notes: '', ingredients: [] },
      { id: 'dish-p', name: '平菇炒肉', instructions: '', nutrition_notes: '', notes: '', ingredients: [] },
      { id: 'dish-q', name: '清炒小南瓜丝', instructions: '', nutrition_notes: '', notes: '', ingredients: [] },
    ])
    render(<DietPage />)
    fireEvent.click(await screen.findByRole('button', { name: '安排一餐' }))
    const dialog = within(screen.getByRole('dialog', { name: '安排一餐' }))
    fireEvent.click(dialog.getByRole('button', { name: '选择菜品' }))
    const options = within(dialog.getByRole('group', { name: '常用菜品' }))

    expect(options.getAllByRole('checkbox').map((checkbox) => checkbox.parentElement?.textContent)).toEqual([
      '可乐鸡全翅',
      '农家小炒肉',
      '平菇炒肉',
      '清炒小南瓜丝',
      '土豆炖牛腩',
    ])
  }, 70000)

  it('keeps several selected dishes when reopening a meal and updates the calendar name', async () => {
    const fetchMock = mockApi([], false, [
      { id: 'dish-1', name: '西红柿炒鸡蛋', instructions: '', nutrition_notes: '', notes: '', ingredients: [] },
      { id: 'dish-2', name: '米饭', instructions: '', nutrition_notes: '', notes: '', ingredients: [] },
    ])
    render(<DietPage />)
    fireEvent.click(await screen.findByRole('button', { name: '安排一餐' }))
    const editor = within(screen.getByRole('dialog', { name: '安排一餐' }))
    fireEvent.click(editor.getByRole('button', { name: '选择菜品' }))
    fireEvent.click(editor.getByRole('checkbox', { name: '西红柿炒鸡蛋' }))
    fireEvent.click(editor.getByRole('checkbox', { name: '米饭' }))
    expect(editor.getByRole('checkbox', { name: '西红柿炒鸡蛋' })).toBeChecked()
    expect(editor.getByRole('checkbox', { name: '米饭' })).toBeChecked()
    fireEvent.click(editor.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/meals') && init?.method === 'POST' && JSON.parse(String(init.body)).dish_ids.join(',') === 'dish-1,dish-2')).toBe(true))
    expect(await screen.findByText('西红柿炒鸡蛋、米饭')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(`修改 ${dayjs().format('YYYY-MM-DD')} 晚餐`))
    const reopened = within(screen.getByRole('dialog', { name: '修改饮食安排' }))
    fireEvent.click(reopened.getByRole('button', { name: '选择菜品' }))
    expect(reopened.getByRole('checkbox', { name: '西红柿炒鸡蛋' })).toBeChecked()
    expect(reopened.getByRole('checkbox', { name: '米饭' })).toBeChecked()
  }, 30000)

  it('saves manual changes and follows a meal moved into another month', async () => {
    const fetchMock = mockApi([meal('one', { actual_food: '蔬菜沙拉' })])
    render(<DietPage />)
    fireEvent.click(await screen.findByLabelText('修改 2026-10-07 午餐'))
    fireEvent.change(screen.getByLabelText('或填写其他餐食'), { target: { value: '鸡胸肉沙拉' } })
    expect(screen.queryByLabelText('实际饮食（可选）')).not.toBeInTheDocument()
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
