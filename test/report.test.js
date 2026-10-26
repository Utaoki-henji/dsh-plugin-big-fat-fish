/**
 * Regression tests for report classification.
 *
 * The report used to classify failures with `record.kind === 'assertion'`, but
 * `kind` is the run kind (`http` | `ui`) — the real classification is
 * `status` + `errorKind`. Assertion failures were therefore rendered as
 * "错误" and the "失败明细" section stayed empty even when assertions failed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { renderReport, severityOf } from '../lib/report.js'

function httpRecord(overrides) {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    kind: 'http',
    caseId: 'TC-001',
    caseName: 'case',
    status: 'passed',
    errorKind: null,
    request: { method: 'GET', url: 'http://127.0.0.1:8080/api/users' },
    assertions: [],
    warnings: [],
    ...overrides,
  }
}

const records = [
  httpRecord({ caseId: 'TC-001', caseName: '通过用例' }),
  httpRecord({
    caseId: 'TC-002',
    caseName: '断言失败',
    status: 'failed',
    errorKind: 'assertion_failed',
    assertions: [{ path: 'status', op: 'in', expected: [200], actual: 500, ok: false }],
  }),
  httpRecord({
    caseId: 'TC-003',
    caseName: '延迟超标',
    status: 'failed',
    errorKind: 'latency_exceeded',
    assertions: [{ path: 'latencyMs', op: 'max', expected: 50, actual: 158, ok: false }],
  }),
  httpRecord({
    caseId: 'TC-004',
    caseName: '网络错误',
    status: 'error',
    errorKind: 'timeout',
    message: 'request timeout',
  }),
  httpRecord({
    caseId: 'TC-005',
    caseName: '策略拦截',
    status: 'blocked',
    errorKind: 'blocked_by_policy',
    message: 'POST requires destructive: true',
  }),
  httpRecord({ caseId: 'TC-006', caseName: '跳过', status: 'skipped' }),
  {
    schemaVersion: 1,
    runId: 'run-1',
    kind: 'ui',
    caseId: 'UF-001',
    caseName: 'UI 断言失败',
    status: 'failed',
    errorKind: 'assertion_failed',
    flow: { flowId: 'UF-001', steps: [] },
    browser: { url: 'http://127.0.0.1:5173/', consoleErrors: [], failedRequests: [] },
    assertions: [],
    warnings: [],
  },
  {
    schemaVersion: 1,
    runId: 'run-1',
    kind: 'ui',
    caseId: 'UF-002',
    caseName: 'UI 选择器超时',
    status: 'failed',
    errorKind: 'selector_timeout',
    message: 'locator.click: Timeout 15000ms exceeded.',
    flow: { flowId: 'UF-002', steps: [] },
    browser: { url: 'http://127.0.0.1:5173/', consoleErrors: [], failedRequests: [] },
    assertions: [],
    warnings: [],
  },
]

test('severityOf classifies real record shapes by status and errorKind', () => {
  assert.equal(severityOf({ status: 'passed' }), 'passed')
  assert.equal(severityOf({ status: 'skipped' }), 'skipped')
  assert.equal(severityOf({ kind: 'http', status: 'failed', errorKind: 'assertion_failed' }), 'failed')
  assert.equal(severityOf({ kind: 'http', status: 'failed', errorKind: 'latency_exceeded' }), 'failed')
  assert.equal(severityOf({ kind: 'ui', status: 'failed', errorKind: 'assertion_failed' }), 'failed')
  assert.equal(severityOf({ kind: 'ui', status: 'failed', errorKind: 'selector_timeout' }), 'error')
  assert.equal(severityOf({ kind: 'http', status: 'error', errorKind: 'network_error' }), 'error')
  assert.equal(severityOf({ kind: 'http', status: 'blocked', errorKind: 'blocked_by_policy' }), 'blocked')
  // `kind` is the run kind, not the failure class.
  assert.equal(severityOf({ kind: 'http', status: 'failed', errorKind: 'assertion_failed' }), 'failed')
})

test('report counts assertion failures as 失败 and lists them in 失败明细', () => {
  const report = renderReport({ title: 'demo', environment: 'local', records })

  assert.match(report, /共 8，通过 1，失败 3，错误 2，阻塞 1，跳过 1/)

  const failedSection = report.split('## 3.')[0]
  assert.match(failedSection, /TC-002/)
  assert.match(failedSection, /TC-003/)
  assert.match(failedSection, /UF-001/)
  // Errors and blocked cases stay out of 失败明细.
  assert.doesNotMatch(failedSection, /TC-004/)
  assert.doesNotMatch(failedSection, /TC-005/)
  assert.doesNotMatch(failedSection, /UF-002/)

  const errorSection = report.split('## 3.')[1].split('## 4.')[0]
  assert.match(errorSection, /TC-004/)
  assert.match(errorSection, /TC-005/)
  assert.match(errorSection, /UF-002/)

  assert.match(report, /疑似产品缺陷：3 个/)
  assert.match(report, /环境\/执行错误：2 个/)
  assert.match(report, /被策略拦截：1 个/)
})

test('report marks known failures and keeps request evidence', () => {
  const report = renderReport({
    title: 'demo',
    records: [records[1]],
    knownFailures: ['TC-002'],
  })
  assert.match(report, /已知问题/)
  assert.match(report, /GET http:\/\/127\.0\.0\.1:8080\/api\/users/)
  assert.match(report, /results\.jsonl#TC-002/)
})
