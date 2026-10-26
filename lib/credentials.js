/**
 * Local credential store for internal systems that cannot self-register.
 *
 * Resolution order for `${env:NAME}` (highest wins):
 *   1. the launching process environment
 *   2. `.ft/credentials.local.json` (workspace-local, git-ignored)
 *
 * Only test/dev credentials belong here. The file is created by the agent after
 * the user explicitly provides the accounts, and values are never echoed back
 * into a suite, a report, or a message.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const CREDENTIALS_FILE = '.ft/credentials.local.json'

/**
 * Load stored variables. A missing file is normal; a malformed file only warns.
 * @returns {Promise<{variables: Record<string,string>, warnings: string[]}>}
 */
export async function loadCredentialStore(cwd) {
  const warnings = []
  const file = path.join(cwd, CREDENTIALS_FILE)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { variables: {}, warnings }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warnings.push(`${CREDENTIALS_FILE} is not valid JSON (${error.message}); local credentials ignored`)
    return { variables: {}, warnings }
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
    warnings.push(`${CREDENTIALS_FILE} must be an object with schemaVersion 1; local credentials ignored`)
    return { variables: {}, warnings }
  }
  const variables = {}
  for (const [key, value] of Object.entries(parsed.variables ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      warnings.push(`${CREDENTIALS_FILE}: "${key}" is not a valid variable name; ignored`)
      continue
    }
    if (typeof value !== 'string') {
      warnings.push(`${CREDENTIALS_FILE}: "${key}" must be a string; ignored`)
      continue
    }
    variables[key] = value
  }
  return { variables, warnings }
}

/**
 * Merge stored variables under the process environment so an exported variable
 * can always override the local store.
 */
export function credentialLookup(storedVariables, base = process.env) {
  return { ...storedVariables, ...base }
}
