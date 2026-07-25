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
//
// Also covers issue #97 task 3 — the dry_run `cost_estimate` preview's pure
// building blocks (all above the TICKETMILL-TEST-HARNESS-SPLIT marker, same as
// estimateCost() itself):
//   - HISTORY: the module-level binding that threads args.history through.
//   - flagOversized(): the three oversized arms — structural (PRIMARY,
//     OVERSIZE_GROUP_MEMBERS, history-free), pf_ceiling (SECONDARY,
//     OVERSIZE_PF_CEILING, history-free, documented-evadable), and
//     multiple_of_median (unit-invariant, requires real trusted history) —
//     each boundary-tested at its named threshold.
//   - globalHistoricalMedian(): the median-of-per-band-medians the
//     multiple_of_median arm compares every estimate against.
//   - buildBatchProjection(): the batch-wide rollup that never emits a bare
//     summed total when any member estimate is null.
//   - buildCostEstimate(): the public entry point composing all of the above,
//     including the pf=[]-but-oversized-member-count acceptance case.

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

// ============================================================================
// HISTORY run arg threading (issue #97 task 3) — the top-level `HISTORY`
// binding the dry_run cost_estimate preview (and a later task's live-run
// pre-check) reads. Declared well above the TICKETMILL-TEST-HARNESS-SPLIT
// marker (right next to CONCURRENCY/DRY_RUN), so it is directly readable via
// harness.readGlobal() like any other module-level const.
// ============================================================================

test('HISTORY: threads args.history straight through when it is an array', function () {
  const context = harness.boot({ args: { branch: 'main', history: [{ run_tag: 'a' }, { run_tag: 'b' }] } })
  const history = harness.readGlobal(context, 'HISTORY')
  assert.strictEqual(history.length, 2)
  assert.strictEqual(history[0].run_tag, 'a')
  assert.strictEqual(history[1].run_tag, 'b')
})

test('HISTORY: falls open to [] when args.history is omitted', function () {
  const context = harness.boot({ args: { branch: 'main' } })
  const history = harness.readGlobal(context, 'HISTORY')
  assert.strictEqual(Array.isArray(history), true)
  assert.strictEqual(history.length, 0)
})

test('HISTORY: falls open to [] when args.history is present but not an array (never throws)', function () {
  const context = harness.boot({ args: { branch: 'main', history: 'not-an-array' } })
  const history = harness.readGlobal(context, 'HISTORY')
  assert.strictEqual(Array.isArray(history), true)
  assert.strictEqual(history.length, 0)
})

// ============================================================================
// Oversized-issue flags + batch projection (issue #97 task 3) — feeds the
// dry_run `cost_estimate` block. flagOversized/buildBatchProjection/
// globalHistoricalMedian/buildCostEstimate are all plain function declarations
// above the split marker, so they attach directly to the vm context like
// estimateCost() itself.
// ============================================================================

// ---- flagOversized: structural arm (PRIMARY, OVERSIZE_GROUP_MEMBERS) ----

test('flagOversized: structural arm is false one below OVERSIZE_GROUP_MEMBERS, true exactly at it (boundary)', function () {
  const context = harness.boot()
  const threshold = harness.readGlobal(context, 'OVERSIZE_GROUP_MEMBERS')
  const below = context.flagOversized({ member_count: threshold - 1, pf: 0 }, { estimate: null }, null)
  const at = context.flagOversized({ member_count: threshold, pf: 0 }, { estimate: null }, null)
  assert.strictEqual(below.structural, false)
  assert.strictEqual(at.structural, true)
})

test('flagOversized: a group with pf=[] on every member (pf=0) still flags via the structural arm once member_count clears the threshold', function () {
  const context = harness.boot()
  const threshold = harness.readGlobal(context, 'OVERSIZE_GROUP_MEMBERS')
  const flags = context.flagOversized({ member_count: threshold, pf: 0 }, { estimate: null }, null)
  assert.strictEqual(flags.structural, true, 'structural must not depend on pf at all')
  assert.strictEqual(flags.pf_ceiling, false, 'pf_ceiling correctly stays false when pf=0')
  assert.strictEqual(flags.any, true, 'any must be true off the structural arm alone')
})

test('flagOversized: member_count defaults to 1 (never flags structurally) when omitted', function () {
  const context = harness.boot()
  const flags = context.flagOversized({ pf: 0 }, { estimate: null }, null)
  assert.strictEqual(flags.structural, false)
})

// ---- flagOversized: pf_ceiling arm (SECONDARY, OVERSIZE_PF_CEILING, evadable) ----

test('flagOversized: pf_ceiling arm is false one below OVERSIZE_PF_CEILING, true exactly at it (boundary)', function () {
  const context = harness.boot()
  const ceiling = harness.readGlobal(context, 'OVERSIZE_PF_CEILING')
  const below = context.flagOversized({ member_count: 1, pf: ceiling - 1 }, { estimate: null }, null)
  const at = context.flagOversized({ member_count: 1, pf: ceiling }, { estimate: null }, null)
  assert.strictEqual(below.pf_ceiling, false)
  assert.strictEqual(at.pf_ceiling, true)
})

// ---- flagOversized: multiple_of_median arm (unit-invariant, requires real history) ----

test('flagOversized: multiple_of_median arm is false just under ESTIMATOR_OVERSIZED_MULTIPLE x the global median, true exactly at it (boundary)', function () {
  const context = harness.boot()
  const multiple = harness.readGlobal(context, 'ESTIMATOR_OVERSIZED_MULTIPLE')
  const globalMedian = 1000
  const below = context.flagOversized({ member_count: 1, pf: 0 }, { estimate: multiple * globalMedian - 1 }, globalMedian)
  const at = context.flagOversized({ member_count: 1, pf: 0 }, { estimate: multiple * globalMedian }, globalMedian)
  assert.strictEqual(below.multiple_of_median, false)
  assert.strictEqual(at.multiple_of_median, true)
})

test('flagOversized: multiple_of_median is false (never throws) when the estimate is null', function () {
  const context = harness.boot()
  const flags = context.flagOversized({ member_count: 1, pf: 0 }, { estimate: null }, 1000)
  assert.strictEqual(flags.multiple_of_median, false)
})

test('flagOversized: multiple_of_median is false (never throws) when the global median is null (no trusted history at all)', function () {
  const context = harness.boot()
  const flags = context.flagOversized({ member_count: 1, pf: 0 }, { estimate: 999999 }, null)
  assert.strictEqual(flags.multiple_of_median, false)
})

test('flagOversized: any is the OR of all three arms — true when only one fires, false when none do', function () {
  const context = harness.boot()
  const noneFire = context.flagOversized({ member_count: 1, pf: 0 }, { estimate: 100 }, 1000)
  assert.strictEqual(noneFire.any, false)
  const onlyPfCeiling = context.flagOversized({ member_count: 1, pf: 9999 }, { estimate: 100 }, 1000)
  assert.strictEqual(onlyPfCeiling.structural, false)
  assert.strictEqual(onlyPfCeiling.multiple_of_median, false)
  assert.strictEqual(onlyPfCeiling.any, true)
})

// ---- globalHistoricalMedian: median OF the per-band medians, not a global re-derivation ----

test('globalHistoricalMedian: null when bands is empty', function () {
  const context = harness.boot()
  assert.strictEqual(context.globalHistoricalMedian({}), null)
  assert.strictEqual(context.globalHistoricalMedian(null), null)
  assert.strictEqual(context.globalHistoricalMedian(undefined), null)
})

test('globalHistoricalMedian: the median of every band\'s own median, unweighted by sample count', function () {
  const context = harness.boot()
  const bands = { '1': { median: 10, count: 3 }, '2-3': { median: 20, count: 50 }, '4-7': { median: 30, count: 3 } }
  assert.strictEqual(context.globalHistoricalMedian(bands), 20)
})

test('globalHistoricalMedian: ignores a band whose median is non-finite instead of throwing', function () {
  const context = harness.boot()
  const bands = { '1': { median: 10, count: 3 }, '2-3': { median: null, count: 0 } }
  assert.strictEqual(context.globalHistoricalMedian(bands), 10)
})

// ---- buildBatchProjection: never a bare sum on partial coverage ----

test('buildBatchProjection: full coverage sums every estimate and reports confidence "estimated"', function () {
  const context = harness.boot()
  const result = context.buildBatchProjection([{ estimate: 1000 }, { estimate: 2000 }, { estimate: 3000 }])
  assert.strictEqual(result.total_issues, 3)
  assert.strictEqual(result.estimable_count, 3)
  assert.strictEqual(result.unknown_count, 0)
  assert.strictEqual(result.projected_total, 6000)
  assert.strictEqual(result.confidence, 'estimated')
  assert.strictEqual(result.coverage_note, 'estimable 3 of 3, 0 unknown')
})

test('buildBatchProjection: ANY null estimate suppresses the total entirely — never a partial/understated sum', function () {
  const context = harness.boot()
  const result = context.buildBatchProjection([{ estimate: 1000 }, { estimate: null }, { estimate: 3000 }])
  assert.strictEqual(result.projected_total, null, 'a bare partial sum (4000) would silently understate the true batch cost')
  assert.strictEqual(result.confidence, 'insufficient')
  assert.strictEqual(result.estimable_count, 2)
  assert.strictEqual(result.unknown_count, 1)
  assert.strictEqual(result.coverage_note, 'estimable 2 of 3, 1 unknown')
})

test('buildBatchProjection: an empty issue list is insufficient/null, not a false-positive full-coverage zero', function () {
  const context = harness.boot()
  const result = context.buildBatchProjection([])
  assert.strictEqual(result.total_issues, 0)
  assert.strictEqual(result.projected_total, null)
  assert.strictEqual(result.confidence, 'insufficient')
})

test('buildBatchProjection: null/undefined input degrades cleanly instead of throwing', function () {
  const context = harness.boot()
  assert.doesNotThrow(function () { context.buildBatchProjection(null) })
  assert.doesNotThrow(function () { context.buildBatchProjection(undefined) })
})

// ---- buildCostEstimate: the public integration entry point the dry_run preview calls ----

test('buildCostEstimate: composes estimateCost + oversized flags + batch_projection into one object', function () {
  const context = harness.boot()
  const history = trustedBand(1, [900, 1000, 1100])
  const result = context.buildCostEstimate(history, [{ issue: 9, pf: 1, member_count: 1 }])
  assert.strictEqual(result.by_issue.length, 1)
  assert.strictEqual(result.by_issue[0].estimate, 1000)
  assert.strictEqual(result.by_issue[0].oversized.any, false)
  assert.strictEqual(result.batch_projection.projected_total, 1000)
  assert.strictEqual(result.batch_projection.confidence, 'estimated')
})

test('buildCostEstimate: a group with pf=[] on every member but member_count over OVERSIZE_GROUP_MEMBERS still flags oversized, even with zero history', function () {
  const context = harness.boot()
  const threshold = harness.readGlobal(context, 'OVERSIZE_GROUP_MEMBERS')
  const members = []
  for (let i = 0; i < threshold; i++) members.push({ issue: 100 + i, pf: 0 })
  const bundle = { issue: 100, pf: 0, member_count: threshold, members: members }
  const result = context.buildCostEstimate([], [bundle])
  assert.strictEqual(result.by_issue[0].estimate, null, 'zero history — estimate itself is honestly null')
  assert.strictEqual(result.by_issue[0].oversized.structural, true, 'the structural arm is history-free and must still fire')
  assert.strictEqual(result.by_issue[0].oversized.any, true)
  // batch_projection must not claim full coverage / a bare total when the
  // one-and-only issue's own estimate is null.
  assert.strictEqual(result.batch_projection.projected_total, null)
  assert.strictEqual(result.batch_projection.confidence, 'insufficient')
})

test('buildCostEstimate: batch_projection carries a coverage indicator across a mix of estimable and unknown issues', function () {
  const context = harness.boot()
  const history = trustedBand(1, [900, 1000, 1100]) // band '1' only
  const result = context.buildCostEstimate(history, [
    { issue: 1, pf: 1, member_count: 1 }, // pf=1 -> band '1' -> estimate 1000
    { issue: 2, pf: 10, member_count: 1 }, // pf=10 -> band '8-15', no history -> null
  ])
  assert.strictEqual(result.batch_projection.estimable_count, 1)
  assert.strictEqual(result.batch_projection.unknown_count, 1)
  assert.strictEqual(result.batch_projection.projected_total, null)
  assert.strictEqual(result.batch_projection.coverage_note, 'estimable 1 of 2, 1 unknown')
})
