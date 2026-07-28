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

  // issue #163: this clean-but-unfixed exit tallies as 'carried-unresolved' in
  // gate_findings.quality — it converted a changes_requested verdict to a pass
  // without ever running a fix, so it is not an 'accepted' outcome.
  harness.assertVmEqual(ctx.gate_findings.quality, {
    count: 0,
    severity: { critical: 0, major: 0, minor: 0 },
    disposition: { 'carried-unresolved': 1 },
  })
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

// ---- issue #163: recordGateOutcome(ctx, 'quality', ...) wiring — one test per
// disposition branch from task 1's map. tests/gate-findings.test.js already
// proves recordGateOutcome() itself is correct in isolation; these drive the
// real runQualityLoop() control flow (same rationale as
// tests/pr-review-gate.test.js's header comment) so the derivation at each
// call site — not just the pure tally function — is proven end-to-end. ----

test('runQualityLoop: a simplify-stage death records a "dismissed" disposition with zero findings', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} }) // no simplify_globs -> every file in-scope -> simplify runs

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) return { status: 'error', summary: 'simplify blew up', commit: null, files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 59 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['src/foo.js'])

  assert.strictEqual(result, 'degraded')
  assert.strictEqual(ctx.metrics.quality_degrades, 1)
  harness.assertVmEqual(ctx.gate_findings.quality, {
    count: 0,
    severity: { critical: 0, major: 0, minor: 0 },
    disposition: { dismissed: 1 },
  })
})

test('runQualityLoop: a review-stage death (agent gives up after retries) records a "dismissed" disposition with zero findings', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } }) // scoped away from the changed file -> simplify skipped

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    // null every attempt -> stage() retries STAGE_TRIES times then gives up (dead).
    if (label.indexOf(':quality-review-') !== -1) return null
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 60 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])

  assert.strictEqual(result, 'degraded')
  assert.strictEqual(ctx.metrics.quality_degrades, 1)
  harness.assertVmEqual(ctx.gate_findings.quality, {
    count: 0,
    severity: { critical: 0, major: 0, minor: 0 },
    disposition: { dismissed: 1 },
  })
})

test('runQualityLoop: an approved review records an "accepted" disposition, tallying any nit-level issues alongside the approval', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    // 'approved' can still carry nit-level issues — the disposition is driven
    // by .result alone, not by issues being empty (mirrors pr-review-gate.test.js:70).
    if (label.indexOf(':quality-review-') !== -1) return { result: 'approved', comments: '', issues: [{ severity: 'minor', summary: 'nit: naming' }], recommended_fix_agent: null, summary: 'looks good' }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 61 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])

  assert.strictEqual(result, 'approved')
  harness.assertVmEqual(ctx.gate_findings.quality, {
    count: 1,
    severity: { critical: 0, major: 0, minor: 1 },
    disposition: { accepted: 1 },
  })
})

test('runQualityLoop: a changes_requested review before the cap iteration records a "re-litigated" disposition', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } })

  let reviewCalls = 0
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    if (label.indexOf(':quality-review-') !== -1) {
      reviewCalls++
      if (reviewCalls === 1) return { result: 'changes_requested', comments: 'fix this', issues: [{ severity: 'major', summary: 'bug' }], recommended_fix_agent: null, summary: 'needs work' }
      return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }
    }
    if (label.indexOf(':quality-fix-') !== -1) return { status: 'success', summary: 'fixed', commit: 'deadbeef', files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 62 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])

  assert.strictEqual(result, 'approved')
  const g = ctx.gate_findings.quality
  assert.strictEqual(g.count, 1)
  harness.assertVmEqual(g.disposition, { 're-litigated': 1, accepted: 1 })
})

// ---- issue #163: a typed mixed-severity issues array (mirrors
// tests/pr-review-gate.test.js:390) ----

test('runQualityLoop: a typed mixed-severity issues array makes gate_findings["quality"].severity report real, non-zero counts', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } })

  let reviewCalls = 0
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    if (label.indexOf(':quality-review-') !== -1) {
      reviewCalls++
      if (reviewCalls === 1) {
        return {
          result: 'changes_requested', comments: '', issues: [
            { severity: 'critical', summary: 'auth bypass' },
            { severity: 'major', summary: 'missing input validation', recommendation: 'validate before use' },
            { severity: 'minor', summary: 'typo in error message' },
          ], recommended_fix_agent: null, summary: 'three findings',
        }
      }
      return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }
    }
    if (label.indexOf(':quality-fix-') !== -1) return { status: 'success', summary: 'fixed', commit: 'deadbeef', files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 63 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])

  assert.strictEqual(result, 'approved')
  const g = ctx.gate_findings.quality
  assert.strictEqual(g.count, 3)
  harness.assertVmEqual(g.severity, { critical: 1, major: 1, minor: 1 })
  harness.assertVmEqual(g.disposition, { 're-litigated': 1, accepted: 1 })
})

// ---- issue #163: the exact invariant sum(gate_findings.quality.disposition)
// === ctx.metrics.quality_iters. Every iteration entered (quality_iters++ at
// the top of the loop body) records exactly one disposition before the
// iteration can exit, whether it exits clean or by a later death — proven
// here by ending the loop on a death AFTER a prior re-litigated iteration. ----

test('runQualityLoop: sum(gate_findings.quality.disposition) === ctx.metrics.quality_iters, even when the loop ends on a later death', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } })

  let reviewCalls = 0
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    if (label.indexOf(':quality-review-') !== -1) {
      reviewCalls++
      // iteration 1: changes_requested with a real finding (-> re-litigated,
      // fix runs and succeeds); iteration 2: the reviewer dies (-> dismissed).
      if (reviewCalls === 1) return { result: 'changes_requested', comments: 'fix this', issues: [{ severity: 'major', summary: 'bug' }], recommended_fix_agent: null, summary: 'needs work' }
      return null
    }
    if (label.indexOf(':quality-fix-') !== -1) return { status: 'success', summary: 'fixed', commit: 'deadbeef', files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 64 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])

  assert.strictEqual(result, 'degraded')
  assert.strictEqual(ctx.metrics.quality_iters, 2)
  const g = ctx.gate_findings.quality
  harness.assertVmEqual(g.disposition, { 're-litigated': 1, dismissed: 1 })
  const sum = Object.keys(g.disposition).reduce(function (acc, k) { return acc + g.disposition[k] }, 0)
  assert.strictEqual(sum, ctx.metrics.quality_iters)
})

// ---- issue #163: the bounded cap line — cap exhaustion is `!approved &&
// !degraded` at the loop tail, rolled up to exactly ONE VERIFY_SKIPS entry. ----

test('runQualityLoop: a fully capped loop (5 changes_requested iterations, no death) records disposition {\'re-litigated\': 4, \'carried-unresolved\': 1}, returns "degraded", leaves quality_degrades at 0, and pushes exactly one VERIFY_SKIPS entry', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    if (label.indexOf(':quality-review-') !== -1) return { result: 'changes_requested', comments: 'still not right', issues: [{ severity: 'major', summary: 'bug' }], recommended_fix_agent: null, summary: 'needs work' }
    if (label.indexOf(':quality-fix-') !== -1) return { status: 'success', summary: 'fixed', commit: 'deadbeef', files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 65 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])

  assert.strictEqual(result, 'degraded')
  assert.strictEqual(ctx.metrics.quality_iters, 5)
  assert.strictEqual(ctx.metrics.quality_degrades, 0)
  const g = ctx.gate_findings.quality
  assert.strictEqual(g.count, 5)
  harness.assertVmEqual(g.disposition, { 're-litigated': 4, 'carried-unresolved': 1 })

  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 1)
  assert.ok(verifySkips[0].includes('#65'), 'expected the single cap line to name this issue: ' + verifySkips[0])
  assert.ok(verifySkips[0].includes('task 1'), 'expected the single cap line to name the capped scope: ' + verifySkips[0])
})

test('runQualityLoop: two capped scopes on the same ctx (a task, then a PR-fix round) roll up to exactly one VERIFY_SKIPS entry naming both', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: { simplify_globs: ['src/**'] } })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) throw new Error('simplify must not run: filesChanged has no in-scope files')
    if (label.indexOf(':quality-review-') !== -1) return { result: 'changes_requested', comments: 'still not right', issues: [{ severity: 'major', summary: 'bug' }], recommended_fix_agent: null, summary: 'needs work' }
    if (label.indexOf(':quality-fix-') !== -1) return { status: 'success', summary: 'fixed', commit: 'deadbeef', files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 66 })
  const firstResult = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['docs/readme.md'])
  const secondResult = await context.runQualityLoop(ctx, 'pr-fix-i1', 'fix pr feedback', ['docs/readme.md'])

  assert.strictEqual(firstResult, 'degraded')
  assert.strictEqual(secondResult, 'degraded')

  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 1, 'a second capped scope on the same ctx must rewrite the existing entry in place, not append a second one: ' + JSON.stringify(verifySkips))
  assert.ok(verifySkips[0].includes('task 1'), 'expected the rolled-up entry to still name the first capped scope: ' + verifySkips[0])
  assert.ok(verifySkips[0].includes('PR-fix round 1'), 'expected the rolled-up entry to also name the second capped scope: ' + verifySkips[0])
})

test('runQualityLoop: a loop that converges to "approved" pushes no VERIFY_SKIPS entry at all', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':simplify-') !== -1) return { status: 'success', summary: 'nothing to simplify', commit: null, files_changed: [] }
    if (label.indexOf(':quality-review-') !== -1) return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 67 })
  const result = await context.runQualityLoop(ctx, 'task-1', 'do the thing', ['src/foo.js'])

  assert.strictEqual(result, 'approved')
  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 0)
})
