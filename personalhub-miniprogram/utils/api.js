/**
 * 接口封装
 * - 统一 baseUrl、Cookie 会话、X-Local-Token 写保护
 * - 401 自动回到登录页；写令牌失效自动刷新重试
 */
const config = require('../config')

const KEYS = {
  session: 'ph_session',
  token: 'ph_token',
  user: 'ph_user',
  settings: 'ph_settings',
  baseUrl: 'ph_base_url',
}

const COOKIE_NAME = 'personalhub_public_session'

let mem = { session: '', token: '' }
let reloginLock = false

/** 规范化地址：补 https://、去空格和末尾斜杠 */
function normalizeBase(url) {
  let v = String(url || '').trim()
  if (!v) return ''
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v
  return v.replace(/\/+$/, '')
}

/** 当前生效的服务地址：本地设置优先，其次 config.js 里的默认值 */
function getBaseUrl() {
  let saved = ''
  try {
    saved = wx.getStorageSync(KEYS.baseUrl) || ''
  } catch (e) {
    saved = ''
  }
  return normalizeBase(saved) || normalizeBase(config.baseUrl)
}

function setBaseUrl(url) {
  const v = normalizeBase(url)
  const previous = getBaseUrl()
  if (!v) wx.removeStorageSync(KEYS.baseUrl)
  else wx.setStorageSync(KEYS.baseUrl, v)
  if (getBaseUrl() !== previous) clearAuth()
  return v
}

function resetBaseUrl() {
  const previous = getBaseUrl()
  try {
    wx.removeStorageSync(KEYS.baseUrl)
  } catch (e) {}
  if (getBaseUrl() !== previous) clearAuth()
  return normalizeBase(config.baseUrl)
}

/** 是否用了自定义地址（与 config.js 默认值不同） */
function isCustomBaseUrl() {
  return getBaseUrl() !== normalizeBase(config.baseUrl)
}

function base() {
  return getBaseUrl()
}

function log() {
  if (config.debug) {
    console.log.apply(console, ['[api]'].concat([].slice.call(arguments)))
  }
}

/* ---------------- 会话存储 ---------------- */
function getSession() {
  if (!mem.session) mem.session = wx.getStorageSync(KEYS.session) || ''
  return mem.session
}

function setSession(v) {
  mem.session = v || ''
  if (v) wx.setStorageSync(KEYS.session, v)
  else wx.removeStorageSync(KEYS.session)
}

function getToken() {
  if (!mem.token) mem.token = wx.getStorageSync(KEYS.token) || ''
  return mem.token
}

function setToken(v) {
  mem.token = v || ''
  if (v) wx.setStorageSync(KEYS.token, v)
  else wx.removeStorageSync(KEYS.token)
}

function getUser() {
  return wx.getStorageSync(KEYS.user) || null
}

function setUser(u) {
  if (u) wx.setStorageSync(KEYS.user, u)
  else wx.removeStorageSync(KEYS.user)
}

function clearAuth() {
  setSession('')
  setToken('')
  setUser(null)
  wx.removeStorageSync(KEYS.settings)
  wx.removeStorageSync('ph_remind_sync')
}

function isLoggedIn() {
  return !!getSession()
}

/* ---------------- Cookie 解析 ---------------- */
function pickCookie(header) {
  if (!header) return ''
  const raw = header['Set-Cookie'] || header['set-cookie'] || header['SET-COOKIE']
  if (!raw) return ''
  const list = Array.isArray(raw) ? raw : [raw]
  for (let i = 0; i < list.length; i++) {
    const m = new RegExp(COOKIE_NAME + '=([^;\\s]+)').exec(String(list[i]))
    if (m) return m[1]
  }
  return ''
}

/* ---------------- 请求 ---------------- */
function buildQuery(query) {
  if (!query) return ''
  const parts = []
  Object.keys(query).forEach((k) => {
    const v = query[k]
    if (v === undefined || v === null || v === '') return
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v))
  })
  return parts.length ? '?' + parts.join('&') : ''
}

function errText(res) {
  const d = res && res.data
  if (typeof d === 'string' && d) return d.slice(0, 120)
  if (d && typeof d.detail === 'string') return d.detail
  if (d && Array.isArray(d.detail)) {
    const t = d.detail
      .map((x) => x && x.msg)
      .filter(Boolean)
      .join('；')
    if (t) return t
  }
  if (d && typeof d.message === 'string') return d.message
  return '操作失败（' + ((res && res.statusCode) || '网络异常') + '）'
}

/** 网关层的错误（隧道 100 秒超时会返回 524 这种），正文是英文，翻成中文 */
function gatewayText(code) {
  if (code === 524 || code === 522 || code === 520 || code === 523) {
    return '服务端处理超时（网关等太久先断开了），请稍后重试'
  }
  if (code === 504) return '网关等待服务端响应超时，请稍后重试'
  if (code === 502 || code === 503) return '服务暂时不可用，请稍后重试'
  if (code === 429) return '请求太频繁，请稍后再试'
  return ''
}

/** 统一造错：带 statusCode / code，方便调用方按错误类型分别处理 */
function httpError(res) {
  const code = (res && res.statusCode) || 0
  const d = res && res.data
  const hasDetail =
    d &&
    typeof d === 'object' &&
    (typeof d.detail === 'string' || Array.isArray(d.detail) || typeof d.message === 'string')
  const e = new Error(hasDetail ? errText(res) : gatewayText(code) || errText(res))
  e.statusCode = code
  if (d && typeof d === 'object' && d.code) e.code = d.code
  return e
}

function goLogin() {
  if (reloginLock) return
  reloginLock = true
  clearAuth()
  const pages = getCurrentPages()
  const cur = pages.length ? pages[pages.length - 1].route : ''
  if (cur && cur.indexOf('pages/login/index') === -1) {
    wx.reLaunch({
      url: '/pages/login/index',
      complete: () => setTimeout(() => (reloginLock = false), 800),
    })
  } else {
    reloginLock = false
  }
}

/**
 * 发起请求
 * @param {string} path 形如 '/home'
 * @param {object} options { method, data, query, retry }
 */
function request(path, options) {
  const opt = options || {}
  const method = (opt.method || 'GET').toUpperCase()
  const safe = method === 'GET' || method === 'HEAD'
  const url = base() + '/api/v1' + path + buildQuery(opt.query)

  const header = {
    Accept: 'application/json',
    'content-type': 'application/json',
  }
  const session = getSession()
  if (session) header.Cookie = COOKIE_NAME + '=' + session
  if (!safe) {
    const token = getToken()
    if (token) header['X-Local-Token'] = token
  }

  log(method, url)

  return new Promise((resolve, reject) => {
    wx.request({
      url: url,
      method: method,
      header: header,
      data: opt.data === undefined ? undefined : opt.data,
      timeout: opt.timeout || 30000,
      success: (res) => {
        const cookie = pickCookie(res.header)
        if (cookie && cookie !== session) {
          setSession(cookie)
          log('session cookie updated')
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.statusCode === 204 ? null : res.data)
          return
        }

        if (res.statusCode === 401) {
          goLogin()
          reject(new Error('请先登录'))
          return
        }

        // 写保护令牌失效：刷新 bootstrap 后重试一次
        const text = errText(res)
        if (res.statusCode === 403 && /local write token/i.test(text) && !opt.retry) {
          bootstrap()
            .then(() => resolve(request(path, Object.assign({}, opt, { retry: true }))))
            .catch(() => reject(new Error(text)))
          return
        }

        reject(httpError(res))
      },
      fail: (e) => {
        log('fail', e)
        const msg = e && e.errMsg ? e.errMsg.replace(/^request:fail\s*/, '') : ''
        if (/timeout|timed? ?out|time out/i.test(msg)) {
          const err = new Error('请求超时（服务端太久没返回），请稍后重试')
          err.statusCode = 0
          err.timeout = true
          reject(err)
          return
        }
        reject(new Error('无法连接服务' + (msg ? '：' + msg : '，请检查网络或服务地址')))
      },
    })
  })
}

const get = (path, query) => request(path, { method: 'GET', query })
const post = (path, data, options) =>
  request(path, Object.assign({ method: 'POST', data: data || {} }, options || {}))
const patch = (path, data) => request(path, { method: 'PATCH', data: data || {} })
const put = (path, data) => request(path, { method: 'PUT', data: data || {} })
const del = (path) => request(path, { method: 'DELETE' })

/* ---------------- 登录态 ---------------- */
function bootstrap() {
  return wxRequestRaw('/bootstrap').then((res) => {
    if (res.statusCode === 401) {
      const e = new Error('请先登录')
      e.unauthorized = true
      throw e
    }
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(errText(res))
    const data = res.data || {}
    setToken(data.local_token || '')
    setUser({
      username: data.username || data.app_name || 'PersonalHub',
      app_name: data.app_name || 'PersonalHub',
      version: data.version || '',
      database_path: data.database_path || '',
    })
    return data
  })
}

function login(username, password) {
  return authRequest('login', { username: username, password: password }).then(() =>
    bootstrap().then((data) => data),
  )
}

function register(username, password) {
  return authRequest('register', { username: username, password: password }).then(() => bootstrap())
}

function logout() {
  return new Promise((resolve) => {
    wx.request({
      url: base() + '/api/v1/public/logout',
      method: 'POST',
      header: { Cookie: COOKIE_NAME + '=' + getSession() },
      complete: () => {
        clearAuth()
        resolve()
      },
    })
  })
}

function wxRequestRaw(path) {
  return new Promise((resolve, reject) => {
    const header = { Accept: 'application/json' }
    const session = getSession()
    if (session) header.Cookie = COOKIE_NAME + '=' + session
    wx.request({
      url: base() + '/api/v1' + path,
      method: 'GET',
      header: header,
      timeout: 20000,
      success: (res) => {
        const cookie = pickCookie(res.header)
        if (cookie) setSession(cookie)
        resolve(res)
      },
      fail: () => reject(new Error('无法连接服务')),
    })
  })
}

function authRequest(kind, payload) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: base() + '/api/v1/public/' + kind,
      method: 'POST',
      header: { 'content-type': 'application/json', Accept: 'application/json' },
      data: payload,
      timeout: 20000,
      success: (res) => {
        const cookie = pickCookie(res.header)
        if (cookie) setSession(cookie)
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data || {})
          return
        }
        reject(new Error(errText(res)))
      },
      fail: (e) => {
        const msg = e && e.errMsg ? e.errMsg.replace(/^request:fail\s*/, '') : ''
        reject(new Error('连接失败' + (msg ? '：' + msg : '，请检查网络')))
      },
    })
  })
}

/* ---------------- 设置缓存 ---------------- */
function cachedSettings() {
  return wx.getStorageSync(KEYS.settings) || null
}

function saveSettings(s) {
  wx.setStorageSync(KEYS.settings, s || {})
}

/** 探测某个地址是否连得上：能收到任何 HTTP 响应就算通（401/404 也算通） */
function probe(url, timeout) {
  const target = normalizeBase(url)
  return new Promise((resolve) => {
    if (!target) {
      resolve({ ok: false, reason: '地址为空' })
      return
    }
    const started = Date.now()
    wx.request({
      url: target + '/api/v1/public/bootstrap',
      method: 'GET',
      header: { Accept: 'application/json' },
      timeout: timeout || 12000,
      success: (res) => {
        resolve({ ok: true, status: res.statusCode, ms: Date.now() - started, url: target })
      },
      fail: (e) => {
        const msg = e && e.errMsg ? e.errMsg.replace(/^request:fail\s*/, '') : '连接失败'
        resolve({ ok: false, reason: msg, url: target })
      },
    })
  })
}

module.exports = {
  request,
  get,
  post,
  patch,
  put,
  del,
  bootstrap,
  login,
  register,
  logout,
  isLoggedIn,
  getUser,
  getSession,
  getToken,
  clearAuth,
  cachedSettings,
  saveSettings,
  getBaseUrl,
  setBaseUrl,
  resetBaseUrl,
  isCustomBaseUrl,
  normalizeBase,
  probe,
  KEYS,
}
