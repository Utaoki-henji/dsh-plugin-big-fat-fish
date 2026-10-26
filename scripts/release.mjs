/**
 * Freeze the current source tree into an immutable release directory.
 *
 *   node scripts/release.mjs
 *
 * Output: <workspace>/releases/<package-short-name>-v<version>/
 *
 * The installed profile must point at that release directory (never at this
 * source tree), so editing source never changes what is installed/running.
 */

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'))

const packageShortName = String(pkg.name).split('/').pop()
const version = String(pkg.version ?? '0.0.0')
const releaseRoot = path.resolve(sourceRoot, '..', '..', 'releases')
const releaseDir = path.join(releaseRoot, `${packageShortName}-v${version}`)

const RUNTIME_ENTRIES = ['index.js', 'cordis.patch.yml', 'locale', 'skill', 'lib', 'icon.svg', 'package.json']
const RUNTIME_DEPENDENCIES = ['playwright-core']

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

for (const entry of RUNTIME_ENTRIES) {
  if (!(await exists(path.join(sourceRoot, entry)))) {
    console.error(`[release] missing runtime entry: ${entry}`)
    process.exit(1)
  }
}

if (await exists(releaseDir)) {
  console.error(`[release] ${releaseDir} already exists.`)
  console.error('[release] releases are immutable: bump package.json version and release again.')
  process.exit(1)
}

await mkdir(releaseDir, { recursive: true })
for (const entry of RUNTIME_ENTRIES) {
  await cp(path.join(sourceRoot, entry), path.join(releaseDir, entry), { recursive: true })
}

for (const dependency of RUNTIME_DEPENDENCIES) {
  const from = path.join(sourceRoot, 'node_modules', dependency)
  if (!(await exists(from))) {
    console.error(`[release] warning: runtime dependency "${dependency}" is not installed in ${path.join(sourceRoot, 'node_modules')}`)
    console.error(`[release] run \`npm install\` in the source tree before releasing; the release will fail at runtime without it.`)
    process.exit(1)
  }
  await cp(from, path.join(releaseDir, 'node_modules', dependency), { recursive: true })
}

await writeFile(
  path.join(releaseDir, 'RELEASE.json'),
  `${JSON.stringify({ name: pkg.name, version, source: sourceRoot, createdAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
)

console.log(`[release] ${pkg.name}@${version}`)
console.log(`[release] ${releaseDir}`)
console.log('[release] next: install/upgrade this directory in the plugin manager, then restart the Harness.')
