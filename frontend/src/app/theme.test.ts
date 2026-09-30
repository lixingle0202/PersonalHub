import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAppearance, loadAppearance } from './theme'

describe('application appearance', () => {
  beforeEach(() => {
    document.body.className = ''
    document.documentElement.style.removeProperty('--primary-color')
    vi.restoreAllMocks()
  })

  it('applies dark mode and the configured accent color', () => {
    applyAppearance({ theme_mode: 'dark', theme_color: '#725cff' })

    expect(document.body).toHaveClass('dark-mode')
    expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#725cff')
  })

  it('loads and applies appearance during application startup', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      theme_mode: 'dark',
      theme_color: '#204080',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await loadAppearance()

    expect(fetch).toHaveBeenCalledWith('/api/v1/settings', expect.objectContaining({ headers: expect.any(Headers) }))
    expect(document.body).toHaveClass('dark-mode')
    expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#204080')
  })

  it('removes dark mode when light appearance is restored', () => {
    document.body.classList.add('dark-mode')
    applyAppearance({ theme_mode: 'light', theme_color: '#1677ff' })

    expect(document.body).not.toHaveClass('dark-mode')
  })
})
