'use strict'

// Unit tests for the pure aggregateMergeAutoResolve(results) helper (workflows/
// ticketmill.js) — the run-level rollup of runMergeAutoResolve activity that
// feeds the batch-PR body, the final agent report, and resultsJson.merge_auto_resolve.
// Modeled on tests/token-usage.test.js's coverage of the sibling aggregateTokens
// helper: same "load via harness.boot(), call the pure function directly, assert
// both the machine-readable fields and the rendered markdown" shape.
//
// Covers all 4 markdown branches the helper distinguishes:
//   - none: no result carries a truthy merge_auto_resolved or merge_thrash metric.
//   - resolved-only: at least one auto-resolved issue, zero thrashed.
//   - thrash-only: zero auto-resolved, at least one thrashed.
//   - both: at least one of each, rendered as two separate paragraphs.
// Plus the same "missing/null metrics degrade cleanly" story aggregateTokens
// covers for its own inputs, since this helper reads results straight off the
// batch's raw result array (which can contain skipped/not_started entries with
// no `.metrics` at all, or a `fail()`-produced result whose metrics survived
// unrelated failures).

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// Arrays built INSIDE the vm context (agg.resolved_issues / agg.thrash_issues)
// carry that context's Array.prototype — a different realm from this file's own
// array literals — so assert.deepStrictEqual fails the prototype check even
// when every element matches (same realm-prototype note as the field-by-field
// object assertions elsewhere in tests/token-usage.test.js and
// tests/merge-auto-resolve.test.js). Compare length + elements instead.
function assertSameNumbers(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length, message)
  for (let i = 0; i < expected.length; i++) assert.strictEqual(actual[i], expected[i], message)
}

test('aggregateMergeAutoResolve: no result has merge_auto_resolved or merge_thrash — the "nothing to auto-resolve" branch', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, metrics: { merge_auto_resolved: 0, merge_thrash: 0 } },
    { issue: 2, metrics: { merge_auto_resolved: 0, merge_thrash: 0 } },
  ]
  const agg = context.aggregateMergeAutoResolve(results)

  assert.strictEqual(agg.resolved_count, 0)
  assert.strictEqual(agg.thrash_count, 0)
  assertSameNumbers(agg.resolved_issues, [])
  assertSameNumbers(agg.thrash_issues, [])
  assert.ok(agg.markdown.includes('## Merge Auto-Resolution'))
  assert.ok(agg.markdown.includes('No CONFLICTING PRs this run — nothing to auto-resolve.'))
})

test('aggregateMergeAutoResolve: resolved-only — lists the resolved issues, says nothing about thrash', function () {
  const context = harness.boot()
  const results = [
    { issue: 11, metrics: { merge_auto_resolved: 1, merge_thrash: 0 } },
    { issue: 12, metrics: { merge_auto_resolved: 1, merge_thrash: 0 } },
    { issue: 13, metrics: { merge_auto_resolved: 0, merge_thrash: 0 } },
  ]
  const agg = context.aggregateMergeAutoResolve(results)

  assert.strictEqual(agg.resolved_count, 2)
  assertSameNumbers(agg.resolved_issues, [11, 12])
  assert.strictEqual(agg.thrash_count, 0)
  assertSameNumbers(agg.thrash_issues, [])
  assert.ok(agg.markdown.includes('2 issue(s) auto-resolved: CONFLICTING after review'))
  assert.ok(agg.markdown.includes('#11, #12'))
  assert.ok(!agg.markdown.includes('thrash guard'))
})

test('aggregateMergeAutoResolve: thrash-only — the resolved line reports 0, the thrash paragraph names the thrashed issues', function () {
  const context = harness.boot()
  const results = [
    { issue: 21, metrics: { merge_auto_resolved: 0, merge_thrash: 1 } },
    { issue: 22, metrics: { merge_auto_resolved: 0, merge_thrash: 0 } },
  ]
  const agg = context.aggregateMergeAutoResolve(results)

  assert.strictEqual(agg.resolved_count, 0)
  assertSameNumbers(agg.resolved_issues, [])
  assert.strictEqual(agg.thrash_count, 1)
  assertSameNumbers(agg.thrash_issues, [21])
  assert.ok(agg.markdown.includes('0 issue(s) auto-resolved this run.'))
  assert.ok(agg.markdown.includes('1 issue(s) hit the thrash guard'))
  assert.ok(agg.markdown.includes('#21'))
})

test('aggregateMergeAutoResolve: both resolved and thrashed issues in the same run — two distinct, non-overlapping paragraphs', function () {
  const context = harness.boot()
  const results = [
    { issue: 31, metrics: { merge_auto_resolved: 1, merge_thrash: 0 } },
    { issue: 32, metrics: { merge_auto_resolved: 0, merge_thrash: 1 } },
  ]
  const agg = context.aggregateMergeAutoResolve(results)

  assert.strictEqual(agg.resolved_count, 1)
  assertSameNumbers(agg.resolved_issues, [31])
  assert.strictEqual(agg.thrash_count, 1)
  assertSameNumbers(agg.thrash_issues, [32])
  // An issue never appears in both buckets in the same run (thrash escalates to
  // needs_human instead of also bumping merge_auto_resolved — see the doc
  // comment above the helper and runMergeAutoResolve's own metric-bump note).
  assert.ok(agg.resolved_issues.indexOf(32) === -1)
  assert.ok(agg.thrash_issues.indexOf(31) === -1)
  assert.ok(agg.markdown.includes('1 issue(s) auto-resolved: CONFLICTING after review'))
  assert.ok(agg.markdown.includes('#31'))
  assert.ok(agg.markdown.includes('1 issue(s) hit the thrash guard'))
  assert.ok(agg.markdown.includes('#32'))
})

test('aggregateMergeAutoResolve: results missing `.metrics` entirely (skipped/not_started) degrade cleanly, never throw', function () {
  const context = harness.boot()
  const results = [
    { issue: 41, status: 'skipped' },
    { issue: 42, status: 'not_started' },
  ]
  const agg = context.aggregateMergeAutoResolve(results)

  assert.strictEqual(agg.resolved_count, 0)
  assert.strictEqual(agg.thrash_count, 0)
  assert.ok(agg.markdown.includes('No CONFLICTING PRs this run — nothing to auto-resolve.'))
})

test('aggregateMergeAutoResolve: empty results array degrades cleanly (no throw, "nothing to auto-resolve")', function () {
  const context = harness.boot()
  const agg = context.aggregateMergeAutoResolve([])

  assert.strictEqual(agg.resolved_count, 0)
  assert.strictEqual(agg.thrash_count, 0)
  assertSameNumbers(agg.resolved_issues, [])
  assertSameNumbers(agg.thrash_issues, [])
  assert.ok(agg.markdown.includes('No CONFLICTING PRs this run — nothing to auto-resolve.'))
})

test('aggregateMergeAutoResolve: null/undefined results (same defensive contract as aggregateTokens\' `results || []`) degrades cleanly', function () {
  const context = harness.boot()
  const agg = context.aggregateMergeAutoResolve(null)

  assert.strictEqual(agg.resolved_count, 0)
  assert.strictEqual(agg.thrash_count, 0)
  assert.ok(agg.markdown.includes('No CONFLICTING PRs this run — nothing to auto-resolve.'))
})
