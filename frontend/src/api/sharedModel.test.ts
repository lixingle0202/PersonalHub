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
  it('polls a background job, switches from queued to running, and returns its draft', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'queued', result: null }, 202))
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'running', result: null }, 200))
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'completed', result: { id: 'draft-1' } }, 200))
    const waiting = vi.fn(), running = vi.fn()
    const pending = generateSharedDraft({ topic: '英语' }, new AbortController().signal, waiting, '/ai/learning/generate', running)
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1500)
    expect(running).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1500)
    await expect(pending).resolves.toEqual({ id: 'draft-1' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/ai/learning/generate', '/api/v1/ai/shared/jobs/job-1', '/api/v1/ai/shared/jobs/job-1'])
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('prefer')).toBe('respond-async')
  })

  it('cancels an accepted job on the server and stops polling', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'running', result: null }, 202))
      .mockImplementation(() => json({ job_id: 'job-1', state: 'cancelling' }, 200))
    const controller = new AbortController()
    const pending = generateSharedDraft({}, controller.signal, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE')
  })

  it('retries temporary polling failures without submitting a duplicate generation', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'running', result: null }, 202))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'completed', result: { id: 'draft-1' } }, 200))
    const pending = generateSharedDraft({}, new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(4500)
    await expect(pending).resolves.toEqual({ id: 'draft-1' })
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('shows a failed job’s actual error without repeatedly regenerating', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'running', result: null }, 202))
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'failed', detail: '具体步骤重复，请重试' }, 200))
    const pending = generateSharedDraft({}, new AbortController().signal, vi.fn())
    const check = expect(pending).rejects.toThrow('具体步骤重复，请重试')
    await vi.advanceTimersByTimeAsync(1500)
    await check
  })

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

  it('bounds a stalled polling connection, then resumes the same job', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'running', result: null }, 202))
      .mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }))
      .mockImplementationOnce(() => json({ job_id: 'job-1', state: 'completed', result: { id: 'draft-1' } }, 200))
    const pending = generateSharedDraft({}, new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(24500)
    await expect(pending).resolves.toEqual({ id: 'draft-1' })
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
})
