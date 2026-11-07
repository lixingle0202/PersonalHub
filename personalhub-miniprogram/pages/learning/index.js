const api = require('../../utils/api')
const util = require('../../utils/util')
const theme = require('../../utils/theme')

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
      tab: 'plan',
      days: [],
      notices: [],
      acking: '',
      saving: false,
      deletingGoal: false,

      sheet: '',
      goalForm: { name: '', goal: '', start_date: '', target_date: '', estimated_minutes: 30 },
      taskForm: { title: '', details: '', plan_date: '', priority: 'normal', estimated_minutes: 30, section_id: '' },
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
        start_date: ''
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
      color: '#5b6cff'
    },
    theme.data()
  ),

  onLoad() {
    const d = util.today()
    this.setData({
      'goalForm.start_date': d,
      'goalForm.target_date': util.addDays(d, 30),
      'sessionForm.studied_on': d,
      'aiLearnForm.start_date': util.addDays(d, 1)
    })
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
        const goals = (list || []).filter((g) => !g.deleted_at)
        // 当前选中的目标可能刚被删掉，回落到第一个
        const keep = goals.some((g) => g.id === this.data.selectedId)
        const selected = keep ? this.data.selectedId : (goals[0] && goals[0].id) || ''
        this.setData({ goals: goals, selectedId: selected, loading: false, error: '' })
        if (selected) return this.loadGoal(selected)
        this.setData({
          goal: null,
          days: [],
          taskCount: 0,
          doneCount: 0,
          autoProgress: 0,
          progressDraft: 0,
          progressDirty: false
        })
      })
      .catch((e) => this.setData({ loading: false, error: (e && e.message) || '读取失败' }))
  },

  loadGoal(id) {
    return api
      .get('/learning/goals/' + id)
      .then((g) => {
        const tasks = (g.tasks || []).filter((t) => !t.archived_at)
        const stats = this.progressStats(tasks)
        this.setData({
          goal: Object.assign({}, g, { tasks: tasks }),
          progressDraft: g.progress || 0,
          progressDirty: false,
          autoProgress: stats.percent,
          doneCount: stats.done,
          taskCount: stats.total,
          days: this.groupTasks(tasks)
        })
      })
      .catch((e) => util.toast(e.message || '读取学习目标失败'))
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
        done: t.status === 'completed'
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
        items: map[k]
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
          acking: ''
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
      }
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
    this.setData({
      sheet: 'task',
      taskForm: {
        title: '',
        details: '',
        plan_date: dayKey && dayKey !== 'none' ? dayKey : util.today(),
        priority: 'normal',
        estimated_minutes: 30,
        section_id: ''
      }
    })
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
      }
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
        estimated_minutes: 30
      }
    }
    if (kind === 'session') {
      patch.sessionForm = {
        studied_on: d,
        actual_minutes: 45,
        notes: '',
        problems: '',
        next_step: ''
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
        start_date: util.addDays(util.today(), 1)
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
      cancel: false
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
      aiResumeDays: 0
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
        '第 ' + (run.chunks.length + 1) + '/' + segTotal + ' 段 · 正在生成第 ' + fromDay + '~' + toDay + ' 天'
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
          daily_minutes: run.dailyMinutes
        },
        { timeout: AI_CHUNK_TIMEOUT }
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
          count: (res.plan.tasks || []).length
        })
        this.runAiChunk(toDay + 1)
      })
      .catch((e) => this.onAiChunkFail(e, fromDay))
  },

  /** 各段计划拼起来：任务顺序追加，结束日期用最后一段的 */
  mergeAiPlan(a, b) {
    return Object.assign({}, a, {
      tasks: (a.tasks || []).concat(b.tasks || []),
      target_date: b.target_date || a.target_date
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
        this.setData({ aiProgressText: '模型正在排队，' + 6 + ' 秒后自动重试（第 ' + run.retry429 + ' 次）' })
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
          ' 天」，也可以先把已经生成的部分导入。'
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
          : '')
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
        section_index: si >= 0 && si < sections.length ? si : 0
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
      aiDraftDays: this.groupAiTasks(plan.tasks)
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
      aiCanResume: false
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
      aiResumeDays: 0
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
          notes: t.notes || ''
        })
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
        tasks: tasks
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
        notes: t.notes || ''
      }))
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
          return api
            .patch('/learning/goals/' + gid, { target_date: targetDate })
            .then(() => finish(missed), () => finish(missed))
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
                estimated_minutes: Number(t.minutes) || dailyMinutes
              })
              .catch(() => {
                missed += 1
              })
          ),
        Promise.resolve()
      )
      .then(() => missed)
  },

  afterAiImport(missed) {
    util.toast(missed ? '已导入，有 ' + missed + ' 条任务没加上' : '已导入为学习目标', missed ? 'none' : 'success')
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
      aiProgress: 0
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
        estimated_minutes: Number(f.estimated_minutes) || 0
      })
    } else if (kind === 'task') {
      const f = this.data.taskForm
      if (!f.title.trim() || !g) {
        this.setData({ saving: false })
        util.toast('请填写任务标题')
        return
      }
      task = api.post('/learning/goals/' + g.id + '/tasks', {
        title: f.title.trim(),
        details: f.details || '',
        plan_date: f.plan_date || null,
        priority: f.priority,
        estimated_minutes: Number(f.estimated_minutes) || null
      })
    } else if (kind === 'session') {
      const f = this.data.sessionForm
      if (!g) return
      task = api.post('/learning/goals/' + g.id + '/sessions', {
        studied_on: f.studied_on,
        actual_minutes: Number(f.actual_minutes) || 0,
        notes: f.notes || '',
        problems: f.problems || '',
        next_step: f.next_step || ''
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
        notes: f.notes || ''
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
      pomoTaskPick: tasks.length && this.data.pomoTaskPick >= tasks.length ? -1 : this.data.pomoTaskPick
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
      pomoPct: 0
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
      pomoPct: this.pomoPct(left)
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
    this.setData({ pomoRunning: false, pomoLeft: left, pomoLabel: this.fmtPomo(left), pomoPct: this.pomoPct(left) })
  },

  resetPomo() {
    if (this._pomoTimer) clearInterval(this._pomoTimer)
    this._pomoTimer = null
    this._pomoEnd = 0
    const total = this.data.pomoMin * 60
    this.setData({ pomoRunning: false, pomoLeft: total, pomoLabel: this.fmtPomo(total), pomoPct: 0 })
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
      pomoToday: n
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
            next_step: ''
          })
          .then(() => {
            util.toast('已记入学习记录', 'success')
            return this.loadGoal(this.data.selectedId)
          })
          .catch((err) => util.toast(err.message || '记录失败'))
      }
    })
  },

  retry() {
    this.loadAll()
  }
})
