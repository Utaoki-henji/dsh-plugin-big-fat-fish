/**
 * Functional Test Harness — Host bundle entry.
 *
 * Registers three executor tools (`ft_http_run`, `ft_ui_run`, `ft_report`) and
 * the `functional-testing` skill. The skill owns the methodology; the tools
 * only execute and keep evidence.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runHttp } from './lib/http-runner.js'
import { runUi } from './lib/ui-runner.js'
import { runReport } from './lib/report-tool.js'

export const name = 'big-fat-fish'
export const inject = ['tools', 'skills', 'workingDirectory']

const SKILL_DIR = fileURLToPath(new URL('./skill', import.meta.url))

function loadSkillBody() {
  const text = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

function textOutput(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const FAILED_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'kind'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['assertion', 'error', 'blocked'] },
    errorKind: { type: 'string' },
    message: { type: 'string' },
    assertions: { type: 'array', items: { type: 'object' } },
  },
}

const RUN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'summary', 'failed', 'warnings', 'artifacts'],
  properties: {
    runId: { type: 'string' },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'passed', 'failed', 'errors', 'skipped', 'blocked', 'durationMs'],
      properties: {
        total: { type: 'number' },
        passed: { type: 'number' },
        failed: { type: 'number' },
        errors: { type: 'number' },
        skipped: { type: 'number' },
        blocked: { type: 'number' },
        durationMs: { type: 'number' },
      },
    },
    failed: { type: 'array', items: FAILED_ITEM_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
    artifacts: {
      type: 'object',
      additionalProperties: false,
      required: ['dir', 'report'],
      properties: {
        dir: { type: 'string' },
        report: { type: 'string' },
      },
    },
  },
}

/**
 * Model-facing parameter schemas.
 *
 * `ctx.tools.register` takes a raw `ToolDefinition`, so `parameters` must already
 * be a wire-level JSON Schema (object-rooted). A bare `{prop: {...}}` map is sent
 * to the provider as `type: null` and the provider rejects every request with
 * "Invalid schema for function ...: schema must be a JSON Schema of type: object",
 * which makes the whole Harness unable to hold a conversation while the plugin is
 * loaded. Keep these schemas object-rooted and use `required` arrays, never
 * per-property `required: true`.
 */
const FT_HTTP_RUN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['runName'],
  properties: {
    runName: { type: 'string', description: 'Run name, matching [A-Za-z0-9._-]{1,64}.' },
    suitePath: { type: 'string', description: 'Workspace-relative suite JSON path; mutually exclusive with cases.' },
    baseUrl: { type: 'string', description: 'Base URL override (host must be allowlisted).' },
    env: { type: 'string', description: 'Environment name from .ft/config.json.' },
    variables: { type: 'object', description: 'String variables merged over suite.variables.' },
    cases: { type: 'array', items: { type: 'object' }, description: 'Inline case list when suitePath is omitted.' },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stopOnFailure: { type: 'boolean' },
        saveResponseBody: { type: 'boolean' },
        concurrency: { type: 'number', description: 'v1 supports only 1.' },
        retryOnError: { type: 'number', description: 'Retries for network/timeout errors only.' },
      },
    },
  },
}

const FT_UI_RUN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['runName', 'baseUrl', 'flows'],
  properties: {
    runName: { type: 'string', description: 'Run name, matching [A-Za-z0-9._-]{1,64}.' },
    baseUrl: { type: 'string', description: 'Application base URL (host must be allowlisted).' },
    env: { type: 'string', description: 'Environment name from .ft/config.json.' },
    browser: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: { type: 'string', enum: ['chrome', 'edge'] },
        headless: { type: 'boolean' },
        viewport: {
          type: 'object',
          additionalProperties: false,
          properties: { width: { type: 'number' }, height: { type: 'number' } },
        },
        executablePath: { type: 'string' },
        trace: { type: 'boolean' },
      },
    },
    login: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['none', 'storageState', 'cookies'] },
        path: { type: 'string', description: 'storageState JSON path, workspace-relative.' },
        cookies: { type: 'array', items: { type: 'object' } },
      },
    },
    flows: { type: 'array', items: { type: 'object' }, description: 'Flow list (id, name, steps).' },
  },
}

const FT_REPORT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['runId'],
  properties: {
    runId: { type: 'string', description: 'Existing .ft/runs/<runId> to report on.' },
    runIds: { type: 'array', items: { type: 'string' }, description: 'Aggregate several runs instead of one.' },
    title: { type: 'string' },
    environment: { type: 'string' },
    knownFailures: { type: 'array', items: { type: 'string' }, description: 'Case ids marked as known issues.' },
  },
}

export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register({
    name: 'ft_http_run',
    description: [
      'Execute a batch of black-box HTTP test cases: send requests, judge declared assertions, persist evidence, and return a summary.',
      'Read the `functional-testing` skill first for case design and attribution rules.',
      'Suite shape: {schemaVersion:1, defaults:{baseUrl,auth}, cases:[{id,name,destructive,request:{method,path,headers,body},expect:{status,jsonPath,headers,latencyMs},extract}]}.',
      'Writing methods (POST/PUT/PATCH/DELETE) require `destructive: true` in the case and a matching config rule.',
    ].join(' '),
    parameters: FT_HTTP_RUN_PARAMETERS,
    output: { schema: RUN_OUTPUT_SCHEMA, render: (_args, value) => textOutput(value) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('ft_http_run requires an owning agent session')
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      return runHttp({ args, cwd, signal: exec.signal })
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'ft_ui_run',
    description: [
      'Execute UI flows with Playwright against the local Chrome/Edge: css=, text=, testid= selectors, auto-wait, waitForResponse, assertions, screenshots.',
      'Read the `functional-testing` skill first for flow design and attribution rules.',
      'Each flow is a list of steps; a failed step fails the flow and captures a screenshot.',
    ].join(' '),
    parameters: FT_UI_RUN_PARAMETERS,
    output: { schema: RUN_OUTPUT_SCHEMA, render: (_args, value) => textOutput(value) },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('ft_ui_run requires an owning agent session')
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      return runUi({ args, cwd, signal: exec.signal })
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'ft_report',
    description: [
      'Rebuild the human-readable report from a stored run, or aggregate several runs into report-summary.md.',
      'Use after ft_http_run / ft_ui_run, when the report needs known-failure marking or multi-run aggregation.',
    ].join(' '),
    parameters: FT_REPORT_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['runId', 'artifacts'],
        properties: {
          runId: { type: 'string' },
          artifacts: {
            type: 'object',
            additionalProperties: false,
            required: ['dir', 'report'],
            properties: {
              dir: { type: 'string' },
              report: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => textOutput(value),
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('ft_report requires an owning agent session')
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      return runReport({ args, cwd })
    },
  }))

  ctx.effect(() => ctx.skills.register({
    name: 'functional-testing',
    description: '以黑盒为主的功能测试方法论：从代码/接口摸底到用例设计、执行、归因与报告。',
    whenToUse: '用户说「开始测试」，或要求测试某个项目/接口/页面/功能、做回归验证时；也用于判断一个失败是产品缺陷、用例缺陷还是环境问题。',
    source: 'runtime',
    content: loadSkillBody(),
    resourceBase: { kind: 'directory', path: SKILL_DIR },
    invocation: { modelInvocable: true, userInvocable: true },
  }))
}
