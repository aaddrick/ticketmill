'use strict'

// Drives runTestLoop(ctx) with a scripted agent() to prove the loop-cap
// actually stops iterating, rather than merely asserting the value of the
// MAX_TEST_ITERATIONS constant. The scripted agent always returns a live
// (truthy) response — never null — so stage()'s own retry/death-counter
// machinery (STAGE_TRIES, MAX_CONSECUTIVE_AGENT_DEATHS) never trips STOP and
// short-circuits the loop for an unrelated reason; only runTestLoop's own
// `for (iter <= MAX_TEST_ITERATIONS)` bound ends it.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('runTestLoop: stops at MAX_TEST_ITERATIONS when tests keep failing, never a raw agent-call count', async function () {
  const context = harness.boot()
  const MAX_TEST_ITERATIONS = harness.readGlobal(context, 'MAX_TEST_ITERATIONS')
  assert.strictEqual(typeof MAX_TEST_ITERATIONS, 'number')

  context.__seed({ PROFILE: {}, TEST_CMD: 'npm test' })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':test-run-') !== -1) {
      // Always "failed" -> the loop always takes the test-fix branch and
      // continues to the next iteration instead of ever reaching test-validate.
      return { result: 'failed', summary: 'failing on purpose', total_tests: 1, passed_tests: 0, failed_tests: 1, failures: [{ test: 'x', message: 'always fails' }] }
    }
    if (label.indexOf(':test-fix-') !== -1) {
      // A live, non-error response -> stage() does not retry and BATCH's
      // consecutive-death counter stays at 0, so the circuit breaker never
      // trips and the loop keeps running all the way to its own cap.
      return { status: 'success', summary: 'attempted a fix', commit: null, files_changed: [] }
    }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 42 })
  const result = await context.runTestLoop(ctx)

  // Field-by-field, not assert.deepStrictEqual(result, {...}): result is an
  // object literal constructed INSIDE the vm context, so it carries that
  // context's Object.prototype — a different realm from this literal's
  // Object.prototype — which fails deepStrictEqual's prototype check even
  // when every property value is identical.
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'test loop exceeded ' + MAX_TEST_ITERATIONS + ' iterations')
  assert.strictEqual(ctx.metrics.test_iters, MAX_TEST_ITERATIONS)
})

test('runTestLoop: skips immediately (ok:true) when the profile declares test_command: null', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {}, TEST_CMD: null })

  harness.installScriptedAgent(context, function () {
    throw new Error('agent must not be called when the test gate is explicitly disabled')
  })

  const ctx = harness.makeCtx({ issue: 43 })
  const result = await context.runTestLoop(ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.metrics.test_iters, 0)
  assert.strictEqual(ctx.decisions.length, 1)
  assert.ok(ctx.decisions[0].entry.includes('SKIPPED — profile declares no test gate'))

  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 1)
  assert.ok(verifySkips[0].includes('#43: test loop skipped'))
})

test('runTestLoop: returns ok:true after a single iteration once tests pass and validation approves', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {}, TEST_CMD: 'npm test' })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':test-run-') !== -1) return { result: 'passed', summary: 'all green', total_tests: 3, passed_tests: 3, failed_tests: 0, failures: [] }
    if (label.indexOf(':test-validate-') !== -1) return { result: 'approved', summary: 'looks good' }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 44 })
  const result = await context.runTestLoop(ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.metrics.test_iters, 1)
  // test-validate approved on the very first pass -> test-quality-fix is
  // never reached, so its round counter must stay at its fresh-ctx zero.
  assert.strictEqual(ctx.metrics.test_quality_fix_rounds, 0)
})

test('runTestLoop: ctx.metrics.test_quality_fix_rounds increments once per test-quality-fix round, and stops incrementing once validation approves (issue #87 task 2)', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {}, TEST_CMD: 'npm test' })

  let validateCalls = 0
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':test-run-') !== -1) return { result: 'passed', summary: 'all green', total_tests: 3, passed_tests: 3, failed_tests: 0, failures: [] }
    if (label.indexOf(':test-validate-') !== -1) {
      validateCalls++
      // Two rounds of "changes requested" before the third approves, so
      // test-quality-fix runs exactly twice.
      return validateCalls <= 2
        ? { result: 'changes_requested', comments: 'hollow assertion', issues: ['x'], summary: 'needs work' }
        : { result: 'approved', summary: 'covered now' }
    }
    if (label.indexOf(':test-quality-fix-') !== -1) return { status: 'success', summary: 'strengthened tests', commit: 'deadbeef', files_changed: ['tests/foo.test.js'] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 45 })
  const result = await context.runTestLoop(ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.metrics.test_iters, 3)
  assert.strictEqual(ctx.metrics.test_quality_fix_rounds, 2)
  // Same call site also feeds tallyTouches — the repeatedly-fixed file must
  // read 2, proving both counters actually advanced together, not just one.
  assert.strictEqual(ctx.touch_counts['tests/foo.test.js'], 2)
})

// ---- issue #162: a present-and-empty `issues` array is treated as nothing-to-fix ----

test('runTestLoop: a changes_requested test-validate with issues: [] is treated as clean — no test-quality-fix stage runs, ok:true, findings_empty_exits increments', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {}, TEST_CMD: 'npm test' })

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':test-run-') !== -1) return { result: 'passed', summary: 'all green', total_tests: 3, passed_tests: 3, failed_tests: 0, failures: [] }
    if (label.indexOf(':test-validate-') !== -1) return { result: 'changes_requested', comments: 'nothing actionable', issues: [], summary: 'nothing to fix' }
    // test-quality-fix must never be reached on this leg — a live throw here
    // (not a returned null/error) proves the loop itself never asked for it.
    throw new Error('test-quality-fix must not run when issues is a present, empty array: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 46 })
  const result = await context.runTestLoop(ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.metrics.findings_empty_exits, 1)
  const stageKeys = scriptedAgent.calls.map(function (c) { return (c.opts && c.opts.label) || '' })
  assert.ok(!stageKeys.some(function (k) { return k.indexOf(':test-quality-fix-') !== -1 }), 'test-quality-fix stage key must be absent from recorded stage keys: ' + JSON.stringify(stageKeys))

  // This exit converts a changes_requested verdict to a clean pass with no fix
  // stage — it must surface in the batch PR's Verification Gaps, not just the
  // run-record metrics counter above.
  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 1)
  assert.ok(verifySkips[0].includes('#46: test validation'))
})

// ---- MIRROR IMAGE (issue #162): `issues` omitted entirely must NOT be treated as empty ----
//
// Every scripted reviewer in the pre-#162 suite supplies `issues` explicitly. This
// is the one scenario that catches the plausible call-site slip
// `normalizeFindings(v.issues || [], source)`, which would collapse an omitted
// key into an empty array and silently disable the fix loop while passing every
// other test (including the unit-level normalizeFindings(undefined) -> null test).

test('runTestLoop: MIRROR IMAGE — a changes_requested test-validate that OMITS `issues` entirely still runs the test-quality-fix stage exactly as on main, and findings_empty_exits stays 0', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {}, TEST_CMD: 'npm test' })

  let validateCalls = 0
  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':test-run-') !== -1) return { result: 'passed', summary: 'all green', total_tests: 3, passed_tests: 3, failed_tests: 0, failures: [] }
    if (label.indexOf(':test-validate-') !== -1) {
      validateCalls++
      if (validateCalls === 1) {
        // `issues` deliberately OMITTED from this response object — not [], not ['x'].
        return { result: 'changes_requested', comments: 'hollow assertion', summary: 'needs work' }
      }
      return { result: 'approved', comments: '', issues: [], summary: 'covered now' }
    }
    if (label.indexOf(':test-quality-fix-') !== -1) return { status: 'success', summary: 'strengthened tests', commit: 'deadbeef', files_changed: ['tests/foo.test.js'] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 47 })
  const result = await context.runTestLoop(ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.metrics.findings_empty_exits, 0)
  const stageKeys = scriptedAgent.calls.map(function (c) { return (c.opts && c.opts.label) || '' })
  assert.ok(stageKeys.some(function (k) { return k.indexOf(':test-quality-fix-i1') !== -1 }), 'test-quality-fix stage must run when `issues` is omitted (degrade to the prose path), not be treated as empty: ' + JSON.stringify(stageKeys))

  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 0)
})

// ---- regression: the pre-#162 issues: ['x'] fixtures still trigger test-quality-fix,
// and the fix prompt now carries the rendered, id-prefixed finding line ----

test('runTestLoop: an existing issues: ["x"] fixture still runs test-quality-fix, and the fix prompt renders the id-prefixed finding line', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {}, TEST_CMD: 'npm test' })

  let validateCalls = 0
  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':test-run-') !== -1) return { result: 'passed', summary: 'all green', total_tests: 3, passed_tests: 3, failed_tests: 0, failures: [] }
    if (label.indexOf(':test-validate-') !== -1) {
      validateCalls++
      if (validateCalls === 1) return { result: 'changes_requested', comments: 'hollow assertion', issues: ['x'], summary: 'needs work' }
      return { result: 'approved', comments: '', issues: [], summary: 'covered now' }
    }
    if (label.indexOf(':test-quality-fix-') !== -1) return { status: 'success', summary: 'strengthened tests', commit: 'deadbeef', files_changed: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 48 })
  const result = await context.runTestLoop(ctx)

  assert.strictEqual(result.ok, true)
  const fixCall = scriptedAgent.calls.find(function (c) { return ((c.opts && c.opts.label) || '').indexOf(':test-quality-fix-') !== -1 })
  assert.ok(fixCall, 'test-quality-fix stage must have run for an issues: ["x"] fixture')
  assert.ok(/- \[test-i1-1\] \[unspecified\] x -> /.test(fixCall.prompt), 'fix prompt must render the id-prefixed finding line: ' + fixCall.prompt.slice(0, 2000))
})
