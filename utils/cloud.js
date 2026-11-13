/**
 * 微信云开发：只服务「监督群」这一块跨用户数据（群、成员、打卡快照、催办）。
 * 个人数据仍然走电脑端后端（utils/api.js），两条链路互不影响。
 *
 * 所有群数据读写都经过云函数 phgroup（管理员身份），
 * 所以不需要在云开发控制台给集合逐个设权限。
 *
 * 未开通云开发 / 云函数没部署时不崩溃：status() 不可用时页面显示「还差两步」引导，
 * 调用报错会被翻译成能照着做的中文提示，其它功能完全不受影响。
 */
const config = require('../config')

const OPENID_KEY = 'ph_openid'
const FN = 'phgroup'

let inited = false
let ready = false
let openidCache = ''

function envId() {
  return String((config && config.cloudEnv) || '').trim()
}

/** 是否填了云环境 ID */
function configured() {
  return !!envId()
}

/** 初始化云开发（幂等）
 *  填了 cloudEnv 就用它；没填就交给云开发用「默认环境」（第一个创建的环境）。
 *  群数据全部经云函数读写，客户端不直接连库，所以默认环境足够用。
 */
function init() {
  if (inited) return ready
  inited = true
  if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.init !== 'function') return false
  try {
    if (envId()) wx.cloud.init({ env: envId(), traceUser: true })
    else wx.cloud.init({ traceUser: true })
    ready = true
  } catch (e) {
    ready = false
  }
  return ready
}

/** 是否在用默认环境（没填 cloudEnv） */
function isAuto() {
  return !envId()
}

/**
 * 状态：
 *  - 'no-support' 当前基础库/环境不支持云开发
 *  - 'ok'         可用
 */
function status() {
  if (!init()) return 'no-support'
  return 'ok'
}

function notReady() {
  return '当前微信版本不支持云开发，请升级微信后重试'
}

/** 调用云函数 phgroup，统一拆 {ok,data} 信封并翻译常见错误 */
function invoke(data) {
  if (status() !== 'ok') return Promise.reject(new Error(notReady()))
  return wx.cloud
    .callFunction({ name: FN, data: data || {} })
    .then((res) => {
      const r = (res && res.result) || {}
      if (r.ok === false) throw new Error(r.error || '云开发调用失败')
      return r.data
    })
    .catch((e) => {
      const msg = String((e && (e.errMsg || e.message)) || '')
      if (/collection not exists|-502005|DATABASE_COLLECTION_NOT_EXIST/i.test(msg)) {
        throw new Error('数据集合还没建好：回到监督群页点「重新检测」')
      }
      if (/not found|does not exist|FunctionName|-501000|FUNCTION_NOT_FOUND|env|Environment/i.test(msg)) {
        throw new Error(
          '云开发还没开通，或者云函数 phgroup 还没部署。' +
            '开通：开发者工具右上角「云开发」→ 开通；' +
            '部署：左侧右键 cloudfunctions/phgroup → 上传并部署（云端安装依赖）'
        )
      }
      throw new Error(e && e.message ? e.message : '云开发调用失败')
    })
}

/** 一次性创建 4 个集合（幂等，可以反复点） */
function setup() {
  return invoke({ action: 'setup' })
}

/** 当前用户 openid：首次经云函数取回，之后读本地缓存 */
function openid() {
  if (openidCache) return Promise.resolve(openidCache)
  const saved = wx.getStorageSync(OPENID_KEY) || ''
  if (saved) {
    openidCache = saved
    return Promise.resolve(saved)
  }
  return invoke({ action: 'whoami' }).then((d) => {
    const id = (d && d.openid) || ''
    if (!id) throw new Error('取不到微信身份')
    openidCache = id
    wx.setStorageSync(OPENID_KEY, id)
    return id
  })
}

function clearOpenid() {
  openidCache = ''
  try {
    wx.removeStorageSync(OPENID_KEY)
  } catch (e) {}
}

/**
 * 上传群头像到云存储，返回 fileID（cloud://...）。
 * 存储权限用默认的「仅创建者可写」即可，读走 getTempFileURL，不需要改权限。
 */
function uploadAvatar(filePath, prefix) {
  if (status() !== 'ok') return Promise.reject(new Error(notReady()))
  const src = String(filePath || '')
  if (!src) return Promise.reject(new Error('没有选择图片'))
  const m = src.match(/\.([a-zA-Z0-9]+)$/)
  const ext = m ? m[1].toLowerCase() : 'jpg'
  const cloudPath = 'group-avatars/' + (prefix || 'g') + '-' + Date.now() + '.' + ext
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: src,
      success: (r) => {
        const id = (r && r.fileID) || ''
        if (!id) reject(new Error('上传失败，请重试'))
        else resolve(id)
      },
      fail: () => reject(new Error('头像上传失败，检查网络后重试'))
    })
  })
}

/** fileID → 可直接放进 <image src> 的临时地址（带 1 小时本地缓存） */
function tempUrl(fileID) {
  const id = String(fileID || '')
  if (!id) return Promise.resolve('')
  if (id.indexOf('http') === 0) return Promise.resolve(id)
  if (status() !== 'ok') return Promise.resolve('')
  const KEY = 'ph_tmpurl_' + id
  try {
    const hit = wx.getStorageSync(KEY)
    if (hit && hit.url && Date.now() - (hit.at || 0) < 3600 * 1000) return Promise.resolve(hit.url)
  } catch (e) {}
  return new Promise((resolve) => {
    wx.cloud.getTempFileURL({
      fileList: [id],
      success: (res) => {
        const f = ((res && res.fileList) || [])[0]
        const url = (f && f.tempFileURL) || ''
        if (url) {
          try {
            wx.setStorageSync(KEY, { url: url, at: Date.now() })
          } catch (e) {}
        }
        resolve(url)
      },
      fail: () => resolve('')
    })
  })
}

module.exports = {
  configured,
  init,
  isAuto,
  status,
  invoke,
  setup,
  openid,
  clearOpenid,
  uploadAvatar,
  tempUrl,
  envId
}
