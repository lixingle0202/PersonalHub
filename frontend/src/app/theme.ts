import { createElement, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { ConfigProvider, theme, type ThemeConfig } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { apiRequest } from '../api/client'

export type AppearanceSettings = {
  theme_mode: 'light' | 'dark'
  theme_color: string
}

let appearance: AppearanceSettings = { theme_mode: 'light', theme_color: '#5b6cff' }
const appearanceListeners = new Set<() => void>()

function subscribeAppearance(listener: () => void) {
  appearanceListeners.add(listener)
  return () => { appearanceListeners.delete(listener) }
}

function accentChannels(color: string) {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16))
}

function luminance(channels: number[]) {
  const linear = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function colorHex(channels: number[]) {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

// Keep a user's accent while ensuring small white button labels stay readable.
function controlAccent(color: string) {
  let channels = accentChannels(color)
  while (1.05 / (luminance(channels) + 0.05) < 4.5) channels = channels.map((channel) => Math.floor(channel * 0.96))
  return colorHex(channels)
}

function readableAccent(color: string, dark: boolean) {
  let channels = accentChannels(color)
  if (!dark) {
    const backgroundLuminance = luminance([229, 233, 255])
    while ((backgroundLuminance + 0.05) / (luminance(channels) + 0.05) < 4.5) {
      channels = channels.map((channel) => Math.floor(channel * 0.96))
    }
    return colorHex(channels)
  }
  const surfaceLuminance = luminance([48, 56, 78])
  while ((luminance(channels) + 0.05) / (surfaceLuminance + 0.05) < 4.5) {
    channels = channels.map((channel) => Math.ceil(channel + (255 - channel) * 0.08))
  }
  return colorHex(channels)
}

export function createApplicationTheme(settings: AppearanceSettings, reduceMotion = false): ThemeConfig {
  const dark = settings.theme_mode === 'dark'
  const accent = controlAccent(settings.theme_color)
  const rgb = accentChannels(settings.theme_color).join(', ')
  const readable = readableAccent(settings.theme_color, dark)
  const surface = dark ? '#232b3c' : '#ffffff'
  const border = dark ? '#424c60' : '#dce2ed'
  const secondaryText = dark ? '#b1b8ce' : '#626a7e'
  const baseAlgorithm = dark ? theme.darkAlgorithm : theme.defaultAlgorithm

  return {
    algorithm: (seed, map) => ({
      ...baseAlgorithm(seed, map),
      // colorLink is a seed token; preserve its readable shade after palette generation.
      colorLink: readable,
      colorLinkHover: readable,
      colorLinkActive: readable,
    }),
    token: {
      colorPrimary: dark ? settings.theme_color : accent,
      colorInfo: dark ? settings.theme_color : accent,
      fontFamily: '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 14,
      fontSizeHeading1: 32,
      fontSizeHeading2: 26,
      fontSizeHeading3: 21,
      fontSizeHeading4: 17,
      lineHeight: 1.6,
      borderRadius: 12,
      borderRadiusLG: 20,
      borderRadiusSM: 8,
      controlHeight: 38,
      controlHeightSM: 30,
      controlHeightLG: 44,
      colorBgContainer: surface,
      colorBgElevated: surface,
      colorBgLayout: dark ? '#131a29' : '#edf1f8',
      colorText: dark ? '#eef2fa' : '#202a3c',
      colorTextSecondary: secondaryText,
      colorTextTertiary: secondaryText,
      colorTextDescription: secondaryText,
      colorTextPlaceholder: secondaryText,
      colorBorder: border,
      colorBorderSecondary: dark ? '#354056' : '#e7ebf2',
      colorPrimaryBorder: readable,
      controlOutline: `rgba(${rgb}, 0.16)`,
      boxShadow: dark ? '0 16px 48px rgba(0, 0, 0, 0.34)' : '0 16px 48px rgba(40, 56, 92, 0.14)',
      boxShadowSecondary: dark ? '0 10px 30px rgba(0, 0, 0, 0.26)' : '0 10px 30px rgba(40, 56, 92, 0.10)',
      motion: !reduceMotion,
      motionDurationFast: '0.14s',
      motionDurationMid: '0.22s',
      motionDurationSlow: '0.32s',
    },
    components: {
      Button: {
        borderRadius: 10,
        fontWeight: 600,
        colorPrimary: accent,
        colorPrimaryHover: colorHex(accentChannels(accent).map((channel) => Math.floor(channel * 0.96))),
        colorPrimaryActive: colorHex(accentChannels(accent).map((channel) => Math.floor(channel * 0.90))),
        primaryColor: '#ffffff',
        defaultBg: surface,
        defaultBorderColor: border,
        defaultShadow: dark ? '0 1px 2px rgba(0, 0, 0, 0.18)' : '0 1px 2px rgba(29, 45, 76, 0.05)',
        primaryShadow: `0 4px 12px rgba(${rgb}, ${dark ? '0.22' : '0.19'})`,
      },
      Card: { borderRadiusLG: 20, headerFontSize: 16, headerHeight: 58, paddingLG: 24 },
      Input: { activeShadow: `0 0 0 3px rgba(${rgb}, 0.14)` },
      InputNumber: { activeShadow: `0 0 0 3px rgba(${rgb}, 0.14)` },
      Select: { optionSelectedBg: `rgba(${rgb}, ${dark ? '0.23' : '0.09'})` },
      Menu: {
        itemHeight: 44,
        itemBorderRadius: 12,
        itemMarginBlock: 5,
        itemMarginInline: 0,
        itemSelectedBg: `rgba(${rgb}, ${dark ? '0.24' : '0.12'})`,
        itemSelectedColor: dark ? '#dfe5ff' : accent,
        itemHoverBg: dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.7)',
      },
      Modal: { borderRadiusLG: 24 },
      Tabs: { horizontalItemGutter: 28, titleFontSize: 14 },
    },
  }
}

function subscribeMotion(listener: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const settings = useSyncExternalStore(subscribeAppearance, () => appearance)
  const reduceMotion = useSyncExternalStore(subscribeMotion, () => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const applicationTheme = useMemo(() => createApplicationTheme(settings, reduceMotion), [settings, reduceMotion])
  return createElement(ConfigProvider, { theme: applicationTheme, locale: zhCN }, children)
}

export function applyAppearance(settings: AppearanceSettings) {
  document.body.classList.toggle('dark-mode', settings.theme_mode === 'dark')
  document.documentElement.style.setProperty('--primary-color', settings.theme_color)
  document.documentElement.style.setProperty('--primary-rgb', accentChannels(settings.theme_color).join(', '))
  document.documentElement.style.setProperty('--primary-control', controlAccent(settings.theme_color))
  document.documentElement.style.setProperty('--primary-readable', readableAccent(settings.theme_color, settings.theme_mode === 'dark'))
  document.documentElement.style.setProperty('--primary-soft', `rgba(${accentChannels(settings.theme_color).join(', ')}, ${settings.theme_mode === 'dark' ? '0.20' : '0.09'})`)
  document.documentElement.style.setProperty('--primary-tint', `rgba(${accentChannels(settings.theme_color).join(', ')}, ${settings.theme_mode === 'dark' ? '0.30' : '0.16'})`)
  document.documentElement.style.colorScheme = settings.theme_mode
  document.documentElement.dataset.appearance = settings.theme_mode

  if (appearance.theme_mode !== settings.theme_mode || appearance.theme_color !== settings.theme_color) {
    appearance = { theme_mode: settings.theme_mode, theme_color: settings.theme_color }
    appearanceListeners.forEach((listener) => listener())
  }
}

export async function loadAppearance() {
  const settings = await apiRequest<AppearanceSettings>('/settings')
  applyAppearance(settings)
  return settings
}
