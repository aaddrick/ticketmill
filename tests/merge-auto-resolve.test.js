'use strict'

// Harness node:test coverage for the merge-stage auto-rebase/resolve flow
// (runMergeAutoResolve, mergeSettlePoll, and their wiring into reviewAndMerge).
// Each test below maps 1:1 onto one of the six acceptance scenarios from the
// issue #2 task list ("## Revised Task List (iteration 1)", task 3):
//   (a) CONFLICTING -> rebase drops already-upstream -> green tests -> force-push
//       -> merges, merge_auto_resolved incremented AFTER merge success.
//   (b) [new] persistent probe mergeable:UNKNOWN -> auto-resolve flow does NOT
//       escalate; it falls through untouched for the merge stage's own
//       settle-tolerant preflight to decide.
//   (c) resolver declines a semantic conflict -> needs_human, worktree preserved
//       (merge/cleanup never reached).
//   (d) TARGET moves again while the mandatory post-rebase tests are running ->
//       merge_thrash bumped -> needs_human, worktree preserved.
//   (e) profile test_command:null -> auto-resolution skipped entirely, zero
//       agent calls, no rebase attempted.
//   (f) [new] a resolved conflict touching only files outside PROFILE.test_globs
//       still runs the full suite (forced), not silently skipped on "no
//       testable code changed".
//   (g) [new] the helper resolves (mar.resolved=true, full rebase/test/push
//       sequence succeeds) but the merge stage's OWN subsequent preflight then
//       blocks for an unrelated reason -> needs_human, and merge_auto_resolved
//       must stay 0 (the metric only bumps after a CONFIRMED merge).
//
// (a), (c), (d), and (g) drive the FULL reviewAndMerge() — not just the helper
// — so the assertions prove the real user-visible outcome (merged status /
// metric timing / needs_human with the merge stage never reached), not just
// the helper's own return shape. (b), (e), and (f) are narrower and drive
// runMergeAutoResolve() directly since their contract is entirely about what
// the helper does (or deliberately does NOT do).

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// Every stage() call's opts.label is "<issue>:<stageKey>" (see workflows/
// ticketmill.js stage(), ~line 894). Issue numbers never contain ':', so the
// stage key is always everything after the first colon.
function stageKeyOf(call) {
  const label = (call.opts && call.opts.label) || ''
  return label.slice(label.indexOf(':') + 1)
}

function seedMergeFlow(context, overrides) {
  context.__seed(Object.assign({
    PROFILE: {},
    TEST_CMD: 'npm test',
    TARGET: 'Batch_2026-07-19_153400',
  }, overrides))
}

const APPROVED_REVIEW = { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }

test('(a) CONFLICTING PR auto-resolves through reviewAndMerge: clean rebase, forced green tests, force-push, merges — merge_auto_resolved bumped only AFTER the merge succeeds', async function () {
  const context = harness.boot()
  seedMergeFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': APPROVED_REVIEW,
    'merge-preflight-probe': { state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    'merge-rebase': { status: 'clean', conflicted_files: [], error: null }, // already-upstream sibling commits
    'test-run-i1': { result: 'passed', total_tests: 5, passed_tests: 5, failed_tests: 0, failures: [], summary: 'all green' },
    'test-validate-i1': { result: 'approved', comments: '', issues: [], summary: 'covered' },
    'merge-preflight-guard': { moved: false, detail: 'TARGET unchanged' },
    'merge-force-push': { status: 'success', error: null },
    merge: { status: 'merged', follow_up_issues: [], error: null },
  })

  const ctx = harness.makeCtx({ issue: 21, pr: 210 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'completed')
  assert.strictEqual(result.pr, 210)
  // The metric is bumped by reviewAndMerge itself, only once the merge stage
  // reports status==='merged' — never by the helper.
  assert.strictEqual(ctx.metrics.merge_auto_resolved, 1)
  assert.strictEqual(ctx.metrics.merge_thrash, 0)

  const keys = context.agent.calls.map(stageKeyOf)
  for (const expected of ['spec-review-i1', 'code-review-i1', 'merge-preflight-probe', 'merge-rebase', 'test-run-i1', 'test-validate-i1', 'merge-preflight-guard', 'merge-force-push', 'merge']) {
    assert.ok(keys.includes(expected), 'expected stage "' + expected + '" to have run; ran: ' + keys.join(', '))
  }
  // The mechanical git recovery must all happen strictly after the probe finds
  // CONFLICTING and strictly before the force-push.
  const probeIdx = keys.indexOf('merge-preflight-probe')
  const rebaseIdx = keys.indexOf('merge-rebase')
  const guardIdx = keys.indexOf('merge-preflight-guard')
  const pushIdx = keys.indexOf('merge-force-push')
  const mergeIdx = keys.indexOf('merge')
  assert.ok(probeIdx < rebaseIdx && rebaseIdx < guardIdx && guardIdx < pushIdx && pushIdx < mergeIdx)

  // The probe and the merge stage's own final preflight both use the shared
  // UNKNOWN-tolerant settle-poll, not a single-shot read.
  const probeCall = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'merge-preflight-probe' })
  assert.ok(probeCall.prompt.includes('for i in $(seq 1 6)'))
  const mergeCall = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'merge' })
  assert.ok(mergeCall.prompt.includes('for i in $(seq 1 6)'))
  // The merged diff diverged from the reviewed head — the Implementation
  // Complete comment must say so.
  assert.ok(mergeCall.prompt.includes('auto-rebased onto'))
  assert.ok(mergeCall.prompt.includes('force-pushed with tests re-verified green'))

  // The mandatory post-rebase test loop is FORCED — it must not be able to
  // silently skip via the "no testable code changed" shortcut.
  const testRunCall = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'test-run-i1' })
  assert.ok(testRunCall.prompt.includes('MANDATORY re-run'))
})

test('(b) [new] a probe mergeable:UNKNOWN that stays UNKNOWN through the settle-poll is left for the merge stage\'s own preflight — no rebase is attempted and nothing escalates', async function () {
  const context = harness.boot()
  seedMergeFlow(context)

  installScriptedResponder(context, {
    'merge-preflight-probe': { state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
  })

  const ctx = harness.makeCtx({ issue: 22, pr: 220 })
  const result = await context.runMergeAutoResolve(ctx)

  // Field-by-field, not assert.deepStrictEqual: result is an object literal
  // built inside the vm context, so it carries that context's Object.prototype
  // (a different realm) and fails deepStrictEqual's prototype check even when
  // every property value matches (see tests/test-loop.test.js for the same note).
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.resolved, false)
  assert.strictEqual(context.agent.calls.length, 1, 'only the probe should run — UNKNOWN is not this flow\'s business')
  assert.strictEqual(stageKeyOf(context.agent.calls[0]), 'merge-preflight-probe')
  assert.strictEqual(ctx.metrics.merge_auto_resolved, 0)
  assert.strictEqual(ctx.metrics.merge_thrash, 0)
})

test('(c) the conflict resolver declining a semantic conflict lands in needs_human with the worktree preserved — the merge/cleanup stage is never reached', async function () {
  const context = harness.boot()
  seedMergeFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': APPROVED_REVIEW,
    'merge-preflight-probe': { state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    'merge-rebase': { status: 'conflicts', conflicted_files: ['workflows/ticketmill.js'], error: null },
    'merge-conflict-resolve': { status: 'aborted', commit: null, files_changed: [], summary: 'both sides changed the same behavior differently — cannot tell which is intended' },
    'halt-note-merge-auto-resolve': { posted: true },
  })

  const ctx = harness.makeCtx({ issue: 23, pr: 230 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'merge-auto-resolve')
  assert.ok(result.error.includes('declined'), result.error)
  assert.strictEqual(ctx.metrics.merge_auto_resolved, 0)

  const keys = context.agent.calls.map(stageKeyOf)
  assert.ok(keys.includes('merge-conflict-resolve'))
  // Nothing past the abort ever runs: no forced test loop, no thrash guard, no
  // force-push, and critically no merge stage — which is the only stage that
  // ever tears down the worktree (step 7 of its prompt). Never reaching it is
  // exactly "worktree preserved".
  for (const shouldNotRun of ['test-run-i1', 'test-validate-i1', 'merge-preflight-guard', 'merge-force-push', 'merge']) {
    assert.ok(!keys.includes(shouldNotRun), 'stage "' + shouldNotRun + '" must not run after the resolver declines; ran: ' + keys.join(', '))
  }
})

const TARGET_MOVED_DETAIL = 'origin/Batch_2026-07-19_153400 is no longer an ancestor of HEAD'

test('(d) TARGET moving again while the mandatory tests were running trips the thrash guard — merge_thrash bumped, needs_human, worktree preserved (no re-rebase, no force-push)', async function () {
  const context = harness.boot()
  seedMergeFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': APPROVED_REVIEW,
    'merge-preflight-probe': { state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    'merge-rebase': { status: 'clean', conflicted_files: [], error: null },
    'test-run-i1': { result: 'passed', total_tests: 5, passed_tests: 5, failed_tests: 0, failures: [], summary: 'all green' },
    'test-validate-i1': { result: 'approved', comments: '', issues: [], summary: 'covered' },
    'merge-preflight-guard': { moved: true, detail: TARGET_MOVED_DETAIL },
    'halt-note-merge-auto-resolve': { posted: true },
  })

  const ctx = harness.makeCtx({ issue: 24, pr: 240 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'merge-auto-resolve')
  assert.ok(result.error.includes('moved again'), result.error)
  assert.strictEqual(ctx.metrics.merge_thrash, 1)
  assert.strictEqual(ctx.metrics.merge_auto_resolved, 0)

  const keys = context.agent.calls.map(stageKeyOf)
  assert.ok(keys.includes('merge-preflight-guard'))
  // The just-tested state must never be pushed once it's known stale — a
  // deliberate contrarian-adjudicated choice (see runMergeAutoResolve's own
  // doc comment): escalate rather than silently re-rebase and push untested
  // content. And the merge stage (worktree teardown) must never run either.
  for (const shouldNotRun of ['merge-force-push', 'merge']) {
    assert.ok(!keys.includes(shouldNotRun), 'stage "' + shouldNotRun + '" must not run once the thrash guard trips; ran: ' + keys.join(', '))
  }
})

test('(e) profile test_command:null skips auto-resolution entirely — zero agent calls, no rebase attempted, CONFLICTING falls straight through to the merge stage\'s own preflight as before', async function () {
  const context = harness.boot()
  seedMergeFlow(context, { TEST_CMD: null })

  installScriptedResponder(context, {
    // Nothing should be called at all — any stage key reaching the responder
    // is itself the test failure, so leave the map empty and let the
    // catch-all below throw loudly if anything does.
  })

  const ctx = harness.makeCtx({ issue: 25, pr: 250 })
  const result = await context.runMergeAutoResolve(ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.resolved, false)
  assert.strictEqual(context.agent.calls.length, 0, 'test_command:null means there is no suite to re-verify against — the whole flow must be a no-op')
})

test('(f) [new] a resolved conflict touching only files outside PROFILE.test_globs still runs the full suite (forced) — it is not silently skipped on "no testable code changed"', async function () {
  const context = harness.boot()
  // test_globs deliberately does NOT match the conflicted file below, so the
  // unforced test-run prompt would tell the agent it's free to skip the suite.
  seedMergeFlow(context, { PROFILE: { test_globs: ['**/*.test.js'] } })

  installScriptedResponder(context, {
    'merge-preflight-probe': { state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    'merge-rebase': { status: 'conflicts', conflicted_files: ['README.md'], error: null },
    'merge-conflict-resolve': { status: 'resolved', commit: 'deadbeef', files_changed: ['README.md'], summary: 'kept both doc additions' },
    'test-run-i1': { result: 'passed', total_tests: 5, passed_tests: 5, failed_tests: 0, failures: [], summary: 'all green' },
    'test-validate-i1': { result: 'approved', comments: '', issues: [], summary: 'covered' },
    'merge-preflight-guard': { moved: false, detail: 'TARGET unchanged' },
    'merge-force-push': { status: 'success', error: null },
  })

  const ctx = harness.makeCtx({ issue: 26, pr: 260 })
  const result = await context.runMergeAutoResolve(ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.resolved, true)

  const testRunCall = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'test-run-i1' })
  assert.ok(testRunCall, 'the forced test-run stage must actually be invoked even though the resolved diff only touches non-test-glob files')
  // The forced branch's mandatory language must be present, and the
  // glob-skip-permitting branch (which would let the agent legitimately skip
  // README.md as "not testable") must be entirely absent from this prompt.
  assert.ok(testRunCall.prompt.includes('MANDATORY re-run'))
  assert.ok(!testRunCall.prompt.includes('do NOT run the suite'))
})

test('(g) [new] auto-resolve rebases and force-pushes clean (mar.resolved=true), but the merge stage\'s own preflight then blocks for an unrelated reason — needs_human, and merge_auto_resolved must NOT be bumped', async function () {
  const context = harness.boot()
  seedMergeFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': APPROVED_REVIEW,
    'merge-preflight-probe': { state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    'merge-rebase': { status: 'clean', conflicted_files: [], error: null },
    'test-run-i1': { result: 'passed', total_tests: 5, passed_tests: 5, failed_tests: 0, failures: [], summary: 'all green' },
    'test-validate-i1': { result: 'approved', comments: '', issues: [], summary: 'covered' },
    'merge-preflight-guard': { moved: false, detail: 'TARGET unchanged' },
    'merge-force-push': { status: 'success', error: null },
    // runMergeAutoResolve completes successfully (resolved: true) — but the
    // merge stage's OWN settle-tolerant preflight then finds the PR blocked for
    // a reason unrelated to the auto-resolve flow entirely (e.g. a branch
    // protection rule, a required check still pending, a human review request
    // filed after force-push). This is the exact combination the doc comment
    // above the metric-bump line in reviewAndMerge calls out by name.
    merge: { status: 'blocked', follow_up_issues: [], error: 'required status check "ci/lint" has not completed' },
    'halt-note-merge': { posted: true },
  })

  const ctx = harness.makeCtx({ issue: 27, pr: 270 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'merge')
  assert.ok(result.error.includes('ci/lint'), result.error)
  // The load-bearing assertion: auto-resolve DID resolve the PR (rebased,
  // tested, force-pushed) but the metric must stay at 0 because the merge
  // stage right after it never reported status==='merged'.
  assert.strictEqual(ctx.metrics.merge_auto_resolved, 0)
  assert.strictEqual(ctx.metrics.merge_thrash, 0)

  const keys = context.agent.calls.map(stageKeyOf)
  // The full auto-resolve mechanical sequence DID run, all the way through the
  // force-push — this is not a case where auto-resolve itself declined or
  // aborted early.
  for (const expected of ['merge-rebase', 'merge-preflight-guard', 'merge-force-push', 'merge']) {
    assert.ok(keys.includes(expected), 'expected stage "' + expected + '" to have run; ran: ' + keys.join(', '))
  }
})

// ---- shared responder plumbing ----

// Installs a scripted agent keyed by exact stage key (see stageKeyOf above).
// Any stage key not present in `byKey` throws immediately — an uninstrumented
// stage silently returning null would make stage()'s retry/death machinery
// swallow the gap instead of failing the test loudly.
function installScriptedResponder(context, byKey) {
  return harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    const key = label.slice(label.indexOf(':') + 1)
    if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
      throw new Error('unscripted stage in this scenario: "' + key + '" (label "' + label + '") — prompt starts: ' + String(prompt).slice(0, 200))
    }
    return byKey[key]
  })
}
