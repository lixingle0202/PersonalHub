import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Form, Input, InputNumber } from 'antd'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaloriePreview } from './CaloriePreview'
import { setLocalToken } from '../api/client'

function response(kcal: number | null, explanation = '五花肉120克≈419 kcal + 食用油8克≈71 kcal；按参考配方估算') {
  return new Response(JSON.stringify({ display_kcal: kcal, calorie_source: kcal == null ? '待补充' : '参考配方', calorie_explanation: explanation }), { headers: { 'Content-Type': 'application/json' } })
}

function Harness({ name = '农家小炒肉' }: { name?: string }) {
  return <Form initialValues={{ custom_name: name, servings: 1, estimated_kcal: null }}>
    <Form.Item name="custom_name" label="餐食"><Input /></Form.Item>
    <Form.Item name="servings" label="份数"><InputNumber /></Form.Item>
    <Form.Item name="estimated_kcal" label="手动热量"><InputNumber /></Form.Item>
    <CaloriePreview />
  </Form>
}

describe('meal calorie preview', () => {
  beforeEach(() => { vi.restoreAllMocks(); setLocalToken('test-token') })

  it('shows ingredient assumptions before saving and recalculates when portions change', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      return response(532 * body.servings)
    })
    render(<Harness />)
    expect(await screen.findByText('本餐约 532 kcal · 参考配方', {}, { timeout: 10000 })).toBeInTheDocument()
    expect(screen.getByText(/五花肉120克/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('份数'), { target: { value: '0.5' } })
    expect(await screen.findByText('本餐约 266 kcal · 参考配方', {}, { timeout: 10000 })).toBeInTheDocument()
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/diet/calories/estimate'))).toBe(true)
  }, 30000)

  it('does not show an older estimate after the food changes and the slower request finishes', async () => {
    let release: (value: Response) => void = () => undefined
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve }))
      .mockImplementationOnce(async () => response(260, '米饭200克'))
    render(<Harness />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('餐食'), { target: { value: '米饭200克' } })
    expect(await screen.findByText('本餐约 260 kcal · 参考配方', {}, { timeout: 10000 })).toBeInTheDocument()
    await act(async () => release(response(532)))
    expect(screen.queryByText('本餐约 532 kcal · 参考配方')).not.toBeInTheDocument()
    expect(screen.getByText('米饭200克')).toBeInTheDocument()
  }, 30000)

  it('keeps unknown food unestimated and supports retrying a request failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ detail: '暂时无法估算' }), { status: 503 }))
      .mockImplementationOnce(async () => response(null, '未知酱料需补充用量或每份热量'))
    render(<Harness name="未知酱料" />)
    fireEvent.click(await screen.findByRole('button', { name: '重试估算' }, { timeout: 10000 }))
    expect(await screen.findByText('热量待补充', {}, { timeout: 10000 })).toBeInTheDocument()
    expect(screen.getByText('未知酱料需补充用量或每份热量')).toBeInTheDocument()
    expect(screen.queryByText(/本餐约/)).not.toBeInTheDocument()
  }, 30000)
})
