import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readSettings, updateSettings, type AppSettings } from './settings'

const defaults: AppSettings = {
  nickname: '学生', theme_mode: 'light', theme_color: '#5b6cff', week_starts_on: 1,
  default_work_start: '09:00', default_work_end: '18:00', default_study_minutes: 60,
  custom_categories: {},
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('settings persistence', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('preserves the last rapid appearance change and waits for pending saves before reading', async () => {
    let settings = { ...defaults }
    let finishFirstSave!: () => void
    let writes = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (init?.method === 'PATCH') {
        writes += 1
        const changes = JSON.parse(String(init.body))
        if (writes === 1) return new Promise<Response>((resolve) => {
          finishFirstSave = () => { settings = { ...settings, ...changes }; resolve(json(settings)) }
        })
        settings = { ...settings, ...changes }
      }
      return Promise.resolve(json(settings))
    })

    const dark = updateSettings({ theme_mode: 'dark' })
    const light = updateSettings({ theme_mode: 'light' })
    const last = updateSettings({ theme_mode: 'dark', theme_color: '#22aa77' })
    const read = readSettings()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    finishFirstSave()

    await Promise.all([dark, light, last])
    expect(await read).toMatchObject({ theme_mode: 'dark', theme_color: '#22aa77', nickname: '学生' })
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['PATCH', 'PATCH', 'PATCH', 'GET'])
  })

  it('allows saving and reading settings again after a failed request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ detail: '保存失败' }, 503))
      .mockResolvedValueOnce(json({ ...defaults, theme_mode: 'dark' }))
      .mockResolvedValueOnce(json({ ...defaults, theme_mode: 'dark' }))

    await expect(updateSettings({ theme_mode: 'dark' })).rejects.toThrow('保存失败')
    await expect(updateSettings({ theme_mode: 'dark' })).resolves.toMatchObject({ theme_mode: 'dark' })
    await expect(readSettings()).resolves.toMatchObject({ theme_mode: 'dark' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
