'use strict'

// Unit tests for computeCompleteness(results, tokenAgg) (issue #87 task 5) — the
// pure trust flag that answers, for a whole run's results array: did every
// issue's `metrics` block land, was `changed_files` captured for every issue
// that actually merged, and did the run's own token accounting reconcile
// (aggregateTokens' reconcile_error kept under MAX_RECONCILE_ERROR_FOR_TRUST)?
// Also covers its wiring into buildRunRecord()/buildLedgerLine() (issue #86's
// pure record builders), which now carry the flag as `completeness`/`trustworthy`.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

function reconciled(err) { return { reconcile_error: err, run_total: 100, by_model: {}, reconciles: true } }

test('computeCompleteness: an all-clear run (every result has metrics + changed_files, tokens reconcile) is trustworthy', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, status: 'completed', metrics: {}, changed_files: ['a.js'] },
    { issue: 2, status: 'completed', metrics: {}, changed_files: [] },
    { issue: 3, status: 'needs_human', metrics: {}, changed_files: null }, // not completed -> changed_files exempt
  ]
  const c = context.computeCompleteness(results, reconciled(0))

  assert.strictEqual(c.total_results, 3)
  assert.strictEqual(c.metrics_missing, 0)
  assert.strictEqual(c.completed_count, 2)
  assert.strictEqual(c.changed_files_missing, 0)
  assert.strictEqual(c.tokens_reconciled, true)
  assert.strictEqual(c.trustworthy, true)
})

test('computeCompleteness: flags a fixture with a missing metrics block', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, status: 'completed', metrics: {}, changed_files: [] },
    { issue: 2, status: 'failed', metrics: null, changed_files: null }, // metrics never landed
  ]
  const c = context.computeCompleteness(results, reconciled(0))

  assert.strictEqual(c.metrics_missing, 1)
  assert.strictEqual(c.trustworthy, false)
})

test('computeCompleteness: flags a completed issue whose changed_files was never captured', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, status: 'completed', metrics: {}, changed_files: null },
  ]
  const c = context.computeCompleteness(results, reconciled(0))

  assert.strictEqual(c.completed_count, 1)
  assert.strictEqual(c.changed_files_missing, 1)
  assert.strictEqual(c.trustworthy, false)
})

test('computeCompleteness: a skipped/needs_human result never counts against changed_files_missing (only completed issues probe it)', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, status: 'skipped', metrics: {}, changed_files: null },
    { issue: 2, status: 'needs_human', metrics: {}, changed_files: null },
  ]
  const c = context.computeCompleteness(results, reconciled(0))

  assert.strictEqual(c.completed_count, 0)
  assert.strictEqual(c.changed_files_missing, 0)
  assert.strictEqual(c.trustworthy, true)
})

test('computeCompleteness: a large reconcile_error (above MAX_RECONCILE_ERROR_FOR_TRUST) flips tokens_reconciled/trustworthy false even with clean per-issue data', function () {
  const context = harness.boot()
  const results = [{ issue: 1, status: 'completed', metrics: {}, changed_files: [] }]
  const threshold = harness.readGlobal(context, 'MAX_RECONCILE_ERROR_FOR_TRUST')
  assert.strictEqual(typeof threshold, 'number') // guards against the constant silently vanishing/renaming

  const clean = context.computeCompleteness(results, reconciled(threshold))
  assert.strictEqual(clean.tokens_reconciled, true)
  assert.strictEqual(clean.trustworthy, true)

  const bad = context.computeCompleteness(results, reconciled(threshold + 0.01))
  assert.strictEqual(bad.tokens_reconciled, false)
  assert.strictEqual(bad.trustworthy, false)
})

test('computeCompleteness: a null/unavailable reconcile_error (budget.spent() unavailable) is NOT trusted by default', function () {
  const context = harness.boot()
  const results = [{ issue: 1, status: 'completed', metrics: {}, changed_files: [] }]
  const c = context.computeCompleteness(results, { reconcile_error: null })

  assert.strictEqual(c.reconcile_error, null)
  assert.strictEqual(c.tokens_reconciled, false)
  assert.strictEqual(c.trustworthy, false)
})

test('computeCompleteness: defensive against missing/empty inputs — never throws, empty results is trustworthy iff tokens reconcile', function () {
  const context = harness.boot()

  assert.doesNotThrow(function () { context.computeCompleteness(null, null) })
  assert.doesNotThrow(function () { context.computeCompleteness(undefined, undefined) })

  const empty = context.computeCompleteness([], reconciled(0))
  assert.strictEqual(empty.total_results, 0)
  assert.strictEqual(empty.trustworthy, true)
})

// ---- wiring into buildRunRecord() / buildLedgerLine() ----

test('buildRunRecord: carries completeness computed from its own results/tokenAgg', function () {
  const context = harness.boot()
  const results = [{ issue: 1, status: 'completed', metrics: {}, changed_files: null }]
  const record = context.buildRunRecord({
    runTag: 'run', state: 'completed', results: results,
    tokenAgg: reconciled(0), mergeAgg: {}, stop: { tripped: false }, counts: {},
    verificationGaps: [], tokensSpent: 100, consolidationGroups: [],
  })

  assert.strictEqual(record.completeness.changed_files_missing, 1)
  assert.strictEqual(record.completeness.trustworthy, false)
})

test('buildLedgerLine: mirrors record.completeness.trustworthy as a flat `trustworthy` field', function () {
  const context = harness.boot()
  const trustedRecord = { results: [{ issue: 1, status: 'completed', metrics: {}, changed_files: [] }], tokens: reconciled(0), completeness: { trustworthy: true } }
  const untrustedRecord = { results: [], tokens: reconciled(0), completeness: { trustworthy: false } }

  assert.strictEqual(context.buildLedgerLine(trustedRecord).trustworthy, true)
  assert.strictEqual(context.buildLedgerLine(untrustedRecord).trustworthy, false)
  assert.strictEqual(context.buildLedgerLine({}).trustworthy, false)
})
