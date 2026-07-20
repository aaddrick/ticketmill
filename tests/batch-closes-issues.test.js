'use strict'

// Unit tests for the pure batchClosesIssues(results) helper (workflows/ticketmill.js,
// added for issue #30) — derives the deduped issue numbers whose work is actually IN
// the batch branch, used to drive the batch PR's "Closes #N" lines (and the create/
// update gate, title count, and Consolidated Groups section that must agree with them
// by construction). Modeled on tests/merge-auto-resolve-aggregate.test.js's shape:
// harness.boot(), call the pure function directly, compare arrays element-wise
// because they're built inside the vm context (a different realm from this file's
// own array literals) — see assertSameNumbers below.
//
// The bug this guards against: a healing/resumed run rebuilds the batch PR body from
// that pass's own results. An issue whose per-issue PR merged in a PRIOR pass
// preflights as status:'skipped' this pass ("Related PR already merged"), so keying
// Closes lines off raw completion status silently drops it — leaving that issue open
// when the batch PR merges. The fix keys inclusion on the structured
// merged_into_target flag (computed in JS from pr_state==='merged' && pr_base===TARGET
// at preflight time), NOT on raw pr_state, because pr_state alone can't distinguish
// "merged into THIS run's batch branch" from "merged into a DIFFERENT batch branch by
// a concurrent run" — the mirror-image bug the Revised Plan (iteration 1) caught.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// Arrays returned from inside the vm context carry that context's own
// Array.prototype — a different realm from this file's array literals — so
// assert.deepStrictEqual fails the prototype check even when every element
// matches (same realm-prototype note as tests/merge-auto-resolve-aggregate.test.js
// and tests/token-usage.test.js). Compare length + elements instead.
function assertSameNumbers(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length, message)
  for (let i = 0; i < expected.length; i++) assert.strictEqual(actual[i], expected[i], message)
}

test('batchClosesIssues: the exact bug — completed #1, completed #3, skipped #2 merged_into_target:true all ship', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, status: 'completed' },
    { issue: 3, status: 'completed' },
    { issue: 2, status: 'skipped', pr_state: 'merged', merged_into_target: true },
  ]
  const shipped = context.batchClosesIssues(results)

  assertSameNumbers(shipped, [1, 3, 2])
})

test('batchClosesIssues: cross-batch guard — skipped + pr_state merged but merged_into_target:false (merged into a DIFFERENT base) is excluded', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, status: 'completed' },
    { issue: 2, status: 'skipped', pr_state: 'merged', merged_into_target: false },
  ]
  const shipped = context.batchClosesIssues(results)

  assertSameNumbers(shipped, [1])
})

test('batchClosesIssues: skipped with pr_state none/closed/open (merged_into_target falsy) is excluded', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, status: 'skipped', pr_state: 'none', merged_into_target: false },
    { issue: 2, status: 'skipped', pr_state: 'closed', merged_into_target: false },
    { issue: 3, status: 'skipped', pr_state: 'open', merged_into_target: false },
    // merged_into_target simply absent (undefined), as a real skip result that
    // never went through the merged-PR branch would look.
    { issue: 4, status: 'skipped', pr_state: 'none' },
  ]
  const shipped = context.batchClosesIssues(results)

  assertSameNumbers(shipped, [])
})

test('batchClosesIssues: failed, not_started, and dissolved statuses are excluded regardless of other fields', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, status: 'failed' },
    { issue: 2, status: 'not_started' },
    { issue: 3, status: 'dissolved' },
    // Even a stray merged_into_target:true on a non-completed/non-skipped status
    // must not leak it in — the predicate checks status first.
    { issue: 4, status: 'failed', merged_into_target: true },
  ]
  const shipped = context.batchClosesIssues(results)

  assertSameNumbers(shipped, [])
})

test('batchClosesIssues: group flatMap — a completed group closes every member, not just its primary', function () {
  const context = harness.boot()
  const results = [
    { issue: 10, status: 'completed', members: [10, 11] },
  ]
  const shipped = context.batchClosesIssues(results)

  assertSameNumbers(shipped, [10, 11])
})

test('batchClosesIssues: group flatMap — a skipped group with merged_into_target:true closes every member', function () {
  const context = harness.boot()
  const results = [
    { issue: 20, status: 'skipped', pr_state: 'merged', merged_into_target: true, members: [20, 21] },
  ]
  const shipped = context.batchClosesIssues(results)

  assertSameNumbers(shipped, [20, 21])
})

test('batchClosesIssues: a skipped group with merged_into_target:false contributes no members', function () {
  const context = harness.boot()
  const results = [
    { issue: 20, status: 'skipped', pr_state: 'merged', merged_into_target: false, members: [20, 21] },
  ]
  const shipped = context.batchClosesIssues(results)

  assertSameNumbers(shipped, [])
})

test('batchClosesIssues: dedup holds across overlapping members from separate results', function () {
  const context = harness.boot()
  const results = [
    { issue: 30, status: 'completed', members: [30, 31] },
    // A second, independent result that happens to also cover issue 31 (e.g. a
    // reconciled/split group in a later pass) must not produce a duplicate.
    { issue: 31, status: 'completed', members: [31, 32] },
    { issue: 31, status: 'skipped', pr_state: 'merged', merged_into_target: true, members: [31] },
  ]
  const shipped = context.batchClosesIssues(results)

  assertSameNumbers(shipped, [30, 31, 32])
})

test('batchClosesIssues: no members field falls back to [r.issue] (the non-grouped case)', function () {
  const context = harness.boot()
  const results = [
    { issue: 5, status: 'completed' },
    { issue: 6, status: 'skipped', pr_state: 'merged', merged_into_target: true },
  ]
  const shipped = context.batchClosesIssues(results)

  assertSameNumbers(shipped, [5, 6])
})

test('batchClosesIssues: empty and null/undefined results degrade cleanly (no throw, empty array)', function () {
  const context = harness.boot()

  assertSameNumbers(context.batchClosesIssues([]), [])
  assertSameNumbers(context.batchClosesIssues(null), [])
  assertSameNumbers(context.batchClosesIssues(undefined), [])
})
