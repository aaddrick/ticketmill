'use strict'

// Integration tests for the pr-review gate's wiring into recordGateOutcome()
// (issue #91) — the "only gate #87 left unwired" call site inside
// reviewAndMerge() (workflows/ticketmill.js, ~line 4199):
//
//   const prReviewClean = spec.result === 'approved' && code.result === 'approved'
//   const prReviewDisposition = prReviewClean ? 'accepted' : (iter === MAX_PR_REVIEW_ITERATIONS ? 'carried-unresolved' : 're-litigated')
//   recordGateOutcome(ctx, 'pr-review', (spec.issues || []).concat(code.issues || []), prReviewDisposition)
//
// tests/gate-findings.test.js already proves recordGateOutcome() itself (the
// pure tally function) is correct in isolation, and tests/gate-yield.test.js
// proves computeGateYield() correctly rolls up whatever lands in
// ctx.gate_findings. Neither exercises the call site above through the real
// control flow: the disposition ('accepted' / 're-litigated' / 'carried-
// unresolved') is DERIVED from `iter`/`prReviewClean` inside reviewAndMerge()
// itself, and a mutant that corrupted or deleted that derivation (or the
// recordGateOutcome call entirely) would leave every recordGateOutcome()/
// computeGateYield() unit test still green. These tests drive the real
// reviewAndMerge() (loaded via tests/harness.js, same pattern as
// tests/merge-auto-resolve.test.js scenarios (a)/(c)/(d)/(g)) with a scripted
// agent(), so the derivation and the wiring are proven end-to-end.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// Every stage() call's opts.label is "<issue>:<stageKey>" (see workflows/
// ticketmill.js stage(), ~line 1527). Mirrors tests/merge-auto-resolve.test.js's
// stageKeyOf/installScriptedResponder helpers.
function stageKeyOf(call) {
  const label = (call.opts && call.opts.label) || ''
  return label.slice(label.indexOf(':') + 1)
}

// Installs a scripted agent keyed by exact stage key. Any stage key not
// present in `byKey` throws immediately — a readable "which stage did I
// forget to script" signal, same convention as merge-auto-resolve.test.js.
function installScriptedResponder(context, byKey) {
  return harness.installScriptedAgent(context, function (prompt, opts) {
    const key = stageKeyOf({ opts: opts })
    if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
      throw new Error('unscripted stage in this scenario: "' + key + '" (label "' + ((opts && opts.label) || '') + '") — prompt starts: ' + String(prompt).slice(0, 200))
    }
    return byKey[key]
  })
}

function seedReviewFlow(context, overrides) {
  // PROFILE:{} (no docs_dir -> tech-docs stage skipped) and TEST_CMD:null (no
  // suite -> runMergeAutoResolve() short-circuits with zero agent calls) keep
  // the post-approval tail of reviewAndMerge() down to exactly
  // changed-files-probe + merge, matching this file's scripted responses.
  context.__seed(Object.assign({
    PROFILE: {},
    TEST_CMD: null,
    REPO: 'aaddrick/ticketmill-fixture',
    TARGET: 'Batch_2026-07-25_fixture',
  }, overrides))
}

const APPROVED_REVIEW = { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'looks good' }
const CHANGED_FILES_PROBE_OK = { changed_files: ['workflows/ticketmill.js'], added_files: [] }
const COMMIT_PROBE_OK = { unresolved_shas: [] }
const MERGE_OK = { status: 'merged', follow_up_issues: [], error: null }
const FIX_OK = { status: 'success', commit: 'deadbeef', files_changed: [], fixes_applied: ['addressed review feedback'], summary: 'fixed', error: null }
const SIMPLIFY_OK = { status: 'success', commit: null, files_changed: [], summary: 'nothing to simplify' }
const QUALITY_REVIEW_APPROVED = { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'clean' }

test('reviewAndMerge(): a clean pr-review approval on iteration 1 records an "accepted" disposition in ctx.gate_findings["pr-review"], tallying both reviewers\' issues', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    // 'approved' can still carry nit-level issues — the disposition is driven
    // by .result alone, not by issues being empty.
    'code-review-i1': Object.assign({}, APPROVED_REVIEW, { issues: [{ severity: 'minor', summary: 'nit: naming' }] }),
    'changed-files-probe': CHANGED_FILES_PROBE_OK,
    merge: MERGE_OK,
  })

  const ctx = harness.makeCtx({ issue: 30, pr: 300 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'completed')
  assert.strictEqual(ctx.metrics.pr_review_iters, 1)

  const g = ctx.gate_findings['pr-review']
  assert.ok(g, 'ctx.gate_findings["pr-review"] must be populated by the real reviewAndMerge() call site')
  assert.strictEqual(g.count, 1)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.severity)), { critical: 0, major: 0, minor: 1 })
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.disposition)), { accepted: 1 })

  // The tally also survives on the returned result object, same as every
  // other completed-issue field.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result.gate_findings['pr-review'].disposition)), { accepted: 1 })
})

test('reviewAndMerge(): a changes-requested iteration followed by a clean approval records "re-litigated" then "accepted", accumulating in the same gate_findings["pr-review"] bucket', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  installScriptedResponder(context, {
    // ---- iteration 1: code review requests changes (spec is fine) ----
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': { result: 'changes_requested', comments: 'tighten error handling', issues: [{ severity: 'major', summary: 'unhandled rejection' }], recommended_fix_agent: null, summary: 'needs a fix' },
    'pr-fix-i1': FIX_OK,
    'simplify-pr-fix-i1-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i1-i1': QUALITY_REVIEW_APPROVED,
    // ---- iteration 2: both approve ----
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': APPROVED_REVIEW,
    // pr-fix-i1 (FIX_OK) posted a commit, so reviewAndMerge()'s commit-sha
    // probe (issue #79, Layer 2) dispatches once for the whole issue, before
    // changed-files-probe — see the probeCommitShas() call site.
    'commit-sha-probe': COMMIT_PROBE_OK,
    'changed-files-probe': CHANGED_FILES_PROBE_OK,
    merge: MERGE_OK,
  })

  const ctx = harness.makeCtx({ issue: 31, pr: 310 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'completed')
  assert.strictEqual(ctx.metrics.pr_review_iters, 2)

  const g = ctx.gate_findings['pr-review']
  assert.strictEqual(g.count, 1) // only iteration 1's single major finding
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.severity)), { critical: 0, major: 1, minor: 0 })
  // Accumulated, not overwritten: one 're-litigated' (iter 1) + one 'accepted' (iter 2).
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.disposition)), { 're-litigated': 1, accepted: 1 })

  const keys = context.agent.calls.map(stageKeyOf)
  assert.deepStrictEqual(keys, [
    'spec-review-i1', 'code-review-i1', 'pr-fix-i1', 'simplify-pr-fix-i1-i1', 'quality-review-pr-fix-i1-i1',
    'spec-review-i2', 'code-review-i2', 'commit-sha-probe', 'changed-files-probe', 'merge',
  ])
})

test('reviewAndMerge(): exhausting MAX_PR_REVIEW_ITERATIONS without approval records a "carried-unresolved" disposition and returns needs_human, carrying gate_findings through fail()', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  const CHANGES_REQUESTED = { result: 'changes_requested', comments: 'still not right', issues: [{ severity: 'critical', summary: 'security hole' }], recommended_fix_agent: null, summary: 'needs work' }

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': CHANGES_REQUESTED,
    'pr-fix-i1': FIX_OK,
    'simplify-pr-fix-i1-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i1-i1': QUALITY_REVIEW_APPROVED,
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': CHANGES_REQUESTED,
    'pr-fix-i2': FIX_OK,
    'simplify-pr-fix-i2-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i2-i1': QUALITY_REVIEW_APPROVED,
    // Final iteration: the loop records the outcome and breaks WITHOUT running
    // a pr-fix/quality-loop stage (see reviewAndMerge()'s
    // `if (iter === MAX_PR_REVIEW_ITERATIONS) break` right after
    // recordGateOutcome) — deliberately left unscripted below to prove that.
    'spec-review-i3': APPROVED_REVIEW,
    'code-review-i3': CHANGES_REQUESTED,
  })

  const ctx = harness.makeCtx({ issue: 32, pr: 320 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'pr-review')
  assert.strictEqual(ctx.metrics.pr_review_iters, 3)

  const g = ctx.gate_findings['pr-review']
  assert.strictEqual(g.count, 3) // one critical finding per iteration
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.severity)), { critical: 3, major: 0, minor: 0 })
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.disposition)), { 're-litigated': 2, 'carried-unresolved': 1 })

  // fail() carries ctx.gate_findings through onto the returned result — proven
  // in isolation by tests/gate-findings.test.js; this proves it holds for the
  // REAL pr-review exhaustion path too.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result.gate_findings['pr-review'].disposition)), { 're-litigated': 2, 'carried-unresolved': 1 })

  // No pr-fix-i3/simplify/quality-review must have run — the final iteration
  // breaks immediately after recordGateOutcome, before the fix stage.
  const keys = context.agent.calls.map(stageKeyOf)
  for (const shouldNotRun of ['pr-fix-i3', 'simplify-pr-fix-i3-i1', 'quality-review-pr-fix-i3-i1', 'changed-files-probe', 'merge']) {
    assert.ok(!keys.includes(shouldNotRun), 'stage "' + shouldNotRun + '" must not run once the review cap is exhausted; ran: ' + keys.join(', '))
  }
})
