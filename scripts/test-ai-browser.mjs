import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// HTTP fixture tests integration, not real model inference. Personal data is never used.
const [runtimePath, playwrightPath, outputPath, mode] = process.argv.slice(2)
if (!runtimePath || !playwrightPath || !outputPath || (mode && mode !== '--packaged')) throw new Error('Usage: node scripts/test-ai-browser.mjs <python-or-exe> <playwright-module> <artifacts> [--packaged]')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(outputPath)
assert.ok(artifacts.startsWith(root + path.sep), 'Artifacts must stay inside the project')
await mkdir(artifacts, { recursive: true })
const requests = []
const model = 'test-study-model'
const fixture = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: model }] })); return }
  if (req.url !== '/api/chat') { res.writeHead(404); res.end('{}'); return }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requests.push(body)
  const requirements = JSON.parse(body.messages[1].content)
  const plan = { name: '浏览器学习草稿', goal: requirements.objective, sections: ['基础练习', '动手实践'],
    tasks: Array.from({ length: requirements.days }, (_, index) => ({ day_number: index + 1,
      section_index: index % 2, title: `第 ${index + 1} 天学习任务`, minutes: requirements.daily_minutes,
      notes: `练习 ${requirements.topic} 并记录结果` })) }
  res.end(JSON.stringify({ done: true, message: { content: JSON.stringify(plan) } }))
})
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
const ollamaUrl = `http://127.0.0.1:${fixture.address().port}`
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const baseUrl = `http://127.0.0.1:${port}`
const server = spawn(path.resolve(runtimePath), mode === '--packaged' ? [] : ['-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root, windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, 'backend'),
    PERSONAL_HUB_DATA_DIR: path.join(artifacts, 'ai-browser-data'), PERSONAL_HUB_PORT: String(port), PERSONAL_HUB_NO_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (data) => { log += data })
server.stderr.on('data', (data) => { log += data })
const require = createRequire(import.meta.url)
const { chromium } = require(playwrightPath)
let browser
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
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const bootstrap = await (await page.request.get(`${baseUrl}/api/v1/bootstrap`)).json()
  assert.equal(path.resolve(bootstrap.database_path), path.join(artifacts, 'ai-browser-data', 'data', 'personal_data.db'))
  const headers = { 'X-Local-Token': bootstrap.local_token }
  await page.goto(`${baseUrl}/settings?tab=ai`)
  await page.getByLabel('Ollama 服务地址', { exact: true }).fill(ollamaUrl)
  await page.getByRole('button', { name: '检查连接并刷新模型', exact: true }).click()
  await page.getByText('已连接，发现 1 个本地模型', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), model)
  await page.getByRole('button', { name: '保存模型设置', exact: true }).click()
  await page.getByText('本地模型设置已保存', { exact: true }).waitFor()
  await page.goto(`${baseUrl}/learning`)
  await page.getByRole('button', { name: 'AI 生成学习计划', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('学习主题', { exact: true }).fill('Android')
  await dialog.getByLabel('希望达到的目标', { exact: true }).fill('完成待办清单应用')
  await dialog.getByLabel('计划天数', { exact: true }).fill('2')
  const today = await dialog.getByLabel('开始日期', { exact: true }).inputValue()
  const generationResponse = page.waitForResponse((response) => response.url().endsWith('/ai/learning/generate') && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  const generated = await (await generationResponse).json()
  await dialog.getByText('这是可编辑草稿，确认前不会加入正式计划', { exact: true }).waitFor()
  assert.deepEqual(await (await page.request.get(`${baseUrl}/api/v1/learning/goals`)).json(), [])
  await page.screenshot({ path: path.join(artifacts, 'generated-preview.png'), fullPage: true })
  await page.reload()
  await page.getByRole('button', { name: 'AI 生成学习计划', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('计划名称', { exact: true }).fill('浏览器验收学习计划')
  await dialog.getByLabel('任务 1 标题', { exact: true }).fill('完成手动修改的布局练习')
  await dialog.getByLabel('任务 1 分钟', { exact: true }).fill('35')
  await dialog.getByRole('button', { name: '移除任务 2', exact: true }).click()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'AI 生成学习计划', exact: true }).click()
  dialog = page.getByRole('dialog')
  assert.equal(await dialog.getByLabel('计划名称', { exact: true }).inputValue(), '浏览器验收学习计划')
  await dialog.getByRole('button', { name: '确认加入学习计划', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('tab', { name: '学习任务', exact: true }).click()
  await page.getByText('完成手动修改的布局练习', { exact: false }).waitFor()
  const goals = await (await page.request.get(`${baseUrl}/api/v1/learning/goals`)).json()
  assert.equal(goals.length, 1)
  const goal = await (await page.request.get(`${baseUrl}/api/v1/learning/goals/${goals[0].id}`)).json()
  assert.equal(goal.estimated_minutes, 35)
  assert.equal(goal.tasks.length, 1)
  assert.equal(goal.sections.length, 2)
  const stored = await (await page.request.get(`${baseUrl}/api/v1/ai/learning/drafts/${generated.id}`)).json()
  const retry = await page.request.post(`${baseUrl}/api/v1/ai/learning/drafts/${generated.id}/import`, { headers, data: stored.plan })
  assert.equal((await retry.json()).id, goal.id)
  const home = await (await page.request.get(`${baseUrl}/api/v1/home?date=${today}`)).json()
  assert.equal(home.agenda.length, 1)
  assert.equal(home.agenda[0].title, '完成手动修改的布局练习')
  const agenda = await (await page.request.get(`${baseUrl}/api/v1/agenda?date=${today}`)).json()
  assert.equal(agenda.length, 1)
  assert.match(agenda[0].notes, /预计 35 分钟/)
  assert.ok((await (await page.request.get(`${baseUrl}/api/v1/search?q=${encodeURIComponent('浏览器验收学习计划')}`)).json()).length)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].format.type, 'object')
  assert.equal(requests[0].stream, false)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(artifacts, 'imported-learning-plan.png'), fullPage: true })
  console.log('PASS: local model settings, HTTP generation fixture, preview, refresh restore, edit, remove task, reopen, confirm, retry, home/agenda/search sync; no browser errors. Not a real model inference test.')
} finally {
  if (browser) await browser.close()
  server.kill()
  await new Promise((resolve) => fixture.close(resolve))
  await writeFile(path.join(artifacts, 'backend.log'), log, 'utf8')
}
