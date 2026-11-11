const api = require('../../utils/api')
const util = require('../../utils/util')
const theme = require('../../utils/theme')

const MEAL_TYPES = util.MEAL_TYPES
const MEAL_LABEL = {}
MEAL_TYPES.forEach((m) => (MEAL_LABEL[m.value] = m.label))

// 新账号还没有常用菜品时，点开输入框也给几个常见选项，避免一片空白
const POPULAR_FOODS = ['米饭', '馒头', '鸡蛋', '牛奶', '白粥', '鸡胸肉', '青菜', '苹果']

Page({
  data: Object.assign(
    {
      loading: true,
      error: '',
      tab: 'calendar',

      year: 0,
      month: 0,
      title: '',
      cells: [],
      weekHead: ['一', '二', '三', '四', '五', '六', '日'],

      selectedDate: '',
      dayMeals: [],
      dayKcal: 0,
      daySheet: false,

      dishes: [],
      mealTypes: MEAL_TYPES,
      mealSheet: false,
      mealAppend: false,
      mealRows: [],
      mealEstimating: false,
      mealEstimate: { kcal: null, items: [], note: '' },
      estHasInput: false,
      autoFocusIdx: -1,
      sugScroll: '',
      mealForm: {
        id: '',
        meal_date: '',
        meal_type: 'breakfast',
        dish_id: '',
        custom_name: '',
        servings: 1,
        actual_food: '',
        kcalText: ''
      },

      health: { water_ml: 0, weight_kg: '', feeling: '' },
      profile: { height_cm: '', weight_kg: '' },

      dishSheet: false,
      dishEditing: false,
      dishScrolled: false,
      dishForm: { id: '', name: '', instructions: '', estimated_kcal: '', recipe_servings: 1, ingredients_text: '' },

      shoppingLists: [],
      shoppingSheet: false,
      shoppingForm: { name: '', start_date: '', end_date: '' },
      itemDraft: '',
      itemEditId: '',
      itemEditForm: { name: '', quantity: '' },
      itemSaving: false,

      // AI 生成菜单
      aiDietSheet: false,
      aiDietForm: { theme: '', preferences: '', days: 1 },
      aiDietGenerating: false,
      aiDietPlan: null,
      aiDietDays: [],
      aiDietImporting: false,
      aiDietError: '',

      saving: false,
      color: '#5b6cff'
    },
    theme.data()
  ),

  onLoad() {
    const d = new Date()
    const t = util.today()
    this.setData({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      selectedDate: t,
      'mealForm.meal_date': t,
      'shoppingForm.start_date': t,
      'shoppingForm.end_date': util.addDays(t, 7)
    })
    this._offline = util.offlineTracker(this)
  },

  onShow() {
    this.setData(Object.assign({ color: theme.current().color }, theme.data()))
    theme.applyNav(theme.current())
    const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tb) tb.init(3, theme.current())
    if (!api.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.loadAll()
  },

  onPullDownRefresh() {
    this.loadAll(true).then(() => wx.stopPullDownRefresh())
  },

  noop() {},

  loadAll(silent) {
    if (!silent) this.setData({ loading: !this.data.cells.length })
    return Promise.all([
      this.loadDishes(),
      this.loadCalendar(silent),
      this.loadHealth(this.data.selectedDate),
      this.loadProfile(),
      this.loadShopping()
    ]).then(() => this.setData({ loading: false, error: '' }))
  },

  /* ---------------- 日历 ---------------- */
  loadCalendar() {
    const grid = util.monthGrid(this.data.year, this.data.month, 1)
    const start = grid.cells[0].date
    const end = grid.cells[grid.cells.length - 1].date
    const cacheKey = 'diet_meals_' + start + '_' + end
    return api
      .get('/diet/meals', { start_date: start, end_date: end })
      .then((list) => {
        this._meals = list || []
        util.cacheSet(cacheKey, this._meals)
        if (this._offline) this._offline.clear('meals')
        this.setData({ title: grid.title })
        this.renderCalendar(grid.cells)
      })
      .catch((e) => {
        const cached = util.cacheGetStale(cacheKey)
        if (cached) {
          this._meals = cached
          if (this._offline) this._offline.mark('meals', util.cacheStamp(cacheKey))
        } else {
          this.setData({ error: (e && e.message) || '读取失败' })
        }
        this.renderCalendar(grid.cells)
      })
  },

  renderCalendar(cells) {
    const map = {}
    ;(this._meals || []).forEach((m) => {
      if (!map[m.meal_date]) map[m.meal_date] = []
      map[m.meal_date].push(m)
    })
    const out = cells.map((c) => {
      const meals = map[c.date] || []
      let kcal = 0
      meals.forEach((m) => {
        if (m.display_kcal) kcal += Number(m.display_kcal)
      })
      const dots = []
      MEAL_TYPES.forEach((t) => {
        if (meals.some((m) => m.meal_type === t.value)) dots.push(t.value)
      })
      return Object.assign({}, c, {
        meals: meals,
        kcal: kcal,
        dots: dots,
        selected: c.date === this.data.selectedDate
      })
    })
    this.setData({ cells: out })
  },

  selectDay(e) {
    const date = e.currentTarget.dataset.date
    const meals = (this._meals || []).filter((m) => m.meal_date === date)
    let kcal = 0
    meals.forEach((m) => {
      if (m.display_kcal) kcal += Number(m.display_kcal)
    })
    util.setTabBarHidden(true)
    this.setData({
      selectedDate: date,
      dayMeals: meals.map((m) => ({
        id: m.id,
        meal_type: m.meal_type,
        typeLabel: MEAL_LABEL[m.meal_type] || m.meal_type,
        name: m.dish_name || m.custom_name || '未命名',
        actual_food: m.actual_food,
        kcal: m.display_kcal || 0,
        servings: m.servings
      })),
      dayKcal: kcal,
      daySheet: true
    })
    this.loadHealth(date)
    this.renderCalendar(this.data.cells)
  },

  closeDay() {
    util.setTabBarHidden(false)
    this.setData({ daySheet: false })
  },

  shiftMonth(e) {
    const next = util.shiftMonth(this.data.year, this.data.month, Number(e.currentTarget.dataset.delta))
    this.setData({ year: next.year, month: next.month })
    this.loadCalendar()
  },

  backToday() {
    const d = new Date()
    this.setData({ year: d.getFullYear(), month: d.getMonth() + 1 })
    this.loadCalendar()
  },

  /* ---------------- 餐次 ---------------- */
  makeRow(name) {
    this._rowSeq = (this._rowSeq || 0) + 1
    return { id: 'r' + this._rowSeq, name: name || '', sug: [], sugEmpty: false }
  },

  // 把「农家小炒肉，米饭」这类文本拆回每一道菜
  splitDishes(text) {
    return String(text || '')
      .split(/[，,、；;\n]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  },

  dishNames() {
    return (this.data.mealRows || []).map((r) => String(r.name || '').trim()).filter(Boolean)
  },

  openMeal(e) {
    const date = e.currentTarget.dataset.date || this.data.selectedDate
    const id = e.currentTarget.dataset.id || ''
    const type = e.currentTarget.dataset.type || 'breakfast'
    const meal = id ? (this._meals || []).filter((m) => m.id === id)[0] : null
    const rows =
      meal && !meal.dish_id ? this.splitDishes(meal.dish_name || meal.custom_name || '').map((n) => this.makeRow(n)) : []

    util.setTabBarHidden(true)
    this._kcalTouched = false
    this.setData(
      {
        mealSheet: true,
        mealAppend: false,
        mealRows: rows.length ? rows : [this.makeRow('')],
        mealEstimating: false,
        mealEstimate: { kcal: null, items: [], note: '' },
        autoFocusIdx: -1,
        'mealForm.id': id,
        'mealForm.meal_date': meal ? meal.meal_date : date,
        'mealForm.meal_type': meal ? meal.meal_type : type,
        'mealForm.dish_id': meal && meal.dish_id ? meal.dish_id : '',
        'mealForm.custom_name': '',
        'mealForm.servings': meal ? meal.servings : 1,
        'mealForm.actual_food': meal ? meal.actual_food || '' : '',
        'mealForm.kcalText': meal && meal.estimated_kcal ? String(Math.round(Number(meal.estimated_kcal))) : ''
      },
      () => this.recalcEstimate()
    )
  },

  // 给已有的一餐再添一道菜
  openMealAdd(e) {
    const id = e.currentTarget.dataset.id
    const meal = (this._meals || []).filter((m) => m.id === id)[0]
    if (!meal) return
    const rows = this.splitDishes(meal.dish_name || meal.custom_name || '').map((n) => this.makeRow(n))
    rows.push(this.makeRow(''))

    util.setTabBarHidden(true)
    this._kcalTouched = false
    this.setData(
      {
        mealSheet: true,
        mealAppend: true,
        mealRows: rows,
        mealEstimating: false,
        mealEstimate: { kcal: null, items: [], note: '' },
        autoFocusIdx: rows.length - 1,
        'mealForm.id': meal.id,
        'mealForm.meal_date': meal.meal_date,
        'mealForm.meal_type': meal.meal_type,
        'mealForm.dish_id': '',
        'mealForm.custom_name': '',
        'mealForm.servings': meal.servings || 1,
        'mealForm.actual_food': meal.actual_food || '',
        'mealForm.kcalText': ''
      },
      () => this.recalcEstimate()
    )
  },

  closeMeal() {
    util.setTabBarHidden(false)
    this.setData({ mealSheet: false, autoFocusIdx: -1 })
  },

  setMealType(e) {
    this.setData({ 'mealForm.meal_type': e.currentTarget.dataset.value })
  },

  pickDish(e) {
    const id = e.currentTarget.dataset.id
    const next = this.data.mealForm.dish_id === id ? '' : id
    this.setData(
      {
        'mealForm.dish_id': next,
        mealRows: next ? [this.makeRow('')] : this.data.mealRows,
        'mealForm.kcalText': ''
      },
      () => {
        this._kcalTouched = false
        if (next) this.updateDishMode()
        else this.recalcEstimate()
      }
    )
  },

  /* ---------------- 菜品联想 ---------------- */
  onRowInput(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    if (!this.data.mealRows[idx]) return
    const value = e.detail.value
    const patch = {}
    patch['mealRows[' + idx + '].name'] = value
    if (this.data.mealForm.dish_id) patch['mealForm.dish_id'] = ''
    this.setData(patch)
    this.suggestFor(idx, value)
    this.debounceEstimate()
  },

  // 点进输入框就先给一批候选（常用菜品 + 最近吃过的），不用等网络
  onRowFocus(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const row = this.data.mealRows[idx]
    if (!row) return
    if (row.sug && row.sug.length) return
    this.suggestFor(idx, row.name || '')
  },

  // 最近吃过的菜名（从已加载的餐食里取，去重后按时间倒序）
  recentDishNames(limit) {
    const seen = {}
    const out = []
    const meals = (this._meals || []).slice().sort((a, b) => (a.meal_date < b.meal_date ? 1 : -1))
    meals.forEach((m) => {
      if (m.dish_id) {
        const d = (this.data.dishes || []).filter((x) => x.id === m.dish_id)[0]
        const name = (d && d.name) || m.dish_name || ''
        if (name && !seen[name]) {
          seen[name] = 1
          out.push(name)
        }
        return
      }
      this.splitDishes(m.dish_name || m.custom_name || '').forEach((name) => {
        if (!seen[name]) {
          seen[name] = 1
          out.push(name)
        }
      })
    })
    return out.slice(0, limit || 8)
  },

  // 本地即时候选：常用菜品 + 最近吃过 + 上次网络结果缓存
  localSuggest(q) {
    const key = String(q || '').trim()
    const seen = {}
    const out = []
    const push = (name, detail, kcal) => {
      const n = String(name || '').trim()
      if (!n || seen[n]) return
      seen[n] = 1
      out.push({ name: n, detail: detail || '', kcal: kcal || 0 })
    }
    const dishes = this.data.dishes || []
    if (!key) {
      dishes.forEach((d) => push(d.name, d.estimated_kcal ? d.estimated_kcal + ' kcal/份' : '常用菜品', d.estimated_kcal))
      this.recentDishNames(6).forEach((n) => push(n, '最近吃过'))
      if (!out.length) POPULAR_FOODS.forEach((n) => push(n, '常见食物'))
      return out.slice(0, 8)
    }
    dishes.forEach((d) => {
      if (String(d.name || '').indexOf(key) > -1) push(d.name, d.estimated_kcal ? d.estimated_kcal + ' kcal/份' : '常用菜品', d.estimated_kcal)
    })
    this.recentDishNames(12).forEach((n) => {
      if (n.indexOf(key) > -1) push(n, '最近吃过')
    })
    const cache = this._sugCache || {}
    Object.keys(cache).forEach((k) => {
      if (k.indexOf(key) > -1 || key.indexOf(k) > -1) cache[k].forEach((it) => push(it.name, it.detail, it.kcal))
    })
    return out.slice(0, 8)
  },

  setSug(idx, items, empty) {
    if (!this.data.mealRows[idx]) return
    const prev = (this.data.mealRows[idx].sug || []).length
    const patch = {}
    patch['mealRows[' + idx + '].sug'] = items || []
    patch['mealRows[' + idx + '].sugEmpty'] = !!empty
    // 列表从无到有时，把这一行滚到可视区上方，避免被键盘挡住
    if (!prev && (items || []).length) {
      patch.sugScroll = 'dishline' + idx
      if (this._sugScrollTimer) clearTimeout(this._sugScrollTimer)
      this._sugScrollTimer = setTimeout(() => this.setData({ sugScroll: '' }), 700)
    }
    this.setData(patch)
  },

  suggestFor(idx, q) {
    this._sugTimers = this._sugTimers || {}
    this._sugSeq = this._sugSeq || {}
    if (this._sugTimers[idx]) clearTimeout(this._sugTimers[idx])
    const text = String(q || '').trim()

    // 1) 本地候选立即渲染，保证「一输入就有下拉」
    const local = this.localSuggest(text)
    this.setSug(idx, local, false)

    if (!text) return

    // 2) 服务端补全（带序号防串结果 + 失败重试一次 + 全量缓存）
    const seq = (this._sugSeq[idx] || 0) + 1
    this._sugSeq[idx] = seq
    const mergeWithLocal = (remote) => {
      const seen = {}
      const out = []
      local.forEach((it) => {
        if (!seen[it.name]) {
          seen[it.name] = 1
          out.push(it)
        }
      })
      remote.forEach((it) => {
        if (!seen[it.name]) {
          seen[it.name] = 1
          out.push(it)
        }
      })
      return out.slice(0, 8)
    }
    const fetchOnce = (retry) => {
      api
        .get('/diet/food-references', { q: text, limit: 8 })
        .then((res) => {
          const items = ((res && res.items) || []).map((it) => {
            const label = String(it.label || it.name || '')
            const cut = label.indexOf(' · ')
            const m = label.match(/(\d+(?:\.\d+)?)\s*kcal/)
            return {
              name: it.name,
              detail: cut > -1 ? label.slice(cut + 3) : it.source || '',
              kcal: m ? Math.round(Number(m[1])) : 0
            }
          })
          this._sugCache = this._sugCache || {}
          if (items.length) this._sugCache[text] = items
          if (this._sugSeq[idx] !== seq) return
          const merged = mergeWithLocal(items)
          this.setSug(idx, merged, !merged.length)
          // 兜底：有缓存过更长的查询（比如先输「鸡肉粥」再删成「鸡」），已经在 local 里带出来了
        })
        .catch(() => {
          if (!retry) return
          setTimeout(() => fetchOnce(false), 500)
        })
    }
    this._sugTimers[idx] = setTimeout(() => fetchOnce(true), 120)
  },

  pickSuggest(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const name = e.currentTarget.dataset.name
    const kcal = Number(e.currentTarget.dataset.kcal) || 0
    if (!this.data.mealRows[idx]) return
    const patch = {}
    patch['mealRows[' + idx + '].name'] = name
    patch['mealRows[' + idx + '].sug'] = []
    patch['mealRows[' + idx + '].sugEmpty'] = false
    patch.sugScroll = ''
    // 候选自带参考热量时先填上，网络估算回来还能再修正
    if (kcal && !this._kcalTouched) {
      patch['mealForm.kcalText'] = String(kcal)
      this._kcalTouched = false
    }
    this.setData(patch)
    this.recalcEstimate()
  },

  hideSuggest(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    this._hideTimers = this._hideTimers || {}
    if (this._hideTimers[idx]) clearTimeout(this._hideTimers[idx])
    // 失焦后不立刻收起：手机上点候选会先触发失焦，收太快就点不到
    this._hideTimers[idx] = setTimeout(() => {
      if (!this.data.mealRows[idx]) return
      const patch = {}
      patch['mealRows[' + idx + '].sug'] = []
      patch['mealRows[' + idx + '].sugEmpty'] = false
      patch.sugScroll = ''
      this.setData(patch)
    }, 1500)
  },

  addRow() {
    if (this.data.mealRows.length >= 8) {
      util.toast('一餐最多 8 道菜')
      return
    }
    const rows = this.data.mealRows.concat([this.makeRow('')])
    this.setData({ mealRows: rows, autoFocusIdx: rows.length - 1 })
  },

  removeRow(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    if (this.data.mealRows.length <= 1) return
    const rows = this.data.mealRows.filter((r, i) => i !== idx)
    this.setData({ mealRows: rows }, () => this.recalcEstimate())
  },

  /* ---------------- 热量预估 ---------------- */
  debounceEstimate() {
    if (this._estTimer) clearTimeout(this._estTimer)
    this._estTimer = setTimeout(() => this.recalcEstimate(), 500)
  },

  trimNote(text) {
    const s = String(text || '').replace(/\s+/g, ' ')
    return s.length > 120 ? s.slice(0, 120) + '…' : s
  },

  updateDishMode() {
    const f = this.data.mealForm
    const dish = (this.data.dishes || []).filter((d) => d.id === f.dish_id)[0]
    const servings = Number(f.servings) || 1
    let kcal = null
    let note = ''
    if (dish) {
      if (dish.estimated_kcal) {
        kcal = Math.round(Number(dish.estimated_kcal) * servings)
        note = '常用菜品「' + dish.name + '」每份 ' + dish.estimated_kcal + ' kcal × ' + servings + ' 份'
      } else {
        note = '「' + dish.name + '」还没填热量，可到「常用菜品」里补充'
      }
    }
    const patch = { mealEstimating: false, mealEstimate: { kcal: kcal, items: [], note: note } }
    if (kcal && !this._kcalTouched) patch['mealForm.kcalText'] = String(kcal)
    this.setData(patch)
  },

  recalcEstimate() {
    const f = this.data.mealForm
    if (f.dish_id) {
      this.updateDishMode()
      return
    }
    const names = this.dishNames()
    if (!names.length) {
      this.setData({
        mealEstimating: false,
        estHasInput: false,
        mealEstimate: { kcal: null, items: [], note: '' },
        'mealForm.kcalText': ''
      })
      return
    }
    this.setData({ mealEstimating: true, estHasInput: true })
    api
      .post('/diet/calories/estimate', {
        custom_name: names.join('，'),
        servings: Number(f.servings) || 1
      })
      .then((res) => {
        const raw = res && res.display_kcal
        const kcal = raw === null || raw === undefined ? null : Math.round(Number(raw))
        const items = ((res && res.calorie_items) || []).map((it) => ({
          name: it.name,
          kcal: it.kcal ? Math.round(Number(it.kcal)) : 0
        }))
        const patch = {
          mealEstimating: false,
          mealEstimate: {
            kcal: kcal,
            items: items,
            note: this.trimNote(res && res.calorie_explanation)
          }
        }
        if (kcal && !this._kcalTouched) patch['mealForm.kcalText'] = String(kcal)
        this.setData(patch)
      })
      .catch(() => this.setData({ mealEstimating: false }))
  },

  onKcalInput(e) {
    const v = e.detail.value
    this._kcalTouched = !!String(v || '').trim()
    this.setData({ 'mealForm.kcalText': v })
  },

  onMealInput(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch['mealForm.' + key] = e.detail.value
    this.setData(patch)
    if (key === 'servings') {
      this._kcalTouched = false
      if (this.data.mealForm.dish_id) this.updateDishMode()
      else this.debounceEstimate()
    }
  },

  pickMealDate(e) {
    this.setData({ 'mealForm.meal_date': e.detail.value })
  },

  pickHealthDate(e) {
    const date = e.detail.value
    this.setData({ selectedDate: date })
    this.loadHealth(date)
  },

  goHealth() {
    util.setTabBarHidden(false)
    this.setData({ daySheet: false, tab: 'health' })
    this.loadHealth(this.data.selectedDate)
  },

  saveMeal() {
    const f = this.data.mealForm
    const names = this.dishNames()
    if (!f.dish_id && !names.length) {
      util.toast('选个常用菜品，或写下这餐吃了什么')
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })

    const kcal = Number(f.kcalText)
    const payload = {
      meal_date: f.meal_date,
      meal_type: f.meal_type,
      dish_id: f.dish_id || null,
      custom_name: f.dish_id ? '' : names.join('，'),
      servings: Number(f.servings) || 1,
      estimated_kcal: kcal > 0 ? Math.round(kcal) : null,
      actual_food: f.actual_food || ''
    }

    const task = f.id ? api.patch('/diet/meals/' + f.id, payload) : api.post('/diet/meals', payload)
    task
      .then(() => {
        util.setTabBarHidden(false)
        this.setData({ saving: false, mealSheet: false, autoFocusIdx: -1 })
        util.toast('已保存', 'success')
        return this.loadCalendar()
      })
      .then(() => {
        const meals = (this._meals || []).filter((m) => m.meal_date === this.data.selectedDate)
        let kcal = 0
        meals.forEach((m) => {
          if (m.display_kcal) kcal += Number(m.display_kcal)
        })
        this.setData({
          dayMeals: meals.map((m) => ({
            id: m.id,
            meal_type: m.meal_type,
            typeLabel: MEAL_LABEL[m.meal_type] || m.meal_type,
            name: m.dish_name || m.custom_name || '未命名',
            actual_food: m.actual_food,
            kcal: m.display_kcal || 0,
            servings: m.servings
          })),
          dayKcal: kcal
        })
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast(e.message || '保存失败')
      })
  },

  deleteMeal() {
    const id = this.data.mealForm.id
    if (!id) return
    wx.showModal({
      title: '删除这餐？',
      confirmText: '删除',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api
          .del('/diet/meals/' + id)
          .then(() => {
            util.setTabBarHidden(false)
            this.setData({ mealSheet: false, daySheet: false })
            return this.loadCalendar()
          })
          .catch((e) => util.toast(e.message || '删除失败'))
      }
    })
  },

  /* ---------------- 菜品 ---------------- */
  loadDishes() {
    return api
      .get('/diet/dishes')
      .then((list) => {
        util.cacheSet('diet_dishes', list || [])
        if (this._offline) this._offline.clear('dishes')
        this.setData({ dishes: list || [] })
      })
      .catch(() => {
        const cached = util.cacheGetStale('diet_dishes')
        if (cached) {
          this.setData({ dishes: cached })
          if (this._offline) this._offline.mark('dishes', util.cacheStamp('diet_dishes'))
        }
      })
  },

  openDish() {
    util.setTabBarHidden(true)
    this.setData({
      dishSheet: true,
      dishEditing: false,
      dishForm: {
        id: '',
        name: '',
        instructions: '',
        estimated_kcal: '',
        recipe_servings: 1,
        ingredients_text: '',
        nutrition_notes: '',
        notes: ''
      }
    })
  },

  // 点菜品卡片 → 打开编辑
  editDish(e) {
    const id = e.currentTarget.dataset.id
    const dish = (this.data.dishes || []).filter((d) => d.id === id)[0]
    if (!dish) return
    const lines = (dish.ingredients || [])
      .map((ing) => {
        const parts = [String(ing.name || '').trim()]
        if (ing.quantity !== null && ing.quantity !== undefined && ing.quantity !== '') parts.push(String(ing.quantity))
        else parts.push('')
        parts.push(String(ing.unit || '').trim())
        return parts.join(' | ').replace(/\s+\|\s*$/, '').replace(/\s+\|\s+\|$/, '')
      })
      .filter((x) => x.replace(/[\s|]/g, ''))
    util.setTabBarHidden(true)
    this.setData({
      dishSheet: true,
      dishEditing: true,
      dishForm: {
        id: dish.id,
        name: dish.name || '',
        instructions: dish.instructions || '',
        estimated_kcal: dish.estimated_kcal ? String(dish.estimated_kcal) : '',
        recipe_servings: dish.recipe_servings || 1,
        ingredients_text: lines.join('\n'),
        nutrition_notes: dish.nutrition_notes || '',
        notes: dish.notes || ''
      }
    })
  },

  closeDish() {
    util.setTabBarHidden(false)
    this.setData({ dishSheet: false })
  },

  onDishInput(e) {
    const patch = {}
    patch['dishForm.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  buildDishPayload() {
    const f = this.data.dishForm
    const ingredients = String(f.ingredients_text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|').map((x) => x.trim())
        return {
          name: parts[0],
          quantity: parts[1] ? Number(parts[1]) || null : null,
          unit: parts[2] || ''
        }
      })
      .filter((x) => x.name)
    return {
      name: String(f.name || '').trim(),
      instructions: f.instructions || '',
      estimated_kcal: String(f.estimated_kcal || '').trim() ? Math.round(Number(f.estimated_kcal)) : null,
      recipe_servings: Number(f.recipe_servings) || 1,
      ingredients: ingredients,
      nutrition_notes: f.nutrition_notes || '',
      notes: f.notes || ''
    }
  },

  saveDish() {
    const f = this.data.dishForm
    if (!String(f.name || '').trim()) {
      util.toast('请填写菜品名称')
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    const payload = this.buildDishPayload()
    const req = f.id ? api.patch('/diet/dishes/' + f.id, payload) : api.post('/diet/dishes', payload)
    req
      .then(() => {
        util.setTabBarHidden(false)
        this.setData({ saving: false, dishSheet: false, dishEditing: false })
        util.toast(f.id ? '菜品已更新' : '菜品已添加', 'success')
        return this.loadDishes()
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast(e.message || '保存失败')
      })
  },

  deleteDishInSheet() {
    const id = this.data.dishForm.id
    if (!id) return
    wx.showModal({
      title: '删除这个菜品？',
      content: '删除后，之前记录里引用它的餐食会保留名称。',
      confirmText: '删除',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api
          .del('/diet/dishes/' + id)
          .then(() => {
            util.setTabBarHidden(false)
            this.setData({ dishSheet: false, dishEditing: false })
            util.toast('已删除', 'success')
            return this.loadDishes()
          })
          .catch((err) => util.toast(err.message || '删除失败'))
      }
    })
  },

  deleteDish(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除这个菜品？',
      confirmText: '删除',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api
          .del('/diet/dishes/' + id)
          .then(() => this.loadDishes())
          .catch((err) => util.toast(err.message || '删除失败'))
      }
    })
  },

  /* ---------------- 每日记录 ---------------- */
  loadHealth(date) {
    if (!date) return Promise.resolve()
    const cacheKey = 'diet_health_' + date
    return api
      .get('/diet/health/' + date)
      .then((h) => {
        util.cacheSet(cacheKey, h || {})
        if (this._offline) this._offline.clear('health')
        this.applyHealth(h)
      })
      .catch(() => {
        const cached = util.cacheGetStale(cacheKey)
        if (cached) {
          this.applyHealth(cached)
          if (this._offline) this._offline.mark('health', util.cacheStamp(cacheKey))
        }
      })
  },

  applyHealth(h) {
    this.setData({
      health: {
        water_ml: (h && h.water_ml) || 0,
        weight_kg: h && h.weight_kg ? h.weight_kg : '',
        feeling: (h && h.feeling) || ''
      }
    })
  },

  loadProfile() {
    return api
      .get('/diet/profile')
      .then((p) =>
        this.setData({
          profile: {
            height_cm: p && p.height_cm ? p.height_cm : '',
            weight_kg: p && p.weight_kg ? p.weight_kg : ''
          }
        })
      )
      .catch(() => {})
  },

  addWater(e) {
    const delta = Number(e.currentTarget.dataset.delta)
    const next = Math.max(0, Number(this.data.health.water_ml || 0) + delta)
    this.setData({ 'health.water_ml': next })
  },

  onHealthInput(e) {
    const patch = {}
    patch['health.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  saveHealth() {
    const h = this.data.health
    api
      .put('/diet/health/' + this.data.selectedDate, {
        water_ml: Number(h.water_ml) || 0,
        weight_kg: h.weight_kg ? Number(h.weight_kg) : null,
        feeling: h.feeling || ''
      })
      .then(() => util.toast('记录已保存', 'success'))
      .catch((e) => util.toast(e.message || '保存失败'))
  },

  onProfileInput(e) {
    const patch = {}
    patch['profile.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  saveProfile() {
    const p = this.data.profile
    if (!p.height_cm || !p.weight_kg) {
      util.toast('请填写身高和体重')
      return
    }
    api
      .put('/diet/profile', { height_cm: Number(p.height_cm), weight_kg: Number(p.weight_kg) })
      .then(() => {
        util.toast('身体资料已保存', 'success')
        if (!this.data.health.weight_kg) this.setData({ 'health.weight_kg': p.weight_kg })
      })
      .catch((e) => util.toast(e.message || '保存失败'))
  },

  /* ---------------- 购物清单 ---------------- */
  loadShopping() {
    return api
      .get('/diet/shopping-lists')
      .then((list) => {
        util.cacheSet('diet_shopping', list || [])
        if (this._offline) this._offline.clear('shopping')
        this.applyShopping(list)
      })
      .catch(() => {
        const cached = util.cacheGetStale('diet_shopping')
        if (cached) {
          this.applyShopping(cached)
          if (this._offline) this._offline.mark('shopping', util.cacheStamp('diet_shopping'))
        }
      })
  },

  applyShopping(list) {
    const lists = (list || []).map((l) => ({
      id: l.id,
      name: l.name,
      start_date: l.start_date,
      end_date: l.end_date,
      items: (l.items || []).map((it) => ({
        id: it.id,
        name: it.ingredient_name,
        quantity: it.quantity_text,
        done: !!it.is_completed
      }))
    }))
    // 正在编辑的物品若已被删掉，退出编辑态
    let editId = this.data.itemEditId
    if (editId) {
      const still = lists.some((l) => (l.items || []).some((it) => it.id === editId))
      if (!still) editId = ''
    }
    this.setData({ shoppingLists: lists, itemEditId: editId })
  },

  openShopping() {
    util.setTabBarHidden(true)
    const t = util.today()
    this.setData({
      shoppingSheet: true,
      shoppingForm: { name: '一周采购', start_date: t, end_date: util.addDays(t, 7) }
    })
  },

  closeShopping() {
    util.setTabBarHidden(false)
    this.setData({ shoppingSheet: false })
  },

  onShoppingInput(e) {
    const patch = {}
    patch['shoppingForm.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  pickShoppingDate(e) {
    const patch = {}
    patch['shoppingForm.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  generateShopping() {
    const f = this.data.shoppingForm
    if (!String(f.name || '').trim()) {
      util.toast('请填写清单名称')
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    api
      .post('/diet/shopping-lists/generate', {
        name: String(f.name).trim(),
        start_date: f.start_date,
        end_date: f.end_date
      })
      .then(() => {
        util.setTabBarHidden(false)
        this.setData({ saving: false, shoppingSheet: false })
        util.toast('清单已生成', 'success')
        return this.loadShopping()
      })
      .catch((e) => {
        this.setData({ saving: false })
        util.toast(e.message || '生成失败')
      })
  },

  toggleShoppingItem(e) {
    const id = e.currentTarget.dataset.id
    const done = e.currentTarget.dataset.done
    api
      .patch('/diet/shopping-items/' + id, { is_completed: !done })
      .then(() => this.loadShopping())
      .catch((err) => util.toast(err.message || '更新失败'))
  },

  /** 行内修改单个采购物品 */
  startEditItem(e) {
    const id = e.currentTarget.dataset.id
    let target = null
    ;(this.data.shoppingLists || []).forEach((l) => {
      ;(l.items || []).forEach((it) => {
        if (it.id === id) target = it
      })
    })
    if (!target) return
    this.setData({
      itemEditId: id,
      itemEditForm: { name: target.name || '', quantity: target.quantity || '' }
    })
  },

  onEditItemInput(e) {
    const patch = {}
    patch['itemEditForm.' + e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
  },

  cancelEditItem() {
    this.setData({ itemEditId: '', itemEditForm: { name: '', quantity: '' } })
  },

  saveShoppingItem() {
    const id = this.data.itemEditId
    if (!id || this.data.itemSaving) return
    const f = this.data.itemEditForm
    const name = String(f.name || '').trim()
    if (!name) {
      util.toast('物品名称不能为空')
      return
    }
    const payload = { ingredient_name: name }
    const q = String(f.quantity || '').trim()
    if (q) payload.quantity_text = q
    this.setData({ itemSaving: true })
    api
      .patch('/diet/shopping-items/' + id, payload)
      .then(() => {
        this.setData({ itemSaving: false, itemEditId: '', itemEditForm: { name: '', quantity: '' } })
        util.toast('已修改', 'success')
        return this.loadShopping()
      })
      .catch((err) => {
        this.setData({ itemSaving: false })
        util.toast(err.message || '保存失败')
      })
  },

  deleteShoppingItem(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name || '这个物品'
    wx.showModal({
      title: '删除这个物品？',
      content: '把「' + name + '」从采购清单里删掉。',
      confirmText: '删除',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api
          .del('/diet/shopping-items/' + id)
          .then(() => {
            if (this.data.itemEditId === id) {
              this.setData({ itemEditId: '', itemEditForm: { name: '', quantity: '' } })
            }
            util.toast('已删除', 'success')
            return this.loadShopping()
          })
          .catch((err) => util.toast(err.message || '删除失败'))
      }
    })
  },

  /* ---------------- AI 生成菜单 ---------------- */
  openAiDiet() {
    util.setTabBarHidden(true)
    this.setData({
      aiDietSheet: true,
      aiDietForm: { theme: '', preferences: '', days: 1 },
      aiDietPlan: null,
      aiDietDays: [],
      aiDietError: ''
    })
  },

  closeAiDiet() {
    if (this.data.aiDietGenerating) {
      util.toast('AI 生成中，请稍候…')
      return
    }
    util.setTabBarHidden(false)
    this.setData({ aiDietSheet: false })
  },

  onAiDietInput(e) {
    const patch = {}
    patch['aiDietForm.' + e.currentTarget.dataset.key] = e.detail.value
    if (this.data.aiDietError) patch.aiDietError = ''
    this.setData(patch)
  },

  groupAiMeals(meals) {
    const map = {}
    ;(meals || []).forEach((m) => {
      const key = m.day_number || 1
      if (!map[key]) map[key] = []
      map[key].push({
        type: MEAL_LABEL[m.meal_type] || m.meal_type,
        name: m.name,
        kcal: m.estimated_kcal || 0
      })
    })
    return Object.keys(map)
      .sort((a, b) => a - b)
      .map((k) => ({ key: k, label: '第 ' + k + ' 天', items: map[k] }))
  },

  generateDiet() {
    if (this.data.aiDietGenerating) return
    const f = this.data.aiDietForm
    if (!String(f.theme || '').trim()) {
      this.setData({ aiDietError: '请填写菜单主题，例如：低脂减脂餐' })
      return
    }
    this.setData({ aiDietGenerating: true, aiDietError: '', aiDietPlan: null, aiDietDays: [] })

    api
      .post(
        '/ai/diet/generate',
        {
          theme: String(f.theme).trim(),
          preferences: String(f.preferences || '').trim(),
          days: Math.min(7, Math.max(1, Number(f.days) || 1))
        },
        { timeout: 240000 }
      )
      .then((res) => {
        const plan = res && res.plan
        if (!plan || !plan.meals || !plan.meals.length) throw new Error('生成结果为空，请重试')
        this.setData({
          aiDietGenerating: false,
          aiDietPlan: plan,
          aiDietDays: this.groupAiMeals(plan.meals)
        })
      })
      .catch((e) => {
        this.setData({ aiDietGenerating: false, aiDietError: (e && e.message) || '生成失败，请重试' })
      })
  },

  regenerateDiet() {
    this.setData({ aiDietPlan: null, aiDietDays: [], aiDietError: '' })
    this.generateDiet()
  },

  applyAiDiet() {
    if (this.data.aiDietImporting || !this.data.aiDietPlan) return
    const start = this.data.selectedDate
    const meals = this.data.aiDietPlan.meals || []
    if (!meals.length) return

    this.setData({ aiDietImporting: true, aiDietError: '' })

    // 逐条写入，避免并发写库冲突
    let chain = Promise.resolve()
    meals.forEach((m) => {
      chain = chain.then(() =>
        api.post('/diet/meals', {
          custom_name: m.name || '',
          estimated_kcal: m.estimated_kcal || null,
          meal_date: util.addDays(start, (m.day_number || 1) - 1),
          meal_type: m.meal_type || 'lunch',
          servings: 1
        })
      )
    })

    chain
      .then(() => {
        util.toast('菜单已加入饮食日历', 'success')
        util.setTabBarHidden(false)
        this.setData({ aiDietImporting: false, aiDietSheet: false, aiDietPlan: null, aiDietDays: [] })
        return this.loadCalendar()
      })
      .catch((e) => {
        this.setData({ aiDietImporting: false, aiDietError: (e && e.message) || '写入失败，请重试' })
      })
  },

  deleteShoppingList(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除这个清单？',
      confirmText: '删除',
      confirmColor: '#c9455a',
      success: (r) => {
        if (!r.confirm) return
        api
          .del('/diet/shopping-lists/' + id)
          .then(() => this.loadShopping())
          .catch((err) => util.toast(err.message || '删除失败'))
      }
    })
  },

  onItemDraft(e) {
    this.setData({ itemDraft: e.detail.value })
  },

  addShoppingItem(e) {
    const listId = e.currentTarget.dataset.id
    const name = String(this.data.itemDraft || '').trim()
    if (!name) return
    api
      .post('/diet/shopping-lists/' + listId + '/items', { ingredient_name: name, quantity_text: '按需' })
      .then(() => {
        this.setData({ itemDraft: '' })
        return this.loadShopping()
      })
      .catch((err) => util.toast(err.message || '添加失败'))
  },

  setTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ tab: tab })
    if (tab === 'shopping') this.loadShopping()
    if (tab === 'health') this.loadHealth(this.data.selectedDate)
  },

  /** 离线横幅点击：跳到「数据与设置」改服务地址（换隧道域名时用） */
  goServer() {
    wx.switchTab({ url: '/pages/settings/index' })
  },

  retry() {
    this.loadAll()
  }
})
