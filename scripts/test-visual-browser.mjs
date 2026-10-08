import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Use an isolated application and real browser rendering. Formal personal data is never read or changed.
const [runtimePath, playwrightPath, outputPath, mode] = process.argv.slice(2)
if (!runtimePath || !playwrightPath || !outputPath || (mode && mode !== '--packaged')) {
  throw new Error('Usage: node scripts/test-visual-browser.mjs <python-or-exe> <playwright-module> <artifacts> [--packaged]')
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(outputPath)
assert.ok(artifacts.startsWith(root + path.sep), 'Artifacts must stay inside the project')
await mkdir(artifacts, { recursive: true })
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const baseUrl = `http://127.0.0.1:${port}`
const dataRoot = path.join(artifacts, 'visual-browser-data')
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
const errors = []
let browser
let page
async function check(name, test) {
  await test()
  checks.push(name)
}
async function screenshot(name, target = page) {
  await target.evaluate(() => document.fonts.ready)
  await target.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  // A visible dialog can precede rc-motion's first animation frame. Wait for its painted surface.
  await target.waitForFunction(() => [...document.querySelectorAll('.ant-modal')]
    .filter((element) => element.getClientRects().length)
    .every((element) => Number(getComputedStyle(element).opacity) >= 0.99))
  const hasDialog = await target.getByRole('dialog').count() > 0 && await target.getByRole('dialog').last().isVisible()
  const filename = `${name}.png`
  await target.screenshot({ path: path.join(artifacts, filename), fullPage: !hasDialog, animations: 'disabled' })
  screenshots.push(filename)
}
async function noPageOverflow(target = page) {
  const dimensions = await target.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
  }))
  assert.ok(Math.max(dimensions.body, dimensions.document) <= dimensions.viewport + 2,
    `The page must fit its viewport: ${JSON.stringify(dimensions)}`)
}
async function visibleFocus(locator) {
  await locator.focus()
  await page.keyboard.press('Tab')
  const state = await page.evaluate(() => {
    const element = document.activeElement
    const style = getComputedStyle(element)
    return { visible: element.matches(':focus-visible'), outline: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth), shadow: style.boxShadow, tag: element.tagName }
  })
  assert.ok(state.visible, `Keyboard navigation must show a focus-visible target: ${JSON.stringify(state)}`)
  assert.ok((state.outline !== 'none' && state.outlineWidth >= 1) || state.shadow !== 'none',
    `Keyboard focus needs a visible outline or shadow: ${JSON.stringify(state)}`)
}
// This samples computed colors of visible content, including translucent ancestor surfaces.
// It supplements human screenshot inspection; it does not claim to audit every possible gradient pixel.
async function readableContent(target = page) {
  const samples = await target.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    function rgba(value) {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const color = context.getImageData(0, 0, 1, 1).data
      return [color[0], color[1], color[2], color[3] / 255]
    }
    function composite(front, back) {
      return [0, 1, 2].map((index) => front[index] * front[3] + back[index] * (1 - front[3])).concat(1)
    }
    function luminance(color) {
      const channels = color.slice(0, 3).map((value) => {
        const c = value / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    }
    const selectors = ['.page-title', '.page-subtitle', '.ant-card-head-title', '.ant-card .ant-typography-secondary',
      '.calendar-meal span', '.calendar-empty .ant-typography-secondary', '.ant-btn-primary:not(:disabled)',
      '.header-save-status .ant-tag', '.agenda-main .ant-tag-red', '.agenda-main a', '.ant-tabs-tab-active .ant-tabs-tab-btn']
    const result = []
    for (const selector of selectors) {
      const element = [...document.querySelectorAll(selector)].find((candidate) => candidate.getClientRects().length && candidate.textContent.trim())
      if (!element) continue
      const ancestors = []
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor)
      let background = [255, 255, 255, 1]
      for (const ancestor of ancestors) {
        background = composite(rgba(getComputedStyle(ancestor).backgroundColor), background)
        // The fixed wallpaper is a real painted layer behind the app, including its dark base.
        if (ancestor === document.body) {
          const wallpaper = getComputedStyle(ancestor, '::before')
          if (wallpaper.content !== 'none') background = composite(rgba(wallpaper.backgroundColor), background)
        }
      }
      const style = getComputedStyle(element)
      const foreground = composite(rgba(style.color), background)
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
      const fontSize = parseFloat(style.fontSize)
      const large = fontSize >= 24 || (fontSize >= 18.66 && Number(style.fontWeight) >= 700)
      result.push({ selector, className: element.className, text: element.textContent.trim().slice(0, 30), color: style.color, background,
        ratio: (values[0] + 0.05) / (values[1] + 0.05), minimum: large ? 3 : 4.5 })
    }
    return result
  })
  assert.ok(samples.length >= 2, 'Readable content samples should exist')
  const unreadable = samples.filter((sample) => sample.ratio < sample.minimum)
  assert.deepEqual(unreadable, [], `Insufficient text contrast: ${JSON.stringify(unreadable)}`)
  return samples
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const bootstrap = await (await page.request.get(`${baseUrl}/api/v1/bootstrap`)).json()
  assert.equal(path.resolve(bootstrap.database_path), path.join(dataRoot, 'data', 'personal_data.db'))
  const headers = { 'X-Local-Token': bootstrap.local_token }
  const today = await page.evaluate(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  async function post(endpoint, data) {
    const response = await page.request.post(`${baseUrl}/api/v1${endpoint}`, { headers, data })
    assert.ok(response.ok(), `Fixture creation failed: ${endpoint} ${await response.text()}`)
    return response.json()
  }
  const goal = await post('/learning/goals', { name: 'Android 界面与交互', goal: '完成一个清晰、流畅的个人效率应用', start_date: today, target_date: today, estimated_minutes: 180 })
  await post(`/learning/goals/${goal.id}/sections`, { name: '梳理界面层级', is_completed: true })
  await post(`/learning/goals/${goal.id}/sections`, { name: '实现交互与测试' })
  await post(`/learning/goals/${goal.id}/tasks`, { title: '练习界面布局与状态反馈', plan_date: today, priority: 'high' })
  await post('/agenda', { title: '整理今天的三件重要小事', plan_date: today, bucket: 'must', priority: 'high' })
  await post('/quick-notes', { content: '把灵感留下来，慢慢做成喜欢的样子。' })
  const meal = await post('/diet/meals', { meal_date: today, meal_type: 'lunch', custom_name: '香煎鸡胸肉蔬菜沙拉' })
  await post('/diet/meals', { meal_date: today, meal_type: 'breakfast', custom_name: '燕麦酸奶与蓝莓', actual_food: '燕麦酸奶与蓝莓' })
  await post('/diet/meals', { meal_date: today, meal_type: 'dinner', custom_name: '番茄菌菇意面' })
  await post('/diet/dishes', { name: '香煎鸡胸肉蔬菜沙拉', instructions: '鸡胸肉煎至熟透，搭配新鲜蔬菜。', ingredients: [{ name: '鸡胸肉', quantity: 150, unit: 'g' }, { name: '生菜', quantity: 1, unit: '份' }] })

  const routes = [
    { path: '/', label: '首页总览', ready: () => page.getByText('今天，专注最重要的事', { exact: true }) },
    { path: '/today', label: '今日计划', ready: () => page.getByText('整理今天的三件重要小事', { exact: true }) },
    { path: '/learning', label: '学习计划', ready: () => page.getByRole('tab', { name: '学习路线', exact: true }) },
    { path: '/diet', label: '饮食计划', ready: () => page.getByRole('table', { name: '饮食月历' }) },
    { path: '/settings', label: '数据与设置', ready: () => page.getByRole('tab', { name: '数据管理', exact: true }) },
  ]
  const contrast = {}
  await check('All five light pages render with working selected navigation and readable text', async () => {
    for (const route of routes) {
      await page.goto(`${baseUrl}${route.path}`)
      await route.ready().waitFor()
      await page.locator('.app-sidebar').getByRole('link', { name: route.label, exact: true }).waitFor()
      assert.equal(await page.locator('.app-sidebar').getByRole('link', { name: route.label, exact: true }).getAttribute('aria-current'), 'page', `Navigation selection for ${route.path}`)
      await noPageOverflow()
      contrast[`light${route.path}`] = await readableContent()
      await screenshot(`light-${route.path.slice(1) || 'home'}`)
    }
  })
  await check('Keyboard can enter navigation, show focus, open a dialog and dismiss it with Escape', async () => {
    await page.goto(`${baseUrl}/`)
    await routes[0].ready().waitFor()
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('.skip-link').evaluate((element) => element === document.activeElement), true)
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('#main-content').evaluate((element) => element === document.activeElement), true)
    await visibleFocus(page.locator('.app-sidebar').getByRole('link', { name: '首页总览', exact: true }))
    await page.getByRole('button', { name: '快速新增', exact: true }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '快速新增', exact: true })
    await dialog.waitFor()
    await dialog.locator(':focus').waitFor()
    await screenshot('quick-create-dialog')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
  })
  await check('Secondary tabs and the AI form use the same visual system', async () => {
    await page.goto(`${baseUrl}/learning`)
    await routes[2].ready().waitFor()
    await page.getByRole('tab', { name: '学习任务', exact: true }).click()
    await page.getByText(/练习界面布局与状态反馈/).waitFor()
    await screenshot('light-learning-tasks')
    await page.getByRole('button', { name: 'AI 生成学习计划', exact: true }).click()
    const generator = page.getByRole('dialog', { name: 'AI 生成学习计划', exact: true })
    await generator.getByLabel('学习主题', { exact: true }).waitFor()
    await generator.getByText('请先配置本地模型', { exact: true }).waitFor()
    await screenshot('light-ai-generator')
    await generator.getByRole('button', { name: '取消等待', exact: true }).click()
    await page.goto(`${baseUrl}/diet`)
    await routes[3].ready().waitFor()
    for (const tab of ['常用菜品', '购物清单', '每日记录']) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await screenshot(`light-diet-${tab}`)
    }
    await page.goto(`${baseUrl}/settings`)
    await routes[4].ready().waitFor()
    for (const tab of ['个性化设置', '本地大模型']) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await screenshot(`light-settings-${tab}`)
    }
  })
  await check('Restyled quick-create validates required input and creates a persisted item', async () => {
    await page.getByRole('button', { name: '快速新增', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '快速新增', exact: true })
    await dialog.getByRole('button', { name: /^创\s*建$/ }).click()
    await dialog.locator('.ant-form-item-explain-error').waitFor()
    assert.equal((await (await page.request.get(`${baseUrl}/api/v1/agenda?date=${today}`)).json()).length, 5)
    await dialog.getByLabel('标题或内容', { exact: true }).fill('键盘与表单验收计划')
    await dialog.getByRole('button', { name: /^创\s*建$/ }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.goto(`${baseUrl}/today`)
    await page.getByText('键盘与表单验收计划', { exact: true }).waitFor()
    const completion = page.waitForResponse((response) => response.url().endsWith('/complete') && response.request().method() === 'POST')
    await page.getByLabel('完成 键盘与表单验收计划', { exact: true }).click()
    assert.ok((await completion).ok())
    const saved = await (await page.request.get(`${baseUrl}/api/v1/agenda?date=${today}`)).json()
    assert.equal(saved.find((item) => item.title === '键盘与表单验收计划').status, 'completed')
  })
  await check('Restyled calendar still supports expansion, editing and deletion across modules', async () => {
    await page.goto(`${baseUrl}/diet`)
    await routes[3].ready().waitFor()
    const cell = page.getByRole('cell', { name: today, exact: true })
    assert.equal(await cell.getAttribute('aria-current'), 'date')
    await cell.getByRole('button', { name: '另有 1 餐', exact: true }).click()
    await cell.getByRole('button', { name: '收起', exact: true }).waitFor()
    await page.getByLabel(`修改 ${today} 午餐`, { exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '修改饮食安排', exact: true })
    await dialog.getByLabel('或填写其他餐食', { exact: true }).fill('视觉验收午餐')
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const home = await (await page.request.get(`${baseUrl}/api/v1/home?date=${today}`)).json()
    assert.equal(home.agenda.find((item) => item.source_id === meal.id).title, '午餐：视觉验收午餐')
    await page.getByLabel(`修改 ${today} 午餐`, { exact: true }).click()
    dialog = page.getByRole('dialog', { name: '修改饮食安排', exact: true })
    await dialog.getByRole('button', { name: '删除这餐', exact: true }).click()
    await page.getByRole('button', { name: /^确\s*认$/ }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(await (await page.request.get(`${baseUrl}/api/v1/search?q=${encodeURIComponent('视觉验收午餐')}`)).json(), [])
    const agenda = await (await page.request.get(`${baseUrl}/api/v1/agenda?date=${today}`)).json()
    assert.ok(!agenda.some((item) => item.source_id === meal.id))
  })
  await check('Theme controls update all pages and dialogs, and survive refresh', async () => {
    await page.goto(`${baseUrl}/settings`)
    await page.getByRole('tab', { name: '个性化设置', exact: true }).click()
    await page.getByLabel('深色模式', { exact: true }).click()
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByText('设置已保存', { exact: true }).waitFor()
    assert.ok(await page.locator('body.dark-mode').count())
    const rootBackground = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
    const rootChannels = rootBackground.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
    assert.ok(rootChannels.length === 3 && Math.max(...rootChannels) < 100,
      `The document background must also be dark below the wallpaper: ${rootBackground}`)
    await page.reload()
    await page.getByRole('tab', { name: '数据管理', exact: true }).waitFor()
    assert.ok(await page.locator('body.dark-mode').count())
    for (const route of routes) {
      await page.goto(`${baseUrl}${route.path}`)
      await route.ready().waitFor()
      contrast[`dark${route.path}`] = await readableContent()
      await screenshot(`dark-${route.path.slice(1) || 'home'}`)
    }
    await page.getByRole('button', { name: '快速新增', exact: true }).click()
    await page.getByRole('dialog', { name: '快速新增', exact: true }).waitFor()
    await screenshot('dark-dialog')
    await page.keyboard.press('Escape')
    const saved = await (await page.request.get(`${baseUrl}/api/v1/settings`)).json()
    assert.equal(saved.theme_mode, 'dark')
    await page.request.patch(`${baseUrl}/api/v1/settings`, { headers, data: { theme_mode: 'light' } })
  })
  await check('Desktop, compact and phone layouts contain overflow within the calendar', async () => {
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 900 })
      for (const route of routes) {
        await page.goto(`${baseUrl}${route.path}`)
        await route.ready().waitFor()
        await noPageOverflow()
        if (width === 390 && route.path === '/learning') {
          const title = page.locator('.ant-card-head-title').filter({ hasText: goal.name })
          const dimensions = await title.evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth,
            card: element.closest('.ant-card').clientWidth }))
          assert.ok(dimensions.width >= dimensions.card * 0.75 && dimensions.content <= dimensions.width + 1,
            `The goal title must remain readable beside progress controls: ${JSON.stringify(dimensions)}`)
        }
        await screenshot(`${width}-${route.path.slice(1) || 'home'}`)
      }
      await page.goto(`${baseUrl}/diet`)
      await routes[3].ready().waitFor()
      const scroll = await page.locator('.diet-calendar-scroll').evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth, overflow: getComputedStyle(element).overflowX }))
      assert.ok(['auto', 'scroll'].includes(scroll.overflow), 'Calendar overflow must be contained in a scrolling region')
      if (width === 390) assert.ok(scroll.content > scroll.width, 'The phone calendar should remain readable with local horizontal scrolling')
      await page.getByRole('button', { name: '安排一餐', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '安排一餐', exact: true })
      await dialog.waitFor()
      const box = await dialog.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= width + 2, `Dialog fits ${width}px viewport`)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await page.goto(`${baseUrl}/settings`)
      await routes[4].ready().waitFor()
      await page.getByRole('tab', { name: '个性化设置', exact: true }).click()
      await noPageOverflow()
      await screenshot(`${width}-settings-preferences`)
      await page.goto(`${baseUrl}/learning`)
      await routes[2].ready().waitFor()
      await page.getByRole('button', { name: 'AI 生成学习计划', exact: true }).click()
      const generator = page.getByRole('dialog', { name: 'AI 生成学习计划', exact: true })
      await generator.getByLabel('学习主题', { exact: true }).waitFor()
      const generatorBox = await generator.boundingBox()
      assert.ok(generatorBox.x >= 0 && generatorBox.x + generatorBox.width <= width + 2, `AI dialog fits ${width}px viewport`)
      await screenshot(`${width}-ai-generator`)
      await generator.getByRole('button', { name: '生成草稿', exact: true }).scrollIntoViewIfNeeded()
      const footer = await generator.getByRole('button', { name: '生成草稿', exact: true }).boundingBox()
      assert.ok(footer.y >= 0 && footer.y + footer.height <= 902, `The AI dialog footer is reachable at ${width}px`)
      if (width === 390) await screenshot('390-ai-generator-footer')
      await generator.getByRole('button', { name: '取消等待', exact: true }).click()
    }
    await page.setViewportSize({ width: 1440, height: 1050 })
  })
  await check('Reduced motion disables decorative transitions without blocking controls', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`${baseUrl}/`)
    await routes[0].ready().waitFor()
    const durations = await page.locator('.ant-btn, .app-sidebar, .home-plan-overview').evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element)
      return { transition: style.transitionDuration, animation: style.animationDuration }
    }))
    for (const duration of durations) {
      const milliseconds = (value) => value.split(',').map((part) => parseFloat(part) * (part.trim().endsWith('ms') ? 1 : 1000))
      assert.ok(milliseconds(duration.transition).every((value) => value <= 10), `Reduced transition: ${JSON.stringify(duration)}`)
      assert.ok(milliseconds(duration.animation).every((value) => value <= 10), `Reduced animation: ${JSON.stringify(duration)}`)
    }
    await page.getByRole('button', { name: '快速新增', exact: true }).click()
    await page.getByRole('dialog', { name: '快速新增', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })
  await check('Reduced transparency uses opaque chrome while keeping content readable', async () => {
    const client = await context.newCDPSession(page)
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
    assert.ok(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches), 'Browser must emulate the reduced-transparency preference')
    await page.goto(`${baseUrl}/`)
    await routes[0].ready().waitFor()
    const materials = await page.locator('.app-sidebar, .app-header, .ant-card').evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, filter: style.backdropFilter }
    }))
    for (const material of materials) {
      const values = material.background.match(/[\d.]+/g)?.map(Number) ?? []
      assert.ok(values.length === 3 || values[3] === 1, `Reduced transparency surface must be opaque: ${JSON.stringify(material)}`)
      assert.equal(material.filter, 'none')
    }
    await readableContent()
    await screenshot('reduced-transparency-home')
    await client.send('Emulation.setEmulatedMedia', { features: [] })
    await client.detach()
  })
  await check('Unsupported blur retains readable surfaces and usable dialogs', async () => {
    const fallback = await context.newPage()
    fallback.on('pageerror', (error) => errors.push(error.message))
    // Changing the property name lets Chromium itself take the @supports fallback branch.
    // This also removes real filter support from every fetched stylesheet in this test page.
    await fallback.route('**/*.css', async (route) => {
      const response = await route.fetch()
      const css = (await response.text()).replace(/(?<![\w-])(?:-webkit-)?backdrop-filter/g, 'unsupported-backdrop-filter')
      await route.fulfill({ response, body: css, contentType: 'text/css' })
    })
    await fallback.goto(`${baseUrl}/`)
    await fallback.getByText('今天，专注最重要的事', { exact: true }).waitFor()
    const glass = await fallback.locator('.app-sidebar').evaluate((element) => getComputedStyle(element).backdropFilter)
    assert.equal(glass, 'none')
    await readableContent(fallback)
    await fallback.getByRole('button', { name: '快速新增', exact: true }).click()
    await fallback.getByRole('dialog', { name: '快速新增', exact: true }).waitFor()
    await screenshot('unsupported-blur-dialog', fallback)
    await fallback.keyboard.press('Escape')
    await fallback.close()
  })
  assert.deepEqual(errors, [], 'No unhandled browser errors')
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'passed', checks, contrast, screenshots, errors }, null, 2), 'utf8')
  console.log(`PASS: ${checks.length} visual browser scenarios; ${screenshots.length} screenshots; isolated fixture data; no browser errors.`)
} catch (error) {
  if (page) await screenshot('failure').catch(() => {})
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'failed', checks, screenshots, errors, failure: String(error) }, null, 2), 'utf8')
  throw error
} finally {
  if (browser) await browser.close()
  server.kill()
  await writeFile(path.join(artifacts, 'backend.log'), log, 'utf8')
}
