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
