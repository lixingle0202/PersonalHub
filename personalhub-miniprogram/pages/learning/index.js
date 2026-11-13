const api = require('../../utils/api')
const util = require('../../utils/util')
const theme = require('../../utils/theme')
const remind = require('../../utils/remind')

const PRIORITIES = util.PRIORITIES

// AI 分段生成
// 实测本机模型：1 天约 8 秒、3 天 25~70 秒、7 天一次性要 148 秒。
// 后端在 Cloudflare 隧道后面，网关 100 秒拿不到响应就断成 524，
// 所以这里把长计划拆成每段 2 天的多个请求串行跑，再在本地合并——
// 单段最坏也就 40 秒上下，离网关上限有两倍余量。
const AI_CHUNK_DAYS = 2
const AI_CHUNK_TIMEOUT = 95000

Page({
  data: Object.assign(
    {
      loading: true,
      error: '',
      goals: [],
      selectedId: '',
      goal: null,
      // 微信提醒：remindOn 是本机是否已授权过，quotaLeft 是还能收几条
      remindOn: remind.isOn(),
      quotaLeft: 0,
      tab: 'plan',
      days: [],
      notices: [],
      acking: '',
      saving: false,
      deletingGoal: false,

      sheet: '',
      goalForm: { name: '', goal: '', start_date: '', target_date: '', estimated_minutes: 30 },
      taskForm: {
        id: '',
        title: '',
        details: '',
        plan_date: '',
        priority: 'normal',
        estimated_minutes: 30,
        section_id: '',
        agenda_id: '',
        start_time: '',
        end_time: '',
        orig_start: '',
        orig_end: '',
      },
      sessionForm: { studied_on: '', actual_minutes: 45, notes: '', problems: '', next_step: '' },
      resourceForm: { name: '', link: '', notes: '' },

      // AI 生成学习计划
      aiLearnForm: {
        topic: '',
        objective: '',
        current_level: '零基础',
        preferences: '',
        days: 7,
        daily_minutes: 45,
        start_date: '',
      },
      aiGenerating: false,
      aiDraft: null,
      aiDraftDays: [],
      aiImporting: false,
      aiError: '',
      aiEditingTask: '',
      // 分段生成进度 / 部分结果
      aiProgress: 0,
      aiProgressText: '',
      aiElapsedText: '',
      aiPartial: false,
      aiCanResume: false,
      aiResumeDays: 0,

      // 番茄钟
      pomoOpen: false,
      pomoPresets: [25, 45, 60],
      pomoMin: 25,
      pomoCustom: '25',
      pomoLeft: 1500,
      pomoLabel: '25:00',
      pomoPct: 0,
      pomoRunning: false,
      pomoToday: 0,
      pomoTaskPick: -1,
      todayTasks: [],

      priorities: PRIORITIES,
      progressDraft: 0,
      progressDirty: false,
      autoProgress: 0,
      doneCount: 0,
      taskCount: 0,
      syncing: false,
      color: '#5b6cff',
    },
    theme.data(),
  ),

  onLoad() {
    const d = util.today()
    this.setData({
      'goalForm.start_date': d,
      'goalForm.target_date': util.addDays(d, 30),
      'sessionForm.studied_on': d,
      'aiLearnForm.start_date': util.addDays(d, 1),
    })
    this._offline = util.offlineTracker(this)
  },

  onShow() {
    this.setData(Object.assign({ color: theme.current().color }, theme.data()))
    theme.applyNav(theme.current())
    const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tb) tb.init(2, theme.current())
    if (!api.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.loadAll()
    if (remind.isOn()) {
      // 额度不够就先静默补一批（内部有 15 分钟节流，不会每次进页面都发请求）
      remind.autoTopup().then(() => this.refreshQuota())
    }
    // 从后台切回来时按时间戳补算剩余时间
    if (this.data.pomoRunning && this._pomoEnd) {
      const left = Math.round((this._pomoEnd - Date.now()) / 1000)
      if (left <= 0) {
        this.finishPomo()
      } else {
        this.setData({ pomoLeft: left, pomoLabel: this.fmtPomo(left), pomoPct: this.pomoPct(left) })
        this.runPomoTimer()
      }
    }
  },

  onHide() {
    if (this._pomoTimer) clearInterval(this._pomoTimer)
    this._pomoTimer = null
    this.stopAiClock()
  },

  onUnload() {
    if (this._pomoTimer) clearInterval(this._pomoTimer)
    this._pomoTimer = null
    if (this._pomoEnd) this._pomoEnd = 0
    this.stopAiClock()
    if (this._aiRun) this._aiRun.cancel = true
  },

  onPullDownRefresh() {
    this.loadAll(true).then(() => wx.stopPullDownRefresh())
  },

  noop() {},

  loadAll(silent) {
    if (!silent) this.setData({ loading: !this.data.goals.length })
    return Promise.all([this.loadGoals(silent), this.checkOverdue()])
  },

  loadGoals(silent) {
    return api
      .get('/learning/goals')
      .then((list) => {
        util.cacheSet('learning_goals', list || [])
        if (this._offline) this._offline.clear('goals')
        this.applyGoals((list || []).filter((g) => !g.deleted_at))
      })
      .catch((e) => {
        const cached = util.cacheGetStale('learning_goals')
        if (cached) {
          this.applyGoals((cached || []).filter((g) => !g.deleted_at))
          if (this._offline) this._offline.mark('goals', util.cacheStamp('learning_goals'))
        } else {
          this.setData({ loading: false, error: (e && e.message) || '读取失败' })
        }
      })
  },

  applyGoals(goals) {
    // 当前选中的目标可能刚被删掉，回落到第一个
    const keep = goals.some((g) => g.id === this.data.selectedId)
    const selected = keep ? this.data.selectedId : (goals[0] && goals[0].id) || ''
    this.setData({ goals: goals, selectedId: selected, loading: false, error: '' })
    this.syncDueBadge(goals)
    if (selected) return this.loadGoal(selected)
    this.setData({
      goal: null,
      days: [],
      taskCount: 0,
      doneCount: 0,
      autoProgress: 0,
      progressDraft: 0,
      progressDirty: false,
    })
  },

  /**
   * 临期未完成检测：目标 progress < 100 且 target_date 在 2 天内（含已过期）。
   * 结果驱动两样东西：页面横幅 + 「学习计划」tab 的红色角标。
   */
  syncDueBadge(goals) {
    const t = util.today()
    const dueGoals = []
    ;(goals || []).forEach((g) => {
      if (!g.target_date || (g.progress || 0) >= 100) return
      const left = util.diffDays(g.target_date, t)
      if (left > 2) return
      dueGoals.push({ id: g.id, name: g.name, left: left, text: this.dueText(left) })
    })
    try {
      wx.setStorageSync('ph_badge_learning', dueGoals.length)
    } catch (e) {
      /* 存不下就算了 */
    }
    const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tb && tb.setBadge) tb.setBadge(2, dueGoals.length)
    this.setData({ dueGoals: dueGoals, dueCount: dueGoals.length })
    return dueGoals
  },

  dueText(left) {
    if (left < 0) return '已过期 ' + -left + ' 天'
    if (left === 0) return '今天到期'
    return '还剩 ' + left + ' 天'
  },

  /**
   * 开启「微信提醒」：一次授权就覆盖所有计划（开始前 / 到期前各提醒一次），
   * 不需要对每个计划单独开开关。具体流程在 utils/remind.js，设置页用的是同一份。
   */
  subscribeDueRemind() {
    remind.subscribe().then((ok) => {
      this.setData({ remindOn: remind.isOn() })
      if (ok) this.refreshQuota()
    })
  },

  refreshQuota() {
    remind.quota().then((n) => this.setData({ quotaLeft: n }))
  },

  loadGoal(id) {
    return api
      .get('/learning/goals/' + id)
      .then((g) => {
        util.cacheSet('learning_goal_' + id, g)
        if (this._offline) this._offline.clear('goal')
        this.applyGoal(g)
      })
      .catch((e) => {
        const cached = util.cacheGetStale('learning_goal_' + id)
        if (cached) {
          this.applyGoal(cached)
          if (this._offline) this._offline.mark('goal', util.cacheStamp('learning_goal_' + id))
        } else {
          util.toast(e.message || '读取学习目标失败')
        }
      })
  },

  applyGoal(g) {
    const tasks = (g.tasks || []).filter((t) => !t.archived_at)
    const stats = this.progressStats(tasks)
    // 选中目标临期且有任务没做完 → 顶部横幅提醒
    let dueBanner = ''
    if (g.target_date && stats.total > 0 && stats.done < stats.total) {
      const left = util.diffDays(g.target_date, util.today())
      if (left <= 2) {
        dueBanner =
          '「' +
          (g.name || '学习计划') +
          '」' +
          this.dueText(left) +
          '，还有 ' +
          (stats.total - stats.done) +
          ' 项任务没完成'
      }
    }
    this.setData({
      goal: Object.assign({}, g, { tasks: tasks }),
      progressDraft: g.progress || 0,
      progressDirty: false,
      autoProgress: stats.percent,
      doneCount: stats.done,
      taskCount: stats.total,
      days: this.groupTasks(tasks),
      dueBanner: dueBanner,
    })
    this.enrichTaskTimes()
  },

  /**
   * 任务本身不存开始/结束时间，时间存在对应的「今日计划」条目上。
   * 这里按 agenda_id 把时间取回来，列表里就能显示 09:00–10:00，编辑时也能回填。
   */
  enrichTaskTimes() {
    const days = this.data.days || []
    const dates = []
    days.forEach((d) => {
      if (d.key && d.key !== 'none' && dates.indexOf(d.key) < 0) dates.push(d.key)
    })
    if (!dates.length) return
    const want = dates.slice(0, 14)
    Promise.all(want.map((d) => api.get('/agenda', { date: d }).catch(() => []))).then((lists) => {
      const map = {}
      lists.forEach((list) => {
        const arr = Array.isArray(list) ? list : (list && list.items) || []
        arr.forEach((it) => {
          if (!it || !it.id) return
          if (it.start_time || it.end_time)
            map[it.id] = { s: it.start_time || '', e: it.end_time || '' }
        })
      })
      const next = (this.data.days || []).map((d) =>
        Object.assign({}, d, {
          items: (d.items || []).map((t) => {
            const hit = map[t.agenda_id]
            const st = hit ? hit.s : ''
            const et = hit ? hit.e : ''
            return Object.assign({}, t, {
              start_time: st,
              end_time: et,
              time_text: st || et ? (st || '未设') + '–' + (et || '未设') : '',
            })
          }),
        }),
      )
      this.setData({ days: next })
    })
  },

  /** 按任务完成情况算出的「真实进度」，只统计有标题且未归档的任务 */
  progressStats(tasks) {
    const list = (tasks || []).filter((t) => !t.archived_at)
    const total = list.length
    const done = list.filter((t) => t.status === 'completed').length
    return { total: total, done: done, percent: total ? Math.round((done / total) * 100) : 0 }
  },

  /** 把进度对齐到任务完成度；silent=true 时不弹提示（勾完任务自动同步用） */
  syncProgressToTasks(silent) {
    const g = this.data.goal
    if (!g || !g.tasks || !g.tasks.length) {
      if (!silent) util.toast('这个目标还没有任务')
      return Promise.resolve()
    }
    const stats = this.progressStats(g.tasks)
    if (Number(g.progress) === stats.percent) {
      if (!silent) util.toast('进度已经是 ' + stats.percent + '% 了')
      return Promise.resolve()
    }
    this.setData({ syncing: true })
    return api
      .patch('/learning/goals/' + g.id, { progress: stats.percent })
      .then(() => {
        this.setData({ syncing: false })
        if (!silent) util.toast('已同步为 ' + stats.percent + '%', 'success')
        return this.loadGoals(true)
      })
      .catch((e) => {
        this.setData({ syncing: false })
        if (!silent) util.toast(e.message || '同步失败')
      })
  },

  groupTasks(tasks) {
    const map = {}
    tasks.forEach((t) => {
      const key = t.plan_date || 'none'
      if (!map[key]) map[key] = []
      map[key].push({
        id: t.id,
        title: t.title,
        details: t.details,
        status: t.status,
        agenda_id: t.agenda_id,
        plan_date: t.plan_date,
        minutes: t.estimated_minutes,
        section_id: t.section_id || '',
        start_time: t.start_time || '',
        end_time: t.end_time || '',
        time_text: t.time_text || '',
        done: t.status === 'completed',
      })
    })
    return Object.keys(map)
      .sort((a, b) => {
        if (a === 'none') return 1
        if (b === 'none') return -1
        return a < b ? -1 : 1
      })
      .map((k) => ({
        key: k,
        date: k === 'none' ? '未安排日期' : util.shortDate(k),
        isToday: k === util.today(),
        items: map[k],
      }))
  },

  checkOverdue() {
    return api
      .post('/learning/overdue/check')
      .then((res) => this.setData({ notices: (res && res.notices) || [] }))
      .catch(() => {})
  },

  ackNotice(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ acking: id })
    api
      .post('/learning/overdue/reminders/' + id + '/ack')
      .then(() => {
        this.setData({
          notices: this.data.notices.filter((x) => x.id !== id),
          acking: '',
        })
        return this.loadGoals(true)
      })
      .catch((err) => {
        this.setData({ acking: '' })
        util.toast(err.message || '确认失败')
      })
  },

  /* ---------------- 删除整个学习计划 ---------------- */
  confirmDeleteGoal() {
    const g = this.data.goal
    if (!g || this.data.deletingGoal) return
    const n = (g.tasks || []).length
    wx.showModal({
      title: '删除整个学习计划？',
      content:
        '「' +
        g.name +
        '」' +
        (n ? '和它下面的 ' + n + ' 个学习任务' : '') +
        '会一起删除，删掉之后无法恢复。',
      confirmText: '删除',
      confirmColor: '#c9455a',
      cancelText: '先留着',
      success: (res) => {
        if (res.confirm) this.deleteGoal()
      },
    })
  },

  deleteGoal() {
    const g = this.data.goal
    if (!g || this.data.deletingGoal) return
    const name = g.name
    this.setData({ deletingGoal: true })
    api
      .del('/learning/goals/' + g.id)
      .then(() => {
        this.setData({ deletingGoal: false, selectedId: '' })
        util.toast('「' + name + '」已删除', 'success')
        return this.loadGoals(true)
      })
      .catch((e) => {
        this.setData({ deletingGoal: false })
        util.toast((e && e.message) || '删除失败')
      })
  },

  selectGoal(e) {
    const id = e.currentTarget.dataset.id
    if (id === this.data.selectedId) return
    this.setData({ selectedId: id, goal: null, tab: 'plan' })
    this.loadGoal(id)
  },

  setTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  /* ---------------- 进度 ---------------- */
  onProgressChange(e) {
    this.setData({ progressDraft: e.detail.value, progressDirty: true })
  },

  /* 手动点「同步为 X%」 */
  syncProgressNow() {
    this.syncProgressToTasks(false)
  },

  saveProgress() {
    const g = this.data.goal
    if (!g || this.data.saving) return
    this.setData({ saving: true })
    api
      .patch('/learning/goals/' + g.id, { progress: Number(this.data.progressDraft) })
      .then(() => {
        this.setData({ saving: false, progressDirty: false })
        util.toast('学习进度已更新', 'success')
        return this.loadGoals(true)
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast(e.message || '保存失败')
      })
  },

  /* ---------------- 任务 ---------------- */
  toggleTask(e) {
    const agendaId = e.currentTarget.dataset.agenda
    const done = e.currentTarget.dataset.done
    const planDate = e.currentTarget.dataset.date
    if (!agendaId) {
      util.toast('这条任务还没有关联到今日计划')
      return
    }
    const url = '/agenda/' + agendaId + '/' + (done ? 'reschedule' : 'complete')
    const payload = done ? { plan_date: planDate } : {}
    api
      .post(url, payload)
      .then(() => this.loadGoal(this.data.selectedId))
      // 勾完/取消勾选后，进度跟着任务完成度自动走，不用再手拖滑块
      .then(() => this.syncProgressToTasks(true))
      .catch((err) => util.toast(err.message || '更新完成状态失败'))
  },

  openTask(e) {
    const dayKey = e.currentTarget.dataset.day
    // 弹层会盖住 tabBar，先把它收起来，否则底部的保存按钮会被压在下面
    util.setTabBarHidden(true)
    this.setData({
      sheet: 'task',
      taskForm: {
        id: '',
        title: '',
        details: '',
        plan_date: dayKey && dayKey !== 'none' ? dayKey : util.today(),
        priority: 'normal',
        estimated_minutes: 30,
        section_id: '',
        agenda_id: '',
        start_time: '',
        end_time: '',
        orig_start: '',
        orig_end: '',
      },
    })
  },

  /** 编辑已有任务：点铅笔按钮，回填表单后复用同一个弹层 */
  editTask(e) {
    const id = e.currentTarget.dataset.id
    const days = this.data.days || []
    let hit = null
    days.forEach((d) => {
      ;(d.items || []).forEach((t) => {
        if (t.id === id) hit = t
      })
    })
    if (!hit) return
    util.setTabBarHidden(true)
    const st = hit.start_time || ''
    const et = hit.end_time || ''
    this.setData({
      sheet: 'task',
      taskForm: {
        id: hit.id,
        title: hit.title || '',
        details: hit.details || '',
        plan_date: hit.plan_date || util.today(),
        priority: 'normal',
        estimated_minutes: Number(hit.minutes) || 30,
        section_id: hit.section_id || '',
        agenda_id: hit.agenda_id || '',
        start_time: st,
        end_time: et,
        orig_start: st,
        orig_end: et,
      },
    })
    // 任务列表里没带时间时，单独问一次它对应的日程条目（后端时间存在 agenda 上）
    if (!st && !et && hit.agenda_id) {
      api
        .get('/agenda/' + hit.agenda_id)
        .then((it) => {
          if (!it || this.data.sheet !== 'task' || this.data.taskForm.id !== hit.id) return
          const s2 = it.start_time || ''
          const e2 = it.end_time || ''
          if (!s2 && !e2) return
          this.setData({
            'taskForm.start_time': s2,
            'taskForm.end_time': e2,
            'taskForm.orig_start': s2,
            'taskForm.orig_end': e2,
          })
        })
        .catch(() => {})
    }
  },

  deleteTask(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除这条学习任务？',
      content: '今日计划中的对应条目也会一并移除。',
      confirmText: '删除',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api
          .del('/learning/tasks/' + id)
          .then(() => this.loadGoal(this.data.selectedId))
          .catch((err) => util.toast(err.message || '删除失败'))
      },
    })
  },

  /* ---------------- 表单 ---------------- */
  openSheet(e) {
    const kind = e.currentTarget.dataset.kind
    const d = util.today()
    const patch = { sheet: kind }
    if (kind === 'goal') {
      patch.goalForm = {
        name: '',
        goal: '',
        start_date: d,
        target_date: util.addDays(d, 30),
        estimated_minutes: 30,
      }
    }
    if (kind === 'session') {
      patch.sessionForm = {
        studied_on: d,
        actual_minutes: 45,
        notes: '',
        problems: '',
        next_step: '',
      }
    }
    if (kind === 'resource') {
      patch.resourceForm = { name: '', link: '', notes: '' }
    }
    if (kind === 'ailearn') {
      patch.aiLearnForm = {
        topic: '',
        objective: '',
        current_level: '零基础',
        preferences: '',
        days: 7,
        daily_minutes: 45,
        start_date: util.addDays(util.today(), 1),
      }
      patch.aiDraft = null
      patch.aiDraftDays = []
      patch.aiError = ''
      patch.aiEditingTask = ''
      patch.aiProgress = 0
      patch.aiProgressText = ''
      patch.aiElapsedText = ''
      patch.aiPartial = false
      patch.aiCanResume = false
      patch.aiResumeDays = 0
      this._aiRun = null
      this.stopAiClock()
    }
    util.setTabBarHidden(true)
    this.setData(patch)
  },

  closeSheet() {
    // 关面板就停掉还在排队的分段请求，别让它在后台一直跑
    if (this.data.aiGenerating) {
      if (this._aiRun) this._aiRun.cancel = true
      this.stopAiClock()
      this.setData({ aiGenerating: false, aiProgressText: '', aiProgress: 0 })
    }
    util.setTabBarHidden(false)
    this.setData({ sheet: '' })
  },

  onGoalInput(e) {
    const patch = {}
    patch['goalForm.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  onTaskInput(e) {
    const patch = {}
    patch['taskForm.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  onSessionInput(e) {
    const patch = {}
    patch['sessionForm.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  onResourceInput(e) {
    const patch = {}
    patch['resourceForm.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  onAiLearnInput(e) {
    const patch = {}
    patch['aiLearnForm.' + e.currentTarget.dataset.key] = e.detail.value
    if (this.data.aiError) patch.aiError = ''
    this.setData(patch)
  },

  /* ---------------- AI 生成学习计划 ---------------- */
  groupAiTasks(tasks) {
    const groups = []
    const index = {}
    ;(tasks || []).forEach((t, pi) => {
      const key = t.plan_date || 'none'
      if (!index[key]) {
        index[key] = { key: key, date: key === 'none' ? '未安排' : util.shortDate(key), items: [] }
        groups.push(index[key])
      }
      index[key].items.push({ pi: pi, title: t.title, minutes: t.minutes, notes: t.notes })
    })
    groups.sort((a, b) => {
      if (a.key === 'none') return 1
      if (b.key === 'none') return -1
      return a.key < b.key ? -1 : 1
    })
    return groups
  },

  /** 把主题钉死在提示里：1.5B 小模型很容易脱离主题自由发挥 */
  aiPreferences() {
    const f = this.data.aiLearnForm
    const topic = (f.topic || '').trim()
    if (!topic) return ''
    const anchor =
      '任务必须严格围绕「' +
      topic +
      '」展开，标题尽量写出这门课/这件事里的具体内容，不要出现其它学科的内容，也不要用「阅读指定原文」「整理概念」这类看不出主题的空泛说法。'
    const extra = (f.preferences || '').trim()
    return (extra ? extra + '；' : '') + anchor
  },

  generateLearning() {
    if (this.data.aiGenerating) return
    const f = this.data.aiLearnForm
    if (!f.topic.trim()) {
      this.setData({ aiError: '请填写想学的主题' })
      return
    }
    if (!f.objective.trim()) {
      this.setData({ aiError: '请填写学习目标（想达到什么程度）' })
      return
    }
    const days = Math.min(30, Math.max(1, Math.round(Number(f.days) || 7)))
    const dailyMinutes = Math.min(480, Math.max(5, Math.round(Number(f.daily_minutes) || 45)))
    this._aiRun = {
      days: days,
      startDate: f.start_date || util.today(),
      topic: f.topic.trim(),
      objective: f.objective.trim(),
      level: (f.current_level || '零基础').trim() || '零基础',
      preferences: this.aiPreferences().slice(0, 2000),
      dailyMinutes: dailyMinutes,
      plan: null,
      chunks: [],
      nextDay: 1,
      cancel: false,
    }
    this.stopAiClock()
    this.setData({
      aiGenerating: true,
      aiError: '',
      aiDraft: null,
      aiDraftDays: [],
      aiEditingTask: '',
      aiProgress: 0,
      aiProgressText: '准备生成…',
      aiPartial: false,
      aiCanResume: false,
      aiResumeDays: 0,
    })
    this.startAiClock()
    this.runAiChunk(1)
  },

  /* ---------------- AI 分段生成（每段 ≤ 3 天，避开网关 100 秒超时） ---------------- */
  startAiClock() {
    this.stopAiClock()
    const t0 = Date.now()
    this.setData({ aiElapsedText: '0 秒' })
    this._aiClock = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000)
      const text = s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'
      this.setData({ aiElapsedText: text })
    }, 1000)
  },

  stopAiClock() {
    if (this._aiClock) clearInterval(this._aiClock)
    this._aiClock = null
    if (this._aiRetryTimer) clearTimeout(this._aiRetryTimer)
    this._aiRetryTimer = null
  },

  /** 把网关超时之类的英文原始报错翻成人话 */
  aiErrorText(e) {
    const msg = String((e && e.message) || '')
    const code = e && e.statusCode
    if (code === 429 || /正在处理|busy|太频繁/.test(msg)) {
      return '服务端上一段还没跑完（模型排队中）。'
    }
    if (
      code === 524 ||
      code === 522 ||
      code === 504 ||
      code === 502 ||
      /Proxy Read|超时|timed? ?out|time out/i.test(msg)
    ) {
      return '这一段超过一分半没返回，网关先把连接断了。'
    }
    if (/无法连接服务|连不上/.test(msg)) return '连不上服务，检查一下网络或服务地址。'
    return msg || '生成失败，请重试。'
  },

  runAiChunk(fromDay) {
    const run = this._aiRun
    if (!run) return
    if (run.cancel) {
      this.stopAiClock()
      this.setData({ aiGenerating: false, aiProgressText: '' })
      return
    }
    if (fromDay > run.days) {
      this.finishAiPlan()
      return
    }
    run.nextDay = fromDay
    const size = Math.min(AI_CHUNK_DAYS, run.days - fromDay + 1)
    const toDay = fromDay + size - 1
    const start = util.addDays(run.startDate, fromDay - 1)
    const segTotal = Math.ceil(run.days / AI_CHUNK_DAYS)
    this.setData({
      aiProgress: Math.round(((fromDay - 1) / run.days) * 100),
      aiProgressText:
        '第 ' +
        (run.chunks.length + 1) +
        '/' +
        segTotal +
        ' 段 · 正在生成第 ' +
        fromDay +
        '~' +
        toDay +
        ' 天',
    })

    api
      .post(
        '/ai/learning/generate',
        {
          topic: run.topic,
          objective: run.objective,
          current_level: run.level,
          preferences: run.preferences,
          start_date: start,
          days: size,
          daily_minutes: run.dailyMinutes,
        },
        { timeout: AI_CHUNK_TIMEOUT },
      )
      .then((res) => {
        if (run.cancel) {
          this.stopAiClock()
          this.setData({ aiGenerating: false, aiProgressText: '' })
          return
        }
        if (!res || !res.plan || !res.id) throw new Error('生成结果为空，请重试')
        run.retry429 = 0
        run.plan = run.plan ? this.mergeAiPlan(run.plan, res.plan) : res.plan
        run.chunks.push({
          id: res.id,
          start: res.plan.start_date || start,
          target: res.plan.target_date || util.addDays(start, size - 1),
          count: (res.plan.tasks || []).length,
        })
        this.runAiChunk(toDay + 1)
      })
      .catch((e) => this.onAiChunkFail(e, fromDay))
  },

  /** 各段计划拼起来：任务顺序追加，结束日期用最后一段的 */
  mergeAiPlan(a, b) {
    return Object.assign({}, a, {
      tasks: (a.tasks || []).concat(b.tasks || []),
      target_date: b.target_date || a.target_date,
    })
  },

  onAiChunkFail(e, fromDay) {
    const run = this._aiRun
    if (!run || run.cancel) {
      this.stopAiClock()
      this.setData({ aiGenerating: false, aiProgressText: '' })
      return
    }
    // 模型排队（429）：服务端上一次请求还没收尾，等几秒自动重试，别让用户手点
    if (e && e.statusCode === 429) {
      run.retry429 = (run.retry429 || 0) + 1
      if (run.retry429 <= 3) {
        this.setData({
          aiProgressText: '模型正在排队，' + 6 + ' 秒后自动重试（第 ' + run.retry429 + ' 次）',
        })
        if (this._aiRetryTimer) clearTimeout(this._aiRetryTimer)
        this._aiRetryTimer = setTimeout(() => {
          this._aiRetryTimer = null
          this.runAiChunk(fromDay)
        }, 6000)
        return
      }
    }
    this.stopAiClock()
    const done = fromDay - 1
    const total = run.days
    const reason = this.aiErrorText(e)
    if (done > 0 && run.plan && (run.plan.tasks || []).length) {
      // 已经有部分结果：先给预览，能继续生成，也能直接导入
      const plan = this.finalizeAiPlan(run)
      this.setData({
        aiGenerating: false,
        aiProgressText: '',
        aiDraft: { id: run.chunks.length ? run.chunks[0].id : '', plan: plan },
        aiDraftDays: this.groupAiTasks(plan.tasks),
        aiPartial: true,
        aiCanResume: true,
        aiResumeDays: total - done,
        aiError:
          '已生成前 ' +
          done +
          ' 天，第 ' +
          fromDay +
          ' 天这段失败了：' +
          reason +
          ' 可以点「继续生成剩余 ' +
          (total - done) +
          ' 天」，也可以先把已经生成的部分导入。',
      })
      return
    }
    this.setData({
      aiGenerating: false,
      aiProgressText: '',
      aiCanResume: false,
      aiResumeDays: 0,
      aiError:
        reason +
        (/超时|断了|没返回/.test(reason)
          ? '计划天数越多越容易超时，可以先把天数调小一点，或者稍后再试。'
          : ''),
    })
  },

  finalizeAiPlan(run) {
    const plan = run.plan || {}
    const topic = run.topic
    let name = String(plan.name || '').trim()
    // 1.5B 模型偶发把名称写成别的学科（主题高数、名称却是「毛概学习计划」），
    // 名称里不含主题词时用「主题 + 学习计划」兜底，预览里仍然可以手改
    if (!name || (topic && name.indexOf(topic) === -1)) name = topic + '学习计划'

    const rawSections = (plan.sections || []).filter((s) => String(s || '').trim())
    const sections = rawSections.length ? rawSections : [name]
    const tasks = (plan.tasks || []).map((t) => {
      const si = Number(t.section_index)
      return Object.assign({}, t, {
        section_index: si >= 0 && si < sections.length ? si : 0,
      })
    })
    return Object.assign({}, plan, { name: name, sections: sections, tasks: tasks })
  },

  finishAiPlan() {
    const run = this._aiRun
    this.stopAiClock()
    if (!run) return
    const plan = this.finalizeAiPlan(run)
    this.setData({
      aiGenerating: false,
      aiProgress: 100,
      aiProgressText: '',
      aiPartial: false,
      aiCanResume: false,
      aiResumeDays: 0,
      aiDraft: { id: run.chunks.length ? run.chunks[0].id : '', plan: plan },
      aiDraftDays: this.groupAiTasks(plan.tasks),
    })
  },

  /** 部分失败后继续跑剩余天数 */
  resumeAiGeneration() {
    const run = this._aiRun
    if (!run || this.data.aiGenerating) return
    run.cancel = false
    this.setData({
      aiGenerating: true,
      aiError: '',
      aiDraft: null,
      aiDraftDays: [],
      aiEditingTask: '',
      aiPartial: false,
      aiCanResume: false,
    })
    this.startAiClock()
    this.runAiChunk(run.nextDay || 1)
  },

  /* 预览里直接改名，导入的就是改过的内容 */
  onAiPlanInput(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch['aiDraft.plan.' + key] = e.detail.value
    if (this.data.aiError) patch.aiError = ''
    this.setData(patch)
  },

  editAiTask(e) {
    const d = e.currentTarget.dataset
    this.setData({ aiEditingTask: d.gi + '-' + d.ti })
  },

  onAiTaskInput(e) {
    const d = e.currentTarget.dataset
    const value = e.detail.value
    const patch = {}
    patch['aiDraft.plan.tasks[' + d.pi + '].title'] = value
    patch['aiDraftDays[' + d.gi + '].items[' + d.ti + '].title'] = value
    this.setData(patch)
  },

  doneAiTaskEdit() {
    this.setData({ aiEditingTask: '' })
  },

  regenerateLearning() {
    this._aiRun = null
    this.stopAiClock()
    this.setData({
      aiDraft: null,
      aiDraftDays: [],
      aiError: '',
      aiEditingTask: '',
      aiProgress: 0,
      aiProgressText: '',
      aiPartial: false,
      aiCanResume: false,
      aiResumeDays: 0,
    })
    this.generateLearning()
  },

  importLearning() {
    if (this.data.aiImporting || !this.data.aiDraft) return
    const plan = this.data.aiDraft.plan || {}
    const name = String(plan.name || '').trim()
    if (!name) {
      this.setData({ aiError: '目标名称不能为空，填一个再导入' })
      return
    }
    const tasks = (plan.tasks || [])
      .map((t) =>
        Object.assign({}, t, {
          title: String(t.title || '').trim(),
          notes: t.notes || '',
        }),
      )
      .filter((t) => t.title)
    if (!tasks.length) {
      this.setData({ aiError: '所有任务标题都是空的，至少留一条再导入' })
      return
    }
    const sections = (plan.sections || []).filter((s) => String(s || '').trim())
    const dailyMinutes = Number(plan.daily_minutes) || 45
    const run = this._aiRun
    const chunks = (run && run.chunks) || []

    this.setData({ aiImporting: true, aiError: '' })

    // 单段（就是原来的一次性生成）：整份计划丢给草稿导入接口
    if (chunks.length <= 1) {
      const payload = Object.assign({}, plan, {
        name: name,
        goal: String(plan.goal || '').trim() || name,
        sections: sections.length ? sections : [name],
        tasks: tasks,
      })
      api
        .post('/ai/learning/drafts/' + this.data.aiDraft.id + '/import', payload)
        .then(() => this.afterAiImport(0))
        .catch((e) => {
          this.setData({ aiImporting: false, aiError: (e && e.message) || '导入失败' })
        })
      return
    }

    // 多段：每份草稿只认自己那几天的日期范围（改范围会报「请保留原草稿的日期范围」），
    // 所以先用第一段草稿原样建目标，再把后面几天的任务逐条追加进去，最后把结束日期拉长。
    const first = chunks[0]
    const headCount = Math.max(1, Math.min(Number(first.count) || 1, tasks.length))
    const head = tasks.slice(0, headCount)
    const rest = tasks.slice(headCount)
    const headPayload = {
      name: name,
      goal: String(plan.goal || '').trim() || name,
      start_date: first.start,
      target_date: first.target,
      daily_minutes: dailyMinutes,
      sections: sections.length ? sections : [name],
      tasks: head.map((t) => ({
        plan_date: t.plan_date,
        section_index: 0,
        title: t.title,
        minutes: Number(t.minutes) || dailyMinutes,
        notes: t.notes || '',
      })),
    }

    api
      .post('/ai/learning/drafts/' + first.id + '/import', headPayload)
      .then((goal) => {
        const gid = goal && goal.id
        if (!gid) throw new Error('没能创建学习目标，请重试')
        return this.appendAiTasks(gid, rest, dailyMinutes).then((missed) => {
          const last = tasks[tasks.length - 1]
          const targetDate = (last && last.plan_date) || plan.target_date
          const finish = (n) => this.afterAiImport(n)
          return api.patch('/learning/goals/' + gid, { target_date: targetDate }).then(
            () => finish(missed),
            () => finish(missed),
          )
        })
      })
      .catch((e) => {
        this.setData({ aiImporting: false, aiError: (e && e.message) || '导入失败' })
      })
  },

  /** 逐条追加任务，返回没加上去的条数（不中断整体流程） */
  appendAiTasks(goalId, tasks, dailyMinutes) {
    let missed = 0
    return tasks
      .reduce(
        (chain, t) =>
          chain.then(() =>
            api
              .post('/learning/goals/' + goalId + '/tasks', {
                title: t.title,
                details: t.notes || '',
                plan_date: t.plan_date || null,
                priority: 'normal',
                estimated_minutes: Number(t.minutes) || dailyMinutes,
              })
              .catch(() => {
                missed += 1
              }),
          ),
        Promise.resolve(),
      )
      .then(() => missed)
  },

  afterAiImport(missed) {
    util.toast(
      missed ? '已导入，有 ' + missed + ' 条任务没加上' : '已导入为学习目标',
      missed ? 'none' : 'success',
    )
    util.setTabBarHidden(false)
    this._aiRun = null
    this.stopAiClock()
    this.setData({
      aiImporting: false,
      sheet: '',
      aiDraft: null,
      aiDraftDays: [],
      aiEditingTask: '',
      aiPartial: false,
      aiCanResume: false,
      aiResumeDays: 0,
      aiProgressText: '',
      aiProgress: 0,
    })
    return this.loadAll(true)
  },

  pickField(e) {
    const form = e.currentTarget.dataset.form
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch[form + '.' + key] = e.detail.value
    this.setData(patch)
  },

  setTaskPriority(e) {
    this.setData({ 'taskForm.priority': e.currentTarget.dataset.value })
  },

  /** 清掉开始/结束时间（不填就按「数据与设置」里的默认工作时间提醒） */
  clearTaskTime(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch['taskForm.' + key] = ''
    this.setData(patch)
  },

  submitSheet() {
    if (this.data.saving) return
    const kind = this.data.sheet
    const g = this.data.goal
    this.setData({ saving: true })

    let task = null
    if (kind === 'goal') {
      const f = this.data.goalForm
      if (!f.name.trim()) {
        this.setData({ saving: false })
        util.toast('请填写目标名称')
        return
      }
      task = api.post('/learning/goals', {
        name: f.name.trim(),
        goal: f.goal || '',
        start_date: f.start_date || null,
        target_date: f.target_date || null,
        estimated_minutes: Number(f.estimated_minutes) || 0,
      })
    } else if (kind === 'task') {
      const f = this.data.taskForm
      if (!f.title.trim() || !g) {
        this.setData({ saving: false })
        util.toast('请填写任务标题')
        return
      }
      const payload = {
        title: f.title.trim(),
        details: f.details || '',
        plan_date: f.plan_date || null,
        estimated_minutes: Number(f.estimated_minutes) || null,
      }
      const st = (f.start_time || '').trim()
      const et = (f.end_time || '').trim()
      if (st && et && st >= et) {
        this.setData({ saving: false })
        util.toast('结束时间要晚于开始时间')
        return
      }
      // 时间存在对应的「今日计划」条目上，等任务建好/改好后单独同步
      this._pendingTimes = {
        st: st,
        et: et,
        changed: st !== (f.orig_start || '') || et !== (f.orig_end || ''),
      }
      // 有 id = 编辑已有任务（后端 PATCH 不支持优先级）；没有 = 新增
      task = f.id
        ? api.patch('/learning/tasks/' + f.id, payload)
        : api.post(
            '/learning/goals/' + g.id + '/tasks',
            Object.assign({ priority: f.priority }, payload),
          )
    } else if (kind === 'session') {
      const f = this.data.sessionForm
      if (!g) return
      task = api.post('/learning/goals/' + g.id + '/sessions', {
        studied_on: f.studied_on,
        actual_minutes: Number(f.actual_minutes) || 0,
        notes: f.notes || '',
        problems: f.problems || '',
        next_step: f.next_step || '',
      })
    } else if (kind === 'resource') {
      const f = this.data.resourceForm
      if (!f.name.trim() || !g) {
        this.setData({ saving: false })
        util.toast('请填写资料名称')
        return
      }
      task = api.post('/learning/goals/' + g.id + '/resources', {
        name: f.name.trim(),
        link: f.link || '',
        notes: f.notes || '',
      })
    }

    if (!task) {
      this.setData({ saving: false })
      return
    }

    task
      .then((res) => {
        this.setData({ saving: false, sheet: '' })
        util.setTabBarHidden(false)
        util.toast('已保存', 'success')
        if (kind === 'task') {
          const pend = this._pendingTimes || {}
          this._pendingTimes = null
          const agendaId = (res && res.agenda_id) || this.data.taskForm.agenda_id
          if (agendaId && pend.changed) {
            return api
              .patch('/agenda/' + agendaId, {
                start_time: pend.st || null,
                end_time: pend.et || null,
              })
              .then(() => this.loadGoal(this.data.selectedId))
              .catch((e) => {
                util.toast(e.message || '时间段没保存成功')
                return this.loadGoal(this.data.selectedId)
              })
          }
        }
        if (kind === 'goal' && res && res.id) {
          this.setData({ selectedId: res.id })
          return this.loadGoals(true)
        }
        return this.loadGoal(this.data.selectedId)
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast(e.message || '保存失败')
      })
  },

  /* ---------------- 番茄钟 ---------------- */
  pomoKey() {
    return 'ph_pomo_' + util.today()
  },

  fmtPomo(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0))
    const m = Math.floor(s / 60)
    const r = s % 60
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r
  },

  pomoPct(left) {
    const total = (Number(this.data.pomoMin) || 25) * 60
    if (!total) return 0
    return Math.min(100, Math.max(0, Math.round((1 - left / total) * 100)))
  },

  openPomo() {
    util.setTabBarHidden(true)
    const tasks = []
    const g = this.data.goal
    if (g && g.tasks) {
      g.tasks.forEach((t) => {
        if (t.status !== 'completed' && t.plan_date === util.today()) {
          tasks.push({ id: t.id, title: t.title })
        }
      })
    }
    const saved = Number(wx.getStorageSync('ph_pomo_min') || 0)
    const patch = {
      pomoOpen: true,
      pomoToday: Number(wx.getStorageSync(this.pomoKey()) || 0),
      todayTasks: tasks,
      pomoTaskPick:
        tasks.length && this.data.pomoTaskPick >= tasks.length ? -1 : this.data.pomoTaskPick,
    }
    // 上次自定义的时长还在、且计时器没被动过 → 直接沿用
    const untouched = this.data.pomoLeft === (Number(this.data.pomoMin) || 25) * 60
    if (saved >= 1 && saved <= 180 && !this.data.pomoRunning && untouched) {
      const min = Math.round(saved)
      patch.pomoMin = min
      patch.pomoCustom = String(min)
      patch.pomoLeft = min * 60
      patch.pomoLabel = this.fmtPomo(min * 60)
      patch.pomoPct = 0
    }
    this.setData(patch)
  },

  closePomo() {
    util.setTabBarHidden(false)
    this.setData({ pomoOpen: false })
  },

  pickPomoMin(e) {
    if (this.data.pomoRunning) {
      util.toast('先暂停或重置，再换时长')
      return
    }
    this.applyPomoMin(Number(e.currentTarget.dataset.min) || 25)
  },

  /** 换时长并记住，下次打开还是这个数 */
  applyPomoMin(m) {
    const min = Math.min(180, Math.max(1, Math.round(Number(m) || 25)))
    wx.setStorageSync('ph_pomo_min', min)
    this.setData({
      pomoMin: min,
      pomoCustom: String(min),
      pomoLeft: min * 60,
      pomoLabel: this.fmtPomo(min * 60),
      pomoPct: 0,
    })
  },

  onPomoCustomInput(e) {
    this.setData({ pomoCustom: e.detail.value })
  },

  applyPomoCustom() {
    if (this.data.pomoRunning) {
      util.toast('先暂停或重置，再换时长')
      return
    }
    const raw = String(this.data.pomoCustom || '').trim()
    const m = Math.round(Number(raw))
    if (!raw || !isFinite(m) || m < 1 || m > 180) {
      util.toast('请输入 1~180 之间的分钟数')
      return
    }
    this.applyPomoMin(m)
    util.toast('专注时长已设为 ' + m + ' 分钟', 'success')
  },

  /** 在自定义时长上微调，拖动式加减 */
  stepPomoMin(e) {
    if (this.data.pomoRunning) {
      util.toast('先暂停或重置，再换时长')
      return
    }
    const step = Number(e.currentTarget.dataset.step) || 5
    this.applyPomoMin((Number(this.data.pomoMin) || 25) + step)
  },

  pickPomoTask(e) {
    this.setData({ pomoTaskPick: Number(e.currentTarget.dataset.idx) })
  },

  togglePomo() {
    if (this.data.pomoRunning) this.pausePomo()
    else this.startPomo()
  },

  startPomo() {
    const left = this.data.pomoLeft > 0 ? this.data.pomoLeft : this.data.pomoMin * 60
    this._pomoEnd = Date.now() + left * 1000
    this.setData({
      pomoRunning: true,
      pomoLeft: left,
      pomoLabel: this.fmtPomo(left),
      pomoPct: this.pomoPct(left),
    })
    this.runPomoTimer()
  },

  runPomoTimer() {
    if (this._pomoTimer) clearInterval(this._pomoTimer)
    this._pomoTimer = setInterval(() => {
      const left = Math.round((this._pomoEnd - Date.now()) / 1000)
      if (left <= 0) {
        this.setData({ pomoLeft: 0, pomoLabel: '00:00', pomoPct: 100 })
        this.finishPomo()
        return
      }
      this.setData({ pomoLeft: left, pomoLabel: this.fmtPomo(left), pomoPct: this.pomoPct(left) })
    }, 500)
  },

  pausePomo() {
    if (this._pomoTimer) clearInterval(this._pomoTimer)
    this._pomoTimer = null
    const left = Math.max(0, Math.round((this._pomoEnd - Date.now()) / 1000))
    this.setData({
      pomoRunning: false,
      pomoLeft: left,
      pomoLabel: this.fmtPomo(left),
      pomoPct: this.pomoPct(left),
    })
  },

  resetPomo() {
    if (this._pomoTimer) clearInterval(this._pomoTimer)
    this._pomoTimer = null
    this._pomoEnd = 0
    const total = this.data.pomoMin * 60
    this.setData({
      pomoRunning: false,
      pomoLeft: total,
      pomoLabel: this.fmtPomo(total),
      pomoPct: 0,
    })
  },

  finishPomo() {
    if (this._pomoTimer) clearInterval(this._pomoTimer)
    this._pomoTimer = null
    this._pomoEnd = 0

    const minutes = Number(this.data.pomoMin) || 25
    const n = Number(wx.getStorageSync(this.pomoKey()) || 0) + 1
    wx.setStorageSync(this.pomoKey(), n)

    const idx = this.data.pomoTaskPick
    const task = idx >= 0 ? this.data.todayTasks[idx] : null
    const total = minutes * 60

    this.setData({
      pomoRunning: false,
      pomoLeft: total,
      pomoLabel: this.fmtPomo(total),
      pomoPct: 0,
      pomoToday: n,
    })
    if (wx.vibrateLong) wx.vibrateLong({})

    const g = this.data.goal
    if (!g) {
      util.toast('专注 ' + minutes + ' 分钟完成', 'success')
      return
    }
    wx.showModal({
      title: '完成 1 个番茄',
      content: '专注 ' + minutes + ' 分钟，要记到「' + g.name + '」的学习记录吗？',
      confirmText: '记录',
      cancelText: '不用',
      success: (r) => {
        if (!r.confirm) return
        api
          .post('/learning/goals/' + g.id + '/sessions', {
            studied_on: util.today(),
            actual_minutes: minutes,
            notes: '番茄钟专注 ' + minutes + ' 分钟' + (task ? '：' + task.title : ''),
            problems: '',
            next_step: '',
          })
          .then(() => {
            util.toast('已记入学习记录', 'success')
            return this.loadGoal(this.data.selectedId)
          })
          .catch((err) => util.toast(err.message || '记录失败'))
      },
    })
  },

  /** 离线横幅点击：跳到「数据与设置」改服务地址（换隧道域名时用） */
  goServer() {
    wx.switchTab({ url: '/pages/settings/index' })
  },

  retry() {
    this.loadAll()
  },
})
