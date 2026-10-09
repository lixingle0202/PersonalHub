import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapApi } from '../api/client'
import { saveVisitorModel } from '../api/visitorModel'
import { AIDietGenerator } from './AIDietGenerator'

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))

describe('visitor diet model selection', () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.clear() })

  it('uses the visitor browser’s Ollama and validates the menu before showing it', async () => {
    const plan = { name: '本地菜单', description: '自选', cycle_days: 1, meals: [
      { day_number: 1, meal_type: 'breakfast', name: '鸡蛋燕麦', estimated_kcal: 400 },
      { day_number: 1, meal_type: 'lunch', name: '米饭鸡肉', estimated_kcal: 650 },
      { day_number: 1, meal_type: 'dinner', name: '清蒸鱼', estimated_kcal: 600 },
    ] }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input)
      if (path === '/api/v1/bootstrap') return json({ app_name: 'PersonalHub', version: 'test', local_token: 'token', database_path: 'account', public_mode: true, username: 'bob' })
      if (path === 'http://127.0.0.1:11434/api/tags') return json({ models: [{ name: 'qwen2.5:1.5b' }] })
      if (path.endsWith('/ai/diet/visitor/prepare')) return json({ stream: false, format: { type: 'object' } })
      if (path === 'http://127.0.0.1:11434/api/chat') return json({ message: { content: JSON.stringify(plan) }, done: true })
      if (path.endsWith('/ai/diet/visitor/draft')) return json({ plan })
      return json({})
    })
    await bootstrapApi()
    saveVisitorModel({ provider: 'local', base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:1.5b' })
    const onGenerated = vi.fn()
    render(<AIDietGenerator onGenerated={onGenerated} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成菜谱 / 模板' }))
    fireEvent.click(await screen.findByRole('button', { name: '生成可编辑草稿' }))
    expect(await screen.findByText(/鸡蛋燕麦 · 约 400 kcal/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑、保存或导入日历' }))
    expect(onGenerated).toHaveBeenCalledWith(plan)
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === 'http://127.0.0.1:11434/api/chat')).toBe(true))
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/ai/diet/generate'))).toBe(false)
  })
})
