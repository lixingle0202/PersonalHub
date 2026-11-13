const api = require('../../utils/api')
const util = require('../../utils/util')
const theme = require('../../utils/theme')

const PRIORITY_TAG = { normal: '', low: '', high: '高', urgent: '紧急' }

Page({
  data: Object.assign(
    {
      loading: true,
      error: '',
      date: '',
      dateText: '',
      weekdayShort: '',
      stats: { total: 0, completed: 0, completion_rate: 0, must: 0 },
      agenda: [],
      pendingCount: 0,
      notes: [],
      activities: [],
      activityGroups: [],
      summaries: {},
      noteDraft: '',
      noteEditing: null,
      noteSaving: false,
      journalDate: '',
      journalText: '',
      journalLoading: false,
      journalSkipped: [],
      openSourceId: '',
      // 连续打卡天数 & 本周小结
      streak: 0,
      week: null,
      weekLoading: false,
      color: '#5b6cff',
    },
    theme.data(),
  ),

  onLoad() {
    const d = util.today()
    this.setData({
      date: d,
      dateText: util.prettyDate(d),
      journalDate: d,
    })
    this._journalLoaded = ''
    this._offline = util.offlineTracker(this)
  },

  onShow() {
    this.setData(theme.data())
    theme.applyNav(theme.current())
    this.initTab(0)
    if (!api.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    // 扫码/分享带目标进来且已登录：直接跳对应页，不在这页停留
    const app = getApp()
    const target = app.globalData.pendingTarget
    if (target && target !== '/pages/home/index') {
      app.globalData.pendingTarget = ''
      wx.switchTab({ url: target })
      return
    }
    app.globalData.pendingTarget = ''
    this.load()
    this.loadJournal(this.data.journalDate)
    this.loadWeek()
  },

  onPullDownRefresh() {
    Promise.all([this.load(true), this.loadJournal(this.data.journalDate, true)]).then(() => {
      this.loadWeek(true)
      wx.stopPullDownRefresh()
    })
  },

  initTab(index) {
    const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tb) tb.init(index, theme.current())
  },

  /* ---------------- 首页数据 ---------------- */
  load(silent) {
    const cacheKey = 'home_' + this.data.date
    const hasData = this.data.agenda.length || this.data.stats.total
    if (!silent && !hasData) {
      const cached = util.cacheGet(cacheKey)
      if (cached) {
        // 有缓存先画出来，用户立刻看到内容，再静默拉最新
        this.applyHome(cached, true)
      } else {
        this.setData({ loading: true })
      }
    }
    return api
      .get('/home', { date: this.data.date })
      .then((d) => {
        util.cacheSet(cacheKey, d)
        if (this._offline) this._offline.clear('home')
        this.applyHome(d)
      })
      .catch((e) => {
        // 连不上服务时回落到缓存，让用户至少能看今天有什么事
        const cached = util.cacheGetStale(cacheKey)
        if (cached) {
          this.applyHome(cached, true)
          if (this._offline) this._offline.mark('home', util.cacheStamp(cacheKey))
        } else {
          this.setData({ loading: false, error: (e && e.message) || '读取失败' })
        }
      })
  },

  applyHome(d, fromCache) {
    const agenda = ((d && d.agenda) || []).map((x) => ({
      id: x.id,
      title: x.title,
      status: x.status,
      bucket: x.bucket,
      priority: x.priority,
      done: x.status === 'completed',
      timeText: this.timeText(x),
      tag: PRIORITY_TAG[x.priority] || '',
      urgent: x.priority === 'urgent',
    }))
    // 未完成的排前面，已完成的沉底，避免清单看着像"都还没做"
    agenda.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0))
    this.setData({
      loading: false,
      error: '',
      stats: d.stats || this.data.stats,
      agenda: agenda,
      pendingCount: agenda.filter((x) => !x.done).length,
      notes: d.quick_notes || this.data.notes,
      activities: d.daily_activities || this.data.activities,
      summaries: d.summaries || this.data.summaries,
      color: theme.current().color,
    })
    const pct = (d.stats || {}).completion_rate || 0
    if (fromCache) wx.nextTick(() => this.drawRing(pct))
    else this.drawRing(pct)
    this.applyStreak()
  },

  /** 连续打卡：今天完成过事项就打一次卡（本地按账号记录） */
  applyStreak() {
    const user = api.getUser()
    const username = user && user.username
    const done = Number((this.data.stats || {}).completed) || 0
    const streak = done > 0 ? util.bumpStreak(username) : util.streakCount(username)
    if (streak !== this.data.streak) this.setData({ streak: streak })
  },

  /* ---------------- 本周小结 ---------------- */
  loadWeek(force) {
    const settings = api.cachedSettings() || {}
    const weekStart = settings.week_starts_on === 0 ? 0 : 1
    const t = util.parseDate(this.data.date)
    const offset = (t.getDay() - weekStart + 7) % 7
    const start = util.addDays(this.data.date, -offset)
    const key = 'week_' + start
    if (!force) {
      const cached = util.cacheGet(key, 60 * 60 * 1000)
      if (cached) {
        this.setData({ week: cached })
        return
      }
    }
    this.setData({ weekLoading: true })
    const days = []
    for (let i = 0; i < 7; i++) days.push(util.addDays(start, i))

    const qAgenda = days.map((d) => api.get('/agenda', { date: d }).catch(() => []))
    const qHealth = days.map((d) => api.get('/diet/health/' + d).catch(() => null))
    Promise.all(qAgenda.concat(qHealth)).then((res) => {
      const agendas = res.slice(0, 7)
      const healths = res.slice(7)
      let total = 0
      let completed = 0
      let activeDays = 0
      let water = 0
      const weights = []
      const bars = days.map((d, i) => {
        const list = Array.isArray(agendas[i]) ? agendas[i] : (agendas[i] && agendas[i].items) || []
        const dayTotal = list.filter((x) => x.status !== 'cancelled').length
        const dayDone = list.filter((x) => x.status === 'completed').length
        total += dayTotal
        completed += dayDone
        if (dayDone > 0) activeDays += 1
        const h = healths[i] || {}
        water += Number(h.water_ml) || 0
        if (h.weight_kg) weights.push({ date: d, kg: Number(h.weight_kg) })
        return {
          date: d,
          label: d.slice(8),
          done: dayDone,
          h: dayTotal ? Math.round((dayDone / dayTotal) * 100) : 0,
        }
      })
      let weightDelta = 0
      if (weights.length >= 2)
        weightDelta = Math.round((weights[weights.length - 1].kg - weights[0].kg) * 10) / 10
      const week = {
        start: start,
        end: days[6],
        total: total,
        completed: completed,
        rate: total ? Math.round((completed / total) * 100) : 0,
        activeDays: activeDays,
        waterL: Math.round(water / 100) / 10,
        weightDelta: weightDelta,
        bars: bars,
      }
      util.cacheSet(key, week)
      this.setData({ week: week, weekLoading: false })
    })
  },

  /** 周报分享（右上角菜单 / 卡片里的分享按钮） */
  onShareAppMessage() {
    const w = this.data.week
    const streak = this.data.streak
    let title = 'PersonalHub · 让每一天，从容开始'
    if (w && w.completed > 0) {
      title = '我本周完成了 ' + w.completed + ' 件事，连续打卡 ' + streak + ' 天'
    } else if (streak > 0) {
      title = '我已经连续打卡 ' + streak + ' 天啦'
    }
    return {
      title: title,
      path: '/pages/home/index?target=home',
    }
  },

  timeText(x) {
    if (x.start_time && x.end_time) return x.start_time + '–' + x.end_time
    if (x.start_time) return x.start_time
    return '随时'
  },

  /* 完成度环形图 */
  drawRing(percent) {
    const t = theme.current()
    const color = t.color
    const rail = t.mode === 'dark' ? '#3a4359' : '#e4e8f2'
    const query = wx.createSelectorQuery()
    query
      .select('#ring')
      .fields({ node: true, size: true })
      .exec((res) => {
        const item = res && res[0]
        if (!item || !item.node) return
        const canvas = item.node
        const ctx = canvas.getContext('2d')
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const dpr = info.pixelRatio || 2
        const w = item.width
        const h = item.height
        canvas.width = w * dpr
        canvas.height = h * dpr
        ctx.scale(dpr, dpr)
        ctx.clearRect(0, 0, w, h)
        const lw = 7
        const r = Math.min(w, h) / 2 - lw / 2 - 1
        const cx = w / 2
        const cy = h / 2
        ctx.lineWidth = lw
        ctx.lineCap = 'round'
        ctx.strokeStyle = rail
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.stroke()
        const pct = Math.max(0, Math.min(100, Number(percent) || 0))
        if (pct > 0) {
          ctx.strokeStyle = color
          ctx.beginPath()
          ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * pct) / 100)
          ctx.stroke()
        }
      })
  },

  /* ---------------- 今日清单 ---------------- */
  toggleAgenda(e) {
    const id = e.currentTarget.dataset.id
    const done = e.currentTarget.dataset.done
    const action = done ? 'reopen' : 'complete'
    api
      .post('/agenda/' + id + '/' + action)
      .then(() => this.load(true))
      .catch((err) => util.toast(err.message || '操作失败'))
  },

  goToday() {
    wx.switchTab({ url: '/pages/today/index' })
  },

  goGroups() {
    wx.navigateTo({ url: '/pages/groups/index' })
  },

  goLearning() {
    wx.switchTab({ url: '/pages/learning/index' })
  },

  goDiet() {
    wx.switchTab({ url: '/pages/diet/index' })
  },

  /* ---------------- 快速备忘 ---------------- */
  onNoteInput(e) {
    this.setData({ noteDraft: e.detail.value })
  },

  addNote() {
    const content = (this.data.noteDraft || '').trim()
    if (!content) return
    api
      .post('/quick-notes', { content: content })
      .then(() => {
        this.setData({ noteDraft: '' })
        util.toast('已记录', 'success')
        return this.load(true)
      })
      .catch((e) => util.toast(e.message || '记录失败'))
  },

  startEditNote(e) {
    this.setData({
      noteEditing: {
        id: e.currentTarget.dataset.id,
        content: e.currentTarget.dataset.content,
      },
    })
  },

  onEditNoteInput(e) {
    this.setData({ 'noteEditing.content': e.detail.value })
  },

  cancelEditNote() {
    this.setData({ noteEditing: null })
  },

  saveNote() {
    const note = this.data.noteEditing
    if (!note || !note.content.trim() || this.data.noteSaving) return
    this.setData({ noteSaving: true })
    api
      .patch('/quick-notes/' + note.id, { content: note.content.trim() })
      .then(() => {
        this.setData({ noteEditing: null, noteSaving: false })
        util.toast('备忘已修改', 'success')
        return this.load(true)
      })
      .catch((e) => {
        this.setData({ noteSaving: false })
        util.toast(e.message || '修改失败')
      })
  },

  deleteNote(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除这条备忘？',
      content: '删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api
          .del('/quick-notes/' + id)
          .then(() => this.load(true))
          .catch((err) => util.toast(err.message || '删除失败'))
      },
    })
  },

  convertNote(e) {
    const id = e.currentTarget.dataset.id
    api
      .post('/quick-notes/' + id + '/convert', {
        target_type: 'agenda',
        plan_date: this.data.date,
        bucket: 'scheduled',
      })
      .then(() => {
        util.toast('已加入今天', 'success')
        return this.load(true)
      })
      .catch((err) => util.toast(err.message || '加入失败'))
  },

  /* ---------------- 日常记录 ---------------- */
  loadJournal(date, silent) {
    if (!date) return Promise.resolve()
    if (!silent) this.setData({ journalLoading: true })
    return api
      .get('/daily-activities', { date: date })
      .then((list) => {
        const rows = (list || []).map((x) =>
          Object.assign({}, x, { categoryLabel: util.CATEGORIES[x.category] || x.category }),
        )
        this.setData({
          journalLoading: false,
          activities: rows,
          activityGroups: this.groupActivities(rows),
        })
        this._journalLoaded = date
      })
      .catch(() => this.setData({ journalLoading: false }))
  },

  /** 同类记录归到一组，顺序固定，方便一眼扫完 */
  groupActivities(rows) {
    const order = ['learning', 'diet', 'exercise', 'work', 'health', 'life', 'leisure', 'other']
    const map = {}
    ;(rows || []).forEach((x) => {
      const key = x.category || 'other'
      if (!map[key]) map[key] = []
      map[key].push(x)
    })
    const keys = order
      .filter((k) => map[k])
      .concat(Object.keys(map).filter((k) => order.indexOf(k) < 0))
    return keys.map((k) => ({
      key: k,
      label: util.CATEGORIES[k] || k,
      items: map[k],
    }))
  },

  shiftJournal(e) {
    const delta = Number(e.currentTarget.dataset.delta)
    const next = delta === 0 ? util.today() : util.addDays(this.data.journalDate, delta)
    if (next > util.today()) return
    this.setData({ journalDate: next, openSourceId: '' })
    this.loadJournal(next)
  },

  onJournalDate(e) {
    const d = e.detail.value
    if (!d || d > util.today()) return
    this.setData({ journalDate: d, openSourceId: '' })
    this.loadJournal(d)
  },

  onJournalInput(e) {
    this.setData({ journalText: e.detail.value })
  },

  submitJournal() {
    const text = (this.data.journalText || '').trim()
    if (!text || this.data.journalLoading) return
    const date = this.data.journalDate
    this.setData({ journalLoading: true, journalSkipped: [] })
    api
      .post('/daily-activities/narrate', {
        activity_date: date,
        text: text,
        request_id: util.uuid(),
      })
      .then((res) => {
        const items = (res && res.items) || []
        const skipped = (res && res.skipped) || []
        this.setData({ journalLoading: false, journalText: '', journalSkipped: skipped })
        if (items.length) {
          util.toast(
            res.created ? '已分条记录 ' + items.length + ' 件事' : '这次描述已保存',
            'success',
          )
          this.loadJournal(date, true)
        } else {
          util.toast('没有可记录的已做事项，请调整描述')
        }
      })
      .catch((e) => {
        this.setData({ journalLoading: false })
        util.toast(e.message || '记录失败，请重试')
      })
  },

  toggleSource(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ openSourceId: this.data.openSourceId === id ? '' : id })
  },

  deleteActivity(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除这条日常记录？',
      confirmText: '删除',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api
          .del('/daily-activities/' + id)
          .then(() => this.loadJournal(this.data.journalDate, true))
          .catch((err) => util.toast(err.message || '删除失败'))
      },
    })
  },

  /** 离线横幅点击：跳到「数据与设置」改服务地址（换隧道域名时用） */
  goServer() {
    wx.switchTab({ url: '/pages/settings/index' })
  },

  retry() {
    this.load()
    this.loadJournal(this.data.journalDate)
  },
})
