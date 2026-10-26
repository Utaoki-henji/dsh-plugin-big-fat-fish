import test from 'node:test'
import assert from 'node:assert/strict'
import { getPath, parsePath, JsonPathError } from '../lib/jsonpath.js'

test('parse dot and index segments', () => {
  assert.deepEqual(parsePath('$.data.items[0].id'), [
    { kind: 'key', value: 'data' },
    { kind: 'key', value: 'items' },
    { kind: 'index', value: 0 },
    { kind: 'key', value: 'id' },
  ])
  assert.deepEqual(parsePath("$['a b']['c']"), [
    { kind: 'key', value: 'a b' },
    { kind: 'key', value: 'c' },
  ])
})

test('rejects unsupported syntax', () => {
  assert.throws(() => parsePath('$.data[*]'), JsonPathError)
  assert.throws(() => parsePath('$..id'), JsonPathError)
  assert.throws(() => parsePath('$.items[?(@.id==1)]'), JsonPathError)
  assert.throws(() => parsePath('data.id'), JsonPathError)
})

test('reads values and missing paths', () => {
  const root = { data: { items: [{ id: 'u_1' }] } }
  assert.deepEqual(getPath(root, '$.data.items[0].id'), { found: true, value: 'u_1' })
  assert.deepEqual(getPath(root, '$.data.missing'), { found: false, value: undefined })
  assert.deepEqual(getPath(root, '$.data.items[3]'), { found: false, value: undefined })
})
