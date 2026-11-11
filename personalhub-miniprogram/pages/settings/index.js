const api = require('../../utils/api')
const util = require('../../utils/util')
const theme = require('../../utils/theme')
const remind = require('../../utils/remind')
const config = require('../../config')

/* ---------- 颜色换算（色环用） ---------- */
function hsvToRgb(h, s, v) {
  const c = v * s
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) {
    r = c
    g = x
  } else if (hp < 2) {
    r = x
    g = c
  } else if (hp < 3) {
    g = c
    b = x
  } else if (hp < 4) {
    g = x
    b = c
  } else if (hp < 5) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  const m = v - c
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  }
}

function toHex(n) {
  const s = Math.max(0, Math.min(255, n | 0)).toString(16)
  return s.length === 1 ? '0' + s : s
}

function hsvToHex(h, s, v) {
  const c = hsvToRgb(h, s, v)
  return '#' + toHex(c.r) + toHex(c.g) + toHex(c.b)
}

function hexToHsv(hex) {
  const h = String(hex || '#5b6cff').replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let hue = 0
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6
    else if (max === g) hue = (b - r) / d + 2
    else hue = (r - g) / d + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  return { h: hue, s: max ? d / max : 0, v: max }
}

/** 感知亮度，用来卡住「太亮的主题色」——白字压上去会看不清 */
function lumaOf(hex) {
  const h = String(hex).replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** 选出颜色后按亮度上限回压明度，保证按钮上的白字仍然清楚 */
const LUMA_CAP = 150

function readableHex(hue, sat) {
  let v = 0.95
  let hex = hsvToHex(hue, sat, v)
  while (lumaOf(hex) > LUMA_CAP && v > 0.45) {
    v -= 0.04
    hex = hsvToHex(hue, sat, v)
  }
  return hex
}

Page({
  data: Object.assign(
    {
      loading: true,
      saving: false,
      username: '',
      baseUrl: api.getBaseUrl(),
      version: '0.1.0',

      settings: {
        nickname: '',
        theme_mode: 'light',
        theme_color: '#5b6cff',
        week_starts_on: 1,
        default_work_start: '09:00',
        default_work_end: '18:00',
        default_study_minutes: 60
      },
      themeColors: config.themeColors,
      showWheel: false,
      wheelCursor: null,
      backups: [],
      backingUp: false,

      /* 服务地址（换隧道域名时直接在手机上改，不用重新上传版本） */
      serverUrl: '',
      serverDefault: '',
      serverCustom: false,
      serverTesting: false,
      serverHint: '',
      // 微信提醒：本机是否已授权 + 剩余可收条数
      remindOn: remind.isOn(),
      quotaLeft: 0,
      needLogin: false
    },
    theme.data()
  ),

  onShow() {
    this.setData(Object.assign({ color: theme.current().color }, theme.data()))
    theme.applyNav(theme.current())
    const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tb) tb.init(4, theme.current())

    const user = api.getUser() || {}
    this.setData({
      username: user.username || '',
      version: user.version || '0.1.0',
      serverUrl: api.getBaseUrl(),
      serverDefault: api.normalizeBase(config.baseUrl),
      serverCustom: api.isCustomBaseUrl(),
      baseUrl: api.getBaseUrl()
    })

    // 未登录（或服务连不上被踢回登录页）：只展示「服务地址」卡，不强行跳走，
    // 否则连不上服务时用户没法改地址，直接卡死。
    if (!api.isLoggedIn()) {
      this.setData({ loading: false, needLogin: true })
      return
    }
    this.setData({ needLogin: false, remindOn: remind.isOn() })
    if (remind.isOn()) remind.quota().then((n) => this.setData({ quotaLeft: n }))
    this.load()
    if (this.data.showWheel) {
      wx.nextTick(() => this.measureWheel())
    }
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  load(silent) {
    if (!silent) this.setData({ loading: !this.data.backups.length })
    return Promise.all([this.loadSettings(), this.loadBackups()]).then(() =>
      this.setData({ loading: false })
    )
  },

  loadSettings() {
    return api
      .get('/settings')
      .then((s) => {
        api.saveSettings(s)
        theme.apply(s)
        this.setData(
          Object.assign(
            {
              settings: {
                nickname: s.nickname || '',
                theme_mode: s.theme_mode || 'light',
                theme_color: s.theme_color || '#5b6cff',
                week_starts_on: s.week_starts_on === 0 ? 0 : 1,
                default_work_start: s.default_work_start || '09:00',
                default_work_end: s.default_work_end || '18:00',
                default_study_minutes: s.default_study_minutes || 60
              },
              color: s.theme_color || '#5b6cff'
            },
            theme.data()
          )
        )
        if (this.data.showWheel) wx.nextTick(() => this.syncWheelCursor())
      })
      .catch((e) => util.toast(e.message || '读取设置失败'))
  },

  loadBackups() {
    return api
      .get('/backups')
      .then((list) => {
        const rows = (Array.isArray(list) ? list : list && list.items) || []
        this.setData({
          backups: rows.map((b) => ({
            filename: b.filename || b.name,
            size: this.formatSize(b.size_bytes),
            created: (b.created_at || '').replace('T', ' ').slice(0, 16)
          }))
        })
      })
      .catch(() => {})
  },

  formatSize(n) {
    const v = Number(n) || 0
    if (!v) return ''
    if (v < 1024) return v + ' B'
    if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB'
    return (v / 1024 / 1024).toFixed(1) + ' MB'
  },

  /* ---------------- 表单 ---------------- */
  onInput(e) {
    const patch = {}
    patch['settings.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  pickTime(e) {
    const patch = {}
    patch['settings.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  pickColor(e) {
    this.applyColor(e.currentTarget.dataset.value)
    this.syncWheelCursor()
  },

  /* ---------- 色环 ---------- */
  applyColor(value) {
    this.setData({ 'settings.theme_color': value, color: value })
    theme.apply({ theme_mode: this.data.settings.theme_mode, theme_color: value })
    this.setData(theme.data())
    const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tb) tb.init(4, theme.current())
  },

  toggleWheel() {
    const open = !this.data.showWheel
    this.setData({ showWheel: open })
    if (!open) return
    wx.nextTick(() => this.measureWheel())
  },

  /** 色环用 CSS 渐变绘制，这里只量一下位置，用于把触点换算成色相/饱和度 */
  measureWheel() {
    wx.createSelectorQuery()
      .select('#wheel')
      .boundingClientRect((rect) => {
        if (!rect || !rect.width) return
        this._wheel = { left: rect.left, top: rect.top, r: rect.width / 2 }
        this.syncWheelCursor()
      })
      .exec()
  },

  cursorOf(hue, sat, r) {
    const rad = (hue * Math.PI) / 180
    return {
      left: r + Math.cos(rad) * sat * r,
      top: r + Math.sin(rad) * sat * r
    }
  },

  syncWheelCursor() {
    const w = this._wheel
    if (!w || !this.data.showWheel) return
    const c = hexToHsv(this.data.settings.theme_color)
    this.setData({ wheelCursor: this.cursorOf(c.h, Math.max(0.06, c.s), w.r) })
  },

  onWheelTouch(e) {
    const w = this._wheel
    if (!w) return
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return
    const cx = t.clientX == null ? t.pageX : t.clientX
    const cy = t.clientY == null ? t.pageY : t.clientY
    if (cx == null || cy == null) return
    const x = Number(cx) - w.left
    const y = Number(cy) - w.top
    const r = w.r
    const dx = x - r
    const dy = y - r
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > r + 4) return
    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
    // 饱和度留一个下限，避免选出近白色导致按钮文字看不清
    const sat = Math.min(1, Math.max(0.32, dist / r))
    this.setData({ wheelCursor: this.cursorOf(hue, Math.min(1, dist / r), r) })
    const hex = readableHex(hue, sat)
    const now = Date.now()
    if (this._wheelTs && now - this._wheelTs < 90) {
      this._wheelPending = hex
      return
    }
    this._wheelTs = now
    this.applyColor(hex)
  },

  onWheelTouchEnd() {
    this._wheelTs = 0
    if (this._wheelPending) {
      this.applyColor(this._wheelPending)
      this._wheelPending = ''
    }
  },

  toggleDark(e) {
    const mode = e.detail.value ? 'dark' : 'light'
    this.setData({ 'settings.theme_mode': mode })
    theme.apply({ theme_mode: mode, theme_color: this.data.settings.theme_color })
    this.setData(theme.data())
    const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tb) tb.init(4, theme.current())
  },

  setWeekStart(e) {
    this.setData({ 'settings.week_starts_on': Number(e.currentTarget.dataset.value) })
  },

  save() {
    if (this.data.saving) return
    this.setData({ saving: true })
    const s = this.data.settings
    api
      .patch('/settings', {
        nickname: s.nickname || '',
        theme_mode: s.theme_mode,
        theme_color: s.theme_color,
        week_starts_on: Number(s.week_starts_on),
        default_work_start: s.default_work_start,
        default_work_end: s.default_work_end,
        default_study_minutes: Number(s.default_study_minutes) || 60
      })
      .then((res) => {
        this.setData({ saving: false })
        // 后端通常回传完整设置；万一字段不全，用本地值兜底
        const merged = Object.assign({}, s, res || {})
        api.saveSettings(merged)
        theme.apply(merged)
        this.setData({ settings: merged })
        this.setData(theme.data())
        theme.applyNav(theme.current())
        const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null
        if (tb) tb.init(4, theme.current())
        util.toast('设置已保存', 'success')
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast(e.message || '保存失败')
      })
  },

  /** 未登录时的「去登录」 */
  goLogin() {
    wx.reLaunch({ url: '/pages/login/index' })
  },

  /* ---------------- 消息提醒 ---------------- */

  /** 开启/补充微信提醒（与学习页常驻条同一流程） */
  openRemind() {
    remind.subscribe().then((ok) => {
      this.setData({ remindOn: remind.isOn() })
      if (ok) remind.quota().then((n) => this.setData({ quotaLeft: n }))
    })
  },

  /* ---------------- 服务地址 ---------------- */
  onServerInput(e) {
    this.setData({ serverUrl: e.detail.value, serverHint: '' })
  },

  /** 只测试不保存 */
  testServer() {
    if (this.data.serverTesting) return
    const url = api.normalizeBase(this.data.serverUrl || this.data.serverDefault)
    if (!url) {
      util.toast('请先填写地址')
      return
    }
    this.setData({ serverTesting: true, serverHint: '正在连接 ' + url })
    api.probe(url).then((r) => {
      if (r.ok) {
        this.setData({
          serverTesting: false,
          serverHint: '连接成功（' + r.status + '，' + r.ms + 'ms）'
        })
        util.toast('连得上，可以保存', 'success')
      } else {
        this.setData({ serverTesting: false, serverHint: '连不上：' + (r.reason || '未知原因') })
        util.toast('连不上，换一个地址试试')
      }
    })
  },

  /** 保存并切换：先探测，探不通给二次确认 */
  saveServer() {
    if (this.data.serverTesting) return
    const url = api.normalizeBase(this.data.serverUrl)
    const doSave = () => {
      const applied = api.setBaseUrl(url)
      // 换了地址之后会话可能失效：试拉一次 bootstrap，401 会自己跳登录页
      api
        .bootstrap()
        .then(() => {
          this.setData({
            serverUrl: applied,
            serverCustom: api.isCustomBaseUrl(),
            baseUrl: applied,
            serverHint: applied === this.data.serverDefault ? '已恢复默认地址' : '已切换到 ' + applied
          })
          util.toast('服务地址已切换', 'success')
          wx.reLaunch({ url: '/pages/home/index' })
        })
        .catch((e) => {
          this.setData({
            serverUrl: applied,
            serverCustom: api.isCustomBaseUrl(),
            baseUrl: applied
          })
          if (e && e.unauthorized) {
            util.toast('地址通，但会话失效，请重新登录')
            api.clearAuth()
            wx.reLaunch({ url: '/pages/login/index' })
          } else {
            util.toast(e.message || '切换后连接失败')
          }
        })
    }

    if (!url) {
      this.resetServer()
      return
    }
    this.setData({ serverTesting: true, serverHint: '正在连接 ' + url })
    api.probe(url).then((r) => {
      this.setData({ serverTesting: false })
      if (r.ok) {
        doSave()
        return
      }
      wx.showModal({
        title: '这个地址连不上',
        content: (r.reason || '请求失败') + '\n仍然保存吗？保存后可能打不开数据。',
        confirmText: '仍然保存',
        cancelText: '取消',
        confirmColor: '#c9455a',
        success: (m) => {
          if (m.confirm) doSave()
          else this.setData({ serverHint: '已取消，当前地址未改变' })
        }
      })
    })
  },

  resetServer() {
    const def = api.resetBaseUrl()
    this.setData({ serverUrl: def, serverCustom: false, baseUrl: def, serverHint: '已恢复为内置默认地址（无需重启）' })
    util.toast('已恢复默认地址', 'success')
  },

  /* ---------------- 备份 ---------------- */
  makeBackup() {
    if (this.data.backingUp) return
    this.setData({ backingUp: true })
    api
      .post('/backups')
      .then(() => {
        this.setData({ backingUp: false })
        util.toast('备份已创建', 'success')
        return this.loadBackups()
      })
      .catch((e) => {
        this.setData({ backingUp: false })
        util.toast(e.message || '备份失败')
      })
  },

  /* ---------------- 退出 ---------------- */
  logout() {
    wx.showModal({
      title: '退出登录？',
      content: '退出后需要重新输入账号密码。',
      confirmText: '退出',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api.logout().then(() => {
          wx.reLaunch({ url: '/pages/login/index' })
        })
      }
    })
  }
})
