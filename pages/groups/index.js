const groupdb = require('../../utils/groupdb')
const cloud = require('../../utils/cloud')
const theme = require('../../utils/theme')
const util = require('../../utils/util')

const SETUP_KEY = 'ph_group_setup_done'

Page({
  data: {
    loading: true,
    err: '',
    showGuide: false,
    status: 'ok',
    groups: [],
    myName: '',
    nameDraft: '',
    nameInput: '',
    codeInput: '',
    createSheet: false,
    joinSheet: false,
    saving: false,
    themeMode: 'light',
    themeStyle: '',
    color: '#5b6cff'
  },

  onShow() {
    this.setData(theme.data())
    theme.applyNav(theme.current())
    this.setData({ color: theme.current().color })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  /**
   * 首次使用自动建好 4 个集合，省掉「去控制台建表 + 逐个设权限」的手工步骤。
   * 成功后写本地标记，之后不再重复调用。
   */
  ensureSetup() {
    if (wx.getStorageSync(SETUP_KEY)) return Promise.resolve()
    return groupdb
      .setup()
      .then((r) => {
        wx.setStorageSync(SETUP_KEY, 1)
        return r
      })
      .catch((e) => {
        // 建表失败不阻断列表读取（可能已经手工建过），把原因留给列表报错展示
        const msg = String((e && e.message) || '')
        if (!/已存在|exist/i.test(msg)) throw e
      })
  },

  /** 手动重试：部署完云函数后不用退出小程序 */
  retry() {
    wx.removeStorageSync(SETUP_KEY)
    this.load()
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/index' })
  },

  load() {
    const st = cloud.status()
    const name = groupdb.myName()
    this.setData({ status: st, myName: name, err: '', showGuide: false })
    if (st !== 'ok' || !name) {
      this.setData({ loading: false, groups: [] })
      return Promise.resolve()
    }
    this.setData({ loading: true })
    return this.ensureSetup()
      .then(() => groupdb.listMyGroups())
      .then((list) => {
        const groups = list.map((g) => ({
          id: g.id,
          name: g.name,
          code: g.code,
          avatar: g.avatar || '',
          avatarUrl: g.avatarUrl || '',
          owner: g.owner,
          memberCount: g.memberCount,
          initial: String(g.name || '群').slice(0, 1)
        }))
        this.setData({ groups: groups, loading: false })
        // 云函数没给地址（老数据 / 取链失败）时，客户端再兜底换一次
        const todo = groups.filter((g) => !g.avatarUrl && g.avatar)
        if (!todo.length) return
        return Promise.all(todo.map((g) => cloud.tempUrl(g.avatar))).then((urls) => {
          const patch = {}
          todo.forEach((g, i) => {
            patch[g.id] = urls[i] || ''
          })
          this.setData({
            groups: groups.map((g) => (patch[g.id] ? Object.assign({}, g, { avatarUrl: patch[g.id] }) : g))
          })
        })
      })
      .catch((e) => {
        this.setData({
          err: (e && e.message) || '读取群列表失败',
          loading: false,
          showGuide: true
        })
      })
  },

  onNameInput(e) {
    this.setData({ nameDraft: e.detail.value })
  },

  saveName() {
    const v = groupdb.setMyName(this.data.nameDraft)
    if (!v) {
      util.toast('名字不能为空')
      return
    }
    this.setData({ myName: v })
    this.load()
  },

  openCreate() {
    this.setData({ createSheet: true, nameInput: '' })
  },

  closeCreate() {
    this.setData({ createSheet: false })
  },

  onNameDraft(e) {
    this.setData({ nameInput: e.detail.value })
  },

  doCreate() {
    if (this.data.saving) return
    const nm = String(this.data.nameInput || '').trim()
    if (!nm) {
      util.toast('请填写群名')
      return
    }
    this.setData({ saving: true })
    groupdb
      .createGroup(nm)
      .then((g) => {
        this.setData({ saving: false, createSheet: false })
        util.toast('群建好了', 'success')
        wx.navigateTo({ url: '/pages/group/index?id=' + g.id })
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast((e && e.message) || '创建失败')
      })
  },

  openJoin() {
    this.setData({ joinSheet: true, codeInput: '' })
  },

  closeJoin() {
    this.setData({ joinSheet: false })
  },

  onCodeDraft(e) {
    this.setData({ codeInput: String(e.detail.value || '').toUpperCase() })
  },

  doJoin() {
    if (this.data.saving) return
    const code = String(this.data.codeInput || '').trim()
    if (code.length < 4) {
      util.toast('请输入 6 位邀请码')
      return
    }
    this.setData({ saving: true })
    groupdb
      .joinGroup(code)
      .then((g) => {
        this.setData({ saving: false, joinSheet: false })
        util.toast(g.joined ? '加入成功' : '你已经在群里了', 'success')
        wx.navigateTo({ url: '/pages/group/index?id=' + g.id })
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast((e && e.message) || '加入失败')
      })
  },

  openGroup(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/group/index?id=' + id })
  },

  onShareAppMessage() {
    return {
      title: 'PersonalHub · 和朋友互相监督，别偷懒',
      path: '/pages/home/index'
    }
  }
})
