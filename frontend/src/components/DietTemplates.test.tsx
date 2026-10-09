import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapApi, setLocalToken } from '../api/client'
import { DietTemplates } from './DietTemplates'

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
const example = { id: 'preset:example', name: '减脂餐模板', description: '示例', cycle_days: 1, builtin: true,
  meals: [{ day_number: 1, meal_type: 'breakfast', name: '燕麦牛奶', estimated_kcal: 400 }] }

describe('recurring diet templates', () => {
  beforeEach(() => { vi.restoreAllMocks(); setLocalToken('diet-template-test-token') })

  it('previews built-in meals and imports a chosen cycle without overwriting existing slots', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/diet/templates')) return json([example])
      if (String(input).includes('/import') && init?.method === 'POST') return json({ imported: 5, skipped: 2 })
      return json({})
    })
    const onImported = vi.fn()
    render(<DietTemplates onImported={onImported} />)
    expect(await screen.findByText('第 1 天 · 早餐：燕麦牛奶 · 约 400 kcal')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '导入日历' }))
    const dialog = within(screen.getByRole('dialog', { name: '导入「减脂餐模板」' }))
    fireEvent.change(dialog.getByLabelText('模板导入天数'), { target: { value: '3' } })
    fireEvent.click(dialog.getByRole('button', { name: '确认导入' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/import') && init?.method === 'POST' && JSON.parse(String(init.body)).days === 3)).toBe(true))
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1))
  })

  it('generates a shared-model menu with calories, then saves and imports the editable draft', async () => {
    const plan = { name: 'AI 一日菜单', description: '可编辑', cycle_days: 1, meals: [
      { day_number: 1, meal_type: 'breakfast', name: '燕麦鸡蛋', estimated_kcal: 400 },
      { day_number: 1, meal_type: 'lunch', name: '鸡肉饭', estimated_kcal: 650 },
      { day_number: 1, meal_type: 'dinner', name: '鱼肉面', estimated_kcal: 600 },
    ] }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input)
      if (path === '/api/v1/bootstrap') return json({ app_name: 'PersonalHub', version: 'test', local_token: 'token', database_path: 'account', public_mode: true, username: 'alice' })
      if (path.endsWith('/ai/ollama/settings')) return json({ base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:1.5b' })
      if (path.endsWith('/ai/diet/generate') && init?.method === 'POST') return json({ plan })
      if (path.endsWith('/diet/templates') && init?.method === 'POST') return json({ ...plan, id: 'new-template', builtin: false })
      if (path.endsWith('/diet/templates')) return json([example])
      if (path.endsWith('/diet/templates/new-template/import')) return json({ imported: 3, skipped: 0 })
      return json({})
    })
    await bootstrapApi()
    const onImported = vi.fn()
    render(<DietTemplates onImported={onImported} />)
    fireEvent.click(await screen.findByRole('button', { name: 'AI 生成菜谱 / 模板' }))
    fireEvent.click(await screen.findByRole('button', { name: '生成可编辑草稿' }))
    expect(await screen.findByText('第 1 天 · 早餐：燕麦鸡蛋 · 约 400 kcal')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑、保存或导入日历' }))
    const editorNode = (await screen.findByText('创建饮食模板')).closest<HTMLElement>('[role="dialog"]')!
    await waitFor(() => expect(editorNode).toBeVisible())
    const editor = within(editorNode)
    expect((editor.getByLabelText('模板餐食') as HTMLTextAreaElement).value).toContain('燕麦鸡蛋')
    fireEvent.click(editor.getByRole('button', { name: '保存并导入日历' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/diet/templates/new-template/import') && init?.method === 'POST')).toBe(true))
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1))
  }, 30000)
})
