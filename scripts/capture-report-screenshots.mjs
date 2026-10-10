import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [pythonPath, playwrightPath, outputPath] = process.argv.slice(2)
if (!pythonPath || !playwrightPath || !outputPath) {
  throw new Error('Usage: node scripts/capture-report-screenshots.mjs <python> <playwright-module> <output-directory>')
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.resolve(outputPath)
assert.ok(output.startsWith(root + path.sep), 'Screenshot output must stay inside the project')
await mkdir(output, { recursive: true })

const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const baseUrl = `http://127.0.0.1:${port}`
const isolatedData = await mkdtemp(path.join(tmpdir(), 'personalhub-report-'))
assert.ok(isolatedData.startsWith(tmpdir()), 'Temporary data must stay inside the system temporary directory')

const server = spawn(path.resolve(pythonPath), [
  '-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port),
], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    PYTHONPATH: path.join(root, 'backend'),
    PERSONAL_HUB_DATA_DIR: isolatedData,
    PERSONAL_HUB_PORT: String(port),
    PERSONAL_HUB_NO_BROWSER: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
server.stdout.on('data', (data) => { serverLog += data })
server.stderr.on('data', (data) => { serverLog += data })
const { chromium } = createRequire(import.meta.url)(playwrightPath)
let browser

async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled', fullPage: false })
}

try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${baseUrl}/health`)).ok } catch {}
    if (ready) break
    if (server.exitCode !== null) throw new Error(`Screenshot server exited: ${serverLog}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(ready, `Screenshot server did not start: ${serverLog}`)

  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' })
  const page = await context.newPage()
  const bootstrap = await (await page.request.get(`${baseUrl}/api/v1/bootstrap`)).json()
  const headers = { 'X-Local-Token': bootstrap.local_token }

  async function post(endpoint, data) {
    const response = await page.request.post(`${baseUrl}/api/v1${endpoint}`, { headers, data })
    assert.ok(response.ok(), `Fixture request failed: ${endpoint} ${await response.text()}`)
    return response.json()
  }

  const goal = await post('/learning/goals', {
    name: '英语六级冲刺计划',
    goal: '系统提升词汇、阅读、听力和写作能力，顺利通过六级考试',
    start_date: '2026-10-10', target_date: '2026-10-14', estimated_minutes: 300,
  })
  const vocabulary = await post(`/learning/goals/${goal.id}/sections`, { name: '词汇与语法基础', sort_order: 1 })
  const reading = await post(`/learning/goals/${goal.id}/sections`, { name: '阅读与听力强化', sort_order: 2 })
  await post(`/learning/goals/${goal.id}/tasks`, {
    title: '核心词汇与语法复习', details: '复习 80 个高频词汇，完成 10 道语法练习并订正错题。',
    section_id: vocabulary.id, plan_date: '2026-10-10', priority: 'high', estimated_minutes: 45,
  })
  await post(`/learning/goals/${goal.id}/tasks`, {
    title: '长篇阅读专项训练', details: '完成 2 篇六级长篇阅读，标记定位词并总结错误原因。',
    section_id: reading.id, plan_date: '2026-10-11', estimated_minutes: 50,
  })
  await post(`/learning/goals/${goal.id}/tasks`, {
    title: '听力精听与复述', details: '精听一套新闻材料，逐句跟读并用自己的话复述主要内容。',
    section_id: reading.id, plan_date: '2026-10-12', estimated_minutes: 40,
  })
  await post('/agenda', { title: '整理课程设计汇报提纲', plan_date: '2026-10-10', bucket: 'must', priority: 'high' })
  await post('/quick-notes', { content: '汇报时重点演示学习计划、饮食日历和大模型生成流程。', is_important: true })

  const breakfast = await post('/diet/dishes', {
    name: '燕麦酸奶水果杯', instructions: '燕麦与酸奶混合，加入蓝莓和香蕉。', estimated_kcal: 380,
    ingredients: [{ name: '燕麦', quantity: 50, unit: 'g' }, { name: '酸奶', quantity: 200, unit: 'g' }, { name: '蓝莓', quantity: 1, unit: '份' }],
  })
  const lunchMain = await post('/diet/dishes', {
    name: '香煎鸡胸肉', instructions: '鸡胸肉腌制后煎熟，搭配黑胡椒。', estimated_kcal: 360,
    ingredients: [{ name: '鸡胸肉', quantity: 180, unit: 'g' }],
  })
  const lunchSide = await post('/diet/dishes', {
    name: '时蔬沙拉', instructions: '生菜、番茄和玉米混合，少量油醋汁调味。', estimated_kcal: 180,
    ingredients: [{ name: '生菜', quantity: 1, unit: '份' }, { name: '番茄', quantity: 1, unit: '个' }],
  })
  await post('/diet/meals', { meal_date: '2026-10-10', meal_type: 'breakfast', dish_ids: [breakfast.id] })
  await post('/diet/meals', { meal_date: '2026-10-10', meal_type: 'lunch', dish_ids: [lunchMain.id, lunchSide.id] })
  await post('/diet/meals', { meal_date: '2026-10-10', meal_type: 'dinner', custom_name: '番茄菌菇意面', estimated_kcal: 520 })

  await page.goto(`${baseUrl}/`)
  await page.getByText('今天，专注最重要的事', { exact: true }).waitFor()
  await screenshot(page, 'home-overview')

  await page.goto(`${baseUrl}/learning`)
  await page.getByRole('tab', { name: '学习计划', exact: true }).waitFor()
  await page.getByRole('heading', { name: '每日学习任务', exact: true }).scrollIntoViewIfNeeded()
  await screenshot(page, 'learning-plan')

  await page.goto(`${baseUrl}/diet`)
  await page.getByRole('table', { name: '饮食月历' }).waitFor()
  await screenshot(page, 'diet-calendar')

  await page.goto(`${baseUrl}/settings`)
  const modelTab = page.getByRole('tab', { name: '本地大模型', exact: true })
  await modelTab.waitFor()
  await modelTab.click()
  await page.getByText('本地大模型 · Ollama', { exact: true }).waitFor()
  await screenshot(page, 'model-settings')

  for (const diagram of ['plan-workflow', 'system-architecture']) {
    await page.goto(pathToFileURL(path.join(output, `${diagram}.svg`)).href)
    await page.locator('svg').screenshot({ path: path.join(output, `${diagram}.png`), animations: 'disabled' })
  }

  console.log(`Captured 4 page screenshots and 2 flowcharts in ${output}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server.exitCode === null) {
    server.kill()
    await new Promise((resolve) => server.once('exit', resolve)).catch(() => {})
  }
  await rm(isolatedData, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}
