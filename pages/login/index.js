const api = require('../../utils/api')
const theme = require('../../utils/theme')

const AGREEMENT_KEY = 'ph_agreed_v1'

Page({
  data: Object.assign(
    {
      isRegister: false,
      username: '',
      password: '',
      error: '',
      loading: false,
      showPwd: false,
      agreed: false,
      serverUrl: ''
    },
    theme.data()
  ),

  onLoad() {
    // 已同意过协议则默认勾选，避免每次登录都要点一遍
    this.setData({ agreed: !!wx.getStorageSync(AGREEMENT_KEY) })
    if (api.isLoggedIn()) {
      wx.switchTab({ url: '/pages/home/index' })
    }
  },

  onShow() {
    this.setData(Object.assign({ serverUrl: api.getBaseUrl() }, theme.data()))
    theme.applyNav(theme.current())
  },

  /** 连不上服务时从登录页也能改地址 */
  goServer() {
    wx.switchTab({ url: '/pages/settings/index' })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const patch = {}
    patch[key] = e.detail.value
    if (this.data.error) patch.error = ''
    this.setData(patch)
  },

  togglePwd() {
    this.setData({ showPwd: !this.data.showPwd })
  },

  toggleMode() {
    if (this.data.loading) return
    this.setData({
      isRegister: !this.data.isRegister,
      error: ''
    })
  },

  toggleAgree() {
    const next = !this.data.agreed
    this.setData({ agreed: next, error: next ? this.data.error : '' })
    if (next) wx.setStorageSync(AGREEMENT_KEY, 1)
  },

  goAgreement() {
    wx.navigateTo({ url: '/pages/agreement/index' })
  },

  /** 免登录直达「监督群」：群数据全在微信云开发上，不依赖电脑端后端 */
  goGroups() {
    wx.navigateTo({ url: '/pages/groups/index' })
  },

  validate() {
    const username = (this.data.username || '').trim()
    const password = this.data.password || ''
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      return '用户名需为 3 至 32 位英文字母、数字或下划线'
    }
    if (password.length < 10) {
      return '密码至少 10 位'
    }
    return ''
  },

  submit() {
    if (this.data.loading) return
    if (!this.data.agreed) {
      this.setData({ error: '请先阅读并同意《用户协议与隐私政策》' })
      return
    }

    const invalid = this.validate()
    if (invalid) {
      this.setData({ error: invalid })
      return
    }

    const username = this.data.username.trim()
    const password = this.data.password
    const isRegister = this.data.isRegister

    this.setData({ loading: true, error: '' })

    const auth = isRegister
      ? api.register(username, password)
      : api.login(username, password)

    auth
      .then(() => {
        const app = getApp()
        // 登录后马上把「这个微信号在用哪个账号」同步给电脑端，提醒才不会推成别人的数据
        try {
          require('../../utils/remind').syncAccount(true)
        } catch (e) {}
        return app.syncSettings().catch(() => null)
      })
      .then(() => {
        this.setData({ loading: false })
        // 扫码 / 分享进来时带的目标页：登录完直接去那里，而不是总回首页
        const app = getApp()
        const target = app.globalData.pendingTarget
        app.globalData.pendingTarget = ''
        if (target) {
          wx.switchTab({ url: target, fail: () => wx.switchTab({ url: '/pages/home/index' }) })
        } else {
          wx.switchTab({ url: '/pages/home/index' })
        }
      })
      .catch((e) => {
        this.setData({
          loading: false,
          error: (e && e.message) || (isRegister ? '注册失败，请稍后重试' : '登录失败，请检查用户名或密码')
        })
      })
  }
})
