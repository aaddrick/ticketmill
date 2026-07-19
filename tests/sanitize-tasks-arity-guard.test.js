'use strict'

// Source-text guard against sanitizeTasks() arity drift: the helper was
// lifted from an inner closure (which read ctx implicitly) to a top-level
// function that takes ctx explicitly (workflows/ticketmill.js). If a future
// edit reintroduces a call site that forgets the leading ctx argument, that
// call site silently closes over whatever `ctx` happens to be in scope at
// call time (or throws a ReferenceError) instead of failing loudly — this
// test makes the drift a mechanical, source-text-level failure.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('arity guard: exactly one def + two calls of sanitizeTasks(ctx, ...), no stale single-arg calls', function () {
  const raw = harness.readEngineSource()

  // Line ~134 carries a doc comment mentioning "sanitizeTasks()" with no
  // arguments at all — strip that specific, parens-empty mention before
  // counting real (ctx, ...) sites, so a doc-comment reword can't mask a
  // genuine arity regression (and so this test fails loudly if the comment
  // itself has drifted away from what this guard expects).
  const withoutDocComment = raw.replace(/sanitizeTasks\(\)/, '')
  assert.notStrictEqual(withoutDocComment, raw, 'expected to find the doc comment mentioning "sanitizeTasks()" with no args — has it moved or been reworded?')

  const ctxFirstSites = withoutDocComment.match(/sanitizeTasks\(ctx,\s*/g) || []
  assert.strictEqual(
    ctxFirstSites.length, 3,
    'expected exactly 1 def (`function sanitizeTasks(ctx, raw)`) + 2 call sites ' +
    '(`sanitizeTasks(ctx, ...)`), got ' + ctxFirstSites.length + ' — a reintroduced ' +
    'single-arg call site or a duplicated def would change this count',
  )

  const staleSingleArgCalls = raw.match(/sanitizeTasks\(\s*(planR|rp)\.tasks\s*\)/g)
  assert.strictEqual(
    staleSingleArgCalls, null,
    'found a stale single-arg sanitizeTasks(planR.tasks) or sanitizeTasks(rp.tasks) call — ' +
    'both call sites must pass ctx explicitly: sanitizeTasks(ctx, ...)',
  )

  // Sanity canary: total "sanitizeTasks(" occurrences anywhere in the file
  // (doc comment + def + 2 calls) is exactly 4 — catches an entirely new,
  // unaccounted-for reference to the helper appearing anywhere in the source.
  const allOccurrences = raw.match(/sanitizeTasks\(/g) || []
  assert.strictEqual(allOccurrences.length, 4)
})
