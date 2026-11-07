import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const plan = { name: '一日菜单', description: '可编辑', cycle_days: 1, meals: [
  { day_number: 1, meal_type: 'breakfast', name: '燕麦牛奶', estimated_kcal: 400 },
] }
const requirements = { theme: '一日菜单', preferences: '', days: 1 }
const config = { base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:1.5b' }
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const bootstrap = (username: string) => ({ app_name: 'PersonalHub', version: 'test', local_token: 'token', database_path: 'account', public_mode: true, username })

beforeEach(() => { vi.resetModules(); sessionStorage.clear(); localStorage.clear(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function setup(username = 'alice') {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(bootstrap(username)))
  const client = await import('./client')
  await client.bootstrapApi()
  const store = await import('./dietDraft')
  return { fetchMock, store, client }
}

describe('account-scoped resumable diet generation', () => {
  it('keeps a single task without a mounted page, stores progress, and retains the result', async () => {
    const { fetchMock, store } = await setup()
    fetchMock.mockImplementation((url) => String(url).endsWith('/ai/diet/generate')
      ? json({ job_id: 'one', state: 'queued', queue_position: 2, result: null }, 202)
      : json({ job_id: 'one', state: 'completed', result: { plan } }))
    store.startDietGeneration(requirements, config, 'shared')
    store.startDietGeneration(requirements, config, 'shared')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getDietDraft().state).toBe('queued')
    const saved = JSON.parse(sessionStorage.getItem(store.dietDraftScope())!)
    expect(saved.handle.jobId).toBe('one')
    expect(saved.handle.requestKey).toBeTruthy()
    await vi.advanceTimersByTimeAsync(1500)
    expect(store.getDietDraft()).toMatchObject({ state: 'completed', plan })
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/ai/diet/generate'))).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  it('reconnects after refresh to the saved job without submitting another generation', async () => {
    const { fetchMock, store } = await setup('refresh')
    sessionStorage.setItem(store.dietDraftScope(), JSON.stringify({ version: 1, state: 'running', requirements, transport: 'shared',
      handle: { jobId: 'saved-job', requestKey: 'saved-key', startedAt: Date.now() - 20 * 60 * 1000 } }))
    fetchMock.mockImplementation(() => json({ job_id: 'saved-job', state: 'completed', result: { plan } }))
    store.resumeDietGeneration()
    store.resumeDietGeneration()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getDietDraft()).toMatchObject({ state: 'completed', plan })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/ai/shared/jobs/saved-job', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('reuses the saved request key if a refresh happened before the job identifier arrived', async () => {
    const { fetchMock, store } = await setup('request-key')
    sessionStorage.setItem(store.dietDraftScope(), JSON.stringify({ version: 1, state: 'running', requirements, transport: 'shared',
      handle: { jobId: '', requestKey: 'same-request', startedAt: Date.now() } }))
    fetchMock.mockImplementation(() => json({ job_id: 'existing', state: 'completed', result: { plan } }))
    store.resumeDietGeneration()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getDietDraft().state).toBe('completed')
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get('X-Generation-Key')).toBe('same-request')
  })

  it('reports an expired server job instead of silently submitting a replacement', async () => {
    const { fetchMock, store } = await setup('expired')
    sessionStorage.setItem(store.dietDraftScope(), JSON.stringify({ version: 1, state: 'running', requirements, transport: 'shared',
      handle: { jobId: 'expired', requestKey: 'old-key', startedAt: Date.now() } }))
    fetchMock.mockImplementation(() => json({ detail: '生成任务不存在或已过期，请重新生成' }, 404))
    store.resumeDietGeneration()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getDietDraft()).toMatchObject({ state: 'failed', error: expect.stringContaining('已过期') })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('only cancels when explicitly requested and never creates a template or meal', async () => {
    const { fetchMock, store } = await setup('cancel')
    fetchMock.mockImplementation(() => json({ job_id: 'cancel-job', state: 'running', result: null }, 202))
    store.startDietGeneration(requirements, config, 'shared')
    await vi.advanceTimersByTimeAsync(0)
    store.cancelDietGeneration()
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.getDietDraft().state).toBe('cancelled')
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([url]) => /diet\/(templates|meals)/.test(String(url)))).toBe(false)
  })

  it('isolates accounts and preserves incomplete editor text across reloads', async () => {
    const { fetchMock, store, client } = await setup('editor')
    sessionStorage.setItem(store.dietDraftScope(), JSON.stringify({ version: 1, state: 'completed', plan }))
    store.updateDietDraftEditor({ name: '修改中的菜单', description: '', cycleDays: 1, lines: '1 | 早餐 | 尚未写完' })
    expect(JSON.parse(sessionStorage.getItem(store.dietDraftScope())!).editor.lines).toBe('1 | 早餐 | 尚未写完')
    fetchMock.mockImplementation(() => json(bootstrap('other')))
    await client.bootstrapApi()
    expect(store.getDietDraft().state).toBe('idle')
    fetchMock.mockImplementation(() => json(bootstrap('editor')))
    await client.bootstrapApi()
    expect(store.getDietDraft().editor?.name).toBe('修改中的菜单')
  })

  it('stops an old account workflow before sending a visitor result under a new account', async () => {
    const { fetchMock, store, client } = await setup('old')
    let release!: (value: Response) => void
    fetchMock.mockImplementation((url) => String(url).endsWith('/visitor/prepare')
      ? new Promise<Response>((resolve) => { release = resolve }) : json(bootstrap('new')))
    store.startDietGeneration(requirements, config, 'local')
    await vi.advanceTimersByTimeAsync(0)
    await client.bootstrapApi()
    release(new Response(JSON.stringify({ stream: false })))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getDietDraft().state).toBe('idle')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('11434'))).toBe(false)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/visitor/draft'))).toBe(false)
  })

  it('finishes generation in memory when session storage is disabled', async () => {
    const { fetchMock, store } = await setup('no-storage')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled') })
    fetchMock.mockImplementation(() => json({ plan }))
    store.startDietGeneration(requirements, config, 'shared')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getDietDraft()).toMatchObject({ state: 'completed', plan })
  })
})
