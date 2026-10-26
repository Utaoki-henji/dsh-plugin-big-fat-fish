# Contributing

## Layout

```text
plugins/big-fat-fish/                  # ① development source (edit only here)
releases/dsh-plugin-big-fat-fish-v<version>/  # ② frozen release (generated, read-only)
<DSH profile>/node_modules/... (link)  # ③ installed plugin (runtime is ②)
```

**Never edit a release directory or an installed plugin.** Edit ①, run tests, freeze a new release, install that.

## Development

Edit `index.js`, `lib/`, `skill/`, `locale/`, `cordis.patch.yml`.

Run the unit tests one file at a time (under the Windows sandbox `node --test test/` may fail to spawn worker processes):

```powershell
Get-ChildItem test\*.test.js | ForEach-Object { node $_.FullName }
```

All tests must pass before a release.

## Release

```powershell
node scripts/release.mjs
```

Outputs `releases/<package>-v<version>/` with the runtime files, `node_modules/playwright-core` and `RELEASE.json`.

Releases are immutable: bump `version` in `package.json` before releasing again. Breaking changes (tool schema, suite format) need a minor bump and a sync with `docs/ft-contract.md`.

## Versioning

- SemVer. `0.x` while the suite format is still settling.
- Never reuse a released version; never re-release the same version with different content.
- Rollback = point the profile back at the previous `releases/` directory and restart.

## Compatibility

- Node.js 22+, ESM only.
- Tool `parameters` and `output.schema` must be wire-level JSON Schema (`type: "object"`, object-level `required` arrays) and lossless JSON — no `undefined` values.
- The plugin registers through `ctx.tools.register` and `ctx.skills.register({ source: 'runtime' })`; it injects `['tools', 'skills', 'workingDirectory']`.
