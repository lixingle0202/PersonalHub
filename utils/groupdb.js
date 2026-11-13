/**
 * 监督群数据层（微信云开发）
 *
 * 读写全部走云函数 phgroup（管理员身份执行），因此：
 *   - 不需要在控制台给 4 个集合逐个设权限；
 *   - 集合由 setup() 自动创建；
 *   - 「催办文案白名单」「不能写别人的记录」这类规则由服务端把关，客户端绕不过。
 *
 * 设计约束（个人主体、不走社交类目）：
 *   - 不提供自由聊天，群里只同步「完成了几项、学习多久、喝多少水」这类数字；
 *   - 催办只能发一句短句（40 字内），服务端截断，不能发图片、不能连续刷屏；
 *   - 计划只同步标题与完成状态，不含评论、图片。
 */
const cloud = require('./cloud')

const NAME_KEY = 'ph_group_name'
const READ_KEY = 'ph_group_read'
const NUDGE_KEY = 'ph_nudge_texts'

/** 看板数据缓存时长：群页会连着调 5 个读取方法，合并成 1 次云端请求 */
const BOARD_TTL = 4000

/** 集合名（服务端建表用，页面不需要关心） */
const C = {
  groups: 'ph_groups',
  members: 'ph_group_members',
  checks: 'ph_group_checks',
  nudges: 'ph_group_nudges'
}

/** 催办默认句式；用户可以在群页自己增删改，存本机 */
const NUDGE_TEXTS = [
  '今天的计划还没完成，加把劲',
  '别忘了打卡，我盯着你呢',
  '今天的学习目标还差一点',
  '喝水和记录别忘了',
  '一起把今天的事做完吧'
]

/** 常用催办最多存几句 / 每句最多几个字 */
const NUDGE_LIMIT = 12
const NUDGE_MAX = 40

let memo = null

function ready() {
  return cloud.status() === 'ok'
}

/* ---------------- 我的昵称 ---------------- */
function myName() {
  return wx.getStorageSync(NAME_KEY) || ''
}

function setMyName(name) {
  const v = String(name || '').trim().slice(0, 12)
  if (v) wx.setStorageSync(NAME_KEY, v)
  return v
}

/* ---------------- 已读催办（存本地） ---------------- */
function readIds() {
  const v = wx.getStorageSync(READ_KEY)
  return Array.isArray(v) ? v : []
}

function markRead(ids) {
  const merged = readIds().concat(ids || [])
  const uniq = []
  for (let i = 0; i < merged.length; i++) {
    if (merged[i] && uniq.indexOf(merged[i]) === -1) uniq.push(merged[i])
  }
  wx.setStorageSync(READ_KEY, uniq.slice(-60))
}

/* ---------------- 建表 ---------------- */
/** 创建 4 个集合（幂等），返回 {created, existed} */
function setup() {
  return cloud.setup()
}

/* ---------------- 看板（一次取全） ---------------- */
function normalizeError(e) {
  const msg = String((e && e.message) || '')
  if (msg === 'not_member' || msg === 'not_member:') return new Error('你不在这个群里了，请重新输入邀请码加入')
  return new Error(msg || '读取群数据失败')
}

function board(groupId, force) {
  const id = String(groupId || '')
  if (!id) return Promise.reject(new Error('缺少群信息'))
  const now = Date.now()
  if (!force && memo && memo.id === id && now - memo.at < BOARD_TTL) return memo.p

  const p = cloud
    .invoke({ action: 'board', groupId: id, myName: myName() })
    .then((d) => {
      const r = d || {}
      return {
        today: r.today || '',
        myName: r.myName || '',
        subscribeTemplate: r.subscribeTemplate || '',
        group: r.group || null,
        members: Array.isArray(r.members) ? r.members : [],
        checks: Array.isArray(r.checks) ? r.checks : [],
        nudges: Array.isArray(r.nudges) ? r.nudges : [],
        nudged: Array.isArray(r.nudged) ? r.nudged : []
      }
    })
    .catch((e) => {
      if (memo && memo.p === p) memo = null
      throw normalizeError(e)
    })

  memo = { id: id, at: now, p: p }
  return p
}

function invalidate() {
  memo = null
}

/* ---------------- 群 ---------------- */
function createGroup(name) {
  const title = String(name || '').trim().slice(0, 16)
  if (!title) return Promise.reject(new Error('请给群起个名字'))
  return cloud.invoke({ action: 'create', name: title, myName: myName() || '我' }).then((d) => {
    invalidate()
    return d
  })
}

function joinGroup(input) {
  const raw = String(input || '').trim()
  if (!raw) return Promise.reject(new Error('请输入 6 位邀请码'))
  const byCode = raw.length <= 10
  return cloud
    .invoke(
      byCode
        ? { action: 'join', code: raw.toUpperCase(), myName: myName() || '我' }
        : { action: 'join', groupId: raw, myName: myName() || '我' }
    )
    .then((d) => {
      invalidate()
      return d
    })
}

function listMyGroups() {
  return cloud.invoke({ action: 'mine' }).then((list) => (Array.isArray(list) ? list : []))
}

function getGroup(id) {
  return board(id).then((b) => {
    if (!b.group) throw new Error('群不存在或已解散')
    return b.group
  })
}

function listMembers(id) {
  return board(id).then((b) => b.members)
}

function leaveGroup(groupId) {
  return cloud.invoke({ action: 'leave', groupId: groupId }).then(() => {
    invalidate()
    return true
  })
}

/**
 * 改群名 / 群头像（只有群主能改，服务端会拦）。
 * @param {string} groupId
 * @param {object} patch { name?, avatar? } avatar 传云存储 fileID（cloud://...）
 */
function updateGroup(groupId, patch) {
  const p = patch || {}
  const payload = { action: 'updateGroup', groupId: String(groupId || '') }
  if (typeof p.name === 'string') payload.name = p.name
  if (typeof p.avatar === 'string') payload.avatar = p.avatar
  return cloud.invoke(payload).then((d) => {
    invalidate()
    return d
  })
}

/* ---------------- 每日快照 ---------------- */
/**
 * @param {string} groupId
 * @param {object} snap { done, total, mustDone, mustTotal, minutes, water, plans:[{title,done}] }
 */
function syncMyCheck(groupId, snap) {
  return cloud
    .invoke({ action: 'check', groupId: groupId, snap: snap || {}, myName: myName() || '我' })
    .then((d) => {
      invalidate()
      return d
    })
}

function todayChecks(groupId) {
  return board(groupId).then((b) => b.checks)
}

/**
 * 在群里直接发/更新我的今日计划清单（不需要电脑端后端）。
 * @param {string} groupId
 * @param {Array<{text:string,done:boolean}>} items 最多 8 项，每项 20 字内
 */
function postMyItems(groupId, items) {
  const list = (Array.isArray(items) ? items : [])
    .slice(0, 8)
    .map((it) => ({ text: String((it && it.text) || '').slice(0, 20), done: !!(it && it.done) }))
  return cloud
    .invoke({ action: 'post', groupId: groupId, items: list, myName: myName() || '我' })
    .then((d) => {
      invalidate()
      return d
    })
}

/* ---------------- 周榜 / 复用昨天 / 催办通知 ---------------- */

/**
 * 最近 7 天周榜。
 * @returns {Promise<{days:string[], rows:Array<{openid,name,done,total,pct,daysPosted,streak,trend:number[],isMe}>}>}
 *   trend 是 7 个数字（老 → 今天），-1 表示那天没发计划
 */
function week(groupId) {
  return cloud.invoke({ action: 'week', groupId: String(groupId || '') }).then((d) => {
    const r = d || {}
    return {
      days: Array.isArray(r.days) ? r.days : [],
      rows: Array.isArray(r.rows) ? r.rows : []
    }
  })
}

/** 我昨天发的计划清单（「复用昨天」用） */
function myDay(groupId, date) {
  return cloud
    .invoke({ action: 'yesterday', groupId: String(groupId || ''), date: String(date || '') })
    .then((d) => {
      const r = d || {}
      return { date: r.date || '', plans: Array.isArray(r.plans) ? r.plans : [] }
    })
}

/** 群的催办订阅消息模板 ID（服务端没配就返回空串 = 关闭推送） */
function subscribeTemplateOf(groupId) {
  return board(groupId).then((b) => b.subscribeTemplate || '')
}

const SUB_KEY = 'ph_sub_accepted'

/** 今天是否已经接受过订阅授权（存本机，接受一次够发一条） */
function subAcceptedToday() {
  try {
    return wx.getStorageSync(SUB_KEY) === new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  } catch (e) {
    return false
  }
}

function markSubAccepted() {
  try {
    wx.setStorageSync(SUB_KEY, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10))
  } catch (e) {}
}

/* ---------------- 催办 ---------------- */
/* ---------------- 我的常用催办（存本机，不上云） ---------------- */

/** 单句清洗：压换行、去空白、截断 */
function cleanText(raw) {
  let s = String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').trim()
  if (s.length > NUDGE_MAX) s = s.slice(0, NUDGE_MAX)
  return s
}

function readStore() {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return null
    const v = wx.getStorageSync(NUDGE_KEY)
    return Array.isArray(v) ? v : null
  } catch (e) {
    return null
  }
}

function writeStore(list) {
  try {
    if (typeof wx === 'undefined' || !wx.setStorageSync) return
    wx.setStorageSync(NUDGE_KEY, list)
  } catch (e) {}
}

/** 当前常用列表：没设过就用默认 5 句 */
function myNudgeTexts() {
  const saved = readStore()
  if (!saved) return NUDGE_TEXTS.slice()
  const out = []
  for (let i = 0; i < saved.length; i++) {
    const s = cleanText(saved[i])
    if (s && out.indexOf(s) === -1) out.push(s)
  }
  return out.length ? out.slice(0, NUDGE_LIMIT) : NUDGE_TEXTS.slice()
}

/** 整体覆盖（去重、限条数、限字数）；传空数组等于恢复默认 */
function saveNudgeTexts(list) {
  const src = Array.isArray(list) ? list : []
  const out = []
  for (let i = 0; i < src.length; i++) {
    const s = cleanText(src[i])
    if (s && out.indexOf(s) === -1) out.push(s)
    if (out.length >= NUDGE_LIMIT) break
  }
  if (!out.length) {
    try {
      if (typeof wx !== 'undefined' && wx.removeStorageSync) wx.removeStorageSync(NUDGE_KEY)
    } catch (e) {}
    return NUDGE_TEXTS.slice()
  }
  writeStore(out)
  return out
}

/**
 * 发完一句自定义就记进常用（放最前面），下次直接点
 * 返回新的列表，页面直接 setData 即可
 */
function rememberNudge(text) {
  const s = cleanText(text)
  if (!s) return myNudgeTexts()
  const list = myNudgeTexts().filter((x) => x !== s)
  list.unshift(s)
  return saveNudgeTexts(list)
}

/** 删掉某一句；删空了会自动回落默认 */
function removeNudgeText(text) {
  const s = cleanText(text)
  return saveNudgeTexts(myNudgeTexts().filter((x) => x !== s))
}

/** 恢复默认 5 句 */
function resetNudgeTexts() {
  return saveNudgeTexts([])
}

/** 现在是不是默认状态（决定要不要显示「恢复默认」） */
function isDefaultNudgeTexts() {
  const cur = myNudgeTexts()
  if (cur.length !== NUDGE_TEXTS.length) return false
  for (let i = 0; i < NUDGE_TEXTS.length; i++) {
    if (cur[i] !== NUDGE_TEXTS[i]) return false
  }
  return true
}

function sendNudge(groupId, to, toName, text) {
  return cloud
    .invoke({ action: 'nudge', groupId: groupId, to: to, toName: toName || '', text: cleanText(text) })
    .then((d) => {
      invalidate()
      return d
    })
}

/** 发给我的、今天、还没读过的催办 */
function incomingNudges(groupId) {
  return board(groupId).then((b) => {
    const read = readIds()
    return b.nudges.filter((n) => read.indexOf(n.id) === -1)
  })
}

/** 我今天催过谁（避免重复催同一人同一条） */
function nudgedToday(groupId) {
  return board(groupId).then((b) => b.nudged)
}

module.exports = {
  C,
  NUDGE_TEXTS,
  NUDGE_MAX,
  NUDGE_LIMIT,
  myNudgeTexts,
  saveNudgeTexts,
  rememberNudge,
  removeNudgeText,
  resetNudgeTexts,
  isDefaultNudgeTexts,
  cleanNudgeText: cleanText,
  ready,
  setup,
  board,
  invalidate,
  myName,
  setMyName,
  markRead,
  createGroup,
  joinGroup,
  listMyGroups,
  getGroup,
  listMembers,
  leaveGroup,
  updateGroup,
  syncMyCheck,
  postMyItems,
  todayChecks,
  week,
  myDay,
  subscribeTemplateOf,
  subAcceptedToday,
  markSubAccepted,
  sendNudge,
  incomingNudges,
  nudgedToday
}
