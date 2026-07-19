'use strict'

// Unit tests for the two pieces of #11's per-run token tracking that
// tests/token-usage.test.js does NOT reach, because that file only drives the
// downstream pure aggregateTokens(results, spent, concurrency) helper with
// hand-built `results`/`spent` inputs:
//
//   1. spentTokens() — the guarded wrapper over the runtime's budget.spent().
//      Exercises every branch: budget missing, budget.spent not a function,
//      budget.spent() throwing, and budget.spent() returning a non-finite
//      value, plus the happy path.
//   2. stage()'s finally-block instrumentation — the tokensBefore/tokensAfter
//      sampling around the retry loop, the Math.max(0, ...) delta clamp, and
//      the ctx.tokens.total / ctx.tokens.byModel[opts.model] / ctx.tokens.tracked
//      accumulation. Drives context.stage(...) directly (not through a higher
//      loop) with a scripted agent() and a scripted, stateful budget.spent(),
//      so the attribution math is proven end-to-end rather than assumed from
//      the changelog's description of it.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ---- spentTokens(): guard branches ----

test('spentTokens: returns the finite number budget.spent() reports', function () {
  const context = harness.boot({ budget: { spent: function () { return 42 } } })
  assert.strictEqual(context.spentTokens(), 42)
})

test('spentTokens: returns null when budget is undefined', function () {
  const context = harness.boot({ budget: undefined })
  assert.strictEqual(context.spentTokens(), null)
})

test('spentTokens: returns null when budget.spent is not a function', function () {
  const context = harness.boot({ budget: { spent: 'nope' } })
  assert.strictEqual(context.spentTokens(), null)
})

test('spentTokens: returns null when budget.spent() throws', function () {
  const context = harness.boot({
    budget: { spent: function () { throw new Error('budget hook misbehaved') } },
  })
  assert.strictEqual(context.spentTokens(), null)
})

test('spentTokens: returns null when budget.spent() returns NaN', function () {
  const context = harness.boot({ budget: { spent: function () { return NaN } } })
  assert.strictEqual(context.spentTokens(), null)
})

test('spentTokens: returns null when budget.spent() returns Infinity', function () {
  const context = harness.boot({ budget: { spent: function () { return Infinity } } })
  assert.strictEqual(context.spentTokens(), null)
})

test('spentTokens: returns null when budget.spent() returns a non-number', function () {
  const context = harness.boot({ budget: { spent: function () { return '100' } } })
  assert.strictEqual(context.spentTokens(), null)
})

// ---- stage(): token-tracking finally-block ----

// A budget.spent() stub that returns the next value off a queue on each call,
// and records every value it handed out (in call order) so tests can assert
// exactly how many times stage() sampled it.
function queuedBudget(values) {
  const queue = values.slice()
  const calls = []
  return {
    spent: function () {
      const v = queue.length ? queue.shift() : queue[queue.length]
      calls.push(v)
      return v
    },
    calls: calls,
  }
}

test('stage(): samples budget.spent() before and after the call and records the delta onto ctx.tokens', async function () {
  const budgetStub = queuedBudget([1000, 1300])
  const context = harness.boot({ budget: budgetStub })
  harness.installScriptedAgent(context, function () { return { ok: true } })

  const ctx = harness.makeCtx({ issue: 1 })
  assert.strictEqual(ctx.tokens.tracked, false) // sanity: fixture starts untracked

  const r = await context.stage(ctx, 'some-stage', 'do the thing', { model: 'sonnet' }, {})

  assert.strictEqual(r.ok, true)
  assert.strictEqual(ctx.tokens.total, 300)
  assert.strictEqual(ctx.tokens.byModel.sonnet, 300)
  assert.strictEqual(ctx.tokens.tracked, true)
  // Exactly one before/after pair — not one sample per retry attempt.
  assert.strictEqual(budgetStub.calls.length, 2)
})

test('stage(): clamps a negative measured delta to 0 rather than recording a decrease', async function () {
  // budget.spent() moving backwards relative to this call happens when a
  // shared monotonic counter is read across overlapping concurrent stages;
  // stage() must never let that show up as negative tokens.
  const context = harness.boot({ budget: queuedBudget([500, 200]) })
  harness.installScriptedAgent(context, function () { return { ok: true } })

  const ctx = harness.makeCtx({ issue: 2 })
  await context.stage(ctx, 'some-stage', 'do the thing', { model: 'opus' }, {})

  assert.strictEqual(ctx.tokens.total, 0)
  assert.strictEqual(ctx.tokens.byModel.opus, 0) // key still created, with a 0 delta added
  // tokensBefore/tokensAfter were both finite, so tracking still counts as
  // having happened even though the clamped delta was 0.
  assert.strictEqual(ctx.tokens.tracked, true)
})

test('stage(): one before/after sample spans the whole retry loop, not one pair per attempt', async function () {
  const budgetStub = queuedBudget([100, 250])
  const context = harness.boot({ budget: budgetStub })

  let attempts = 0
  harness.installScriptedAgent(context, function () {
    attempts++
    return attempts < 2 ? null : { ok: true } // fail once, then succeed
  })

  const ctx = harness.makeCtx({ issue: 3 })
  const r = await context.stage(ctx, 'some-stage', 'do the thing', { model: 'sonnet' }, {})

  assert.strictEqual(r.ok, true)
  assert.strictEqual(attempts, 2) // proves the retry actually happened
  assert.strictEqual(budgetStub.calls.length, 2) // yet spentTokens() was only sampled twice
  assert.strictEqual(ctx.tokens.total, 150)
  assert.strictEqual(ctx.tokens.byModel.sonnet, 150)
})

test('stage(): accumulates byModel across multiple stage() calls for the same model rather than overwriting', async function () {
  const context = harness.boot({ budget: queuedBudget([0, 40, 40, 65]) })
  harness.installScriptedAgent(context, function () { return { ok: true } })

  const ctx = harness.makeCtx({ issue: 4 })
  await context.stage(ctx, 'stage-a', 'first', { model: 'opus' }, {})
  await context.stage(ctx, 'stage-b', 'second', { model: 'opus' }, {})

  assert.strictEqual(ctx.tokens.total, 65) // 40 + 25
  assert.strictEqual(ctx.tokens.byModel.opus, 65)
})

test('stage(): accumulates ctx.tokens.total when opts.model is absent, without creating any byModel key', async function () {
  const context = harness.boot({ budget: queuedBudget([10, 55]) })
  harness.installScriptedAgent(context, function () { return { ok: true } })

  const ctx = harness.makeCtx({ issue: 5 })
  await context.stage(ctx, 'some-stage', 'do the thing', {}, {})

  assert.strictEqual(ctx.tokens.total, 45)
  assert.strictEqual(Object.keys(ctx.tokens.byModel).length, 0)
  assert.strictEqual(ctx.tokens.tracked, true)
})

test('stage(): silently no-ops (no throw) when ctx.tokens is absent, an older ctx shape', async function () {
  const context = harness.boot({ budget: queuedBudget([10, 55]) })
  harness.installScriptedAgent(context, function () { return { ok: true } })

  const ctx = harness.makeCtx({ issue: 6 })
  delete ctx.tokens // simulate a ctx built before token tracking existed

  const r = await context.stage(ctx, 'some-stage', 'do the thing', { model: 'sonnet' }, {})

  assert.strictEqual(r.ok, true) // control flow is completely unaffected
  assert.strictEqual(ctx.tokens, undefined) // instrumentation never re-creates the field
})

test('stage(): leaves ctx.tokens untouched when budget.spent() is unavailable (spentTokens() returns null)', async function () {
  const context = harness.boot({ budget: {} }) // no .spent function at all
  harness.installScriptedAgent(context, function () { return { ok: true } })

  const ctx = harness.makeCtx({ issue: 7 })
  await context.stage(ctx, 'some-stage', 'do the thing', { model: 'sonnet' }, {})

  assert.strictEqual(ctx.tokens.total, 0)
  assert.strictEqual(ctx.tokens.tracked, false)
  assert.strictEqual(Object.keys(ctx.tokens.byModel).length, 0)
})

test('stage(): a budget.spent() that throws on every call never affects the stage() return value or ctx.tokens', async function () {
  // spentTokens() already swallows the throw and returns null (proven in the
  // guard-branch tests above); this proves that null propagating through
  // BOTH tokensBefore and tokensAfter still leaves stage()'s own return value
  // and ctx.tokens completely unaffected — the finally-block's isFiniteNumber
  // guard skips the whole accumulation block rather than doing arithmetic on
  // non-numbers.
  const context = harness.boot({
    budget: { spent: function () { throw new Error('budget hook misbehaved') } },
  })
  harness.installScriptedAgent(context, function () { return { ok: true } })

  const ctx = harness.makeCtx({ issue: 8 })
  const r = await context.stage(ctx, 'some-stage', 'do the thing', { model: 'sonnet' }, {})

  assert.strictEqual(r.ok, true)
  assert.strictEqual(ctx.tokens.total, 0)
  assert.strictEqual(ctx.tokens.tracked, false)
})
