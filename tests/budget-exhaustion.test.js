'use strict'

// Unit tests for issue #35's tightened isBudgetExhaustedError(): a
// budget/token/ceiling NOUN must now co-occur with an exhaustion/exceedance
// VERB (exhaust/exceed/deplete/ran out/over/limit-reached) in a caught stage
// error's message before the whole-run STOP trips. Either alone is not
// enough — a target repo's own domain error that merely names a budget noun,
// or merely exceeds something unrelated, must fall through to the ordinary
// per-attempt retry + recordAgentDeath() path instead of halting the run.
//
// Drives both the predicate directly (context.isBudgetExhaustedError(msg))
// and end-to-end through context.stage() with a scripted throwing agent(),
// mirroring tests/token-tracking.test.js's harness-driven style.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ---- context.isBudgetExhaustedError(msg): direct predicate ----

test('isBudgetExhaustedError: true-exhaustion message (budget noun + exhaustion verb) returns true and trips STOP', function () {
  const context = harness.boot()
  const result = context.isBudgetExhaustedError('token budget exhausted')
  assert.strictEqual(result, true)
  assert.strictEqual(harness.readGlobal(context, 'STOP.tripped'), true)
})

test('isBudgetExhaustedError: domain error with a budget/ceiling noun but no exhaustion verb returns false and leaves STOP untripped', function () {
  const context = harness.boot()
  const result = context.isBudgetExhaustedError('the ceiling value for the monthly budget feature is 5')
  assert.strictEqual(result, false)
  assert.strictEqual(harness.readGlobal(context, 'STOP.tripped'), false)
})

test('isBudgetExhaustedError: domain error with an exhaustion verb but no budget/token/ceiling noun returns false and leaves STOP untripped', function () {
  const context = harness.boot()
  const result = context.isBudgetExhaustedError('upload exceeded the max file size')
  assert.strictEqual(result, false)
  assert.strictEqual(harness.readGlobal(context, 'STOP.tripped'), false)
})

test('isBudgetExhaustedError: domain error with a budget noun and a bare "over"-substring word (not an overrun-shaped phrase) returns false and leaves STOP untripped', function () {
  const context = harness.boot()
  const result = context.isBudgetExhaustedError('failed to recover the budget ledger')
  assert.strictEqual(result, false)
  assert.strictEqual(harness.readGlobal(context, 'STOP.tripped'), false)
})

// ---- context.stage(): harness-driven, scripted throwing agent ----

test('stage(): a true-exhaustion throw trips STOP and returns null on the first throw, without consuming a retry', async function () {
  const context = harness.boot()
  let calls = 0
  harness.installScriptedAgent(context, function () {
    calls++
    throw new Error('token budget exhausted')
  })

  const ctx = harness.makeCtx({ issue: 1 })
  const r = await context.stage(ctx, 'some-stage', 'do the thing', {}, {})

  assert.strictEqual(r, null)
  assert.strictEqual(calls, 1, 'a true budget-exhaustion throw must short-circuit the retry loop on the first attempt')
  assert.strictEqual(harness.readGlobal(context, 'STOP.tripped'), true)
})

test('stage(): a false-positive domain error (budget/ceiling noun, no exhaustion verb) is retried STAGE_TRIES times, leaves STOP untripped, and counts as one consecutive death', async function () {
  const context = harness.boot()
  const STAGE_TRIES = harness.readGlobal(context, 'STAGE_TRIES')
  let calls = 0
  harness.installScriptedAgent(context, function () {
    calls++
    throw new Error('the ceiling value for the monthly budget feature is 5')
  })

  const ctx = harness.makeCtx({ issue: 2 })
  const r = await context.stage(ctx, 'some-stage', 'do the thing', {}, {})

  assert.strictEqual(r, null)
  assert.strictEqual(calls, STAGE_TRIES, 'ordinary retry behavior — every attempt gets a fresh scripted call')
  assert.strictEqual(harness.readGlobal(context, 'STOP.tripped'), false)
  assert.strictEqual(harness.readGlobal(context, 'BATCH.consecutiveDeaths'), 1)
})

test('stage(): a contrarian-recommended domain error (exhaustion verb, no budget/token/ceiling noun) leaves STOP untripped', async function () {
  const context = harness.boot()
  const STAGE_TRIES = harness.readGlobal(context, 'STAGE_TRIES')
  let calls = 0
  harness.installScriptedAgent(context, function () {
    calls++
    throw new Error('upload exceeded the max file size')
  })

  const ctx = harness.makeCtx({ issue: 3 })
  const r = await context.stage(ctx, 'some-stage', 'do the thing', {}, {})

  assert.strictEqual(r, null)
  assert.strictEqual(calls, STAGE_TRIES, 'ordinary retry behavior — an exhaustion-shaped verb alone must not short-circuit the loop')
  assert.strictEqual(harness.readGlobal(context, 'STOP.tripped'), false)
  assert.strictEqual(harness.readGlobal(context, 'BATCH.consecutiveDeaths'), 1)
})
