import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// All mutations go to a fresh, explicitly verified fixture database, never personal data.
const [runtimePath, playwrightPath, outputPath, mode] = process.argv.slice(2)
if (!runtimePath || !playwrightPath || !outputPath || (mode && mode !== '--packaged')) {
  throw new Error('Usage: node scripts/test-learning-delete-browser.mjs <python-or-exe> <playwright-module> <fresh-artifacts> [--packaged]')
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(outputPath)
assert.ok(artifacts.startsWith(root + path.sep), 'Artifacts must stay inside the project')
const dataRoot = path.join(artifacts, 'learning-delete-browser-data')
try {
  await access(dataRoot)
  throw new Error('Use a fresh artifact directory; the fixture database already exists')
} catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(artifacts, { recursive: true })
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const baseUrl = `http://127.0.0.1:${port}`
const server = spawn(path.resolve(runtimePath), mode === '--packaged' ? [] : [
  '-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port),
], { cwd: root, windowsHide: true,
  env: { ...process.env, PYTHONPATH: path.join(root, 'backend'), PERSONAL_HUB_DATA_DIR: dataRoot,
    PERSONAL_HUB_PORT: String(port), PERSONAL_HUB_NO_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (data) => { log += data })
server.stderr.on('data', (data) => { log += data })
const { chromium } = createRequire(import.meta.url)(playwrightPath)
const checks = []
const screenshots = []
const errors = []
const releases = []
let browser
let page
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function withTimeout(promise, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 7000)
    })])
  } finally { clearTimeout(timer) }
}
async function frame(target = page) {
  await target.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function readyDialog(dialog, target = page) {
  await dialog.waitFor()
  await frame(target)
  await dialog.evaluate((element) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000
    function painted() {
      if (performance.now() > deadline) { reject(new Error('Dialog did not finish painting')); return }
      if (Number(getComputedStyle(element).opacity) >= 0.99 && element.getAnimations().every((animation) => animation.playState !== 'running')) resolve()
      else requestAnimationFrame(painted)
    }
    painted()
  }))
}
async function screenshot(name, target = page) {
  await frame(target)
  const filename = `${name}.png`
  await target.screenshot({ path: path.join(artifacts, filename), animations: 'disabled' })
  screenshots.push(filename)
}
async function check(name, action) {
  await action()
  checks.push(name)
  console.log(`PASS: ${name}`)
}
async function pointClick(locator, target = page) {
  // Editor content may scroll; confirmation controls must already fit the viewport.
  const label = await locator.getAttribute('aria-label')
  if (label !== '确认删除' && label !== '取消删除') await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  const viewport = target.viewportSize()
  assert.ok(box && box.width > 0 && box.height > 0, 'The button must have visible dimensions')
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    `The entire button must fit the viewport: ${JSON.stringify({ box, viewport })}`)
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  assert.ok(await locator.evaluate((element, coordinates) => {
    const hit = document.elementFromPoint(coordinates.x, coordinates.y)
    return hit === element || element.contains(hit)
  }, point), 'The button center must receive real pointer input without an overlay')
  await target.mouse.click(point.x, point.y)
  return point
}
function editor(kind, target = page) { return target.getByRole('dialog', { name: kind === 'task' ? '编辑学习任务' : '编辑学习目标', exact: true }) }
function confirmation(kind, target = page) { return target.getByRole('dialog', { name: kind === 'task' ? '确认删除此学习任务？' : '确认删除此学习计划？', exact: true }) }
async function openGoal(name, target = page) {
  await target.getByRole('button', { name: `编辑学习目标 ${name}`, exact: true }).click()
  const dialog = editor('goal', target)
  await readyDialog(dialog, target)
  return dialog
}
async function selectGoal(goal, target = page) {
  const dialog = await openGoal(goal.name, target)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await target.getByText(goal.goal, { exact: true }).waitFor()
}
async function setDate(input, value) { await input.fill(value); await input.press('Enter') }

try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${baseUrl}/health`)).ok } catch {}
    if (ready) break
    if (server.exitCode !== null) throw new Error(`Test server exited: ${log}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(ready, `Server did not start: ${log}`)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const bootstrap = await (await page.request.get(`${baseUrl}/api/v1/bootstrap`)).json()
  assert.equal(path.resolve(bootstrap.database_path), path.join(dataRoot, 'data', 'personal_data.db'))
  const headers = { 'X-Local-Token': bootstrap.local_token }
  async function get(endpoint) {
    const response = await page.request.get(`${baseUrl}/api/v1${endpoint}`)
    assert.ok(response.ok(), `GET ${endpoint}: ${response.status()}`)
    return response.json()
  }
  async function post(endpoint, data) {
    const response = await page.request.post(`${baseUrl}/api/v1${endpoint}`, { headers, data })
    assert.ok(response.ok(), `POST ${endpoint}: ${await response.text()}`)
    return response.json()
  }
  const today = await page.evaluate(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  function offsetDate(offset) {
    const value = new Date(`${today}T12:00:00Z`)
    value.setUTCDate(value.getUTCDate() + offset)
    return value.toISOString().slice(0, 10)
  }
  const tomorrow = offsetDate(1)
  const yesterday = offsetDate(-1)
  const prefix = '浏览器逐项学习验收'
  let primary = await post('/learning/goals', { name: `${prefix}目标`, goal: '待修改的目标详情', start_date: today, target_date: tomorrow, estimated_minutes: 120 })
  const section = await post(`/learning/goals/${primary.id}/sections`, { name: `${prefix}章节` })
  const task1 = await post(`/learning/goals/${primary.id}/tasks`, { title: `${prefix}任务一`, plan_date: today })
  const task2 = await post(`/learning/goals/${primary.id}/tasks`, { title: `${prefix}任务二`, plan_date: today })
  const task3 = await post(`/learning/goals/${primary.id}/tasks`, { title: `${prefix}任务三`, plan_date: tomorrow })
  const unscheduled = await post(`/learning/goals/${primary.id}/tasks`, { title: `${prefix}未排期任务` })
  const session = await post(`/learning/goals/${primary.id}/sessions`, { studied_on: today, actual_minutes: 35, notes: `${prefix}学习记录` })
  const resource = await post(`/learning/goals/${primary.id}/resources`, { name: `${prefix}资料`, link: 'https://developer.android.com/' })
  const retained = await post('/learning/goals', { name: '保留的其他学习目标', goal: '另一目标详情保持独立', start_date: today, target_date: tomorrow })
  const retainedTask = await post(`/learning/goals/${retained.id}/tasks`, { title: '保留的其他学习任务', plan_date: today })
  const meal = await post('/diet/meals', { meal_date: today, meal_type: 'lunch', custom_name: '保留的午餐安排' })
  await post(`/agenda/${task2.agenda_id}/complete`)
  let home = await get(`/home?date=${today}`)
  assert.equal(home.stats.total, 4)
  assert.equal(home.stats.completed, 1)
  assert.equal(home.summaries.learning.count, 2)
  await page.goto(`${baseUrl}/learning`)
  await page.getByRole('button', { name: `编辑学习目标 ${primary.name}`, exact: true }).waitFor()

  await check('Each goal opens its own editable name, dates and description', async () => {
    const dialog = await openGoal(primary.name)
    const changedName = `${prefix}已修改目标`
    await dialog.getByLabel('学习主题', { exact: true }).fill(changedName)
    await dialog.getByLabel('学习目标', { exact: true }).fill('修改后的目标详情用于确认当前选择')
    await setDate(dialog.getByLabel('开始日期', { exact: true }), yesterday)
    await dialog.getByLabel('预计投入分钟', { exact: true }).fill('240')
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    primary = await get(`/learning/goals/${primary.id}`)
    assert.equal(primary.name, changedName)
    assert.equal(primary.start_date, yesterday)
    assert.equal(primary.estimated_minutes, 240)
    await page.getByText(primary.goal, { exact: true }).waitFor()
    await screenshot('edited-goal')
  })
  await check('An older detail response cannot replace a newer selected goal', async () => {
    await selectGoal(retained)
    const arrived = deferred()
    const release = deferred()
    releases.push(release.resolve)
    const endpoint = `${baseUrl}/api/v1/learning/goals/${primary.id}`
    const handler = async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      arrived.resolve()
      await release.promise
      await route.continue()
    }
    await page.route(endpoint, handler)
    const pendingEditor = await openGoal(primary.name)
    await pendingEditor.getByRole('button', { name: '取消', exact: true }).click()
    await withTimeout(arrived.promise, 'Opening the goal did not request its detail')
    await selectGoal(retained)
    const lateResponse = page.waitForResponse((response) => response.url() === endpoint && response.request().method() === 'GET')
    release.resolve()
    await lateResponse
    await frame()
    assert.equal(await page.getByText(primary.goal, { exact: true }).count(), 0)
    await page.getByRole('tab', { name: '学习任务', exact: true }).click()
    await page.getByRole('button', { name: `编辑学习任务 ${retainedTask.title}`, exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: `编辑学习任务 ${task1.title}`, exact: true }).count(), 0)
    await page.unroute(endpoint, handler)
  })
  let changedTaskTitle
  await check('Each task supports title and date edits and updates agenda/search', async () => {
    await selectGoal(primary)
    await page.getByRole('tab', { name: '学习任务', exact: true }).click()
    await page.getByRole('button', { name: `编辑学习任务 ${task1.title}`, exact: true }).click()
    const dialog = editor('task')
    await readyDialog(dialog)
    changedTaskTitle = `${prefix}已修改任务`
    await dialog.getByLabel('学习任务', { exact: true }).fill(changedTaskTitle)
    await setDate(dialog.getByLabel('计划日期', { exact: true }), tomorrow)
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const updated = (await get(`/learning/goals/${primary.id}`)).tasks.find((task) => task.id === task1.id)
    assert.equal(updated.title, changedTaskTitle)
    assert.equal(updated.plan_date, tomorrow)
    assert.ok(!(await get(`/agenda?date=${today}`)).some((item) => item.source_id === task1.id))
    assert.equal((await get(`/agenda?date=${tomorrow}`)).find((item) => item.source_id === task1.id).title, changedTaskTitle)
    assert.ok((await get(`/search?q=${encodeURIComponent(changedTaskTitle)}`)).length)
    assert.deepEqual(await get(`/search?q=${encodeURIComponent(task1.title)}`), [])
    await screenshot('edited-task')
  })

  async function deleteWithFaults(kind, id, draftField) {
    const dialog = editor(kind)
    const trigger = dialog.getByRole('button', { name: kind === 'task' ? '删除此任务' : '删除此计划', exact: true })
    const confirm = confirmation(kind)
    const endpoint = `${baseUrl}/api/v1/learning/${kind === 'task' ? 'tasks' : 'goals'}/${id}`
    let attempts = 0
    const began = deferred()
    const release = deferred()
    releases.push(release.resolve)
    const handler = async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      attempts++
      if (attempts === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '验收模拟删除失败，请重试' }) })
      began.resolve()
      await release.promise
      await route.continue()
    }
    await page.route(endpoint, handler)
    await trigger.click()
    await readyDialog(confirm)
    await pointClick(confirm.getByRole('button', { name: '取消删除', exact: true }))
    await confirm.waitFor({ state: 'hidden' })
    assert.equal(attempts, 0)
    assert.ok(await dialog.isVisible())
    const draft = `${prefix}未保存的${kind === 'task' ? '任务' : '目标'}修改`
    await dialog.getByLabel(draftField, { exact: true }).fill(draft)
    await trigger.click()
    await readyDialog(confirm)
    await pointClick(confirm.getByRole('button', { name: '确认删除', exact: true }))
    await confirm.getByText('验收模拟删除失败，请重试', { exact: true }).waitFor()
    assert.equal(attempts, 1)
    assert.equal(await dialog.getByLabel(draftField, { exact: true }).inputValue(), draft)
    assert.ok(kind === 'goal' ? (await get('/learning/goals')).some((goal) => goal.id === id) : (await get(`/learning/goals/${primary.id}`)).tasks.some((task) => task.id === id))
    await screenshot(`${kind}-delete-failed-retry`)
    const point = await pointClick(confirm.getByRole('button', { name: '确认删除', exact: true }))
    await withTimeout(began.promise, 'Confirming deletion did not start the DELETE request')
    await page.mouse.click(point.x, point.y)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.press('Escape')
    await page.mouse.click(1, 1)
    const cancelBox = await confirm.getByRole('button', { name: '取消删除', exact: true }).boundingBox()
    await page.mouse.click(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2)
    await frame()
    assert.equal(attempts, 2, 'Pending confirmation must not issue duplicate DELETE requests')
    assert.ok(await confirm.isVisible(), 'Pending confirmation must stay open after Escape, mask and cancel clicks')
    assert.ok(await dialog.isVisible(), 'Pending editor must stay open')
    assert.ok(await dialog.getByRole('button', { name: '保存修改', exact: true }).isDisabled())
    await screenshot(`${kind}-delete-pending`)
    const response = page.waitForResponse((result) => result.url() === endpoint && result.request().method() === 'DELETE' && result.status() !== 500)
    release.resolve()
    assert.ok((await response).ok())
    await confirm.waitFor({ state: 'hidden' })
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(attempts, 2)
    await page.unroute(endpoint, handler)
  }
  await check('Task deletion cancels safely, preserves drafts on 500, retries and blocks duplicate/exit actions while pending', async () => {
    await page.getByRole('button', { name: `编辑学习任务 ${changedTaskTitle}`, exact: true }).click()
    await readyDialog(editor('task'))
    await deleteWithFaults('task', task1.id, '学习任务')
    await page.getByRole('button', { name: `编辑学习任务 ${task2.title}`, exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: `编辑学习任务 ${changedTaskTitle}`, exact: true }).count(), 0)
    const remaining = (await get(`/learning/goals/${primary.id}`)).tasks
    assert.deepEqual(remaining.map((task) => task.id).sort(), [task2.id, task3.id, unscheduled.id].sort())
    assert.equal((await get(`/home?date=${tomorrow}`)).stats.total, 1)
    assert.deepEqual(await get(`/search?q=${encodeURIComponent(changedTaskTitle)}`), [])
  })
  await check('Goal deletion removes its whole hierarchy from home, today, search and statistics while retaining other plans', async () => {
    await openGoal(primary.name)
    await deleteWithFaults('goal', primary.id, '学习主题')
    await page.getByText(retained.goal, { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: `编辑学习目标 ${primary.name}`, exact: true }).count(), 0)
    assert.deepEqual((await get('/learning/goals')).map((goal) => goal.id), [retained.id])
    assert.equal((await page.request.get(`${baseUrl}/api/v1/learning/goals/${primary.id}`)).status(), 404)
    const current = await get(`/agenda?date=${today}`)
    assert.deepEqual(current.map((item) => item.source_id).sort(), [retainedTask.id, meal.id].sort())
    assert.deepEqual(await get(`/agenda?date=${tomorrow}`), [])
    assert.deepEqual(await get(`/search?q=${encodeURIComponent(prefix)}`), [])
    home = await get(`/home?date=${today}`)
    assert.deepEqual(home.stats, { total: 2, completed: 0, completion_rate: 0, must: 0, overdue: 0, due_soon: 0 })
    assert.equal(home.summaries.learning.count, 1)
    assert.equal(home.summaries.diet.count, 1)
    assert.ok(!JSON.stringify(home).includes(prefix))
    const trash = await get('/trash')
    for (const record of [primary, section, task1, task2, task3, unscheduled, session, resource]) {
      assert.ok(trash.some((item) => item.id === record.id), `Deleted hierarchy record ${record.id} must be recoverable`)
    }
    await page.goto(`${baseUrl}/`)
    await page.getByText(retainedTask.title, { exact: true }).waitFor()
    await page.getByText('午餐：保留的午餐安排', { exact: true }).waitFor()
    await screenshot('home-after-goal-delete')
    await page.goto(`${baseUrl}/today`)
    await page.getByText(retainedTask.title, { exact: true }).waitFor()
    assert.equal(await page.getByText(task2.title, { exact: true }).count(), 0)
    await page.getByLabel('全局搜索', { exact: true }).fill(prefix)
    await page.locator('.global-search').getByRole('button').click()
    await page.getByText('没有找到匹配内容', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
  })
  for (const width of [508, 390]) {
    await check(`${width}×590 DPR 2 editors and centered confirmations accept real pointer clicks without clipped controls`, async () => {
      const narrow = await browser.newContext({ viewport: { width, height: 590 }, deviceScaleFactor: 2, timezoneId: 'Asia/Shanghai' })
      const compact = await narrow.newPage()
      compact.on('pageerror', (error) => errors.push(error.message))
      try {
        const goal = await post('/learning/goals', { name: `${width}像素下可以独立删除的学习计划`, goal: '确认按钮应完整可见且不被遮挡' })
        const task = await post(`/learning/goals/${goal.id}/tasks`, { title: `${width}像素下的可编辑学习任务`, plan_date: today })
        await compact.goto(`${baseUrl}/learning`)
        let dialog = await openGoal(goal.name, compact)
        await pointClick(dialog.getByRole('button', { name: '删除此计划', exact: true }), compact)
        let confirm = confirmation('goal', compact)
        await readyDialog(confirm, compact)
        await screenshot(`${width}-goal-confirm`, compact)
        await pointClick(confirm.getByRole('button', { name: '取消删除', exact: true }), compact)
        await confirm.waitFor({ state: 'hidden' })
        await pointClick(dialog.getByRole('button', { name: '取消', exact: true }), compact)
        await compact.getByRole('tab', { name: '学习任务', exact: true }).click()
        await compact.getByRole('button', { name: `编辑学习任务 ${task.title}`, exact: true }).click()
        dialog = editor('task', compact)
        await readyDialog(dialog, compact)
        await pointClick(dialog.getByRole('button', { name: '删除此任务', exact: true }), compact)
        confirm = confirmation('task', compact)
        await readyDialog(confirm, compact)
        await screenshot(`${width}-task-confirm`, compact)
        await pointClick(confirm.getByRole('button', { name: '确认删除', exact: true }), compact)
        await dialog.waitFor({ state: 'hidden' })
        assert.deepEqual((await get(`/learning/goals/${goal.id}`)).tasks, [])
        dialog = await openGoal(goal.name, compact)
        await pointClick(dialog.getByRole('button', { name: '删除此计划', exact: true }), compact)
        confirm = confirmation('goal', compact)
        await readyDialog(confirm, compact)
        await pointClick(confirm.getByRole('button', { name: '确认删除', exact: true }), compact)
        await dialog.waitFor({ state: 'hidden' })
        await compact.getByRole('button', { name: `编辑学习目标 ${retained.name}`, exact: true }).waitFor()
      } finally { await narrow.close() }
    })
  }
  assert.deepEqual((await get('/learning/goals')).map((goal) => goal.id), [retained.id])
  assert.equal((await get(`/home?date=${today}`)).stats.total, 2)
  assert.deepEqual(errors, [], 'No unhandled browser errors')
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'passed', checks, screenshots, errors,
    fixtureDatabase: path.join(dataRoot, 'data', 'personal_data.db'), packaged: mode === '--packaged' }, null, 2), 'utf8')
  console.log(`PASS: ${checks.length} learning edit/delete scenarios; ${screenshots.length} screenshots; isolated database; no browser errors.`)
} catch (error) {
  if (page) await screenshot('failure').catch(() => {})
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'failed', checks, screenshots, errors, failure: String(error) }, null, 2), 'utf8')
  throw error
} finally {
  for (const release of releases) release()
  if (browser) await browser.close()
  server.kill()
  await writeFile(path.join(artifacts, 'backend.log'), log, 'utf8')
}
