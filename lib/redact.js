/** Secret redaction for evidence that is returned to the model or written to disk. */

export const DEFAULT_REDACT_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'token',
  'secret',
  'api-key',
  'apikey',
  'access-token',
  'refresh-token',
]

const MASK = '[REDACTED]'

// `${env:NAME}` is an indirection, not a secret: keep it in persisted suites so a
// run stays replayable without ever storing the value itself.
const ENV_PLACEHOLDER = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*(?::-.*)?\}$/

function isEnvPlaceholder(value) {
  return typeof value === 'string' && ENV_PLACEHOLDER.test(value)
}

function isSensitiveKey(key, keys) {
  const lower = String(key).toLowerCase()
  return keys.some((candidate) => {
    const k = candidate.toLowerCase()
    return lower === k || lower.includes(k)
  })
}

/** Deep-copy a JSON-ish value, masking sensitive object keys. */
export function maskValue(value, keys = DEFAULT_REDACT_KEYS, depth = 0) {
  if (depth > 12) return MASK
  if (Array.isArray(value)) return value.map((item) => maskValue(item, keys, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSensitiveKey(key, keys) && !isEnvPlaceholder(inner) ? MASK : maskValue(inner, keys, depth + 1)
    }
    return out
  }
  return value
}

/** Mask header values by header name. */
export function maskHeaders(headers, keys = DEFAULT_REDACT_KEYS) {
  if (headers === null || typeof headers !== 'object') return headers
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveKey(key, keys) ? MASK : value
  }
  return out
}

/** Mask values of `extract` results before they are persisted. */
export function maskExtracted(extracted, keys = DEFAULT_REDACT_KEYS) {
  if (extracted === null || typeof extracted !== 'object') return extracted
  const out = {}
  for (const [key, value] of Object.entries(extracted)) {
    out[key] = isSensitiveKey(key, keys) ? MASK : value
  }
  return out
}

/** Resolve `${env:NAME}` and `${env:NAME:-default}` references. */
export function resolveEnvRef(value, env = process.env) {
  if (typeof value !== 'string') return value
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, fallback) => {
    const found = env[name]
    if (found !== undefined) return found
    return fallback === undefined ? '' : fallback
  })
}
