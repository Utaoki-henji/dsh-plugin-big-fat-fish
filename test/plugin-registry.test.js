/**
 * Regression test for the "plugin breaks every conversation" bug.
 *
 * `ft_http_run` / `ft_ui_run` / `ft_report` used to declare `parameters` as a bare
 * `{prop: {...}}` map. `ctx.tools.register` treats `parameters` as an already
 * built wire JSON Schema, so the provider received `type: null` and rejected the
 * whole request with:
 *
 *   Invalid schema for function 'ft_http_run': schema must be a JSON Schema of
 *   'type: "object"', got 'type: null'.
 *
 * Because tools are part of every request, loading the plugin made the Harness
 * unable to answer anything. This test registers the plugin into a minimal fake
 * context and validates the model-facing schemas the same way the provider does.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const ALLOWED_KEYWORDS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
])

const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])

function createFakeContext() {
  const tools = new Map()
  const skills = new Map()
  const ctx = {
    effect(fn) {
      return fn()
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    skills: {
      register(definition) {
        skills.set(definition.name, definition)
        return () => {}
      },
    },
    workingDirectory: {
      async ensure() {
        return process.cwd()
      },
    },
  }
  return { ctx, tools, skills }
}

function validateNode(node, path, errors) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${path}: schema node must be an object`)
    return
  }

  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) errors.push(`${path}: unsupported keyword "${key}"`)
  }

  if (node.type !== undefined) {
    if (typeof node.type !== 'string' || !ALLOWED_TYPES.has(node.type)) {
      errors.push(`${path}.type: unsupported type ${JSON.stringify(node.type)}`)
    }
  }

  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) errors.push(`${path}.oneOf: must be a non-empty array`)
    else node.oneOf.forEach((child, index) => validateNode(child, `${path}.oneOf[${index}]`, errors))
  }

  if (node.enum !== undefined && !Array.isArray(node.enum)) errors.push(`${path}.enum: must be an array`)

  if (node.description !== undefined && typeof node.description !== 'string') {
    errors.push(`${path}.description: must be a string`)
  }

  if (node.required !== undefined) {
    if (!Array.isArray(node.required)) {
      // This is what DSH's JsonSchemaNode validator reports as
      // "required is not supported on type ..." / "required must be an array of strings".
      errors.push(`${path}.required: must be an array of strings`)
    } else if (!node.required.every((key) => typeof key === 'string')) {
      errors.push(`${path}.required: must contain only strings`)
    }
  }

  if (node.type === 'object' || node.properties !== undefined) {
    if (node.properties !== undefined) {
      if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        errors.push(`${path}.properties: must be an object`)
      } else {
        for (const [key, child] of Object.entries(node.properties)) {
          validateNode(child, `${path}.properties.${key}`, errors)
        }
        if (Array.isArray(node.required)) {
          for (const key of node.required) {
            if (!(key in node.properties)) errors.push(`${path}.required: "${key}" is not a declared property`)
          }
        }
      }
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
      if (typeof node.additionalProperties !== 'object') {
        errors.push(`${path}.additionalProperties: must be a boolean or schema node`)
      } else {
        validateNode(node.additionalProperties, `${path}.additionalProperties`, errors)
      }
    }
  }

  if (node.type === 'array') {
    if (node.items === undefined) errors.push(`${path}.items: is required when type is "array"`)
    else validateNode(node.items, `${path}.items`, errors)
  }
}

test('plugin registers its three tools and the skill', () => {
  const { ctx, tools, skills } = createFakeContext()
  apply(ctx, {})

  assert.deepEqual([...tools.keys()].sort(), ['ft_http_run', 'ft_report', 'ft_ui_run'])
  assert.ok(skills.has('functional-testing'))
})

test('every tool parameter schema is a wire-valid, object-rooted JSON Schema', () => {
  const { ctx, tools } = createFakeContext()
  apply(ctx, {})

  for (const [name, definition] of tools) {
    assert.equal(definition.parameters?.type, 'object', `${name}: parameters must be rooted at type "object"`)
    assert.ok(definition.parameters?.properties, `${name}: parameters must declare properties`)

    const errors = []
    validateNode(definition.parameters, `${name}.parameters`, errors)
    assert.deepEqual(errors, [], `${name}: invalid parameter schema`)

    if (Array.isArray(definition.parameters.required)) {
      assert.ok(definition.parameters.required.length > 0, `${name}: at least one required parameter`)
    } else {
      assert.fail(`${name}: parameters must declare a required array`)
    }
  }
})

test('every tool output schema is a wire-valid JSON Schema', () => {
  const { ctx, tools } = createFakeContext()
  apply(ctx, {})

  for (const [name, definition] of tools) {
    assert.equal(definition.output?.schema?.type, 'object', `${name}: output schema must be object-rooted`)

    const errors = []
    validateNode(definition.output.schema, `${name}.output.schema`, errors)
    assert.deepEqual(errors, [], `${name}: invalid output schema`)
  }
})

test('required markers live in the object-level arrays, never on a property', () => {
  const { ctx, tools } = createFakeContext()
  apply(ctx, {})

  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (node.required !== undefined) {
      assert.ok(Array.isArray(node.required), `${path}.required must be an object-level array`)
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
  }

  for (const [name, definition] of tools) {
    walk(definition.parameters, `${name}.parameters`)
    walk(definition.output.schema, `${name}.output.schema`)
  }
})

test('tool definitions carry the executable contract', () => {
  const { ctx, tools } = createFakeContext()
  apply(ctx, {})

  for (const [name, definition] of tools) {
    assert.equal(typeof definition.description, 'string', `${name}: description`)
    assert.equal(typeof definition.execute, 'function', `${name}: execute`)
    assert.equal(typeof definition.output.render, 'function', `${name}: output.render`)
    assert.equal(typeof definition.isConcurrencySafe, 'function', `${name}: isConcurrencySafe must be a function`)
    assert.equal(typeof definition.timeoutMs, 'number', `${name}: timeoutMs`)
  }
})

test('skill registration exposes runtime metadata without frontmatter', () => {
  const { ctx, skills } = createFakeContext()
  apply(ctx, {})

  const skill = skills.get('functional-testing')
  assert.equal(skill.source, 'runtime')
  assert.equal(typeof skill.description, 'string')
  assert.equal(typeof skill.whenToUse, 'string')
  assert.equal(skill.invocation.modelInvocable, true)
  assert.equal(skill.invocation.userInvocable, true)
  assert.equal(skill.resourceBase?.kind, 'directory')
  assert.match(skill.resourceBase.path, /skill$/)
  assert.ok(skill.content.length > 0)
  assert.ok(!skill.content.startsWith('---'), 'skill content must not include YAML frontmatter')
})
