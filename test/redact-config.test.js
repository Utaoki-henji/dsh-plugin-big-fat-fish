import test from 'node:test'
import assert from 'node:assert/strict'
import { maskValue, maskHeaders, maskExtracted, redactText, resolveEnvRef, DEFAULT_REDACT_KEYS } from '../lib/redact.js'
import { isHostAllowed, isDestructiveAllowed, DEFAULT_CONFIG } from '../lib/config.js'

test('maskValue masks nested sensitive keys', () => {
  const masked = maskValue({ name: 'a', user: { password: 'p', token: 't' }, list: [{ cookie: 'c' }] })
  assert.equal(masked.name, 'a')
  assert.equal(masked.user.password, '[REDACTED]')
  assert.equal(masked.user.token, '[REDACTED]')
  assert.equal(masked.list[0].cookie, '[REDACTED]')
})

test('maskHeaders is case-insensitive', () => {
  const masked = maskHeaders({ Authorization: 'Bearer x', 'X-Trace': '1' })
  assert.equal(masked.Authorization, '[REDACTED]')
  assert.equal(masked['X-Trace'], '1')
})

test('maskExtracted masks by key name', () => {
  assert.deepEqual(maskExtracted({ userId: 'u_1', accessToken: 't' }), {
    userId: 'u_1',
    accessToken: '[REDACTED]',
  })
})

test('resolveEnvRef reads env and defaults', () => {
  const env = { FT_TOKEN: 'abc' }
  assert.equal(resolveEnvRef('${env:FT_TOKEN}', env), 'abc')
  assert.equal(resolveEnvRef('${env:MISSING:-fallback}', env), 'fallback')
})

test('redactText masks a token key inside a saved response body', () => {
  const jwt = 'eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlLXNpZ24'
  const body = `{"msg":"操作成功","code":200,"token":"${jwt}"}`
  const masked = redactText(body, DEFAULT_REDACT_KEYS)
  assert.ok(!masked.includes(jwt), 'token must not survive in the saved body')
  assert.ok(masked.includes('"token":"[REDACTED]"'), `unexpected mask: ${masked}`)
  assert.ok(masked.includes('"code":200'), 'non-sensitive fields stay readable')
})

test('redactText masks a truncated body without breaking it', () => {
  const body = '{"code":200,"data":{"accessToken":"eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnI'
  const masked = redactText(body, DEFAULT_REDACT_KEYS)
  assert.ok(!masked.includes('eyJhbGci'))
  assert.ok(masked.includes('"code":200'))
})

test('redactText masks a bare bearer credential', () => {
  const masked = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789')
  assert.ok(!masked.includes('abcdefghijklmnopqrstuvwxyz0123456789'))
  assert.ok(masked.includes('Bearer [REDACTED]'))
})


test('isHostAllowed matches exact host and subdomains', () => {
  assert.equal(isHostAllowed('http://127.0.0.1:8080/api', ['127.0.0.1']).allowed, true)
  assert.equal(isHostAllowed('http://localhost:5173/', ['localhost']).allowed, true)
  assert.equal(isHostAllowed('http://api.test.local/', ['test.local']).allowed, true)
  assert.equal(isHostAllowed('http://evil.com/', ['localhost']).allowed, false)
  assert.equal(isHostAllowed('file:///etc/passwd', ['localhost']).allowed, false)
})

test('destructive allowed only with enabled rule', () => {
  const disabled = { ...DEFAULT_CONFIG, destructive: { enabled: false, rules: [] } }
  assert.equal(isDestructiveAllowed('POST', '/api/users', disabled), false)
  const enabled = {
    ...DEFAULT_CONFIG,
    destructive: { enabled: true, rules: [{ method: 'POST', pathPattern: '/api/**' }] },
  }
  assert.equal(isDestructiveAllowed('POST', '/api/users', enabled), true)
  assert.equal(isDestructiveAllowed('DELETE', '/api/users', enabled), false)
  assert.equal(isDestructiveAllowed('GET', '/api/users', enabled), true)
})
