// wechat-notifier.js — PersonalHub 本地伴生服务（配合小程序「计划到期微信提醒」）
//
// 职责：
//   1) /api/v1/wx/* 的请求留在本地处理：订阅登记（code2Session 换 openid）、状态查询
//   2) 其余请求原样转发到 PersonalHub 后端（重写 Host / 去 Origin，规避 TrustedHost 与跨站校验）
//   3) 每 10 分钟检查一次（8:00–22:00）：所有未完成计划
//      「今天/明天开始」和「今天/明天到期」都自动推送，多个计划合并成一条消息
//      没有任何「逐个任务打开提醒」的开关，授权一次即全量生效
//
// 配置：_tmpapi/wechat_conf.json  { "appid": "...", "secret": "...", "tmpl_id": "(可选)" }
// 状态：_tmpapi/wechat_subs.json  登记过的用户 openid + 剩余额度 quota
//       _tmpapi/wechat_state.json 推送去重（每个用户/每类事件/每个日期只发一次）
//
// 用法：node wechat-notifier.js   （默认监听 127.0.0.1:8771，隧道指向它）

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

const PORT = Number(process.env.PORT || 8771)
const TARGET = process.env.TARGET || 'http://127.0.0.1:8770'
const APPID = process.env.WX_APPID || '' // 未设置时从 wechat_conf.json 的 appid 读（loadConf 里已做兜底）
const DATA_DIR = path.join(__dirname, '..', '_tmpapi')
const CONF_FILE = path.join(DATA_DIR, 'wechat_conf.json')
const SUBS_FILE = path.join(DATA_DIR, 'wechat_subs.json')
const SESSION_COOKIE = 'personalhub_public_session'
const STATE_FILE = path.join(DATA_DIR, 'wechat_state.json')

const target = new URL(TARGET)
const backendAgent = new http.Agent({ keepAlive: true })
let accessToken = { v: '', exp: 0 }
let tmplCache = null

function log() {
  const t = new Date().toISOString().slice(5, 19).replace('T', ' ')
  console.log.apply(console, ['[' + t + ']'].concat([].slice.call(arguments)))
}
function readJson(p, d) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    return d
  }
}
function writeJson(p, v) {
  try {
    fs.writeFileSync(p, JSON.stringify(v, null, 1))
  } catch (e) {
    /* 写不进去就跳过 */
  }
}
function loadConf() {
  return readJson(CONF_FILE, {})
}
function mask(s) {
  s = String(s || '')
  return s.length > 8 ? s.slice(0, 4) + '****' + s.slice(-4) : s
}
function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
function daysLeft(dateStr) {
  const t = new Date(todayStr() + 'T00:00:00')
  const g = new Date(String(dateStr).slice(0, 10) + 'T00:00:00')
  return Math.round((g - t) / 86400000)
}

/* ---- 时间点辅助（按日程的开始/结束时间精确提醒） ---- */
const TASK_END_LEAD_MIN = 30 // 到期前 30 分钟发「快到期」
const TASK_START_GRACE_MIN = 60 // 开始提醒：到点后 60 分钟内仍补发（关机/断网错过的仍能收到）
const TASK_END_GRACE_MIN = 0 // 到期提醒：到结束时间就停，免得推无用的旧提醒

/** '9:0' / '09:00' / '09:00:00' → '09:00'；非法返回 '' */
function normHM(v) {
  const m = String(v == null ? '' : v).match(/^(\d{1,2}):(\d{1,2})/)
  if (!m) return ''
  const h = Math.min(23, Number(m[1]))
  const mi = Math.min(59, Number(m[2]))
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
}

/** 日期 + 时间 → 本地毫秒时间戳 */
function atMs(dateStr, hm) {
  const d = String(dateStr || '').slice(0, 10).split('-')
  if (d.length < 3) return 0
  const t = String(hm || '00:00').split(':')
  return new Date(Number(d[0]), Number(d[1]) - 1, Number(d[2]), Number(t[0]) || 0, Number(t[1]) || 0, 0, 0).getTime()
}

/**
 * 这条任务还剩多少分钟到期（用于「还剩 X 分钟」，别再写死 30）。
 * - 还没到发送点的（预览未来任务）按「结束 - 计划发送点」算，即提前量本身；
 * - 已经到点的按当前真实时间算，补发时不至于说谎。
 */
function remainMinutesOf(ev) {
  const endMs = atMs(ev.date, String(ev.endTime || '').slice(0, 5))
  if (!endMs) return 0
  const now = Date.now()
  const from = ev.fireAt && now < ev.fireAt ? Number(ev.fireAt) : now
  // 向上取整：发送发生在「结束前30分钟」这个点之后的 0~59 秒内，
  // round 会把 29分50秒 显示成 29（用户要求到期前30分钟就显示 30）
  return Math.max(0, Math.ceil((endMs - from) / 60000))
}

/**
 * 任务时长是否够发一次「快到期」。
 * 时长 ≤ 提前量(30 分钟) 时，「结束前 30 分钟」那个点还没开始甚至早于开始，
 * 提示毫无意义（例：13:52–14:10 的「上厕所」，一创建就弹「还剩 30 分钟」但实际上只剩 20 分钟）。
 */
function wantEndReminder(dateStr, sHM, eHM) {
  const dur = Math.round((atMs(dateStr, eHM) - atMs(dateStr, sHM)) / 60000)
  return dur > TASK_END_LEAD_MIN
}

/** 事件是否到点该发（计划类事件没有时间窗，随时可发；当日任务按开始/结束时间判断） */
function isDue(e, now) {
  if (e.kind !== 'task_start' && e.kind !== 'task_end') return true
  const f = Number(e.fireAt || 0)
  if (!f) return false
  if (e.kind === 'task_start') return now >= f && now <= f + TASK_START_GRACE_MIN * 60000
  return now >= f && now <= f + (TASK_END_LEAD_MIN + TASK_END_GRACE_MIN) * 60000
}
function httpGetJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = (u.protocol === 'https:' ? https : http).request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET' },
      (r) => {
        let buf = ''
        r.on('data', (c) => (buf += c))
        r.on('end', () => {
          try {
            resolve(JSON.parse(buf))
          } catch (e) {
            resolve({ raw: buf.slice(0, 200) })
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeout || 15000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}
function httpPostJson(url, body, headers, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(body || {})
    const req = (u.protocol === 'https:' ? https : http).request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, headers || {})
      },
      (r) => {
        let buf = ''
        r.on('data', (c) => (buf += c))
        r.on('end', () => {
          try {
            resolve({ status: r.statusCode, headers: r.headers, json: JSON.parse(buf) })
          } catch (e) {
            resolve({ status: r.statusCode, headers: r.headers, json: { raw: buf.slice(0, 400) } })
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeout || 20000, () => req.destroy(new Error('timeout')))
    req.write(data)
    req.end()
  })
}

/* ---------------- 微信接口 ---------------- */
async function getSession(code) {
  const conf = loadConf()
  if (!conf.secret) return { ok: false, reason: 'no_secret' }
  const r = await httpGetJson(
    'https://api.weixin.qq.com/sns/jscode2session?appid=' +
      (APPID || conf.appid) +
      '&secret=' +
      conf.secret +
      '&js_code=' +
      encodeURIComponent(code) +
      '&grant_type=authorization_code'
  )
  if (r && r.openid) return { ok: true, openid: r.openid }
  return { ok: false, reason: (r && (r.errmsg || r.errcode)) || 'unknown' }
}

async function getAccessToken() {
  const conf = loadConf()
  if (!conf.secret) throw new Error('未配置 AppSecret')
  if (accessToken.v && Date.now() < accessToken.exp) return accessToken.v
  const r = await httpGetJson(
    'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' +
    (APPID || conf.appid) +
    '&secret=' +
    conf.secret
  )
  if (!r || !r.access_token) throw new Error('拿 access_token 失败: ' + JSON.stringify(r).slice(0, 200))
  accessToken = { v: r.access_token, exp: Date.now() + ((r.expires_in || 7200) - 300) * 1000 }
  return accessToken.v
}

/** 「待办事项提醒」模板（tid 2983）的字段结构，接口拉不到时兜底 */
const FALLBACK_KEYWORDS = [
  { k: 'thing5', type: 'thing' },   // 日程标题
  { k: 'time6', type: 'time' },     // 开始时间
  { k: 'date9', type: 'date' },     // 到期时间
  { k: 'thing11', type: 'thing' }   // 备注
]

/**
 * 模板详情接口现在返回的是 content 字符串（"事项主题:{{thing1.DATA}}"），
 * 不再给 keywords 数组，这里把它解析成 [{k,type}]。
 */
function parseContent(content) {
  const out = []
  const re = /\{\{\s*([a-zA-Z_]+?)(\d+)\.DATA\s*\}\}/g
  const s = String(content || '')
  let m
  while ((m = re.exec(s))) out.push({ k: m[1] + m[2], type: m[1] })
  return out
}

/** 找一个可用的订阅模板（优先用配置里的 tmpl_id，否则取账号下第一个） */
async function getTemplate() {
  if (tmplCache) return tmplCache
  const conf = loadConf()
  if (conf.tmpl_id) {
    // 配置了模板 id：仍拉一次模板列表拿 keywords（组装 data 需要字段名和类型）
    try {
      const token = await getAccessToken()
      const r = await httpGetJson('https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate?access_token=' + token)
      if (r && r.errcode === 0 && r.data && r.data.length) {
        const hit = r.data.find((t) => t.priTmplId === conf.tmpl_id) || r.data[0]
        const kws = (hit.keywords && hit.keywords.length) ? hit.keywords : parseContent(hit.content)
        tmplCache = { id: hit.priTmplId, keywords: kws.length ? kws : FALLBACK_KEYWORDS }
        return tmplCache
      }
      log('模板列表为空，使用内置兜底字段结构')
    } catch (e) {
      log('拉取模板详情失败，使用内置兜底字段结构：', e.message)
    }
    tmplCache = { id: conf.tmpl_id, keywords: FALLBACK_KEYWORDS }
    return tmplCache
  }
  const token = await getAccessToken()
  const r = await httpGetJson('https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate?access_token=' + token)
  if (!r || r.errcode !== 0 || !r.data || !r.data.length) throw new Error('没有可用的订阅消息模板: ' + JSON.stringify(r).slice(0, 200))
  const t = r.data[0]
  const kws = (t.keywords && t.keywords.length) ? t.keywords : parseContent(t.content)
  tmplCache = { id: t.priTmplId, keywords: kws.length ? kws : FALLBACK_KEYWORDS }
  return tmplCache
}

/** 按关键字类型把值收拾成微信要求的格式 */
function coerce(type, v) {
  v = String(v == null ? '' : v)
  const t = String(type || '').toLowerCase()
  if (t.indexOf('short_thing') === 0) return v.slice(0, 5)
  if (t.indexOf('thing') === 0) return v.slice(0, 20)
  if (t.indexOf('phrase') === 0) return v.slice(0, 5)
  if (t.indexOf('character') === 0) return v.slice(0, 32)
  if (t.indexOf('number') === 0) return v.replace(/[^0-9.-]/g, '') || '0'
  return v
}

/** 日期 → 2026年11月14日 */
function fmtDateCN(d) {
  const s = String(d || '')
  if (s.length < 10) return ''
  return s.slice(0, 4) + '年' + s.slice(5, 7) + '月' + s.slice(8, 10) + '日'
}

/** 日期 → 11/14（short_thing 限 5 个字符，只能这么短） */
function fmtDateShort(d) {
  const s = String(d || '')
  if (s.length < 10) return '未设置'
  return s.slice(5, 7) + '/' + s.slice(8, 10)
}

/**
 * 组装一条消息的 data —— 一个项目一条独立通知（用户要求「每个项目有独立的通知」）。
 * ev: { kind:'start'|'end', goal, left, date, taskTitle? }
 *  - 事项主题 thing1        = 当天任务名（没有就用计划名），不再是「N个学习计划」
 *  - 截止时间 time10        = 计划的截止日期
 *  - 剩余时间 short_thing20 = 开始时间（这一栏改显示计划/任务的开始日，见用户要求）
 *  - 备注消息 thing12       = 今天开始/明天开始 + 所属计划、剩几天 + 完成度
 */
/**
 * 每个事件单独一条通知（用户 11-09 明确：不合并、不省额度，每个任务都要自己的通知）。
 * 保留函数名只为兼容旧引用，返回「一个事件一组」。
 */
function groupSameSlot(events) {
  return events.map((ev) => [ev])
}

function buildEventData(keywords, ev) {
  const g = ev.goal || {}

  // 事项主题
  const title = String(ev.taskTitle || g.name || '学习计划').slice(0, 20)

  // 截止时间：始终是计划真正的截止日
  const endRaw = String(g.target_date || ev.date || '')
  // 开始时间：优先用计划/任务自己的开始日，没有就写「未设置」（别用截止日冒充）
  const startRaw = String(g.start_date || '')
  const startHM = String(ev.startTime || '').slice(0, 5)
  const endHM = String(ev.endTime || '').slice(0, 5)
  const isTask = ev.kind === 'task_start' || ev.kind === 'task_end'
  const startFull = startRaw ? (startHM ? fmtDateCN(startRaw) + ' ' + startHM : fmtDateCN(startRaw)) : '未设置'
  // 当日任务：到期时间要带上具体时分（计划类没有时分，只写日期）
  const endFull = isTask && endHM ? fmtDateCN(endRaw) + ' ' + endHM : fmtDateCN(endRaw)

  // 备注消息：任务名当主题时，把计划名带上，免得看不出属于哪个计划
  let remark
  if (ev.kind === 'start') {
    remark = ev.left === 0 ? '今天开始' : '明天开始'
    if (ev.taskTitle && g.name && ev.taskTitle !== g.name) remark += '·' + g.name
  } else if (ev.kind === 'task_start') {
    remark = '今天 ' + startHM + ' 开始，记得去做'
  } else if (ev.kind === 'task_end') {
    const rm = remainMinutesOf(ev)
    remark = endHM + ' 到期' + (rm > 0 ? '，还剩 ' + rm + ' 分钟' : '，时间到了')
  } else {
    remark = (ev.left === 0 ? '今天到期' : '剩' + ev.left + '天') + '，完成' + (g.progress || 0) + '%'
  }

  const data = {}
  const alt = {}
  const cs = (t, v) => ({ value: coerce(t, v) })
  if (keywords && keywords.length) {
    let thingUsed = 0
    let timeUsed = 0
    keywords.forEach((k) => {
      const t = String(k.type || inferType(k.k || '')).toLowerCase()
      if (t.indexOf('short_thing') === 0) {
        data[k.k] = cs(t, fmtDateShort(startRaw))
        alt[k.k] = data[k.k]
      } else if (t.indexOf('thing') === 0) {
        data[k.k] = cs(t, thingUsed++ === 0 ? title : remark)
        alt[k.k] = data[k.k]
      } else if (t.indexOf('time') === 0) {
        // 模板里可能只有一个时间字段：有「开始时间」槽（多个 time/date）时先填开始，再填到期
        const isFirst = timeUsed++ === 0
        const v = isFirst && hasStartSlot(keywords) ? startFull : endFull
        data[k.k] = cs(t, v)
        alt[k.k] = cs(t, isFirst && hasStartSlot(keywords) ? startHM : endHM)
      } else if (t.indexOf('date') === 0) {
        data[k.k] = cs(t, endFull || endRaw)
        // 万一微信嫌「日期 时分」格式不对（47003），退回纯日期
        alt[k.k] = cs(t, fmtDateCN(endRaw) || endRaw)
      } else if (t.indexOf('character') === 0) {
        data[k.k] = cs(t, endRaw.replace(/-/g, '/'))
        alt[k.k] = data[k.k]
      } else if (t.indexOf('number') === 0) {
        data[k.k] = cs(t, String(ev.left))
        alt[k.k] = data[k.k]
      } else {
        data[k.k] = cs(t, remark)
        alt[k.k] = data[k.k]
      }
    })
  } else {
    data.thing5 = { value: coerce('thing', title) }
    data.time6 = { value: coerce('time', startFull) }
    data.date9 = { value: coerce('date', endFull || endRaw) }
    data.thing11 = { value: coerce('thing', remark) }
    alt.thing5 = data.thing5
    alt.time6 = { value: coerce('time', startHM || startFull) }
    alt.date9 = { value: coerce('date', fmtDateCN(endRaw) || endRaw) }
    alt.thing11 = data.thing11
  }
  return { title: title, start: startFull, end: endFull, remark: remark, data: data, alt: alt }
}

/** 模板里是否同时有「开始时间」和「到期时间」两个时间槽（time + date/time） */
function hasStartSlot(keywords) {
  const slots = (keywords || []).filter((k) => {
    const t = String(k.type || inferType(k.k || '')).toLowerCase()
    return t.indexOf('time') === 0 || t.indexOf('date') === 0
  })
  return slots.length >= 2
}

/** 从字段名猜类型（部分模板接口不返回 type） */
function inferType(key) {
  const k = String(key || '').toLowerCase()
  if (k.indexOf('short_thing') === 0) return 'short_thing'
  if (k.indexOf('thing') === 0) return 'thing'
  if (k.indexOf('time') === 0) return 'time'
  if (k.indexOf('date') === 0) return 'date'
  if (k.indexOf('character') === 0) return 'character_string'
  if (k.indexOf('number') === 0) return 'number'
  if (k.indexOf('phrase') === 0) return 'phrase'
  return 'thing'
}

/* ---------------- 后端取数 ---------------- */
// 登录 cookie 持久化缓存：每 10 分钟重新登一次会被后端限流（429 Too Many Requests）。
// 只要 cookie 还在，就一路复用；只有后端回 401/403 才真的重登一次。
//
// 多账号：每个微信用户对应「他在小程序里正在用的那个账号」。客户端登记订阅时会把
// 当前会话（ph_session）一起上报，notifier 就用它取该用户自己的计划/任务；
// 没上报过会话才退回 conf 里的默认账号（否则会推成别人的数据）。
const COOKIE_FILE = path.join(DATA_DIR, 'backend_cookie.json')
let cookieCache = readJson(COOKIE_FILE, { v: '', exp: 0 })
let loginBlockedUntil = 0

function subsUsers() {
  const s = readJson(SUBS_FILE, { users: [] })
  return (s && s.users) || []
}

/** 该 openid 上报过的小程序会话（没有就返回空） */
function sessionOf(openid) {
  if (!openid) return ''
  const u = subsUsers().find((x) => x.openid === openid)
  return (u && u.session) || ''
}

/** 会话失效了就丢掉，避免一直用坏 cookie */
function dropSession(openid) {
  if (!openid) return
  const s = readJson(SUBS_FILE, { users: [] })
  const u = (s.users || []).find((x) => x.openid === openid)
  if (u && u.session) {
    u.session = ''
    writeJson(SUBS_FILE, s)
    log('用户会话已失效 →', mask(openid), '改用默认账号取数')
  }
}

async function backendLoginCookie(force) {
  // 优先用 conf 里写死的本地会话（免密，绕开 /public/login 的 IP 限流，且能指定任意账号）
  const conf0 = loadConf()
  if (conf0.session) return conf0.session
  if (!force && cookieCache.v) return cookieCache.v
  if (Date.now() < loginBlockedUntil) throw new Error('后端登录被限流，稍后自动重试')
  const conf = loadConf()
  // 账号密码只从 _tmpapi/wechat_conf.json 读，代码里不留默认值（否则打包外传等于泄露）
  if (!conf.username || !conf.password) {
    throw new Error('wechat_conf.json 缺 username/password，无法自动登录（也可直接用 session）')
  }
  const r = await httpPostJson(TARGET + '/api/v1/public/login', {
    username: conf.username,
    password: conf.password
  })
  if (r.status === 429) {
    loginBlockedUntil = Date.now() + 10 * 60000
    throw new Error('后端登录被限流(429)，10 分钟后再试')
  }
  const setc = (r.headers && (r.headers['set-cookie'] || r.headers['Set-Cookie'])) || []
  if (!setc.length) throw new Error('后端登录失败 status=' + r.status + ' ' + JSON.stringify(r.json).slice(0, 120))
  cookieCache = { v: setc.map((c) => c.split(';')[0]).join('; '), exp: Date.now() + 7 * 86400000 }
  writeJson(COOKIE_FILE, cookieCache)
  return cookieCache.v
}

/** 拿某人的 cookie：优先他自己上报的小程序会话，其次 conf 里的默认账号 */
async function cookieFor(openid, force) {
  if (!force) {
    const s = sessionOf(openid)
    if (s) return s
  }
  return backendLoginCookie(force)
}

/** 会话归一：客户端 `api.getSession()` 给的是裸 token，补上前缀才能当 Cookie 用 */
function normSession(s) {
  const v = String(s || '').trim()
  if (!v) return ''
  return v.indexOf(SESSION_COOKIE + '=') === 0 ? v : SESSION_COOKIE + '=' + v
}

/** 用一个会话探一下它是哪个账号；无效返回空字符串 */
async function usernameOfSession(session) {
  const cookie = normSession(session)
  if (!cookie) return ''
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: target.hostname, port: target.port, path: '/api/v1/public/me', method: 'GET', headers: { Cookie: cookie } },
        (res) => {
          let buf = ''
          res.on('data', (c) => (buf += c))
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, json: JSON.parse(buf) })
            } catch (e) {
              resolve({ status: res.statusCode, json: null })
            }
          })
        }
      )
      req.on('error', reject)
      req.setTimeout(10000, () => req.destroy(new Error('timeout')))
      req.end()
    })
    if (r.status === 200 && r.json && r.json.username) return String(r.json.username)
    return ''
  } catch (e) {
    return ''
  }
}

/** 带登录 cookie 的 GET（cookie 失效会自动重登一次） */
async function backendGetJson(pathAndQuery, opts) {
  opts = typeof opts === 'string' ? { retry: opts } : opts || {}
  const openid = opts.openid || ''
  const retry = opts.retry
  const cookie = await cookieFor(openid, retry === 'force')
  const u = new URL(TARGET + pathAndQuery)
  const r = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), method: 'GET', headers: { Cookie: cookie } },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf) })
          } catch (e) {
            resolve({ status: res.statusCode, json: null })
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('timeout')))
    req.end()
  })
  const notLogin =
    r.status === 401 || r.status === 403 || (r.json && typeof r.json.detail === 'string' && r.json.detail.indexOf('请先登录') >= 0)
  if (notLogin && retry !== 'force') {
    if (openid) {
      // 指定了用户：会话过期就丢掉并放弃本次取数。绝不能回退默认账号——那会把别人的数据推给他
      if (sessionOf(openid)) dropSession(openid)
      return r
    }
    // 无 openid 的系统级调用才允许用默认账号重试
    cookieCache = { v: '', exp: 0 }
    writeJson(COOKIE_FILE, cookieCache)
    return backendGetJson(pathAndQuery, { retry: 'force' })
  }
  return r
}

async function fetchGoals(openid) {
  const r = await backendGetJson('/api/v1/learning/goals', { openid: openid })
  const arr = Array.isArray(r.json) ? r.json : []
  return arr.filter((g) => !g.deleted_at && !g.archived_at)
}

/**
 * 「项目」的显示名：优先用这一天排到的具体任务名（更具体，比如「理解数字信号处理的基本概念」），
 * 没有任务时退回计划名。任务按天排在 agenda 里，所以需要查目标详情 + 当天 agenda。
 */
let goalTaskCache = { at: 0, byGoal: {} }
let agendaCache = { at: 0, byDate: {} }

async function goalTasks(goalId, openid) {
  const now = Date.now()
  if (now - goalTaskCache.at > 10 * 60000) goalTaskCache = { at: now, byGoal: {} }
  const ck = (openid || '') + '|' + goalId
  if (goalTaskCache.byGoal[ck]) return goalTaskCache.byGoal[ck]
  try {
    const r = await backendGetJson('/api/v1/learning/goals/' + encodeURIComponent(goalId), { openid: openid })
    const d = r.json || {}
    goalTaskCache.byGoal[ck] = (d.tasks || []).map((t) => ({ id: t.id, title: t.title, status: t.status }))
  } catch (e) {
    goalTaskCache.byGoal[ck] = []
  }
  return goalTaskCache.byGoal[ck]
}

async function agendaOf(dateStr, openid) {
  const now = Date.now()
  if (now - agendaCache.at > 5 * 60000) agendaCache = { at: now, byDate: {} }
  const key = (openid || '') + '|' + dateStr
  if (agendaCache.byDate[key]) return agendaCache.byDate[key]
  let list = []
  try {
    const r = await backendGetJson('/api/v1/agenda?date=' + encodeURIComponent(dateStr), { openid: openid })
    list = Array.isArray(r.json) ? r.json : []
  } catch (e) {
    list = []
  }
  agendaCache.byDate[key] = list
  return list
}

/** 用户设置里的「默认工作开始/结束」（日程没填时间时用它）
 *  缓存只留 60 秒：用户在「数据与设置」里改完时间，下一轮扫描（≤10 分钟，通常就是下一轮）立刻按新时间算 */
let settingsCache = { at: 0, byUser: {} }
async function settingsOf(openid) {
  const now = Date.now()
  if (now - settingsCache.at > 60 * 1000) settingsCache = { at: now, byUser: {} }
  const k = openid || ''
  if (settingsCache.byUser[k]) return settingsCache.byUser[k]
  let s = {}
  try {
    const r = await backendGetJson('/api/v1/settings', { openid: openid })
    s = r.json || {}
  } catch (e) {
    s = {}
  }
  const out = {
    work_start: normHM(s.default_work_start) || '09:00',
    work_end: normHM(s.default_work_end) || '18:00'
  }
  settingsCache.byUser[k] = out
  return out
}

/** 给事件补上「当天具体的任务名」，pushOnce / events 接口都会用 */async function attachTaskTitles(events, openid) {
  const dates = {}
  events.forEach((e) => (dates[e.date] = 1))
  const agendaByDate = {}
  for (const d of Object.keys(dates)) agendaByDate[d] = await agendaOf(d, openid)
  for (const e of events) {
    const tasks = await goalTasks(e.goal.id, openid)
    const ids = {}
    tasks.forEach((t) => (ids[t.id] = t))
    const hit = (agendaByDate[e.date] || []).filter(
      (it) => ids[it.source_id] && it.status !== 'completed' && it.status !== 'cancelled'
    )
    if (hit.length) e.taskTitle = hit[0].title
  }
  return events
}

/* 提醒规则：
 *   开始前/当天 —— 「今天开始」「明天开始」
 *   到期前/当天 —— 「今天到期」「剩1天」
 * 所有未完成的计划都自动纳入，没有任何「逐个打开」的开关。
 */
const START_LEAD_DAYS = 1
const END_LEAD_DAYS = 1

function dueEvents(goals) {
  const byGoal = {}
  goals.forEach((g) => {
    if ((g.progress || 0) >= 100) return
    const push = (kind, date) => {
      const left = daysLeft(date)
      if (left < 0 || left > (kind === 'start' ? START_LEAD_DAYS : END_LEAD_DAYS)) return
      const cur = byGoal[g.id]
      // 同一天既开始又到期（一天期的计划）：只发「到期」，别发两条浪费额度
      if (cur && cur.kind === 'end' && kind === 'start') return
      byGoal[g.id] = { kind: kind, goal: g, left: left, date: date }
    }
    if (g.start_date) push('start', g.start_date)
    if (g.target_date) push('end', g.target_date)
  })
  return Object.keys(byGoal)
    .map((k) => byGoal[k])
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/** 去重键里带上日期和时间槽：计划改了日期 / 任务改了时间点就会重新提醒一次 */
function sentKey(openid, e) {
  return openid + '|' + e.kind + '|' + e.goal.id + '|' + e.date + (e.slot ? '|' + e.slot : '')
}

/**
 * 今日排期任务：今天每个未完成的日程项，按「开始时间」和「结束前 30 分钟」各发一条。
 *  - 有 start_time / end_time 就用它；
 *  - 没填时间就用「数据与设置」里的默认工作开始/结束（默认 09:00 / 18:00）。
 * 产生的两类事件：task_start（到点开始）/ task_end（结束前 30 分钟快到期）
 */
async function todayTaskEvents(goals, openid) {
  const today = todayStr()
  const items = await agendaOf(today, openid)
  const pend = items.filter(
    (it) => it.plan_date === today && it.status !== 'completed' && it.status !== 'cancelled'
  )
  if (!pend.length) return []
  const st = await settingsOf(openid)
  // 建 taskId→所属计划 的映射，用于去重（该计划今天已有「开始」提醒时不再重复）
  const owner = {}
  for (const g of goals) {
    const ts = await goalTasks(g.id, openid)
    ts.forEach((t) => (owner[t.id] = g))
  }
  const out = []
  for (const it of pend) {
    const sHM = normHM(it.start_time) || st.work_start
    const eHM = normHM(it.end_time) || st.work_end
    // 任务时长不够一个提前量（≤30 分钟）时，不必再发「快到期」：那时才刚开始，纯属打扰
    const wantEnd = wantEndReminder(today, sHM, eHM)
    const og = owner[it.source_id]
    const base = {
      goal: {
        id: 'ag_' + it.id,
        name: it.title,
        start_date: it.plan_date,
        target_date: it.plan_date,
        progress: 0
      },
      left: 0,
      date: it.plan_date,
      taskTitle: it.title,
      startTime: sHM,
      endTime: eHM,
      ownerId: og ? og.id : ''
    }
    out.push(Object.assign({}, base, { kind: 'task_start', slot: 's' + sHM, fireAt: atMs(today, sHM) }))
    if (wantEnd) {
      out.push(
        Object.assign({}, base, {
          kind: 'task_end',
          slot: 'e' + eHM,
          fireAt: atMs(today, eHM) - TASK_END_LEAD_MIN * 60000
        })
      )
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt)
}

/** 计划事件 + 今日任务事件 合并：今日任务已覆盖的「计划今天开始」提醒去掉，避免重复打扰 */
async function allEvents(goals, openid) {
  const goalEv = await attachTaskTitles(dueEvents(goals), openid)
  const taskEv = await todayTaskEvents(goals, openid)
  const startedToday = {}
  taskEv.forEach((e) => {
    if (e.ownerId) startedToday[e.ownerId + '|' + e.date] = 1
  })
  const filtered = goalEv.filter((e) => !(e.kind === 'start' && startedToday[e.goal.id + '|' + e.date]))
  return filtered.concat(taskEv).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

function loadState() {
  const s = readJson(STATE_FILE, {})
  // 老格式是扁平的 openid|日期 → 直接丢掉，改用 sent 子对象
  if (!s || typeof s !== 'object' || !s.sent) return { sent: {} }
  return s
}

/* ---------------- 推送调度 ---------------- */
// 一个计划一条独立通知：每轮每个用户最多发这么多条，避免一次刷屏、也免得把额度一口气打光
const MAX_MSGS_PER_TICK = 6

async function pushOnce(opts) {
  opts = opts || {}
  const dry = !!opts.dry
  const force = !!opts.force
  const limit = Number(opts.limit || 0) || MAX_MSGS_PER_TICK
  const conf = loadConf()
  if (!conf.secret) {
    log('跳过推送：还没配置 AppSecret（', CONF_FILE, '）')
    return { error: 'no_secret' }
  }
  const subs = readJson(SUBS_FILE, { users: [] })
  // 日志/预览用第一个登记用户的账号数据；实际推送时每人再各取一次自己的
  const previewOpenid = (subs.users && subs.users[0] && subs.users[0].openid) || ''
  const goals = await fetchGoals(previewOpenid)
  const events = await allEvents(goals, previewOpenid)
  const out = {
    dry: dry,
    events: events.map((e) => ({
      kind: e.kind,
      name: e.goal.name,
      task: e.taskTitle || '',
      date: e.date,
      at: e.fireAt ? new Date(e.fireAt).toTimeString().slice(0, 5) : '',
      start: e.startTime || '',
      end: e.endTime || '',
      left: e.left,
      progress: e.goal.progress || 0
    })),
    users: []
  }
  log('本轮事件', events.length, '条：', events.map((e) => e.kind + ':' + (e.goal.name || '') + '(' + e.left + ')').join(', ') || '无')
  if (!subs.users || !subs.users.length) return out
  if (!events.length) return out

  const state = loadState()
  const tmpl = await getTemplate()
  const token = dry ? '' : await getAccessToken()
  let sent = 0
  for (const user of subs.users) {
    // 没绑定自己会话的人一律不发：否则会回退到默认账号取数，把别人的提醒推到他微信上
    if (!sessionOf(user.openid)) {
      log('跳过推送 →', mask(user.openid), '：未绑定账号会话（用新版小程序登录自己的账号后自动绑定）')
      out.users.push({ openid: mask(user.openid), skipped: 'no_session' })
      continue
    }
    // 每个用户按他自己在小程序里登录的账号取数据（没上报会话就是默认账号）
    let uEvents = events
    if (user.openid !== previewOpenid) {
      try {
        uEvents = await allEvents(await fetchGoals(user.openid), user.openid)
      } catch (e) {
        log('取该用户数据失败 →', mask(user.openid), e.message)
        uEvents = []
      }
    }
    // 只发「已到点」的：计划事件随时可发，当日任务要等开始时间到 / 结束前 30 分钟
    const nowMs = Date.now()
    // 越紧急越先发：今天 > 明天；同一天里「到期」比「开始」优先
    const mine = uEvents
      .filter((e) => force || dry || isDue(e, nowMs))
      // dry 模式不看去重（方便预览当天所有提醒长什么样）
      .filter((e) => force || dry || !state.sent[sentKey(user.openid, e)])
      .sort((a, b) => {
        const fa = Number(a.fireAt || 0)
        const fb = Number(b.fireAt || 0)
        if (fa && fb && fa !== fb) return fa - fb
        if (a.left !== b.left) return a.left - b.left
        if (a.kind === b.kind) return 0
        const rank = { end: 0, task_end: 1, task_start: 2, start: 3 }
        return (rank[a.kind] || 3) - (rank[b.kind] || 3)
      })
    if (!mine.length) {
      out.users.push({ openid: mask(user.openid), skipped: 'no_new_event' })
      continue
    }
    // 每个事件一条独立通知，按事件数限制本轮最多发 limit 条
    const groups = groupSameSlot(mine).slice(0, limit)
    const groupEvents = groups.reduce((n, g) => n + g.length, 0)
    let quota = Number(user.quota || 0)
    if (quota <= 0) {
      // 额度用完：保留登记，等小程序下次打开时静默补订
      out.users.push({ openid: mask(user.openid), skipped: 'no_quota', pending: groupEvents })
      continue
    }
    const sentList = []
    for (const grp of groups) {
      if (quota <= 0) break
      const ev = grp[0]
      const built = buildEventData(tmpl.keywords, ev)
      if (dry) {
        sentList.push({ kind: ev.kind, goal: ev.goal.name, title: built.title, start: built.start, end: built.end, remark: built.remark, data: built.data })
        continue
      }
      const body = {
        touser: user.openid,
        template_id: tmpl.id,
        page: 'pages/learning/index',
        data: built.data
      }
      let r = await httpPostJson('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token, body)
      let code = r.json && r.json.errcode
      // 47003/47001：日期时分格式被拒 → 退回「纯日期 + 纯时间」再试一次
      if (code === 47003 || code === 47001) {
        log('模板字段格式被拒', code, '→ 用简化格式重试')
        r = await httpPostJson('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token,
          Object.assign({}, body, { data: built.alt }))
        code = r.json && r.json.errcode
      }
      if (code === 0) {
        quota -= 1
        user.quota = quota
        state.sent[sentKey(user.openid, ev)] = Date.now()
        sent++
        sentList.push({
          kind: ev.kind,
          goal: ev.goal.name,
          title: built.title,
          start: built.start,
          end: built.end,
          remark: built.remark,
          ok: true
        })
        log('已推送 →', mask(user.openid), '「' + built.title + '」', ev.kind, '剩余额度', quota)
      } else if (code === 43101) {
        // 微信侧没额度了（用户拒绝 / 一次性订阅已耗尽）：清零额度，等他下次打开补订
        user.quota = 0
        quota = 0
        log('微信侧无订阅额度(43101) →', mask(user.openid), '等待客户端补订')
        break
      } else {
        log('推送失败', code, JSON.stringify(r.json).slice(0, 200))
        sentList.push({ kind: ev.kind, goal: ev.goal.name, error: code, detail: r.json })
        break
      }
    }
    out.users.push({
      openid: mask(user.openid),
      sent: dry ? sentList.length : sentList.filter((x) => x.ok).length,
      quota_left: quota,
      messages: sentList
    })
  }
  if (!dry) {
    // state 只保留 120 天，避免无限膨胀
    const cutoff = Date.now() - 120 * 86400000
    Object.keys(state.sent).forEach((k) => {
      if (state.sent[k] < cutoff) delete state.sent[k]
    })
    writeJson(SUBS_FILE, subs)
    writeJson(STATE_FILE, state)
  }
  log('本轮推送完成：', sent, '条')
  return out
}

/* ---------------- 本地路由 ---------------- */
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => (buf += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'))
      } catch (e) {
        resolve({})
      }
    })
  })
}

async function handleLocal(req, res, pathname) {
  if (pathname === '/api/v1/wx/subs/register' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.code) return sendJson(res, 400, { detail: '缺少 code' })
    const s = await getSession(body.code)
    if (!s.ok) {
      if (s.reason === 'no_secret') return sendJson(res, 503, { detail: '推送服务还没配置 AppSecret，请先在本机 _tmpapi/wechat_conf.json 里填好' })
      return sendJson(res, 400, { detail: '换取 openid 失败: ' + s.reason })
    }
    const subs = readJson(SUBS_FILE, { users: [] })
    const accepts = Math.max(1, Math.min(20, Number(body.accepts) || 1))
    // 客户端会把当前登录会话一起带上来：推送时用它取该用户自己的计划，
    // 否则 everyone 都会被推成 conf 里那个默认账号的数据。
    const session = normSession(body.session)
    let who = ''
    if (session) who = await usernameOfSession(session)
    const hit = subs.users.find((u) => u.openid === s.openid)
    if (hit) {
      hit.quota = Number(hit.quota || 0) + accepts
      if (session && who) {
        hit.session = session
        hit.username = who
        hit.session_at = new Date().toISOString()
      }
    } else {
      subs.users.push({
        openid: s.openid,
        quota: accepts,
        subscribed_at: new Date().toISOString(),
        session: session && who ? session : '',
        username: who || ''
      })
    }
    writeJson(SUBS_FILE, subs)
    // 会话变了，取数缓存要清掉
    goalTaskCache = { at: 0, byGoal: {} }
    agendaCache = { at: 0, byDate: {} }
    log('登记订阅 →', mask(s.openid), '额度 +' + accepts, who ? '账号 ' + who : '（未带上账号会话）')
    return sendJson(res, 200, { ok: true, quota: hit ? hit.quota : accepts, username: who })
  }
  if (pathname === '/api/v1/wx/subs/session' && req.method === 'POST') {
    // 只同步「这个微信用户当前在用哪个账号」，不动额度
    const body = await readBody(req)
    if (!body.code) return sendJson(res, 400, { detail: '缺少 code' })
    const s = await getSession(body.code)
    if (!s.ok) return sendJson(res, 400, { detail: '换取 openid 失败: ' + s.reason })
    const session = normSession(body.session)
    if (!session) return sendJson(res, 400, { detail: '缺少 session' })
    const who = await usernameOfSession(session)
    if (!who) return sendJson(res, 400, { detail: '会话无效或已过期' })
    const subs = readJson(SUBS_FILE, { users: [] })
    const hit = subs.users.find((u) => u.openid === s.openid)
    if (hit) {
      hit.session = session
      hit.username = who
      hit.session_at = new Date().toISOString()
    } else {
      subs.users.push({ openid: s.openid, quota: 0, subscribed_at: new Date().toISOString(), session: session, username: who })
    }
    writeJson(SUBS_FILE, subs)
    goalTaskCache = { at: 0, byGoal: {} }
    agendaCache = { at: 0, byDate: {} }
    log('同步账号会话 →', mask(s.openid), who)
    return sendJson(res, 200, { ok: true, username: who })
  }
  if (pathname === '/api/v1/wx/subs/status' && req.method === 'GET') {
    const conf = loadConf()
    const subs = readJson(SUBS_FILE, { users: [] })
    // 按请求者身份返回个人额度。身份来源优先级：
    //   1) ?code= —— wx.login 的 code 换 openid，最权威（客户端会话可能失效/是裸 token）
    //   2) 请求 cookie 里的 PersonalHub 会话 → 匹配 subs 里绑定的用户
    // 之前这里返回所有人额度的总和，用户看到「还有 6/17 条」其实自己一分不剩（11-09 投诉）
    const query = new URL(req.url, 'http://127.0.0.1').searchParams
    let me = null
    const code = query.get('code') || ''
    if (code) {
      try {
        const s = await getSession(code)
        if (s.ok) me = (subs.users || []).find((u) => u.openid === s.openid) || null
      } catch (e) {
        /* code 失效就退回用会话匹配 */
      }
    }
    if (!me) {
      const rawCookie = String((req.headers && (req.headers.cookie || req.headers.Cookie)) || '')
      const sm = rawCookie.match(new RegExp(SESSION_COOKIE + '=([^;\\s]+)'))
      if (sm) me = (subs.users || []).find((u) => normSession(u.session).indexOf(sm[1]) !== -1) || null
    }
    const myQuota = me ? Number(me.quota || 0) : null
    const quota = (subs.users || []).reduce((n, u) => n + Number(u.quota || 0), 0)
    let tmpl_id = conf.tmpl_id || ''
    if (!tmpl_id && conf.secret) {
      try {
        tmpl_id = (await getTemplate()).id
      } catch (e) {
        /* 拿不到模板就返回空，前端会提示 */
      }
    }
    return sendJson(res, 200, {
      registered: subs.users.length,
      // quota 直接给「这个人自己的额度」：0.9.15 及更旧的客户端只认这个字段，
      // 若这里sum总和，旧版界面就会显示所有人的总和（11-09 用户看到「还可收 17 条」）
      quota: myQuota != null ? myQuota : 0,
      my_quota: myQuota,
      total_quota: quota,
      my_username: me ? me.username || '' : '',
      has_secret: !!conf.secret,
      tmpl_id: tmpl_id,
      conf_file: CONF_FILE,
      accounts: (subs.users || []).map((u) => ({
        openid: mask(u.openid),
        username: u.username || '',
        has_session: !!u.session,
        quota: Number(u.quota || 0)
      }))
    })
  }
  if (pathname === '/api/v1/wx/events' && req.method === 'GET') {
    try {
      // ?openid= 指定看谁的；不带就看第一个登记用户（即推送时真正在用的那份数据）
      const q = new URL(req.url, 'http://127.0.0.1').searchParams
      const askOpenid = q.get('openid') || ''
      const users = subsUsers()
      const openid = askOpenid || (users[0] && users[0].openid) || ''
      const goals = await fetchGoals(openid)
      const events = await allEvents(goals, openid)
      return sendJson(res, 200, {
        account: openid ? (users.find((u) => u.openid === openid) || {}).username || '(默认账号)' : '(默认账号)',
        goals: goals.length,
        events: events.map((e) => ({
          kind: e.kind,
          name: e.goal.name,
          task: e.taskTitle || '',
          date: e.date,
          at: e.fireAt ? new Date(e.fireAt).toTimeString().slice(0, 5) : '',
          start: e.startTime || '',
          end: e.endTime || '',
          due: isDue(e, Date.now()),
          left: e.left,
          progress: e.goal.progress || 0
        }))
      })
    } catch (e) {
      return sendJson(res, 500, { detail: String(e.message || e) })
    }
  }
  return sendJson(res, 404, { detail: 'not found' })
}

/* ---------------- 服务器 ---------------- */
const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0]
  // 本机 netstat 偶发漏行，取 PID 时用这个更可靠
  if (pathname === '/__pid') return sendJson(res, 200, { pid: process.pid, uptime: process.uptime() })
  if (pathname.indexOf('/api/v1/wx/') === 0) {
    handleLocal(req, res, pathname).catch((e) => sendJson(res, 500, { detail: String(e.message || e) }))
    return
  }
  // 其余 → 转发后端
  const headers = Object.assign({}, req.headers)
  delete headers.origin
  delete headers.referer
  delete headers.host
  // 后端的跨站保护会拦 Sec-Fetch-Site: cross-site（微信/浏览器都会带），转发前必须清掉
  delete headers['sec-fetch-site']
  delete headers['sec-fetch-mode']
  delete headers['sec-fetch-dest']
  delete headers['sec-fetch-user']
  headers.host = target.host
  const up = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: req.url,
      method: req.method,
      headers: headers,
      agent: backendAgent
    },
    (r) => {
      // 后端 4xx/5xx 记一笔：小程序里弹的「Internal Server Error」就是这里的 detail
      if (r.statusCode >= 400) {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => {
          const buf = Buffer.concat(chunks)
          log('后端返回', r.statusCode, req.method, req.url, buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 300))
          res.writeHead(r.statusCode, r.headers)
          res.end(buf)
        })
        return
      }
      res.writeHead(r.statusCode, r.headers)
      r.pipe(res)
    }
  )
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'proxy error: ' + e.message }))
  })
  req.pipe(up)
})

// 直接运行才起服务/定时器；被 require（离线单测）时只导出函数
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    log('notifier ' + PORT + ' → ' + TARGET + '（/api/v1/wx/* 本地处理，其余转发）')
    const conf = loadConf()
    log('AppSecret:', conf.secret ? '已配置' : '未配置（推送暂不可用）', '| 模板:', conf.tmpl_id || '自动取第一个')
  })

  // 每 10 分钟检查一轮；只在 8:00–22:00 推送（别半夜吵人）；启动 40 秒后先跑一轮
  function inQuietHours() {
    const h = new Date().getHours()
    return h < 8 || h >= 22
  }
  function tick() {
    if (inQuietHours()) return
    pushOnce().catch((e) => log('推送出错:', e.message))
  }
  setTimeout(tick, 40 * 1000)
  // 每分钟轮询一次：到点的提醒最多延迟 1 分钟弹出（去重键保证不重复发）
  setInterval(tick, 60 * 1000)
}

// 供离线单测调用（verify33.js 用），不影响常驻服务
module.exports = {
  pushOnce,
  buildEventData,
  fmtDateCN,
  fmtDateShort,
  dueEvents,
  coerce,
  normHM,
  atMs,
  isDue,
  remainMinutesOf,
  wantEndReminder,
  groupSameSlot,
  TASK_END_LEAD_MIN,
  TASK_START_GRACE_MIN,
  TASK_END_GRACE_MIN
}
