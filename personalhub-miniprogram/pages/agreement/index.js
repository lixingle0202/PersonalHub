const theme = require('../../utils/theme')

Page({
  data: Object.assign({}, theme.data()),

  onShow() {
    this.setData(theme.data())
    theme.applyNav(theme.current())
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.reLaunch({ url: '/pages/login/index' })
  },
})
