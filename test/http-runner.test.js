import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runHttp } from '../lib/http-runner.js'
import { renderReport } from '../lib/report.js'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ft-runner-'))
  await mkdir(path.join(root, '.ft'), { recursive: true })
  return root
}

test('http runner executes, extracts, fails, blocks, and writes evidence', async () => {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.method === 'POST' && req.url === '/api/users') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { id: 'u_1' } }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/users/u_1') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { name: '张三' } }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/broken') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 400, message: 'bad' }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { ok: true } }))
      }, 80)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const port = await listen(server)
  const cwd = await makeWorkspace()
  try {
    await writeFile(
      path.join(cwd, '.ft', 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        defaultEnv: 'test',
        environments: {
          test: {
            baseUrls: { api: `http://127.0.0.1:${port}` },
            allowedHosts: ['127.0.0.1'],
            destructive: {
              enabled: true,
              rules: [{ method: 'POST', pathPattern: '/api/**' }],
            },
          },
        },
      }),
    )

    const result = await runHttp({
      cwd,
      args: {
        runName: 'it-run',
        env: 'test',
        cases: [
          {
            id: 'TC-001',
            name: 'create user',
            destructive: true,
            auth: undefined,
            request: { method: 'POST', path: '/api/users', body: { name: '张三' } },
            expect: { status: [200, 201], jsonPath: [{ path: '$.code', op: 'equals', value: 0 }] },
            extract: { userId: '$.data.id' },
          },
          {
            id: 'TC-002',
            name: 'read user',
            destructive: false,
            request: { method: 'GET', path: '/api/users/${userId}' },
            expect: { status: 200, jsonPath: [{ path: '$.data.name', op: 'equals', value: '张三' }] },
          },
          {
            id: 'TC-003',
            name: 'broken expects 200',
            destructive: false,
            request: { method: 'GET', path: '/api/broken' },
            expect: { status: 200 },
          },
          {
            id: 'TC-004',
            name: 'delete without rule',
            destructive: true,
            request: { method: 'DELETE', path: '/api/users/u_1' },
            expect: { status: 200 },
          },
          {
            id: 'TC-005',
            name: 'latency strict exceeded',
            destructive: false,
            request: { method: 'GET', path: '/api/slow' },
            expect: { status: 200, latencyMs: { max: 1, strict: true } },
          },
        ],
      },
    })

    assert.equal(result.summary.total, 5)
    assert.equal(result.summary.passed, 2)
    assert.equal(result.summary.failed, 2)
    assert.equal(result.summary.blocked, 1)
    assert.ok(result.runId.startsWith('it-run') === false)
    assert.ok(result.runId.endsWith('_it-run') || result.runId.includes('_it-run_'))

    const resultsFile = path.join(cwd, '.ft', 'runs', result.runId, 'results.jsonl')
    const lines = (await readFile(resultsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 5)
    const failed = lines.find((line) => line.caseId === 'TC-003')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.errorKind, 'assertion_failed')
    assert.equal(failed.assertions[0].actual, 400)
    const latency = lines.find((line) => line.caseId === 'TC-005')
    assert.equal(latency.status, 'failed')
    assert.equal(latency.errorKind, 'latency_exceeded')
    assert.equal(latency.assertions.find((item) => item.path === 'latencyMs').ok, false)
    const blocked = lines.find((line) => line.caseId === 'TC-004')
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.errorKind, 'blocked_by_policy')

    const report = await readFile(path.join(cwd, '.ft', 'runs', result.runId, 'report.md'), 'utf8')
    assert.match(report, /失败明细/)
    assert.match(report, /TC-003/)
    assert.match(report, /TC-005/)
    assert.match(report, /共 5，通过 2，失败 2，错误 0，阻塞 1，跳过 0/)

    // Truncated summary stays small; the full evidence lives on disk.
    assert.ok(result.failed.length <= 20)
    assert.ok(requests.length >= 3)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(cwd, { recursive: true, force: true })
  }
})

test('report renderer summarises statuses', () => {
  const report = renderReport({
    title: 'demo',
    records: [
      { caseId: 'A', caseName: 'a', status: 'passed', assertions: [], warnings: [] },
      { caseId: 'B', caseName: 'b', kind: 'http', status: 'failed', errorKind: 'assertion_failed', request: { method: 'GET', url: 'http://x' }, assertions: [{ ok: false, path: 'status', op: 'in', expected: 200, actual: 500 }] },
      { caseId: 'C', caseName: 'c', status: 'error', errorKind: 'timeout', message: 'boom' },
    ],
  })
  assert.match(report, /通过 1/)
  assert.match(report, /失败明细/)
  assert.match(report, /B/)
  assert.match(report, /timeout/)
})

test('login suite uses local credentials, extracts a token, and never leaks the password', async () => {
  let loginBody = null
  let seenAuth = null
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/login') {
        loginBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { token: 'tok-1', username: loginBody.username } }))
        return
      }
      if (req.method === 'GET' && req.url === '/api/me') {
        seenAuth = req.headers.authorization
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { auth: req.headers.authorization } }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  const port = await listen(server)
  const cwd = await makeWorkspace()
  try {
    await writeFile(
      path.join(cwd, '.ft', 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        defaultEnv: 'dev',
        environments: {
          dev: {
            baseUrls: { api: `http://127.0.0.1:${port}` },
            allowedHosts: ['127.0.0.1'],
            destructive: { enabled: true, rules: [{ method: 'POST', pathPattern: '/api/login' }] },
          },
        },
      }),
    )
    await writeFile(
      path.join(cwd, '.ft', 'credentials.local.json'),
      JSON.stringify({ schemaVersion: 1, variables: { FT_USERNAME: 'tester', FT_PASSWORD: 'example-password-value' } }),
    )

    const result = await runHttp({
      cwd,
      args: {
        runName: 'login-round',
        env: 'dev',
        cases: [
          {
            id: 'LOGIN-001',
            name: '登录并获取令牌',
            destructive: true,
            request: {
              method: 'POST',
              path: '/api/login',
              headers: { 'content-type': 'application/json' },
              body: { username: '${env:FT_USERNAME}', password: '${env:FT_PASSWORD}' },
            },
            expect: { status: 200, jsonPath: [{ path: '$.data.username', op: 'equals', value: 'tester' }] },
            extract: { accessToken: '$.data.token' },
          },
          {
            id: 'TC-101',
            name: '带令牌访问',
            destructive: false,
            request: { method: 'GET', path: '/api/me', headers: { authorization: 'Bearer ${accessToken}' } },
            expect: { status: 200, jsonPath: [{ path: '$.data.auth', op: 'equals', value: 'Bearer tok-1' }] },
          },
        ],
      },
    })

    assert.equal(result.summary.total, 2)
    assert.equal(result.summary.passed, 2)
    // Credentials reached the server, and the extracted token reached the next case.
    assert.deepEqual(loginBody, { username: 'tester', password: 'example-password-value' })
    assert.equal(seenAuth, 'Bearer tok-1')

    const runDir = path.join(cwd, '.ft', 'runs', result.runId)
    const resultsText = await readFile(path.join(runDir, 'results.jsonl'), 'utf8')
    assert.ok(!resultsText.includes('example-password-value'), 'password must not be persisted in results.jsonl')
    const records = resultsText.trim().split('\n').map((line) => JSON.parse(line))
    const loginRecord = records.find((record) => record.caseId === 'LOGIN-001')
    assert.equal(loginRecord.request.body.password, '[REDACTED]')
    assert.equal(loginRecord.extract.accessToken, '[REDACTED]')

    const suiteText = await readFile(path.join(runDir, 'suite.json'), 'utf8')
    assert.ok(!suiteText.includes('example-password-value'), 'password must not be persisted in suite.json')
    assert.ok(suiteText.includes('${env:FT_PASSWORD}'))

    const gitignore = await readFile(path.join(cwd, '.ft', '.gitignore'), 'utf8')
    assert.match(gitignore, /runs\//)
    assert.match(gitignore, /credentials\.local\.json/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a response above maxResponseBytes is an invalid_response error, not a false assertion failure', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { big: 'x'.repeat(5000) } }))
  })
  const port = await listen(server)
  const cwd = await makeWorkspace()
  try {
    await writeFile(
      path.join(cwd, '.ft', 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        defaultEnv: 't',
        environments: {
          t: {
            baseUrls: { api: `http://127.0.0.1:${port}` },
            allowedHosts: ['127.0.0.1'],
            request: { maxResponseBytes: 100 },
          },
        },
      }),
    )

    const result = await runHttp({
      cwd,
      args: {
        runName: 'big-response',
        env: 't',
        cases: [
          {
            id: 'TC-001',
            name: 'truncated response',
            destructive: false,
            request: { method: 'GET', path: '/api/big' },
            expect: { status: 200, jsonPath: [{ path: '$.code', op: 'equals', value: 0 }] },
          },
        ],
      },
    })

    assert.equal(result.summary.total, 1)
    assert.equal(result.summary.errors, 1)
    assert.equal(result.summary.failed, 0)
    assert.equal(result.failed[0].errorKind, 'invalid_response')
    assert.match(result.failed[0].message, /maxResponseBytes/)

    // The tool result must be lossless JSON (no undefined properties).
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)

    const record = JSON.parse((await readFile(path.join(cwd, '.ft', 'runs', result.runId, 'results.jsonl'), 'utf8')).trim())
    assert.equal(record.status, 'error')
    assert.equal(record.errorKind, 'invalid_response')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(cwd, { recursive: true, force: true })
  }
})
