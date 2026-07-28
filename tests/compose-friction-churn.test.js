'use strict'

// Unit tests for the pure composeFrictionChurn(results, opts) helper
// (workflows/ticketmill.js, issue #89) — the composer that combines
// computeFriction's and computeChurn's own '### Friction' / '### Churn'
// sub-blocks into ONE '## Friction & Churn' section, gated on either
// sub-rollup having signal, and the thing actually wired into the batch-PR
// body (workflows/ticketmill.js:5301/5470) and threaded into buildRunRecord's
// `friction_churn` field. Flagged as untested in the Test Validation
// (iteration 1) verdict on issue #89 — computeFriction/computeChurn each have
// their own dedicated test file (tests/friction.test.js, tests/churn.test.js)
// but the composer that actually ships to production had no direct coverage.
//
// Covers:
//   - clean omission: neither sub-rollup has signal -> has_signal false,
//     markdown === '' (no bare heading).
//   - friction-only signal -> heading + friction block, no '### Churn' text.
//   - churn-only signal -> heading + churn block, no '### Friction' text.
//   - both signals -> exact blank-line-only join between the two sub-blocks
//     (heading, blank, friction.markdown, blank, churn.markdown).
//   - the returned friction/churn sub-objects are the real computeFriction/
//     computeChurn outputs, not re-derived or truncated.
//   - opts (serializeGlobs/engineOwned) are forwarded to computeChurn, not
//     dropped or read off module scope.
//   - defensive null/empty results and missing opts.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('composeFrictionChurn: neither sub-rollup has signal -> clean omission (no bare heading)', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 1,
      metrics: { approach_iters: 0, plan_iters: 0, quality_iters: 0, test_iters: 0, browser_iters: 0, pr_review_iters: 0, task_review_attempts: 0, quality_degrades: 0, merge_thrash: 0 },
      needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0,
      changed_files: ['solo.js'], touch_counts: { 'solo.js': 1 },
    },
  ]

  const fc = context.composeFrictionChurn(results, { serializeGlobs: [], engineOwned: [] })

  assert.strictEqual(fc.has_signal, false)
  assert.strictEqual(fc.friction.has_signal, false)
  assert.strictEqual(fc.churn.has_signal, false)
  assert.strictEqual(fc.markdown, '')
  assert.ok(!fc.markdown.includes('## Friction & Churn'), 'a clean run must never render a bare heading')
})

test('composeFrictionChurn: friction-only signal renders the heading + friction block, omits churn entirely', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 2,
      metrics: { quality_iters: 5 }, // saturates MAX_QUALITY_ITERATIONS -> friction signal
      needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0,
      changed_files: ['solo.js'], touch_counts: { 'solo.js': 1 }, // no hotspot, no re-fix chain
    },
  ]

  const fc = context.composeFrictionChurn(results, { serializeGlobs: [], engineOwned: [] })

  assert.strictEqual(fc.has_signal, true)
  assert.strictEqual(fc.friction.has_signal, true)
  assert.strictEqual(fc.churn.has_signal, false)
  assert.ok(fc.markdown.startsWith('## Friction & Churn'))
  assert.ok(fc.markdown.includes('### Friction'))
  assert.ok(!fc.markdown.includes('### Churn'), 'a signal-free churn block must not be appended')
  // Exact composition: heading, blank, then friction's own markdown verbatim.
  assert.strictEqual(fc.markdown, '## Friction & Churn\n\n' + fc.friction.markdown)
})

test('composeFrictionChurn: churn-only signal renders the heading + churn block, omits friction entirely', function () {
  const context = harness.boot()
  const results = [
    { issue: 3, changed_files: [], touch_counts: { 'flaky/module.js': 3 }, metrics: {}, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const fc = context.composeFrictionChurn(results, { serializeGlobs: [], engineOwned: [] })

  assert.strictEqual(fc.has_signal, true)
  assert.strictEqual(fc.friction.has_signal, false)
  assert.strictEqual(fc.churn.has_signal, true)
  assert.ok(fc.markdown.startsWith('## Friction & Churn'))
  assert.ok(fc.markdown.includes('### Churn'))
  assert.ok(!fc.markdown.includes('### Friction'), 'a signal-free friction block must not be appended')
  assert.strictEqual(fc.markdown, '## Friction & Churn\n\n' + fc.churn.markdown)
})

test('composeFrictionChurn: both signals join with exactly one blank line between the two sub-blocks', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 4,
      metrics: { quality_iters: 5 }, // friction signal
      needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0,
      changed_files: [], touch_counts: { 'flaky/module.js': 3 }, // churn signal (re-fix chain)
    },
  ]

  const fc = context.composeFrictionChurn(results, { serializeGlobs: [], engineOwned: [] })

  assert.strictEqual(fc.has_signal, true)
  assert.strictEqual(fc.friction.has_signal, true)
  assert.strictEqual(fc.churn.has_signal, true)
  const expected = '## Friction & Churn\n\n' + fc.friction.markdown + '\n\n' + fc.churn.markdown
  assert.strictEqual(fc.markdown, expected)
  // No accidental double-blank or missing-blank join.
  assert.ok(!fc.markdown.includes('\n\n\n'), 'join must be exactly one blank line, not more')
})

test('composeFrictionChurn: returns the real computeFriction/computeChurn outputs, not re-derived summaries', function () {
  const context = harness.boot()
  const results = [
    { issue: 5, metrics: { browser_iters: 3 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0, changed_files: ['shared/util.js'], touch_counts: {} },
    { issue: 6, metrics: {}, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0, changed_files: ['shared/util.js'], touch_counts: {} },
    // issue #165: a multi-scope quality fixture proves the new driver keys
    // (cap, scopes) added by the pooled-denominator fix survive composition
    // rather than being dropped/truncated on the way through the composer.
    { issue: 8, metrics: { quality_iters: 6, quality_scopes: 3 }, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0, changed_files: [], touch_counts: {} },
  ]

  const fc = context.composeFrictionChurn(results, { serializeGlobs: [], engineOwned: [] })
  const direct = context.computeFriction(results)
  const directChurn = context.computeChurn(results, { serializeGlobs: [], engineOwned: [] })

  assert.strictEqual(fc.friction.top_issues.length, direct.top_issues.length)
  assert.strictEqual(fc.friction.by_issue.length, direct.by_issue.length)
  assert.strictEqual(fc.churn.hotspots.length, directChurn.hotspots.length)
  assert.strictEqual(fc.churn.hotspots[0].file, 'shared/util.js')
  assert.strictEqual(fc.churn.hotspots[0].count, 2)

  const fcRow = fc.friction.by_issue.find(function (r) { return r.issue === 8 })
  const directRow = direct.by_issue.find(function (r) { return r.issue === 8 })
  assert.deepStrictEqual(fcRow.drivers, directRow.drivers, 'composed friction drivers must be the same objects/values computeFriction produces directly')
  const qualityDriver = fcRow.drivers.find(function (d) { return d.name === 'quality' })
  assert.strictEqual(qualityDriver.cap, 15) // MAX_QUALITY_ITERATIONS (5) * quality_scopes (3)
  assert.strictEqual(qualityDriver.scopes, 3)
  assert.ok(Math.abs(qualityDriver.contribution - 0.4) < 1e-9)
})

test('composeFrictionChurn: opts are forwarded to computeChurn, not dropped or read off module scope', function () {
  const context = harness.boot()
  const results = [
    { issue: 7, changed_files: ['config/db.php'], touch_counts: { 'config/db.php': 3 }, metrics: {}, needs_human: false, contrarian_capped: false, unresolved_count: 0, test_quality_fix_rounds: 0 },
  ]

  const withGlob = context.composeFrictionChurn(results, { serializeGlobs: ['config/**'], engineOwned: [] })
  assert.strictEqual(withGlob.churn.refix_chains[0].bucket, 'serialize_globs')

  const withoutGlob = context.composeFrictionChurn(results, { serializeGlobs: [], engineOwned: [] })
  assert.strictEqual(withoutGlob.churn.refix_chains[0].bucket, 'surprising')
})

test('composeFrictionChurn: null/empty results and missing opts degrade cleanly, never throw', function () {
  const context = harness.boot()

  assert.doesNotThrow(function () { context.composeFrictionChurn(null, {}) })
  const nullAgg = context.composeFrictionChurn(null, {})
  assert.strictEqual(nullAgg.has_signal, false)
  assert.strictEqual(nullAgg.markdown, '')

  assert.doesNotThrow(function () { context.composeFrictionChurn([], undefined) })
  const noOptsAgg = context.composeFrictionChurn([], undefined)
  assert.strictEqual(noOptsAgg.has_signal, false)
  assert.strictEqual(noOptsAgg.markdown, '')
})
