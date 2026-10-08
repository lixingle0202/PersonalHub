import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// A real browser and a fresh, isolated database exercise deletion without touching personal data.
const [runtimePath, playwrightPath, outputPath, mode] = process.argv.slice(2)
if (!runtimePath || !playwrightPath || !outputPath || (mode && mode !== '--packaged')) {
  throw new Error('Usage: node scripts/test-diet-delete-browser.mjs <python-or-exe> <playwright-module> <artifacts> [--packaged]')
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(outputPath)
assert.ok(artifacts.startsWith(root + path.sep), 'Artifacts must stay inside the project')
await mkdir(artifacts, { recursive: true })
const dataRoot = path.join(artifacts, 'diet-delete-browser-data')
let existingDatabase = false
try { await access(path.join(dataRoot, 'data', 'personal_data.db')); existingDatabase = true } catch {}
assert.equal(existingDatabase, false, 'Use a fresh artifacts directory so every run starts with an empty test database')
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const baseUrl = `http://127.0.0.1:${port}`
const server = spawn(path.resolve(runtimePath), mode === '--packaged' ? [] : [
  '-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port),
], {
  cwd: root, windowsHide: true,
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
const geometry = []
const errors = []
const deletes = []
let browser
let page
let headers
let today
let releaseDelete

async function check(name, test) {
  await test()
  checks.push(name)
}
async function screenshot(name) {
  const filename = `${name}.png`
  await page.screenshot({ path: path.join(artifacts, filename), fullPage: false })
  screenshots.push(filename)
}
async function newPage(viewport = { width: 508, height: 590 }, deviceScaleFactor = 1) {
  const context = await browser.newContext({ viewport, deviceScaleFactor, timezoneId: 'Asia/Shanghai' })
  const next = await context.newPage()
  next.setDefaultTimeout(7000)
  next.on('pageerror', (error) => errors.push(error.message))
  next.on('request', (request) => {
    if (request.method() === 'DELETE') deletes.push(new URL(request.url()).pathname)
  })
  return next
}
async function get(endpoint) {
  const response = await page.request.get(`${baseUrl}/api/v1${endpoint}`)
  assert.ok(response.ok(), `GET failed: ${endpoint} ${await response.text()}`)
  return response.json()
}
async function post(endpoint, data) {
  const response = await page.request.post(`${baseUrl}/api/v1${endpoint}`, { headers, data })
  assert.ok(response.ok(), `Fixture creation failed: ${endpoint} ${await response.text()}`)
  return response.json()
}
async function calendar() {
  await page.goto(`${baseUrl}/diet`)
  await page.getByRole('table', { name: '饮食月历' }).waitFor()
}
async function editLunch() {
  // Deliberately do not wait for the editor's opening animation before pressing Delete.
  await page.getByLabel(`修改 ${today} 午餐`, { exact: true }).click()
  const editor = page.getByRole('dialog', { name: '修改饮食安排', exact: true })
  await editor.getByRole('button', { name: '删除这餐', exact: true }).click()
  return editor
}
async function confirmation(name) {
  // Test the user-visible confirmation behavior, regardless of the component used to render it.
  const dialog = page.getByRole('dialog', { name: '确认删除这餐？', exact: true })
    .or(page.getByRole('tooltip').filter({ hasText: '确认删除这餐？' }))
  await dialog.waitFor({ state: 'visible' })
  return dialog
}
async function pointerTarget(button, name) {
  // Wait only for the confirmation to paint; never scroll it or use locator.click on its controls.
  await button.evaluate((element) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000
    const painted = () => {
      if (performance.now() > deadline) { reject(new Error('Confirmation did not finish painting')); return }
      const modal = element.closest('.ant-modal, .ant-popover')
      if (!modal || (Number(getComputedStyle(modal).opacity) >= 0.99
        && modal.getAnimations().every((animation) => animation.playState !== 'running'))) resolve()
      else requestAnimationFrame(painted)
    }
    requestAnimationFrame(() => requestAnimationFrame(painted))
  }))
  const result = await button.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    return { rect: rect.toJSON(), x, y, viewport: { width: innerWidth, height: innerHeight },
      hit: hit?.outerHTML ?? null, hitButton: hit === element || element.contains(hit),
      disabled: element.disabled, pointerEvents: getComputedStyle(element).pointerEvents }
  })
  geometry.push({ name, ...result })
  assert.ok(result.rect.width > 0 && result.rect.height > 0 && result.rect.x >= 0 && result.rect.y >= 0
    && result.rect.right <= result.viewport.width && result.rect.bottom <= result.viewport.height,
  `The confirmation control must fit the viewport without automatic scrolling: ${JSON.stringify(result)}`)
  assert.equal(result.hitButton, true, `The visible control must receive pointer events: ${JSON.stringify(result)}`)
  return result
}
async function mouseClick(button, name) {
  const position = await pointerTarget(button, name)
  assert.equal(position.disabled, false, `${name} must be enabled`)
  await page.mouse.click(position.x, position.y)
}
async function assertDisabled(button, name) {
  assert.equal(await button.isDisabled(), true, `${name} must be disabled while deletion is pending`)
}
async function withTimeout(promise, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 7000)
    })])
  } finally { clearTimeout(timer) }
}

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
  page = await newPage()
  const bootstrap = await get('/bootstrap')
  assert.equal(path.resolve(bootstrap.database_path), path.join(dataRoot, 'data', 'personal_data.db'))
  headers = { 'X-Local-Token': bootstrap.local_token }
  today = await page.evaluate(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  const keepName = '保留的浏览器早餐'
  const lunchName = '删除回归测试午餐'
  const kept = await post('/diet/meals', { meal_date: today, meal_type: 'breakfast', custom_name: keepName })
  const failedMeal = await post('/diet/meals', { meal_date: today, meal_type: 'lunch', custom_name: lunchName })
  await page.context().close()

  for (const [width, height, scale] of [[508, 590, 2], [390, 590, 1], [1440, 1000, 1]]) {
    const name = `${width}x${height}-dpr${scale}`
    await check(`${name}: immediate Delete opens a clickable confirmation; cancel preserves unsaved edits`, async () => {
      page = await newPage({ width, height }, scale)
      await calendar()
      const beforeDeletes = deletes.length
      // Repeat rapid opening because the original layout failure depended on animation timing.
      let editor
      let dialog
      for (let attempt = 1; attempt <= 3; attempt++) {
        editor = await editLunch()
        dialog = await confirmation(`${name}-${attempt}`)
        await pointerTarget(dialog.getByRole('button', { name: /^确\s*认$/ }), `${name}-${attempt}-confirm`)
        await screenshot(`${name}-${attempt}-confirmation`)
        await mouseClick(dialog.getByRole('button', { name: /^取\s*消$/ }), `${name}-${attempt}-cancel`)
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(await editor.getByLabel('或填写其他餐食', { exact: true }).inputValue(), lunchName)
        if (attempt < 3) {
          await editor.getByRole('button', { name: '取消', exact: true }).click()
          await editor.waitFor({ state: 'hidden' })
        }
      }
      const draft = `未保存草稿-${name}`
      await editor.getByLabel('或填写其他餐食', { exact: true }).fill(draft)
      await editor.getByRole('button', { name: '删除这餐', exact: true }).click()
      dialog = await confirmation(`${name}-draft`)
      await mouseClick(dialog.getByRole('button', { name: /^取\s*消$/ }), `${name}-draft-cancel`)
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await editor.getByLabel('或填写其他餐食', { exact: true }).inputValue(), draft)
      assert.equal(deletes.length, beforeDeletes, 'Opening or cancelling confirmation must not send DELETE')
      assert.equal((await get(`/diet/meals?start_date=${today}&end_date=${today}`)).find((meal) => meal.id === failedMeal.id).custom_name, lunchName)
      await editor.getByRole('button', { name: '取消', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      await page.context().close()
    })
  }

  page = await newPage()
  await check('A failed DELETE preserves the meal and editor draft, then a real retry deletes only that meal', async () => {
    await calendar()
    const endpoint = `**/api/v1/diet/meals/${failedMeal.id}`
    await page.route(endpoint, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '浏览器模拟删除失败，请重试' }) })
    })
    const editor = await editLunch()
    let dialog = await confirmation('failed-delete')
    await mouseClick(dialog.getByRole('button', { name: /^取\s*消$/ }), 'failed-delete-cancel')
    await dialog.waitFor({ state: 'hidden' })
    const draft = '删除失败仍保留的草稿'
    await editor.getByLabel('或填写其他餐食', { exact: true }).fill(draft)
    await editor.getByRole('button', { name: '删除这餐', exact: true }).click()
    dialog = await confirmation('failed-delete-reopen')
    const beforeDeletes = deletes.length
    await mouseClick(dialog.getByRole('button', { name: /^确\s*认$/ }), 'failed-delete-confirm')
    await page.getByText('浏览器模拟删除失败，请重试', { exact: true }).waitFor()
    assert.equal(deletes.length, beforeDeletes + 1)
    assert.equal(await editor.getByLabel('或填写其他餐食', { exact: true }).inputValue(), draft)
    assert.ok((await get(`/diet/meals?start_date=${today}&end_date=${today}`)).some((meal) => meal.id === failedMeal.id))
    await screenshot('failed-delete-draft-preserved')
    await page.unroute(endpoint)
    if (!(await dialog.isVisible())) {
      await editor.getByRole('button', { name: '删除这餐', exact: true }).click()
      dialog = await confirmation('retry-delete')
    }
    await mouseClick(dialog.getByRole('button', { name: /^确\s*认$/ }), 'retry-delete-confirm')
    await editor.waitFor({ state: 'hidden' })
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(deletes.length, beforeDeletes + 2)
    const meals = await get(`/diet/meals?start_date=${today}&end_date=${today}`)
    assert.deepEqual(meals.map((meal) => meal.id), [kept.id])
    assert.equal(await page.getByText(lunchName, { exact: true }).count(), 0)
    assert.equal(await page.getByText(keepName, { exact: true }).count(), 1)
  })

  const delayedName = '延迟删除同步验收午餐'
  const delayedMeal = await post('/diet/meals', { meal_date: today, meal_type: 'lunch', custom_name: delayedName })
  await check('The meal is initially visible in calendar, home, today and global search', async () => {
    await calendar()
    await page.getByText(delayedName, { exact: true }).waitFor()
    await page.goto(`${baseUrl}/`)
    await page.getByText(`午餐：${delayedName}`, { exact: true }).waitFor()
    await page.goto(`${baseUrl}/today`)
    await page.getByText(`午餐：${delayedName}`, { exact: true }).waitFor()
    await page.getByLabel('全局搜索', { exact: true }).fill(delayedName)
    await page.locator('.global-search').getByRole('button').click()
    const search = page.getByRole('dialog', { name: `搜索“${delayedName}”`, exact: true })
    await search.getByRole('button').filter({ hasText: delayedName }).first().waitFor()
    assert.ok((await get(`/search?q=${encodeURIComponent(delayedName)}`)).length > 0)
  })
  await check('A delayed DELETE prevents repeat submission and closing/saving before successful removal', async () => {
    await calendar()
    let started
    const began = new Promise((resolve) => { started = resolve })
    const gate = new Promise((resolve) => { releaseDelete = resolve })
    const endpoint = `**/api/v1/diet/meals/${delayedMeal.id}`
    await page.route(endpoint, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      started()
      await gate
      await route.continue()
    })
    const editor = await editLunch()
    const dialog = await confirmation('pending-delete')
    const confirm = dialog.getByRole('button', { name: /^确\s*认$/ })
    const beforeDeletes = deletes.length
    const position = await pointerTarget(confirm, 'pending-delete-confirm')
    await page.mouse.click(position.x, position.y)
    await withTimeout(began, 'Pressing Confirm did not start the expected DELETE request')
    await assertDisabled(dialog.getByRole('button', { name: /^取\s*消$/ }), 'Confirmation cancel')
    await assertDisabled(editor.getByRole('button', { name: '保存修改', exact: true }), 'Editor save')
    await assertDisabled(editor.getByRole('button', { name: '取消', exact: true }), 'Editor cancel')
    // Native repeat clicks at the same coordinates must not create another DELETE.
    await page.mouse.click(position.x, position.y, { clickCount: 2 })
    await page.keyboard.press('Escape')
    assert.equal(await dialog.isVisible(), true, 'Escape must not close an in-progress deletion')
    assert.equal(await editor.isVisible(), true)
    assert.equal(deletes.length, beforeDeletes + 1)
    const close = dialog.getByRole('button', { name: /close|关闭/i })
    if (await close.count()) {
      assert.equal(await close.isDisabled(), true, 'Confirmation close must be disabled while deleting')
    }
    const editorClose = editor.getByRole('button', { name: /close|关闭/i })
    if (await editorClose.count()) {
      assert.equal(await editorClose.isDisabled(), true, 'Editor close must be disabled while deleting')
    }
    await screenshot('pending-delete-disabled-controls')
    releaseDelete()
    releaseDelete = undefined
    await editor.waitFor({ state: 'hidden' })
    await dialog.waitFor({ state: 'hidden' })
    await page.unroute(endpoint)
    assert.equal(deletes.length, beforeDeletes + 1)
    assert.equal(await page.getByText(delayedName, { exact: true }).count(), 0)
    assert.equal(await page.getByText(keepName, { exact: true }).count(), 1)
  })
  await check('Successful deletion persists and removes the meal from home, today and global search', async () => {
    assert.deepEqual((await get(`/diet/meals?start_date=${today}&end_date=${today}`)).map((meal) => meal.id), [kept.id])
    const home = await get(`/home?date=${today}`)
    assert.ok(!home.agenda.some((item) => item.source_id === delayedMeal.id))
    assert.ok(home.agenda.some((item) => item.source_id === kept.id))
    assert.ok(!(await get(`/agenda?date=${today}`)).some((item) => item.source_id === delayedMeal.id))
    assert.deepEqual(await get(`/search?q=${encodeURIComponent(delayedName)}`), [])
    await page.reload()
    await page.getByRole('table', { name: '饮食月历' }).waitFor()
    assert.equal(await page.getByText(delayedName, { exact: true }).count(), 0)
    await page.goto(`${baseUrl}/`)
    await page.getByText('今天，专注最重要的事', { exact: true }).waitFor()
    assert.equal(await page.getByText(`午餐：${delayedName}`, { exact: true }).count(), 0)
    await page.getByText(`早餐：${keepName}`, { exact: true }).waitFor()
    await page.goto(`${baseUrl}/today`)
    await page.getByText(`早餐：${keepName}`, { exact: true }).waitFor()
    assert.equal(await page.getByText(`午餐：${delayedName}`, { exact: true }).count(), 0)
    await page.getByLabel('全局搜索', { exact: true }).fill(delayedName)
    await page.locator('.global-search').getByRole('button').click()
    await page.getByRole('dialog', { name: `搜索“${delayedName}”`, exact: true }).getByText('没有找到匹配内容', { exact: true }).waitFor()
    await screenshot('deleted-meal-no-search-results')
  })
  assert.deepEqual(errors, [], 'No unhandled browser errors')
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'passed', checks, screenshots, geometry, deletes, errors }, null, 2), 'utf8')
  console.log(`PASS: ${checks.length} diet deletion browser scenarios; isolated fixture data; visible pointer targets; no browser errors.`)
} catch (error) {
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {})
  const surfaces = page && !page.isClosed() ? await page.locator('[role="dialog"], [role="tooltip"]').evaluateAll((elements) => elements.map((element) => ({
    role: element.getAttribute('role'), labelledBy: element.getAttribute('aria-labelledby'),
    label: element.getAttribute('aria-label'), title: element.querySelector('.ant-modal-title')?.textContent,
    visible: Boolean(element.getClientRects().length), buttons: [...element.querySelectorAll('button')].map((button) => ({
      text: button.textContent, ariaLabel: button.getAttribute('aria-label'), disabled: button.disabled,
    })),
  }))).catch(() => []) : []
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'failed', checks, screenshots, geometry, deletes, errors, surfaces, failure: String(error) }, null, 2), 'utf8')
  throw error
} finally {
  releaseDelete?.()
  if (browser) await browser.close()
  server.kill()
  await writeFile(path.join(artifacts, 'backend.log'), log, 'utf8')
}
