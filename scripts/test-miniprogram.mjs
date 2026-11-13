import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mini = path.join(root, 'personalhub-miniprogram')
const read = (name) => fs.readFileSync(path.join(mini, name), 'utf8')
const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', 'miniprogram_npm', '.git'].includes(e.name)) return []
    const file = path.join(dir, e.name)
    return e.isDirectory() ? files(file) : [file]
  })

test('all registered pages, custom tabs, cloud entry and local dependencies exist', () => {
  const app = JSON.parse(read('app.json'))
  assert.equal(app.pages.length, 9)
  assert.ok(app.pages.includes('pages/groups/index'))
  assert.ok(app.pages.includes('pages/group/index'))
  for (const page of app.pages) {
    for (const ext of ['js', 'json', 'wxml', 'wxss'])
      assert.ok(fs.existsSync(path.join(mini, page + '.' + ext)), page + '.' + ext)
  }
  for (const item of app.tabBar.list) assert.ok(app.pages.includes(item.pagePath))
  const project = JSON.parse(read('project.config.json'))
  assert.ok(fs.existsSync(path.join(mini, project.cloudfunctionRoot, 'phgroup/index.js')))
  for (const file of files(mini).filter((p) => p.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8')
    for (const hit of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (!hit[1].startsWith('.')) continue
      const target = path.resolve(path.dirname(file), hit[1])
      assert.ok(
        fs.existsSync(target) || fs.existsSync(target + '.js') || fs.existsSync(target + '.json'),
        file + ': ' + hit[1],
      )
    }
  }
  assert.ok(
    !fs.existsSync(path.join(root, 'app.json')),
    'mini-program files must not be duplicated at repo root',
  )
})

test('JavaScript and JSON parse and all static WXML event handlers are defined', () => {
  for (const file of files(mini)) {
    if (file.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'))
    if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      assert.equal(result.status, 0, file + '\n' + result.stderr)
    }
    if (file.endsWith('.wxml')) {
      const js = fs.readFileSync(file.replace(/\.wxml$/, '.js'), 'utf8')
      const xml = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
      for (const hit of xml.matchAll(
        /(?:bind|catch|capture-bind|capture-catch):?[\w-]+\s*=\s*['"]([A-Za-z_$][\w$]*)['"]/g,
      )) {
        assert.match(
          js,
          new RegExp('(?:^|\\n)\\s*(?:async\\s+)?' + hit[1] + '\\s*\\([^)]*\\)\\s*\\{'),
          file + ': missing handler ' + hit[1],
        )
      }
    }
  }
})

function client() {
  const storage = new Map([
    ['ph_session', 'alice-token'],
    ['ph_token', 'alice-write'],
    ['ph_user', { username: 'Alice' }],
    ['ph_settings', { nickname: 'Alice' }],
  ])
  const exports = {}
  const context = vm.createContext({
    module: { exports },
    exports,
    console,
    setTimeout,
    require: () => ({ baseUrl: 'http://127.0.0.1:8771', debug: false }),
    wx: {
      getStorageSync: (k) => storage.get(k),
      setStorageSync: (k, v) => storage.set(k, v),
      removeStorageSync: (k) => storage.delete(k),
    },
  })
  vm.runInContext(read('utils/api.js'), context)
  return { api: context.module.exports, storage }
}

test('changing or resetting the backend clears credentials and account settings', () => {
  const { api, storage } = client()
  api.setBaseUrl('http://127.0.0.1:8771/')
  assert.equal(api.getSession(), 'alice-token')
  api.setBaseUrl('https://new.example.test')
  assert.equal(api.getSession(), '')
  assert.equal(api.getToken(), '')
  assert.equal(api.getUser(), null)
  assert.equal(api.cachedSettings(), null)
  storage.set('ph_session', 'new-backend-token')
  api.resetBaseUrl()
  assert.equal(api.getSession(), '')
})

function groupFixture() {
  let identity = 'alice'
  let seq = 10
  const stores = {
    ph_groups: [{ _id: 'g1', name: 'Study', code: 'ABC123', owner: 'alice' }],
    ph_group_members: [
      { _id: 'm1', group_id: 'g1', openid: 'alice', name: 'Alice' },
      { _id: 'm2', group_id: 'g1', openid: 'bob', name: 'Bob' },
    ],
    ph_group_checks: [],
    ph_group_nudges: [],
  }
  function query(name, filter = {}, offset = 0, limit = 100) {
    const select = () =>
      (stores[name] || []).filter((row) =>
        Object.entries(filter).every(([k, v]) =>
          v && typeof v === 'object' && '$in' in v ? v.$in.includes(row[k]) : row[k] === v,
        ),
      )
    return {
      where: (where) => query(name, where, offset, limit),
      skip: (skip) => query(name, filter, skip, limit),
      limit: (n) => query(name, filter, offset, n),
      get: async () => ({ data: select().slice(offset, offset + limit) }),
      add: async ({ data }) => {
        const row = { ...data, _id: 'new' + ++seq }
        ;(stores[name] ||= []).push(row)
        return { _id: row._id }
      },
      doc: (id) => ({
        get: async () => ({ data: stores[name].find((x) => x._id === id) }),
        update: async ({ data }) =>
          Object.assign(
            stores[name].find((x) => x._id === id),
            data,
          ),
        remove: async () => {
          stores[name] = stores[name].filter((x) => x._id !== id)
        },
      }),
    }
  }
  const database = {
    command: { in: (values) => ({ $in: values }) },
    collection: (name) => query(name),
    createCollection: async (name) => {
      stores[name] ||= []
    },
  }
  const cloud = {
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: identity }),
    getTempFileURL: async () => ({ fileList: [] }),
  }
  const context = vm.createContext({
    exports: {},
    require: (name) => {
      assert.equal(name, 'wx-server-sdk')
      return cloud
    },
    console,
  })
  vm.runInContext(read('cloudfunctions/phgroup/index.js'), context)
  return {
    stores,
    call: (user, action, extra = {}) => {
      identity = user
      return context.exports.main({ action, ...extra })
    },
  }
}

test('group cloud function rejects missing identity and non-member reads or writes', async () => {
  const { call } = groupFixture()
  assert.equal((await call('', 'whoami')).ok, false)
  for (const action of ['board', 'post', 'week', 'yesterday', 'updateGroup', 'nudge']) {
    const result = await call('outsider', action, {
      groupId: 'g1',
      name: 'Hijack',
      to: 'bob',
      items: [{ text: 'fake' }],
    })
    assert.equal(result.ok, false, action)
  }
})

test('group plans are bounded, counted on the server, and belong to the caller', async () => {
  const { call, stores } = groupFixture()
  const result = await call('alice', 'post', {
    groupId: 'g1',
    openid: 'bob',
    done: 999,
    items: Array.from({ length: 12 }, (_, i) => ({ text: 'x'.repeat(30), done: i % 2 === 0 })),
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.total, 8)
  assert.equal(result.data.done, 4)
  assert.equal(stores.ph_group_checks[0].openid, 'alice')
  assert.equal(stores.ph_group_checks[0].plans[0].text.length, 20)
  const board = await call('bob', 'board', { groupId: 'g1' })
  assert.equal(board.ok, true)
  assert.equal(board.data.checks[0].openid, 'alice')
  const week = await call('alice', 'week', { groupId: 'g1' })
  assert.equal(week.data.days.length, 7)
  assert.equal(week.data.rows.find((r) => r.isMe).pct, 50)
})

test('only owners can edit group details; duplicate or cross-group nudges fail', async () => {
  const { call, stores } = groupFixture()
  assert.equal((await call('bob', 'updateGroup', { groupId: 'g1', name: 'Fake' })).ok, false)
  assert.equal(
    (await call('alice', 'updateGroup', { groupId: 'g1', avatar: 'https://untrusted.test' })).ok,
    false,
  )
  assert.equal(
    (await call('alice', 'updateGroup', { groupId: 'g1', name: 'New study group' })).ok,
    true,
  )
  assert.equal((await call('alice', 'nudge', { groupId: 'g1', to: 'outsider' })).ok, false)
  assert.equal((await call('alice', 'nudge', { groupId: 'g1', to: 'alice' })).ok, false)
  const first = await call('alice', 'nudge', { groupId: 'g1', to: 'bob', text: 'a'.repeat(80) })
  assert.equal(first.ok, true)
  assert.equal(first.data.text.length, 40)
  assert.equal(first.data.pushed, false)
  assert.equal((await call('alice', 'nudge', { groupId: 'g1', to: 'bob' })).ok, false)
  assert.equal(stores.ph_group_nudges.length, 1)
})

test('notifier never exposes another account and persists first-run state', async () => {
  const runtime = path.join(root, '.test-runtime', 'miniprogram-checks')
  fs.mkdirSync(runtime, { recursive: true })
  const dir = fs.mkdtempSync(path.join(runtime, 'notifier-'))
  let operatorRequests = 0
  const backend = createServer((req, res) => {
    const cookie = req.headers.cookie || ''
    if (cookie.includes('operator-token')) operatorRequests++
    const name =
      cookie === 'personalhub_public_session=alice-token'
        ? 'Alice'
        : cookie === 'personalhub_public_session=bob-token'
          ? 'Bob'
          : ''
    res.setHeader('Content-Type', 'application/json')
    if (!name) {
      res.writeHead(401)
      res.end(JSON.stringify({ detail: '请先登录' }))
      return
    }
    if (req.url === '/api/v1/public/me') res.end(JSON.stringify({ username: name }))
    else if (req.url === '/api/v1/learning/goals') res.end('[]')
    else res.end('[]')
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const prior = {
    TARGET: process.env.TARGET,
    PERSONAL_HUB_WECHAT_DATA_DIR: process.env.PERSONAL_HUB_WECHAT_DATA_DIR,
  }
  process.env.TARGET = 'http://127.0.0.1:' + backend.address().port
  process.env.PERSONAL_HUB_WECHAT_DATA_DIR = dir
  const require = createRequire(import.meta.url)
  const notifier = require('../_tools/wechat-notifier.js')
  notifier.writeJson(path.join(dir, 'wechat_conf.json'), {
    secret: '',
    session: 'personalhub_public_session=operator-token',
  })
  notifier.writeJson(path.join(dir, 'wechat_subs.json'), {
    users: [
      { openid: 'alice-id', username: 'Alice', session: 'alice-token', quota: 2 },
      { openid: 'bob-id', username: 'Bob', session: 'bob-token', quota: 7 },
    ],
  })
  notifier.server.listen(0, '127.0.0.1')
  await once(notifier.server, 'listening')
  const url = 'http://127.0.0.1:' + notifier.server.address().port
  try {
    const anonymous = await fetch(url + '/api/v1/wx/subs/status').then((r) => r.json())
    assert.equal(anonymous.quota, 0)
    for (const key of ['accounts', 'total_quota', 'conf_file'])
      assert.equal(key in anonymous, false)
    const mine = await fetch(url + '/api/v1/wx/subs/status', {
      headers: { Cookie: 'personalhub_public_session=alice-token' },
    }).then((r) => r.json())
    assert.equal(mine.quota, 2)
    assert.equal(mine.my_username, 'Alice')
    assert.equal((await fetch(url + '/api/v1/wx/events')).status, 401)
    assert.equal(
      (
        await fetch(url + '/api/v1/wx/events?openid=bob-id', {
          headers: { Cookie: 'personalhub_public_session=alice-token' },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await fetch(url + '/api/v1/wx/events', {
          headers: { Cookie: 'personalhub_public_session=alice-token' },
        })
      ).status,
      200,
    )
    assert.equal(await notifier.cookieFor('missing-user', false), '')
    assert.equal(operatorRequests, 0)
    const initial = path.join(dir, 'new-folder', 'state.json')
    notifier.writeJson(initial, { ok: true })
    assert.equal(JSON.parse(fs.readFileSync(initial, 'utf8')).ok, true)
  } finally {
    await Promise.all([
      new Promise((r) => notifier.server.close(r)),
      new Promise((r) => backend.close(r)),
    ])
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
