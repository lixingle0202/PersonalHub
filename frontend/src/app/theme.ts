import { apiRequest } from '../api/client'

export type AppearanceSettings = {
  theme_mode: 'light' | 'dark'
  theme_color: string
}

export function applyAppearance(settings: AppearanceSettings) {
  document.body.classList.toggle('dark-mode', settings.theme_mode === 'dark')
  document.documentElement.style.setProperty('--primary-color', settings.theme_color)
}

export async function loadAppearance() {
  const settings = await apiRequest<AppearanceSettings>('/settings')
  applyAppearance(settings)
  return settings
}
