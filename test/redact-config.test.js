import test from 'node:test'
import assert from 'node:assert/strict'
import { maskValue, maskHeaders, maskExtracted, resolveEnvRef } from '../lib/redact.js'
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
