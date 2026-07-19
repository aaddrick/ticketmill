'use strict'

// Unit tests for the pure aggregateTokens(results, spent, concurrency) helper
// (workflows/ticketmill.js) — builds per-issue/per-model token subtotals plus a
// finished "## Token Usage" markdown section, all math done in JS. Covers the
// three reconciliation stories the helper distinguishes:
//   - CONCURRENCY === 1: an "orchestration/unattributed" remainder row makes the
//     table sum exactly to the guarded budget.spent() run total (reconciles: true).
//   - CONCURRENCY > 1: the whole breakdown is labelled approximate and does NOT
//     reconcile (reconciles: false) — a shared monotonic counter over-counts
//     overlapping concurrent stages.
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

test('aggregateTokens: concurrency>1 labels the whole breakdown approximate and does not reconcile', function () {
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
  // No remainder row is fabricated under concurrency>1 — there is nothing to reconcile.
  assert.ok(!agg.markdown.includes('orchestration/unattributed'))
  // Per-model and per-issue totals in the table are the raw (over-counted) sums,
  // NOT scaled/reconciled against spent. (Field-by-field, not deepStrictEqual —
  // see the realm-prototype note above.)
  assert.strictEqual(agg.by_model.sonnet, 250)
  assert.strictEqual(Object.keys(agg.by_model).length, 1)
  assert.ok(agg.markdown.includes('**250**')) // Total row reflects sumDeltas, not spent, when not reconciling
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
    assert.strictEqual(Object.keys(row.byModel).length, 0)
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

test('aggregateTokens: empty results array degrades cleanly (no throw, "not tracked" everywhere)', function () {
  const context = harness.boot()
  const agg = context.aggregateTokens([], null, 1)
  assert.strictEqual(agg.tracked, false)
  assert.strictEqual(agg.run_total, null)
  assert.strictEqual(agg.by_issue.length, 0)
  assert.strictEqual(Object.keys(agg.by_model).length, 0)
  assert.ok(agg.markdown.includes('Run total: not tracked'))
})
