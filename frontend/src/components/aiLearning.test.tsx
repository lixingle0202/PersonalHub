import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import dayjs from 'dayjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest, setLocalToken } from '../api/client'
import { AILearningGenerator, type LearningPreview } from './AILearningGenerator'
import { OllamaSettingsPanel } from './OllamaSettingsPanel'

const config = { base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b' }
const plan: LearningPreview = {
  name: 'Android 入门', goal: '完成一个应用', start_date: '2026-12-31', target_date: '2027-01-01', daily_minutes: 45,
  sections: ['界面', '状态'],
  tasks: [
    { title: '创建界面', plan_date: '2026-12-31', section_index: 0, minutes: 45, notes: '做一个按钮' },
    { title: '保存状态', plan_date: '2027-01-01', section_index: 1, minutes: 30, notes: '练习状态更新' },
  ],
}
const draft = { id: 'draft-1', plan, imported_goal_id: null }
function json(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) }

function mockApi(options: { unconfigured?: boolean; offline?: boolean; invalid?: boolean; failImport?: boolean } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input)
    if (url.endsWith('/ollama/settings')) return json(options.unconfigured ? { ...config, model: '' } : config)
    if (url.endsWith('/ollama/models')) return options.offline ? json({ detail: '无法连接本机 Ollama，请先启动' }, 503) : json({ models: [config.model] })
    if (url.endsWith('/learning/generate')) return options.invalid ? json({ detail: '生成的学习计划未通过校验，尚未写入' }, 502) : json(draft)
    if (url.endsWith('/import') && init?.method === 'POST') return options.failImport ? json({ detail: '导入暂时失败，可重试' }, 500) : json({ id: 'goal-1' }, 201)
    if (url.includes('/drafts/')) return json(draft)
    return json({}, 404)
  })
}

async function openAndFill() {
  fireEvent.click(screen.getByRole('button', { name: 'AI 生成学习计划' }))
  const dialog = within(await screen.findByRole('dialog'))
  await waitFor(() => expect(dialog.getByRole('button', { name: '生成草稿' })).toBeEnabled())
  fireEvent.change(dialog.getByLabelText('学习主题'), { target: { value: 'Android' } })
  fireEvent.change(dialog.getByLabelText('希望达到的目标'), { target: { value: '完成一个待办应用' } })
  return dialog
}

describe('local model configuration and learning-plan preview', () => {
  beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); setLocalToken('test-token') })

  it('does not mount hidden generation fields before opening, keeping the existing goal editor unambiguous', () => {
    const fetchMock = mockApi()
    render(<AILearningGenerator onImported={vi.fn()} />)
    expect(screen.queryByLabelText('学习主题')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('checks the local model connection and saves the chosen configuration', async () => {
    const fetchMock = mockApi()
    render(<OllamaSettingsPanel />)
    expect(await screen.findByDisplayValue('qwen2.5:3b')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '检查连接并刷新模型' }))
    expect(await screen.findByText('已连接，发现 1 个本地模型')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存模型设置' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/ollama/settings') && init?.method === 'PUT' && JSON.parse(String(init.body)).model === config.model)).toBe(true))
  })

  it('explains missing configuration without issuing a generation request', async () => {
    const fetchMock = mockApi({ unconfigured: true })
    render(<AILearningGenerator onImported={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成学习计划' }))
    expect(await screen.findByText('请先配置本地模型')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成草稿' })).toBeDisabled()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/generate'))).toBe(false)
  })

  it('shows an offline Ollama message and disables generation', async () => {
    mockApi({ offline: true })
    render(<AILearningGenerator onImported={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成学习计划' }))
    expect(await screen.findByText('无法连接本机 Ollama，请先启动')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成草稿' })).toBeDisabled()
  })

  it('previews and edits generated tasks, removes unwanted tasks and imports only after confirmation', async () => {
    const onImported = vi.fn()
    const fetchMock = mockApi()
    render(<AILearningGenerator onImported={onImported} />)
    const dialog = await openAndFill()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    expect(await screen.findByText('这是可编辑草稿，确认前不会加入正式计划')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/import'))).toBe(false)
    const generation = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/generate'))!
    expect(JSON.parse(String(generation[1]?.body))).toMatchObject({ topic: 'Android', start_date: dayjs().format('YYYY-MM-DD'), days: 7, daily_minutes: 45 })
    fireEvent.change(screen.getByLabelText('计划名称'), { target: { value: '我的 Android 计划' } })
    fireEvent.change(screen.getByLabelText('任务 1 标题'), { target: { value: '先完成布局练习' } })
    fireEvent.change(screen.getByLabelText('任务 1 分钟'), { target: { value: '35' } })
    fireEvent.click(screen.getByRole('button', { name: '移除任务 2' }))
    expect(screen.queryByLabelText('任务 2 标题')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认加入学习计划' }))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('goal-1'))
    const imported = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/drafts/draft-1/import'))!
    expect(JSON.parse(String(imported[1]?.body))).toMatchObject({ name: '我的 Android 计划', tasks: [{ title: '先完成布局练习', minutes: 35 }] })
    expect(sessionStorage.getItem('personalhub:ai-learning-draft')).toBeNull()
  })

  it('removes a generated chapter with its tasks and reindexes the remaining plan before import', async () => {
    const fetchMock = mockApi()
    render(<AILearningGenerator onImported={vi.fn()} />)
    const dialog = await openAndFill()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    await dialog.findByLabelText('章节 1')
    fireEvent.click(dialog.getByRole('button', { name: '移除章节 1' }))
    expect(dialog.queryByLabelText('任务 2 标题')).not.toBeInTheDocument()
    expect(dialog.getByLabelText('章节 1')).toHaveValue('状态')
    fireEvent.click(dialog.getByRole('button', { name: '确认加入学习计划' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/drafts/draft-1/import'))).toBe(true))
    const imported = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/drafts/draft-1/import'))!
    const body = JSON.parse(String(imported[1]?.body)) as LearningPreview
    expect(body.sections).toEqual(['状态'])
    expect(body.tasks).toEqual([expect.objectContaining({ title: '保存状态', section_index: 0 })])
  })

  it('retains the preview after import failure so confirmation can be retried', async () => {
    const onImported = vi.fn()
    mockApi({ failImport: true })
    render(<AILearningGenerator onImported={onImported} />)
    const dialog = await openAndFill()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    await screen.findByLabelText('计划名称')
    fireEvent.click(screen.getByRole('button', { name: '确认加入学习计划' }))
    expect(await screen.findByText('导入暂时失败，可重试')).toBeInTheDocument()
    expect(screen.getByLabelText('计划名称')).toHaveValue('Android 入门')
    expect(onImported).not.toHaveBeenCalled()
  })

  it('does not display a usable preview when generation fails validation', async () => {
    mockApi({ invalid: true })
    render(<AILearningGenerator onImported={vi.fn()} />)
    const dialog = await openAndFill()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    expect(await screen.findByText('生成的学习计划未通过校验，尚未写入')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认加入学习计划' })).not.toBeInTheDocument()
    expect(dialog.getByRole('button', { name: '生成草稿' })).toBeEnabled()
  })

  it('restores a persisted draft after reopening without generating a second plan', async () => {
    sessionStorage.setItem('personalhub:ai-learning-draft', 'draft-1')
    const fetchMock = mockApi()
    render(<AILearningGenerator onImported={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成学习计划' }))
    expect(await screen.findByLabelText('计划名称')).toHaveValue('Android 入门')
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/generate'))).toBe(false)
  })

  it.each(['close', 'unmount'])('cancels waiting for a slow generation on %s without importing any plan', async (action) => {
    const fetchMock = mockApi()
    const normal = fetchMock.getMockImplementation()!
    let aborted = false
    fetchMock.mockImplementation((input, init) => String(input).endsWith('/generate') ? new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')) })
    }) : normal(input, init))
    const view = render(<AILearningGenerator onImported={vi.fn()} />)
    const dialog = await openAndFill()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    await screen.findByText('本地模型正在生成，请稍候')
    if (action === 'unmount') view.unmount()
    else fireEvent.click(dialog.getByRole('button', { name: '取消等待' }))
    await waitFor(() => expect(aborted).toBe(true))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/import'))).toBe(false)
  })

  it('shows server validation details as readable text', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ detail: [{ msg: '每日时长超出限制' }] }, 422))
    await expect(apiRequest('/ai/learning/drafts/draft-1/import', { method: 'POST' })).rejects.toThrow('每日时长超出限制')
  })
})
