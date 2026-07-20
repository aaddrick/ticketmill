'use strict'

// Drives runQualityLoop(ctx, prefix, taskDesc, filesChanged) with a scripted
// agent() to prove its actual control flow — convergence, the simplify-scope
// skip, degrade accounting, the rolling degrade-window halt, and the STOP
// short-circuit — rather than merely asserting the MAX_* constants exist.
// Every scripted response is branched on opts.label (never call order), and
// every branch that IS reached returns a live (truthy) response — never
// null — so stage()'s own retry/death-counter machinery never trips STOP for
// an unrelated reason; only runQualityLoop's own logic drives each result.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('runQualityLoop: converges to "approved" in one iteration when review approves immediately', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    // PROFILE has no simplify_globs, so matchesGlobs treats every file as
    // in-scope and simplify runs before the review that actually converges
    // this scenario.
    if (label.indexOf(':simplify-') !== -1) return { status: 'success', summary: 'nothing to simplify', commit: null, files_changed: [] }
    if (label.indexOf(':quality-review-') !== -1) return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 50 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['src/foo.js'])

  assert.strictEqual(result, 'approved')
  assert.strictEqual(ctx.metrics.quality_iters, 1)
  assert.strictEqual(ctx.degrades[ctx.degrades.length - 1], false)
})

test('runQualityLoop: skips simplify when the changed files are outside simplify_globs scope', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    if (label.indexOf(':quality-review-') !== -1) return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 51 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])

  assert.strictEqual(result, 'approved')
})

test('runQualityLoop: a dead (error-status) fix stage degrades this iteration and records the degrade', async function () {
  const context = harness.boot()
  // simplify_globs scoped away from the changed file so simplify is skipped
  // and this scenario isolates the quality-fix degrade path specifically
  // (the sibling test above already covers a simplify-stage degrade).
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    if (label.indexOf(':quality-review-') !== -1) return { result: 'changes_requested', comments: 'fix this', issues: ['x'], recommended_fix_agent: null, summary: 'needs work' }
    // A live, non-null {status:'error'} response — not a null/thrown death —
    // so stage()'s retry loop and BATCH.consecutiveDeaths circuit breaker
    // never engage; only runQualityLoop's own `fix.status === 'error'` check
    // drives the degrade.
    if (label.indexOf(':quality-fix-') !== -1) return { status: 'error', summary: 'fix blew up', commit: null, files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 52 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])

  assert.strictEqual(result, 'degraded')
  assert.strictEqual(ctx.metrics.quality_degrades, 1)
  assert.strictEqual(ctx.degrades[ctx.degrades.length - 1], true)
})

test('runQualityLoop: halts once a fresh degrade pushes the rolling window over MAX_QUALITY_DEGRADES_IN_WINDOW', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    // Every stage that could be reached in a single iteration dies live
    // (never null) so this scenario's own halt logic — not the death
    // circuit breaker — is what produces 'halted'.
    if (label.indexOf(':simplify-') !== -1) return { status: 'error', summary: 'simplify blew up', commit: null, files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 53 })
  // Pre-seed two prior degrades in this issue's rolling window; one more
  // degrade from this call reaches MAX_QUALITY_DEGRADES_IN_WINDOW (3).
  ctx.degrades = [true, true]

  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['src/foo.js'])

  assert.strictEqual(result, 'halted')
  // Discriminates the degrade-window halt path from the STOP short-circuit
  // path below: both return 'halted', but only this path runs the loop body
  // at all, so both counters must have advanced exactly once.
  assert.strictEqual(ctx.metrics.quality_iters, 1)
  assert.strictEqual(ctx.metrics.quality_degrades, 1)
})

test('runQualityLoop: halts immediately with zero agent calls when STOP is already tripped', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} })
  harness.readGlobal(context, 'STOP.tripped = true')

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    throw new Error('agent must not be called once STOP has tripped')
  })

  const ctx = harness.makeCtx({ issue: 54 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['src/foo.js'])

  assert.strictEqual(result, 'halted')
  assert.strictEqual(scriptedAgent.calls.length, 0)
  // Discriminates from the degrade-window halt path above: the STOP check
  // is the very first line of the loop body, before either counter
  // increments, so both stay at their fresh-ctx zero.
  assert.strictEqual(ctx.metrics.quality_iters, 0)
  assert.strictEqual(ctx.metrics.quality_degrades, 0)
})
