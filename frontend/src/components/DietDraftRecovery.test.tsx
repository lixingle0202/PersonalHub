import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapApi } from '../api/client'
import { AIDietGenerator } from './AIDietGenerator'
import { DietTemplates } from './DietTemplates'
import { dietDraftScope, getDietDraft } from '../api/dietDraft'

const plan = { name: '恢复菜单', description: '草稿', cycle_days: 1, meals: [
  { day_number: 1, meal_type: 'breakfast', name: '燕麦牛奶', estimated_kcal: 400 },
] }
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear() })

describe('diet draft navigation recovery', () => {
  it('keeps generating while unmounted and shows the result when the page returns', async () => {
    let release!: (value: Response) => void
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url)
      if (path.endsWith('/bootstrap')) return json({ app_name: 'PersonalHub', local_token: 'token', database_path: 'test', public_mode: true, desktop_mode: true, username: 'navigation' })
      if (path.endsWith('/settings')) return json({ base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:1.5b' })
      if (path.endsWith('/generate')) return new Promise<Response>((resolve) => { release = resolve })
      return json({})
    })
    await bootstrapApi()
    const first = render(<AIDietGenerator onGenerated={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成菜谱 / 模板' }))
    const start = await screen.findByRole('button', { name: '生成可编辑草稿' })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)
    expect(await screen.findByRole('button', { name: '收起，继续生成' })).toBeInTheDocument()
    first.unmount()
    const callback = vi.fn()
    render(<AIDietGenerator onGenerated={callback} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成菜谱 / 模板' }))
    expect(await screen.findByRole('button', { name: '取消生成' })).toBeInTheDocument()
    await act(async () => { release(new Response(JSON.stringify({ plan }))) })
    expect(await screen.findByText('恢复菜单')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑、保存或导入日历' }))
    expect(callback).toHaveBeenCalledWith(plan)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/generate'))).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  it('restores edited AI draft fields and clears the saved draft only after a successful save', async () => {
    let fail = true
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const path = String(url)
      if (path.endsWith('/bootstrap')) return json({ app_name: 'PersonalHub', local_token: 'token', database_path: 'test', public_mode: true, username: 'edit-recovery' })
      if (path.endsWith('/diet/templates') && init?.method === 'POST') return fail
        ? Promise.resolve(new Response(JSON.stringify({ detail: '保存失败，请重试' }), { status: 503 }))
        : json({ ...plan, id: 'saved', builtin: false })
      return json([])
    })
    await bootstrapApi()
    sessionStorage.setItem(dietDraftScope(), JSON.stringify({ version: 1, state: 'completed', plan, editor: { name: '修改后的菜单', description: '少油', cycleDays: 1, lines: '1 | 早餐 | 牛奶燕麦 | 380' } }))
    const first = render(<DietTemplates onImported={vi.fn()} />)
    const editor = within(await screen.findByRole('dialog', { name: '创建饮食模板' }))
    expect(editor.getByLabelText('模板名称')).toHaveValue('修改后的菜单')
    fireEvent.change(editor.getByLabelText('模板名称'), { target: { value: '继续编辑后的菜单' } })
    await waitFor(() => expect(getDietDraft().editor?.name).toBe('继续编辑后的菜单'))
    first.unmount()
    render(<DietTemplates onImported={vi.fn()} />)
    const recovered = within(await screen.findByRole('dialog', { name: '创建饮食模板' }))
    expect(recovered.getByLabelText('模板名称')).toHaveValue('继续编辑后的菜单')
    fireEvent.click(recovered.getByRole('button', { name: '保存模板' }))
    await screen.findAllByText('保存失败，请重试')
    expect(getDietDraft().plan).toEqual(plan)
    fail = false
    fireEvent.click(recovered.getByRole('button', { name: '保存模板' }))
    await waitFor(() => expect(getDietDraft().state).toBe('idle'))
    expect(sessionStorage.getItem(dietDraftScope())).toBeNull()
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/diet/templates') && init?.method === 'POST')).toHaveLength(2)
  })
})
