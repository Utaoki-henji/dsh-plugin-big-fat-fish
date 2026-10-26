import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAssertions } from '../lib/assert.js'

function response(overrides = {}) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    text: '{"code":0,"data":{"id":"u_1","name":"张三","tags":["a"]}}',
    json: { code: 0, data: { id: 'u_1', name: '张三', tags: ['a'] } },
    ...overrides,
  }
}

test('status accepts an array', () => {
  const result = evaluateAssertions({ status: [200, 201] }, response())
  assert.equal(result.ok, true)
  assert.equal(result.assertions[0].op, 'in')
})

test('jsonPath ops', () => {
  const result = evaluateAssertions(
    {
      jsonPath: [
        { path: '$.code', op: 'equals', value: 0 },
        { path: '$.data.id', op: 'exists' },
        { path: '$.data.name', op: 'type', type: 'string' },
        { path: '$.data.tags', op: 'length', value: 1 },
        { path: '$.data.name', op: 'matches', value: '^张' },
        { path: '$.data.tags', op: 'contains', value: 'a' },
      ],
    },
    response(),
  )
  assert.equal(result.ok, true)
})

test('comparison, membership and negative ops', () => {
  const result = evaluateAssertions(
    {
      jsonPath: [
        { path: '$.data.tags', op: 'notEmpty' },
        { path: '$.data.tags', op: 'lengthGte', value: 1 },
        { path: '$.data.tags', op: 'lengthLte', value: 3 },
        { path: '$.code', op: 'gte', value: 0 },
        { path: '$.code', op: 'lte', value: 0 },
        { path: '$.code', op: 'in', value: [0, 1] },
        { path: '$.data.name', op: 'notMatches', value: 'SQLException|stack trace' },
        { path: '$.data.name', op: 'notContains', value: '\\u0000' },
        { path: '$.data.missing', op: 'notExists' },
      ],
    },
    response(),
  )
  assert.equal(result.ok, true)
})

test('negative ops fail when the forbidden value is present', () => {
  const result = evaluateAssertions(
    {
      jsonPath: [
        { path: '$.data.name', op: 'notMatches', value: '^张' },
        { path: '$.data.tags', op: 'notContains', value: 'a' },
        { path: '$.data.id', op: 'notExists' },
        { path: '$.code', op: 'gt', value: 10 },
      ],
    },
    response(),
  )
  assert.equal(result.ok, false)
  assert.equal(result.assertions.every((item) => item.ok === false), true)
})


test('missing path fails equals/exists', () => {
  const result = evaluateAssertions({ jsonPath: [{ path: '$.data.nope', op: 'exists' }] }, response())
  assert.equal(result.ok, false)
})

test('jsonKeys reports missing keys', () => {
  const result = evaluateAssertions({ jsonKeys: [{ path: '$', keys: ['code', 'message'] }] }, response())
  assert.equal(result.ok, false)
  assert.match(result.assertions[0].message, /message/)
})

test('header assertions are case-insensitive', () => {
  const result = evaluateAssertions(
    { headers: [{ name: 'Content-Type', op: 'contains', value: 'application/json' }] },
    response(),
  )
  assert.equal(result.ok, true)
})

test('latency is warn-only unless strict', () => {
  const soft = evaluateAssertions({ latencyMs: { max: 10, strict: false } }, response(), { latencyMs: 50 })
  assert.equal(soft.ok, true)
  assert.equal(soft.warnings.length, 1)
  const strict = evaluateAssertions({ latencyMs: { max: 10, strict: true } }, response(), { latencyMs: 50 })
  assert.equal(strict.ok, false)
})

test('failed assertion is reported with actual value', () => {
  const result = evaluateAssertions({ status: 400 }, response())
  assert.equal(result.ok, false)
  assert.equal(result.assertions[0].actual, 200)
})

test('unsupported jsonPath throws JsonPathError to the caller', () => {
  assert.throws(() => evaluateAssertions({ jsonPath: [{ path: '$.a[*]', op: 'exists' }] }, response()))
})

test('assertions on missing paths stay JSON-safe (actual is null, never undefined)', () => {
  const result = evaluateAssertions(
    {
      jsonPath: [
        { path: '$.data.missing', op: 'exists' },
        { path: '$.data.missing', op: 'equals', value: 1 },
      ],
    },
    response(),
  )
  assert.equal(result.ok, false)
  for (const item of result.assertions) {
    assert.equal(Object.prototype.hasOwnProperty.call(item, 'actual'), true)
    assert.equal(item.actual, null)
    assert.deepEqual(JSON.parse(JSON.stringify(item)), item)
  }
})
