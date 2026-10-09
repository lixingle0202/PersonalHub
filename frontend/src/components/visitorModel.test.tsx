import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapApi } from '../api/client'
import { loopbackUrl, readVisitorModel, saveVisitorModel, visitorModels } from '../api/visitorModel'
import { AILearningGenerator } from './AILearningGenerator'
import { OllamaSettingsPanel } from './OllamaSettingsPanel'

const shared = { base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:1.5b' }
const output = { name: '两天学习', goal: '完成练习', sections: ['入门', '练习'], tasks: [
  { day_number: 1, section_index: 0, title: '学习界面', minutes: 30, notes: '练习' },
  { day_number: 2, section_index: 1, title: '完成应用', minutes: 30, notes: '练习' },
] }
const plan = { name: '两天学习', goal: '完成练习', start_date: '2026-12-31', target_date: '2027-01-01', daily_minutes: 45,
  sections: ['入门', '练习'], tasks: output.tasks.map((task, index) => ({ ...task, plan_date: index ? '2027-01-01' : '2026-12-31' })) }
const draft = { id: 'visitor-draft', plan, imported_goal_id: null }
function json(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) }

function mockRequests() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input)
    if (url.endsWith('/api/v1/bootstrap')) return json({ app_name: 'PersonalHub', version: 'test', local_token: 'alice-token', database_path: '独立空间', public_mode: true, username: 'alice' })
    if (url.endsWith('/ai/ollama/settings')) return json(shared)
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'qwen2.5:3b' }] })
    if (url.endsWith('/learning/visitor/prepare')) return json({ stream: false, messages: [{ role: 'user', content: 'Android' }], format: { type: 'object' } })
    if (url.endsWith('/api/chat')) return json({ message: { content: JSON.stringify(output) }, done: true })
    if (url.endsWith('/learning/visitor/draft') || url.endsWith('/learning/generate')) return json(draft)
    if (url.endsWith('/visitor-draft/import')) return json({ id: 'goal-1' }, 201)
    return json({}, 404)
  })
}

async function fillGenerator() {
  fireEvent.click(screen.getByRole('button', { name: 'AI 生成学习计划' }))
  const dialog = within(await screen.findByRole('dialog'))
  await waitFor(() => expect(dialog.getByRole('button', { name: '生成草稿' })).toBeEnabled())
  fireEvent.change(dialog.getByLabelText('学习主题'), { target: { value: 'Android' } })
  fireEvent.change(dialog.getByLabelText('希望达到的目标'), { target: { value: '完成应用' } })
  return dialog
}

describe('public visitors choose shared or their own loopback Ollama', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    mockRequests()
    await bootstrapApi()
  })

  it('uses the shared model by default without contacting a visitor Ollama', async () => {
    const onImported = vi.fn()
    const fetchMock = vi.mocked(globalThis.fetch)
    render(<AILearningGenerator onImported={onImported} />)
    const dialog = await fillGenerator()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    expect(await screen.findByLabelText('计划名称')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/learning/generate'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/chat'))).toBe(false)
  })

  it('saves a selected visitor model, calls only browser loopback, validates and imports its draft', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    const settings = render(<OllamaSettingsPanel />)
    expect(await screen.findByText(/无需在这台电脑安装 Ollama/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('本地大模型'))
    fireEvent.click(screen.getByRole('button', { name: '检查连接并刷新模型' }))
    expect(await screen.findByText('已连接，发现 1 个本机模型')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存并使用本地模型' }))
    await waitFor(() => expect(readVisitorModel()).toMatchObject({ provider: 'local', model: 'qwen2.5:3b' }))
    settings.unmount()

    const onImported = vi.fn()
    render(<AILearningGenerator onImported={onImported} />)
    const dialog = await fillGenerator()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    expect(await screen.findByLabelText('计划名称')).toHaveValue('两天学习')
    const localCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/chat'))!
    expect(String(localCall[0])).toBe('http://127.0.0.1:11434/api/chat')
    expect(JSON.parse(String(localCall[1]?.body)).model).toBe('qwen2.5:3b')
    expect(localCall[1]).toMatchObject({ mode: 'cors', credentials: 'omit', redirect: 'error' })
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/learning/visitor/draft'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/learning/generate'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '确认加入学习计划' }))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('goal-1'))
  })

  it('rejects non-loopback URLs before sending browser requests', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    for (const url of ['https://example.com', 'http://192.168.1.2:11434', 'http://user:pass@127.0.0.1:11434', 'http://127.0.0.1:11434/other']) {
      expect(() => loopbackUrl(url)).toThrow()
      await expect(visitorModels(url)).rejects.toThrow()
    }
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/tags'))).toBe(false)
  })

  it('keeps each public account’s model choice separate in the same browser', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    saveVisitorModel({ provider: 'local', base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b' })
    fetchMock.mockImplementationOnce(() => json({ app_name: 'PersonalHub', version: 'test', local_token: 'bob-token', database_path: '独立空间', public_mode: true, username: 'bob' }))
    await bootstrapApi()
    expect(readVisitorModel()).toMatchObject({ provider: 'shared', model: '' })
    fetchMock.mockImplementationOnce(() => json({ app_name: 'PersonalHub', version: 'test', local_token: 'alice-token', database_path: '独立空间', public_mode: true, username: 'alice' }))
    await bootstrapApi()
    expect(readVisitorModel()).toMatchObject({ provider: 'local', model: 'qwen2.5:3b' })
  })
})
