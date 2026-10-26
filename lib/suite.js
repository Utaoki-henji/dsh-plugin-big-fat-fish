/** Suite loading, validation, and `${var}` expansion. */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const SUITE_SCHEMA_VERSION = 1

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function fail(message) {
  const error = new Error(message)
  error.kind = 'setup_error'
  throw error
}

/**
 * Reference syntax resolved inside suite values:
 *   ${name} / ${name:-default}      → suite/extract variable table
 *   ${env:NAME} / ${env:NAME:-def}  → process environment (credentials only; never logged)
 */
const VARS_REF = /\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?|([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?)\}/g

/** Resolve `${name}` / `${name:-default}` / `${env:NAME}` references. */
export function expandVars(value, vars, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(VARS_REF, (_match, envName, envFallback, name, fallback) => {
      if (envName !== undefined) {
        const found = env[envName]
        if (found !== undefined) return found
        if (envFallback !== undefined) return envFallback
        fail(`environment variable "${envName}" is not set (referenced as "\${env:${envName}}")`)
      }
      if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name])
      if (fallback !== undefined) return fallback
      fail(`undefined variable "\${${name}}"`)
    })
  }
  if (Array.isArray(value)) return value.map((item) => expandVars(item, vars, env))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = expandVars(inner, vars, env)
    return out
  }
  return value
}

export function expandCase(testCase, vars, env = process.env) {
  const expanded = expandVars(testCase, vars, env)
  const request = expanded.request ?? {}
  if (typeof request.path !== 'string' || request.path.length === 0) {
    fail(`case "${testCase.id}" has no request.path`)
  }
  request.method = String(request.method ?? 'GET').toUpperCase()
  if (!METHODS.includes(request.method)) fail(`case "${testCase.id}" has unsupported method ${request.method}`)
  if (expanded.expect === undefined) expanded.expect = {}
  if (typeof expanded.destructive !== 'boolean') {
    fail(`case "${testCase.id}" must declare destructive: true|false`)
  }
  return { ...expanded, request }
}

/**
 * Load a suite from disk (or build one from inline cases) and validate it.
 * @returns {Promise<{suite:{schemaVersion:number, name:string, cases:Array, teardown:Array}, warnings:string[]}>}
 */
export async function loadSuite({ cwd, suitePath, cases, runName, variables = {}, env }) {
  let suite
  if (suitePath !== undefined) {
    const full = path.resolve(cwd, suitePath)
    if (!full.startsWith(path.resolve(cwd) + path.sep)) fail('suitePath must stay inside the workspace')
    let text
    try {
      text = await readFile(full, 'utf8')
    } catch (error) {
      fail(`cannot read suitePath ${suitePath}: ${error.message}`)
    }
    try {
      suite = JSON.parse(text)
    } catch (error) {
      fail(`suitePath ${suitePath} is not valid JSON: ${error.message}`)
    }
  } else if (Array.isArray(cases)) {
    suite = { schemaVersion: SUITE_SCHEMA_VERSION, name: runName, cases }
  } else {
    fail('provide suitePath or cases')
  }

  if (suite.schemaVersion !== SUITE_SCHEMA_VERSION) {
    fail(`unsupported suite schemaVersion ${suite.schemaVersion}; expected ${SUITE_SCHEMA_VERSION}`)
  }
  const list = suite.cases
  if (!Array.isArray(list) || list.length === 0) fail('suite has no cases')
  const ids = new Set()
  for (const testCase of list) {
    if (typeof testCase.id !== 'string' || testCase.id.length === 0) fail('every case needs a string id')
    if (ids.has(testCase.id)) fail(`duplicate case id "${testCase.id}"`)
    ids.add(testCase.id)
  }
  const teardown = Array.isArray(suite.teardown) ? suite.teardown : []
  return {
    suite: {
      schemaVersion: suite.schemaVersion,
      name: suite.name ?? runName,
      env: suite.env ?? env,
      defaults: suite.defaults ?? {},
      cases: list,
      teardown,
      variables: { ...(suite.variables ?? {}), ...variables },
    },
    warnings: [],
  }
}
