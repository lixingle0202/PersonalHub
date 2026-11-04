import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { MealFoodInput } from './MealFoodInput'

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return <><label htmlFor="foods">餐食</label><MealFoodInput id="foods" value={value} onChange={setValue} /><output data-testid="saved-foods">{value}</output></>
}

beforeEach(() => {
  vi.restoreAllMocks(); setLocalToken('test-token')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    items: [{ name: '蛋炒饭', label: '蛋炒饭 · 1份参考约413 kcal' }], food_count: 2213, recipe_count: 190,
  }), { headers: { 'Content-Type': 'application/json' } }))
})

it('adds and removes individual foods and preserves quantities when an existing meal is reopened', async () => {
  render(<Harness initial={'米饭200g\n西红柿炒鸡蛋0.5份'} />)
  expect(screen.getByLabelText('餐食')).toHaveValue('米饭200g')
  expect(screen.getByLabelText('第2项餐食')).toHaveValue('西红柿炒鸡蛋0.5份')
  fireEvent.click(screen.getByRole('button', { name: '＋ 添加一道菜或主食' }))
  fireEvent.change(screen.getByLabelText('第3项餐食'), { target: { value: '蛋炒饭200g' } })
  expect(screen.getByTestId('saved-foods').textContent).toBe('米饭200g\n西红柿炒鸡蛋0.5份\n蛋炒饭200g')
  fireEvent.click(screen.getByRole('button', { name: '移除第2项餐食' }))
  expect(screen.getByTestId('saved-foods').textContent).toBe('米饭200g\n蛋炒饭200g')
  expect(screen.getByLabelText('第2项餐食')).toHaveValue('蛋炒饭200g')
})

it('searches bundled food references, shows provenance, and selects a known dish', async () => {
  render(<Harness />)
  const input = screen.getByLabelText('餐食')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: '蛋炒' } })
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('food-references?q=%E8%9B%8B%E7%82%92'), expect.anything()), { timeout: 10000 })
  fireEvent.click(await screen.findByText('蛋炒饭 · 1份参考约413 kcal'))
  expect(input).toHaveValue('蛋炒饭')
  expect(await screen.findByText(/2,213 项食物数据、190 道常见菜参考配方/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '食物数据来源：食品药物管理署' })).toHaveAttribute('href', 'https://data.gov.tw/dataset/8543')
}, 30000)

it('suggests food in another row and preserves its grams and other rows on selection', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
    items: [{ name: '小炒金钱蛋', label: '小炒金钱蛋 · 1份参考约331 kcal' }], food_count: 2213, recipe_count: 190,
  })))
  render(<Harness initial={'米饭200g\n金钱200g'} />)
  const input = screen.getByLabelText('第2项餐食')
  fireEvent.focus(input)
  fireEvent.click(await screen.findByText('小炒金钱蛋 · 1份参考约331 kcal'))
  expect(input).toHaveValue('小炒金钱蛋200g')
  expect(screen.getByTestId('saved-foods').textContent).toBe('米饭200g\n小炒金钱蛋200g')
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('q=%E9%87%91%E9%92%B1&'), expect.anything())
}, 30000)

it('keeps a slower previous search from replacing suggestions for the current characters', async () => {
  let release: (value: Response) => void = () => undefined
  vi.mocked(fetch).mockImplementation(async (url) => {
    const query = new URL(String(url), 'http://localhost').searchParams.get('q')
    if (query === '金钱') return new Promise<Response>((resolve) => { release = resolve })
    return new Response(JSON.stringify({ items: [{ name: '土豆炖牛肉', label: '土豆炖牛肉 · 1份参考约394 kcal' }] }))
  })
  render(<Harness />)
  const input = screen.getByLabelText('餐食')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: '金钱' } })
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('q=%E9%87%91%E9%92%B1&'), expect.anything()))
  fireEvent.change(input, { target: { value: '土豆' } })
  expect(await screen.findByText('土豆炖牛肉 · 1份参考约394 kcal')).toBeInTheDocument()
  await act(async () => release(new Response(JSON.stringify({ items: [{ name: '小炒金钱蛋', label: '旧的金钱蛋搜索结果' }] }))))
  expect(screen.queryByText('旧的金钱蛋搜索结果')).not.toBeInTheDocument()
  expect(input).toHaveValue('土豆')
}, 30000)
