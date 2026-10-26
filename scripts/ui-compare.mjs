/**
 * Front/back consistency check: read the device-group history table from the real
 * page, then compare the same rows with the aggregate API response.
 * Dev helper only (not shipped in releases).
 */

import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const BASE_API = 'http://127.0.0.1:8017'
const BASE_UI = 'http://127.0.0.1:8090'
const state = JSON.parse(readFileSync('D:/dsh/.ft/auth/mmkj-state.json', 'utf8').replace(/^\uFEFF/, ''))
const token = state.cookies.find((cookie) => cookie.name === 'mm_token').value

const pad = (n) => String(n).padStart(2, '0')
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const now = new Date()
const start24h = fmt(new Date(now.getTime() - 24 * 3600 * 1000))
const endTime = fmt(now)

async function apiHistory(groupId, interval) {
  const params = new URLSearchParams({ startTime: start24h, endTime, realtimeInterval: '5m', historyInterval: interval, aggregation: 'LAST' })
  const response = await fetch(`${BASE_API}/iot/device-group/${groupId}/aggregate?${params}`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await response.json()
  const history = body.data.history
  return { interval: history.interval, rows: history.rows, columns: history.columns }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ storageState: state, baseURL: BASE_UI, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto('/device/deviceList')
  await page.getByText('设备组列表').first().waitFor({ state: 'visible', timeout: 20000 })
  await page.getByText('气象监测').first().click()
  await page.locator('.dl-history__sampled').first().waitFor({ state: 'visible', timeout: 30000 })

  async function readUi() {
    return page.evaluate(() => {
      const sampled = document.querySelector('.dl-history__sampled')?.textContent?.trim() ?? null
      const total = document.querySelector('.el-pagination__total')?.textContent?.trim() ?? null
      const headers = [...document.querySelectorAll('.dl-history__table thead th')].map((th) => th.textContent.trim())
      const rows = [...document.querySelectorAll('.dl-history__table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
      return { sampled, total, headers, rows }
    })
  }

  async function switchInterval(label) {
    await page.locator('.dl-history__interval').first().click()
    await page.getByText(label, { exact: true }).last().click()
    await page.locator('.dl-history__interval').first().press('Tab')
    await page.waitForTimeout(1500)
  }

  function compare(ui, api) {
    const apiRowsByTs = new Map(api.rows.map((row) => [row.ts, row]))
    const headerKeys = api.columns.map((column) => column.title)
    const mismatches = []
    let comparedRows = 0
    let comparedCells = 0
    for (const uiRow of ui.rows) {
      const ts = uiRow[0]
      const apiRow = apiRowsByTs.get(ts)
      if (!apiRow) continue
      comparedRows += 1
      for (let i = 0; i < api.columns.length; i += 1) {
        const column = api.columns[i]
        const uiValue = uiRow[i + 1]
        const apiValue = apiRow[column.key]
        const normalizedApi = apiValue === null || apiValue === undefined ? '-' : String(apiValue)
        comparedCells += 1
        if (uiValue !== normalizedApi) mismatches.push({ ts, column: column.key, ui: uiValue, api: normalizedApi })
      }
    }
    return {
      sampledMatches: ui.sampled === `采样间隔 ${api.interval}`,
      uiSampled: ui.sampled,
      apiInterval: api.interval,
      totalMatches: ui.total === null ? null : ui.total === `共 ${api.rows.length} 条`,
      uiTotal: ui.total,
      apiRows: api.rows.length,
      headerCount: ui.headers.length,
      apiColumns: api.columns.length,
      uiTs: ui.rows.map((row) => row[0]),
      apiFirstTs: api.rows[0]?.ts ?? null,
      comparedRows,
      comparedCells,
      mismatches: mismatches.slice(0, 10),
      mismatchCount: mismatches.length,
    }
  }

  const ui30 = await readUi()
  const api30 = await apiHistory(6, '30m')
  const result30 = compare(ui30, api30)
  console.log(JSON.stringify({ interval: '30m', ...result30 }))

  await switchInterval('5分钟')
  const ui5 = await readUi()
  const api5 = await apiHistory(6, '5m')
  const result5 = compare(ui5, api5)
  console.log(JSON.stringify({ interval: '5m', ...result5 }))
} finally {
  await browser.close()
}
