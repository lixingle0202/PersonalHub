// 「微信提醒」的订阅授权流程。
// 学习页横幅、设置页入口、启动时静默补订都走这里，避免多处逻辑各写一遍以后漂移。
//
// 关键背景：微信「一次性订阅消息」一条授权只能收一条消息，没法真正永久订阅。
// 破解办法（做到「授权一次就能一直收到」）：
//   1) 用户在弹窗里勾上「总是保持以上选择」后，后续 requestSubscribeMessage 不再弹窗、直接 accept；
//   2) 所以点一次按钮我们连要最多 6 轮，把额度一次攒够；
//   3) 之后每次打开小程序（app.onShow）静默检查额度，低于 6 条就自动补一批 —— 用户完全无感。
// 所以：授权一次 → 勾上「总是保持」→ 以后所有计划都会自动提醒，不用再点。
const api = require('./api')
const util = require('./util')

const FLAG_KEY = 'ph_remind_on'        // 本机是否开启过提醒
const AUTO_KEY = 'ph_remind_auto'      // 是否检测到「总是保持」（可静默补订）
const LAST_AUTO_KEY = 'ph_remind_last' // 上次静默补订时间
const MANUAL_ROUNDS = 6                // 手动点一次最多攒 6 条额度
const AUTO_ROUNDS = 4                  // 每次自动补订最多补 4 条
const TARGET_QUOTA = 6                 // 剩余额度低于这个数就自动补
const AUTO_GAP_MS = 15 * 60 * 1000     // 两次自动补订至少间隔 15 分钟
const SILENT_MS = 400                  // 返回太快 = 没弹窗（用户勾了「总是」）

function isOn() {
  try {
    return !!wx.getStorageSync(FLAG_KEY)
  } catch (e) {
    return false
  }
}

function isAuto() {
  try {
    return !!wx.getStorageSync(AUTO_KEY)
  } catch (e) {
    return false
  }
}

function setStorage(k, v) {
  try {
    wx.setStorageSync(k, v)
  } catch (e) {
    /* 存不下不影响本次授权 */
  }
}

/** 弹一次授权，返回 {accepted, ms}；ms 用来判断是不是静默通过 */
function askOnce(tmplId) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (r) => resolve({ accepted: r[tmplId] === 'accept', ms: Date.now() - t0 }),
      fail: (e) => resolve({ accepted: false, ms: Date.now() - t0, err: e })
    })
  })
}

function loginCode() {
  return new Promise((resolve) => {
    wx.login({
      success: (r) => resolve(r.code || ''),
      fail: () => resolve('')
    })
  })
}

/**
 * 连要多次授权：第 1 轮必定弹窗，用户勾了「总是保持以上选择」之后
 * 后续几轮都是静默 accept（耗时极短），所以能一次攒下多条额度。
 * 返回 {accepts, silent}
 */
function askMany(tmplId, maxRounds) {
  return askOnce(tmplId).then((first) => {
    if (!first.accepted) return { accepts: 0, silent: false }
    const silent = first.ms < SILENT_MS
    const accepts = { n: 1 }
    const next = (i) => {
      if (!silent || i >= maxRounds) return Promise.resolve()
      return askOnce(tmplId).then((r) => {
        if (!r.accepted || r.ms >= SILENT_MS) return
        accepts.n += 1
        return next(i + 1)
      })
    }
    return next(1).then(() => ({ accepts: accepts.n, silent: silent }))
  })
}

/** 把拿到的额度登记到电脑端推送服务 */
function register(accepts) {
  return loginCode().then((code) => {
    if (!code) return false
    return api
      .post('/wx/subs/register', { code: code, accepts: accepts, session: api.getSession() })
      .then(() => true)
      .catch(() => false)
  })
}

// 把「这个微信号当前在用哪个账号」同步给电脑端：推送时会用这个账号的数据，
// 否则会拿着默认测试账号的计划乱推。登录后/打开小程序时各同步一次，5 分钟节流。
const SYNC_KEY = 'ph_remind_sync'
const SYNC_GAP_MS = 5 * 60 * 1000

function syncAccount(force) {
  const session = api.getSession()
  if (!session) return Promise.resolve(false)
  let last = 0
  try {
    last = Number(wx.getStorageSync(SYNC_KEY) || 0)
  } catch (e) {
    last = 0
  }
  if (!force && Date.now() - last < SYNC_GAP_MS) return Promise.resolve(false)
  return loginCode().then((code) => {
    if (!code) return false
    return api
      .post('/wx/subs/session', { code: code, session: session })
      .then((r) => {
        try {
          wx.setStorageSync(SYNC_KEY, Date.now())
        } catch (e) {}
        return (r && r.username) || true
      })
      .catch(() => false)
  })
}

/**
 * 主流程：拿模板 id → 连要最多 6 轮 → 汇总登记额度。
 * resolve(true) 表示订阅成功（额度已累加）。
 */
function subscribe() {
  if (!wx.requestSubscribeMessage) {
    util.toast('当前微信版本太旧，不支持订阅消息')
    return Promise.resolve(false)
  }
  return api
    .get('/wx/subs/status')
    .then((s) => {
      if (!s || !s.has_secret) {
        util.toast('电脑端推送服务还没配置好，暂时开不了')
        return ''
      }
      return s.tmpl_id
    })
    .then((tmplId) => {
      if (!tmplId) {
        util.toast('还没有可用的消息模板，需要先在微信后台申请')
        return false
      }
      return askMany(tmplId, MANUAL_ROUNDS).then((r) => {
        if (!r.accepts) {
          util.toast('没有同意授权，开不了提醒')
          return false
        }
        setStorage(AUTO_KEY, r.silent ? 1 : 0)
        return register(r.accepts).then((ok) => {
          if (!ok) {
            util.toast('登记失败，请检查电脑端服务是否在线')
            return false
          }
          setStorage(FLAG_KEY, 1)
          if (r.accepts > 1) {
            util.toast('已开启：所有计划都会自动提醒你（额度 ' + r.accepts + ' 条）', 'success')
          } else {
            util.toast('已开启：计划开始/到期都会提醒你', 'success')
            if (!r.silent) {
              // 用户没勾「总是保持」：再点一次可以攒更多额度，这里只提示不打扰
              setTimeout(() => util.toast('想少点几次？重新点一次并在弹窗勾「总是保持以上选择」'), 1800)
            }
          }
          return true
        })
      })
    })
    .catch(() => {
      util.toast('检查推送服务失败，请确认电脑端服务已启动')
      return false
    })
}

/**
 * 静默补订：额度低于 TARGET_QUOTA 时由 app 启动 / 学习页显示触发。
 * 只有确认用户勾过「总是保持以上选择」才会走这里，所以不会再弹窗打扰。
 */
function autoTopup() {
  if (!isOn() || !isAuto()) return Promise.resolve(false)
  let last = 0
  try {
    last = Number(wx.getStorageSync(LAST_AUTO_KEY) || 0)
  } catch (e) {
    last = 0
  }
  if (Date.now() - last < AUTO_GAP_MS) return Promise.resolve(false)
  return loginCode()
    .then((code) => api.get('/wx/subs/status' + (code ? '?code=' + encodeURIComponent(code) : '')))
    .then((s) => {
      if (!s || !s.tmpl_id) return false
      const my = s.my_quota != null ? Number(s.my_quota) : Number(s.quota || 0)
      if (my >= TARGET_QUOTA) return false // 我自己的额度还够，不用补（不能用所有人总和判断）
      setStorage(LAST_AUTO_KEY, Date.now())
      return askMany(s.tmpl_id, AUTO_ROUNDS).then((r) => {
        if (!r.accepts || !r.silent) return false
        return register(r.accepts).then(() => true)
      })
    })
    .catch(() => false)
}

/** 查服务端剩余额度（「我这个微信号」的，不是所有人总和），用于界面显示与补订判断 */
function quota() {
  // 带上 wx.login 的 code：服务端换 openid 认人，比靠会话可靠（会话可能是裸 token/已失效）
  return loginCode()
    .then((code) => api.get('/wx/subs/status' + (code ? '?code=' + encodeURIComponent(code) : '')))
    .then((s) => {
      if (!s) return 0
      // my_quota：按请求者身份匹配到的个人额度；服务端旧版没这个字段时退回 quota
      return Number(s.my_quota != null ? s.my_quota : s.quota || 0)
    })
    .catch(() => 0)
}

module.exports = { isOn, isAuto, subscribe, autoTopup, quota, syncAccount, FLAG_KEY }
