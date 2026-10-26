/**
 * Local credential store for internal systems that cannot self-register.
 * Only test/dev accounts belong here; values must never reach a report or suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CREDENTIALS_FILE, credentialLookup, loadCredentialStore } from '../lib/credentials.js'

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ft-credentials-'))
  await mkdir(path.join(root, '.ft'), { recursive: true })
  return root
}

test('a missing credential file is normal and yields no warnings', async () => {
  const cwd = await workspace()
  try {
    const store = await loadCredentialStore(cwd)
    assert.deepEqual(store.variables, {})
    assert.deepEqual(store.warnings, [])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('stored variables load from .ft/credentials.local.json', async () => {
  const cwd = await workspace()
  try {
    await writeFile(
      path.join(cwd, CREDENTIALS_FILE),
      JSON.stringify({ schemaVersion: 1, variables: { FT_USERNAME: 'tester', FT_PASSWORD: 'example-value' } }),
    )
    const store = await loadCredentialStore(cwd)
    assert.deepEqual(store.variables, { FT_USERNAME: 'tester', FT_PASSWORD: 'example-value' })
    assert.deepEqual(store.warnings, [])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('malformed stores only warn and never throw', async () => {
  const cwd = await workspace()
  try {
    await writeFile(path.join(cwd, CREDENTIALS_FILE), '{ not json')
    const broken = await loadCredentialStore(cwd)
    assert.deepEqual(broken.variables, {})
    assert.equal(broken.warnings.length, 1)

    await writeFile(path.join(cwd, CREDENTIALS_FILE), JSON.stringify({ schemaVersion: 2, variables: {} }))
    const wrongVersion = await loadCredentialStore(cwd)
    assert.deepEqual(wrongVersion.variables, {})
    assert.match(wrongVersion.warnings[0], /schemaVersion/)

    await writeFile(
      path.join(cwd, CREDENTIALS_FILE),
      JSON.stringify({ schemaVersion: 1, variables: { GOOD: 'value', BAD_NAME: 42, 'not valid': 'x' } }),
    )
    const partial = await loadCredentialStore(cwd)
    assert.deepEqual(partial.variables, { GOOD: 'value' })
    assert.equal(partial.warnings.length, 2)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('the process environment overrides the stored value', () => {
  assert.deepEqual(
    credentialLookup({ FT_USERNAME: 'stored', FT_PASSWORD: 'stored-pw' }, { FT_PASSWORD: 'env-pw' }),
    { FT_USERNAME: 'stored', FT_PASSWORD: 'env-pw' },
  )
})
