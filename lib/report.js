/** Markdown report rendering. */

// errorKind values from `ft-contract.md` §8 that belong to the "assertion" class.
// Everything else that is not passed/skipped/blocked is an execution error.
const ASSERTION_ERROR_KINDS = new Set(['assertion_failed', 'latency_exceeded'])

/**
 * Classify one record for the report.
 *
 * `record.kind` is the run kind (`http` | `ui`), never the failure kind, so the
 * classification must come from `status` + `errorKind`. Regression guard: a
 * regression test in `test/report.test.js` uses real record shapes.
 */
export function severityOf(record) {
  if (record.status === 'passed') return 'passed'
  if (record.status === 'skipped') return 'skipped'
  if (record.status === 'blocked' || record.errorKind === 'blocked_by_policy') return 'blocked'
  if (ASSERTION_ERROR_KINDS.has(record.errorKind)) return 'failed'
  return 'error'
}

function short(text, limit = 800) {
  if (typeof text !== 'string') return ''
  const normalized = text.replace(/\r\n/g, '\n')
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n… (truncated)` : normalized
}

/**
 * Render `report.md` for one or more runs.
 * @param {{title:string, environment?:string, baseUrl?:string, records:Array, startedAt?:string, finishedAt?:string, knownFailures?:string[]}} input
 */
export function renderReport(input) {
  const known = new Set(input.knownFailures ?? [])
  const records = input.records
  const total = records.length
  const passed = records.filter((r) => severityOf(r) === 'passed').length
  const skipped = records.filter((r) => severityOf(r) === 'skipped').length
  const failed = records.filter((r) => severityOf(r) === 'failed').length
  const errors = records.filter((r) => severityOf(r) === 'error').length
  const blocked = records.filter((r) => severityOf(r) === 'blocked').length
  const rate = total === 0 ? 0 : Math.round((passed / total) * 1000) / 10

  const lines = []
  lines.push(`# ${input.title}`, '')
  lines.push('## 1. 概览', '')
  if (input.environment) lines.push(`- 环境：${input.environment}`)
  if (input.baseUrl) lines.push(`- 地址：${input.baseUrl}`)
  if (input.startedAt) lines.push(`- 时间：${input.startedAt}${input.finishedAt ? ` ~ ${input.finishedAt}` : ''}`)
  lines.push(`- 用例：共 ${total}，通过 ${passed}，失败 ${failed}，错误 ${errors}，阻塞 ${blocked}，跳过 ${skipped}`)
  lines.push(`- 通过率：${rate}%`, '')

  const failedRecords = records.filter((r) => severityOf(r) === 'failed')
  lines.push('## 2. 失败明细', '')
  if (failedRecords.length === 0) {
    lines.push('无。', '')
  } else {
    for (const record of failedRecords) {
      const knownTag = known.has(record.caseId) ? '（已知问题）' : ''
      lines.push(`### ${record.caseId} ${record.caseName}${knownTag}`, '')
      if (record.request) lines.push(`- 请求：${record.request.method} ${record.request.url}`)
      const failures = (record.assertions ?? []).filter((item) => item.ok === false)
      for (const item of failures) {
        lines.push(`- 断言：\`${item.path}\` ${item.op} 期望 ${JSON.stringify(item.expected)}，实际 ${JSON.stringify(item.actual)}`)
      }
      if (record.message) lines.push(`- 信息：${short(record.message, 300)}`)
      lines.push(`- 证据：results.jsonl#${record.caseId}`, '')
    }
  }

  const errorRecords = records.filter((r) => severityOf(r) === 'error')
  lines.push('## 3. 错误与阻塞', '')
  if (errorRecords.length === 0 && blocked === 0) {
    lines.push('无。', '')
  } else {
    for (const record of records.filter((r) => ['error', 'blocked'].includes(severityOf(r)))) {
      lines.push(`- ${record.caseId} ${record.caseName}：${severityOf(record)} / ${record.errorKind ?? 'unknown'}${record.message ? ` — ${short(record.message, 200)}` : ''}`)
    }
    lines.push('')
  }

  const warnings = records.flatMap((record) => (record.warnings ?? []).map((warning) => `${record.caseId}: ${warning}`))
  lines.push('## 4. 警告', '')
  if (warnings.length === 0) {
    lines.push('无。', '')
  } else {
    for (const warning of warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  lines.push('## 5. 结论与建议', '')
  const productBugs = failedRecords.filter((record) => record.errorKind !== 'test_case_defect')
  lines.push(`- 疑似产品缺陷：${productBugs.length} 个`)
  lines.push(`- 环境/执行错误：${errors} 个`)
  lines.push(`- 被策略拦截：${blocked} 个`)
  lines.push('- 遗留风险：待人工确认失败用例的归属（产品缺陷 / 用例缺陷 / 环境问题）', '')
  return lines.join('\n')
}
