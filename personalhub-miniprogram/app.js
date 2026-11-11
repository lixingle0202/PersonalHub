const api = require('./utils/api')
const util = require('./utils/util')
const remind = require('./utils/remind')

App({
  globalData: {
    theme: { mode: 'light', color: '#5b6cff' },
    username: '',
    version: ''
  },

  onLaunch() {
    const s = api.cachedSettings()
    if (s) {
      this.globalData.theme = {
        mode: s.theme_mode || 'light',
        color: s.theme_color || '#5b6cff'
      }
    }
    const user = api.getUser()
    if (user) this.globalData.username = user.username || ''
  },

  /** 每次回到前台：先把当前登录账号同步给电脑端，再检查额度、不够就悄悄补 */
  onShow() {
    remind.syncAccount()
    remind.autoTopup()
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
