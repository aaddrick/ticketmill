'use strict'

// Unit tests for the pure aggregateTokens(results, spent, concurrency, byStage)
// helper (workflows/ticketmill.js) — builds per-issue/per-model/per-stage token
// subtotals plus a finished "## Token Usage" markdown section, all math done in
// JS. Covers the reconciliation stories the helper distinguishes:
//   - CONCURRENCY === 1: reconciles: true when spent + some tracked data exist.
//   - CONCURRENCY > 1: the per-issue rows over-count (a shared monotonic
//     counter can't be split per concurrent call) so reconciles: false, but the
//     "orchestration/unattributed" remainder row still renders whenever
//     budget.spent() is available — labelled approximate rather than omitted.
//   - The 4th `byStage` param (STAGE_TOKENS: preflight/select-phase spend,
//     sampled outside the concurrent per-issue pool) folds into sumDeltas
//     exactly once, renders as its own labeled row(s), and never gets
//     double-counted into the remainder. It defaults to {} so existing 3-arg
//     callers/tests are unaffected, and it alone is enough to flip a run with
//     zero tracked per-issue rows into a rendered ("tracked") breakdown — the
//     resumed-run shape this was built for.
//   - Results missing `.tokens` entirely (skipped/not_started, no ctx ever
//     existed) or carrying `.tokens.tracked === false` degrade to "not tracked"
//     cells, never a false zero.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ---- concurrency === 1: exact reconciliation via the remainder row ----

test('aggregateTokens: concurrency===1 appends an orchestration/unattributed remainder row so the table sums exactly to spent', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { sonnet: 100 }, tracked: true } },
    { issue: 2, tokens: { total: 150, byModel: { sonnet: 100, opus: 50 }, tracked: true } },
  ]
  const spent = 300 // sum of deltas (250) + 50 unattributed orchestration overhead
  const agg = context.aggregateTokens(results, spent, 1)

  assert.strictEqual(agg.run_total, 300)
  assert.strictEqual(agg.tracked, true)
  assert.strictEqual(agg.reconciles, true)

  const sumDeltas = agg.by_issue.reduce(function (acc, row) { return acc + row.total }, 0)
  assert.strictEqual(sumDeltas, 250)
  const remainder = spent - sumDeltas
  assert.strictEqual(remainder, 50)

  // The rendered table must sum EXACTLY to the run total: per-issue subtotals
  // plus the remainder row equal spent.
  assert.strictEqual(sumDeltas + remainder, agg.run_total)

  assert.ok(agg.markdown.includes('Run total (output tokens, via budget.spent()): **300**'))
  assert.ok(agg.markdown.includes('Reconciles exactly to the run total above'))
  assert.ok(agg.markdown.includes('| orchestration/unattributed |'))
  assert.ok(agg.markdown.includes('| 50 |'))
  assert.ok(agg.markdown.includes('**300**')) // Total row's grand total cell
  // Field-by-field, not assert.deepStrictEqual(agg.by_model, {...}): agg.by_model
  // is an object literal built INSIDE the vm context (see harness.js), so it
  // carries that context's Object.prototype — a different realm from this
  // file's own object literals — which fails deepStrictEqual's prototype check
  // even when every property value is identical.
  assert.strictEqual(agg.by_model.sonnet, 200)
  assert.strictEqual(agg.by_model.opus, 50)
  assert.strictEqual(Object.keys(agg.by_model).length, 2)

  // Direct assertions on the tracked by_issue[] rows themselves, not just the
  // aggregate above: the tracked-write path (.claude/workflows/ticketmill.js:1532)
  // populates each row's by_model via Object.assign({}, t.byModel || {}), and
  // until now that field was only checked indirectly through ambiguous markdown
  // substring matches (other rows can share the same numeric cell). Field-by-field
  // here, same vm-realm prototype reasoning as above — never deepStrictEqual.
  assert.strictEqual(agg.by_issue[0].issue, 1)
  assert.strictEqual(agg.by_issue[0].by_model.sonnet, 100)
  assert.strictEqual(Object.keys(agg.by_issue[0].by_model).length, 1)

  assert.strictEqual(agg.by_issue[1].issue, 2)
  assert.strictEqual(agg.by_issue[1].by_model.sonnet, 100)
  assert.strictEqual(agg.by_issue[1].by_model.opus, 50)
  assert.strictEqual(Object.keys(agg.by_issue[1].by_model).length, 2)
})

test('aggregateTokens: concurrency===1 with spent exactly equal to summed deltas still reconciles (zero remainder)', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { sonnet: 100 }, tracked: true } },
  ]
  const agg = context.aggregateTokens(results, 100, 1)

  assert.strictEqual(agg.reconciles, true)
  assert.ok(agg.markdown.includes('| orchestration/unattributed |'))
  // The remainder row's numeric cell is 0, not omitted.
  assert.ok(/\|\s*orchestration\/unattributed\s*\|.*\|\s*0\s*\|/.test(agg.markdown))
})

// ---- concurrency > 1: approximate, non-reconciling breakdown ----

test('aggregateTokens: concurrency>1 labels the whole breakdown approximate, does not reconcile, but still renders the remainder row', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { sonnet: 100 }, tracked: true } },
    { issue: 2, tokens: { total: 150, byModel: { sonnet: 150 }, tracked: true } },
  ]
  const spent = 180 // deliberately less than the summed deltas (250) — overlapping
  // concurrent stages double-counted the same shared counter movement.
  const agg = context.aggregateTokens(results, spent, 3)

  assert.strictEqual(agg.run_total, 180) // budget.spent() stays authoritative regardless
  assert.strictEqual(agg.reconciles, false)
  assert.ok(agg.markdown.includes(
    'approximate - overlapping concurrent stages over-count and do NOT reconcile to the run total.'
  ))
  assert.ok(agg.markdown.includes('single shared monotonic counter cannot be split per concurrent call'))
  assert.ok(agg.markdown.includes('stage rows below are exact even so'))
  // Unlike before, the remainder row DOES render at concurrency>1 (labelled
  // approximate rather than omitted) — clamped to 0 here since the over-counted
  // per-issue sum (250) already exceeds spent (180).
  assert.strictEqual(agg.remainder, 0)
  assert.ok(agg.markdown.includes('| orchestration/unattributed |'))
  assert.ok(/\|\s*orchestration\/unattributed\s*\|\s*\|\s*0\s*\|/.test(agg.markdown))
  // Per-model and per-issue totals in the table are the raw (over-counted) sums,
  // NOT scaled/reconciled against spent. (Field-by-field, not deepStrictEqual —
  // see the realm-prototype note above.)
  assert.strictEqual(agg.by_model.sonnet, 250)
  assert.strictEqual(Object.keys(agg.by_model).length, 1)
  // The Total row's Subtotal cell (last column) now always shows `spent`
  // whenever it's available (hasSpent ? spent : sumDeltas), even though
  // reconciles is false — that's distinct from the sonnet MODEL column's
  // total, which legitimately still shows the raw over-counted 250.
  assert.ok(/\|\s*\*\*Total\*\*\s*\|\s*\*\*250\*\*\s*\|\s*\*\*180\*\*\s*\|/.test(agg.markdown))
})

// ---- byStage: preflight/select-phase orchestration buckets ----

test('aggregateTokens: byStage folds nonzero buckets into sumDeltas and renders one labeled row per bucket, table sums exactly', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { sonnet: 100 }, tracked: true } },
  ]
  const byStage = { preflight: 40, select: 60 }
  const spent = 220 // 100 (issue) + 40 (preflight) + 60 (select) + 20 unattributed
  const agg = context.aggregateTokens(results, spent, 1, byStage)

  assert.strictEqual(agg.reconciles, true)
  assert.deepStrictEqual(Object.assign({}, agg.by_stage), { preflight: 40, select: 60 })
  assert.strictEqual(agg.remainder, 20)

  // The table's per-issue subtotal + stage rows + remainder sum exactly to spent.
  const sumDeltas = agg.by_issue.reduce(function (acc, row) { return acc + (row.total || 0) }, 0) + 40 + 60
  assert.strictEqual(sumDeltas + agg.remainder, agg.run_total)

  assert.ok(agg.markdown.includes('| preflight (orchestration) |'))
  assert.ok(agg.markdown.includes('| select-phase (orchestration) |'))
  // Each stage/remainder row has a blank cell per model column before its total.
  assert.ok(/\|\s*preflight \(orchestration\)\s*\|\s*\|\s*40\s*\|/.test(agg.markdown))
  assert.ok(/\|\s*select-phase \(orchestration\)\s*\|\s*\|\s*60\s*\|/.test(agg.markdown))
  assert.ok(agg.markdown.includes('| orchestration/unattributed |'))
  assert.ok(/\|\s*orchestration\/unattributed\s*\|\s*\|\s*20\s*\|/.test(agg.markdown))
  assert.ok(/\|\s*\*\*Total\*\*\s*\|\s*\*\*100\*\*\s*\|\s*\*\*220\*\*\s*\|/.test(agg.markdown)) // Total row === spent
})

test('aggregateTokens: a zero-valued byStage bucket is kept in by_stage but omitted from the rendered table row', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { sonnet: 100 }, tracked: true } },
  ]
  const agg = context.aggregateTokens(results, 100, 1, { preflight: 0, select: 50 })

  assert.strictEqual(agg.by_stage.preflight, 0)
  assert.strictEqual(agg.by_stage.select, 50)
  assert.ok(!agg.markdown.includes('preflight (orchestration)'))
  assert.ok(agg.markdown.includes('select-phase (orchestration)'))
})

// ---- resumed-run shape: all per-issue rows untracked, stage buckets populated ----

test('aggregateTokens: a resumed run with every per-issue row untracked but populated stage buckets still renders a breakdown', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 0, byModel: {}, tracked: false } },
    { issue: 2, status: 'skipped' },
  ]
  const byStage = { preflight: 3800000, select: 150000 }
  const spent = 4000000 // the reconciles:false resumed-run shape this was built for
  const agg = context.aggregateTokens(results, spent, 1, byStage)

  // anyTracked is false (no per-issue row was tracked) but anyStage makes the
  // breakdown render anyway instead of degrading to "not tracked".
  assert.strictEqual(agg.tracked, true)
  assert.ok(!agg.markdown.includes(
    'Per-issue / per-model breakdown: not tracked (no stage in this run reported a usable token delta).'
  ))
  assert.ok(agg.markdown.includes('| #1 | not tracked |'))
  assert.ok(agg.markdown.includes('| #2 | not tracked |'))
  assert.ok(agg.markdown.includes('| preflight (orchestration) |'))
  assert.ok(agg.markdown.includes('| select-phase (orchestration) |'))
  assert.strictEqual(agg.remainder, 50000) // 4000000 - 3800000 - 150000
  assert.ok(agg.markdown.includes('| orchestration/unattributed |'))
})

// ---- degenerate case: spent available but zero attribution (no per-issue, no stage) ----

test('aggregateTokens: Quality Review (task 1, iteration 1) fix — hasSpent true but trackedAny false still renders the remainder row instead of hiding the full spend behind "not tracked"', function () {
  const context = harness.boot()
  // Exact repro from the review finding: a run that crashed/resumed before any
  // per-issue row OR any STAGE_TOKENS bracket ever sampled a usable delta, but
  // budget.spent() itself is still available and nonzero.
  const results = [
    { issue: 1, status: 'skipped' },
    { issue: 2, status: 'not_started' },
  ]
  const agg = context.aggregateTokens(results, 500000, 1, {})

  assert.strictEqual(agg.tracked, true) // hasSpent alone makes it "tracked"
  assert.strictEqual(agg.remainder, 500000) // the entire spend is unattributed
  assert.strictEqual(agg.run_total, 500000)
  // The full spend must be visible in the markdown, not silently absorbed by
  // the "not tracked" line.
  assert.ok(!agg.markdown.includes(
    'Per-issue / per-model breakdown: not tracked (no stage in this run reported a usable token delta).'
  ))
  assert.ok(agg.markdown.includes('| orchestration/unattributed |'))
  assert.ok(/\|\s*orchestration\/unattributed\s*\|\s*500000\s*\|/.test(agg.markdown))
  assert.ok(/\|\s*\*\*Total\*\*\s*\|\s*\*\*500000\*\*\s*\|/.test(agg.markdown))
})

// ---- 3-arg backward compat ----

test('aggregateTokens: calling with only 3 args (no byStage) behaves exactly as before — empty by_stage, no stage rows', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { sonnet: 100 }, tracked: true } },
  ]
  const agg = context.aggregateTokens(results, 150, 1)

  assert.deepStrictEqual(Object.assign({}, agg.by_stage), {})
  assert.strictEqual(agg.remainder, 50)
  assert.strictEqual(agg.reconciles, true)
  assert.ok(!agg.markdown.includes('(orchestration)'))
  assert.ok(agg.markdown.includes('| orchestration/unattributed |'))
})

// ---- 'not tracked' degrade path ----

test('aggregateTokens: results with no .tokens field at all (skipped/not_started) degrade to "not tracked", never zero', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { sonnet: 100 }, tracked: true } },
    { issue: 2, status: 'skipped' }, // no ctx ever existed for this issue
    { issue: 3, status: 'not_started' },
  ]
  const agg = context.aggregateTokens(results, 100, 1)

  assert.strictEqual(agg.tracked, true) // at least one issue WAS tracked
  const untracked = agg.by_issue.filter(function (row) { return row.issue === 2 || row.issue === 3 })
  assert.strictEqual(untracked.length, 2)
  for (const row of untracked) {
    assert.strictEqual(row.total, null)
    assert.strictEqual(row.tracked, false)
    assert.strictEqual(Object.keys(row.by_model).length, 0)
  }
  assert.ok(agg.markdown.includes('| #2 | not tracked | not tracked |'))
  assert.ok(agg.markdown.includes('| #3 | not tracked | not tracked |'))
})

test('aggregateTokens: a result with tokens.tracked===false (ctx existed but no stage sampled a usable pair) also renders "not tracked"', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { total: 0, byModel: {}, tracked: false } },
  ]
  const agg = context.aggregateTokens(results, null, 1)

  assert.strictEqual(agg.tracked, false)
  assert.strictEqual(agg.run_total, null)
  assert.strictEqual(agg.by_issue[0].total, null)
  assert.strictEqual(agg.by_issue[0].tracked, false)
  assert.ok(agg.markdown.includes('Run total: not tracked (budget.spent() unavailable this run)'))
  assert.ok(agg.markdown.includes(
    'Per-issue / per-model breakdown: not tracked (no stage in this run reported a usable token delta).'
  ))
})

test('aggregateTokens: run_total agrees with the markdown\'s "not tracked" line even when stage deltas WERE tracked but budget.spent() was not', function () {
  const context = harness.boot()
  // Quality Review (task 3, iteration 1) regression: budget.spent() unavailable
  // (hasSpent=false) but a stage delta was still tracked (anyTracked=true). Before
  // the fix, run_total silently fell back to sumDeltas (a real number) while the
  // markdown unconditionally said "not tracked" for this same case — a
  // machine-readable-vs-prose mismatch. run_total must now be null, matching prose.
  const results = [
    { issue: 1, tokens: { total: 100, byModel: { sonnet: 100 }, tracked: true } },
  ]
  const agg = context.aggregateTokens(results, null, 1)

  assert.strictEqual(agg.run_total, null)
  assert.ok(agg.markdown.includes('Run total: not tracked (budget.spent() unavailable this run)'))
})

test('aggregateTokens: empty results array degrades cleanly (no throw, "not tracked" everywhere)', function () {
  const context = harness.boot()
  const agg = context.aggregateTokens([], null, 1)
  assert.strictEqual(agg.tracked, false)
  assert.strictEqual(agg.run_total, null)
  assert.strictEqual(agg.by_issue.length, 0)
  assert.strictEqual(Object.keys(agg.by_model).length, 0)
  assert.ok(agg.markdown.includes('Run total: not tracked'))
})
