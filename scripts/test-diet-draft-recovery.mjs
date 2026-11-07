import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Real Chromium navigation with HTTP job fixtures, not real model inference.
const [playwrightPath, outputPath] = process.argv.slice(2)
if (!playwrightPath || !outputPath) throw new Error('Usage: node scripts/test-diet-draft-recovery.mjs <playwright-module> <artifacts>')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(outputPath)
assert.ok(artifacts.startsWith(root + path.sep))
await mkdir(artifacts, { recursive: true })
const dist = path.join(root, 'frontend', 'dist')
const plan = { name: '浏览器恢复菜谱', description: '模拟生成', cycle_days: 1, meals: [
  { day_number: 1, meal_type: 'breakfast', name: '燕麦牛奶', estimated_kcal: 400 },
  { day_number: 1, meal_type: 'lunch', name: '番茄鸡蛋饭', estimated_kcal: 600 },
  { day_number: 1, meal_type: 'dinner', name: '青菜豆腐面', estimated_kcal: 500 },
] }
let generationCount = 0, cancellationCount = 0, templateCount = 0, completed = false, state = 'running'
const keys = new Set(), templates = []
function snapshot() { return { job_id: 'browser-job', state: completed ? 'completed' : state, elapsed_seconds: 5, queue_position: 0, result: completed ? { plan } : null } }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://test')
  const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (url.pathname.startsWith('/api/v1/')) {
    const endpoint = url.pathname.slice('/api/v1'.length)
    if (endpoint === '/bootstrap') return json({ app_name: 'PersonalHub', version: 'test', local_token: 'fixture-token', database_path: 'fixture-only', public_mode: true, desktop_mode: true, username: 'browsercheck' })
    if (endpoint === '/settings') return json({ nickname: '验收', theme_mode: 'light', theme_color: '#79629D' })
    if (endpoint === '/ai/ollama/settings') return json({ base_url: 'http://127.0.0.1:11434', model: 'fixture-model' })
    if (endpoint === '/ai/diet/generate') {
      const key = req.headers['x-generation-key']
      if (!keys.has(key)) { keys.add(key); generationCount++ }
      return json(snapshot(), 202)
    }
    if (endpoint === '/ai/shared/jobs/browser-job') {
      if (req.method === 'DELETE') { cancellationCount++; state = 'cancelled' }
      return json(snapshot())
    }
    if (endpoint === '/diet/templates') {
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk
        templateCount++; const saved = { ...JSON.parse(raw), id: 'saved', builtin: false }; templates.push(saved); return json(saved, 201)
      }
      return json(templates)
    }
    if (endpoint === '/diet/profile') return json({ height_cm: null, weight_kg: null })
    if (endpoint.startsWith('/diet/health/')) return json({ water_ml: 0, weight_kg: null, feeling: '' })
    return json([])
  }
  const target = url.pathname.startsWith('/assets/') ? path.join(dist, url.pathname) : path.join(dist, 'index.html')
  if (!target.startsWith(dist + path.sep)) { res.writeHead(404); res.end(); return }
  try {
    const bytes = await readFile(target)
    res.writeHead(200, { 'Content-Type': target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html' })
    res.end(bytes)
  } catch { res.writeHead(404); res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const { chromium } = createRequire(import.meta.url)(playwrightPath)
let browser
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  page.setDefaultTimeout(20000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base + '/diet')
  await page.getByRole('tab', { name: '饮食模板', exact: true }).click()
  await page.getByRole('button', { name: 'AI 生成菜谱 / 模板', exact: true }).click()
  await page.getByRole('button', { name: '生成可编辑草稿', exact: true }).click()
  await page.getByRole('button', { name: '收起，继续生成', exact: true }).click()
  await page.getByRole('link', { name: '今日计划', exact: true }).click()
  await page.getByRole('heading', { name: '今日计划', exact: true }).waitFor()
  await page.getByRole('link', { name: '饮食计划', exact: true }).click()
  await page.getByRole('button', { name: '查看进度', exact: true }).click()
  await page.getByRole('button', { name: '取消生成', exact: true }).waitFor()
  assert.equal(generationCount, 1)
  assert.equal(cancellationCount, 0)
  await page.reload()
  await page.getByRole('button', { name: '查看进度', exact: true }).waitFor()
  assert.equal(generationCount, 1)
  completed = true
  await page.getByText('AI 菜谱草稿已保留，可以继续编辑', { exact: true }).waitFor()
  await page.getByRole('button', { name: '查看菜谱草稿', exact: true }).click()
  await page.getByRole('heading', { name: plan.name, exact: true }).waitFor()
  await page.getByRole('button', { name: '编辑、保存或导入日历', exact: true }).click()
  await page.getByLabel('模板名称', { exact: true }).fill('保留编辑的菜谱')
  await page.getByLabel('模板餐食', { exact: true }).fill('1 | 早餐 | 牛奶燕麦 | 380')
  await page.getByRole('dialog', { name: '创建饮食模板', exact: true }).getByRole('button', { name: /^取\s*消$/ }).click()
  await page.getByRole('link', { name: '今日计划', exact: true }).click()
  await page.getByRole('link', { name: '饮食计划', exact: true }).click()
  await page.getByRole('button', { name: '查看菜谱草稿', exact: true }).click()
  assert.equal(await page.getByLabel('模板名称', { exact: true }).inputValue(), '保留编辑的菜谱')
  assert.equal(await page.getByLabel('模板餐食', { exact: true }).inputValue(), '1 | 早餐 | 牛奶燕麦 | 380')
  await page.reload()
  await page.getByRole('button', { name: '查看菜谱草稿', exact: true }).click()
  assert.equal(await page.getByLabel('模板名称', { exact: true }).inputValue(), '保留编辑的菜谱')
  assert.equal(templateCount, 0)
  await page.getByLabel('模板名称', { exact: true }).click()
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return false
    for (let element = dialog; element; element = element.parentElement) {
      if (Number(getComputedStyle(element).opacity) < 0.99) return false
    }
    return true
  })
  await page.screenshot({ path: path.join(artifacts, 'recovered-editor.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: '保存模板', exact: true }).click()
  await page.getByText('饮食模板已保存', { exact: true }).waitFor()
  assert.equal(templateCount, 1)
  assert.equal(generationCount, 1)
  assert.equal(cancellationCount, 0)
  assert.equal(await page.getByText('AI 菜谱草稿已保留，可以继续编辑', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  const report = { passed: true, generationCount, templateCount, cancellationCount, checks: ['route navigation', 'progress after refresh', 'draft recovery', 'edited fields after navigation and refresh', 'save only on confirmation'], pageErrors: errors }
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  if (browser) await browser.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
