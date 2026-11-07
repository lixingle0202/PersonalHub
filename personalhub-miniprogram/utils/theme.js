const api = require('./api')
const util = require('./util')

const DEFAULT = { mode: 'light', color: '#5b6cff' }

function current() {
  const app = getApp()
  if (app && app.globalData && app.globalData.theme) return app.globalData.theme
  const s = api.cachedSettings()
  return s ? { mode: s.theme_mode || 'light', color: s.theme_color || '#5b6cff' } : DEFAULT
}

function apply(settings) {
  const app = getApp()
  const theme = {
    mode: (settings && settings.theme_mode) || 'light',
    color: (settings && settings.theme_color) || '#5b6cff'
  }
  if (app && app.globalData) app.globalData.theme = theme
  return theme
}

/** 供页面 data 使用 */
function data() {
  const t = current()
  return { themeMode: t.mode, themeStyle: util.themeStyle(t.color) }
}

/**
 * 同步系统级外观：状态栏文字颜色 + 窗口背景色。
 * 自定义导航栏（navigationStyle: custom）下，
 * 状态栏文字颜色由 setNavigationBarColor 控制，
 * 不随主题切换的话，深色模式会黑字压深底。
 */
const BG_LIGHT = '#edf0f8'
const BG_DARK = '#181d2b'

function applyNav(t) {
  const dark = !!(t && t.mode === 'dark')
  if (wx.setNavigationBarColor) {
    wx.setNavigationBarColor({
      frontColor: dark ? '#ffffff' : '#000000',
      backgroundColor: dark ? BG_DARK : BG_LIGHT,
      fail: function () {}
    })
  }
  if (wx.setBackgroundColor) {
    wx.setBackgroundColor({
      backgroundColor: dark ? BG_DARK : BG_LIGHT,
      fail: function () {}
    })
  }
}

module.exports = { current, apply, data, applyNav }
