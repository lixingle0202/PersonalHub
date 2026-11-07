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
      color: '#5b6cff'
    },
    theme.data()
  ),

  onLoad() {
    const d = util.today()
    this.setData({
      date: d,
      dateText: util.prettyDate(d),
      journalDate: d
    })
    this._journalLoaded = ''
  },

  onShow() {
    this.setData(theme.data())
    theme.applyNav(theme.current())
    this.initTab(0)
    if (!api.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.load()
    this.loadJournal(this.data.journalDate)
  },

  onPullDownRefresh() {
    Promise.all([this.load(true), this.loadJournal(this.data.journalDate, true)]).then(() =>
      wx.stopPullDownRefresh()
    )
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
        this.applyHome(d)
      })
      .catch((e) => {
        this.setData({ loading: false, error: (e && e.message) || '读取失败' })
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
      urgent: x.priority === 'urgent'
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
      color: theme.current().color
    })
    const pct = (d.stats || {}).completion_rate || 0
    if (fromCache) wx.nextTick(() => this.drawRing(pct))
    else this.drawRing(pct)
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
        content: e.currentTarget.dataset.content
      }
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
      }
    })
  },

  convertNote(e) {
    const id = e.currentTarget.dataset.id
    api
      .post('/quick-notes/' + id + '/convert', {
        target_type: 'agenda',
        plan_date: this.data.date,
        bucket: 'scheduled'
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
          Object.assign({}, x, { categoryLabel: util.CATEGORIES[x.category] || x.category })
        )
        this.setData({
          journalLoading: false,
          activities: rows,
          activityGroups: this.groupActivities(rows)
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
      items: map[k]
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
        request_id: util.uuid()
      })
      .then((res) => {
        const items = (res && res.items) || []
        const skipped = (res && res.skipped) || []
        this.setData({ journalLoading: false, journalText: '', journalSkipped: skipped })
        if (items.length) {
          util.toast(res.created ? '已分条记录 ' + items.length + ' 件事' : '这次描述已保存', 'success')
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
      }
    })
  },

  retry() {
    this.load()
    this.loadJournal(this.data.journalDate)
  }
})
