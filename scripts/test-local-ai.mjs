import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Requires the installed local model. This test performs real inference in an isolated app database.
const [playwrightPath, outputPath] = process.argv.slice(2)
if (!playwrightPath || !outputPath) throw new Error('Usage: node scripts/test-local-ai.mjs <playwright-module> <artifacts>')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(outputPath)
assert.ok(artifacts.startsWith(root + path.sep), 'Artifacts must stay in the project')
await mkdir(artifacts, { recursive: true })
const model = 'qwen2.5:1.5b'
const ollamaUrl = 'http://127.0.0.1:11434'

async function invokeStarter(args = []) {
  const process = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'start-local-ai.ps1'), ...args], { cwd: root, windowsHide: true })
  let output = '', error = ''
  process.stdout.on('data', (data) => { output += data })
  process.stderr.on('data', (data) => { error += data })
  const code = await new Promise((resolve) => process.on('exit', resolve))
  return { code, output, error }
}
async function startOllama() {
  const result = await invokeStarter()
  assert.equal(result.code, 0, result.error)
  return JSON.parse(result.output.trim())
}
const first = await startOllama()
const repeated = await startOllama()
assert.equal(first.pid, repeated.pid, 'Repeated launch must reuse the running service')
const concurrent = await Promise.all([startOllama(), startOllama()])
assert.ok(concurrent.every((state) => state.pid === first.pid), 'Concurrent launch must reuse the running service')
assert.equal(path.resolve(first.models_directory), path.join(root, '.local-ai', 'models'))
assert.notEqual(path.parse(first.models_directory).root.toLowerCase(), 'c:\\')
assert.equal(first.no_cloud, true)
const rejectedLocation = await invokeStarter(['-InstallRoot', 'C:\\PersonalHubAIRejectedLocation'])
assert.notEqual(rejectedLocation.code, 0)
assert.match(rejectedLocation.error, /other than C/)
const occupied = createServer((_, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: 'unrelated-test-service' })) })
await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve))
try {
  const otherPort = occupied.address().port
  const rejectedService = await invokeStarter(['-Port', String(otherPort)])
  assert.notEqual(rejectedService.code, 0)
  assert.match(rejectedService.error, /cannot be verified/)
  assert.equal((await (await fetch(`http://127.0.0.1:${otherPort}/api/version`)).json()).version, 'unrelated-test-service')
} finally { await new Promise((resolve) => occupied.close(resolve)) }
console.log('PASS: D-drive startup, repeated launch reuse, C-drive rejection and occupied-service protection')
const tags = await (await fetch(`${ollamaUrl}/api/tags`)).json()
const installed = tags.models.find((item) => item.name === model)
assert.ok(installed, 'The lightweight model must be installed')
assert.ok(installed.size > 500_000_000 && installed.size < 1_100_000_000, 'Expected the small 1.5B model')
const manifest = JSON.parse(await readFile(path.join(first.models_directory, 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5', '1.5b'), 'utf8'))
for (const layer of manifest.layers) {
  const blob = path.join(first.models_directory, 'blobs', layer.digest.replace(':', '-'))
  assert.equal((await stat(blob)).size, layer.size, 'Model blobs must exist on the configured D drive')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(blob)) digest.update(chunk)
  assert.equal(`sha256:${digest.digest('hex')}`, layer.digest, 'Downloaded model must match its registry digest')
}

const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const baseUrl = `http://127.0.0.1:${port}`
const server = spawn(path.join(root, 'dist', 'PersonalHub', 'PersonalHub.exe'), [], { cwd: root, windowsHide: true,
  env: { ...process.env, PERSONAL_HUB_DATA_DIR: path.join(artifacts, 'ai-live-data'), PERSONAL_HUB_PORT: String(port), PERSONAL_HUB_NO_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
server.stdout.on('data', (data) => { log += data })
server.stderr.on('data', (data) => { log += data })
const require = createRequire(import.meta.url)
const { chromium } = require(playwrightPath)
let browser, page
const report = { model, model_bytes: installed.size, models_directory: first.models_directory, tests: [] }
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${baseUrl}/health`)).ok } catch {}
    if (ready) break
    if (server.exitCode !== null) throw new Error(log)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(ready, log)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const bootstrap = await (await page.request.get(`${baseUrl}/api/v1/bootstrap`)).json()
  assert.equal(path.resolve(bootstrap.database_path), path.join(artifacts, 'ai-live-data', 'data', 'personal_data.db'))
  const headers = { 'X-Local-Token': bootstrap.local_token }
  await page.goto(`${baseUrl}/settings?tab=ai`)
  await page.getByRole('button', { name: '检查连接并刷新模型', exact: true }).click()
  await page.getByText('已连接，发现 1 个本地模型', { exact: true }).waitFor()
  await page.getByLabel('模型名称', { exact: true }).fill(model)
  await page.getByRole('button', { name: '保存模型设置', exact: true }).click()
  await page.getByText('本地模型设置已保存', { exact: true }).waitFor()
  await page.goto(`${baseUrl}/learning`)
  await page.getByRole('button', { name: 'AI 生成学习计划', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('学习主题', { exact: true }).fill('Python 入门')
  await dialog.getByLabel('希望达到的目标', { exact: true }).fill('学会变量和条件判断，并完成一个小练习')
  await dialog.getByLabel('计划天数', { exact: true }).fill('2')
  const today = await dialog.getByLabel('开始日期', { exact: true }).inputValue()
  const generationResponse = page.waitForResponse((response) => response.url().endsWith('/ai/learning/generate') && response.request().method() === 'POST', { timeout: 330000 })
  const started = Date.now()
  await dialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  const response = await generationResponse
  const generated = await response.json()
  assert.equal(response.status(), 200, JSON.stringify(generated))
  report.tests.push({ name: 'real browser two-day generation', seconds: (Date.now() - started) / 1000, plan: generated.plan })
  console.log(`PASS: real two-day model generation in ${(Date.now() - started) / 1000}s`)
  await dialog.getByLabel('计划名称', { exact: true }).fill('本地模型真实推理验收')
  await dialog.getByLabel('任务 1 标题', { exact: true }).fill('手动修改后的 Python 练习')
  assert.deepEqual(await (await page.request.get(`${baseUrl}/api/v1/learning/goals`)).json(), [])
  await page.screenshot({ path: path.join(artifacts, 'real-model-preview.png'), fullPage: true })
  await dialog.getByRole('button', { name: '确认加入学习计划', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('tab', { name: '学习任务', exact: true }).click()
  await page.getByText('手动修改后的 Python 练习', { exact: false }).waitFor()
  const goals = await (await page.request.get(`${baseUrl}/api/v1/learning/goals`)).json()
  assert.equal(goals.length, 1)
  const goal = await (await page.request.get(`${baseUrl}/api/v1/learning/goals/${goals[0].id}`)).json()
  assert.equal(goal.tasks.length, generated.plan.tasks.length)
  const home = await (await page.request.get(`${baseUrl}/api/v1/home?date=${today}`)).json()
  assert.ok(home.agenda.some((task) => task.title === '手动修改后的 Python 练习'))
  const stored = await (await page.request.get(`${baseUrl}/api/v1/ai/learning/drafts/${generated.id}`)).json()
  const retry = await page.request.post(`${baseUrl}/api/v1/ai/learning/drafts/${generated.id}/import`, { headers, data: stored.plan })
  assert.equal((await retry.json()).id, goal.id)
  const weeklyStarted = Date.now()
  const weeklyResponse = await page.request.post(`${baseUrl}/api/v1/ai/learning/generate`, { headers, timeout: 330000,
    data: { topic: 'Python 入门', objective: '能够写出一个简单的命令行待办清单', current_level: '零基础', start_date: today, days: 7, daily_minutes: 45 } })
  const weekly = await weeklyResponse.json()
  assert.equal(weeklyResponse.status(), 200, JSON.stringify(weekly))
  assert.equal(new Set(weekly.plan.tasks.map((task) => task.plan_date)).size, 7)
  report.tests.push({ name: 'real seven-day generation', seconds: (Date.now() - weeklyStarted) / 1000, plan: weekly.plan })
  assert.equal((await (await page.request.get(`${baseUrl}/api/v1/learning/goals`)).json()).length, 1, 'Unconfirmed weekly draft must not create a second goal')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(artifacts, 'imported-real-plan.png'), fullPage: true })
  report.passed = true
  console.log('PASS: D-drive model storage, repeated startup, real Ollama browser generation, edited import, home sync, idempotent confirmation and seven-day generation. Personal database unchanged.')
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  if (browser) await browser.close()
  server.kill()
  await writeFile(path.join(artifacts, 'backend.log'), log, 'utf8')
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
}
