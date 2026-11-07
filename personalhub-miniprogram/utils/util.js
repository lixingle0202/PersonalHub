/** 通用工具函数 */

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/** 本地日期 -> YYYY-MM-DD */
function fmtDate(d) {
  const x = d instanceof Date ? d : new Date(d)
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate())
}

/** 今天 YYYY-MM-DD */
function today() {
  return fmtDate(new Date())
}

/** 解析 YYYY-MM-DD（避免 iOS 解析差异） */
function parseDate(s) {
  if (!s) return new Date()
  if (s instanceof Date) return s
  const p = String(s).slice(0, 10).split('-')
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
}

function addDays(s, n) {
  const d = parseDate(s)
  d.setDate(d.getDate() + n)
  return fmtDate(d)
}

function diffDays(a, b) {
  return Math.round((parseDate(a) - parseDate(b)) / 86400000)
}

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const WEEK_SHORT = ['日', '一', '二', '三', '四', '五', '六']

function weekday(s) {
  return WEEK[parseDate(s).getDay()]
}

/** 2026年11月06日 · 星期五 */
function prettyDate(s) {
  const d = parseDate(s)
  return (
    d.getFullYear() + '年' + pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日 · ' + WEEK[d.getDay()]
  )
}

/** 11月6日 周五 */
function shortDate(s) {
  const d = parseDate(s)
  return pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日 周' + WEEK_SHORT[d.getDay()]
}

/**
 * 生成月历网格（周日/周一起始可配置）
 * 返回 { title: '2026年11月', cells: [{date, day, inMonth, isToday, weekday}] }
 */
function monthGrid(year, month, weekStart = 1) {
  const first = new Date(year, month - 1, 1)
  let offset = first.getDay() - weekStart
  if (offset < 0) offset += 7
  const start = new Date(year, month - 1, 1 - offset)
  const cells = []
  const nowStr = today()
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const ds = fmtDate(d)
    cells.push({
      date: ds,
      day: d.getDate(),
      inMonth: d.getMonth() === month - 1,
      isToday: ds === nowStr,
      weekday: d.getDay()
    })
  }
  // 去掉多余的整周
  while (cells.length > 35 && cells.slice(35).every((c) => !c.inMonth)) cells.length = 35
  return { title: year + '年' + month + '月', cells }
}

function shiftMonth(year, month, delta) {
  const d = new Date(year, month - 1 + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

/* ---------- 颜色 ---------- */
function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h || '5b6cff', 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgba(hex, alpha) {
  const c = hexToRgb(hex)
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')'
}

function darken(hex, ratio) {
  const c = hexToRgb(hex)
  const f = 1 - (ratio || 0.18)
  return (
    '#' +
    [c.r, c.g, c.b]
      .map((v) => {
        const x = Math.max(0, Math.min(255, Math.round(v * f)))
        return x < 16 ? '0' + x.toString(16) : x.toString(16)
      })
      .join('')
  )
}

/** 生成页面根节点的主题样式变量 */
/**
 * 自定义导航栏需要的安全尺寸。
 * navigationStyle: custom 时小程序不管状态栏，env(safe-area-inset-top) 在多数
 * 安卓机与开发者工具里是 0，所以这里按系统信息算出来再用。
 */
let navCache = null
function navMetrics() {
  if (navCache) return navCache
  let statusBar = 20
  let navBar = 44
  let capRight = 96
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    statusBar = info.statusBarHeight || 20
    const rect = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null
    if (rect && rect.height) {
      navBar = (rect.top - statusBar) * 2 + rect.height
      // 胶囊按钮左边缘到屏幕右侧的距离，用于给右上角按钮让位
      capRight = (info.windowWidth || rect.right) - rect.left + 8
    }
  } catch (e) {}
  navCache = { statusBar: statusBar, navBar: navBar, capRight: capRight }
  return navCache
}

function themeStyle(color) {
  const c = color || '#5b6cff'
  const nav = navMetrics()
  return (
    '--primary:' + c + ';' +
    '--primary-soft:' + rgba(c, 0.09) + ';' +
    '--primary-tint:' + rgba(c, 0.16) + ';' +
    '--primary-readable:' + darken(c, 0.2) + ';' +
    '--sb:' + nav.statusBar + 'px;' +
    '--nav-h:' + nav.navBar + 'px;' +
    '--cap:' + nav.capRight + 'px;'
  )
}

/* ---------- 其它 ---------- */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const BUCKETS = [
  { value: 'must', label: '必须完成' },
  { value: 'scheduled', label: '按时间安排' },
  { value: 'optional', label: '有空再做' }
]

const PRIORITIES = [
  { value: 'low', label: '低' },
  { value: 'normal', label: '普通' },
  { value: 'high', label: '高' },
  { value: 'urgent', label: '紧急' }
]

const MEAL_TYPES = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' }
]

const CATEGORIES = {
  learning: '学习',
  diet: '饮食',
  exercise: '运动',
  work: '工作',
  health: '健康',
  life: '生活',
  leisure: '休闲',
  other: '其他'
}

function labelOf(list, value) {
  const hit = list.filter((x) => x.value === value)[0]
  return hit ? hit.label : value
}

function toast(title, icon) {
  wx.showToast({ title: title, icon: icon || 'none', duration: 1800 })
}

/**
 * 轻量缓存：进页面先渲染上次的数据，再静默刷新。
 * 避免每次切页都整屏「正在加载」白屏（真机走隧道时尤其明显）。
 */
const CACHE_PREFIX = 'ph_cache_'
const CACHE_TTL = 12 * 60 * 60 * 1000

function cacheSet(key, value) {
  try {
    wx.setStorageSync(CACHE_PREFIX + key, { t: Date.now(), v: value })
  } catch (e) {
    /* 存不下就跳过 */
  }
}

function cacheGet(key, ttl) {
  try {
    const box = wx.getStorageSync(CACHE_PREFIX + key)
    if (!box || !box.t) return null
    if (Date.now() - box.t > (ttl || CACHE_TTL)) return null
    return box.v
  } catch (e) {
    return null
  }
}

/** 打开弹层时收起自定义 tabBar（它的层级高于弹层，会盖住底部按钮） */
function setTabBarHidden(hidden) {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  const cur = pages[pages.length - 1]
  if (!cur || typeof cur.getTabBar !== 'function') return
  const tb = cur.getTabBar()
  if (tb && typeof tb.setHidden === 'function') tb.setHidden(hidden)
}

module.exports = {
  pad,
  fmtDate,
  today,
  parseDate,
  addDays,
  diffDays,
  weekday,
  prettyDate,
  shortDate,
  monthGrid,
  shiftMonth,
  rgba,
  darken,
  themeStyle,
  navMetrics,
  uuid,
  cacheSet,
  cacheGet,
  setTabBarHidden,
  BUCKETS,
  PRIORITIES,
  MEAL_TYPES,
  CATEGORIES,
  labelOf,
  toast,
  WEEK_SHORT
}
