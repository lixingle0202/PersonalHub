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
      agreed: false
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
    this.setData(theme.data())
    theme.applyNav(theme.current())
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
        return app.syncSettings().catch(() => null)
      })
      .then(() => {
        this.setData({ loading: false })
        wx.switchTab({ url: '/pages/home/index' })
      })
      .catch((e) => {
        this.setData({
          loading: false,
          error: (e && e.message) || (isRegister ? '注册失败，请稍后重试' : '登录失败，请检查用户名或密码')
        })
      })
  }
})
