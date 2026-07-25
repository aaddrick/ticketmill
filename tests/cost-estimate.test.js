'use strict'

// Unit tests for estimateCost(history, issues) (issue #97 task 2) — the pure,
// sandbox-safe token-cost estimator over the runs.jsonl ledger (buildLedgerLine's
// own output shape, issue #86/task 1). Covers:
//   - trusted-row flattening (effective_concurrency===1 AND member_count===1 AND
//     reconcile_error <= ESTIMATOR_MAX_RECONCILE_ERROR), including the by-design
//     ~0.26 reconcile_error case (aggregateTokens' own module comment) CONTRIBUTING,
//     and a genuinely pathological over-bound line being REJECTED.
//   - a group-unit row (member_count>1) never polluting a singleton pf-band.
//   - band-median-else-null (never a global fallback) and the insufficient-sample
//     degrade.
//   - group estimates as the sum of per-member estimates, poisoned to null by any
//     null member.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// by_issue/bands are built inside the vm-realm engine function, so they fail
// deepStrictEqual's prototype check against this file's own literals even when
// structurally identical (same cross-realm reasoning as tests/gate-yield.test.js's
// plain() helper).
function plain(x) { return JSON.parse(JSON.stringify(x)) }

// A single trusted, effective_concurrency===1 ledger line carrying one
// singleton (member_count===1) by_issue_shape row. `overrides` can punch in a
// different reconcile_error/effective_concurrency/pf/tokens/tracked/member_count
// to build the rejected-line fixtures below.
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

// N distinct trusted lines all in the same pf band, so a test can clear
// ESTIMATOR_MIN_BAND_SAMPLES deliberately.
function trustedBand(pf, tokensList) {
  return tokensList.map(function (tok, i) { return ledgerLine(1000 + i, pf, tok) })
}

// ---- trusted-row flattening: the ~0.26 by-design line, and the rejected over-bound line ----

test('estimateCost: a trusted run with reconcile_error ~0.26 (the aggregateTokens by-design shape) CONTRIBUTES to its pf-band median', function () {
  const context = harness.boot()
  const history = [
    ledgerLine(1, 1, 1000, { line: { reconcile_error: 0.26 } }),
    ledgerLine(2, 1, 2000, { line: { reconcile_error: 0.26 } }),
    ledgerLine(3, 1, 3000, { line: { reconcile_error: 0.26 } }),
  ]
  const result = context.estimateCost(history, [{ issue: 9, predicted_files: ['a.js'] }])
  assert.strictEqual(result.bands['1'].count, 3, 'the ~0.26 lines must be counted as trusted samples')
  assert.strictEqual(result.bands['1'].median, 2000)
  assert.strictEqual(result.by_issue[0].estimate, 2000)
  assert.strictEqual(result.by_issue[0].confidence, 'estimated')
})

test('estimateCost: a run with reconcile_error over ESTIMATOR_MAX_RECONCILE_ERROR (~0.5) is REJECTED wholesale, not just discounted', function () {
  const context = harness.boot()
  const history = [
    ledgerLine(1, 1, 1000, { line: { reconcile_error: 0.1 } }),
    ledgerLine(2, 1, 2000, { line: { reconcile_error: 0.1 } }),
    ledgerLine(3, 1, 3000, { line: { reconcile_error: 0.1 } }),
    // Pathological: reconcile_error 0.6 > 0.5. Even though its own row looks
    // like ordinary singleton data, the WHOLE run is untrustworthy, so this
    // row (and its outlier token value) must never reach the band.
    ledgerLine(4, 1, 999999, { line: { reconcile_error: 0.6 } }),
  ]
  const result = context.estimateCost(history, [{ issue: 9, predicted_files: ['a.js'] }])
  assert.strictEqual(result.bands['1'].count, 3, 'the over-bound line must not be counted as a trusted sample')
  assert.strictEqual(result.bands['1'].median, 2000, 'the outlier 999999 token value must not skew the median')
})

test('estimateCost: a run with effective_concurrency !== 1 is rejected wholesale even when reconcile_error looks fine', function () {
  const context = harness.boot()
  const history = [
    ledgerLine(1, 1, 1000),
    ledgerLine(2, 1, 2000),
    ledgerLine(3, 1, 3000),
    ledgerLine(4, 1, 999999, { line: { effective_concurrency: 2, reconcile_error: 0.01 } }),
  ]
  const result = context.estimateCost(history, [{ issue: 9, predicted_files: ['a.js'] }])
  assert.strictEqual(result.bands['1'].count, 3)
  assert.strictEqual(result.bands['1'].median, 2000)
})

// ---- group-unit pollution guard ----

test('estimateCost: a group-unit row (member_count>1) does NOT pollute a singleton pf-band, even in the same band and same run', function () {
  const context = harness.boot()
  const history = [
    ledgerLine(1, 2, 1000),
    ledgerLine(2, 2, 1200),
    ledgerLine(3, 2, 1400),
    // Same run, same pf band (2 -> band '2-3'), but a GROUP unit: its whole-
    // group total (50000) must never be filed into the '2-3' singleton band.
    ledgerLine(4, 2, 50000, { row: { member_count: 2 } }),
  ]
  const result = context.estimateCost(history, [{ issue: 9, predicted_files: ['a.js', 'b.js'] }])
  assert.strictEqual(result.bands['2-3'].count, 3, 'the group-unit row must be excluded from the band sample count')
  assert.strictEqual(result.bands['2-3'].median, 1200, 'the group total must not skew the singleton median')
})

// ---- band-median-else-null: never a global fallback ----

test('estimateCost: an issue in a pf-band with NO trusted history gets null/insufficient, never another band\'s median', function () {
  const context = harness.boot()
  const history = trustedBand(1, [1000, 1000, 1000]) // plenty of history, but only in band '1'
  const result = context.estimateCost(history, [{ issue: 9, predicted_files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] }]) // pf=5 -> band '4-7'
  assert.strictEqual(result.by_issue[0].pf_band, '4-7')
  assert.strictEqual(result.by_issue[0].estimate, null)
  assert.strictEqual(result.by_issue[0].confidence, 'insufficient')
  // The '1' band's own median must be unaffected/still present — proves the
  // null above is a genuine "no data in THIS band", not a global wipeout.
  assert.strictEqual(result.bands['1'].median, 1000)
})

// ---- insufficient-sample degrade (below ESTIMATOR_MIN_BAND_SAMPLES) ----

test('estimateCost: a pf-band with fewer than ESTIMATOR_MIN_BAND_SAMPLES trusted rows degrades to null/insufficient', function () {
  const context = harness.boot()
  const history = trustedBand(3, [1000, 2000]) // only 2 samples, band '2-3'
  const result = context.estimateCost(history, [{ issue: 9, predicted_files: ['a.js', 'b.js'] }])
  assert.strictEqual(result.by_issue[0].estimate, null)
  assert.strictEqual(result.by_issue[0].confidence, 'insufficient')
})

test('estimateCost: a pf-band that clears ESTIMATOR_MIN_BAND_SAMPLES reports the real median, not insufficient', function () {
  const context = harness.boot()
  const history = trustedBand(3, [1000, 2000, 3000])
  const result = context.estimateCost(history, [{ issue: 9, predicted_files: ['a.js', 'b.js'] }])
  assert.strictEqual(result.by_issue[0].estimate, 2000)
  assert.strictEqual(result.by_issue[0].confidence, 'estimated')
})

test('estimateCost: with no history at all, every issue degrades cleanly to null/insufficient (never throws)', function () {
  const context = harness.boot()
  const result = context.estimateCost([], [{ issue: 1, predicted_files: [] }, { issue: 2, predicted_files: ['a.js'] }])
  assert.strictEqual(result.by_issue.length, 2)
  for (const est of result.by_issue) {
    assert.strictEqual(est.estimate, null)
    assert.strictEqual(est.confidence, 'insufficient')
  }
  assert.deepStrictEqual(plain(result.bands), {})
})

test('estimateCost: null/undefined history and issues degrade cleanly instead of throwing', function () {
  const context = harness.boot()
  assert.doesNotThrow(function () { context.estimateCost(null, null) })
  assert.doesNotThrow(function () { context.estimateCost(undefined, undefined) })
  const result = context.estimateCost(null, undefined)
  assert.deepStrictEqual(plain(result.by_issue), [])
})

// ---- per-unit = sum of member estimates ----

test('estimateCost: a group (members.length>1) estimates as the SUM of each member\'s OWN per-member-pf-band estimate, not the union pf', function () {
  const context = harness.boot()
  const history = [
    // band '1' (pf=1): median 1000
    ...trustedBand(1, [900, 1000, 1100]),
    // band '2-3' (pf=2): median 5000 — deliberately far from band '1' so a
    // union-pf lookup (union pf = 3, band '2-3') would give a visibly wrong
    // answer if the implementation banded the whole group instead of summing
    // its members individually.
    ...trustedBand(2, [4900, 5000, 5100]),
  ]
  const group = {
    issue: 42,
    members: [
      { issue: 42, predicted_files: ['a.js'] },       // pf=1 -> band '1', estimate 1000
      { issue: 43, predicted_files: ['b.js', 'c.js'] }, // pf=2 -> band '2-3', estimate 5000
    ],
  }
  const result = context.estimateCost(history, [group])
  assert.strictEqual(result.by_issue[0].estimate, 6000, 'sum of member estimates (1000 + 5000), not a union-pf band lookup')
  assert.strictEqual(result.by_issue[0].confidence, 'estimated')
  assert.strictEqual(result.by_issue[0].member_count, 2)
})

test('estimateCost: a group estimate is poisoned to null when ANY member has no trusted history (never a partial/understated sum)', function () {
  const context = harness.boot()
  const history = trustedBand(1, [900, 1000, 1100]) // only band '1' has history
  const group = {
    issue: 42,
    members: [
      { issue: 42, predicted_files: ['a.js'] },                               // pf=1 -> estimate 1000
      { issue: 43, predicted_files: ['b.js', 'c.js', 'd.js', 'e.js', 'f.js'] }, // pf=5 -> band '4-7', no history -> null
    ],
  }
  const result = context.estimateCost(history, [group])
  assert.strictEqual(result.by_issue[0].estimate, null)
  assert.strictEqual(result.by_issue[0].confidence, 'insufficient')
})

// ---- pf lookup falls back to predicted_files.length when `pf` isn't given directly ----

test('estimateCost: an issues[] entry may give pf as a number OR as a predicted_files array; both resolve to the same band', function () {
  const context = harness.boot()
  const history = trustedBand(2, [1000, 2000, 3000])
  const byPfNumber = context.estimateCost(history, [{ issue: 1, pf: 2 }])
  const byPredictedFiles = context.estimateCost(history, [{ issue: 2, predicted_files: ['a.js', 'b.js'] }])
  assert.strictEqual(byPfNumber.by_issue[0].estimate, 2000)
  assert.strictEqual(byPredictedFiles.by_issue[0].estimate, 2000)
})
