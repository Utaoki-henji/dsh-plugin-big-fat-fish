/** Configuration loading: defaults < plugin config < repo `.ft/config.json` < call arguments. */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const CONFIG_FILE = '.ft/config.json'

export const DEFAULT_CONFIG = {
  baseUrls: {},
  allowedHosts: ['127.0.0.1', 'localhost'],
  auth: {},
  request: {
    timeoutMs: 10000,
    maxResponseBytes: 1024 * 1024,
    followRedirects: false,
  },
  destructive: { enabled: false, rules: [] },
  browser: { channel: 'chrome', headless: true, timeoutMs: 15000 },
  artifacts: { dir: '.ft/runs', keepRuns: 20 },
  redact: {
    keys: ['authorization', 'cookie', 'set-cookie', 'password', 'token', 'secret'],
  },
}

const SECRET_KEYS = ['token', 'password', 'secret', 'authorization', 'cookie', 'apikey', 'api-key']

function looksSensitiveKey(key) {
  const lower = String(key).toLowerCase()
  return SECRET_KEYS.some((candidate) => lower.includes(candidate))
}

function assertNoSecrets(value, trail = '') {
  if (value === null || typeof value !== 'object') return
  for (const [key, inner] of Object.entries(value)) {
    const here = trail ? `${trail}.${key}` : key
    if (looksSensitiveKey(key) && typeof inner === 'string' && inner.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
      throw new Error(`.ft/config.json must not contain credentials (found "${here}"); provide them through environment variables`)
    }
    assertNoSecrets(inner, here)
  }
}

function mergeDeep(base, override) {
  if (override === undefined) return base
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return override
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = mergeDeep(base[key], value)
  }
  return out
}

/**
 * Load `.ft/config.json` when present.
 * @returns {Promise<{config: object, envName: string|undefined, warnings: string[]}>}
 */
export async function loadRepoConfig(cwd, requestedEnv) {
  const warnings = []
  const file = path.join(cwd, CONFIG_FILE)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { config: {}, envName: requestedEnv, warnings }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warnings.push(`${CONFIG_FILE} is not valid JSON (${error.message}); falling back to defaults`)
    return { config: {}, envName: requestedEnv, warnings }
  }
  try {
    assertNoSecrets(parsed)
  } catch (error) {
    warnings.push(error.message)
    return { config: {}, envName: requestedEnv, warnings }
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
    warnings.push(`${CONFIG_FILE} schemaVersion ${parsed.schemaVersion} is not supported; expected 1`)
    return { config: {}, envName: requestedEnv, warnings }
  }
  const envName = requestedEnv ?? parsed.defaultEnv
  const environments = parsed.environments ?? {}
  const selected = envName === undefined ? {} : environments[envName] ?? {}
  if (envName !== undefined && environments[envName] === undefined) {
    warnings.push(`${CONFIG_FILE} has no environment "${envName}"; using defaults`)
  }
  return { config: selected, envName, warnings }
}

/**
 * Resolve the effective configuration for one run.
 * @param {{cwd:string, env?:string, overrides?:object}} options
 */
export async function resolveConfig(options) {
  const repo = await loadRepoConfig(options.cwd, options.env)
  let config = mergeDeep(DEFAULT_CONFIG, repo.config)
  config = mergeDeep(config, options.overrides)
  return { config, envName: repo.envName, warnings: repo.warnings }
}

export function isHostAllowed(url, allowedHosts) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: `invalid URL: ${url}` }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { allowed: false, reason: `unsupported protocol: ${parsed.protocol}` }
  }
  const host = parsed.hostname
  const allowed = allowedHosts.some((entry) => {
    const candidate = String(entry).toLowerCase()
    return host === candidate || host.endsWith(`.${candidate}`)
  })
  return allowed ? { allowed: true } : { allowed: false, reason: `host "${host}" is not in allowedHosts` }
}

export function isDestructiveAllowed(method, urlPath, config) {
  const upper = String(method).toUpperCase()
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(upper)) return true
  if (config.destructive?.enabled !== true) return false
  const rules = config.destructive?.rules ?? []
  return rules.some((rule) => {
    if (String(rule.method).toUpperCase() !== upper) return false
    const pattern = String(rule.pathPattern)
    return wildcardMatch(pattern, urlPath)
  })
}

function wildcardMatch(pattern, value) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}
