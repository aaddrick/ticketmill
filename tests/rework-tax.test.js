'use strict'

// Unit tests for computeReworkTax(results, tokenAgg) (issue #91 task 2) — the
// pure per-issue/per-run reducer that classifies ctx.tokens.byStage deltas
// (issue #91 task 1's instrumentation) against REWORK_STAGE_PREFIXES to report
// what fraction of TRACKED token spend went to fix/retry loops vs first-pass
// work, gated on tokenAgg.reconcile_error being <= MAX_RECONCILE_ERROR_FOR_TRUST
// (issue #90) — NEVER the coarser `reconciles` boolean.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ctx.tokens.byStage/by_issue rows are built inside the vm-realm engine
// function, so their prototype differs from this file's own object/array
// literals and fails deepStrictEqual's prototype check even when
// structurally identical (same cross-realm reasoning as
// tests/gate-findings.test.js's plain() helper). The data is plain JSON, so
// a JSON round-trip is a safe, realm-agnostic normalizer for the whole shape.
function plain(x) { return JSON.parse(JSON.stringify(x)) }

function tokenAgg(reconcileError) { return { reconcile_error: reconcileError } }

test('computeReworkTax: known rework fraction over a fixture, asserted per-issue and per-run', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 1,
      tokens: { tracked: true, byStage: { implement: 100, 'quality-fix-i1': 50 } },
    },
    {
      issue: 2,
      tokens: { tracked: true, byStage: { implement: 100, 'test-fix-i2': 100 } },
    },
  ]
  const rt = context.computeReworkTax(results, tokenAgg(0))

  // per-issue: issue 1 -> 50 rework / 150 total; issue 2 -> 100 rework / 200 total
  assert.deepStrictEqual(plain(rt.by_issue), [
    { issue: 1, rework: 50, first_pass: 100, fraction: 50 / 150, tracked: true },
    { issue: 2, rework: 100, first_pass: 100, fraction: 0.5, tracked: true },
  ])

  // per-run: 150 rework / 350 total tracked tokens
  assert.strictEqual(rt.run_rework, 150)
  assert.strictEqual(rt.run_first_pass, 200)
  assert.ok(Math.abs(rt.run_fraction - (150 / 350)) < 1e-9)
  assert.strictEqual(rt.trusted, true)
  assert.strictEqual(rt.has_signal, true)
})

test('computeReworkTax: the compound "test-quality-fix" prefix classifies as rework, not double-counted against the shorter "quality-fix"/"test-fix" prefixes', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { tracked: true, byStage: { implement: 40, 'test-quality-fix-i1': 60 } } },
  ]
  const rt = context.computeReworkTax(results, tokenAgg(0))

  assert.strictEqual(rt.by_issue[0].rework, 60)
  assert.strictEqual(rt.by_issue[0].first_pass, 40)
})

test('computeReworkTax: a result with no tracked byStage data contributes a tracked:false row and no run totals', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { tracked: false, byStage: {} } },
    { issue: 2, tokens: null },
    { issue: 3 },
  ]
  const rt = context.computeReworkTax(results, tokenAgg(0))

  assert.strictEqual(rt.by_issue.length, 3)
  for (const row of plain(rt.by_issue)) {
    assert.strictEqual(row.tracked, false)
    assert.strictEqual(row.rework, null)
    assert.strictEqual(row.first_pass, null)
    assert.strictEqual(row.fraction, null)
  }
  assert.strictEqual(rt.run_rework, 0)
  assert.strictEqual(rt.run_first_pass, 0)
  assert.strictEqual(rt.run_fraction, null)
  assert.strictEqual(rt.has_signal, false)
})

// ---- reconcile-error gate: MUST key off reconcile_error, never `reconciles` ----

test('computeReworkTax: reconcile_error above MAX_RECONCILE_ERROR_FOR_TRUST suppresses/scopes the output', function () {
  const context = harness.boot()
  const threshold = harness.readGlobal(context, 'MAX_RECONCILE_ERROR_FOR_TRUST')
  assert.strictEqual(typeof threshold, 'number') // guards against the constant silently vanishing/renaming

  const results = [
    { issue: 1, tokens: { tracked: true, byStage: { implement: 100, 'quality-fix-i1': 50 } } },
  ]
  const rt = context.computeReworkTax(results, tokenAgg(threshold + 0.01))

  assert.strictEqual(rt.trusted, false)
  assert.strictEqual(rt.has_signal, false, 'has_signal is false when the run is not trusted, regardless of rework volume')
  assert.ok(typeof rt.suppressed_reason === 'string' && rt.suppressed_reason.indexOf('exceeds the trust threshold') !== -1)
  assert.match(rt.markdown, /^## Rework Tax/)
  assert.match(rt.markdown, /Suppressed/)
  // raw sums are still returned (never blanked) -- a machine consumer can see
  // what was computed even though the run itself refuses to treat it as trusted.
  assert.strictEqual(rt.run_rework, 50)
  assert.strictEqual(rt.run_first_pass, 100)
})

test('computeReworkTax: reconcile_error == null (tokens never tracked/budget.spent() unavailable) also suppresses/scopes the output', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, tokens: { tracked: true, byStage: { implement: 100, 'quality-fix-i1': 50 } } },
  ]
  const rt = context.computeReworkTax(results, tokenAgg(null))

  assert.strictEqual(rt.reconcile_error, null)
  assert.strictEqual(rt.trusted, false)
  assert.strictEqual(rt.has_signal, false)
  assert.ok(rt.suppressed_reason.indexOf('unavailable this run') !== -1)
  assert.match(rt.markdown, /Suppressed/)
})

test('computeReworkTax: a small reconcile_error at or under the threshold is trusted and the fraction publishes', function () {
  const context = harness.boot()
  const threshold = harness.readGlobal(context, 'MAX_RECONCILE_ERROR_FOR_TRUST')
  const results = [
    { issue: 1, tokens: { tracked: true, byStage: { implement: 100, 'quality-fix-i1': 50 } } },
  ]
  const rt = context.computeReworkTax(results, tokenAgg(threshold))

  assert.strictEqual(rt.trusted, true)
  assert.strictEqual(rt.suppressed_reason, null)
  assert.strictEqual(rt.has_signal, true)
  assert.doesNotMatch(rt.markdown, /Suppressed/)
  assert.match(rt.markdown, /Run-wide/)
  assert.ok(rt.markdown.indexOf('#1') !== -1, 'per-issue table row is rendered when trusted')
})

test('computeReworkTax: defensive against missing/empty inputs -- never throws', function () {
  const context = harness.boot()

  assert.doesNotThrow(function () { context.computeReworkTax(null, null) })
  assert.doesNotThrow(function () { context.computeReworkTax(undefined, undefined) })

  const empty = context.computeReworkTax([], tokenAgg(0))
  assert.strictEqual(empty.by_issue.length, 0)
  assert.strictEqual(empty.run_fraction, null)
  assert.strictEqual(empty.has_signal, false)
})
