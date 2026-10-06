import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'

// Run against an isolated PersonalHub test instance, never the personal database.
const [baseUrl, playwrightPath, artifactPath] = process.argv.slice(2)
if (!baseUrl || !playwrightPath || !artifactPath) throw new Error('Usage: node scripts/test-diet-browser.mjs <test-url> <playwright-module> <artifact-directory>')
const require = createRequire(import.meta.url)
const { chromium } = require(playwrightPath)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  const bootstrap = await (await page.request.get(`${baseUrl}/api/v1/bootstrap`)).json()
  assert.match(bootstrap.database_path, /diet-browser/)
  const headers = { 'X-Local-Token': bootstrap.local_token }
  const today = await page.evaluate(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  const response = await page.request.post(`${baseUrl}/api/v1/diet/meals`, {
    headers, data: { meal_date: today, meal_type: 'lunch', custom_name: '浏览器验收餐食' },
  })
  assert.equal(response.status(), 201)
  const meal = await response.json()
  await page.goto(`${baseUrl}/diet`)
  await page.getByRole('table', { name: '饮食月历' }).waitFor()
  assert.equal(await page.getByRole('columnheader').first().textContent(), '周一')
  assert.equal(await page.getByRole('cell', { name: today, exact: true }).getAttribute('aria-current'), 'date')
  await mkdir(artifactPath, { recursive: true })
  await page.screenshot({ path: `${artifactPath}/calendar.png`, fullPage: true })
  await page.getByLabel(`修改 ${today} 午餐`, { exact: true }).click()
  await page.getByLabel('或填写其他餐食').fill('浏览器验收沙拉')
  await page.getByLabel('实际饮食（可选）').fill('鸡胸肉蔬菜沙拉')
  await page.getByRole('button', { name: '保存修改', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByText('实际：鸡胸肉蔬菜沙拉', { exact: true }).waitFor()
  let home = await (await page.request.get(`${baseUrl}/api/v1/home?date=${today}`)).json()
  assert.equal(home.agenda.find((item) => item.source_id === meal.id).title, '午餐：浏览器验收沙拉')
  await page.getByLabel(`修改 ${today} 午餐`, { exact: true }).click()
  await page.getByRole('button', { name: '删除这餐', exact: true }).click()
  await page.getByRole('button', { name: /^确\s*认$/ }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await page.getByText('浏览器验收沙拉', { exact: true }).count(), 0)
  home = await (await page.request.get(`${baseUrl}/api/v1/home?date=${today}`)).json()
  assert.equal(home.agenda.length, 0)
  assert.equal(home.summaries.diet.count, 0)
  assert.deepEqual(await (await page.request.get(`${baseUrl}/api/v1/search?q=${encodeURIComponent('浏览器验收沙拉')}`)).json(), [])
  await page.reload()
  await page.getByRole('table', { name: '饮食月历' }).waitFor()
  assert.equal(await page.getByText('浏览器验收沙拉', { exact: true }).count(), 0)
  await page.getByRole('button', { name: '下一月', exact: true }).click()
  await page.getByRole('button', { name: '回到今天', exact: true }).click()
  await page.getByRole('cell', { name: today, exact: true }).waitFor()
  await page.getByRole('button', { name: '安排一餐', exact: true }).click()
  await page.getByLabel('或填写其他餐食').fill('新建验收餐食')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByText('新建验收餐食', { exact: true }).waitFor()
  await page.screenshot({ path: `${artifactPath}/calendar-after-changes.png`, fullPage: true })
  assert.deepEqual(errors, [])
  console.log('PASS: monthly calendar, create, edit, confirmed delete, reload persistence, home and search sync; no browser errors.')
} finally {
  await browser.close()
}
