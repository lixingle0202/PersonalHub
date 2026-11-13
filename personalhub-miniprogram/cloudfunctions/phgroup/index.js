/**
 * 监督群云函数（唯一的服务端入口）
 *
 * 为什么把读写都放在云函数里：
 *   1. 所有数据库操作以管理员身份执行，4 个集合不需要在控制台逐个设权限，少 4 次手工操作；
 *   2. 服务端校验「你是不是这个群的人」「催办文案长度是否合规」，客户端改不了别人的数据；
 *   3. 看板一次调用取全部数据，从 5 次请求降到 1 次。
 *
 * 集合（首次调用 setup 自动创建）：
 *   ph_groups / ph_group_members / ph_group_checks / ph_group_nudges
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const C = {
  groups: 'ph_groups',
  members: 'ph_group_members',
  checks: 'ph_group_checks',
  nudges: 'ph_group_nudges',
}

const ALL = [C.groups, C.members, C.checks, C.nudges]

/** 云函数端单次 get 上限 100 条，超出要分页 */
const PAGE = 100
const MAX_ROWS = 600

/** 催办默认句式（客户端可自定义，服务端只校验长度） */
const NUDGE_TEXTS = [
  '今天的计划还没完成，加把劲',
  '别忘了打卡，我盯着你呢',
  '今天的学习目标还差一点',
  '喝水和记录别忘了',
  '一起把今天的事做完吧',
]

/** 催办文案上限（字数），超出截断，防止有人塞一大段 */
const NUDGE_MAX = 40

/**
 * 订阅消息：被催的人能收到微信「服务通知」推送。
 * 开启方法（个人主体可用「一次性订阅」）：
 *   1. 小程序管理后台 → 功能 → 订阅消息 → 挑一个「一次性订阅」类模板；
 *   2. 把模板 ID 填到 templateId，并在 fields 里写模板字段映射
 *      （键 = 模板里的字段名，值 = 'text' 催办文案 / 'from' 催办人 / 'group' 群名 / 'time' 时间）；
 *   3. 重新部署云函数。留空 = 关闭推送，催办本身不受影响。
 */
const SUBSCRIBE = {
  templateId: '',
  fields: { thing1: 'text', thing2: 'from' },
}

/** 清洗催办文案：压掉换行、去首尾空白、截断；空则回落默认句 */
function cleanNudge(raw) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  if (!s) return NUDGE_TEXTS[0]
  if (s.length > NUDGE_MAX) s = s.slice(0, NUDGE_MAX)
  return s
}

/* ---------------- 云存储图片 → 可显示的临时地址 ---------------- */

/**
 * 为什么不在小程序端直接 getTempFileURL：
 *   客户端取临时链接受「云存储权限」约束，群主上传的头像，别的成员取不到（返回空），
 *   表现就是「只有群主自己能看到头像」。云函数是管理员身份，不受这个限制。
 *
 * 临时链接默认 2 小时有效，这里在云函数实例内存里缓存 90 分钟，省调用次数。
 */
const URL_TTL = 90 * 60 * 1000
const urlCache = {}

async function fileUrls(ids) {
  const list = []
  const src = Array.isArray(ids) ? ids : [ids]
  for (let i = 0; i < src.length; i++) {
    const id = String(src[i] || '')
    if (id && id.indexOf('cloud://') === 0 && list.indexOf(id) === -1) list.push(id)
  }
  const out = {}
  const need = []
  const now = Date.now()
  for (let i = 0; i < list.length; i++) {
    const hit = urlCache[list[i]]
    if (hit && now - hit.at < URL_TTL) out[list[i]] = hit.url
    else need.push(list[i])
  }
  // getTempFileURL 单次上限 50 个
  for (let start = 0; start < need.length; start += 50) {
    const chunk = need.slice(start, start + 50)
    if (!chunk.length) continue
    try {
      const res = await cloud.getTempFileURL({ fileList: chunk })
      const arr = (res && res.fileList) || []
      for (let i = 0; i < arr.length; i++) {
        const f = arr[i] || {}
        const id = f.fileID || ''
        const url = f.tempFileURL || ''
        if (id && url) {
          urlCache[id] = { url: url, at: now }
          out[id] = url
        }
      }
    } catch (e) {
      // 拿不到就返回空，客户端回落显示群名首字，不影响其它功能
    }
  }
  return out
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function ok(data) {
  return { ok: true, data: data }
}

function fail(msg) {
  return { ok: false, error: String(msg || '操作失败') }
}

/** 云函数跑在 UTC，群里的「今天」按北京时间算 */
function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 今天偏移 offset 天的日期串（北京时间），dayStr(-1) = 昨天 */
function dayStr(offset) {
  return new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10)
}

function makeCode() {
  let s = ''
  for (let i = 0; i < 6; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length))
  return s
}

async function fetchAll(name, where) {
  const out = []
  let skip = 0
  for (;;) {
    const res = await db.collection(name).where(where).skip(skip).limit(PAGE).get()
    const list = (res && res.data) || []
    for (let i = 0; i < list.length; i++) out.push(list[i])
    if (list.length < PAGE || out.length >= MAX_ROWS) break
    skip += PAGE
  }
  return out
}

async function getGroupDoc(id) {
  if (!id) throw new Error('缺少群 ID')
  let res = null
  try {
    res = await db.collection(C.groups).doc(id).get()
  } catch (e) {
    res = null
  }
  const g = (res && res.data) || null
  if (!g) throw new Error('群不存在或已解散')
  return g
}

async function memberOf(groupId, openid) {
  const res = await db
    .collection(C.members)
    .where({ group_id: groupId, openid: openid })
    .limit(1)
    .get()
  return ((res && res.data) || [])[0] || null
}

/* ---------------- 各动作 ---------------- */

async function actSetup() {
  const created = []
  const existed = []
  for (let i = 0; i < ALL.length; i++) {
    const name = ALL[i]
    try {
      await db.createCollection(name)
      created.push(name)
    } catch (e) {
      const msg = String((e && (e.errMsg || e.message)) || '')
      if (/exist/i.test(msg)) {
        existed.push(name)
      } else {
        // 有的环境对已存在的集合报的文案不同，再探一次：能查到就当作已存在
        try {
          await db.collection(name).limit(1).get()
          existed.push(name)
        } catch (e2) {
          throw new Error('创建集合 ' + name + ' 失败：' + (msg || '未知原因'))
        }
      }
    }
  }
  return { created: created, existed: existed }
}

async function actCreate(openid, ev) {
  const title = String(ev.name || '')
    .trim()
    .slice(0, 16)
  if (!title) throw new Error('请给群起个名字')
  const myName =
    String(ev.myName || '')
      .trim()
      .slice(0, 12) || '我'

  let code = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const probe = makeCode()
    const res = await db.collection(C.groups).where({ code: probe }).limit(1).get()
    if (!((res && res.data) || []).length) {
      code = probe
      break
    }
  }
  if (!code) throw new Error('邀请码生成失败，请再试一次')

  const added = await db
    .collection(C.groups)
    .add({ data: { name: title, code: code, owner: openid, created_at: Date.now() } })
  const gid = added._id

  await db
    .collection(C.members)
    .add({ data: { group_id: gid, openid: openid, name: myName, joined_at: Date.now() } })

  return { id: gid, name: title, code: code }
}

async function actJoin(openid, ev) {
  const myName =
    String(ev.myName || '')
      .trim()
      .slice(0, 12) || '我'
  let g = null
  if (ev.groupId) {
    g = await getGroupDoc(String(ev.groupId))
  } else {
    const code = String(ev.code || '')
      .trim()
      .toUpperCase()
    if (code.length < 4) throw new Error('请输入 6 位邀请码')
    const res = await db.collection(C.groups).where({ code: code }).limit(1).get()
    g = ((res && res.data) || [])[0] || null
    if (!g) throw new Error('邀请码无效，或这个群已经解散')
  }

  const cur = await memberOf(g._id, openid)
  if (cur) return { id: g._id, name: g.name, code: g.code, joined: false }

  await db
    .collection(C.members)
    .add({ data: { group_id: g._id, openid: openid, name: myName, joined_at: Date.now() } })

  return { id: g._id, name: g.name, code: g.code, joined: true }
}

async function actMine(openid) {
  const mine = await fetchAll(C.members, { openid: openid })
  const ids = []
  for (let i = 0; i < mine.length; i++) {
    const id = mine[i].group_id
    if (id && ids.indexOf(id) === -1) ids.push(id)
  }
  if (!ids.length) return []

  const groups = await fetchAll(C.groups, { _id: _.in(ids) })
  const members = await fetchAll(C.members, { group_id: _.in(ids) })

  const countMap = {}
  for (let i = 0; i < members.length; i++) {
    const k = members[i].group_id
    countMap[k] = (countMap[k] || 0) + 1
  }

  const map = {}
  for (let i = 0; i < groups.length; i++) map[groups[i]._id] = groups[i]

  const out = []
  for (let i = 0; i < ids.length; i++) {
    const g = map[ids[i]]
    if (!g) continue
    out.push({
      id: g._id,
      name: g.name,
      code: g.code,
      avatar: g.avatar || '',
      owner: g.owner === openid,
      memberCount: countMap[g._id] || 1,
    })
  }

  // 云函数换好临时地址，客户端直接 <image src> 用，不受存储权限影响
  const urlMap = await fileUrls(out.map((x) => x.avatar))
  for (let i = 0; i < out.length; i++) {
    out[i].avatarUrl = urlMap[out[i].avatar] || ''
  }
  return out
}

async function actBoard(openid, ev) {
  const gid = String(ev.groupId || '')
  const g = await getGroupDoc(gid)
  const me = await memberOf(gid, openid)
  if (!me) throw new Error('not_member')

  const date = todayCN()
  const members = await fetchAll(C.members, { group_id: gid })
  const checks = await fetchAll(C.checks, { group_id: gid, date: date })
  const toMe = await fetchAll(C.nudges, { group_id: gid, to: openid, date: date })
  const fromMe = await fetchAll(C.nudges, { group_id: gid, from: openid, date: date })

  const avatarUrl = (await fileUrls([g.avatar || '']))[g.avatar || ''] || ''

  return {
    today: date,
    subscribeTemplate: SUBSCRIBE.templateId || '',
    myName: me.name || '',
    group: {
      id: g._id,
      name: g.name,
      code: g.code,
      avatar: g.avatar || '',
      avatarUrl: avatarUrl,
      owner: g.owner === openid,
      ownerOpenid: g.owner,
    },
    members: members.map(function (m) {
      return { openid: m.openid, name: m.name || '队友', joinedAt: m.joined_at || 0 }
    }),
    checks: checks.map(function (c) {
      return {
        openid: c.openid,
        name: c.name || '队友',
        date: c.date,
        done: Number(c.done) || 0,
        total: Number(c.total) || 0,
        mustDone: Number(c.must_done) || 0,
        mustTotal: Number(c.must_total) || 0,
        minutes: Number(c.minutes) || 0,
        water: Number(c.water) || 0,
        plans: Array.isArray(c.plans) ? c.plans : [],
        updatedAt: c.updated_at || 0,
      }
    }),
    nudges: toMe
      .sort(function (a, b) {
        return (b.created_at || 0) - (a.created_at || 0)
      })
      .slice(0, 20)
      .map(function (n) {
        return { id: n._id, from: n.from_name || '队友', text: n.text || '', at: n.created_at || 0 }
      }),
    nudged: fromMe.map(function (n) {
      return n.to
    }),
  }
}

async function actCheck(openid, ev) {
  const gid = String(ev.groupId || '')
  const g = await getGroupDoc(gid)
  const me = await memberOf(gid, openid)
  if (!me) throw new Error('not_member')

  const snap = ev.snap || {}
  const plans = (Array.isArray(snap.plans) ? snap.plans : []).slice(0, 5).map(function (p) {
    return { title: String((p && p.title) || '').slice(0, 18), done: !!(p && p.done) }
  })

  const date = todayCN()
  const data = {
    group_id: gid,
    openid: openid,
    name: String(ev.myName || me.name || '我').slice(0, 12),
    date: date,
    done: Math.max(0, Math.min(999, Number(snap.done) || 0)),
    total: Math.max(0, Math.min(999, Number(snap.total) || 0)),
    must_done: Math.max(0, Math.min(999, Number(snap.mustDone) || 0)),
    must_total: Math.max(0, Math.min(999, Number(snap.mustTotal) || 0)),
    minutes: Math.max(0, Math.min(9999, Number(snap.minutes) || 0)),
    water: Math.max(0, Math.min(99999, Number(snap.water) || 0)),
    plans: plans,
    updated_at: Date.now(),
  }

  const res = await db
    .collection(C.checks)
    .where({ group_id: gid, openid: openid, date: date })
    .limit(1)
    .get()
  const cur = ((res && res.data) || [])[0]

  if (cur) {
    await db.collection(C.checks).doc(cur._id).update({ data: data })
  } else {
    await db.collection(C.checks).add({ data: data })
  }

  return { date: date, group: g.name }
}

/**
 * 在群里直接发/更新我的今日计划清单（不依赖电脑端后端）。
 * items: [{text, done}]，服务端夹紧：最多 8 项、每项 20 字内；done/total 由服务端统计。
 */
async function actPost(openid, ev) {
  const gid = String(ev.groupId || '')
  const g = await getGroupDoc(gid)
  const me = await memberOf(gid, openid)
  if (!me) throw new Error('not_member')

  const raw = Array.isArray(ev.items) ? ev.items : []
  const items = raw
    .slice(0, 8)
    .map(function (p) {
      return {
        text: String((p && p.text) || '')
          .trim()
          .slice(0, 20),
        done: !!(p && p.done),
      }
    })
    .filter(function (p) {
      return p.text
    })
  const done = items.filter(function (p) {
    return p.done
  }).length

  const date = todayCN()
  const data = {
    group_id: gid,
    openid: openid,
    name: String(ev.myName || me.name || '我').slice(0, 12),
    date: date,
    done: done,
    total: items.length,
    must_done: 0,
    must_total: 0,
    minutes: 0,
    water: 0,
    plans: items,
    updated_at: Date.now(),
  }

  const res = await db
    .collection(C.checks)
    .where({ group_id: gid, openid: openid, date: date })
    .limit(1)
    .get()
  const cur = ((res && res.data) || [])[0]
  if (cur) await db.collection(C.checks).doc(cur._id).update({ data: data })
  else await db.collection(C.checks).add({ data: data })

  return { date: date, done: done, total: items.length }
}

/**
 * 最近 7 天周榜：每人本周完成 done/total、完成率、发计划天数、连续打卡天数，
 * 以及 7 天的每日完成率小趋势（没发计划的那天记 -1，前端画灰柱）。
 */
async function actWeek(openid, ev) {
  const gid = String(ev.groupId || '')
  await getGroupDoc(gid)
  const me = await memberOf(gid, openid)
  if (!me) throw new Error('not_member')

  const days = []
  for (let i = -6; i <= 0; i++) days.push(dayStr(i))

  const members = await fetchAll(C.members, { group_id: gid })
  const checks = await fetchAll(C.checks, { group_id: gid, date: _.in(days) })

  // openid|date → {done,total}，plans 里有内容就按 plans 数，否则用 done/total 字段
  const byKey = {}
  for (let j = 0; j < checks.length; j++) {
    const c = checks[j]
    const items = Array.isArray(c.plans) ? c.plans : []
    let done
    let total
    if (items.length) {
      done = items.filter(function (p) {
        return p && p.done
      }).length
      total = items.length
    } else {
      done = Number(c.done) || 0
      total = Number(c.total) || 0
    }
    byKey[c.openid + '|' + c.date] = { done: done, total: total }
  }

  const rows = {}
  const order = []
  function ensure(oid, name) {
    if (!rows[oid]) {
      rows[oid] = {
        openid: oid,
        name: name || '队友',
        done: 0,
        total: 0,
        daysPosted: 0,
        streak: 0,
        trend: [-1, -1, -1, -1, -1, -1, -1],
      }
      order.push(oid)
    } else if (name && rows[oid].name === '队友') {
      rows[oid].name = name
    }
    return rows[oid]
  }
  for (let i = 0; i < members.length; i++) ensure(members[i].openid, members[i].name)

  for (let k = 0; k < order.length; k++) {
    const row = rows[order[k]]
    for (let i = 0; i < days.length; i++) {
      const rec = byKey[order[k] + '|' + days[i]]
      if (!rec) continue
      row.done += rec.done
      row.total += rec.total
      row.daysPosted += 1
      row.trend[i] = rec.total ? Math.min(100, Math.round((rec.done / rec.total) * 100)) : 0
    }
    // 连续打卡：从今天往前数 done>0 的天；今天还没发计划不断签，从昨天接着数
    let streak = 0
    for (let i = days.length - 1; i >= 0; i--) {
      const rec = byKey[order[k] + '|' + days[i]]
      if (rec && rec.done > 0) {
        streak++
      } else if (i === days.length - 1 && !rec) {
        continue
      } else {
        break
      }
    }
    row.streak = streak
  }

  const out = order.map((k) => {
    const r = rows[k]
    r.isMe = k === openid
    r.pct = r.total ? Math.min(100, Math.round((r.done / r.total) * 100)) : 0
    return r
  })
  out.sort(function (a, b) {
    if (a.isMe !== b.isMe) return a.isMe ? -1 : 1
    return b.pct - a.pct
  })

  return { days: days, today: todayCN(), rows: out }
}

/** 取我昨天发的计划清单（「复用昨天」用） */
async function actYesterday(openid, ev) {
  const gid = String(ev.groupId || '')
  await getGroupDoc(gid)
  const me = await memberOf(gid, openid)
  if (!me) throw new Error('not_member')

  const date = dayStr(-1)
  const res = await db
    .collection(C.checks)
    .where({ group_id: gid, openid: openid, date: date })
    .limit(1)
    .get()
  const cur = ((res && res.data) || [])[0]
  const plans = cur && Array.isArray(cur.plans) ? cur.plans : []
  return {
    date: date,
    plans: plans
      .map(function (p) {
        return {
          text: String((p && (p.text || p.title)) || '').slice(0, 20),
          done: !!(p && p.done),
        }
      })
      .filter(function (p) {
        return p.text
      }),
  }
}

/** 改群名 / 群头像：只有群主能改，服务端夹紧 */
async function actUpdateGroup(openid, ev) {
  const gid = String(ev.groupId || '')
  const g = await getGroupDoc(gid)
  if (g.owner !== openid) throw new Error('只有群主能改群名和头像')

  const patch = {}
  if (typeof ev.name === 'string') {
    const name = ev.name.trim().slice(0, 16)
    if (!name) throw new Error('群名不能为空')
    patch.name = name
  }
  if (typeof ev.avatar === 'string') {
    const av = ev.avatar.trim()
    if (av && av.indexOf('cloud://') !== 0) throw new Error('头像地址不合法')
    patch.avatar = av.slice(0, 300)
  }
  if (!Object.keys(patch).length) throw new Error('没有要修改的内容')

  patch.updated_at = Date.now()
  await db.collection(C.groups).doc(gid).update({ data: patch })

  return {
    id: gid,
    name: patch.name || g.name,
    avatar: typeof patch.avatar === 'string' ? patch.avatar : g.avatar || '',
  }
}

/** 按配置把催办内容映射成订阅消息模板字段 */
function buildPushData(n) {
  const out = {}
  const map = SUBSCRIBE.fields || {}
  for (const key in map) {
    let v = ''
    const src = map[key]
    if (src === 'text') v = n.text
    else if (src === 'from') v = n.from
    else if (src === 'group') v = n.group
    else if (src === 'time') v = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16)
    if (/^thing/.test(key)) v = String(v).slice(0, 20)
    out[key] = { value: String(v) }
  }
  return out
}

async function actNudge(openid, ev) {
  const gid = String(ev.groupId || '')
  const to = String(ev.to || '')
  if (!to) throw new Error('缺少催办对象')
  const g = await getGroupDoc(gid)
  const me = await memberOf(gid, openid)
  if (!me) throw new Error('not_member')
  const target = await memberOf(gid, to)
  if (!target) throw new Error('ta 已经不在这个群里了')
  if (to === openid) throw new Error('不用催自己')

  const text = cleanNudge(ev.text)
  const previous = await db
    .collection(C.nudges)
    .where({ group_id: gid, from: openid, to: to, date: todayCN() })
    .limit(1)
    .get()
  if (((previous && previous.data) || []).length) throw new Error('今天已经提醒过这位成员')

  await db.collection(C.nudges).add({
    data: {
      group_id: gid,
      from: openid,
      from_name: String(me.name || '队友').slice(0, 12),
      to: to,
      to_name: String(target.name || '').slice(0, 12),
      date: todayCN(),
      text: text,
      created_at: Date.now(),
    },
  })

  // 尽力补发一条订阅消息；没配模板 / 对方没授权 / 发送失败，都不影响催办本身
  let pushed = false
  if (SUBSCRIBE.templateId) {
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: to,
        templateId: SUBSCRIBE.templateId,
        page: 'pages/group/index?id=' + gid,
        data: buildPushData({ text: text, from: String(me.name || '队友'), group: g.name }),
      })
      pushed = true
    } catch (e) {
      pushed = false
    }
  }

  return { text: text, pushed: pushed }
}

async function actLeave(openid, ev) {
  const gid = String(ev.groupId || '')
  const res = await db.collection(C.members).where({ group_id: gid, openid: openid }).get()
  const list = (res && res.data) || []
  for (let i = 0; i < list.length; i++) {
    await db.collection(C.members).doc(list[i]._id).remove()
  }
  return true
}

exports.main = async function (event) {
  const ev = event || {}
  const action = String(ev.action || '')
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''

  try {
    if (action === 'ping') return ok({ version: 1, hasOpenid: !!openid, today: todayCN() })
    // 建表不依赖身份，放在 openid 校验之前
    if (action === 'setup') return ok(await actSetup())
    if (!openid) return fail('取不到微信身份，请重进小程序')

    if (action === 'whoami') return ok({ openid: openid })
    if (action === 'create') return ok(await actCreate(openid, ev))
    if (action === 'join') return ok(await actJoin(openid, ev))
    if (action === 'mine') return ok(await actMine(openid))
    if (action === 'board') return ok(await actBoard(openid, ev))
    if (action === 'check') return ok(await actCheck(openid, ev))
    if (action === 'post') return ok(await actPost(openid, ev))
    if (action === 'week') return ok(await actWeek(openid, ev))
    if (action === 'yesterday') return ok(await actYesterday(openid, ev))
    if (action === 'updateGroup') return ok(await actUpdateGroup(openid, ev))
    if (action === 'nudge') return ok(await actNudge(openid, ev))
    if (action === 'leave') return ok(await actLeave(openid, ev))

    return fail('未知操作：' + action)
  } catch (e) {
    return fail((e && e.message) || '服务异常')
  }
}
