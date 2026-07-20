'use strict'

// Unit tests for the pure resolveIssueNumbers(raw) helper (workflows/ticketmill.js,
// added for issue #33) — normalizes args.issues into deduped positive integers in
// first-seen order before the Select block builds its work list. Modeled on
// tests/batch-closes-issues.test.js's shape: harness.boot(), call the pure function
// directly, compare arrays element-wise because they're built inside the vm context
// (a different realm from this file's own array literals) — see assertSameNumbers
// below.
//
// The bug this guards against: a caller passing issues:[701, 701] (typo or a stale
// resume command) survived the old inline map(Number).filter(n>0) untouched and
// produced two preflights, two claims, and two processIssue units racing on the
// same worktree/branch for the same issue.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// Arrays returned from inside the vm context carry that context's own
// Array.prototype — a different realm from this file's array literals — so
// assert.deepStrictEqual fails the prototype check even when every element
// matches (same realm-prototype note as tests/batch-closes-issues.test.js).
// Compare length + elements instead.
function assertSameNumbers(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length, message)
  for (let i = 0; i < expected.length; i++) assert.strictEqual(actual[i], expected[i], message)
}

test('resolveIssueNumbers: the exact bug — a repeated issue number collapses to one', function () {
  const context = harness.boot()
  const resolved = context.resolveIssueNumbers([701, 701])

  assertSameNumbers(resolved, [701])
})

test('resolveIssueNumbers: dedupes while preserving first-seen order', function () {
  const context = harness.boot()
  const resolved = context.resolveIssueNumbers([3, 1, 3, 2])

  assertSameNumbers(resolved, [3, 1, 2])
})

test('resolveIssueNumbers: drops n<=0 and NaN entries', function () {
  const context = harness.boot()
  const resolved = context.resolveIssueNumbers([5, 0, -1, NaN, 6])

  assertSameNumbers(resolved, [5, 6])
})

test('resolveIssueNumbers: empty array input yields []', function () {
  const context = harness.boot()
  const resolved = context.resolveIssueNumbers([])

  assertSameNumbers(resolved, [])
})

test('resolveIssueNumbers: non-array input (undefined, null) degrades cleanly to []', function () {
  const context = harness.boot()

  assertSameNumbers(context.resolveIssueNumbers(undefined), [])
  assertSameNumbers(context.resolveIssueNumbers(null), [])
})
