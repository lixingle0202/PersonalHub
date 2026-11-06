import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OllamaSettingsPanel } from './OllamaSettingsPanel'
import { apiRequest } from '../api/client'

vi.mock('../api/client', () => ({ apiRequest: vi.fn(), isPublicMode: () => true, isDesktopMode: () => true }))

const builtin = { source: 'builtin', base_url: 'http://127.0.0.1:11435', model: 'qwen2.5:1.5b' }
const custom = { source: 'local', base_url: 'http://127.0.0.1:11434', model: 'other:7b' }

describe('desktop model selection', () => {
  beforeEach(() => vi.resetAllMocks())

  it('refreshes installed models and saves the selection for both generators', async () => {
    vi.mocked(apiRequest).mockImplementation(async (path, init) => {
      if (path === '/desktop/ai/settings' && init?.method === 'PUT') return custom
      if (path === '/desktop/ai/settings') return builtin
      if (path === '/desktop/ai/status') return { ...builtin, ready: true }
      if (path === '/desktop/ai/models') return { models: ['other:7b'] }
      throw new Error('Unexpected request')
    })
    render(<OllamaSettingsPanel />)
    await waitFor(() => expect(screen.getByRole('radio', { name: '其他本机 Ollama 模型' })).toBeEnabled())
    fireEvent.click(screen.getByRole('radio', { name: '其他本机 Ollama 模型' }))
    expect(screen.getByLabelText('Ollama 地址')).toHaveValue('http://127.0.0.1:11434')
    fireEvent.click(screen.getByRole('button', { name: '刷新模型列表' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并切换' })).toBeEnabled())
    expect(screen.getByText('other:7b')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存并切换' }))
    await screen.findByText('当前使用 · 本机 Ollama · other:7b')
    expect(apiRequest).toHaveBeenCalledWith('/desktop/ai/settings', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ base_url: custom.base_url, model: custom.model, source: 'local' }),
    }))
  }, 20000)

  it('restores the saved choice and can switch back to the bundled model', async () => {
    vi.mocked(apiRequest).mockImplementation(async (path, init) => {
      if (path === '/desktop/ai/settings' && init?.method === 'PUT') return builtin
      if (path === '/desktop/ai/settings') return custom
      if (path === '/desktop/ai/status') return { ...custom, ready: true }
      throw new Error('Unexpected request')
    })
    render(<OllamaSettingsPanel />)
    await waitFor(() => expect(screen.getByRole('radio', { name: '其他本机 Ollama 模型' })).toBeChecked())
    expect(screen.getByLabelText('Ollama 地址')).toHaveValue(custom.base_url)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并切换' })).toBeEnabled())
    // A bad address in the unsubmitted custom form must not prevent resetting.
    fireEvent.change(screen.getByLabelText('Ollama 地址'), { target: { value: 'invalid-address' } })
    fireEvent.click(screen.getByRole('radio', { name: '内置模型' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并切换' }))
    await screen.findByText('当前使用 · 内置模型 · qwen2.5:1.5b')
    expect(apiRequest).toHaveBeenCalledWith('/desktop/ai/settings', expect.objectContaining({ method: 'PUT', body: '{"source":"builtin"}' }))
  }, 20000)

  it('keeps the current model visible when saving an unavailable service fails', async () => {
    vi.mocked(apiRequest).mockImplementation(async (path, init) => {
      if (init?.method === 'PUT') throw new Error('无法连接此 Ollama')
      if (path === '/desktop/ai/settings') return builtin
      return { ...builtin, ready: true }
    })
    render(<OllamaSettingsPanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并切换' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '保存并切换' }))
    await screen.findByText('无法连接此 Ollama')
    expect(screen.getByText('当前使用 · 内置模型 · qwen2.5:1.5b')).toBeInTheDocument()
  }, 20000)
})
