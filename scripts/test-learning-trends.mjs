// Run against an isolated, login-enabled source preview; never use a personal data service.
// node scripts/test-learning-trends.mjs <playwright-module-path> <preview-url> <artifact-directory>
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const { chromium } = require(process.argv[2] || 'playwright')
const base = process.argv[3] || 'http://127.0.0.1:8788'
assert.equal(new URL(base).hostname, '127.0.0.1', 'Only run this smoke test on an isolated local preview.')
const output = path.resolve(process.argv[4] || '.test-runtime/learning-trends-browser')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const localDate = (offset = 0) => {
    const value = new Date(Date.now() + offset * 86400000)
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
  }
  const today = localDate()
  const registered = await context.request.post(`${base}/api/v1/public/register`, {
    headers: { origin: base }, data: { username: `trend_${Date.now()}`, password: `Test-${randomUUID()}` },
  })
  assert.equal(registered.status(), 200, await registered.text())
  const bootstrap = await (await context.request.get(`${base}/api/v1/bootstrap`)).json()
  async function write(endpoint, data) {
    const response = await context.request.post(`${base}/api/v1${endpoint}`, {
      headers: { origin: base, 'x-local-token': bootstrap.local_token }, data,
    })
    assert.ok(response.ok(), `${endpoint}: ${response.status()} ${await response.text()}`)
    return response.json()
  }
  const goal = await write('/learning/goals', { name: '学习趋势验收', start_date: today, target_date: localDate(7) })
  const empty = await write('/learning/goals', { name: '暂无记录目标' })
  await write(`/learning/goals/${goal.id}/sessions`, { studied_on: localDate(-1), actual_minutes: 20 })
  for (const title of ['词汇练习', '阅读练习']) {
    await write(`/learning/goals/${goal.id}/tasks`, { title, plan_date: today, estimated_minutes: 25 })
  }
  await page.goto(`${base}/learning?item=${goal.id}`, { waitUntil: 'networkidle' })
  const card = page.locator('.learning-trends')
  await card.getByTestId('trend-minutes').getByText('20', { exact: true }).waitFor()
  await page.getByRole('tab', { name: '学习记录', exact: true }).click()
  await page.getByRole('button', { name: '记录一次学习' }).click()
  const modal = page.getByRole('dialog').filter({ hasText: '记录学习' })
  await modal.getByLabel('学习日期').fill(today)
  await modal.getByLabel('学习日期').press('Enter')
  await modal.getByLabel('实际分钟').fill('30')
  await modal.getByRole('button', { name: '创建', exact: true }).click()
  await modal.waitFor({ state: 'hidden' })
  await card.getByTestId('trend-minutes').getByText('50', { exact: true }).waitFor()
  assert.equal(await card.getByTestId('trend-streak').innerText(), '2')

  await page.getByRole('tab', { name: '学习计划', exact: true }).click()
  await page.getByLabel('完成学习任务 词汇练习', { exact: true }).click()
  await card.getByTestId('trend-completion').getByText('50%', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('完成学习任务 词汇练习', { exact: true }).isChecked(), true)
  await card.scrollIntoViewIfNeeded()
  await card.screenshot({ path: path.join(output, 'trends-light.png') })
  await card.getByText('查看每日明细', { exact: true }).click()
  assert.ok((await card.getByRole('table').innerText()).includes('20'))
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/learning/trends?') && response.url().includes('days=30') && response.status() === 200),
    card.getByText('近30天', { exact: true }).click(),
  ])
  await card.getByTestId('trend-minutes').getByText('50', { exact: true }).waitFor()
  await card.getByText('近90天', { exact: true }).click()
  await card.getByTestId('trend-minutes').getByText('50', { exact: true }).waitFor()
  await card.getByText('近7天', { exact: true }).click()
  await card.getByTestId('trend-minutes').getByText('50', { exact: true }).waitFor()

  await page.getByRole('button', { name: '开始专注', exact: true }).click()
  await page.getByRole('button', { name: '结束专注并计入时长' }).click()
  await card.getByRole('radiogroup', { name: '学习时长来源' }).getByText('专注计时', { exact: true }).click()
  await card.getByTestId('trend-streak').getByText('1', { exact: true }).waitFor()
  assert.notEqual(await card.getByTestId('trend-minutes').innerText(), '未记录')
  await card.getByRole('radiogroup', { name: '学习时长来源' }).getByText('手动记录', { exact: true }).click()
  assert.equal(await card.getByTestId('trend-minutes').innerText(), '50')
  await page.getByRole('link', { name: '今日计划', exact: true }).click()
  await page.getByRole('link', { name: '学习计划', exact: true }).click()
  await card.getByTestId('trend-minutes').getByText('50', { exact: true }).waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  await card.getByTestId('trend-minutes').getByText('50', { exact: true }).waitFor()
  await card.getByLabel('趋势学习目标').selectOption(empty.id)
  await card.getByText('暂无学习数据，记录学习或结束专注后即可查看').waitFor()
  await card.getByLabel('趋势学习目标').selectOption(goal.id)
  await card.getByTestId('trend-minutes').getByText('50', { exact: true }).waitFor()
  await page.setViewportSize({ width: 430, height: 950 })
  await card.scrollIntoViewIfNeeded()
  await card.screenshot({ path: path.join(output, 'trends-mobile.png') })
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(JSON.stringify({ passed: true, checks: ['manual record auto-refresh', 'streak', 'task completion', '7/30/90 days', 'focus source separation', 'navigation and reload', 'goal scope', 'mobile rendering'], artifacts: output }))
} finally {
  await browser.close()
}
