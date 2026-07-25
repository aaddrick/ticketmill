'use strict'

// Unit tests for the pure computeChurn(results, {serializeGlobs, engineOwned})
// helper (workflows/ticketmill.js, issue #89) — the within-run churn rollup
// (cross-issue hotspots + within-issue re-fix chains) injected (via
// composeFrictionChurn) into the batch-PR body and report agent. Modeled on
// tests/token-usage.test.js and tests/merge-auto-resolve-aggregate.test.js's
// "load via harness.boot(), call the pure function directly, assert both the
// machine-readable fields and the rendered markdown" shape.
//
// Covers:
//   - a synthetic re-fix chain (touch_counts[file] >= REFIX_THRESHOLD).
//   - a cross-issue hotspot exactly AT the HOTSPOT_ISSUE_THRESHOLD boundary.
//   - serialize_globs / engine_owned / surprising bucketing via matchesGlobs
//     with globs passed as params (never read off module scope).
//   - has_signal true-with-signal and false-clean-omission.
//   - defensive null/empty results and results missing changed_files/touch_counts.
//
// Arrays built INSIDE the vm context (h.issues, agg.hotspots, ...) carry that
// context's Array.prototype — a different realm from this file's own array
// literals — so assert.deepStrictEqual fails the prototype check even when
// every element matches (same realm-prototype note as
// tests/merge-auto-resolve-aggregate.test.js). Compare length + elements
// instead via assertSameElements below.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

function assertSameElements(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length, message)
  for (let i = 0; i < expected.length; i++) assert.strictEqual(actual[i], expected[i], message)
}

test('computeChurn: a file touched at exactly HOTSPOT_ISSUE_THRESHOLD distinct issues is a hotspot; below it is not', function () {
  const context = harness.boot()
  const threshold = harness.readGlobal(context, 'HOTSPOT_ISSUE_THRESHOLD')
  assert.strictEqual(threshold, 2)

  const results = [
    { issue: 1, changed_files: ['shared/util.js', 'issue1-only.js'], touch_counts: {} },
    { issue: 2, changed_files: ['shared/util.js'], touch_counts: {} },
    { issue: 3, changed_files: ['issue3-only.js'], touch_counts: {} },
  ]

  const c = context.computeChurn(results, { serializeGlobs: [], engineOwned: [] })

  assert.strictEqual(c.hotspots.length, 1)
  assert.strictEqual(c.hotspots[0].file, 'shared/util.js')
  assert.strictEqual(c.hotspots[0].count, 2)
  assertSameElements(Array.from(c.hotspots[0].issues), [1, 2])

  // Single-issue files never qualify.
  assert.ok(!c.hotspots.some(function (h) { return h.file === 'issue1-only.js' || h.file === 'issue3-only.js' }))

  assert.ok(c.has_signal)
  assert.ok(c.markdown.includes('Cross-issue hotspots'))
  assert.ok(c.markdown.includes('shared/util.js'))
})

test('computeChurn: a synthetic re-fix chain fires at REFIX_THRESHOLD touches within one issue, not below it', function () {
  const context = harness.boot()
  const threshold = harness.readGlobal(context, 'REFIX_THRESHOLD')
  assert.strictEqual(threshold, 3)

  const results = [
    { issue: 10, changed_files: [], touch_counts: { 'flaky/module.js': 3, 'stable/module.js': 2 } },
  ]

  const c = context.computeChurn(results, { serializeGlobs: [], engineOwned: [] })

  assert.strictEqual(c.refix_chains.length, 1)
  assert.strictEqual(c.refix_chains[0].issue, 10)
  assert.strictEqual(c.refix_chains[0].file, 'flaky/module.js')
  assert.strictEqual(c.refix_chains[0].count, 3)
  // 2 touches (below REFIX_THRESHOLD) never becomes a chain.
  assert.ok(!c.refix_chains.some(function (r) { return r.file === 'stable/module.js' }))

  assert.ok(c.has_signal)
  assert.ok(c.markdown.includes('Re-fix chains'))
  assert.ok(c.markdown.includes('flaky/module.js'))
})

test('computeChurn: buckets hotspots/refix chains serialize_globs / engine_owned / surprising via the globs PASSED IN, not module state', function () {
  const context = harness.boot()
  const opts = {
    serializeGlobs: ['config/**'],
    engineOwned: ['.claude/**'],
  }
  const results = [
    { issue: 20, changed_files: ['config/db.php'], touch_counts: { 'config/db.php': 3 } },
    { issue: 21, changed_files: ['config/db.php'], touch_counts: {} },
    { issue: 22, changed_files: ['.claude/agents/foo.md'], touch_counts: { '.claude/agents/foo.md': 4 } },
    { issue: 23, changed_files: ['.claude/agents/foo.md'], touch_counts: {} },
    { issue: 24, changed_files: ['src/app.js'], touch_counts: { 'src/app.js': 3 } },
    { issue: 25, changed_files: ['src/app.js'], touch_counts: {} },
  ]

  const c = context.computeChurn(results, opts)

  const byFile = {}
  for (const h of c.hotspots) byFile[h.file] = h.bucket
  assert.strictEqual(byFile['config/db.php'], 'serialize_globs')
  assert.strictEqual(byFile['.claude/agents/foo.md'], 'engine_owned')
  assert.strictEqual(byFile['src/app.js'], 'surprising')

  const refixByFile = {}
  for (const r of c.refix_chains) refixByFile[r.file] = r.bucket
  assert.strictEqual(refixByFile['config/db.php'], 'serialize_globs')
  assert.strictEqual(refixByFile['.claude/agents/foo.md'], 'engine_owned')
  assert.strictEqual(refixByFile['src/app.js'], 'surprising')

  // buckets{} groups the same entries by bucket name.
  assert.strictEqual(c.buckets.serialize_globs.hotspots.length, 1)
  assert.strictEqual(c.buckets.serialize_globs.refix_chains.length, 1)
  assert.strictEqual(c.buckets.engine_owned.hotspots.length, 1)
  assert.strictEqual(c.buckets.engine_owned.refix_chains.length, 1)
  assert.strictEqual(c.buckets.surprising.hotspots.length, 1)
  assert.strictEqual(c.buckets.surprising.refix_chains.length, 1)

  // Different globs passed to a second call change the bucketing of the SAME
  // data — proves globs are read from params, never module-scope ENGINE_OWNED.
  const c2 = context.computeChurn(results, { serializeGlobs: ['src/**'], engineOwned: [] })
  const byFile2 = {}
  for (const h of c2.hotspots) byFile2[h.file] = h.bucket
  assert.strictEqual(byFile2['src/app.js'], 'serialize_globs')
  assert.strictEqual(byFile2['config/db.php'], 'surprising')
})

test('computeChurn: has_signal is true with signal and false (clean omission) with none', function () {
  const context = harness.boot()

  const clean = context.computeChurn(
    [{ issue: 1, changed_files: ['solo.js'], touch_counts: { 'solo.js': 1 } }],
    { serializeGlobs: [], engineOwned: [] }
  )
  assert.strictEqual(clean.has_signal, false)
  assert.strictEqual(clean.hotspots.length, 0)
  assert.strictEqual(clean.refix_chains.length, 0)
  assert.ok(clean.markdown.includes('No cross-issue hotspots or re-fix chains this run.'))

  const dirty = context.computeChurn(
    [{ issue: 1, changed_files: [], touch_counts: { 'flaky.js': 3 } }],
    { serializeGlobs: [], engineOwned: [] }
  )
  assert.strictEqual(dirty.has_signal, true)
})

test('computeChurn: null/empty results and missing opts degrade cleanly, never throw', function () {
  const context = harness.boot()

  assert.doesNotThrow(function () { context.computeChurn(null, {}) })
  const nullAgg = context.computeChurn(null, {})
  assert.strictEqual(nullAgg.has_signal, false)
  assert.strictEqual(nullAgg.hotspots.length, 0)
  assert.strictEqual(nullAgg.refix_chains.length, 0)

  assert.doesNotThrow(function () { context.computeChurn([], undefined) })
  const noOptsAgg = context.computeChurn([], undefined)
  assert.strictEqual(noOptsAgg.has_signal, false)
})

test('computeChurn: results missing changed_files/touch_counts entirely (skipped/not_started) degrade cleanly', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, status: 'skipped' },
    { issue: 2, status: 'not_started' },
  ]

  assert.doesNotThrow(function () { context.computeChurn(results, { serializeGlobs: [], engineOwned: [] }) })
  const c = context.computeChurn(results, { serializeGlobs: [], engineOwned: [] })
  assert.strictEqual(c.has_signal, false)
  assert.strictEqual(c.hotspots.length, 0)
  assert.strictEqual(c.refix_chains.length, 0)
})
