'use strict'

// Unit tests for sanitizeTasks(ctx, raw) — the lifted, top-level stub-task
// guard (workflows/ticketmill.js, above `async function implementIssue`).
// Covers the three documented behaviors: the stub-task guard (description
// length < 12 dropped), agent normalization to DEFAULT_IMPLEMENTER when the
// planner names an agent outside IMPLEMENTERS, and id defaulting to the
// task's 1-based position in the ORIGINAL (pre-filter) array when t.id isn't
// a number.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

function bootWithImplementers() {
  const context = harness.boot()
  context.__seed({ IMPLEMENTERS: ['alice', 'bob'], DEFAULT_IMPLEMENTER: 'alice' })
  return context
}

test('sanitizeTasks: stub-task guard drops descriptions under 12 chars, keeps real ones', function () {
  const context = bootWithImplementers()
  const ctx = harness.makeCtx({ issue: 7 })

  const tasks = context.sanitizeTasks(ctx, [
    { id: 1, description: 'short' }, // 5 chars, stub -> dropped
    { id: 2, description: 'This is a real task description' }, // kept
    { id: 3, description: '' }, // empty -> dropped, no log noise
    { id: 4, description: 'exactly12ch!' }, // 12 chars exactly -> boundary, kept
  ])

  assert.strictEqual(tasks.length, 2)
  assert.deepStrictEqual(tasks.map(function (t) { return t.id }), [2, 4])
})

test('sanitizeTasks: agent normalization falls back to DEFAULT_IMPLEMENTER for unknown/missing agents', function () {
  const context = bootWithImplementers()
  const ctx = harness.makeCtx({ issue: 8 })

  const tasks = context.sanitizeTasks(ctx, [
    { id: 1, description: 'Valid task description here', agent: 'bob' }, // in IMPLEMENTERS -> kept
    { id: 2, description: 'Another valid task description', agent: 'carol' }, // unknown -> DEFAULT_IMPLEMENTER
    { id: 3, description: 'Yet another valid task text' }, // no agent field at all -> DEFAULT_IMPLEMENTER
  ])

  assert.strictEqual(tasks[0].agent, 'bob')
  assert.strictEqual(tasks[1].agent, 'alice')
  assert.strictEqual(tasks[2].agent, 'alice')
})

test('sanitizeTasks: id defaults to the 1-based ORIGINAL index, surviving stub-guard filtering', function () {
  const context = bootWithImplementers()
  const ctx = harness.makeCtx({ issue: 9 })

  // Index 0 is a stub and gets dropped; indices 1 and 2 are real. If id
  // defaulting happened AFTER filtering (a regression), these would renumber
  // to 1 and 2 instead of keeping their original 2 and 3.
  const tasks = context.sanitizeTasks(ctx, [
    { description: 'stub' },
    { id: 'not-a-number', description: 'A valid task description' },
    { description: 'Another valid task description' },
  ])

  assert.strictEqual(tasks.length, 2)
  assert.strictEqual(tasks[0].id, 2)
  assert.strictEqual(tasks[1].id, 3)
})

test('sanitizeTasks: explicit numeric id is preserved as-is', function () {
  const context = bootWithImplementers()
  const ctx = harness.makeCtx({ issue: 10 })

  const tasks = context.sanitizeTasks(ctx, [{ id: 42, description: 'A perfectly valid task description' }])

  assert.strictEqual(tasks[0].id, 42)
})

test('sanitizeTasks: empty/absent raw list returns an empty array', function () {
  const context = bootWithImplementers()
  const ctx = harness.makeCtx({ issue: 11 })

  // Compare by length/type, not assert.deepStrictEqual(..., []): a null/undefined
  // `raw` falls back to a `[]` literal constructed INSIDE the vm context (a
  // different realm from this test file's own `[]`), so it carries the vm
  // context's Array.prototype — deepStrictEqual across realms fails on
  // prototype identity even when the values are structurally identical.
  for (const raw of [[], null, undefined]) {
    const result = context.sanitizeTasks(ctx, raw)
    assert.ok(Array.isArray(result))
    assert.strictEqual(result.length, 0)
  }
})
