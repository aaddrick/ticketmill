'use strict'

// Tests for issue #90 — honest token reconciliation.
//
// The pre-existing `reconciles` boolean is defined as `concurrency === 1 && hasSpent
// && trackedAny`: it flips true whenever a serial run tracked *anything*, WITHOUT ever
// comparing the attributed sum to the real total. So a concurrency:1 run reports
// reconciles:true even when a large fraction of spend was never attributed (the ~26%
// of PR-review/merge/report spend the retrospective documents). That makes it useless
// as a gate for efficiency metrics.
//
// aggregateTokens now also returns:
//   - attributed:     the summed per-issue + per-stage deltas.
//   - reconcile_error: |spent - attributed| / spent — the concurrency-independent
//                      honest signal. Small => trustworthy attribution. Downstream
//                      efficiency metrics (rework-tax, #91) must gate on THIS.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ---- the crux: reconciles:true can coexist with a real attribution gap ----

test('concurrency:1 can report reconciles:true while reconcile_error exposes a real gap', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { opus: 100 }, tracked: true } },
    { issue: 2, tokens: { total: 150, byModel: { opus: 150 }, tracked: true } },
  ]
  // spent 300, but only 250 attributed -> 50 (16.7%) of the run is unattributed
  // orchestration spend the per-issue rows never saw.
  const agg = context.aggregateTokens(results, 300, 1)

  assert.strictEqual(agg.reconciles, true, 'the legacy boolean still flips true at concurrency 1')
  assert.strictEqual(agg.attributed, 250)
  assert.ok(Math.abs(agg.reconcile_error - (50 / 300)) < 1e-9, 'reconcile_error must expose the ~16.7% gap the boolean hides')
  assert.ok(agg.reconcile_error > 0.1, 'the honest signal is materially non-zero even though reconciles===true')
})

// ---- concurrency > 1: over-count is quantified, not just flagged ----

test('concurrency>1 over-count makes reconcile_error large and reconciles false', function () {
  const context = harness.boot()
  // At concurrency>1 the per-issue rows over-count a shared monotonic counter: their
  // sum (500) exceeds the true spent (300).
  const results = [
    { issue: 1, tokens: { total: 250, byModel: { opus: 250 }, tracked: true } },
    { issue: 2, tokens: { total: 250, byModel: { opus: 250 }, tracked: true } },
  ]
  const agg = context.aggregateTokens(results, 300, 2)

  assert.strictEqual(agg.reconciles, false, 'concurrency>1 never claims exact reconciliation')
  assert.strictEqual(agg.attributed, 500)
  assert.ok(Math.abs(agg.reconcile_error - (200 / 300)) < 1e-9, 'reconcile_error quantifies the over-count (|500-300|/300)')
  // remainder still clamps at 0 (can't attribute negative orchestration spend).
  assert.strictEqual(agg.remainder, 0)
})

// ---- stage buckets fold into attributed exactly once ----

test('per-stage buckets are counted in attributed and shrink reconcile_error', function () {
  const context = harness.boot()
  const results = [{ issue: 1, tokens: { total: 100, byModel: { opus: 100 }, tracked: true } }]
  // byStage {select: 50} attributes another 50, so attributed = 150 of 200 spent.
  const agg = context.aggregateTokens(results, 200, 1, { select: 50 })

  assert.strictEqual(agg.attributed, 150)
  assert.ok(Math.abs(agg.reconcile_error - (50 / 200)) < 1e-9)
})

// ---- degenerate inputs ----

test('reconcile_error is null when budget.spent() is unavailable', function () {
  const context = harness.boot()
  const results = [{ issue: 1, tokens: { total: 100, byModel: { opus: 100 }, tracked: true } }]
  const agg = context.aggregateTokens(results, null, 1)
  assert.strictEqual(agg.reconcile_error, null, 'no run total => no honest error to report')
  assert.strictEqual(agg.attributed, 100)
})

test('reconcile_error is 0 for an exactly-attributed run', function () {
  const context = harness.boot()
  const results = [{ issue: 1, tokens: { total: 300, byModel: { opus: 300 }, tracked: true } }]
  const agg = context.aggregateTokens(results, 300, 1)
  assert.strictEqual(agg.reconcile_error, 0)
  assert.strictEqual(agg.attributed, 300)
})

// ---- issue #111: the 5-arg poolSpend path re-scopes reconcile_error to the
// per-issue-attributable pool slice, surfacing the run-total-vs-pool gap as
// its own named orchestration_overhead field instead of folding it into the
// attribution-error signal. ----

// Shared fixture: a single-issue full-pipeline run where late, unbracketed
// stages (PR-review/merge/report/retrospective/outcome-grading/revisit-probe)
// dominate the run total, but the per-issue pool itself (poolSpend, bracketed
// immediately around runPool() by the caller) reconciles almost exactly
// against what the per-issue row + stage buckets attribute inside it.
function poolFixture() {
  return {
    results: [
      {
        issue: 1,
        tokens: {
          total: 98,
          byModel: { opus: 98 },
          tracked: true,
          byStage: { implement: 70, 'quality-fix-i1': 28 },
        },
      },
    ],
    byStage: { preflight: 15, select: 5 },
    poolSpend: 100,
    runTotal: 1200, // heavy late-stage overhead the pool never saw
  }
}

test('poolSpend (issue #111): single-issue full-pipeline fixture with heavy late-stage overhead reconciles under the trust threshold via the pool-scoped denominator', function () {
  const context = harness.boot()
  const f = poolFixture()
  const agg = context.aggregateTokens(f.results, f.runTotal, 1, f.byStage, f.poolSpend)

  assert.strictEqual(agg.run_total, f.runTotal)
  assert.strictEqual(agg.pool_spend, f.poolSpend)
  // perIssueSum (98) vs poolSpend (100) -> |100-98|/100 = 0.02, well under the
  // 0.05 trust threshold, even though run_total (1200) dwarfs the pool.
  assert.ok(Math.abs(agg.reconcile_error - (2 / 100)) < 1e-9)
  assert.ok(agg.reconcile_error < 0.05, 'pool-scoped reconcile_error must clear the trust threshold despite the huge run_total')
  // orchestration_overhead is the honest run-total-vs-pool gap, reported as
  // its own field rather than folded into reconcile_error.
  assert.strictEqual(agg.orchestration_overhead, f.runTotal - f.poolSpend)
  // attributed/run_total are UNCHANGED by poolSpend: per-issue total (98) plus
  // both stage buckets (15 + 5) still fold into sumDeltas exactly once.
  assert.strictEqual(agg.attributed, 98 + 15 + 5)
})

test('poolSpend (issue #111): feeding that TOKEN_AGG into computeReworkTax flips trusted true (the acceptance gate)', function () {
  const context = harness.boot()
  const f = poolFixture()
  const tokenAgg = context.aggregateTokens(f.results, f.runTotal, 1, f.byStage, f.poolSpend)

  const rt = context.computeReworkTax(f.results, tokenAgg)

  assert.strictEqual(rt.trusted, true)
  assert.strictEqual(rt.suppressed_reason, null)
  // the rework-bearing byStage classifies as expected: 28 rework / 70 first-pass.
  assert.strictEqual(rt.run_rework, 28)
  assert.strictEqual(rt.run_first_pass, 70)
  assert.strictEqual(rt.has_signal, true)
})

test('poolSpend (issue #111): concurrency>1 pool over-count still yields a large reconcile_error and computeReworkTax reports untrusted', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 200, byModel: { opus: 200 }, tracked: true, byStage: { implement: 150, 'quality-fix-i1': 50 } } },
    { issue: 2, tokens: { total: 200, byModel: { opus: 200 }, tracked: true, byStage: { implement: 200 } } },
  ]
  // Overlapping concurrent stages over-count a shared monotonic counter: the
  // per-issue sum (400) exceeds the true pool spend (300).
  const poolSpend = 300
  const runTotal = 350
  const agg = context.aggregateTokens(results, runTotal, 2, {}, poolSpend)

  assert.strictEqual(agg.attributed, 400, 'per-issue sums still fold into sumDeltas unchanged by poolSpend')
  assert.ok(Math.abs(agg.reconcile_error - (Math.abs(poolSpend - 400) / poolSpend)) < 1e-9)
  assert.ok(agg.reconcile_error > 0.05, 'concurrency>1 over-count must still blow past the trust threshold under the pool-scoped formula')

  const rt = context.computeReworkTax(results, agg)
  assert.strictEqual(rt.trusted, false)
  assert.ok(rt.suppressed_reason.indexOf('exceeds the trust threshold') !== -1)
})

test('poolSpend (issue #111): omitting the 5th arg reproduces pre-#111 reconcile_error exactly, with pool_spend/orchestration_overhead both null', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { opus: 100 }, tracked: true } },
    { issue: 2, tokens: { total: 150, byModel: { opus: 150 }, tracked: true } },
  ]
  const agg4 = context.aggregateTokens(results, 300, 1, {}) // 4-arg call
  const agg3 = context.aggregateTokens(results, 300, 1) // 3-arg call

  for (const agg of [agg3, agg4]) {
    assert.strictEqual(agg.pool_spend, null)
    assert.strictEqual(agg.orchestration_overhead, null)
    // matches the pre-#111 |spent - attributed| / spent formula, byte-identical
    // to the first test in this file (spent 300, attributed 250).
    assert.ok(Math.abs(agg.reconcile_error - (50 / 300)) < 1e-9)
  }
})
