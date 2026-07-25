'use strict'

// Unit tests for buildRunRecord()/buildLedgerLine() (workflows/ticketmill.js, issue #86).
//
// The bug these guard against: the old Report phase fed the run's JSON to an agent
// through `resultsJson.slice(0, 30000)`. An 8-issue run already serialized past 24 000
// chars, so an 18-issue run overflowed the slice and every per-issue `metrics` block
// after the cut never reached disk (confirmed on the committed summary-2026-07-19-f.json,
// which carries 18 results and ZERO metrics blocks). buildRunRecord is now a pure
// function above the harness split; the mill skill writes its output verbatim with a
// real fs Write (no agent, no slice). These tests prove it drops nothing at scale.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// A results[] fixture of N completed issues, each carrying a full metrics block.
function fixtureResults(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const issue = 100 + i
    out.push({
      issue: issue,
      title: 'Issue ' + issue,
      status: 'completed',
      pr: 200 + i,
      follow_ups: [],
      stage: 'merge',
      error: null,
      metrics: Object.assign(harness.freshMetrics(), {
        approach_iters: (i % 3) + 1,
        quality_iters: i + 1,
        test_iters: i % 5,
      }),
      tokens: { total: 1000 * (i + 1), byModel: { opus: 500 * (i + 1) }, tracked: true },
      timeline: ['approach: sound', 'merged PR #' + (200 + i)],
      handoff_notes: [],
      members: [issue],
    })
  }
  return out
}

function makeRecord(context, results, over) {
  const o = over || {}
  return context.buildRunRecord(Object.assign({
    runTag: '2026-07-25',
    state: 'completed',
    baseBranch: 'main',
    batchBranch: 'Batch_2026-07-25_000000',
    batchPr: 999,
    stop: { tripped: false, reason: '' },
    counts: { completed: results.length },
    verificationGaps: [],
    tokensSpent: 123456,
    tokenAgg: { run_total: 123456, by_issue: [], by_model: { opus: 100 }, by_stage: null, attributed: 123456, reconcile_error: 0, tracked: true, reconciles: true },
    mergeAgg: { resolved_count: 0, resolved_issues: [], thrash_count: 0, thrash_issues: [] },
    consolidationGroups: [],
    results: results,
  }, o))
}

// ---- the core regression: no per-issue field loss at 18-issue+ scale ----

test('buildRunRecord retains every issue and its full metrics block at 18-issue scale', function () {
  const context = harness.boot()
  const results = fixtureResults(18)
  const record = makeRecord(context, results)

  assert.strictEqual(record.results.length, 18)
  const metricKeys = Object.keys(harness.freshMetrics())
  for (const r of record.results) {
    assert.ok(r.metrics, 'issue ' + r.issue + ' lost its metrics block')
    for (const k of metricKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(r.metrics, k), 'issue ' + r.issue + ' missing metrics.' + k)
    }
  }
})

test('buildRunRecord scales cleanly past the old 30000-char slice with no truncation', function () {
  const context = harness.boot()
  const results = fixtureResults(100)
  const record = makeRecord(context, results)
  const serialized = JSON.stringify(record, null, 2)

  // The very payload size that used to defeat the slice.
  assert.ok(serialized.length > 30000, 'fixture too small to exercise the truncation regression')
  // Every issue survives the round-trip (host-realm compare — never touches a
  // vm-constructed prototype).
  const round = JSON.parse(serialized)
  assert.strictEqual(round.results.length, 100)
  assert.strictEqual(round.results[99].issue, 199)
  assert.ok(round.results[99].metrics, 'last issue lost its metrics block after truncation')
  assert.strictEqual(round.results[99].metrics.quality_iters, 100)
})

// ---- shape / header fields ----

test('buildRunRecord carries the schema header and threads token honesty fields', function () {
  const context = harness.boot()
  const record = makeRecord(context, fixtureResults(2))
  assert.strictEqual(record.schema_version, 2)
  assert.strictEqual(record.run_tag, '2026-07-25')
  assert.strictEqual(record.state, 'completed')
  assert.strictEqual(record.base_branch, 'main')
  assert.strictEqual(record.batch_pr, 999)
  // issue #90 honesty fields flow through into the record's tokens block.
  assert.strictEqual(record.tokens.attributed, 123456)
  assert.strictEqual(record.tokens.reconcile_error, 0)
  assert.strictEqual(record.tokens.reconciles, true)
})

// ---- issue #97 task 1: by_issue_shape + effective_concurrency ----
//
// The proactive cost-estimator's ONLY history input is this pair of fields
// (joined here, in buildRunRecord/buildLedgerLine — not re-derived downstream).
// buildIssueShapeRows joins `results` against `units` (predicted_files lives on
// the unit, never the result) and tokenAgg.by_issue (per-result token totals),
// by issue number rather than array position, so these tests fixture `units` and
// `tokenAgg.by_issue` deliberately out of result order to prove the join is real.

test('buildRunRecord threads effective_concurrency verbatim from the caller', function () {
  const context = harness.boot()
  const record = makeRecord(context, fixtureResults(1), { effectiveConcurrency: 1 })
  assert.strictEqual(record.effective_concurrency, 1)
})

test('buildRunRecord defaults effective_concurrency to null when the caller omits it (never a false 0/undefined)', function () {
  const context = harness.boot()
  const record = makeRecord(context, fixtureResults(1))
  assert.strictEqual(record.effective_concurrency, null)
})

test('buildRunRecord: by_issue_shape joins pf off units and tokens off tokenAgg.by_issue, by issue number (not array position)', function () {
  const context = harness.boot()
  const results = fixtureResults(2) // issues 100, 101
  const units = [
    { issue: 101, predicted_files: ['a.js', 'b.js', 'c.js'] }, // deliberately out of order
    { issue: 100, predicted_files: ['x.js'] },
  ]
  const record = makeRecord(context, results, {
    units: units,
    tokenAgg: {
      run_total: 3000, by_model: {}, by_stage: null, attributed: 3000,
      reconcile_error: 0, tracked: true, reconciles: true,
      by_issue: [
        { issue: 101, total: 2000, by_model: {}, tracked: true }, // also out of order
        { issue: 100, total: 1000, by_model: {}, tracked: true },
      ],
    },
  })

  assert.strictEqual(record.by_issue_shape.length, 2)
  const row100 = record.by_issue_shape.find(function (r) { return r.issue === 100 })
  const row101 = record.by_issue_shape.find(function (r) { return r.issue === 101 })
  assert.ok(row100, 'issue 100 missing from by_issue_shape')
  assert.ok(row101, 'issue 101 missing from by_issue_shape')
  assert.strictEqual(row100.pf, 1)
  assert.strictEqual(row100.tokens, 1000)
  assert.strictEqual(row100.tracked, true)
  assert.strictEqual(row100.member_count, 1)
  assert.strictEqual(row101.pf, 3)
  assert.strictEqual(row101.tokens, 2000)
  assert.strictEqual(row101.member_count, 1)
})

test('buildRunRecord: a group-unit row carries member_count>1, the UNION predicted_files count, and the WHOLE-GROUP token total — never a per-member split', function () {
  const context = harness.boot()
  const results = fixtureResults(1) // single result, issue 100 — the group's primary
  results[0].members = [100, 105, 110] // memberIssues(ctx) shape: a flat array of issue numbers, primary included
  const units = [
    // deriveUnits() already unions predicted_files across every live member before
    // the unit reaches the pool — this fixture mirrors that pre-unioned shape.
    { issue: 100, predicted_files: ['shared/a.js', 'shared/b.js', 'shared/c.js', 'shared/d.js'] },
  ]
  const record = makeRecord(context, results, {
    units: units,
    tokenAgg: {
      run_total: 9000, by_model: {}, by_stage: null, attributed: 9000,
      reconcile_error: 0, tracked: true, reconciles: true,
      // aggregateTokens emits ONE row per result — for a group unit this total IS
      // the whole group's spend, not the primary's alone.
      by_issue: [{ issue: 100, total: 9000, by_model: {}, tracked: true }],
    },
  })

  assert.strictEqual(record.by_issue_shape.length, 1)
  const row = record.by_issue_shape[0]
  assert.strictEqual(row.issue, 100)
  assert.strictEqual(row.member_count, 3, 'group-unit row must flag member_count>1 so estimateCost never files it as a singleton')
  assert.strictEqual(row.pf, 4, 'pf must be the union predicted_files count, not re-derived per member')
  assert.strictEqual(row.tokens, 9000, 'tokens must be the whole-group total, not split across members')
})

test('buildRunRecord: by_issue_shape degrades cleanly when units/tokenAgg.by_issue are missing (pf 0, tokens null, tracked false, member_count from result.members)', function () {
  const context = harness.boot()
  const results = fixtureResults(1)
  delete results[0].tokens // no tokens field at all on the result itself either
  const record = makeRecord(context, results, {
    tokenAgg: { run_total: null, by_model: {}, by_stage: null, attributed: 0, reconcile_error: null, tracked: false, reconciles: false, by_issue: [] },
  })
  const row = record.by_issue_shape[0]
  assert.strictEqual(row.pf, 0)
  assert.strictEqual(row.tokens, null)
  assert.strictEqual(row.tracked, false)
  assert.strictEqual(row.member_count, 1)
})

// ---- the compact ledger line ----

test('buildLedgerLine is a compact single-line index carrying the trend fields', function () {
  const context = harness.boot()
  const record = makeRecord(context, fixtureResults(3), {
    verificationGaps: ['tests skipped for #101'],
    effectiveConcurrency: 2,
    tokenAgg: { run_total: 42, by_issue: [], by_model: { opus: 42 }, by_stage: null, attributed: 30, reconcile_error: 0.2857, tracked: true, reconciles: false },
  })
  const line = context.buildLedgerLine(record)

  assert.strictEqual(line.run_tag, '2026-07-25')
  assert.strictEqual(line.issues, 3)
  assert.strictEqual(line.tokens_total, 42)
  assert.strictEqual(line.reconciles, false)
  assert.strictEqual(line.reconcile_error, 0.2857)
  assert.strictEqual(line.verification_gaps, 1)
  assert.strictEqual(line.stop_tripped, false)
  assert.strictEqual(line.effective_concurrency, 2)
  // "compact single line" is a hard contract — runs.jsonl is one object per line.
  assert.strictEqual(JSON.stringify(line).indexOf('\n'), -1)
})

// ---- issue #97 task 1: by_issue_shape / effective_concurrency on the ledger line ----
//
// estimateCost() (task 2) reduces over runs.jsonl (the ledger), not the full
// per-run record file, so both fields must survive the record->ledger-line
// compaction verbatim — including a group-unit row (member_count>1).

test('buildLedgerLine carries by_issue_shape verbatim, including a group-unit row (member_count>1, union pf, whole-group tokens)', function () {
  const context = harness.boot()
  const results = fixtureResults(1)
  results[0].members = [100, 105] // a 2-member group, primary issue 100
  const units = [{ issue: 100, predicted_files: ['a.js', 'b.js'] }]
  const record = makeRecord(context, results, {
    effectiveConcurrency: 1,
    units: units,
    tokenAgg: {
      run_total: 5000, by_model: {}, by_stage: null, attributed: 5000,
      reconcile_error: 0, tracked: true, reconciles: true,
      by_issue: [{ issue: 100, total: 5000, by_model: {}, tracked: true }],
    },
  })
  const line = context.buildLedgerLine(record)

  assert.strictEqual(line.effective_concurrency, 1)
  assert.strictEqual(line.by_issue_shape.length, 1)
  const row = line.by_issue_shape[0]
  assert.strictEqual(row.issue, 100)
  assert.strictEqual(row.member_count, 2)
  assert.strictEqual(row.pf, 2)
  assert.strictEqual(row.tokens, 5000)
  assert.strictEqual(row.tracked, true)
})

test('buildLedgerLine defaults by_issue_shape to [] and effective_concurrency to null when the record omits them', function () {
  const context = harness.boot()
  const line = context.buildLedgerLine({})
  // Array.isArray + length check, not deepStrictEqual([]) — the vm-constructed
  // array is a different-realm Array (same shape, not reference-equal to a host
  // Array), which deepStrictEqual treats as unequal (see harness.js's own
  // "host-realm compare" note on the scale test above).
  assert.ok(Array.isArray(line.by_issue_shape))
  assert.strictEqual(line.by_issue_shape.length, 0)
  assert.strictEqual(line.effective_concurrency, null)
})

test('buildLedgerLine reports stop_tripped and gap counts from a circuit-broken run', function () {
  const context = harness.boot()
  const record = makeRecord(context, fixtureResults(1), {
    state: 'circuit_breaker',
    stop: { tripped: true, reason: 'circuit breaker: 3 issues failed' },
    verificationGaps: ['a', 'b'],
  })
  const line = context.buildLedgerLine(record)
  assert.strictEqual(line.stop_tripped, true)
  assert.strictEqual(line.state, 'circuit_breaker')
  assert.strictEqual(line.verification_gaps, 2)
})

// ---- friction_churn pass-through (issue #89) ----
//
// Every fixture above omits frictionChurnAgg entirely, so buildRunRecord's
// `friction_churn` field was only ever exercised via its {} default — a
// gap flagged in the Test Validation (iteration 1) verdict on issue #89.
// These tests feed buildRunRecord a REAL composeFrictionChurn(...) output
// (built from a results fixture that actually has friction/churn signal, the
// same shape workflows/ticketmill.js:5301/5470 constructs in production) and
// assert the machine-readable sub-fields survive verbatim.

test('buildRunRecord threads a real frictionChurnAgg through to friction_churn verbatim', function () {
  const context = harness.boot()
  const results = fixtureResults(2)
  // Give the fixture real friction/churn signal: issue 100 saturates quality
  // iters, both issues touch the same file (cross-issue hotspot).
  results[0].metrics.quality_iters = 999
  results[0].changed_files = ['shared/util.js']
  results[0].touch_counts = {}
  results[1].changed_files = ['shared/util.js']
  results[1].touch_counts = {}

  const frictionChurnAgg = context.composeFrictionChurn(results, { serializeGlobs: [], engineOwned: [] })
  assert.ok(frictionChurnAgg.has_signal, 'fixture must actually carry friction/churn signal to exercise the pass-through')

  const record = makeRecord(context, results, { frictionChurnAgg: frictionChurnAgg })

  assert.strictEqual(record.friction_churn.has_signal, true)
  assert.strictEqual(record.friction_churn.friction.has_signal, true)
  assert.strictEqual(record.friction_churn.friction.by_issue.length, frictionChurnAgg.friction.by_issue.length)
  assert.strictEqual(record.friction_churn.friction.top_issues.length, frictionChurnAgg.friction.top_issues.length)
  assert.strictEqual(record.friction_churn.friction.top_issues[0].issue, frictionChurnAgg.friction.top_issues[0].issue)
  assert.strictEqual(record.friction_churn.churn.has_signal, true)
  assert.strictEqual(record.friction_churn.churn.hotspots.length, 1)
  assert.strictEqual(record.friction_churn.churn.hotspots[0].file, 'shared/util.js')
  assert.strictEqual(record.friction_churn.churn.hotspots[0].count, 2)
  assert.ok(record.friction_churn.churn.buckets, 'buckets object must pass through, not be dropped')
  assert.strictEqual(record.friction_churn.churn.buckets.surprising.hotspots.length, 1)
  // No markdown leaks into the machine record — it's a separate field on the composer.
  assert.strictEqual(record.friction_churn.markdown, undefined)
})

test('buildRunRecord defaults friction_churn to a clean, signal-free shape when frictionChurnAgg is omitted', function () {
  const context = harness.boot()
  const record = makeRecord(context, fixtureResults(1))

  assert.strictEqual(record.friction_churn.has_signal, false)
  assert.strictEqual(record.friction_churn.friction.has_signal, false)
  assert.strictEqual(record.friction_churn.churn.has_signal, false)
  assert.strictEqual(record.friction_churn.friction.by_issue, undefined)
  assert.strictEqual(record.friction_churn.churn.hotspots, undefined)
})
