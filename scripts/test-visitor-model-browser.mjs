import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Real Chromium + an account-isolated public server + a browser-local Ollama fixture.
const [pythonPath, playwrightPath, outputPath] = process.argv.slice(2)
if (!pythonPath || !playwrightPath || !outputPath) throw new Error('Usage: node scripts/test-visitor-model-browser.mjs <python> <playwright-module> <fresh-artifacts>')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(outputPath)
assert.ok(artifacts.startsWith(root + path.sep), 'Artifacts must stay inside the project')
await mkdir(artifacts, { recursive: true })

const reserve = createServer()
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
const port = reserve.address().port
await new Promise((resolve) => reserve.close(resolve))
const baseUrl = `http://127.0.0.1:${port}`
const model = 'visitor-browser-test-model'
const chats = []
const fixture = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', baseUrl)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: model }] })); return }
  if (req.url !== '/api/chat') { res.writeHead(404); res.end('{}'); return }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  chats.push(body)
  const requirements = JSON.parse(body.messages[1].content)
  const plan = { name: '访客本机草稿', goal: requirements.objective,
    sections: Array.from({ length: requirements.days }, (_, index) => `阶段 ${index + 1}`),
    tasks: Array.from({ length: requirements.days }, (_, index) => ({
      day_number: index + 1, section_index: index, title: `本机任务 ${index + 1}`,
      minutes: requirements.daily_minutes, notes: '由访客电脑生成',
    })) }
  res.end(JSON.stringify({ done: true, message: { content: JSON.stringify(plan) } }))
})
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
const localModelUrl = `http://127.0.0.1:${fixture.address().port}`

const code = 'from pathlib import Path; import sys, uvicorn; from app.public import create_public_app; uvicorn.run(create_public_app(Path(sys.argv[1]), secure_cookie=False), host="127.0.0.1", port=int(sys.argv[2]), access_log=False)'
const server = spawn(path.resolve(pythonPath), ['-c', code, path.join(artifacts, 'isolated-public-data'), String(port)], {
  cwd: root, windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, 'backend') }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (chunk) => { log += chunk })
server.stderr.on('data', (chunk) => { log += chunk })
const require = createRequire(import.meta.url)
const { chromium } = require(playwrightPath)
let browser
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${baseUrl}/health`)).ok } catch {}
    if (ready) break
    if (server.exitCode !== null) throw new Error(`Public test server exited: ${log}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(ready, `Public test server did not start: ${log}`)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(baseUrl)
  await page.getByRole('button', { name: '没有账号？创建个人空间' }).click()
  await page.getByLabel('用户名').fill('browser_visitor')
  await page.getByLabel('密码').fill('visitor-test-password')
  await page.getByRole('button', { name: '注册并进入' }).click()
  await page.getByRole('heading', { name: '首页总览' }).waitFor()
  await page.goto(`${baseUrl}/settings?tab=ai`)
  await page.getByText('本地大模型', { exact: true }).click()
  await page.getByLabel('这台电脑的 Ollama 地址').fill(localModelUrl)
  await page.getByRole('button', { name: '检查连接并刷新模型' }).click()
  await page.getByText('已连接，发现 1 个本机模型').waitFor()
  await page.getByRole('button', { name: '保存并使用本地模型' }).click()
  await page.getByText('已切换到这台电脑的本地模型').waitFor()
  await page.screenshot({ path: path.join(artifacts, 'visitor-model-settings.png'), fullPage: true })
  await page.goto(`${baseUrl}/learning`)
  await page.getByRole('button', { name: 'AI 生成学习计划' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('学习主题').fill('Android')
  await dialog.getByLabel('希望达到的目标').fill('完成待办应用')
  await dialog.getByLabel('计划天数').fill('2')
  const generatedResponse = page.waitForResponse((response) => response.url().endsWith('/ai/learning/visitor/draft'))
  await dialog.getByRole('button', { name: '生成草稿' }).click()
  const generated = await generatedResponse
  assert.equal(generated.status(), 200, await generated.text())
  await dialog.getByLabel('计划名称').waitFor()
  assert.equal(chats.length, 1)
  assert.equal(chats[0].model, model)
  await page.screenshot({ path: path.join(artifacts, 'visitor-model-preview.png'), fullPage: true })
  await dialog.getByRole('button', { name: '确认加入学习计划' }).click()
  await dialog.waitFor({ state: 'hidden' })
  const goals = await (await page.request.get(`${baseUrl}/api/v1/learning/goals`)).json()
  assert.equal(goals.length, 1)
  assert.equal(goals[0].name, '访客本机草稿')
  await page.goto(`${baseUrl}/settings?tab=ai`)
  await page.getByText('共享大模型', { exact: true }).click()
  await page.getByText(/无需在这台电脑安装 Ollama/).waitFor()
  await page.goto(`${baseUrl}/learning`)
  await page.getByRole('button', { name: 'AI 生成学习计划' }).click()
  await page.getByText('共享大模型 · qwen2.5:1.5b').waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: visitor selects local model, browser calls loopback Ollama, server validates draft, import stays in account, and visitor can return to shared model')
} finally {
  await browser?.close()
  server.kill()
  await new Promise((resolve) => fixture.close(resolve))
}
