'use strict'

// Unit tests for frictionFields(ctx, status) (issue #87 task 1) — the pure
// derived-friction snapshot shared by all three unit return sites (fail(),
// reviewAndMerge's completed return, processIssue's skipped return) via
// Object.assign, so the fields can't drift out of sync between them.
//
// Covers the pure function directly across varied ctx shapes, then drives
// fail() itself (one of the three actual return sites) to prove the
// Object.assign wiring lands the SAME values on a real result object, not
// just on frictionFields()'s own isolated output.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('frictionFields: unresolved findings drive unresolved_count/contrarian_capped, and test_quality_fix_rounds mirrors ctx.metrics', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 1, unresolved: ['[approach gate, major] finding A', '[plan gate, major] finding B'] })
  ctx.metrics.test_quality_fix_rounds = 3

  const ff = context.frictionFields(ctx, 'needs_human')

  assert.strictEqual(ff.unresolved_count, 2)
  assert.strictEqual(ff.contrarian_capped, true)
  assert.strictEqual(ff.test_quality_fix_rounds, 3)
  assert.strictEqual(ff.needs_human, true)
})

test('frictionFields: a clean ctx reports all-clear, and needs_human is false for any non-"needs_human" status', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 2 })

  const ff = context.frictionFields(ctx, 'completed')

  assert.strictEqual(ff.unresolved_count, 0)
  assert.strictEqual(ff.contrarian_capped, false)
  assert.strictEqual(ff.test_quality_fix_rounds, 0)
  assert.strictEqual(ff.needs_human, false)

  const ffSkipped = context.frictionFields(ctx, 'skipped')
  assert.strictEqual(ffSkipped.needs_human, false)
})

test('frictionFields: defensive against a missing/partial ctx (mirrors fail()\'s own partial-ctx tolerance) — never throws, never reports friction for an absent ctx', function () {
  const context = harness.boot()

  assert.doesNotThrow(function () { context.frictionFields(null, 'failed') })
  assert.doesNotThrow(function () { context.frictionFields(undefined, 'failed') })
  const ff = context.frictionFields(null, 'failed')
  assert.strictEqual(ff.unresolved_count, 0)
  assert.strictEqual(ff.contrarian_capped, false)
  assert.strictEqual(ff.test_quality_fix_rounds, 0)
  assert.strictEqual(ff.needs_human, false)

  // A ctx missing metrics/unresolved entirely (e.g. a pool-catch stub) still
  // reports the same all-clear shape rather than throwing on the missing fields.
  const ff2 = context.frictionFields({}, 'needs_human')
  assert.strictEqual(ff2.unresolved_count, 0)
  assert.strictEqual(ff2.test_quality_fix_rounds, 0)
  assert.strictEqual(ff2.needs_human, true)
})

// ---- wiring into an actual return site: fail() ----

test('fail(): the returned result carries frictionFields(ctx, status)\'s exact values, proving the Object.assign wiring, not just the pure function\'s own output', async function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture', TARGET: 'Batch_fixture' })
  harness.installScriptedAgent(context, function () { return { posted: true } }) // postNote()'s halt-note-<stage> stage

  const ctx = harness.makeCtx({ issue: 7, unresolved: ['[approach gate, major] still risky'] })
  ctx.metrics.test_quality_fix_rounds = 1

  const result = await context.fail(ctx, 'needs_human', 'some-stage', 'boom')

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.unresolved_count, 1)
  assert.strictEqual(result.contrarian_capped, true)
  assert.strictEqual(result.test_quality_fix_rounds, 1)
  assert.strictEqual(result.needs_human, true)
})

test('fail(): a clean ctx (no unresolved findings, no test-quality-fix rounds) reports all-clear friction fields even on a failure result', async function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture', TARGET: 'Batch_fixture' })
  harness.installScriptedAgent(context, function () { return { posted: true } })

  const ctx = harness.makeCtx({ issue: 8 })
  const result = await context.fail(ctx, 'halted', 'some-stage', 'stopped')

  assert.strictEqual(result.unresolved_count, 0)
  assert.strictEqual(result.contrarian_capped, false)
  assert.strictEqual(result.test_quality_fix_rounds, 0)
  // status is 'halted', not literally 'needs_human' — frictionFields' needs_human
  // must track the actual status string, not just "any failure".
  assert.strictEqual(result.needs_human, false)
})
