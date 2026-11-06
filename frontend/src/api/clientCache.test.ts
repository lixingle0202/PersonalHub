import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiRequest, setLocalToken } from './client'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => setLocalToken('cache-test'))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('reuses and clones fresh reads, deduplicates requests, and expires them', async () => {
  vi.useFakeTimers()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json([{ id: 'one' }]))
  const [first, second] = await Promise.all([apiRequest<Array<{ id: string }>>('/learning/goals'), apiRequest('/learning/goals')])
  first[0].id = 'edited'
  expect(second).toEqual([{ id: 'one' }])
  expect(await apiRequest('/learning/goals')).toEqual([{ id: 'one' }])
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(15_001)
  await apiRequest('/learning/goals')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('invalidates all related pages on writes and never caches live job status', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ value: 1 }))
  await apiRequest('/home?date=2026-11-06')
  await apiRequest('/learning/tasks/one', { method: 'PATCH', body: JSON.stringify({ title: 'new' }) })
  await apiRequest('/home?date=2026-11-06')
  await apiRequest('/ai/shared/jobs/job-1')
  await apiRequest('/ai/shared/jobs/job-1')
  expect(fetch).toHaveBeenCalledTimes(5)
})

it('does not let a slow read repopulate the cache after a mutation or account switch', async () => {
  let release!: (value: Response) => void
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    .mockImplementation(async () => json([{ id: 'new' }]))
  const oldRead = apiRequest('/learning/goals')
  await apiRequest('/learning/goals', { method: 'POST', body: '{}' })
  release(json([{ id: 'old' }]))
  await oldRead
  expect(await apiRequest('/learning/goals')).toEqual([{ id: 'new' }])
  setLocalToken('different-account')
  await apiRequest('/learning/goals')
  expect(fetch).toHaveBeenCalledTimes(4)
})

it('isolates abortable requests and never caches failures', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(async () => json({ detail: 'temporary' }, 503))
    .mockImplementation(async () => json([]))
  await expect(apiRequest('/learning/goals')).rejects.toThrow('temporary')
  await apiRequest('/learning/goals', { signal: new AbortController().signal })
  await apiRequest('/learning/goals')
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('keeps cached reads for an unchanged overdue check but clears them when dates shift', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(async () => json([]))
    .mockImplementationOnce(async () => json({ shifted_goal_ids: [] }))
    .mockImplementationOnce(async () => json({ shifted_goal_ids: ['one'] }))
    .mockImplementation(async () => json([]))
  await apiRequest('/learning/goals')
  await apiRequest('/learning/overdue/check', { method: 'POST' })
  await apiRequest('/learning/goals')
  expect(fetch).toHaveBeenCalledTimes(2)
  await apiRequest('/learning/overdue/check', { method: 'POST' })
  await apiRequest('/learning/goals')
  expect(fetch).toHaveBeenCalledTimes(4)
})
