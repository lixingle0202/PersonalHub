import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocalToken } from './client'
import { generateSharedDraft } from './sharedModel'

function json(body: unknown, status: number) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }))
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('shared model busy retry', () => {
  it('waits after model_busy, then returns the generated draft without changing the request', async () => {
    vi.useFakeTimers()
    setLocalToken('test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => json({ detail: 'busy', code: 'model_busy' }, 429))
      .mockImplementationOnce(() => json({ id: 'draft-1' }, 200))
    const waiting = vi.fn()
    const pending = generateSharedDraft<{ id: string }>({ topic: '英语六级' }, new AbortController().signal, waiting)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(waiting).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(pending).resolves.toEqual({ id: 'draft-1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ topic: '英语六级' }) })
  })

  it('stops retrying immediately when the visitor cancels', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ code: 'model_busy' }, 429))
    const controller = new AbortController()
    const pending = generateSharedDraft({}, controller.signal, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry the daily limit or other errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ detail: '今天的生成次数已用完' }, 429))
    await expect(generateSharedDraft({}, new AbortController().signal, vi.fn())).rejects.toThrow('今天的生成次数已用完')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
