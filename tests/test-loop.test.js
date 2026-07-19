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
})
