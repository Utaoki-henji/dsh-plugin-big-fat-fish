/** HTTP black-box runner: request execution, assertion judging, evidence writing. */

import path from 'node:path'
import { resolveConfig, isHostAllowed, isDestructiveAllowed } from './config.js'
import { loadSuite, expandCase } from './suite.js'
import { evaluateAssertions } from './assert.js'
import { getPath } from './jsonpath.js'
import { maskHeaders, maskExtracted, maskValue, redactText, resolveEnvRef } from './redact.js'
import { loadCredentialStore, credentialLookup } from './credentials.js'
import * as art from './artifacts.js'
import { renderReport } from './report.js'

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

function nowISO() {
  return new Date().toISOString()
}

function classifyError(error) {
  const name = error?.name ?? ''
  const code = error?.code ?? error?.cause?.code ?? ''
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'network_error'
  if (code === 'CERT_HAS_EXPIRED' || String(code).startsWith('ERR_TLS') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'tls_error'
  return 'network_error'
}

function authHeaders(config, name, env = process.env) {
  if (name === undefined) return {}
  const entry = config.auth?.[name]
  if (entry === undefined) throw Object.assign(new Error(`unknown auth profile "${name}"`), { kind: 'setup_error' })
  const raw = entry.env ? env[entry.env] : undefined
  if (!raw) throw Object.assign(new Error(`auth "${name}" requires environment variable ${entry.env}`), { kind: 'setup_error' })
  const value = resolveEnvRef(raw, env)
  if (entry.type === 'bearer') return { Authorization: `Bearer ${value}` }
  if (entry.type === 'basic') return { Authorization: `Basic ${Buffer.from(value).toString('base64')}` }
  return { [entry.name ?? 'X-Api-Key']: value }
}

async function readBounded(res, maxBytes) {
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), truncated: false, bytes: buffer.length }
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true, bytes: buffer.length }
}

function headersToObject(headers) {
  const out = {}
  for (const [key, value] of headers.entries()) out[key] = value
  return out
}

async function performRequest({ url, method, headers, body, timeoutMs, config, signal }) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs)
  try {
    let current = url
    let hops = 0
    while (true) {
      const response = await fetch(current, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      })
      const status = response.status
      const location = response.headers.get('location')
      if (status >= 300 && status < 400 && location && config.request.followRedirects) {
        if (hops >= 5) throw Object.assign(new Error('too many redirects'), { kind: 'invalid_response' })
        const next = new URL(location, current).toString()
        const check = isHostAllowed(next, config.allowedHosts)
        if (!check.allowed) throw Object.assign(new Error(`redirect blocked: ${check.reason}`), { kind: 'blocked_by_policy' })
        if (status !== 307 && status !== 308) {
          method = 'GET'
          body = undefined
        }
        current = next
        hops += 1
        continue
      }
      return { response, finalUrl: current }
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function recordStatusOf(errorKind) {
  return errorKind === 'blocked_by_policy' ? 'blocked' : 'error'
}

/**
 * Execute an HTTP suite.
 * @param {{args:object, cwd:string, signal?:AbortSignal}} options
 */
export async function runHttp({ args, cwd, signal }) {
  const warnings = []
  const runName = art.sanitizeRunName(args.runName)
  const { config, envName, warnings: configWarnings } = await resolveConfig({
    cwd,
    env: args.env,
    overrides: {},
  })
  warnings.push(...configWarnings)
  // `${env:NAME}` resolves from the launch environment first, then from the
  // workspace-local credential store (internal systems that cannot self-register).
  const credentials = await loadCredentialStore(cwd)
  warnings.push(...credentials.warnings)
  const envLookup = credentialLookup(credentials.variables)
  const loaded = await loadSuite({
    cwd,
    suitePath: args.suitePath,
    cases: args.cases,
    runName,
    variables: args.variables ?? {},
    env: args.env,
  })
  warnings.push(...loaded.warnings)
  const suite = loaded.suite
  const variables = { ...(suite.variables ?? {}) }

  const baseUrl = args.baseUrl ?? suite.defaults?.baseUrl ?? config.baseUrls?.api ?? config.baseUrls?.[envName]
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw Object.assign(new Error('no baseUrl: pass args.baseUrl, suite.defaults.baseUrl, or config.baseUrls'), { kind: 'setup_error' })
  }
  const baseCheck = isHostAllowed(baseUrl, config.allowedHosts)
  if (!baseCheck.allowed) throw Object.assign(new Error(baseCheck.reason), { kind: 'blocked_by_policy' })

  const runId = art.makeRunId(runName)
  const { root, dir } = art.resolveRunDir(cwd, config.artifacts, runId)
  await art.ensureWorkspaceState(cwd)
  await art.ensureRunDir(dir)
  const startedAt = nowISO()
  const records = []
  const options = { stopOnFailure: false, saveResponseBody: true, concurrency: 1, retryOnError: 0, ...(args.options ?? {}) }
  if (options.concurrency !== 1) {
    throw Object.assign(new Error('v1 only supports options.concurrency = 1'), { kind: 'setup_error' })
  }

  const allCases = [...suite.cases]
  const teardownIds = new Set()
  const teardown = Array.isArray(suite.teardown) ? suite.teardown : []
  for (const testCase of teardown) {
    if (teardownIds.has(testCase.id)) throw Object.assign(new Error(`duplicate teardown id "${testCase.id}"`), { kind: 'setup_error' })
    teardownIds.add(testCase.id)
    allCases.push({ ...testCase, __teardown: true })
  }

  let stopped = false
  for (const rawCase of allCases) {
    const isTeardown = rawCase.__teardown === true
    if (stopped && !isTeardown) continue
    const baseRecord = {
      schemaVersion: 1,
      runId,
      kind: 'http',
      caseId: rawCase.id,
      caseName: rawCase.name ?? rawCase.id,
      status: 'skipped',
      errorKind: null,
      startedAt: nowISO(),
      durationMs: 0,
      request: null,
      response: null,
      assertions: [],
      warnings: [],
      extract: undefined,
      artifacts: { screenshot: null },
    }

    if (rawCase.skip === true) {
      records.push(baseRecord)
      continue
    }

    let testCase
    try {
      testCase = expandCase(rawCase, variables, envLookup)
    } catch (error) {
      records.push({ ...baseRecord, status: 'error', errorKind: 'setup_error', message: error.message })
      stopped = true
      continue
    }

    let url
    try {
      url = new URL(testCase.request.path, baseUrl)
      if (testCase.request.query) {
        for (const [key, value] of Object.entries(testCase.request.query)) {
          url.searchParams.set(key, String(value))
        }
      }
    } catch (error) {
      records.push({ ...baseRecord, status: 'error', errorKind: 'setup_error', message: `bad URL: ${error.message}` })
      continue
    }

    const hostCheck = isHostAllowed(url.toString(), config.allowedHosts)
    if (!hostCheck.allowed) {
      records.push({ ...baseRecord, status: 'blocked', errorKind: 'blocked_by_policy', message: hostCheck.reason })
      if (options.stopOnFailure) stopped = true
      continue
    }

    const method = testCase.request.method
    if (WRITE_METHODS.includes(method) && testCase.destructive !== true) {
      records.push({ ...baseRecord, status: 'blocked', errorKind: 'blocked_by_policy', message: `${method} requires destructive: true` })
      if (options.stopOnFailure) stopped = true
      continue
    }
    if (testCase.destructive === true && !isDestructiveAllowed(method, url.pathname, config)) {
      records.push({ ...baseRecord, status: 'blocked', errorKind: 'blocked_by_policy', message: `${method} ${url.pathname} is not covered by destructive.rules` })
      if (options.stopOnFailure) stopped = true
      continue
    }

    const headers = {
      ...(suite.defaults?.headers ?? {}),
      ...(testCase.request.headers ?? {}),
    }
    try {
      Object.assign(headers, authHeaders(config, testCase.auth ?? suite.defaults?.auth, envLookup))
    } catch (error) {
      records.push({ ...baseRecord, status: 'error', errorKind: 'setup_error', message: error.message })
      stopped = true
      continue
    }
    let body
    if (testCase.request.body !== undefined) {
      const encoding = testCase.request.bodyEncoding ?? (typeof testCase.request.body === 'object' ? 'json' : 'text')
      if (encoding === 'json') {
        body = JSON.stringify(testCase.request.body)
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
          headers['content-type'] = 'application/json'
        }
      } else if (encoding === 'form') {
        body = new URLSearchParams(testCase.request.body).toString()
        headers['content-type'] = 'application/x-www-form-urlencoded'
      } else {
        body = String(testCase.request.body)
      }
    }

    const timeoutMs = Number(testCase.timeoutMs ?? suite.defaults?.timeoutMs ?? config.request.timeoutMs)
    const attempt = async () => {
      const started = Date.now()
      const { response, finalUrl } = await performRequest({
        url: url.toString(),
        method,
        headers,
        body,
        timeoutMs,
        config,
        signal,
      })
      const latencyMs = Date.now() - started
      const bodyRead = await readBounded(response, config.request.maxResponseBytes)
      if (bodyRead.truncated) {
        // A truncated body cannot be asserted on; reporting every JSONPath as
        // "missing" would be a false product defect, so fail as an execution error.
        throw Object.assign(
          new Error(`response body ${bodyRead.bytes} bytes exceeds request.maxResponseBytes ${config.request.maxResponseBytes}; raise the limit or narrow the query`),
          { kind: 'invalid_response' },
        )
      }
      let json
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('json') || /^\s*[[{]/.test(bodyRead.text)) {
        try {
          json = JSON.parse(bodyRead.text)
        } catch (error) {
          throw Object.assign(new Error(`response is not valid JSON: ${error.message}`), { kind: 'invalid_response' })
        }
      }
      return {
        request: {
          method,
          url: finalUrl,
          headers: maskHeaders(headers, config.redact.keys),
          body: body === undefined ? undefined : redactBody(body, config.redact.keys),
        },
        response: {
          status: response.status,
          headers: maskHeaders(headersToObject(response.headers), config.redact.keys),
          body: options.saveResponseBody ? redactText(bodyRead.text.slice(0, 4096), config.redact.keys) : undefined,
          truncated: bodyRead.truncated,
          bytes: bodyRead.bytes,
        },
        assertionInput: {
          status: response.status,
          headers: headersToObject(response.headers),
          text: bodyRead.text,
          json,
        },
        latencyMs,
      }
    }

    let result
    let retry = Number(options.retryOnError ?? 0)
    while (true) {
      try {
        result = await attempt()
        break
      } catch (error) {
        const errorKind = typeof error?.kind === 'string' ? error.kind : classifyError(error)
        if (retry > 0 && ['network_error', 'timeout'].includes(errorKind)) {
          retry -= 1
          continue
        }
        records.push({
          ...baseRecord,
          status: recordStatusOf(errorKind),
          errorKind,
          message: error?.message ?? String(error),
          finishedAt: nowISO(),
        })
        if (options.stopOnFailure) stopped = true
        break
      }
    }
    if (result === undefined) continue

    let evaluated
    try {
      evaluated = evaluateAssertions(testCase.expect ?? {}, result.assertionInput, { latencyMs: result.latencyMs })
    } catch (error) {
      records.push({
        ...baseRecord,
        status: 'error',
        errorKind: 'setup_error',
        message: error.message,
        request: result.request,
        response: result.response,
        finishedAt: nowISO(),
      })
      stopped = true
      continue
    }

    // `latency_exceeded` is its own assertion class in the contract; everything
    // else that failed an assertion is `assertion_failed`.
    const failedAssertions = evaluated.assertions.filter((item) => item.ok === false)
    const onlyLatency = failedAssertions.length > 0 && failedAssertions.every((item) => item.path === 'latencyMs')
    const record = {
      ...baseRecord,
      status: evaluated.ok ? 'passed' : 'failed',
      errorKind: evaluated.ok ? null : onlyLatency ? 'latency_exceeded' : 'assertion_failed',
      request: result.request,
      response: result.response,
      assertions: evaluated.assertions,
      warnings: evaluated.warnings,
      latencyMs: result.latencyMs,
      finishedAt: nowISO(),
      extract: undefined,
    }
    if (evaluated.ok && testCase.extract) {
      const extracted = {}
      try {
        for (const [key, jsonPath] of Object.entries(testCase.extract)) {
          const { found, value } = getPath(result.assertionInput.json, jsonPath)
          if (found) {
            variables[key] = value
            extracted[key] = value
          }
        }
      } catch (error) {
        throw Object.assign(new Error(`extract failed: ${error.message}`), { kind: 'setup_error' })
      }
      record.extract = maskExtracted(extracted, config.redact.keys)
    }
    record.durationMs = result.latencyMs
    records.push(record)
    if (!evaluated.ok && options.stopOnFailure) stopped = true
  }

  const finishedAt = nowISO()
  const counts = summarize(records)
  counts.durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  const artifacts = { dir: path.relative(cwd, dir), report: '' }
  const suiteForDisk = {
    schemaVersion: suite.schemaVersion,
    name: suite.name,
    env: suite.env,
    defaults: maskValue(suite.defaults ?? {}, config.redact.keys),
    cases: (suite.cases ?? []).map((testCase) => maskValue(testCase, config.redact.keys)),
    teardown: (suite.teardown ?? []).map((testCase) => maskValue(testCase, config.redact.keys)),
  }
  await art.writeJSON(path.join(dir, 'suite.json'), suiteForDisk)
  await art.writeJSONLines(path.join(dir, 'results.jsonl'), records)
  const report = renderReport({
    title: `${suite.name ?? runName} 功能测试报告`,
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
      .filter((record) => record.status === 'failed' || record.status === 'error' || record.status === 'blocked')
      .slice(0, 20)
      .map((record) => ({
        id: record.caseId,
        name: record.caseName,
        kind: record.status === 'blocked' ? 'blocked' : record.status === 'failed' ? 'assertion' : 'error',
        errorKind: record.errorKind,
        ...(record.message ? { message: record.message } : {}),
        assertions: (record.assertions ?? []).filter((item) => item.ok === false).slice(0, 5),
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
    else if (record.status === 'error') counts.errors += 1
    else if (record.status === 'blocked') counts.blocked += 1
    else counts.skipped += 1
  }
  return counts
}

function safeParseJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Mask a request body before persisting it: structured JSON by key, raw text by pattern. */
function redactBody(body, keys) {
  const parsed = safeParseJSON(body)
  return typeof parsed === 'string' ? redactText(parsed, keys) : maskValue(parsed, keys)
}

export { summarize }
