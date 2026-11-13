const api = require('./utils/api')
const util = require('./utils/util')
const remind = require('./utils/remind')

App({
  globalData: {
    theme: { mode: 'light', color: '#5b6cff' },
    username: '',
    version: '',
    // 扫码 / 分享带来的直达目标（'today' / 'learning'…），
    // 登录页和首页 onShow 会消费掉它做一次 switchTab
    pendingTarget: ''
  },

  onLaunch(options) {
    const s = api.cachedSettings()
    if (s) {
      this.globalData.theme = {
        mode: s.theme_mode || 'light',
        color: s.theme_color || '#5b6cff'
      }
    }
    const user = api.getUser()
    if (user) this.globalData.username = user.username || ''
    this.captureTarget(options)
  },

  /** 每次回到前台：先记下直达目标，再把当前登录账号同步给电脑端、检查额度 */
  onShow(options) {
    this.captureTarget(options)
    remind.syncAccount()
    remind.autoTopup()
  },

  /**
   * 从启动参数里解析直达目标：
   * - 普通跳转/分享：options.query.target = today|learning|diet|settings…
   * - 扫小程序码：scene 值放在 options.query.scene 里（URL 编码过）
   * 解析不出就忽略，不影响正常启动。
   */
  captureTarget(options) {
    try {
      const q = (options && options.query) || {}
      let raw = q.target || q.scene || ''
      if (!raw) return
      raw = decodeURIComponent(String(raw))
      const path = util.resolveTarget(raw)
      if (path) this.globalData.pendingTarget = path
    } catch (e) {}
  },

  /** 拉取并缓存设置，同步主题 */
  syncSettings() {
    return api
      .get('/settings')
      .then((s) => {
        api.saveSettings(s)
        this.globalData.theme = {
          mode: s.theme_mode || 'light',
          color: s.theme_color || '#5b6cff'
        }
        return s
      })
      .catch(() => null)
  }
})
