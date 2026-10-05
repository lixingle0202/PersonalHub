import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { loadPageModule, PageLoadErrorBoundary } from './pageLoadRecovery'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('page module recovery', () => {
  it('reloads once when an older open page requests a removed build asset', async () => {
    const reload = vi.fn()
    const storage = memoryStorage()
    let settled = false

    void loadPageModule(
      () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/LearningPage-old.js')),
      { reload, storage, href: () => '/learning', now: () => 1_000 },
    ).finally(() => { settled = true })

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(storage.getItem('personalhub:page-reload:/learning')).toBe('1000')
    expect(settled).toBe(false)
  })

  it('does not enter a refresh loop when the same asset still fails immediately', async () => {
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/LearningPage-old.js')
    const reload = vi.fn()
    const storage = memoryStorage({ 'personalhub:page-reload:/learning': '1000' })

    await expect(loadPageModule(
      () => Promise.reject(error),
      { reload, storage, href: () => '/learning', now: () => 2_000 },
    )).rejects.toBe(error)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload for an ordinary page programming error', async () => {
    const error = new Error('render failed')
    const reload = vi.fn()

    await expect(loadPageModule(
      () => Promise.reject(error),
      { reload, storage: memoryStorage(), href: () => '/learning', now: () => 1_000 },
    )).rejects.toBe(error)
    expect(reload).not.toHaveBeenCalled()
  })

  it('shows a retry panel instead of a blank app when recovery cannot load the page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const BrokenPage = () => { throw new Error('page failed') }

    render(<PageLoadErrorBoundary resetKey="/learning"><BrokenPage /></PageLoadErrorBoundary>)

    expect(screen.getByText('读取失败')).toBeInTheDocument()
    expect(screen.getByText('页面文件加载失败，请刷新到最新版本。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
  })
})
