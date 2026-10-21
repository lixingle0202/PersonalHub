import { apiRequest } from './client'

export type AppSettings = {
  nickname: string; theme_mode: 'light' | 'dark'; theme_color: string; week_starts_on: 0 | 1
  default_work_start: string; default_work_end: string; default_study_minutes: number
  custom_categories: Record<string, string[]>
}

// Keep writes in user-action order, including saves that outlive the settings page.
let pendingWrite: Promise<unknown> = Promise.resolve()

export async function readSettings() {
  await pendingWrite
  return apiRequest<AppSettings>('/settings')
}

export function updateSettings(changes: Partial<AppSettings>) {
  const request = pendingWrite.then(() => apiRequest<AppSettings>('/settings', {
    method: 'PATCH', body: JSON.stringify(changes),
  }))
  pendingWrite = request.catch(() => undefined)
  return request
}
