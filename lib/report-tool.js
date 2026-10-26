/** `ft_report`: rebuild a human-readable report from stored results. */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as art from './artifacts.js'
import { renderReport } from './report.js'

async function loadRecords(cwd, runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(runId)) {
    throw Object.assign(new Error(`invalid runId "${runId}"`), { kind: 'setup_error' })
  }
  const root = path.resolve(cwd, '.ft/runs')
  const dir = path.resolve(root, runId)
  if (!dir.startsWith(root + path.sep)) throw Object.assign(new Error('runId escapes artifacts root'), { kind: 'blocked_by_policy' })
  const file = path.join(dir, 'results.jsonl')
  try {
    const records = await art.readJSONLines(file)
    return { dir, records }
  } catch (error) {
    throw Object.assign(new Error(`cannot read ${path.relative(cwd, file)}: ${error.message}`), { kind: 'setup_error' })
  }
}

/**
 * Rebuild `report.md` (single run) or `report-summary.md` (several runs).
 * @param {{args:object, cwd:string}} options
 */
export async function runReport({ args, cwd }) {
  const knownFailures = Array.isArray(args.knownFailures) ? args.knownFailures : []
  const title = args.title ?? '功能测试报告'
  if (Array.isArray(args.runIds) && args.runIds.length > 0) {
    const all = []
    let firstDir = null
    for (const runId of args.runIds) {
      const { dir, records } = await loadRecords(cwd, runId)
      firstDir ??= dir
      all.push(...records)
    }
    const report = renderReport({
      title,
      environment: args.environment,
      records: all,
      knownFailures,
    })
    const file = path.join(firstDir, 'report-summary.md')
    await art.writeText(file, report)
    return {
      runId: args.runIds.join(','),
      artifacts: { dir: path.relative(cwd, firstDir), report: path.relative(cwd, file) },
    }
  }

  const { dir, records } = await loadRecords(cwd, args.runId)
  const report = renderReport({
    title: args.title ?? title,
    environment: args.environment,
    baseUrl: records[0]?.request?.url,
    records,
    knownFailures,
  })
  const file = path.join(dir, 'report.md')
  await art.writeText(file, report)
  return {
    runId: args.runId,
    artifacts: { dir: path.relative(cwd, dir), report: path.relative(cwd, file) },
  }
}
