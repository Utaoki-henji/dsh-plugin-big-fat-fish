/** Run artifacts: directory creation, JSONL evidence, report file, retention. */

import { mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export function makeRunId(runName) {
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '')
  const suffix = randomBytes(2).toString('hex')
  return `${stamp}_${runName}_${suffix}`
}

export function sanitizeRunName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error('runName must match [A-Za-z0-9._-]{1,64}')
  }
  return name
}

/** Resolve the run directory and prove it stays inside the artifacts root. */
export function resolveRunDir(cwd, artifactsConfig, runId) {
  const root = path.resolve(cwd, artifactsConfig?.dir ?? '.ft/runs')
  const dir = path.resolve(root, runId)
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(`run directory escapes artifacts root: ${dir}`)
  }
  return { root, dir }
}

export async function ensureRunDir(dir) {
  await mkdir(path.join(dir, 'shots'), { recursive: true })
  return dir
}

/**
 * Prepare the workspace `.ft` directory and its `.gitignore`.
 *
 * Runs, screenshots and the local credential store must never be committed;
 * `config.json`, `logins/` and `suites/` stay committable.
 */
export async function ensureWorkspaceState(cwd) {
  const ftDir = path.join(cwd, '.ft')
  await mkdir(ftDir, { recursive: true })
  const gitignore = path.join(ftDir, '.gitignore')
  const content = ['runs/', 'credentials.local.json', '*.local.json', 'auth/', ''].join('\n')
  try {
    await writeFile(gitignore, content, { encoding: 'utf8', flag: 'wx' })
  } catch {
    // already exists (or another run created it first)
  }
  return ftDir
}

export async function writeJSON(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function writeJSONLines(file, records) {
  const lines = records.map((record) => JSON.stringify(record)).join('\n')
  await writeFile(file, lines.length ? `${lines}\n` : '', 'utf8')
}

export async function writeText(file, text) {
  await writeFile(file, text, 'utf8')
}

export async function readJSONLines(file) {
  const text = await readFile(file, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

/** Keep the newest `keepRuns` directories under the artifacts root. */
export async function pruneRuns(root, keepRuns) {
  if (!Number.isFinite(keepRuns) || keepRuns <= 0) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    try {
      const info = await stat(full)
      dirs.push({ name: entry.name, full, mtimeMs: info.mtimeMs })
    } catch {
      // ignore races
    }
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const removed = []
  for (const item of dirs.slice(keepRuns)) {
    try {
      await rm(item.full, { recursive: true, force: true })
      removed.push(item.name)
    } catch {
      // best effort
    }
  }
  return removed
}
