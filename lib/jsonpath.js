/**
 * Minimal JSONPath subset used by FT assertions.
 *
 * Supported: `$`, `.key`, `['key']`, `["key"]`, `[0]`.
 * Rejected: wildcards, recursive descent, filters, functions — callers must
 * treat a rejected path as a setup error instead of silently reading nothing.
 */

export class JsonPathError extends Error {
  constructor(path, reason) {
    super(`unsupported JSONPath "${path}": ${reason}`)
    this.name = 'JsonPathError'
    this.path = path
    this.reason = reason
  }
}

/** @returns {Array<{kind:'key'|'index', value:string|number}>} */
export function parsePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new JsonPathError(String(path), 'path must be a non-empty string')
  }
  if (path[0] !== '$') throw new JsonPathError(path, 'path must start with "$"')
  const tokens = []
  let i = 1
  while (i < path.length) {
    const ch = path[i]
    if (ch === '.') {
      if (path[i + 1] === '.') throw new JsonPathError(path, 'recursive descent is not supported')
      let j = i + 1
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j += 1
      const key = path.slice(i + 1, j)
      if (key.length === 0) throw new JsonPathError(path, 'empty property name')
      if (key === '*') throw new JsonPathError(path, 'wildcard is not supported')
      tokens.push({ kind: 'key', value: key })
      i = j
      continue
    }
    if (ch === '[') {
      const close = path.indexOf(']', i)
      if (close === -1) throw new JsonPathError(path, 'unterminated bracket')
      const inner = path.slice(i + 1, close).trim()
      if (inner.length === 0) throw new JsonPathError(path, 'empty bracket')
      if (inner === '*') throw new JsonPathError(path, 'wildcard is not supported')
      if (inner.startsWith('?')) throw new JsonPathError(path, 'filter expressions are not supported')
      if (/^\d+$/.test(inner)) {
        tokens.push({ kind: 'index', value: Number(inner) })
      } else if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        tokens.push({ kind: 'key', value: inner.slice(1, -1) })
      } else {
        throw new JsonPathError(path, `unsupported bracket segment "${inner}"`)
      }
      i = close + 1
      continue
    }
    throw new JsonPathError(path, `unexpected character "${ch}"`)
  }
  return tokens
}

/**
 * Read a path.
 * @returns {{found: boolean, value: unknown}}
 */
export function getPath(root, path) {
  const tokens = parsePath(path)
  let current = root
  for (const token of tokens) {
    if (token.kind === 'key') {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) {
        return { found: false, value: undefined }
      }
      if (!Object.prototype.hasOwnProperty.call(current, token.value)) {
        return { found: false, value: undefined }
      }
      current = current[token.value]
      continue
    }
    if (!Array.isArray(current) || token.value >= current.length) {
      return { found: false, value: undefined }
    }
    current = current[token.value]
  }
  return { found: true, value: current }
}
