'use strict'

// Drives runBrowserCheck(ctx, where) with a scripted agent() to prove its
// actual control flow — the no-browser / empty-ui_globs / skipped-by-globs
// skip paths (with VERIFY_SKIPS recording where applicable), the fail-CLOSED
// probe-death branch, convergence, the MAX_BROWSER_ITERATIONS cap, and the
// under-the-lock cleanup stage running even when the verifier itself dies.
// Every scripted response is branched on opts.label (never call order), and
// every branch that IS reached returns a live (truthy) response unless the
// scenario is specifically about a dead stage — so stage()'s own retry/death-
// counter machinery never drives a result for an unrelated reason; only
// runBrowserCheck's own logic does.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('runBrowserCheck: no profile.browser configured skips entirely and never calls the agent', async function () {
  const context = harness.boot()

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    throw new Error('agent must not be called when BROWSER is not configured')
  })

  const ctx = harness.makeCtx({ issue: 60 })
  const result = await context.runBrowserCheck(ctx, 'implement')

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.skipped, true)
  assert.strictEqual(scriptedAgent.calls.length, 0)
})

test('runBrowserCheck: empty profile.browser.ui_globs skips and records the gap in VERIFY_SKIPS', async function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { ui_globs: [] }")

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    throw new Error('agent must not be called when ui_globs is empty')
  })

  const ctx = harness.makeCtx({ issue: 61 })
  const result = await context.runBrowserCheck(ctx, 'implement')

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.skipped, true)
  assert.strictEqual(scriptedAgent.calls.length, 0)
  // The skip must be recorded so it renders in the batch PR's Verification
  // Gaps section — a silent skip is the exact incident this engine guards
  // against.
  const skips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(skips.length, 1)
  assert.match(skips[0], /#61.*browser verification skipped/)
})

test('runBrowserCheck: skips when the UI probe finds no matching files in the diff', async function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { ui_globs: ['src/**'] }")

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':ui-probe-') !== -1) return { ui_files: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 62 })
  const result = await context.runBrowserCheck(ctx, 'implement')

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.skipped, true)
  // Only the probe ran — no browser-* verification stage was ever reached.
  assert.strictEqual(scriptedAgent.calls.length, 1)
})

test('runBrowserCheck: a dead UI probe fails CLOSED and still runs verification', async function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { ui_globs: ['src/**'] }")

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    // The probe dies on both STAGE_TRIES attempts -> stage() returns null.
    // Discriminates verification-ran from a silent-skip regression: a naive
    // "probe died -> skip" bug would also satisfy a bare {ok:true} check.
    if (label.indexOf(':ui-probe-') !== -1) return null
    if (label.indexOf(':browser-cleanup-') !== -1) return { posted: true }
    if (label.indexOf(':browser-fix-') !== -1) throw new Error('fix must not run: the verifier passes on iteration 1')
    if (label.indexOf(':browser-') !== -1) return { result: 'passed', summary: 'looks fine', scenarios: [], failures: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 63 })
  const result = await context.runBrowserCheck(ctx, 'implement')

  assert.strictEqual(result.ok, true)
  assert.ok(!result.skipped)
  assert.ok(scriptedAgent.calls.some(function (c) { return ((c.opts && c.opts.label) || '').indexOf(':browser-implement-i') !== -1 }))
})

test('runBrowserCheck: converges to ok:true in one iteration when browser verification passes', async function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { ui_globs: ['src/**'] }")

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':ui-probe-') !== -1) return { ui_files: ['src/App.jsx'] }
    if (label.indexOf(':browser-cleanup-') !== -1) return { posted: true }
    if (label.indexOf(':browser-fix-') !== -1) throw new Error('fix must not run: the verifier passes on iteration 1')
    if (label.indexOf(':browser-') !== -1) return { result: 'passed', summary: 'all good', scenarios: ['login'], failures: [] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 64 })
  const result = await context.runBrowserCheck(ctx, 'implement')

  assert.strictEqual(result.ok, true)
  assert.ok(!result.skipped)
  assert.strictEqual(ctx.metrics.browser_iters, 1)
  assert.strictEqual(ctx.decisions.length, 1)
})

test('runBrowserCheck: fails after MAX_BROWSER_ITERATIONS of persistent failures', async function () {
  const context = harness.boot()
  const maxIters = harness.readGlobal(context, 'MAX_BROWSER_ITERATIONS')
  harness.readGlobal(context, "BROWSER = { ui_globs: ['src/**'] }")

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':ui-probe-') !== -1) return { ui_files: ['src/App.jsx'] }
    if (label.indexOf(':browser-cleanup-') !== -1) return { posted: true }
    // A live (never null) fix response so the death circuit breaker never
    // engages — only the persistent 'failed' result drives the cap.
    if (label.indexOf(':browser-fix-') !== -1) return { status: 'success', summary: 'attempted a fix', commit: 'deadbeef', files_changed: ['src/App.jsx'] }
    if (label.indexOf(':browser-') !== -1) return { result: 'failed', summary: 'still broken', scenarios: [], failures: ['button does nothing'] }
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 65 })
  const result = await context.runBrowserCheck(ctx, 'implement')

  assert.strictEqual(result.ok, false)
  assert.strictEqual(ctx.metrics.browser_iters, maxIters)
})

test('runBrowserCheck: cleanup still runs, under the lock, when the browser verifier itself dies', async function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { ui_globs: ['src/**'] }")

  const scriptedAgent = harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label.indexOf(':ui-probe-') !== -1) return { ui_files: ['src/App.jsx'] }
    if (label.indexOf(':browser-cleanup-') !== -1) return { posted: true }
    if (label.indexOf(':browser-fix-') !== -1) throw new Error('fix must not run: the function returns before reaching the fix stage')
    // The verifier dies on both STAGE_TRIES attempts.
    if (label.indexOf(':browser-') !== -1) return null
    throw new Error('unexpected stage label in this scenario: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 66 })
  const result = await context.runBrowserCheck(ctx, 'implement')

  assert.strictEqual(result.ok, false)
  assert.ok(scriptedAgent.calls.some(function (c) { return ((c.opts && c.opts.label) || '').indexOf(':browser-cleanup-implement-i') !== -1 }))
})
