/**
 * Suite variable expansion: `${name}`, `${name:-default}`, `${env:NAME}`.
 *
 * `${env:NAME}` exists so a login suite can use credentials from the launching
 * environment without the value ever entering the model context, the suite file,
 * or the report.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { expandCase, expandVars } from '../lib/suite.js'

const ENV = { FT_USERNAME: 'tester', FT_PASSWORD: 'p@ss${weird}' }

test('plain variables and defaults expand in strings, arrays, and objects', () => {
  assert.equal(expandVars('id=${userId}', { userId: 'u_1' }), 'id=u_1')
  assert.equal(expandVars('${missing:-fallback}', {}), 'fallback')
  assert.deepEqual(
    expandVars({ path: '/api/users/${userId}', tags: ['${tag}', 1] }, { userId: 'u_1', tag: 'a' }),
    { path: '/api/users/u_1', tags: ['a', 1] },
  )
})

test('env references resolve from the provided environment', () => {
  assert.equal(expandVars('${env:FT_USERNAME}', {}, ENV), 'tester')
  assert.equal(expandVars('${env:FT_PASSWORD}', {}, ENV), 'p@ss${weird}')
  // env values are inserted verbatim and never re-expanded as suite variables
  assert.equal(expandVars('x=${env:FT_PASSWORD}', { weird: 'oops' }, ENV), 'x=p@ss${weird}')
})

test('env references support a default', () => {
  assert.equal(expandVars('${env:MISSING:-guest}', {}, ENV), 'guest')
})

test('a missing env var is a setup error, not an empty string', () => {
  assert.throws(
    () => expandVars('${env:NOT_SET}', {}, ENV),
    (error) => error.kind === 'setup_error' && /NOT_SET/.test(error.message),
  )
})

test('a missing suite variable is still a setup error', () => {
  assert.throws(
    () => expandVars('${notAVariable}', {}, ENV),
    (error) => error.kind === 'setup_error' && /notAVariable/.test(error.message),
  )
})

test('a login case can use env credentials and extract a token', () => {
  const expanded = expandCase(
    {
      id: 'LOGIN-001',
      destructive: true,
      request: {
        method: 'POST',
        path: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        body: { username: '${env:FT_USERNAME}', password: '${env:FT_PASSWORD}' },
      },
      expect: { status: [200, 201], jsonPath: [{ path: '$.code', op: 'equals', value: 0 }] },
      extract: { accessToken: '$.data.token' },
    },
    {},
    ENV,
  )
  assert.equal(expanded.request.body.username, 'tester')
  assert.equal(expanded.request.body.password, 'p@ss${weird}')
  assert.equal(expanded.extract.accessToken, '$.data.token')
})

test('follow-up cases take the extracted token through ${var}', () => {
  const expanded = expandCase(
    {
      id: 'TC-101',
      destructive: false,
      request: { method: 'GET', path: '/api/users/me', headers: { authorization: 'Bearer ${accessToken}' } },
      expect: { status: 200 },
    },
    { accessToken: 'jwt-abc' },
    ENV,
  )
  assert.equal(expanded.request.headers.authorization, 'Bearer jwt-abc')
})
