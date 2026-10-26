/** UI runner over playwright-core: drive the local Chrome/Edge, assert, and keep evidence. */

import path from 'node:path'
import { resolveConfig, isHostAllowed } from './config.js'
import * as art from './artifacts.js'
import { renderReport } from './report.js'

const DEFAULT_STEP_TIMEOUT = 15000

function parseSelector(selector) {
  if (typeof selector !== 'string' || selector.length === 0) throw new Error('selector must be a non-empty string')
  if (selector.startsWith('css=')) return { kind: 'css', value: selector.slice(4) }
  if (selector.startsWith('text!=')) return { kind: 'text-exact', value: selector.slice(6) }
  if (selector.startsWith('text=')) return { kind: 'text', value: selector.slice(5) }
  if (selector.startsWith('testid=')) return { kind: 'testid', value: selector.slice(7) }
  return { kind: 'css', value: selector }
}

function locate(page, selector) {
  const parsed = parseSelector(selector)
  if (parsed.kind === 'css') return page.locator(parsed.value)
  if (parsed.kind === 'text') return page.getByText(parsed.value, { exact: false })
  if (parsed.kind === 'text-exact') return page.getByText(parsed.value, { exact: true })
  return page.getByTestId(parsed.value)
}

async function pollText(locator, op, value, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await locator.first().textContent({ timeout: 1000 })
      if (last !== null) {
        if (op === 'equals' && last.trim() === String(value)) return { ok: true, actual: last }
        if (op === 'contains' && last.includes(String(value))) return { ok: true, actual: last }
      }
    } catch {
      // keep polling until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Object.assign(new Error(`assertText "${op}" failed; last text: ${JSON.stringify(last ?? null)}`), {
    kind: 'ui_assertion',
  })
}

async function runStep(page, step, context) {
  const timeout = Number(step.timeoutMs ?? context.timeoutMs ?? DEFAULT_STEP_TIMEOUT)
  const action = String(step.action)
  switch (action) {
    case 'goto':
      await page.goto(String(step.url), { waitUntil: 'domcontentloaded', timeout })
      return
    case 'click':
      await locate(page, step.selector).first().click({ timeout })
      return
    case 'fill':
      await locate(page, step.selector).first().fill(String(step.value), { timeout })
      return
    case 'press':
      await locate(page, step.selector).first().press(String(step.key), { timeout })
      return
    case 'select':
      await locate(page, step.selector).first().selectOption(String(step.value), { timeout })
      return
    case 'hover':
      await locate(page, step.selector).first().hover({ timeout })
      return
    case 'waitFor': {
      const state = String(step.state ?? 'visible')
      await locate(page, step.selector).first().waitFor({ state, timeout })
      return
    }
    case 'waitForResponse': {
      const urlPart = String(step.urlContains)
      const statuses = Array.isArray(step.status) ? step.status.map(Number) : undefined
      await page.waitForResponse(
        (response) => response.url().includes(urlPart) && (statuses === undefined || statuses.includes(response.status())),
        { timeout },
      )
      return
    }
    case 'assertText':
      await pollText(locate(page, step.selector), String(step.op ?? 'contains'), step.value, timeout)
      return
    case 'assertVisible':
      await locate(page, step.selector).first().waitFor({ state: 'visible', timeout })
      return
    case 'screenshot':
      await page.screenshot({ path: path.join(context.shotsDir, `${step.name ?? `step-${context.stepIndex}`}.png`), fullPage: false })
      return
    default:
      throw Object.assign(new Error(`unsupported action "${action}"`), { kind: 'setup_error' })
  }
}

function errorKindOf(error) {
  if (error?.kind === 'setup_error') return 'setup_error'
  if (error?.kind === 'ui_assertion') return 'assertion_failed'
  if (String(error?.name ?? '').includes('Timeout')) return 'selector_timeout'
  if (String(error?.name ?? '').includes('Error') && String(error?.message ?? '').includes('Executable doesn')) return 'browser_launch_failed'
  return 'ui_step_error'
}

/**
 * Execute an UI flow suite.
 * @param {{args:object, cwd:string, signal?:AbortSignal}} options
 */
export async function runUi({ args, cwd, signal }) {
  const warnings = []
  const runName = art.sanitizeRunName(args.runName)
  const { config, envName, warnings: configWarnings } = await resolveConfig({ cwd, env: args.env, overrides: {} })
  warnings.push(...configWarnings)
  const baseUrl = args.baseUrl ?? config.baseUrls?.ui ?? config.baseUrls?.[envName]
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw Object.assign(new Error('no baseUrl: pass args.baseUrl or config.baseUrls.ui'), { kind: 'setup_error' })
  }
  const check = isHostAllowed(baseUrl, config.allowedHosts)
  if (!check.allowed) throw Object.assign(new Error(check.reason), { kind: 'blocked_by_policy' })
  const flows = Array.isArray(args.flows) ? args.flows : []
  if (flows.length === 0) throw Object.assign(new Error('flows must be a non-empty array'), { kind: 'setup_error' })
  const ids = new Set()
  for (const flow of flows) {
    if (typeof flow.id !== 'string' || flow.id.length === 0) throw Object.assign(new Error('every flow needs an id'), { kind: 'setup_error' })
    if (ids.has(flow.id)) throw Object.assign(new Error(`duplicate flow id "${flow.id}"`), { kind: 'setup_error' })
    ids.add(flow.id)
  }

  let playwright
  try {
    playwright = await import('playwright-core')
  } catch (error) {
    throw Object.assign(new Error(`playwright-core is not installed: ${error.message}`), { kind: 'browser_launch_failed' })
  }
  const browserConfig = { ...config.browser, ...(args.browser ?? {}) }
  const login = args.login ?? { mode: 'none' }
  const runId = art.makeRunId(runName)
  const { root, dir } = art.resolveRunDir(cwd, config.artifacts, runId)
  await art.ensureWorkspaceState(cwd)
  await art.ensureRunDir(dir)
  const shotsDir = path.join(dir, 'shots')
  const startedAt = new Date().toISOString()
  const records = []

  let browser
  try {
    browser = await playwright.chromium.launch({
      channel: browserConfig.channel,
      headless: browserConfig.headless !== false,
      executablePath: browserConfig.executablePath,
      args: ['--no-sandbox'],
    })
  } catch (error) {
    throw Object.assign(new Error(`browser launch failed (channel ${browserConfig.channel}): ${error.message}`), {
      kind: 'browser_launch_failed',
    })
  }

  try {
    let storageState
    if (login.mode === 'storageState') {
      if (typeof login.path !== 'string' || login.path.length === 0) {
        throw Object.assign(new Error('login.path is required for storageState'), { kind: 'setup_error' })
      }
      storageState = path.resolve(cwd, login.path)
    }
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: browserConfig.viewport,
      storageState,
    })
    if (login.mode === 'cookies' && Array.isArray(login.cookies)) {
      await context.addCookies(login.cookies)
    }

    for (const flow of flows) {
      const page = await context.newPage()
      const consoleErrors = []
      const failedRequests = []
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
      page.on('response', (response) => {
        if (response.status() >= 400) failedRequests.push({ url: response.url(), status: response.status() })
      })
      const record = {
        schemaVersion: 1,
        runId,
        kind: 'ui',
        caseId: flow.id,
        caseName: flow.name ?? flow.id,
        status: 'passed',
        errorKind: null,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        flow: { flowId: flow.id, steps: [] },
        browser: { url: null, consoleErrors, failedRequests },
        assertions: [],
        warnings: [],
        artifacts: { screenshot: null },
      }
      const flowStarted = Date.now()
      const steps = Array.isArray(flow.steps) ? flow.steps : []
      for (let index = 0; index < steps.length; index += 1) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { kind: 'timeout' })
        const step = steps[index]
        try {
          await runStep(page, step, { timeoutMs: browserConfig.timeoutMs, shotsDir, stepIndex: index })
          record.flow.steps.push({ index, action: step.action, ok: true })
        } catch (error) {
          const screenshot = path.join(shotsDir, `${flow.id}-failed-step-${index}.png`)
          try {
            await page.screenshot({ path: screenshot })
            record.artifacts.screenshot = path.relative(cwd, screenshot)
          } catch {
            record.artifacts.screenshot = null
          }
          record.status = 'failed'
          record.errorKind = errorKindOf(error)
          record.message = error.message
          record.flow.steps.push({ index, action: step.action, ok: false, message: error.message })
          break
        }
      }
      record.durationMs = Date.now() - flowStarted
      record.browser.url = page.url()
      await page.close()
      records.push(record)
    }
    await context.close()
  } finally {
    await browser.close().catch(() => {})
  }

  const finishedAt = new Date().toISOString()
  const counts = summarize(records)
  counts.durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  const artifacts = { dir: path.relative(cwd, dir), report: '' }
  await art.writeJSONLines(path.join(dir, 'results.jsonl'), records)
  const report = renderReport({
    title: `${runName} UI 功能测试报告`,
    environment: envName,
    baseUrl,
    records,
    startedAt,
    finishedAt,
  })
  await art.writeText(path.join(dir, 'report.md'), report)
  artifacts.report = path.relative(cwd, path.join(dir, 'report.md'))
  await art.pruneRuns(root, config.artifacts.keepRuns)

  return {
    runId,
    summary: counts,
    failed: records
      .filter((record) => record.status !== 'passed')
      .map((record) => ({
        id: record.caseId,
        name: record.caseName,
        kind: record.errorKind === 'assertion_failed' ? 'assertion' : 'error',
        errorKind: record.errorKind,
        ...(record.message ? { message: record.message } : {}),
        assertions: [],
      })),
    warnings,
    artifacts,
  }
}

function summarize(records) {
  const counts = { total: records.length, passed: 0, failed: 0, errors: 0, skipped: 0, blocked: 0, durationMs: 0 }
  for (const record of records) {
    if (record.status === 'passed') counts.passed += 1
    else if (record.status === 'failed') counts.failed += 1
    else counts.errors += 1
  }
  return counts
}
