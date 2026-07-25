'use strict'

// Tests for issue #88 — widening prior-run learning injection to the implement,
// spec-review, and code-review stages.
//
// Two halves, matching what the harness can and cannot reach:
//   1. learn(cat) is a pure function above the harness split — unit-tested directly
//      for the block it renders when LEARN is populated and its empty-string no-op.
//   2. The three stage prompts live BELOW the split (inside processIssue/reviewAndMerge,
//      which the harness truncates away), so they're guarded by source inspection:
//      each stage's prompt slice must contain a learn(...) call. Mirrors the
//      source-inspection style already used by tests/sandbox-lint.test.js and
//      tests/harness.test.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ---- 1. learn() behavior ----

test('learn(cat) renders the prior-run block when LEARN holds that category', function () {
  const context = harness.boot()
  context.__seed({ LEARN: { error_patterns: 'avoid the vm deepStrictEqual gotcha', workflow: 'serialize engine edits' } })
  assert.strictEqual(context.learn('error_patterns'), '## Prior-run learnings — error_patterns\navoid the vm deepStrictEqual gotcha')
  assert.strictEqual(context.learn('workflow'), '## Prior-run learnings — workflow\nserialize engine edits')
})

test('learn(cat) is an empty-string no-op for an absent category or unset LEARN', function () {
  const context = harness.boot()
  // LEARN defaults to null -> every category is a no-op (degrades cleanly in join()).
  assert.strictEqual(context.learn('error_patterns'), '')
  context.__seed({ LEARN: { quality_loop: 'x' } })
  assert.strictEqual(context.learn('error_patterns'), '', 'a category the digest did not populate must render nothing')
  assert.strictEqual(context.learn('quality_loop'), '## Prior-run learnings — quality_loop\nx')
})

// ---- 2. the three stages inject learn() (source guard) ----

// Return the prompt-array text that immediately precedes a stage's `stageOpts('<key>')`
// marker (the stages are below the harness split, so we assert on source, not runtime).
function promptSliceBefore(src, stageOptsKey, window) {
  const marker = "stageOpts('" + stageOptsKey + "')"
  const idx = src.indexOf(marker)
  assert.notStrictEqual(idx, -1, 'expected to find ' + marker + ' in the engine source')
  return src.slice(Math.max(0, idx - (window || 1600)), idx)
}

test('the implement, spec-review, and code-review stages each inject a learn() block (#88)', function () {
  const src = harness.readEngineSource()
  for (const key of ['implement', 'specReview', 'codeReview']) {
    const slice = promptSliceBefore(src, key)
    assert.match(slice, /learn\(/, 'stage "' + key + '" prompt should include a learn(...) injection after #88')
  }
})

test('the widened stages did not lose the pre-existing injection sites', function () {
  const src = harness.readEngineSource()
  // test-run/test-fix, both contrarian gates, and plan already injected learnings;
  // #88 only adds to implement/spec/code, so the total call count must strictly grow.
  const count = (src.match(/learn\(/g) || []).length
  assert.ok(count >= 11, 'expected at least the 6 prior + 5 new learn() call sites, saw ' + count)
})
