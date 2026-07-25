'use strict'

// Unit tests for the pure computeFriction(results) helper (workflows/
// ticketmill.js, issue #89) — the per-issue/per-stage friction rollup injected
// (via composeFrictionChurn) into the batch-PR body and report agent. Modeled
// on tests/token-usage.test.js and tests/merge-auto-resolve-aggregate.test.js's
// "load via harness.boot(), call the pure function directly, assert both the
// machine-readable fields and the rendered markdown" shape.
//
// Covers:
//   - ranked top_issues/top_stages ordering (descending by score/total).
//   - cap-normalization: iters far past a cap never inflate a ratio past 1.
//   - a synthetic driver breakdown, sorted by contribution descending.
//   - has_signal true-with-signal and false-clean-omission (empty markdown line).
//   - __seed-overridden MAX_CONTRARIAN_ITERATIONS changes the approach/plan ratio.
//   - defensive null/empty results and results missing `.metrics` entirely.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('computeFriction: ranks top_issues by descending score and top_stages by descending summed ratio', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 1,
      metrics: { quality_iters: 5, quality_degrades: 0, merge_thrash: 0 }, // MAX_QUALITY_ITERATIONS === 5 -> ratio 1
      needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0,
    },
    {
      issue: 2,
      metrics: { browser_iters: 3, merge_thrash: 1 }, // MAX_BROWSER_ITERATIONS === 3 -> ratio 1, plus a thrash event
      needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0,
    },
    {
      issue: 3,
      metrics: {},
      needs_human: true, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0,
    },
  ]

  const f = context.computeFriction(results)

  // issue 2: 1 (browser ratio) + 1.5 (merge_thrash weight) = 2.5
  // issue 3: 2 (needs_human weight)
  // issue 1: 1 (quality ratio)
  assert.strictEqual(f.top_issues.length, 3)
  assert.strictEqual(f.top_issues[0].issue, 2)
  assert.ok(Math.abs(f.top_issues[0].score - 2.5) < 1e-9)
  assert.strictEqual(f.top_issues[1].issue, 3)
  assert.ok(Math.abs(f.top_issues[1].score - 2) < 1e-9)
  assert.strictEqual(f.top_issues[2].issue, 1)
  assert.ok(Math.abs(f.top_issues[2].score - 1) < 1e-9)

  // Ranking is non-increasing.
  for (let i = 1; i < f.top_issues.length; i++) {
    assert.ok(f.top_issues[i - 1].score >= f.top_issues[i].score)
  }
  for (let i = 1; i < f.top_stages.length; i++) {
    assert.ok(f.top_stages[i - 1].total >= f.top_stages[i].total)
  }

  // issue 2's top driver is the higher-weighted merge_thrash signal, not the
  // stage ratio (both are 1 raw-ratio-equivalent, but merge_thrash's weight
  // is 1.5 vs. the stage ratio's implicit weight of 1).
  const issue2Row = f.by_issue.find(function (r) { return r.issue === 2 })
  assert.strictEqual(issue2Row.drivers[0].name, 'merge_thrash')

  assert.ok(f.has_signal)
  assert.ok(f.markdown.includes('### Friction'))
  assert.ok(f.markdown.includes('Bumpiest issues this run'))
  assert.ok(f.markdown.includes('#2'))
})

test('computeFriction: caps normalize iters far past the cap to a ratio of exactly 1, never inflating the score', function () {
  const context = harness.boot()
  const results = [
    { issue: 9, metrics: { approach_iters: 100 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const f = context.computeFriction(results)
  const row = f.by_issue.find(function (r) { return r.issue === 9 })

  assert.strictEqual(row.score, 1) // min(1, 100/3), not 100/3 === 33.33
  assert.strictEqual(row.drivers.length, 1)
  assert.strictEqual(row.drivers[0].name, 'approach')
  assert.strictEqual(row.drivers[0].contribution, 1)
})

test('computeFriction: per-issue driver breakdown sums signal terms and sorts by contribution descending', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 4,
      metrics: { quality_degrades: 2 }, // weight 0.5 * 2 = 1
      needs_human: true, // weight 2
      contrarian_capped: true, // weight 1
      unresolved_count: 3, // weight 0.25 * 3 = 0.75
      test_quality_fix_rounds: 0,
    },
  ]

  const f = context.computeFriction(results)
  const row = f.by_issue.find(function (r) { return r.issue === 4 })

  // score = 2 (needs_human) + 1 (contrarian_capped) + 0.75 (unresolved_count) + 1 (quality_degrades) = 4.75
  assert.ok(Math.abs(row.score - 4.75) < 1e-9)
  assert.strictEqual(row.drivers.length, 4)
  assert.strictEqual(row.drivers[0].name, 'needs_human')
  assert.strictEqual(row.drivers[0].contribution, 2)
  // Descending order all the way through.
  for (let i = 1; i < row.drivers.length; i++) {
    assert.ok(row.drivers[i - 1].contribution >= row.drivers[i].contribution)
  }
})

test('computeFriction: has_signal is true with signal and false (clean omission) with none', function () {
  const context = harness.boot()

  const clean = context.computeFriction([
    { issue: 1, metrics: { approach_iters: 0, plan_iters: 0, quality_iters: 0, test_iters: 0, browser_iters: 0, pr_review_iters: 0, task_review_attempts: 0, quality_degrades: 0, merge_thrash: 0 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ])
  assert.strictEqual(clean.has_signal, false)
  assert.strictEqual(clean.top_issues.length, 0)
  assert.strictEqual(clean.top_stages.length, 0)
  assert.ok(clean.markdown.includes('No friction signal this run'))

  const dirty = context.computeFriction([
    { issue: 2, metrics: { merge_thrash: 1 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ])
  assert.strictEqual(dirty.has_signal, true)
  assert.strictEqual(dirty.top_issues.length, 1)
})

test('computeFriction: a __seed()-overridden MAX_CONTRARIAN_ITERATIONS changes the approach/plan ratio, not a stale snapshot', function () {
  const context = harness.boot()
  const results = [
    { issue: 5, metrics: { approach_iters: 1 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  // Default MAX_CONTRARIAN_ITERATIONS === 3 -> ratio 1/3.
  const before = context.computeFriction(results)
  const beforeRow = before.by_issue.find(function (r) { return r.issue === 5 })
  assert.strictEqual(beforeRow.drivers[0].contribution, 1 / 3)

  // Seed the cap down to 1 -> the SAME 1 iteration now fully saturates the cap.
  context.__seed({ MAX_CONTRARIAN_ITERATIONS: 1 })
  const after = context.computeFriction(results)
  const afterRow = after.by_issue.find(function (r) { return r.issue === 5 })
  assert.strictEqual(afterRow.drivers[0].contribution, 1)
})

test('computeFriction: null/empty results degrade cleanly, never throw', function () {
  const context = harness.boot()

  assert.doesNotThrow(function () { context.computeFriction(null) })
  const nullAgg = context.computeFriction(null)
  assert.strictEqual(nullAgg.has_signal, false)
  assert.strictEqual(nullAgg.by_issue.length, 0)
  assert.strictEqual(nullAgg.top_issues.length, 0)
  assert.ok(nullAgg.markdown.includes('No friction signal this run'))

  const emptyAgg = context.computeFriction([])
  assert.strictEqual(emptyAgg.has_signal, false)
  assert.strictEqual(emptyAgg.by_issue.length, 0)
})

test('computeFriction: a result missing `.metrics` entirely (skipped/not_started) contributes zero, never throws', function () {
  const context = harness.boot()
  const results = [
    { issue: 6, status: 'skipped' },
    { issue: 7, status: 'not_started' },
  ]

  assert.doesNotThrow(function () { context.computeFriction(results) })
  const f = context.computeFriction(results)
  assert.strictEqual(f.has_signal, false)
  assert.strictEqual(f.by_issue.length, 2)
  assert.strictEqual(f.by_issue[0].score, 0)
  assert.strictEqual(f.by_issue[0].drivers.length, 0)
})
