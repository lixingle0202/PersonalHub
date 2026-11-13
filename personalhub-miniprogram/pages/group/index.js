const groupdb = require('../../utils/groupdb')
const cloud = require('../../utils/cloud')
const theme = require('../../utils/theme')
const util = require('../../utils/util')

Page({
  data: {
    groupId: '',
    group: null,
    rows: [],
    nudges: [],
    loading: true,
    err: '',
    nudgeSheet: false,
    nudgeTarget: { openid: '', name: '' },
    nudgeTexts: [],
    nudgeCustom: '',
    nudgeDefault: true,
    nudgeMax: groupdb.NUDGE_MAX,
    draft: '',
    posting: false,
    tab: 'today',
    weekRows: [],
    weekDays: [],
    weekLoading: false,
    weekLoaded: false,
    subscribeTemplate: '',
    showSubscribe: false,
    avatarUrl: '',
    groupInitial: '群',
    editSheet: false,
    editName: '',
    editAvatar: '',
    editAvatarUrl: '',
    savingGroup: false,
    themeMode: 'light',
    themeStyle: '',
    color: '#5b6cff',
  },

  onLoad(options) {
    const opt = options || {}
    this.setData(theme.data())
    theme.applyNav(theme.current())
    this.setData({ color: theme.current().color })
    if (opt.id) {
      this.setData({ groupId: opt.id })
      return
    }
    if (opt.code) {
      // 从微信群分享的卡片进来：带着邀请码，先加入
      this.setData({ loading: true })
      groupdb
        .joinGroup(opt.code)
        .then((g) => {
          this.setData({ groupId: g.id })
          this.refresh()
        })
        .catch((e) => {
          this.setData({ err: (e && e.message) || '加入失败', loading: false })
        })
      return
    }
    this.setData({ err: '缺少群信息，请从监督群列表进入', loading: false })
  },

  onShow() {
    if (this.data.groupId) this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh())
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.redirectTo({ url: '/pages/groups/index' })
  },

  refresh() {
    if (!this.data.groupId) return Promise.resolve()
    return this.load()
  },

  load(silent) {
    const id = this.data.groupId
    if (!id) return Promise.resolve()
    if (!silent) this.setData({ loading: !this.data.group, err: '' })
    let myId = ''
    return cloud
      .openid()
      .then((oid) => {
        myId = oid
        return Promise.all([
          groupdb.getGroup(id),
          groupdb.listMembers(id),
          groupdb.todayChecks(id),
          groupdb.incomingNudges(id),
          groupdb.nudgedToday(id),
          groupdb.subscribeTemplateOf(id),
        ])
      })
      .then((res) => {
        const g = res[0] || {}
        const tpl = res[5] || ''
        this.setData({
          group: res[0],
          groupInitial: String(g.name || '群').slice(0, 1),
          rows: this.buildRows(res[1], res[2], res[4], myId),
          nudges: res[3],
          subscribeTemplate: tpl,
          showSubscribe: !!tpl && !groupdb.subAcceptedToday(),
          loading: false,
          err: '',
        })
        // 云函数已经换好临时地址就直接用；老数据（没有 avatarUrl）再走客户端兜底
        if (g.avatarUrl) {
          this.setData({ avatarUrl: g.avatarUrl })
          return
        }
        if (!g.avatar) {
          this.setData({ avatarUrl: '' })
          return
        }
        return cloud.tempUrl(g.avatar).then((url) => {
          if (url) this.setData({ avatarUrl: url })
        })
      })
      .catch((e) => {
        this.setData({ err: (e && e.message) || '读取群数据失败', loading: false })
      })
  },

  /** 把成员和我今天的计划清单合并成一行行看板数据 */
  buildRows(members, checks, nudged, myId) {
    const map = {}
    const order = []
    function ensure(openid, name) {
      if (!map[openid]) {
        map[openid] = {
          openid: openid,
          name: name || '队友',
          items: [],
          done: 0,
          total: 0,
          pct: 0,
          hasCheck: false,
          isMe: openid === myId,
          nudged: nudged.indexOf(openid) !== -1,
        }
        order.push(openid)
      } else if (name && map[openid].name === '队友') {
        map[openid].name = name
      }
      return map[openid]
    }
    for (let i = 0; i < members.length; i++) ensure(members[i].openid, members[i].name)
    for (let j = 0; j < checks.length; j++) {
      const c = checks[j]
      const row = ensure(c.openid, c.name)
      const items = Array.isArray(c.plans) ? c.plans : []
      row.items = items
      if (items.length) {
        row.done = items.filter(function (p) {
          return p.done
        }).length
        row.total = items.length
      } else {
        row.done = Number(c.done) || 0
        row.total = Number(c.total) || 0
      }
      row.hasCheck = items.length > 0 || row.total > 0
      row.pct = row.total ? Math.min(100, Math.round((row.done / row.total) * 100)) : 0
    }
    const rows = order.map((k) => map[k])
    // 我自己置顶，其余按完成率从高到低
    rows.sort((a, b) => {
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1
      return b.pct - a.pct
    })
    return rows
  },

  /** 我那一行的数据 */
  myRow() {
    const rows = this.data.rows || []
    for (let i = 0; i < rows.length; i++) if (rows[i].isMe) return rows[i]
    return null
  },

  onDraft(e) {
    this.setData({ draft: e.detail.value })
  },

  /** 添加一条今日计划（存到云开发，群友可见） */
  addDraft() {
    if (this.data.posting) return
    const text = String(this.data.draft || '').trim()
    if (!text) {
      util.toast('先写一条计划内容')
      return
    }
    const my = this.myRow()
    const items = ((my && my.items) || []).slice()
    if (items.length >= 8) {
      util.toast('最多 8 项，勾完再删掉一项')
      return
    }
    items.push({ text: text.slice(0, 20), done: false })
    this.postMy(items, true)
  },

  /** 点圆圈打勾 / 取消勾（只有自己的清单能点） */
  toggleItem(e) {
    if (this.data.posting) return
    const idx = Number(e.currentTarget.dataset.index)
    const my = this.myRow()
    if (!my || !Array.isArray(my.items) || idx < 0 || idx >= my.items.length) return
    const items = my.items.slice()
    items[idx] = { text: items[idx].text, done: !items[idx].done }
    this.postMy(items, false)
  },

  /** 把整份清单写回云端 */
  postMy(items, clearDraft) {
    const id = this.data.groupId
    if (!id) return
    this.setData({ posting: true })
    groupdb
      .postMyItems(id, items)
      .then(() => {
        this.setData({ posting: false, draft: clearDraft ? '' : this.data.draft })
        return this.load(true)
      })
      .catch((e) => {
        this.setData({ posting: false })
        util.toast((e && e.message) || '保存失败')
      })
  },

  /* ---------------- 今日 / 本周切换 ---------------- */

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    this.setData({ tab: tab })
    if (tab === 'week' && !this.data.weekLoaded && !this.data.weekLoading) this.loadWeek()
  },

  loadWeek() {
    const id = this.data.groupId
    if (!id) return
    this.setData({ weekLoading: true })
    groupdb
      .week(id)
      .then((w) => {
        this.setData({ weekRows: w.rows, weekDays: w.days, weekLoading: false, weekLoaded: true })
      })
      .catch((e) => {
        this.setData({ weekLoading: false })
        util.toast((e && e.message) || '读取周榜失败')
      })
  },

  /* ---------------- 复用昨天 ---------------- */

  /** 把昨天发的计划一键搬过来（默认全部未勾选），覆盖当前清单 */
  reuseYesterday() {
    if (this.data.posting) return
    const id = this.data.groupId
    if (!id) return
    groupdb
      .myDay(id)
      .then((d) => {
        const src = (d.plans || []).slice(0, 8)
        if (!src.length) {
          util.toast('昨天没有发过计划')
          return
        }
        const items = src.map((p) => ({ text: p.text, done: false }))
        this.postMy(items, false)
        util.toast('已带入昨天 ' + items.length + ' 项', 'success')
      })
      .catch((e) => util.toast((e && e.message) || '读取昨天失败'))
  },

  /* ---------------- 催办订阅消息 ---------------- */

  /** 征求一次订阅授权：接受一次 = 下一条催你的消息能弹微信服务通知 */
  askSubscribe() {
    const tpl = this.data.subscribeTemplate
    if (!tpl) return
    wx.requestSubscribeMessage({
      tmplIds: [tpl],
      success: (r) => {
        if (r && r[tpl] === 'accept') {
          groupdb.markSubAccepted()
          this.setData({ showSubscribe: false })
          util.toast('已开启，被催时会有微信通知', 'success')
        } else {
          util.toast('没有开启，以后想开再点')
        }
      },
      fail: () => util.toast('暂时无法开启，可稍后再试'),
    })
  },

  openNudge(e) {
    const ds = e.currentTarget.dataset
    this.setData({
      nudgeSheet: true,
      nudgeTarget: { openid: ds.openid, name: ds.name || '队友' },
      nudgeCustom: '',
      nudgeTexts: groupdb.myNudgeTexts(),
      nudgeDefault: groupdb.isDefaultNudgeTexts(),
    })
  },

  closeNudge() {
    this.setData({ nudgeSheet: false, nudgeCustom: '' })
  },

  pickNudge(e) {
    const text = e.currentTarget.dataset.text
    this.fireNudge(text)
  },

  /** 输入框里自己写的句子 */
  onNudgeInput(e) {
    this.setData({ nudgeCustom: e.detail.value })
  },

  /** 发一句自己写的；发完自动收进常用 */
  sendNudgeCustom() {
    const s = groupdb.cleanNudgeText(this.data.nudgeCustom)
    if (!s) {
      util.toast('先写一句吧')
      return
    }
    this.fireNudge(s, true)
  },

  /** 真正发出催办（remember=true 时把句子记进常用） */
  fireNudge(text, remember) {
    const target = this.data.nudgeTarget
    const groupId = this.data.groupId
    if (!target.openid || !groupId) return
    this.setData({ nudgeCustom: '' })
    groupdb
      .sendNudge(groupId, target.openid, target.name, text)
      .then(() => {
        const list = remember ? groupdb.rememberNudge(text) : this.data.nudgeTexts
        this.setData({
          nudgeSheet: false,
          nudgeTexts: list,
          nudgeDefault: groupdb.isDefaultNudgeTexts(),
        })
        util.toast('已催 ' + target.name, 'success')
        return this.load(true)
      })
      .catch((err) => util.toast((err && err.message) || '催办失败'))
  },

  /** 删掉某句常用（点右侧 ×） */
  removeNudge(e) {
    const text = e.currentTarget.dataset.text
    const list = groupdb.removeNudgeText(text)
    this.setData({ nudgeTexts: list, nudgeDefault: groupdb.isDefaultNudgeTexts() })
    util.toast('已删除')
  },

  /** 恢复默认 5 句 */
  resetNudge() {
    const list = groupdb.resetNudgeTexts()
    this.setData({ nudgeTexts: list, nudgeDefault: true })
    util.toast('已恢复默认', 'success')
  },

  ackNudges() {
    const ids = this.data.nudges.map((n) => n.id)
    if (!ids.length) return
    groupdb.markRead(ids)
    this.setData({ nudges: [] })
  },

  copyCode() {
    const g = this.data.group
    if (!g || !g.code) return
    wx.setClipboardData({
      data: g.code,
      success: () => util.toast('邀请码已复制', 'success'),
    })
  },

  /* ---------------- 群资料（群名 / 头像） ---------------- */

  openEdit() {
    const g = this.data.group
    if (!g) return
    if (!g.owner) {
      util.toast('只有群主能改群名和头像')
      return
    }
    this.setData({
      editSheet: true,
      editName: g.name || '',
      editAvatar: g.avatar || '',
      editAvatarUrl: this.data.avatarUrl || '',
    })
  },

  closeEdit() {
    this.setData({ editSheet: false })
  },

  onEditName(e) {
    this.setData({ editName: e.detail.value })
  },

  /** 选图 → 上传到云存储 → 拿到 fileID */
  chooseAvatar() {
    if (this.data.savingGroup) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (r) => {
        const f = ((r && r.tempFiles) || [])[0]
        const path = (f && f.tempFilePath) || ''
        if (!path) return
        this.setData({ editAvatarUrl: path, savingGroup: true })
        cloud
          .uploadAvatar(path, this.data.groupId || 'g')
          .then((fileID) => {
            this.setData({ editAvatar: fileID, savingGroup: false })
          })
          .catch((e) => {
            this.setData({ savingGroup: false, editAvatarUrl: this.data.avatarUrl || '' })
            util.toast((e && e.message) || '头像上传失败')
          })
      },
    })
  },

  removeAvatar() {
    this.setData({ editAvatar: '', editAvatarUrl: '' })
  },

  saveGroup() {
    if (this.data.savingGroup) return
    const name = String(this.data.editName || '').trim()
    if (!name) {
      util.toast('群名不能为空')
      return
    }
    this.setData({ savingGroup: true })
    groupdb
      .updateGroup(this.data.groupId, { name: name, avatar: this.data.editAvatar || '' })
      .then(() => {
        this.setData({ savingGroup: false, editSheet: false, avatarUrl: '' })
        util.toast('已保存', 'success')
        return this.load(true)
      })
      .catch((e) => {
        this.setData({ savingGroup: false })
        util.toast((e && e.message) || '保存失败')
      })
  },

  leaveGroup() {
    const g = this.data.group
    if (!g) return
    wx.showModal({
      title: '退出这个群？',
      content: '退出后看不到群里的完成情况，需要重新输入邀请码才能回来。',
      confirmText: '退出',
      confirmColor: '#e24b4a',
      success: (r) => {
        if (!r.confirm) return
        groupdb
          .leaveGroup(g.id)
          .then(() => {
            util.toast('已退出', 'success')
            const pages = getCurrentPages()
            if (pages.length > 1) wx.navigateBack()
            else wx.redirectTo({ url: '/pages/groups/index' })
          })
          .catch((e) => util.toast((e && e.message) || '操作失败'))
      },
    })
  },

  onShareAppMessage() {
    const g = this.data.group
    if (!g) return { title: 'PersonalHub · 互相监督打卡', path: '/pages/home/index' }
    return {
      title: '加入「' + g.name + '」，互相盯着别偷懒',
      path: '/pages/group/index?code=' + g.code,
    }
  },
})
