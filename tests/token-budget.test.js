'use strict'

// Unit tests for the always-on token_budget guard (issue #97 task 4):
//   - parseTokenBudgetSpec / resolveTokenBudget: pure normalization of a raw
//     token_budget value (run arg or profile field) into an absolute OUTPUT-
//     token ceiling or a relative multiple-of-historical-median, run-arg-wins-
//     over-profile precedence, and the honest "guard off, not a false floor"
//     degrade when a relative spec has no trusted history to multiply.
//   - buildBudgetEstimateMap: the Select-phase estimate map runPool()'s
//     estimate-aware pre-check reads — resume_point==='implement' units get a
//     real (possibly null) estimate off `history`, skip/process_pr units are
//     charged ~0, mirroring the dry_run cost_estimate preview's own filter.
//   - runPool()/drainUnit's budgetCtx guard itself: the PRIMARY history-free
//     hard floor (spentTokens() >= budget) at concurrency>1, honest under the
//     real guarded monotonic spentTokens() counter, and the estimate-aware
//     pre-check layered on top (spentTokens()+estimate>budget) firing on a
//     LIVE run (no dry_run involved) BEFORE the unit's fn() is ever called —
//     distinct from, and stricter than, the hard floor alone.
//
// Mirrors tests/cost-estimate.test.js's ledgerLine/trustedBand fixture style
// and tests/run-pool.test.js's bootPool/unit() harness style.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// by_issue/bands/parse-spec return objects are built inside the vm-realm engine
// function, so they fail deepStrictEqual's prototype check against this file's
// own literals even when structurally identical (same cross-realm reasoning as
// tests/cost-estimate.test.js's own plain() helper).
function plain(x) { return JSON.parse(JSON.stringify(x)) }

function bootPool(overrides) {
  const logs = []
  const context = harness.createContext(Object.assign({ log: function (msg) { logs.push(msg) } }, overrides))
  harness.loadEngine(context)
  context.logs = logs
  return context
}

// A single trusted, effective_concurrency===1 ledger line carrying one
// singleton (member_count===1) by_issue_shape row — same shape
// tests/cost-estimate.test.js's own ledgerLine() builds.
function ledgerLine(issue, pf, tokens, overrides) {
  const o = overrides || {}
  return Object.assign({
    run_tag: 'run-' + issue,
    effective_concurrency: 1,
    reconcile_error: 0,
    by_issue_shape: [
      Object.assign({ issue: issue, pf: pf, tokens: tokens, tracked: true, member_count: 1 }, o.row || {}),
    ],
  }, o.line || {})
}

function trustedBand(pf, tokensList) {
  return tokensList.map(function (tok, i) { return ledgerLine(2000 + i, pf, tok) })
}

// A deriveUnits()-shaped unit fixture (issue, resume_point, predicted_files,
// members — the fields buildBudgetEstimateMap/runPool's drainUnit read).
function unit(issue, extra) {
  return Object.assign({
    issue: issue, title: 'issue #' + issue, resume_point: 'implement',
    predicted_files: [], members: [{ issue: issue }], depends_on: [],
  }, extra)
}

// ============================================================================
// parseTokenBudgetSpec
// ============================================================================

test('parseTokenBudgetSpec: a positive finite number is an absolute spec', function () {
  const context = harness.boot()
  assert.deepStrictEqual(plain(context.parseTokenBudgetSpec(500000)), { kind: 'absolute', amount: 500000 })
})

test('parseTokenBudgetSpec: a numeric string is an absolute spec', function () {
  const context = harness.boot()
  assert.deepStrictEqual(plain(context.parseTokenBudgetSpec('500000')), { kind: 'absolute', amount: 500000 })
})

test('parseTokenBudgetSpec: an "Nx" string (case-insensitive, optional whitespace) is a relative multiple spec', function () {
  const context = harness.boot()
  assert.deepStrictEqual(plain(context.parseTokenBudgetSpec('5x')), { kind: 'multiple', multiple: 5 })
  assert.deepStrictEqual(plain(context.parseTokenBudgetSpec('5X')), { kind: 'multiple', multiple: 5 })
  assert.deepStrictEqual(plain(context.parseTokenBudgetSpec(' 2.5x ')), { kind: 'multiple', multiple: 2.5 })
})

test('parseTokenBudgetSpec: a {multiple_of_median} object is a relative multiple spec', function () {
  const context = harness.boot()
  assert.deepStrictEqual(plain(context.parseTokenBudgetSpec({ multiple_of_median: 3 })), { kind: 'multiple', multiple: 3 })
})

test('parseTokenBudgetSpec: null/undefined/zero/negative/non-numeric-string/malformed object all return null (never throw)', function () {
  const context = harness.boot()
  assert.strictEqual(context.parseTokenBudgetSpec(null), null)
  assert.strictEqual(context.parseTokenBudgetSpec(undefined), null)
  assert.strictEqual(context.parseTokenBudgetSpec(0), null)
  assert.strictEqual(context.parseTokenBudgetSpec(-5), null)
  assert.strictEqual(context.parseTokenBudgetSpec('not a number'), null)
  assert.strictEqual(context.parseTokenBudgetSpec('0x'), null)
  assert.strictEqual(context.parseTokenBudgetSpec({ multiple_of_median: -1 }), null)
  assert.strictEqual(context.parseTokenBudgetSpec({}), null)
})

// ============================================================================
// resolveTokenBudget
// ============================================================================

test('resolveTokenBudget: an absolute run arg resolves directly, source "arg"', function () {
  const context = harness.boot()
  const result = context.resolveTokenBudget(500000, null, {})
  assert.strictEqual(result.budget, 500000)
  assert.strictEqual(result.source, 'arg')
})

test('resolveTokenBudget: run arg wins over the profile field when both are set', function () {
  const context = harness.boot()
  const result = context.resolveTokenBudget(500000, 999999, {})
  assert.strictEqual(result.budget, 500000)
  assert.strictEqual(result.source, 'arg')
})

test('resolveTokenBudget: falls back to the profile field when the run arg is absent', function () {
  const context = harness.boot()
  const result = context.resolveTokenBudget(null, 250000, {})
  assert.strictEqual(result.budget, 250000)
  assert.strictEqual(result.source, 'profile')
})

test('resolveTokenBudget: neither source set -> budget null, source null (guard off, not a false floor)', function () {
  const context = harness.boot()
  const result = context.resolveTokenBudget(null, null, {})
  assert.strictEqual(result.budget, null)
  assert.strictEqual(result.source, null)
})

test('resolveTokenBudget: a relative "Nx" spec multiplies globalHistoricalMedian(bands)', function () {
  const context = harness.boot()
  const history = trustedBand(1, [1000, 2000, 3000]) // median 2000
  const estimate = context.buildCostEstimate(history, [])
  const result = context.resolveTokenBudget('5x', null, estimate.bands)
  assert.strictEqual(result.budget, 10000) // 5 * 2000
  assert.strictEqual(result.spec.kind, 'multiple')
})

test('resolveTokenBudget: a relative spec with NO trusted history degrades to budget:null with a human-readable `degraded` note, never a false floor', function () {
  const context = harness.boot()
  const result = context.resolveTokenBudget('5x', null, {})
  assert.strictEqual(result.budget, null)
  assert.strictEqual(typeof result.degraded, 'string')
  assert.ok(/relative token_budget/.test(result.degraded))
})

// ============================================================================
// buildBudgetEstimateMap
// ============================================================================

test('buildBudgetEstimateMap: an "implement" unit in a trusted pf-band gets a real numeric estimate', function () {
  const context = harness.boot()
  const history = trustedBand(1, [1000, 2000, 3000]) // median 2000, band '1' (pf<=1)
  const units = [unit(42, { predicted_files: ['a.js'] })]
  const map = context.buildBudgetEstimateMap(history, units)
  assert.strictEqual(map.estimateByIssue[42], 2000)
})

test('buildBudgetEstimateMap: a "skip" or "process_pr" unit is charged ~0, never a full band-median guess', function () {
  const context = harness.boot()
  const history = trustedBand(1, [1000, 2000, 3000])
  const units = [
    unit(1, { resume_point: 'skip', predicted_files: ['a.js'] }),
    unit(2, { resume_point: 'process_pr', predicted_files: ['a.js'] }),
  ]
  const map = context.buildBudgetEstimateMap(history, units)
  assert.strictEqual(map.estimateByIssue[1], 0)
  assert.strictEqual(map.estimateByIssue[2], 0)
})

test('buildBudgetEstimateMap: an "implement" unit with no same-band trusted history degrades to null (never a false number)', function () {
  const context = harness.boot()
  const units = [unit(7, { predicted_files: ['a.js'] })]
  const map = context.buildBudgetEstimateMap([], units)
  assert.strictEqual(map.estimateByIssue[7], null)
})

test('buildBudgetEstimateMap: null/undefined units degrades cleanly to an empty map instead of throwing', function () {
  const context = harness.boot()
  // Cross-realm empty objects fail assert.deepStrictEqual's identity check even
  // when structurally identical (same reasoning as tests/harness.js's own
  // "Node's assert.deepStrictEqual across the vm realm" note) — assert on shape
  // via Object.keys() instead.
  assert.strictEqual(Object.keys(context.buildBudgetEstimateMap([], null).estimateByIssue).length, 0)
  assert.strictEqual(Object.keys(context.buildBudgetEstimateMap([], undefined).estimateByIssue).length, 0)
})

// ============================================================================
// runPool()/drainUnit's budgetCtx guard — hard floor at concurrency>1
// ============================================================================

test('runPool: token_budget hard floor trips at concurrency>1, honest under the real spentTokens() counter — units already in flight keep their real result, remaining units halt not_started', async function () {
  const context = bootPool()
  const SPENT = { value: 0 }
  context.budget.spent = function () { return SPENT.value }
  const items = [unit(1), unit(2), unit(3), unit(4)]
  const budgetCtx = { budget: 100, estimateByIssue: {} }
  const results = await context.runPool(items, 2, async function (item) {
    // Simulate real output-token spend landing the moment work is committed to
    // (synchronously, before the first await) — 2 concurrent units cross the
    // 100-token budget (60 + 60 = 120) before either completes.
    SPENT.value += 60
    await new Promise(function (resolve) { setTimeout(resolve, 5) })
    return { issue: item.issue, status: 'completed' }
  }, undefined, budgetCtx)
  assert.strictEqual(results.length, 4)
  assert.strictEqual(results[0].status, 'completed', 'unit 1 was already in flight when the budget crossed — its real result stands')
  assert.strictEqual(results[1].status, 'completed', 'unit 2 was already in flight when the budget crossed — its real result stands')
  assert.strictEqual(results[2].status, 'not_started')
  assert.ok(/token_budget hard floor/.test(results[2].error), 'expected a hard-floor-specific error, got: ' + results[2].error)
  assert.strictEqual(results[3].status, 'not_started')
  assert.strictEqual(harness.readGlobal(context, 'STOP.kind'), 'budget', 'STOP.kind must be "budget", distinct from the reactive circuit-breaker kind')
})

test('runPool: budgetCtx.budget === null is a complete no-op (guard off) regardless of spent/estimate', async function () {
  const context = bootPool()
  context.budget.spent = function () { return 999999999 }
  const items = [unit(1), unit(2)]
  const budgetCtx = { budget: null, estimateByIssue: { 1: 999999999 } }
  const calls = []
  const results = await context.runPool(items, 2, async function (item) {
    calls.push(item.issue)
    return { issue: item.issue, status: 'completed' }
  }, undefined, budgetCtx)
  assert.deepStrictEqual(calls.slice().sort(), [1, 2])
  assert.deepStrictEqual(Array.from(results).map(function (r) { return r.status }), ['completed', 'completed'])
  assert.strictEqual(harness.readGlobal(context, 'STOP.tripped'), false)
})

test('runPool: omitting budgetCtx entirely (existing callers/tests) is unaffected', async function () {
  const context = bootPool()
  const items = [unit(1)]
  const results = await context.runPool(items, 1, async function (item) { return { issue: item.issue, status: 'completed' } })
  assert.strictEqual(results[0].status, 'completed')
})

// ============================================================================
// runPool()/drainUnit's budgetCtx guard — estimate-aware pre-check, LIVE run
// (no dry_run involved — issue #97 Revised Plan iteration 2, Minor finding:
// the pre-check must fire off a `history`-derived estimate map on a real run,
// not only inside the dry_run preview)
// ============================================================================

test('runPool: the estimate-aware pre-check fires BEFORE fn() is ever called for a unit whose spent+estimate would exceed budget, even though spent alone is still under the hard floor', async function () {
  const context = bootPool()
  context.budget.spent = function () { return 100 } // constant — well under budget
  const items = [unit(5)]
  const budgetCtx = { budget: 1000, estimateByIssue: { 5: 950 } } // 100 + 950 = 1050 > 1000
  const calls = []
  const results = await context.runPool(items, 1, async function (item) {
    calls.push(item.issue)
    return { issue: item.issue, status: 'completed' }
  }, undefined, budgetCtx)
  assert.deepStrictEqual(calls, [], 'fn must never be called once the estimate-aware pre-check trips')
  assert.strictEqual(results[0].status, 'not_started')
  assert.ok(/estimate-aware pre-check/.test(results[0].error), 'expected a pre-check-specific error, got: ' + results[0].error)
  assert.strictEqual(harness.readGlobal(context, 'STOP.kind'), 'budget')
})

test('runPool: a null (unknown) estimate never fires the pre-check — the unit runs, only the hard floor can stop it', async function () {
  const context = bootPool()
  context.budget.spent = function () { return 999 } // just under the hard floor, would overshoot with ANY positive estimate
  const items = [unit(5)]
  const budgetCtx = { budget: 1000, estimateByIssue: { 5: null } } // unknown estimate
  const calls = []
  const results = await context.runPool(items, 1, async function (item) {
    calls.push(item.issue)
    return { issue: item.issue, status: 'completed' }
  }, undefined, budgetCtx)
  assert.deepStrictEqual(calls, [5], 'unit 5 must run (null estimate cannot trip the pre-check)')
  assert.strictEqual(results[0].status, 'completed')
})

test('runPool: the hard floor still catches a unit whose estimate is null, once spent alone crosses budget', async function () {
  const context = bootPool()
  context.budget.spent = function () { return 150 } // already over budget
  const items = [unit(5)]
  const budgetCtx = { budget: 100, estimateByIssue: { 5: null } }
  const calls = []
  const results = await context.runPool(items, 1, async function (item) {
    calls.push(item.issue)
    return { issue: item.issue, status: 'completed' }
  }, undefined, budgetCtx)
  assert.deepStrictEqual(calls, [])
  assert.strictEqual(results[0].status, 'not_started')
  assert.ok(/token_budget hard floor/.test(results[0].error))
})
