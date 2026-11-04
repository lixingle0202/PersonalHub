import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [python, playwright, output] = process.argv.slice(2)
if (!python || !playwright || !output) throw new Error('Usage: node scripts/test-meal-food-browser.mjs <python> <playwright-module> <fresh-artifacts>')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(output)
assert.ok(artifacts.startsWith(path.join(root, '.test-runtime') + path.sep))
try { await access(artifacts); throw new Error('Choose a fresh directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(artifacts, { recursive: true })
const fixture = path.join(artifacts, 'isolated-data')
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`
const server = spawn(path.resolve(python), ['-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root, windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, 'backend'), PERSONAL_HUB_DATA_DIR: fixture, PERSONAL_HUB_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = '', browser, page, headers
const checks = [], errors = []
server.stdout.on('data', (chunk) => { log += chunk })
server.stderr.on('data', (chunk) => { log += chunk })
const { chromium } = createRequire(import.meta.url)(playwright)
async function api(endpoint, method = 'GET', data) {
  const response = await page.request.fetch(`${base}/api/v1${endpoint}`, { method, headers, data })
  assert.ok(response.ok(), `${method} ${endpoint}: ${await response.text()}`)
  return response.json()
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS: ' + name) }
async function save(dialog, name, method, ending) {
  const result = page.waitForResponse((response) => response.request().method() === method && response.url().endsWith(ending))
  await dialog.getByRole('button', { name, exact: true }).click()
  const response = await result
  assert.ok(response.ok(), await response.text())
  const meal = await response.json()
  await dialog.waitFor({ state: 'hidden' })
  return meal
}
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(base + '/health')).ok } catch {}
    if (ready) break
    if (server.exitCode !== null) throw new Error(log)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(ready, 'Isolated server did not start')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', (error) => errors.push(error.message))
  const bootstrap = await (await page.request.get(base + '/api/v1/bootstrap')).json()
  assert.equal(path.resolve(bootstrap.database_path), path.join(fixture, 'data', 'personal_data.db'))
  headers = { 'X-Local-Token': bootstrap.local_token }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const savedDish = await api('/diet/dishes', 'POST', { name: '自制番茄炒蛋', estimated_kcal: 200 })
  let meal
  await check('Space-separated foods show individual calories and the same saved meal total', async () => {
    await page.goto(base + '/diet')
    await page.getByRole('button', { name: '安排一餐', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '安排一餐' })
    await dialog.getByLabel('餐次', { exact: true }).selectOption('lunch')
    await dialog.getByLabel('或填写其他餐食', { exact: true }).fill('米饭200g 西红柿炒鸡蛋')
    await dialog.getByText('本餐约 525 kcal · 多菜品估算', { exact: true }).waitFor()
    assert.equal(await dialog.getByRole('list', { name: '本餐热量明细' }).getByRole('listitem').count(), 2)
    meal = await save(dialog, '创建', 'POST', '/diet/meals')
    assert.equal(meal.display_kcal, 525)
    assert.equal(meal.calorie_items.length, 2)
  })
  await check('Additional dish rows support grams, common dish selection, editing and removal', async () => {
    await page.getByLabel(`修改 ${today} 午餐`, { exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '修改饮食安排' })
    await dialog.getByLabel('或填写其他餐食', { exact: true }).fill('米饭200g')
    await dialog.getByRole('button', { name: '＋ 添加一道菜或主食', exact: true }).click()
    await dialog.getByLabel('第2项餐食', { exact: true }).fill('蛋炒饭200g')
    await dialog.getByRole('button', { name: '选择菜品', exact: true }).click()
    await dialog.getByRole('checkbox', { name: savedDish.name, exact: true }).check()
    const expected = await api('/diet/calories/estimate', 'POST', { dish_ids: [savedDish.id], custom_name: '米饭200g\n蛋炒饭200g' })
    await dialog.getByText(`本餐约 ${expected.display_kcal} kcal · 多菜品估算`, { exact: true }).waitFor()
    await page.screenshot({ path: path.join(artifacts, 'multiple-food-calories.png') })
    meal = await save(dialog, '保存修改', 'PATCH', '/diet/meals/' + meal.id)
    assert.equal(meal.display_kcal, expected.display_kcal)
    assert.equal(meal.calorie_items.length, 3)
    assert.equal(meal.custom_name, '米饭200g\n蛋炒饭200g')
    await page.reload()
    await page.getByLabel(`修改 ${today} 午餐`, { exact: true }).click()
    dialog = page.getByRole('dialog', { name: '修改饮食安排' })
    assert.equal(await dialog.getByLabel('第2项餐食', { exact: true }).inputValue(), '蛋炒饭200g')
    await dialog.getByRole('button', { name: '移除第2项餐食', exact: true }).click()
    await dialog.getByText('本餐约 460 kcal · 多菜品估算', { exact: true }).waitFor()
    meal = await save(dialog, '保存修改', 'PATCH', '/diet/meals/' + meal.id)
    assert.equal(meal.display_kcal, 460)
  })
  await check('Official food catalog search works with attribution and food weights', async () => {
    await page.getByLabel(`修改 ${today} 午餐`, { exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '修改饮食安排' })
    await dialog.getByLabel('或填写其他餐食', { exact: true }).fill('小笼')
    await page.getByText(/^小笼包 · \d+ kcal\/100克$/).click()
    await dialog.getByLabel('或填写其他餐食', { exact: true }).fill('小笼包200g')
    const expected = await api('/diet/calories/estimate', 'POST', { dish_ids: [savedDish.id], custom_name: '小笼包200g' })
    await dialog.getByText(`本餐约 ${expected.display_kcal} kcal · 多菜品估算`, { exact: true }).waitFor()
    assert.equal(expected.calorie_items[1].source, '食物数据库')
    await dialog.getByRole('link', { name: '食物数据来源：食品药物管理署' }).waitFor()
    meal = await save(dialog, '保存修改', 'PATCH', '/diet/meals/' + meal.id)
  })
  await check('Linked diet and learning tasks can move between necessity groups', async () => {
    const goal = await api('/learning/goals', 'POST', { name: '英语练习', goal: '完成口语练习' })
    const task = await api(`/learning/goals/${goal.id}/tasks`, 'POST', { title: '口语对话', plan_date: today })
    await page.goto(base + '/today')
    for (const [id, bucket] of [[meal.agenda_id, 'must'], [task.agenda_id, 'optional']]) {
      const agenda = await api('/agenda/' + id)
      await page.getByRole('button', { name: '调整必要程度：' + agenda.title, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '调整必要程度' })
      await dialog.getByLabel('必要程度', { exact: true }).selectOption(bucket)
      await dialog.getByRole('button', { name: '保存分类', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal((await api('/agenda/' + id)).bucket, bucket)
    }
    await page.reload()
    await page.getByText('必须完成 · 1', { exact: true }).waitFor()
    await page.getByText('有空再做 · 1', { exact: true }).waitFor()
    await page.screenshot({ path: path.join(artifacts, 'linked-plan-classification.png') })
  })
  await check('Requested page copy is removed while input and short learning introduction remain', async () => {
    await page.goto(base)
    await page.getByLabel('描述这一天做过的事情').waitFor()
    assert.ok(!(await page.locator('body').innerText()).includes('说说这一天实际做了什么'))
    await page.goto(base + '/learning')
    await page.getByText('从长期目标拆到章节和任务', { exact: true }).waitFor()
    assert.ok(!(await page.locator('body').innerText()).includes('点击目标或任务可修改'))
  })
  await check('Food rows and fixed save controls fit a dark phone viewport', async () => {
    await api('/settings', 'PATCH', { theme_mode: 'dark' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(base + '/diet')
    await page.getByLabel(`修改 ${today} 午餐`, { exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '修改饮食安排' })
    await dialog.getByRole('button', { name: '＋ 添加一道菜或主食', exact: true }).click()
    await dialog.getByLabel('第2项餐食', { exact: true }).fill('蛋炒饭200g')
    await dialog.getByRole('list', { name: '本餐热量明细' }).scrollIntoViewIfNeeded()
    const saveButton = await dialog.getByRole('button', { name: '保存修改', exact: true }).boundingBox()
    assert.ok(saveButton.y >= 0 && saveButton.y + saveButton.height <= 844)
    assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    await page.screenshot({ path: path.join(artifacts, 'phone-multiple-food-calories.png') })
  })
  assert.deepEqual(errors, [])
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2))
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'failed', checks, errors, failure: String(error) }, null, 2))
  throw error
} finally {
  await browser?.close(); server.kill()
  await writeFile(path.join(artifacts, 'backend.log'), log)
}
