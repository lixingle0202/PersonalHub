const COLOR_KEYS = {
  '#5b6cff': 't-blue',
  '#1f9d75': 't-green',
  '#e8813a': 't-orange',
  '#a15ddb': 't-purple',
  '#3f7f9e': 't-teal',
}

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  data: {
    selected: 0,
    dark: false,
    hidden: false,
    colorHex: '#5b6cff',
    colorKey: 't-blue',
    badges: {},
    list: [
      { path: '/pages/home/index', text: '首页总览', icon: 'home' },
      { path: '/pages/today/index', text: '今日计划', icon: 'clock' },
      { path: '/pages/learning/index', text: '学习计划', icon: 'book' },
      { path: '/pages/diet/index', text: '饮食计划', icon: 'bowl' },
      { path: '/pages/settings/index', text: '数据与设置', icon: 'sliders' },
    ],
  },

  methods: {
    init(selected, theme) {
      const color = (theme && theme.color) || '#5b6cff'
      // 每个页面都有独立的 tabBar 实例，角标统一从本地存储恢复
      let badges = {}
      try {
        const learning = Number(wx.getStorageSync('ph_badge_learning') || 0)
        const todayN = Number(wx.getStorageSync('ph_badge_today') || 0)
        if (learning > 0) badges['2'] = learning
        if (todayN > 0) badges['1'] = todayN
      } catch (e) {
        /* 读不到就没有角标 */
      }
      this.setData({
        selected: selected || 0,
        dark: !!theme && theme.mode === 'dark',
        hidden: false,
        colorHex: color,
        colorKey: COLOR_KEYS[String(color).toLowerCase()] || 't-blue',
        badges: badges,
      })
    },

    /** 某个 tab 显示红色角标数字（index 从 0 起，0 表示隐藏） */
    setBadge(index, count) {
      const n = Math.max(0, Number(count) || 0)
      const patch = {}
      patch['badges[' + index + ']'] = n > 0 ? (n > 99 ? '99+' : n) : 0
      this.setData(patch)
    },

    /**
     * 弹层打开时把 tabBar 收起：自定义 tabBar 的层级高于页面里的 fixed 弹层，
     * 不收起会压住弹层底部的「保存 / 取消」按钮。
     */
    setHidden(v) {
      const next = !!v
      if (this.data.hidden !== next) this.setData({ hidden: next })
    },

    onTap(e) {
      const index = e.currentTarget.dataset.index
      const item = this.data.list[index]
      if (!item || index === this.data.selected) return
      this.setData({ selected: index })
      wx.switchTab({ url: item.path })
    },
  },
})
