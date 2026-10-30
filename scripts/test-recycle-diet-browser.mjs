import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [python, playwright, output] = process.argv.slice(2)
if (!python || !playwright || !output) throw new Error('Usage: node scripts/test-recycle-diet-browser.mjs <python> <playwright-module> <fresh-artifacts>')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(output)
assert.ok(artifacts.startsWith(path.join(root, '.test-runtime') + path.sep))
try { await access(artifacts); throw new Error('Choose a fresh artifact directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(artifacts, { recursive: true })
const fixture = path.join(artifacts, 'fixture-data')
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`
const server = spawn(path.resolve(python), ['-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root, windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, 'backend'), PERSONAL_HUB_DATA_DIR: fixture, PERSONAL_HUB_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (chunk) => { log += chunk })
server.stderr.on('data', (chunk) => { log += chunk })
const { chromium } = createRequire(import.meta.url)(playwright)
const checks = [], screenshots = [], errors = []
let browser, page
async function shot(name) {
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled', fullPage: false })
  screenshots.push(`${name}.png`)
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS: ${name}`) }
async function api(endpoint, method = 'GET', data) {
  const response = await page.request.fetch(`${base}/api/v1${endpoint}`, { method, headers, data })
  assert.ok(response.ok(), `${method} ${endpoint}: ${await response.text()}`)
  return response.status() === 204 ? null : response.json()
}
let headers
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + '/health')).ok) break } catch {}
    if (server.exitCode !== null) throw new Error(log)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const bootstrap = await (await page.request.get(base + '/api/v1/bootstrap')).json()
  assert.equal(path.resolve(bootstrap.database_path), path.join(fixture, 'data', 'personal_data.db'))
  headers = { 'X-Local-Token': bootstrap.local_token }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const goal = await api('/learning/goals', 'POST', { name: '高频电子线路完整学习计划', goal: '分阶段完成谐振计算与调幅波形辨析' })
  const section = await api(`/learning/goals/${goal.id}/sections`, 'POST', { name: 'LC谐振与调幅' })
  const first = await api(`/learning/goals/${goal.id}/tasks`, 'POST', { title: '计算LC谐振频率', details: '代入电感和电容量，核对单位与数量级', section_id: section.id, plan_date: today, estimated_minutes: 45 })
  const second = await api(`/learning/goals/${goal.id}/tasks`, 'POST', { title: '辨析过调制波形', details: '标注包络、载波和失真部位', plan_date: today })
  await api(`/agenda/${first.agenda_id}/complete`, 'POST')
  await api(`/learning/goals/${goal.id}/sessions`, 'POST', { studied_on: today, actual_minutes: 45, notes: '完成一个谐振计算例题' })
  await api(`/learning/goals/${goal.id}/resources`, 'POST', { name: '电路学习笔记', notes: '记录公式、单位和错因' })
  await api(`/learning/goals/${goal.id}`, 'DELETE')
  const meal = await api('/diet/meals', 'POST', { meal_date: today, meal_type: 'dinner', custom_name: '农家小炒肉' })
  assert.equal(meal.display_kcal, 532)
  const shopping = await api('/diet/shopping-lists/generate', 'POST', { name: '本月采购', start_date: today.slice(0, 8) + '01', end_date: today })
  const egg = await api(`/diet/shopping-lists/${shopping.id}/items`, 'POST', { ingredient_name: '鸡蛋', quantity_text: '10个' })
  const tomato = await api(`/diet/shopping-lists/${shopping.id}/items`, 'POST', { ingredient_name: '番茄', quantity_text: '2斤' })

  await check('Generated shopping list has a working delete control, confirmation and cancel', async () => {
    await page.goto(base + '/diet')
    await page.getByRole('tab', { name: '购物清单', exact: true }).click()
    await page.getByRole('button', { name: '删除购物清单 本月采购', exact: true }).click()
    let confirmation = page.getByRole('tooltip')
    await confirmation.getByRole('button', { name: /取\s*消/ }).click()
    assert.equal((await api('/diet/shopping-lists')).length, 1)
    await page.getByRole('button', { name: '删除购物清单 本月采购', exact: true }).click()
    confirmation = page.getByRole('tooltip')
    const deleted = page.waitForResponse((response) => response.url().endsWith(`/diet/shopping-lists/${shopping.id}`) && response.request().method() === 'DELETE')
    await confirmation.getByRole('button', { name: /确\s*认/ }).click()
    assert.ok((await deleted).ok())
    await page.getByRole('button', { name: '删除购物清单 本月采购', exact: true }).waitFor({ state: 'hidden' })
    assert.equal((await api('/diet/meals?start_date=' + today + '&end_date=' + today)).length, 1)
  })

  await check('Recycle bin starts with learning and diet categories, then opens the complete plan', async () => {
    await page.goto(base + '/settings')
    await page.getByRole('button', { name: '查看学习回收站', exact: true }).waitFor()
    await page.getByRole('button', { name: '查看饮食回收站', exact: true }).waitFor()
    await shot('recycle-categories')
    await page.getByRole('button', { name: '查看学习回收站', exact: true }).click()
    await page.getByRole('article', { name: goal.name, exact: true }).getByRole('button', { name: '查看内容', exact: true }).click()
    const modal = page.getByRole('dialog')
    await modal.getByText(first.details, { exact: true }).waitFor()
    await shot('learning-plan-detail')
  })

  await check('One task restores its plan, stage and completed agenda while other tasks remain deleted', async () => {
    await page.getByRole('article', { name: first.title, exact: true }).getByRole('button', { name: '恢复此项', exact: true }).click()
    await page.getByRole('article', { name: first.title, exact: true }).waitFor({ state: 'hidden' })
    let detail = await api(`/learning/goals/${goal.id}`)
    assert.deepEqual(detail.tasks.map((item) => item.id), [first.id])
    assert.equal(detail.tasks[0].status, 'completed')
    assert.equal(detail.sections[0].id, section.id)
    await page.reload()
    await page.getByRole('button', { name: '查看学习回收站', exact: true }).click()
    const row = page.getByRole('article', { name: goal.name, exact: true })
    assert.equal(await row.getByRole('button', { name: '永久删除计划', exact: true }).count(), 0)
    await row.getByRole('button', { name: '恢复整个计划', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    detail = await api(`/learning/goals/${goal.id}`)
    assert.deepEqual(new Set(detail.tasks.map((item) => item.id)), new Set([first.id, second.id]))
  })

  await check('Shopping items can be restored singly, then as an entire list', async () => {
    await page.getByRole('button', { name: '查看饮食回收站', exact: true }).click()
    await page.getByRole('article', { name: shopping.name, exact: true }).getByRole('button', { name: '查看内容', exact: true }).click()
    await shot('shopping-list-detail')
    await page.getByRole('article', { name: '鸡蛋', exact: true }).getByRole('button', { name: '恢复此项', exact: true }).click()
    await page.getByRole('article', { name: '鸡蛋', exact: true }).waitFor({ state: 'hidden' })
    assert.deepEqual((await api('/diet/shopping-lists'))[0].items.map((item) => item.id), [egg.id])
    await page.getByRole('button', { name: '恢复整个清单', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.deepEqual(new Set((await api('/diet/shopping-lists'))[0].items.map((item) => item.id)), new Set([egg.id, tomato.id]))
  })

  await check('Editing a complex meal shows ingredient details and updates calories after changing portions', async () => {
    await page.goto(base + '/diet')
    await page.getByRole('button', { name: `修改 ${today} 晚餐`, exact: true }).click()
    const modal = page.getByRole('dialog', { name: '修改饮食安排', exact: true })
    await modal.getByText('本餐约 532 kcal · 参考配方', { exact: true }).waitFor()
    const saveBox = await modal.getByRole('button', { name: '保存修改', exact: true }).boundingBox()
    assert.ok(saveBox && saveBox.y + saveBox.height <= page.viewportSize().height, 'Save remains visible while calorie details scroll')
    await modal.getByText('本餐约 532 kcal · 参考配方', { exact: true }).scrollIntoViewIfNeeded()
    await shot('complex-meal-calories')
    await modal.getByLabel('本餐用餐份数', { exact: true }).fill('0.5')
    await modal.getByText('本餐约 266 kcal · 参考配方', { exact: true }).waitFor()
    await modal.getByRole('button', { name: '保存修改', exact: true }).click()
    await modal.waitFor({ state: 'hidden' })
    assert.equal((await api('/diet/meals?start_date=' + today + '&end_date=' + today))[0].display_kcal, 266)
  })

  await check('Grouped recovery remains usable at phone width in dark mode', async () => {
    await api(`/learning/goals/${goal.id}`, 'DELETE')
    await api('/settings', 'PATCH', { theme_mode: 'dark' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(base + '/settings')
    await page.getByRole('button', { name: '查看学习回收站', exact: true }).click()
    await page.getByRole('article', { name: goal.name, exact: true }).getByRole('button', { name: '查看内容', exact: true }).click()
    await page.getByRole('dialog').getByText(first.details, { exact: true }).waitFor()
    assert.ok(await page.locator('body').evaluate((element) => element.classList.contains('dark-mode')))
    const modal = page.getByRole('dialog')
    assert.ok(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth + 2))
    await shot('phone-dark-plan-detail')
  })
  assert.deepEqual(errors, [])
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'passed', checks, screenshots, errors, fixture }, null, 2))
  console.log(`PASS: ${checks.length} browser acceptance scenarios`)
} catch (error) {
  if (page) await shot('failure').catch(() => {})
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'failed', checks, screenshots, errors, failure: String(error) }, null, 2))
  throw error
} finally {
  if (browser) await browser.close()
  server.kill()
  await writeFile(path.join(artifacts, 'backend.log'), log)
}
