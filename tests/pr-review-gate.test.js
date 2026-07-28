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
const GATE_STATE_POSTED = { posted: true }

test('reviewAndMerge(): a clean pr-review approval on iteration 1 records an "accepted" disposition in ctx.gate_findings["pr-review"], tallying both reviewers\' issues', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    // 'approved' can still carry nit-level issues — the disposition is driven
    // by .result alone, not by issues being empty.
    'code-review-i1': Object.assign({}, APPROVED_REVIEW, { issues: [{ severity: 'minor', summary: 'nit: naming' }] }),
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
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
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    'pr-fix-i1': FIX_OK,
    'simplify-pr-fix-i1-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i1-i1': QUALITY_REVIEW_APPROVED,
    // ---- iteration 2: both approve ----
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': APPROVED_REVIEW,
    'gate-state-pr-review-i2': GATE_STATE_POSTED,
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

  // One gate-state stage per pr-review iteration (issue #166 task 2), posted
  // right after each iteration's recordGateOutcome — in this scenario that's
  // exactly two: 'gate-state-pr-review-i1' then 'gate-state-pr-review-i2'.
  const keys = context.agent.calls.map(stageKeyOf)
  assert.deepStrictEqual(keys, [
    'spec-review-i1', 'code-review-i1', 'gate-state-pr-review-i1', 'pr-fix-i1', 'simplify-pr-fix-i1-i1', 'quality-review-pr-fix-i1-i1',
    'spec-review-i2', 'code-review-i2', 'gate-state-pr-review-i2', 'commit-sha-probe', 'changed-files-probe', 'merge',
  ])
})

test('reviewAndMerge(): exhausting MAX_PR_REVIEW_ITERATIONS without approval records a "carried-unresolved" disposition and returns needs_human, carrying gate_findings through fail()', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  const CHANGES_REQUESTED = { result: 'changes_requested', comments: 'still not right', issues: [{ severity: 'critical', summary: 'security hole' }], recommended_fix_agent: null, summary: 'needs work' }

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': CHANGES_REQUESTED,
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    'pr-fix-i1': FIX_OK,
    'simplify-pr-fix-i1-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i1-i1': QUALITY_REVIEW_APPROVED,
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': CHANGES_REQUESTED,
    'gate-state-pr-review-i2': GATE_STATE_POSTED,
    'pr-fix-i2': FIX_OK,
    'simplify-pr-fix-i2-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i2-i1': QUALITY_REVIEW_APPROVED,
    // Final iteration: the loop records the outcome (and its gate-state post)
    // and breaks WITHOUT running a pr-fix/quality-loop stage (see
    // reviewAndMerge()'s `if (capReached) break` right after
    // recordGateOutcome/postGateState) — pr-fix-i3 etc. are deliberately left
    // unscripted below to prove that.
    'spec-review-i3': APPROVED_REVIEW,
    'code-review-i3': CHANGES_REQUESTED,
    'gate-state-pr-review-i3': GATE_STATE_POSTED,
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

// ---- issue #162 task 2: the "both reviewers have nothing to fix, but that
// isn't prReviewClean" early exit (nothingToFix, bothNothingToFix) ----

test('reviewAndMerge(): both reviewers changes_requested with issues:[] breaks early as "carried-unresolved" without ever running pr-fix or merge', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  const EMPTY_CHANGES_REQUESTED = { result: 'changes_requested', comments: 'not quite right, but nothing concrete to name', issues: [], recommended_fix_agent: null, summary: 'needs work, no specifics' }

  installScriptedResponder(context, {
    'spec-review-i1': EMPTY_CHANGES_REQUESTED,
    'code-review-i1': EMPTY_CHANGES_REQUESTED,
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    // pr-fix-i1/merge deliberately unscripted below — proving neither runs.
  })

  const ctx = harness.makeCtx({ issue: 33, pr: 330 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'pr-review')
  assert.strictEqual(ctx.metrics.pr_review_iters, 1)
  assert.strictEqual(ctx.metrics.findings_empty_exits, 1)

  const g = ctx.gate_findings['pr-review']
  assert.strictEqual(g.count, 0)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.disposition)), { 'carried-unresolved': 1 })

  // The gate-state post runs INSIDE the loop, right after recordGateOutcome —
  // before the bothNothingToFix early break — so it fires here too, even
  // though pr-fix/merge never run. fail() posts a best-effort halt note
  // (halt-note-pr-review) after that.
  const keys = context.agent.calls.map(stageKeyOf)
  assert.deepStrictEqual(keys, ['spec-review-i1', 'code-review-i1', 'gate-state-pr-review-i1', 'halt-note-pr-review'])
  for (const shouldNotRun of ['pr-fix-i1', 'merge']) {
    assert.ok(!keys.includes(shouldNotRun), 'stage "' + shouldNotRun + '" must not run; ran: ' + keys.join(', '))
  }
})

// nothingToFix(r, f) = r.result === 'approved' || (f !== null && f.length === 0)
// — the doc comment above it is explicit that an approval counts as
// nothing-to-fix "regardless of what issues carries alongside an approval".
// Every OTHER fixture in this file with an approved reviewer also happens to
// carry issues: [], which independently satisfies the function's second
// branch, so none of them can isolate the `r.result === 'approved' ||` half
// of the OR: deleting it would not change their outcome. This scenario gives
// the approved reviewer a NON-EMPTY issues array (a nit alongside the
// approval) specifically so only the 'approved' branch can explain
// nothingToFix returning true for it — a mutant deleting that branch would
// flip bothNothingToFix to false here and send the loop into pr-fix instead
// of halting early.
test('reviewAndMerge(): spec approved-with-a-nit + code changes_requested-with-issues:[] still breaks early as "carried-unresolved" (isolates the approved branch of nothingToFix from the empty-array branch)', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  const APPROVED_WITH_NIT = Object.assign({}, APPROVED_REVIEW, { issues: [{ severity: 'minor', summary: 'nit: naming' }] })
  const EMPTY_CHANGES_REQUESTED = { result: 'changes_requested', comments: 'not quite right, but nothing concrete to name', issues: [], recommended_fix_agent: null, summary: 'needs work, no specifics' }

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_WITH_NIT,
    'code-review-i1': EMPTY_CHANGES_REQUESTED,
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    // pr-fix-i1/merge deliberately unscripted below — proving neither runs.
  })

  const ctx = harness.makeCtx({ issue: 39, pr: 390 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'pr-review')
  assert.strictEqual(ctx.metrics.pr_review_iters, 1)
  assert.strictEqual(ctx.metrics.findings_empty_exits, 1)

  const g = ctx.gate_findings['pr-review']
  // The spec reviewer's nit still tallies (recordGateOutcome runs regardless
  // of disposition) — only the DISPOSITION is under test here.
  assert.strictEqual(g.count, 1)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.disposition)), { 'carried-unresolved': 1 })

  const keys = context.agent.calls.map(stageKeyOf)
  assert.deepStrictEqual(keys, ['spec-review-i1', 'code-review-i1', 'gate-state-pr-review-i1', 'halt-note-pr-review'])
  for (const shouldNotRun of ['pr-fix-i1', 'merge']) {
    assert.ok(!keys.includes(shouldNotRun), 'stage "' + shouldNotRun + '" must not run; ran: ' + keys.join(', '))
  }
})

test('reviewAndMerge(): one reviewer with issues:[] and the other with real findings still runs pr-fix-i1, carrying both the rendered finding and the empty reviewer\'s explicit no-findings line plus prose', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  const EMPTY_CHANGES_REQUESTED = { result: 'changes_requested', comments: 'vague unease, nothing concrete', issues: [], recommended_fix_agent: null, summary: 'needs work, no specifics' }
  const CONCRETE_FINDING = { result: 'changes_requested', comments: 'see the finding below', issues: [{ severity: 'major', summary: 'unhandled null path', recommendation: 'add a guard' }], recommended_fix_agent: null, summary: 'one concrete issue' }

  installScriptedResponder(context, {
    'spec-review-i1': EMPTY_CHANGES_REQUESTED,
    'code-review-i1': CONCRETE_FINDING,
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    'pr-fix-i1': FIX_OK,
    'simplify-pr-fix-i1-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i1-i1': QUALITY_REVIEW_APPROVED,
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': APPROVED_REVIEW,
    'gate-state-pr-review-i2': GATE_STATE_POSTED,
    'commit-sha-probe': COMMIT_PROBE_OK,
    'changed-files-probe': CHANGED_FILES_PROBE_OK,
    merge: MERGE_OK,
  })

  const ctx = harness.makeCtx({ issue: 34, pr: 340 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'completed')
  // bothNothingToFix must be false (spec had nothing, code had a real finding),
  // so the loop fell through to the fix stage, not the early carried-unresolved exit.
  assert.strictEqual(ctx.metrics.findings_empty_exits, 0)

  const prFixCall = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'pr-fix-i1' })
  assert.ok(prFixCall, 'pr-fix-i1 must have run')
  const prompt = String(prFixCall.prompt)
  // The code reviewer's real finding is rendered as a work-list line (id + severity + summary).
  assert.ok(/\[code-i1-1\] \[major\] unhandled null path -> add a guard/.test(prompt), 'expected the rendered code-review finding line in the pr-fix prompt:\n' + prompt)
  // The spec reviewer's empty findings array still renders its explicit no-findings line...
  assert.ok(prompt.includes('(reviewer named no structured findings)'), 'expected the empty-reviewer no-findings line in the pr-fix prompt')
  // ...and its prose comment stays present underneath, as context.
  assert.ok(prompt.includes('vague unease, nothing concrete'), 'expected the empty reviewer\'s prose comment preserved as context in the pr-fix prompt')
})

test('reviewAndMerge(): both reviewers changes_requested with `issues` omitted entirely still runs pr-fix-i1 (prose-only fallback), not the empty-findings exit', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  // `issues` is deliberately absent from these objects (not `[]`) — the third
  // leg of the null-versus-empty pin: normalizeFindings(undefined, ...) must
  // return null, not [], so nothingToFix treats an omitted key as NOT
  // "nothing to fix" (prose-only changes_requested still routes to a fix).
  const OMITTED_ISSUES = { result: 'changes_requested', comments: 'please revisit the error handling', recommended_fix_agent: null, summary: 'needs work' }

  installScriptedResponder(context, {
    'spec-review-i1': OMITTED_ISSUES,
    'code-review-i1': OMITTED_ISSUES,
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    'pr-fix-i1': FIX_OK,
    'simplify-pr-fix-i1-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i1-i1': QUALITY_REVIEW_APPROVED,
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': APPROVED_REVIEW,
    'gate-state-pr-review-i2': GATE_STATE_POSTED,
    'commit-sha-probe': COMMIT_PROBE_OK,
    'changed-files-probe': CHANGED_FILES_PROBE_OK,
    merge: MERGE_OK,
  })

  const ctx = harness.makeCtx({ issue: 35, pr: 350 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'completed')
  assert.strictEqual(ctx.metrics.findings_empty_exits, 0)

  const keys = context.agent.calls.map(stageKeyOf)
  assert.ok(keys.includes('pr-fix-i1'), 'pr-fix-i1 must run for an omitted-issues prose-only changes_requested; ran: ' + keys.join(', '))
  assert.ok(keys.includes('merge'), 'merge must eventually run; ran: ' + keys.join(', '))

  const prFixCall = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'pr-fix-i1' })
  // findingsBlock's null branch: byte-identical to the pre-#162 prose-only prompt.
  assert.ok(String(prFixCall.prompt).includes('please revisit the error handling'), 'expected the omitted-issues reviewer\'s prose to flow through byte-identically')
})

// ---- issue #162 task 2: a dead reviewer at REVIEW_SCHEMA's tightened call site ----

test('reviewAndMerge(): a null spec reviewer fails needs_human at stage "pr-review" without ever running merge', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': null,
    'code-review-i1': APPROVED_REVIEW,
    'gate-state-pr-review-i1-aborted': GATE_STATE_POSTED,
  })

  const ctx = harness.makeCtx({ issue: 36, pr: 360 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'pr-review')
  const keys = context.agent.calls.map(stageKeyOf)
  assert.ok(!keys.includes('merge'), 'merge must never run when the spec reviewer died; ran: ' + keys.join(', '))
  // A dead reviewer is exactly the "aborted" gate-state boundary (issue #166
  // task 2, site 4) — this is the resume-covering post, distinct from the
  // in-loop 'gate-state-pr-review-i1' post that only fires after a clean
  // spec+code pair.
  assert.ok(keys.includes('gate-state-pr-review-i1-aborted'), 'expected the aborted gate-state boundary to post; ran: ' + keys.join(', '))
  assert.ok(!keys.includes('gate-state-pr-review-i1'), 'the non-aborted in-loop boundary must not also fire; ran: ' + keys.join(', '))
})

test('reviewAndMerge(): a null code reviewer fails needs_human at stage "pr-review" without ever running merge', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': null,
    'gate-state-pr-review-i1-aborted': GATE_STATE_POSTED,
  })

  const ctx = harness.makeCtx({ issue: 37, pr: 370 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'pr-review')
  const keys = context.agent.calls.map(stageKeyOf)
  assert.ok(!keys.includes('merge'), 'merge must never run when the code reviewer died; ran: ' + keys.join(', '))
  assert.ok(keys.includes('gate-state-pr-review-i1-aborted'), 'expected the aborted gate-state boundary to post; ran: ' + keys.join(', '))
})

// ---- issue #162 task 2: severity is no longer permanently zero ----

test('reviewAndMerge(): a typed mixed-severity issues array makes gate_findings["pr-review"].severity report real, non-zero counts', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': { result: 'changes_requested', comments: '', issues: [
      { severity: 'critical', summary: 'auth bypass' },
      { severity: 'minor', summary: 'typo in error message' },
    ], recommended_fix_agent: null, summary: 'two spec findings' },
    'code-review-i1': { result: 'changes_requested', comments: '', issues: [
      { severity: 'major', summary: 'missing input validation', recommendation: 'validate before use' },
    ], recommended_fix_agent: null, summary: 'one code finding' },
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    'pr-fix-i1': FIX_OK,
    'simplify-pr-fix-i1-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i1-i1': QUALITY_REVIEW_APPROVED,
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': APPROVED_REVIEW,
    'gate-state-pr-review-i2': GATE_STATE_POSTED,
    'commit-sha-probe': COMMIT_PROBE_OK,
    'changed-files-probe': CHANGED_FILES_PROBE_OK,
    merge: MERGE_OK,
  })

  const ctx = harness.makeCtx({ issue: 38, pr: 380 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'completed')
  const g = ctx.gate_findings['pr-review']
  assert.strictEqual(g.count, 3)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.severity)), { critical: 1, major: 1, minor: 1 })
})

// ---- issue #167: the finding-hypothesis framing and the rebuttal-only exit
// at the pr-review merge gate — the ONE evaluator-fed gate that CONTINUES
// (rather than exiting the loop like quality/test) on a rebuttal-only round,
// because pr-review is a multi-iteration loop with another reviewer pair
// waiting downstream, not a terminal fix gate. ----

const REBUTTAL_ONLY_FIX = {
  status: 'success', commit: null, files_changed: [], fixes_applied: [], summary: 'disagree, guard already exists',
  rebutted: [{ finding_id: 'code-i1-1', evidence: 'ran the reproducer at src/foo.js:12 — the guard already covers this input' }],
}
const CODE_FINDING = { result: 'changes_requested', comments: 'fix the guard', issues: [{ severity: 'major', summary: 'missing null check', recommendation: 'add a guard' }], recommended_fix_agent: null, summary: 'one issue' }

test('reviewAndMerge(): a rebuttal-only pr-fix round at i1 continues into i2 (not needs_human), retypes the disposition to "carried-unresolved", records a contested entry, skips runQualityLoop, and a clean i2 approves and merges with the Verification Gaps line still present', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': CODE_FINDING,
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    'pr-fix-i1': REBUTTAL_ONLY_FIX,
    // simplify-pr-fix-i1-i1 / quality-review-pr-fix-i1-i1 deliberately
    // unscripted below — proving runQualityLoop never runs on a rebuttal-only
    // round (the `continue` must precede that call).
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': APPROVED_REVIEW,
    'gate-state-pr-review-i2': GATE_STATE_POSTED,
    'changed-files-probe': CHANGED_FILES_PROBE_OK,
    merge: MERGE_OK,
  })

  const ctx = harness.makeCtx({ issue: 40, pr: 400 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'completed')
  assert.strictEqual(ctx.metrics.pr_review_iters, 2)
  assert.strictEqual(ctx.metrics.rebuttal_only_rounds, 1)

  // Iteration 1 booked 're-litigated' (a real finding, cap not reached), then
  // the rebuttal-only exit retypes that same bucket to 'carried-unresolved';
  // iteration 2 books 'accepted'. Never a fresh double-booked entry.
  const g = ctx.gate_findings['pr-review']
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.disposition)), { 'carried-unresolved': 1, accepted: 1 })

  assert.strictEqual(ctx.contested.length, 1)
  assert.strictEqual(ctx.contested[0].gate, 'pr-review')
  assert.strictEqual(ctx.contested[0].id, 'code-i1-1')
  assert.ok(ctx.contested[0].evidence.includes('ran the reproducer'))

  // NO second pushDecision for the rebuttal-only round — the existing "PR
  // Review Fix (i1)" decision (pushed for every non-error fix) already
  // renders the fixer's summary.
  assert.strictEqual(ctx.decisions.filter(function (d) { return d.entry.includes('PR Review Fix (i1)') }).length, 1)
  assert.ok(!ctx.decisions.some(function (d) { return d.entry.includes('Gate: findings contested') }), 'pr-review must not push a second decision for a rebuttal-only round: ' + JSON.stringify(ctx.decisions))

  const skips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.ok(skips.some(function (s) { return /PR review fix \(iteration 1\)/.test(s) }), 'expected a rebuttal-only VERIFY_SKIPS line: ' + JSON.stringify(skips))

  const keys = context.agent.calls.map(stageKeyOf)
  assert.deepStrictEqual(keys, [
    'spec-review-i1', 'code-review-i1', 'gate-state-pr-review-i1', 'pr-fix-i1',
    'spec-review-i2', 'code-review-i2', 'gate-state-pr-review-i2',
    'changed-files-probe', 'merge',
  ])
  for (const shouldNotRun of ['simplify-pr-fix-i1-i1', 'quality-review-pr-fix-i1-i1']) {
    assert.ok(!keys.includes(shouldNotRun), 'stage "' + shouldNotRun + '" must not run on a rebuttal-only round; ran: ' + keys.join(', '))
  }

  // The i2 reviewer prompts must carry the contested block so both i2
  // reviewers see the disputed finding.
  const spec2 = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'spec-review-i2' })
  const code2 = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'code-review-i2' })
  assert.ok(String(spec2.prompt).includes('Contested findings'), 'expected the contested block in the i2 spec-review prompt')
  assert.ok(String(code2.prompt).includes('Contested findings'), 'expected the contested block in the i2 code-review prompt')

  // The pr-fix-i1 prompt itself must carry FINDING_HYPOTHESIS_ASK, and NOT
  // any gate-specific immediate-exit wording — the framing is deliberately
  // gate-agnostic since pr-review, unlike quality/test, continues rather
  // than exiting on a rebuttal-only round.
  const fix1 = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'pr-fix-i1' })
  const fixPrompt = String(fix1.prompt)
  assert.ok(fixPrompt.includes('HYPOTHESIS the reviewer formed'), 'expected FINDING_HYPOTHESIS_ASK in the pr-fix prompt')
  assert.ok(!fixPrompt.includes('ends this gate immediately'), 'the framing must stay gate-agnostic (no immediate-exit wording): ' + fixPrompt.slice(0, 2000))
  assert.ok(!fixPrompt.includes('no further fix round'), 'the framing must stay gate-agnostic (no immediate-exit wording): ' + fixPrompt.slice(0, 2000))
})

test('reviewAndMerge(): a second rebuttal-only pr-fix round halts needs_human with the PR left open — only ONE rebuttal-only round is permitted per issue', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  function rebuttalFix(id) {
    return {
      status: 'success', commit: null, files_changed: [], fixes_applied: [], summary: 'disagree again',
      rebutted: [{ finding_id: id, evidence: 'ran the reproducer, guard already covers this input' }],
    }
  }

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': CODE_FINDING,
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    'pr-fix-i1': rebuttalFix('code-i1-1'),
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': CODE_FINDING,
    'gate-state-pr-review-i2': GATE_STATE_POSTED,
    'pr-fix-i2': rebuttalFix('code-i2-1'),
    // spec-review-i3/code-review-i3/merge deliberately unscripted below —
    // proving the halt happens without a third review iteration or a merge.
  })

  const ctx = harness.makeCtx({ issue: 41, pr: 410 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'pr-review')
  assert.match(result.error || '', /second rebuttal-only/)
  assert.strictEqual(ctx.metrics.pr_review_iters, 2)
  // Only the FIRST rebuttal-only round counts — the second is a halt, not a
  // recorded round.
  assert.strictEqual(ctx.metrics.rebuttal_only_rounds, 1)

  const keys = context.agent.calls.map(stageKeyOf)
  assert.deepStrictEqual(keys, [
    'spec-review-i1', 'code-review-i1', 'gate-state-pr-review-i1', 'pr-fix-i1',
    'spec-review-i2', 'code-review-i2', 'gate-state-pr-review-i2', 'pr-fix-i2',
    'halt-note-pr-review',
  ])
  assert.ok(!keys.includes('merge'), 'merge must never run — the PR is left open; ran: ' + keys.join(', '))
})

test('reviewAndMerge(): FINDING_HYPOTHESIS_ASK renders in the pr-fix prompt when only ONE reviewer returned structured findings (the other approved via prose, `issues` omitted)', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  const SPEC_FINDING = { result: 'changes_requested', comments: 'goal not fully met', issues: [{ severity: 'major', summary: 'missing acceptance criterion', recommendation: 'implement it' }], recommended_fix_agent: null, summary: 'one spec finding' }
  // `issues` deliberately omitted (not `[]`) — codeFindings normalizes to
  // null, isolating the `specFindings !== null || codeFindings !== null` OR.
  const CODE_APPROVED_NO_ISSUES_KEY = { result: 'approved', comments: '', recommended_fix_agent: null, summary: 'looks fine' }

  installScriptedResponder(context, {
    'spec-review-i1': SPEC_FINDING,
    'code-review-i1': CODE_APPROVED_NO_ISSUES_KEY,
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    'pr-fix-i1': FIX_OK,
    'simplify-pr-fix-i1-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i1-i1': QUALITY_REVIEW_APPROVED,
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': APPROVED_REVIEW,
    'gate-state-pr-review-i2': GATE_STATE_POSTED,
    'commit-sha-probe': COMMIT_PROBE_OK,
    'changed-files-probe': CHANGED_FILES_PROBE_OK,
    merge: MERGE_OK,
  })

  const ctx = harness.makeCtx({ issue: 42, pr: 420 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'completed')
  const fixCall = context.agent.calls.find(function (c) { return stageKeyOf(c) === 'pr-fix-i1' })
  assert.ok(fixCall, 'pr-fix-i1 must have run')
  assert.ok(String(fixCall.prompt).includes('HYPOTHESIS the reviewer formed'), 'expected FINDING_HYPOTHESIS_ASK to render when even one reviewer returned structured findings: ' + String(fixCall.prompt).slice(0, 2000))
})

test('reviewAndMerge(): a pr-fix response that omits `rebutted` entirely never triggers the rebuttal-only exit, even with empty fixes_applied/files_changed — byte-identical to pre-#167 behavior', async function () {
  const context = harness.boot()
  seedReviewFlow(context)

  // No `rebutted` key at all — mirrors every fixer response before issue #167.
  const NO_REBUTTED_FIX = { status: 'success', commit: 'deadbeef', files_changed: [], fixes_applied: [], summary: 'looked into it, nothing needed changing' }

  installScriptedResponder(context, {
    'spec-review-i1': APPROVED_REVIEW,
    'code-review-i1': CODE_FINDING,
    'gate-state-pr-review-i1': GATE_STATE_POSTED,
    'pr-fix-i1': NO_REBUTTED_FIX,
    'simplify-pr-fix-i1-i1': SIMPLIFY_OK,
    'quality-review-pr-fix-i1-i1': QUALITY_REVIEW_APPROVED,
    'commit-sha-probe': COMMIT_PROBE_OK,
    'spec-review-i2': APPROVED_REVIEW,
    'code-review-i2': APPROVED_REVIEW,
    'gate-state-pr-review-i2': GATE_STATE_POSTED,
    'changed-files-probe': CHANGED_FILES_PROBE_OK,
    merge: MERGE_OK,
  })

  const ctx = harness.makeCtx({ issue: 43, pr: 430 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'completed')
  assert.strictEqual(ctx.metrics.rebuttal_only_rounds, 0)
  assert.ok(!ctx.contested || ctx.contested.length === 0)

  // runQualityLoop DID run — proves the loop fell through to the normal path,
  // not the rebuttal-only `continue` branch.
  const keys = context.agent.calls.map(stageKeyOf)
  assert.ok(keys.includes('simplify-pr-fix-i1-i1'), 'runQualityLoop must run when `rebutted` is omitted; ran: ' + keys.join(', '))
  assert.ok(keys.includes('quality-review-pr-fix-i1-i1'), 'runQualityLoop must run when `rebutted` is omitted; ran: ' + keys.join(', '))
})
