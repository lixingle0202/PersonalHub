// Run only against an isolated executable test instance (never personal data).
// node scripts/test-desktop-release.mjs <playwright-module> <local-url> <artifacts>
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const { chromium } = require(process.argv[2] || 'playwright')
const base = process.argv[3] || 'http://127.0.0.1:18843'
assert.equal(new URL(base).hostname, '127.0.0.1')
const output = path.resolve(process.argv[4] || '.test-runtime/desktop-release-browser')
await mkdir(output, { recursive: true })
const expected = JSON.parse(await readFile(new URL('../frontend/package.json', import.meta.url), 'utf8')).version
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const errors = [], generationIds = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('response', async (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/ai/diet/generate') {
      generationIds.push((await response.json()).job_id)
    }
  })
  const credentials = { username: `release_${Date.now()}`, password: `Test-${randomUUID()}` }
  const registered = await context.request.post(`${base}/api/v1/public/register`, { data: credentials })
  assert.equal(registered.status(), 200, await registered.text())
  const bootstrap = await (await context.request.get(`${base}/api/v1/bootstrap`)).json()
  assert.equal(bootstrap.version, expected)
  await context.request.post(`${base}/api/v1/public/logout`)
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByLabel('用户名', { exact: true }).fill(credentials.username)
  await page.getByLabel('密码', { exact: true }).fill(credentials.password)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.getByRole('button', { name: /^登\s*录$/ }).click(),
  ])
  for (const route of ['/today', '/learning', '/diet', '/settings', '/']) {
    await page.goto(base + route, { waitUntil: 'networkidle' })
    await page.getByRole('searchbox', { name: '全局搜索' }).waitFor()
  }
  console.log(`PASS: extracted executable ${expected}, real login and five main pages`)

  await page.goto(`${base}/diet`, { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: '饮食模板', exact: true }).click()
  await page.getByRole('button', { name: 'AI 生成菜谱 / 模板', exact: true }).click()
  const generator = page.getByRole('dialog').filter({ hasText: 'AI 生成饮食菜单' })
  await generator.getByLabel('菜谱主题').fill('一日均衡家常三餐')
  await generator.getByLabel('生成天数').fill('1')
  await generator.getByLabel('口味、预算或需避开的食材').fill('常见家常菜，不要海鲜')
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/v1/ai/diet/generate') && response.request().method() === 'POST'),
    generator.getByRole('button', { name: '生成可编辑草稿' }).click(),
  ])
  await page.keyboard.press('Escape')
  await generator.waitFor({ state: 'hidden' })
  await page.getByRole('link', { name: '今日计划', exact: true }).click()
  await page.getByRole('link', { name: '饮食计划', exact: true }).click()
  await page.getByRole('button', { name: /^(查看进度|查看菜谱草稿)$/ }).waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /^(查看进度|查看菜谱草稿)$/ }).click()
  console.log('PASS: navigation and reload reconnect the original real diet generation; waiting for model result')
  await generator.getByRole('button', { name: '编辑、保存或导入日历' }).waitFor({ timeout: 360_000 })
  assert.equal(generationIds.length, 1)
  await generator.getByRole('button', { name: '编辑、保存或导入日历' }).click()
  const editor = page.getByRole('dialog').filter({ hasText: '创建饮食模板' })
  const draftName = `v${expected} 草稿恢复验收`
  await editor.getByLabel('模板名称').fill(draftName)
  await editor.getByRole('button', { name: /^取\s*消$/ }).click()
  await page.getByRole('link', { name: '学习计划', exact: true }).click()
  await page.getByRole('link', { name: '饮食计划', exact: true }).click()
  await page.getByRole('button', { name: '查看菜谱草稿', exact: true }).click()
  assert.equal(await editor.getByLabel('模板名称').inputValue(), draftName)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '查看菜谱草稿', exact: true }).click()
  assert.equal(await editor.getByLabel('模板名称').inputValue(), draftName)
  const templates = await (await context.request.get(`${base}/api/v1/diet/templates`)).json()
  assert.ok(!templates.some((template) => template.name === draftName), 'A draft must not be saved automatically')
  await editor.getByLabel('模板名称').click() // Wait for the restored modal's enter transition before capturing it.
  await editor.screenshot({ path: path.join(output, 'diet-recovered-editor.png'), animations: 'disabled' })
  await editor.getByRole('button', { name: '保存模板', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  const saved = await (await context.request.get(`${base}/api/v1/diet/templates`)).json()
  assert.equal(saved.filter((template) => template.name === draftName).length, 1)
  assert.equal(generationIds.length, 1, 'Do not submit another generation while recovering a draft')
  assert.equal(errors.length, 0, errors.join('\n'))
  const report = { version: expected, login: true, mainPages: 5, realDietAI: true,
    navigationRecovery: true, reloadRecovery: true, editorRecovery: true,
    generationRequests: generationIds.length, savedTemplates: 1, pageErrors: errors }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await browser.close()
}
