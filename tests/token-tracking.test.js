'use strict'

// Unit tests for the pieces of #11's and #37's per-run token tracking that
// tests/token-usage.test.js does NOT reach, because that file only drives the
// downstream pure aggregateTokens(results, spent, concurrency, byStage) helper
// with hand-built `results`/`spent`/`byStage` inputs — never the run-body code
// that actually produces those inputs during a real run:
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
//   3. addStage()/STAGE_TOKENS (#37) — the region-boundary bracketing helper
//      that feeds aggregateTokens()'s 4th `byStage` arg in a real run. Drives
//      context.addStage(bucket, before) directly (both live above the
//      TICKETMILL-TEST-HARNESS-SPLIT marker, same as stage(), so the harness
//      reaches them exactly like any other module-level declaration) with a
//      scripted, stateful budget.spent(), and reads the module-level
//      STAGE_TOKENS accumulator back out via harness.readGlobal(). Covers the
//      negative-delta clamp, the isFiniteNumber guard on both `before` and the
//      internally-sampled `after`, cross-call accumulation into the same
//      bucket (mirroring R1+R2 both feeding `preflight` in the real run body),
//      bucket independence, and that a downstream accumulation failure is
//      swallowed without affecting control flow — the exact gap called out in
//      "Test Validation (iteration 1)": only a hand-fabricated byStage object
//      was exercised before, never the bracketing function that produces it.

const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

const ROOT = path.join(__dirname, '..')
const ENGINE_PATH = path.join(ROOT, 'workflows', 'ticketmill.js')
const CLAUDE_ENGINE_PATH = path.join(ROOT, '.claude', 'workflows', 'ticketmill.js')

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

// ---- addStage()/STAGE_TOKENS: the #37 run-body region-boundary accumulator ----
//
// addStage(bucket, before) is the DRY helper the run body calls immediately
// after each of the four sequential regions it brackets (learnPromise, the
// claims Promise.all + settle loop, proposeConsolidation, and
// postConsolidationMarkers) — it samples `after = spentTokens()` itself and
// accumulates Math.max(0, after - before) into the module-level STAGE_TOKENS
// object. These tests drive it directly, the same way the stage() tests above
// drive stage() directly, rather than only ever handing aggregateTokens() a
// hand-built byStage object as tests/token-usage.test.js does.

test('STAGE_TOKENS: starts as {preflight: 0, select: 0} for a fresh run, matching the bucket keys addStage() writes into', function () {
  const context = harness.boot()
  const stageTokens = harness.readGlobal(context, 'STAGE_TOKENS')
  assert.deepStrictEqual(Object.assign({}, stageTokens), { preflight: 0, select: 0 })
})

test('addStage: accumulates Math.max(0, after-before) into STAGE_TOKENS[bucket], leaving the other bucket untouched', function () {
  const context = harness.boot({ budget: queuedBudget([1300]) })
  context.addStage('preflight', 1000)

  const stageTokens = harness.readGlobal(context, 'STAGE_TOKENS')
  assert.strictEqual(stageTokens.preflight, 300)
  assert.strictEqual(stageTokens.select, 0)
})

test('addStage: clamps a negative measured delta to 0 rather than recording a decrease (mirrors stage()\'s own clamp)', function () {
  // Same shared-monotonic-counter concern as stage()'s clamp test above:
  // addStage()'s own doc comment only guarantees exactness because every
  // bracketed region is sequential and strictly before runPool(), but the
  // clamp is still load-bearing defense if that invariant is ever violated.
  const context = harness.boot({ budget: queuedBudget([200]) })
  context.addStage('preflight', 500)

  assert.strictEqual(harness.readGlobal(context, 'STAGE_TOKENS').preflight, 0)
})

test('addStage: skips accumulation entirely when `before` is non-finite (NaN)', function () {
  const context = harness.boot({ budget: queuedBudget([1300]) })
  context.addStage('preflight', NaN)

  assert.strictEqual(harness.readGlobal(context, 'STAGE_TOKENS').preflight, 0)
})

test('addStage: skips accumulation entirely when `before` is non-finite (Infinity)', function () {
  const context = harness.boot({ budget: queuedBudget([1300]) })
  context.addStage('select', Infinity)

  assert.strictEqual(harness.readGlobal(context, 'STAGE_TOKENS').select, 0)
})

test('addStage: skips accumulation when the internally-sampled `after` (spentTokens()) is unavailable', function () {
  const context = harness.boot({ budget: {} }) // no .spent function at all -> spentTokens() returns null
  context.addStage('preflight', 1000)

  assert.strictEqual(harness.readGlobal(context, 'STAGE_TOKENS').preflight, 0)
})

test('addStage: skips accumulation when budget.spent() throws (spentTokens() already swallows it and returns null)', function () {
  const context = harness.boot({
    budget: { spent: function () { throw new Error('budget hook misbehaved') } },
  })

  assert.doesNotThrow(function () { context.addStage('preflight', 1000) })
  assert.strictEqual(harness.readGlobal(context, 'STAGE_TOKENS').preflight, 0)
})

test('addStage: its own try/catch swallows a downstream accumulation failure without throwing or affecting run-body control flow', function () {
  // Belt-and-suspenders beyond spentTokens()'s own guard: force the
  // `STAGE_TOKENS[bucket] += ...` assignment itself to throw (e.g. as if the
  // bucket were a getter/setter pair that misbehaves) and prove addStage()'s
  // own try/catch — the one its doc comment says "mirrors stage()'s finally
  // block" — is what's actually swallowing it, not just spentTokens().
  const context = harness.boot({ budget: queuedBudget([900]) })
  const stageTokens = harness.readGlobal(context, 'STAGE_TOKENS')
  Object.defineProperty(stageTokens, 'preflight', {
    get: function () { return 0 },
    set: function () { throw new Error('boom') },
  })

  assert.doesNotThrow(function () { context.addStage('preflight', 500) })
})

test('addStage: accumulates across repeated calls into the same bucket (R1 + R2 both feeding preflight, as in the real run body)', function () {
  const budgetStub = queuedBudget([1200, 1450])
  const context = harness.boot({ budget: budgetStub })

  context.addStage('preflight', 1000) // R1: before=1000, after=1200 -> +200
  context.addStage('preflight', 1300) // R2: before=1300, after=1450 -> +150

  assert.strictEqual(harness.readGlobal(context, 'STAGE_TOKENS').preflight, 350)
  assert.strictEqual(budgetStub.calls.length, 2) // exactly one `after` sample per addStage() call
})

test('addStage: preflight and select buckets accumulate independently', function () {
  const budgetStub = queuedBudget([1100, 1300])
  const context = harness.boot({ budget: budgetStub })

  context.addStage('preflight', 1000) // +100
  context.addStage('select', 1200) // +100

  const stageTokens = harness.readGlobal(context, 'STAGE_TOKENS')
  assert.strictEqual(stageTokens.preflight, 100)
  assert.strictEqual(stageTokens.select, 100)
})

// ---- Report-phase resultsJson: source-level regression for the raw budget.spent() bug ----
//
// A raw budget.spent() call (unlike the guarded spentTokens() wrapper above) throws
// when the runtime hook misbehaves, which would abort resultsJson construction and
// kill the whole Report phase — no run report, no retrospective write, even for an
// otherwise-successful run. Neither engine copy can be `require`d (Workflow-tool
// globals, top-level await), so this reads the source text directly, mirroring the
// fs.readFileSync source-inspection pattern in tests/sandbox-lint.test.js, and
// isolates the `resultsJson` object literal so the assertion can't be satisfied by
// an unrelated spentTokens() call elsewhere in the file (e.g. the TOKEN_AGG line).

/** Extract the `const resultsJson = JSON.stringify({ ... }, null, 2)` block verbatim. */
function extractResultsJsonBlock(source) {
  const start = source.indexOf('const resultsJson = JSON.stringify({')
  assert.notStrictEqual(start, -1, 'resultsJson block not found in engine source')
  const end = source.indexOf('}, null, 2)', start)
  assert.notStrictEqual(end, -1, 'resultsJson block close (`}, null, 2)`) not found in engine source')
  return source.slice(start, end)
}

for (const [label, enginePath] of [['workflows/ticketmill.js', ENGINE_PATH], ['.claude/workflows/ticketmill.js', CLAUDE_ENGINE_PATH]]) {
  test('Report phase (' + label + '): resultsJson.tokens_spent uses the guarded spentTokens(), not raw budget.spent()', function () {
    const source = fs.readFileSync(enginePath, 'utf8')
    const block = extractResultsJsonBlock(source)

    assert.match(block, /tokens_spent:\s*spentTokens\(\)/, 'resultsJson.tokens_spent must call spentTokens(), the guarded wrapper that never throws')
    assert.doesNotMatch(block, /budget\.spent\(\)/, 'resultsJson block must not call the unguarded budget.spent() directly — a misbehaving hook would abort the whole Report phase')
  })
}
