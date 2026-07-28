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

test('runQualityLoop: each quality-fix round tallies its files_changed into ctx.touch_counts (issue #87 task 2) — a file fixed twice reads 2, a file fixed once reads 1', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} }) // no simplify_globs -> matchesGlobs treats every file in-scope, so simplify runs every iteration (same as the "converges" test above)

  let iter = 0
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) return { status: 'success', summary: 'nothing to simplify', commit: null, files_changed: [] }
    if (label.indexOf(':quality-review-') !== -1) {
      iter++
      // Two rounds of "changes requested" before the third approves, so the
      // fix stage below runs twice.
      return iter <= 2
        ? { result: 'changes_requested', comments: 'fix this', issues: ['x'], recommended_fix_agent: null, summary: 'needs work' }
        : { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }
    }
    if (label.indexOf(':quality-fix-') !== -1) {
      // Round 1 touches both files; round 2 re-touches only one of them.
      const files = iter === 1 ? ['src/foo.js', 'src/bar.js'] : ['src/foo.js']
      return { status: 'success', summary: 'fixed', commit: 'deadbeef', files_changed: files }
    }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 55 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['src/foo.js'])

  assert.strictEqual(result, 'approved')
  assert.strictEqual(ctx.touch_counts['src/foo.js'], 2)
  assert.strictEqual(ctx.touch_counts['src/bar.js'], 1)
})

// ---- issue #162: a present-and-empty `issues` array is treated as nothing-to-fix ----

test('runQualityLoop: a changes_requested review with issues: [] is treated as clean — no fix stage runs, result is "approved", quality_degrades stays 0, findings_empty_exits increments', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} })

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) return { status: 'success', summary: 'nothing to simplify', commit: null, files_changed: [] }
    if (label.indexOf(':quality-review-') !== -1) return { result: 'changes_requested', comments: 'nothing actionable', issues: [], recommended_fix_agent: null, summary: 'nothing to fix' }
    // The fix stage must never be reached on this leg — a live throw here
    // (not a returned null/error) proves the loop itself never asked for it,
    // rather than merely never seeing its result.
    throw new Error('quality-fix must not run when issues is a present, empty array: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 56 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['src/foo.js'])

  assert.strictEqual(result, 'approved')
  assert.strictEqual(ctx.metrics.quality_degrades, 0)
  assert.strictEqual(ctx.metrics.findings_empty_exits, 1)
  const stageKeys = scriptedAgent.calls.map(function (c) { return (c.opts && c.opts.label) || '' })
  assert.ok(!stageKeys.some(function (k) { return k.indexOf(':quality-fix-') !== -1 }), 'fix stage key must be absent from recorded stage keys: ' + JSON.stringify(stageKeys))

  // This exit converts a changes_requested verdict to a clean pass with no fix
  // stage — it must surface in the batch PR's Verification Gaps, not just the
  // run-record metrics counter above.
  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 1)
  assert.ok(verifySkips[0].includes('#56: quality review'))
})

// ---- MIRROR IMAGE (issue #162): `issues` omitted entirely must NOT be treated as empty ----
//
// Every scripted reviewer in the pre-#162 suite supplies `issues` explicitly. This
// is the one scenario that catches the plausible call-site slip
// `normalizeFindings(rev.issues || [], source)`, which would collapse an omitted
// key into an empty array and silently disable the fix loop while passing every
// other test (including the unit-level normalizeFindings(undefined) -> null test).

test('runQualityLoop: MIRROR IMAGE — a changes_requested review that OMITS `issues` entirely still runs the fix stage exactly as on main, and findings_empty_exits stays 0', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} })

  let reviewCalls = 0
  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) return { status: 'success', summary: 'nothing to simplify', commit: null, files_changed: [] }
    if (label.indexOf(':quality-review-') !== -1) {
      reviewCalls++
      if (reviewCalls === 1) {
        // `issues` deliberately OMITTED from this response object — not [], not ['x'].
        return { result: 'changes_requested', comments: 'fix this', recommended_fix_agent: null, summary: 'needs work' }
      }
      return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }
    }
    if (label.indexOf(':quality-fix-') !== -1) return { status: 'success', summary: 'fixed', commit: 'deadbeef', files_changed: ['src/foo.js'] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 57 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['src/foo.js'])

  assert.strictEqual(result, 'approved')
  assert.strictEqual(ctx.metrics.findings_empty_exits, 0)
  const stageKeys = scriptedAgent.calls.map(function (c) { return (c.opts && c.opts.label) || '' })
  assert.ok(stageKeys.some(function (k) { return k.indexOf(':quality-fix-task-1-i1') !== -1 }), 'fix stage must run when `issues` is omitted (degrade to the prose path), not be treated as empty: ' + JSON.stringify(stageKeys))

  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 0)
})

// ---- regression: the pre-#162 issues: ['x'] fixtures still trigger the fix stage,
// and the fix prompt now carries the rendered, id-prefixed finding line ----

test('runQualityLoop: an existing issues: ["x"] fixture still runs the fix stage, and the fix prompt renders the id-prefixed finding line', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } })

  let reviewCalls = 0
  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    if (label.indexOf(':quality-review-') !== -1) {
      reviewCalls++
      if (reviewCalls === 1) return { result: 'changes_requested', comments: 'fix this', issues: ['x'], recommended_fix_agent: null, summary: 'needs work' }
      return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }
    }
    if (label.indexOf(':quality-fix-') !== -1) return { status: 'success', summary: 'fixed', commit: 'deadbeef', files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 58 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])

  assert.strictEqual(result, 'approved')
  const fixCall = scriptedAgent.calls.find(function (c) { return ((c.opts && c.opts.label) || '').indexOf(':quality-fix-') !== -1 })
  assert.ok(fixCall, 'fix stage must have run for an issues: ["x"] fixture')
  assert.ok(/- \[quality-task-1-i1-1\] \[unspecified\] x -> /.test(fixCall.prompt), 'fix prompt must render the id-prefixed finding line: ' + fixCall.prompt.slice(0, 2000))
})
