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

// ---- issue #165: the quality stage's denominator is POOLED across
// runQualityLoop invocations (cap * quality_scopes) instead of comparing the
// run-wide quality_iters aggregate against a single loop's cap. MAX_QUALITY_
// ITERATIONS === 5 throughout this block (see workflows/ticketmill.js). ----

test('computeFriction: a multi-scope issue where every quality loop exhausted its cap (quality_iters 15, quality_scopes 3) saturates to exactly 1.0', function () {
  const context = harness.boot()
  const results = [
    { issue: 30, metrics: { quality_iters: 15, quality_scopes: 3 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const f = context.computeFriction(results)
  const row = f.by_issue.find(function (r) { return r.issue === 30 })
  const d = row.drivers.find(function (x) { return x.name === 'quality' })

  assert.strictEqual(d.cap, 15) // MAX_QUALITY_ITERATIONS (5) * quality_scopes (3)
  assert.strictEqual(d.contribution, 1)
})

test("computeFriction: the issue's dilution case — three tasks that each cleared quality on iteration 2 (quality_iters 6, quality_scopes 3) scores 0.4, not the pre-fix saturation to 1.0", function () {
  const context = harness.boot()
  const results = [
    { issue: 31, metrics: { quality_iters: 6, quality_scopes: 3 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const f = context.computeFriction(results)
  const row = f.by_issue.find(function (r) { return r.issue === 31 })
  const d = row.drivers.find(function (x) { return x.name === 'quality' })

  // Pre-fix this would have been min(1, 6/5) === 1 (saturated). Pooled: 6/15 === 0.4.
  assert.strictEqual(d.cap, 15)
  assert.ok(Math.abs(d.contribution - 0.4) < 1e-9)
})

test('computeFriction: a multi-scope issue where every quality loop passed on iteration 1 (quality_iters 3, quality_scopes 3) scores 0.2 — the consistent answer, not the acceptance criterion\'s unsatisfiable literal "0"', function () {
  // The issue's acceptance criteria say a multi-task issue whose every quality
  // loop passed on the first iteration "scores 0". That literal is unmet by
  // BOTH formulas the issue sanctions: pooled gives 3/(5*3) === 0.2, and the
  // acceptable alternative (worst single scope's iteration count ratioed
  // against the cap directly) gives max(1,1,1)/5 === 0.2 too — every scope here
  // ran exactly one iteration, so the worst scope is any one of them. Both
  // formulas agree on 0.2, not 0, because every capped stage in computeFriction
  // (including the six sibling stages — approach/plan/task-review/test/browser/
  // pr-review) costs iters/cap > 0 for a first-try pass, never exactly 0 (see
  // the module header comment corrected in this issue's first commit). 0.2 is
  // therefore the consistent, correct answer to what the criterion was after,
  // not the impossible literal "0".
  const context = harness.boot()
  const results = [
    { issue: 32, metrics: { quality_iters: 3, quality_scopes: 3 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const f = context.computeFriction(results)
  const row = f.by_issue.find(function (r) { return r.issue === 32 })
  const d = row.drivers.find(function (x) { return x.name === 'quality' })

  assert.strictEqual(d.cap, 15)
  assert.ok(Math.abs(d.contribution - 0.2) < 1e-9)
})

test('computeFriction: a single quality scope scores exactly what it scored before this change (5/5 -> 1.0, 2/5 -> 0.4)', function () {
  const context = harness.boot()
  const results = [
    { issue: 33, metrics: { quality_iters: 5, quality_scopes: 1 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
    { issue: 34, metrics: { quality_iters: 2, quality_scopes: 1 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const f = context.computeFriction(results)
  const row33 = f.by_issue.find(function (r) { return r.issue === 33 })
  const row34 = f.by_issue.find(function (r) { return r.issue === 34 })
  const d33 = row33.drivers.find(function (x) { return x.name === 'quality' })
  const d34 = row34.drivers.find(function (x) { return x.name === 'quality' })

  assert.strictEqual(d33.cap, 5)
  assert.strictEqual(d33.contribution, 1)
  assert.strictEqual(d34.cap, 5)
  assert.ok(Math.abs(d34.contribution - 0.4) < 1e-9)
})

test('computeFriction: a metrics blob carrying no quality_scopes key at all (pre-this-change data) scores as if quality_scopes were 1, unchanged from before', function () {
  const context = harness.boot()
  const results = [
    { issue: 35, metrics: { quality_iters: 5 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const f = context.computeFriction(results)
  const row = f.by_issue.find(function (r) { return r.issue === 35 })
  const d = row.drivers.find(function (x) { return x.name === 'quality' })

  assert.strictEqual(d.scopes, 1)
  assert.strictEqual(d.cap, 5)
  assert.strictEqual(d.contribution, 1)
})

test('computeFriction: non-monotonicity is a deliberate trade — appending a first-try (clean) scope LOWERS the ratio, 5/5 = 1.0 down to 6/10 = 0.6', function () {
  // Pooling means the denominator grows with every new scope, including a
  // scope that added zero friction of its own. An issue that capped out on
  // its only quality loop (5/5 = 1.0) looks WORSE than the same issue after a
  // second task's quality loop passes cleanly on iteration 1 (6/10 = 0.6),
  // even though nothing about the first loop's outcome changed. This is the
  // accepted cost of a pooled denominator (vs. worst-single-scope, which would
  // stay pinned at 1.0 forever once any one scope capped out) and is asserted
  // here as intentional, not a regression to fix later.
  const context = harness.boot()

  const before = context.computeFriction([
    { issue: 36, metrics: { quality_iters: 5, quality_scopes: 1 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ])
  const beforeD = before.by_issue[0].drivers.find(function (x) { return x.name === 'quality' })
  assert.strictEqual(beforeD.contribution, 1)

  const after = context.computeFriction([
    { issue: 36, metrics: { quality_iters: 6, quality_scopes: 2 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ])
  const afterD = after.by_issue[0].drivers.find(function (x) { return x.name === 'quality' })
  assert.ok(Math.abs(afterD.contribution - 0.6) < 1e-9)

  assert.ok(afterD.contribution < beforeD.contribution, 'appending a first-try scope must lower the ratio, not raise or hold it')
})

test('computeFriction: a deliberately saturating fixture (quality_iters 12, quality_scopes 1) clamps contribution to 1 even though value/cap === 2.4', function () {
  const context = harness.boot()
  const results = [
    { issue: 37, metrics: { quality_iters: 12, quality_scopes: 1 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const f = context.computeFriction(results)
  const row = f.by_issue.find(function (r) { return r.issue === 37 })
  const d = row.drivers.find(function (x) { return x.name === 'quality' })

  assert.strictEqual(d.cap, 5)
  assert.strictEqual(d.value / d.cap, 2.4) // the raw ratio, unclamped
  assert.strictEqual(d.contribution, 1) // Math.min(1, ...) clamps it
})

test('computeFriction: scopes stays null (not a number) for single-scope stages — asserted on a task-review driver and a browser driver', function () {
  const context = harness.boot()
  const results = [
    { issue: 38, metrics: { task_review_attempts: 2, browser_iters: 1 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const f = context.computeFriction(results)
  const row = f.by_issue.find(function (r) { return r.issue === 38 })
  const taskReviewD = row.drivers.find(function (x) { return x.name === 'task-review' })
  const browserD = row.drivers.find(function (x) { return x.name === 'browser' })

  assert.ok(taskReviewD, 'expected a task-review driver to be present')
  assert.ok(browserD, 'expected a browser driver to be present')
  assert.strictEqual(taskReviewD.scopes, null)
  assert.strictEqual(browserD.scopes, null)
})

test('computeFriction: driver invariants hold across every stage and signal driver — stage drivers satisfy contribution === Math.min(1, value/cap) and cap === baseCap * (scopes ?? 1); signal drivers satisfy value * weight === contribution and carry neither `cap` nor `scopes`', function () {
  const context = harness.boot()
  const baseCaps = {
    approach: harness.readGlobal(context, 'MAX_CONTRARIAN_ITERATIONS'),
    plan: harness.readGlobal(context, 'MAX_CONTRARIAN_ITERATIONS'),
    'task-review': harness.readGlobal(context, 'MAX_TASK_REVIEW_ATTEMPTS'),
    quality: harness.readGlobal(context, 'MAX_QUALITY_ITERATIONS'),
    test: harness.readGlobal(context, 'MAX_TEST_ITERATIONS'),
    browser: harness.readGlobal(context, 'MAX_BROWSER_ITERATIONS'),
    'pr-review': harness.readGlobal(context, 'MAX_PR_REVIEW_ITERATIONS'),
  }
  const results = [
    {
      issue: 39,
      metrics: {
        approach_iters: 2, plan_iters: 1, task_review_attempts: 2,
        quality_iters: 6, quality_scopes: 2,
        test_iters: 4, browser_iters: 1, pr_review_iters: 2,
        quality_degrades: 1,
      },
      needs_human: true,
      contrarian_capped: true,
      unresolved_count: 3,
      test_quality_fix_rounds: 2,
    },
  ]

  const f = context.computeFriction(results)
  const row = f.by_issue.find(function (r) { return r.issue === 39 })
  assert.ok(row.drivers.length >= 8, 'expected both stage and signal drivers in this fixture')

  const stageNames = Object.keys(baseCaps)
  for (const d of row.drivers) {
    if (stageNames.indexOf(d.name) !== -1) {
      assert.strictEqual(d.weight, null, 'stage driver ' + d.name + ' must carry weight: null')
      assert.strictEqual(d.contribution, Math.min(1, d.value / d.cap), 'stage driver ' + d.name + ' violated contribution === Math.min(1, value/cap)')
      assert.strictEqual(d.cap, baseCaps[d.name] * (d.scopes === null ? 1 : d.scopes), 'stage driver ' + d.name + ' violated cap === baseCap * (scopes ?? 1)')
    } else {
      assert.ok(!('cap' in d), 'signal driver ' + d.name + ' must not carry a cap key')
      assert.ok(!('scopes' in d), 'signal driver ' + d.name + ' must not carry a scopes key')
      assert.strictEqual(d.value * d.weight, d.contribution, 'signal driver ' + d.name + ' violated value * weight === contribution')
    }
  }
})
