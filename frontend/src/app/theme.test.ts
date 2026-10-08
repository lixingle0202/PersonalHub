import { createElement, Fragment } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Input, theme } from 'antd'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceProvider, applyAppearance, createApplicationTheme, loadAppearance } from './theme'

function ThemeProbe() {
  const { token } = theme.useToken()
  return createElement(Fragment, null,
    createElement('output', { 'data-testid': 'component-theme' }, JSON.stringify({
      background: token.colorBgContainer,
      link: token.colorLink,
      motion: token.motion,
      secondary: token.colorTextSecondary,
      tertiary: token.colorTextTertiary,
      description: token.colorTextDescription,
      placeholder: token.colorTextPlaceholder,
      focusBorder: token.colorPrimaryBorder,
    })),
    createElement(Input, { 'aria-label': '草稿标题', defaultValue: '学习计划' }),
  )
}

function componentTheme() {
  return JSON.parse(screen.getByTestId('component-theme').textContent ?? '{}')
}

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16) / 255)
    const values = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('application appearance', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    applyAppearance({ theme_mode: 'light', theme_color: '#5b6cff' })
    document.body.className = ''
  })

  it('applies dark mode and the configured accent color', () => {
    applyAppearance({ theme_mode: 'dark', theme_color: '#725cff' })

    expect(document.body).toHaveClass('dark-mode')
    expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#725cff')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.documentElement.dataset.appearance).toBe('dark')
    expect(document.documentElement.style.getPropertyValue('--primary-rgb')).toBe('114, 92, 255')
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
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.documentElement.dataset.appearance).toBe('light')
  })

  it('updates open components immediately when appearance changes, preserving unfinished input', () => {
    render(createElement(AppearanceProvider, { children: createElement(ThemeProbe) }))
    const input = screen.getByRole('textbox', { name: '草稿标题' })
    fireEvent.change(input, { target: { value: '尚未保存的计划' } })
    const lightTheme = componentTheme()

    act(() => applyAppearance({ theme_mode: 'dark', theme_color: '#27b69e' }))

    expect(componentTheme().background).not.toBe(lightTheme.background)
    expect(componentTheme().link).not.toBe(lightTheme.link)
    expect(componentTheme().link).toBe(document.documentElement.style.getPropertyValue('--primary-readable'))
    expect(screen.getByRole('textbox', { name: '草稿标题' })).toBe(input)
    expect(input).toHaveValue('尚未保存的计划')

    act(() => applyAppearance({ theme_mode: 'light', theme_color: '#a443b7' }))
    expect(componentTheme().background).toBe(lightTheme.background)
    expect(componentTheme().link).toBe(document.documentElement.style.getPropertyValue('--primary-readable'))
    expect(input).toHaveValue('尚未保存的计划')
  })

  it('responds to the system reduced-motion preference and removes its listener on unmount', () => {
    let reduceMotion = false
    const listeners = new Set<() => void>()
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && reduceMotion,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList)
    const view = render(createElement(AppearanceProvider, { children: createElement(ThemeProbe) }))
    expect(componentTheme().motion).toBe(true)

    act(() => {
      reduceMotion = true
      listeners.forEach((listener) => listener())
    })
    expect(componentTheme().motion).toBe(false)

    act(() => {
      reduceMotion = false
      listeners.forEach((listener) => listener())
    })
    expect(componentTheme().motion).toBe(true)
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it.each(['light', 'dark'] as const)('keeps description text, placeholders and focus borders readable in %s mode', (mode) => {
    act(() => applyAppearance({ theme_mode: mode, theme_color: '#5b6cff' }))
    render(createElement(AppearanceProvider, { children: createElement(ThemeProbe) }))
    const tokens = componentTheme()
    const background = mode === 'dark' ? '#30384e' : '#f3f5fb'
    const expected = mode === 'dark' ? '#b1b8ce' : '#626a7e'

    for (const color of [tokens.secondary, tokens.tertiary, tokens.description, tokens.placeholder]) {
      expect(color).toBe(expected)
      expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(tokens.focusBorder, background)).toBeGreaterThanOrEqual(3)
  })

  it.each(['#5b6cff', '#ffe9ac', '#00ff00', '#ffffff', '#000000'])('keeps labels and links readable with the saved accent %s', (color) => {
    for (const mode of ['light', 'dark'] as const) {
      applyAppearance({ theme_mode: mode, theme_color: color })
      const buttons = createApplicationTheme({ theme_mode: mode, theme_color: color }).components!.Button!
      for (const background of [buttons.colorPrimary, buttons.colorPrimaryHover, buttons.colorPrimaryActive]) {
        expect(contrast('#ffffff', background!)).toBeGreaterThanOrEqual(4.5)
      }
      const readable = document.documentElement.style.getPropertyValue('--primary-readable')
      expect(contrast(readable, mode === 'dark' ? '#30384e' : '#e5e9ff')).toBeGreaterThanOrEqual(4.5)
      expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe(color)
    }
  })
})
