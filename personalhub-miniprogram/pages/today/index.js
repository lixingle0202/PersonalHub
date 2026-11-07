const api = require('../../utils/api')
const util = require('../../utils/util')
const theme = require('../../utils/theme')

const GROUP_DEFS = [
  { key: 'must', label: '必须完成' },
  { key: 'scheduled', label: '按时间安排' },
  { key: 'optional', label: '有空再做' },
  { key: 'completed', label: '已完成' }
]

const MODULE_LABEL = { learning: '学习', diet: '饮食', general: '' }

Page({
  data: Object.assign(
    {
      loading: true,
      error: '',
      date: '',
      dateText: '',
      isToday: true,
      groups: [],
      total: 0,
      completed: 0,
      saving: false,

      // 新增/编辑计划
      editing: false,
      formError: '',
      form: {
        id: '',
        title: '',
        plan_date: '',
        bucket: 'scheduled',
        priority: 'normal',
        start_time: '',
        end_time: '',
        notes: ''
      },
      buckets: util.BUCKETS,
      priorities: util.PRIORITIES,

      // 结束今日
      ending: false,
      endItems: [],
      endSummary: ''
    },
    theme.data()
  ),

  onLoad() {
    const d = util.today()
    this.setData({ date: d, dateText: util.shortDate(d), isToday: true })
  },

  onShow() {
    this.setData(theme.data())
    theme.applyNav(theme.current())
    const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tb) tb.init(1, theme.current())
    if (!api.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.load()
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  load(silent) {
    const cacheKey = 'agenda_' + this.data.date
    if (!silent && !this.data.groups.length) {
      const cached = util.cacheGet(cacheKey)
      if (cached) this.applyList(cached)
      else this.setData({ loading: true })
    }
    return api
      .get('/agenda', { date: this.data.date })
      .then((list) => {
        util.cacheSet(cacheKey, list || [])
        this.applyList(list)
      })
      .catch((e) => this.setData({ loading: false, error: (e && e.message) || '读取失败' }))
  },

  applyList(list) {
    const items = (list || []).map((x) => ({
      id: x.id,
      title: x.title,
      bucket: x.bucket,
      priority: x.priority,
      status: x.status,
      module: x.module,
      moduleLabel: MODULE_LABEL[x.module] || '',
      notes: x.notes,
      done: x.status === 'completed',
      timeText: this.timeText(x),
      tag: this.priorityTag(x.priority)
    }))
    const groups = GROUP_DEFS.map((g) => {
      const rows = items.filter((x) => (g.key === 'completed' ? x.done : x.bucket === g.key && !x.done))
      return { key: g.key, label: g.label, items: rows, count: rows.length }
    })
    this.setData({
      loading: false,
      error: '',
      groups: groups,
      total: items.length,
      completed: items.filter((x) => x.done).length
    })
  },

  timeText(x) {
    if (x.start_time && x.end_time) return x.start_time + '–' + x.end_time
    if (x.start_time) return x.start_time + ' 起'
    return ''
  },

  priorityTag(p) {
    if (p === 'urgent') return '紧急'
    if (p === 'high') return '高'
    return ''
  },

  /* ---------------- 日期切换 ---------------- */
  shiftDate(e) {
    const delta = Number(e.currentTarget.dataset.delta)
    const next = delta === 0 ? util.today() : util.addDays(this.data.date, delta)
    this.setData({
      date: next,
      dateText: util.shortDate(next),
      isToday: next === util.today()
    })
    this.load()
  },

  onPickDate(e) {
    const d = e.detail.value
    this.setData({ date: d, dateText: util.shortDate(d), isToday: d === util.today() })
    this.load()
  },

  /* ---------------- 完成 / 操作 ---------------- */
  toggle(e) {
    const id = e.currentTarget.dataset.id
    const done = e.currentTarget.dataset.done
    api
      .post('/agenda/' + id + '/' + (done ? 'reopen' : 'complete'))
      .then(() => this.load(true))
      .catch((err) => util.toast(err.message || '操作失败'))
  },

  findRow(id) {
    let hit = null
    this.data.groups.forEach((g) => {
      g.items.forEach((x) => {
        if (x.id === id) hit = x
      })
    })
    return hit
  },

  openActions(e) {
    const row = this.findRow(e.currentTarget.dataset.id)
    if (!row) return
    if (row.done) {
      wx.showActionSheet({
        itemList: ['重新打开', '编辑', '删除'],
        success: (r) => {
          if (r.tapIndex === 0) this.reopen(row.id)
          if (r.tapIndex === 1) this.openEditor(row)
          if (r.tapIndex === 2) this.confirmDelete(row)
        }
      })
      return
    }
    wx.showActionSheet({
      itemList: ['编辑', '顺延到明天', '删除'],
      success: (r) => {
        if (r.tapIndex === 0) this.openEditor(row)
        if (r.tapIndex === 1) this.reschedule(row)
        if (r.tapIndex === 2) this.confirmDelete(row)
      }
    })
  },

  reopen(id) {
    api
      .post('/agenda/' + id + '/reopen')
      .then(() => this.load(true))
      .catch((e) => util.toast(e.message || '操作失败'))
  },

  reschedule(row) {
    api
      .post('/agenda/' + row.id + '/reschedule', { plan_date: util.addDays(this.data.date, 1) })
      .then(() => {
        util.toast('已顺延到明天', 'success')
        return this.load(true)
      })
      .catch((e) => util.toast(e.message || '顺延失败'))
  },

  confirmDelete(row) {
    wx.showModal({
      title: '删除这条计划？',
      content: row.title,
      confirmText: '删除',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api
          .del('/agenda/' + row.id)
          .then(() => this.load(true))
          .catch((e) => util.toast(e.message || '删除失败'))
      }
    })
  },

  /* ---------------- 新增 / 编辑 ---------------- */
  openCreate() {
    util.setTabBarHidden(true)
    this.setData({
      editing: true,
      formError: '',
      form: {
        id: '',
        title: '',
        plan_date: this.data.date,
        bucket: 'scheduled',
        priority: 'normal',
        start_time: '',
        end_time: '',
        notes: ''
      }
    })
  },

  openEditor(row) {
    util.setTabBarHidden(true)
    this.setData({
      editing: true,
      formError: '',
      form: {
        id: row.id,
        title: row.title,
        plan_date: this.data.date,
        bucket: row.bucket || 'scheduled',
        priority: row.priority || 'normal',
        start_time: '',
        end_time: '',
        notes: row.notes || ''
      }
    })
    api
      .get('/agenda/' + row.id)
      .then((x) => {
        this.setData({
          'form.plan_date': x.plan_date || this.data.date,
          'form.start_time': x.start_time || '',
          'form.end_time': x.end_time || '',
          'form.notes': x.notes || ''
        })
      })
      .catch(() => {})
  },

  closeEditor() {
    util.setTabBarHidden(false)
    this.setData({ editing: false })
  },

  onFormInput(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch['form.' + key] = e.detail.value
    if (key === 'title' && this.data.formError) patch.formError = ''
    this.setData(patch)
  },

  setBucket(e) {
    this.setData({ 'form.bucket': e.currentTarget.dataset.value })
  },

  setPriority(e) {
    this.setData({ 'form.priority': e.currentTarget.dataset.value })
  },

  pickFormDate(e) {
    this.setData({ 'form.plan_date': e.detail.value })
  },

  pickFormTime(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch['form.' + key] = e.detail.value
    this.setData(patch)
  },

  saveForm() {
    const f = this.data.form
    if (!f.title.trim()) {
      // 内联提示，避免 toast 一闪而过、弹层像「点了没反应」
      this.setData({ formError: '写一句话就能保存，例如「读 20 页书」' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true, formError: '' })

    const payload = {
      title: f.title.trim(),
      plan_date: f.plan_date,
      start_time: f.start_time || null,
      end_time: f.end_time || null,
      priority: f.priority,
      bucket: f.bucket,
      notes: f.notes || ''
    }

    const task = f.id ? api.patch('/agenda/' + f.id, payload) : api.post('/agenda', payload)
    task
      .then(() => {
        this.setData({ saving: false, editing: false })
        util.setTabBarHidden(false)
        util.toast(f.id ? '已保存' : '已添加', 'success')
        if (f.plan_date !== this.data.date) {
          this.setData({ date: f.plan_date, dateText: util.shortDate(f.plan_date), isToday: f.plan_date === util.today() })
        }
        return this.load(true)
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast(e.message || '保存失败')
      })
  },

  /* ---------------- 结束今日 ---------------- */
  openEndDay() {
    const items = []
    this.data.groups.forEach((g) => {
      if (g.key === 'completed') return
      g.items.forEach((x) => items.push(Object.assign({}, x, { action: 'tomorrow' })))
    })
    if (!items.length) {
      util.toast('今天没有未完成的事项')
      return
    }
    util.setTabBarHidden(true)
    this.setData({ ending: true, endItems: items, endSummary: '' })
  },

  closeEndDay() {
    util.setTabBarHidden(false)
    this.setData({ ending: false })
  },

  setEndAction(e) {
    const index = Number(e.currentTarget.dataset.index)
    const action = e.currentTarget.dataset.action
    this.setData({ ['endItems[' + index + '].action']: action })
  },

  onEndSummary(e) {
    this.setData({ endSummary: e.detail.value })
  },

  submitEndDay() {
    if (this.data.saving) return
    this.setData({ saving: true })
    const actions = this.data.endItems
      .filter((x) => x.action !== 'keep')
      .map((x) => ({ item_id: x.id, action: x.action, target_date: null }))

    api
      .post('/agenda/end-day', {
        date: this.data.date,
        actions: actions,
        summary: this.data.endSummary || ''
      })
      .then(() => {
        this.setData({ saving: false, ending: false })
        util.setTabBarHidden(false)
        util.toast('今天的计划已收尾', 'success')
        return this.load(true)
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast(e.message || '操作失败')
      })
  },

  noop() {},

  retry() {
    this.load()
  }
})
