/** Assertion evaluation for HTTP responses. */

import { getPath, JsonPathError } from './jsonpath.js'

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((key) => deepEqual(a[key], b[key]))
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function normalizeHeaders(headers) {
  const out = {}
  if (headers === null || headers === undefined) return out
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

function describe(value) {
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value
  try {
    const text = JSON.stringify(value)
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return String(value)
  }
}

function assertion(path, op, expected, actual, ok, message) {
  // `undefined` is not representable in JSON and makes a tool result fail the
  // lossless-JSON check; a missing actual value is reported as `null`.
  const clean = (value) => (value === undefined ? null : value)
  return { path, op, expected: clean(expected), actual: clean(actual), ok, ...(message ? { message } : {}) }
}

/**
 * Evaluate the `expect` block against one response.
 * @param {object} expect
 * @param {{status:number, headers:object, text:string, json:unknown}} response
 * @param {{latencyMs?:number}} meta
 * @returns {{ok:boolean, assertions:Array, warnings:Array<string>}}
 */
export function evaluateAssertions(expect, response, meta = {}) {
  const assertions = []
  const warnings = []
  if (expect === undefined || expect === null) return { ok: true, assertions, warnings }
  if (typeof expect !== 'object') {
    return {
      ok: false,
      assertions: [assertion('expect', 'type', 'object', typeOf(expect), false, 'expect must be an object')],
      warnings,
    }
  }

  if (expect.status !== undefined) {
    const expected = Array.isArray(expect.status) ? expect.status : [expect.status]
    const ok = expected.includes(response.status)
    assertions.push(assertion('status', 'in', expected, response.status, ok,
      ok ? undefined : `expected ${expected.join('|')}, actual ${response.status}`))
  }

  for (const item of expect.jsonPath ?? []) {
    const path = String(item.path)
    const op = String(item.op)
    try {
      const { found, value } = getPath(response.json, path)
      const ok = evaluateJsonOp(op, found, value, item)
      assertions.push(assertion(path, op, item.value ?? item.type, found ? value : undefined, ok,
        ok ? undefined : `${path} ${op} failed (actual: ${found ? describe(value) : 'missing'})`))
    } catch (error) {
      if (error instanceof JsonPathError) throw error
      throw new Error(`assertion for "${path}" failed to evaluate: ${error.message}`)
    }
  }

  for (const item of expect.jsonKeys ?? []) {
    const path = item.path ?? '$'
    const { found, value } = getPath(response.json, path)
    const keys = Array.isArray(item.keys) ? item.keys : []
    if (!found || value === null || typeof value !== 'object' || Array.isArray(value)) {
      assertions.push(assertion(path, 'jsonKeys', keys, found ? value : undefined, false,
        `${path} is not an object`))
      continue
    }
    const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
    assertions.push(assertion(path, 'jsonKeys', keys, missing.length ? { missing } : 'ok', missing.length === 0,
      missing.length ? `missing keys: ${missing.join(', ')}` : undefined))
  }

  if (expect.headers !== undefined) {
    const headers = normalizeHeaders(response.headers)
    for (const item of expect.headers ?? []) {
      const name = String(item.name).toLowerCase()
      const actual = headers[name]
      const op = String(item.op ?? 'contains')
      let ok = false
      if (actual !== undefined) {
        if (op === 'equals') ok = actual === String(item.value)
        else if (op === 'contains') ok = actual.includes(String(item.value))
        else if (op === 'regex') ok = new RegExp(String(item.value)).test(actual)
      }
      assertions.push(assertion(`header:${name}`, op, item.value, actual, ok,
        ok ? undefined : `header ${name} ${op} failed`))
    }
  }

  if (expect.latencyMs !== undefined) {
    const limit = Number(expect.latencyMs.max)
    const actual = meta.latencyMs
    if (Number.isFinite(limit) && typeof actual === 'number') {
      if (actual > limit) {
        const strict = expect.latencyMs.strict === true
        if (strict) {
          assertions.push(assertion('latencyMs', 'max', limit, actual, false,
            `latency ${actual}ms exceeds ${limit}ms`))
        } else {
          warnings.push(`latency ${actual}ms exceeds ${limit}ms (strict=false, not a failure)`)
        }
      }
    }
  }

  return { ok: assertions.every((item) => item.ok), assertions, warnings }
}

function evaluateJsonOp(op, found, value, item) {
  switch (op) {
    case 'exists':
      return found && value !== undefined
    case 'equals':
      return found && deepEqual(value, item.value)
    case 'type':
      return found && typeOf(value) === String(item.type)
    case 'contains':
      if (!found) return false
      if (Array.isArray(value)) return value.some((entry) => deepEqual(entry, item.value))
      if (typeof value === 'string') return value.includes(String(item.value))
      return false
    case 'notContains':
      if (!found) return true
      if (Array.isArray(value)) return value.every((entry) => !deepEqual(entry, item.value))
      if (typeof value === 'string') return !value.includes(String(item.value))
      return true
    case 'notMatches':
      return !(found && typeof value === 'string' && new RegExp(String(item.value)).test(value))
    case 'notExists':
      return !found || value === undefined
    case 'length':
      if (!found) return false
      if (Array.isArray(value) || typeof value === 'string') return value.length === Number(item.value)
      if (value !== null && typeof value === 'object') return Object.keys(value).length === Number(item.value)
      return false
    case 'lengthGte':
      if (!found) return false
      return collectionLength(value) >= Number(item.value)
    case 'lengthLte':
      if (!found) return false
      return collectionLength(value) <= Number(item.value)
    case 'notEmpty':
      if (!found) return false
      return collectionLength(value) > 0
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (!found) return false
      const actual = Number(value)
      const expected = Number(item.value)
      if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false
      if (op === 'gt') return actual > expected
      if (op === 'gte') return actual >= expected
      if (op === 'lt') return actual < expected
      return actual <= expected
    }
    case 'in':
      if (!found) return false
      return Array.isArray(item.value) && item.value.some((entry) => deepEqual(entry, value))
    case 'matches':
      return found && typeof value === 'string' && new RegExp(String(item.value)).test(value)
    default:
      throw new Error(`unsupported assertion op "${op}"`)
  }
}

function collectionLength(value) {
  if (Array.isArray(value) || typeof value === 'string') return value.length
  if (value !== null && typeof value === 'object') return Object.keys(value).length
  return Number.NaN
}
