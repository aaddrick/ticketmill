'use strict'

// Integration tests for the durable per-issue gate-state WRITE path (issue
// #166, task 2): postGateState() itself, and its four call sites wired into
// implementIssue()/reviewAndMerge() (the approach-gate loop, the plan-gate
// loop, the in-loop pr-review post right after recordGateOutcome, and the
// pr-review-death "aborted" post that covers the process_pr resume path).
//
// tests/gate-state.test.js already proves the pure layer this helper is
// built on (buildGateStatePayload/buildGateStateComment/parseGateStateComment
// etc.) in isolation; these tests instead drive postGateState() and its call
// sites through the real control flow (loaded via tests/harness.js, same
// pattern as tests/contrarian-cap.test.js and tests/pr-review-gate.test.js),
// proving:
//   - postGateState is non-fatal in isolation, in both directions (a dead
//     agent, and an explicit posted:false), and sets ctx.gate_state_intent /
//     ctx.gate_state_post_failed correctly for each.
//   - a dead gate-state stage never changes what the SURROUNDING loop does
//     (stage()'s own retry-then-swallow behavior is what makes this true;
//     this proves postGateState doesn't accidentally re-throw or branch on
//     the failure).
//   - the 'approach' boundary posts exactly once, even when the very next
//     stage (plan) dies.
//   - a run that clears both gates posts 'approach' then 'plan', in that
//     order, before IMPLEMENT.
//   - the process_pr resume path (reviewAndMerge called directly, never
//     through the approach/plan loops) posts exactly ONE
//     'pr-review-i1-aborted' block when both reviewers die on iteration 1,
//     and nothing else -- the scenario boundary 4 exists for.
//   - a STOP trip between pr-review iterations posts nothing new for the
//     iteration that never runs.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

const REPO = 'aaddrick/ticketmill-fixture'
const TARGET = 'Batch_2026-07-27_fixture'

function seed(context, overrides) {
  context.__seed(Object.assign({ PROFILE: {}, REPO: REPO, TARGET: TARGET }, overrides))
}

function stageKeyOf(call) {
  const label = (call.opts && call.opts.label) || ''
  return label.slice(label.indexOf(':') + 1)
}

function gateStateKeys(keys) {
  return keys.filter(function (k) { return k.indexOf('gate-state-') === 0 })
}

// Pulls the literal heredoc body back out of a postGateState prompt (the
// exact text between the two TICKETMILL_GATE_STATE_EOF markers -- see
// postGateState's prompt construction in workflows/ticketmill.js) and parses
// it with the real parseGateStateComment, so a test can assert on the ACTUAL
// payload a real postGateState() call built (including its GATE_STATE_WRITE_SEQ-
// derived write_seq), not a hand-crafted fixture.
function extractGateStatePayload(context, prompt, repo, issue) {
  const m = /<<'TICKETMILL_GATE_STATE_EOF'\n([\s\S]*?)\nTICKETMILL_GATE_STATE_EOF/.exec(String(prompt))
  assert.ok(m, 'expected a TICKETMILL_GATE_STATE_EOF heredoc body in the prompt:\n' + prompt)
  const payload = context.parseGateStateComment(m[1], repo, issue)
  assert.ok(payload, 'expected the extracted heredoc body to parse as a valid gate-state comment')
  return payload
}

// ---- postGateState() in isolation ----

test('postGateState: a dead gate-state agent sets gate_state_post_failed (never gate_state_intent), pushes a ctx.deferred note, and returns falsy', async function () {
  const context = harness.boot()
  seed(context)
  harness.installScriptedAgent(context, function () { return null }) // dead every time

  const ctx = harness.makeCtx({ issue: 10 })
  const posted = await context.postGateState(ctx, 'approach')

  assert.ok(!posted, 'a dead agent must not report a live post')
  assert.strictEqual(ctx.gate_state_intent, undefined)
  assert.strictEqual(ctx.gate_state_post_failed, 'approach')
  assert.strictEqual(ctx.deferred.length, 1)
  assert.ok(ctx.deferred[0].includes('approach'), 'expected the deferred note to name the boundary: ' + ctx.deferred[0])
})

test('postGateState: an explicit posted:false leaves gate_state_intent unset and records gate_state_post_failed the same as a dead agent', async function () {
  const context = harness.boot()
  seed(context)
  harness.installScriptedAgent(context, function () { return { posted: false } })

  const ctx = harness.makeCtx({ issue: 11 })
  const posted = await context.postGateState(ctx, 'plan')

  assert.deepStrictEqual(posted, { posted: false })
  assert.strictEqual(ctx.gate_state_intent, undefined)
  assert.strictEqual(ctx.gate_state_post_failed, 'plan')
  assert.strictEqual(ctx.deferred.length, 1)
})

test('postGateState: posted:true sets gate_state_intent to the built payload and never touches gate_state_post_failed', async function () {
  const context = harness.boot()
  seed(context)
  harness.installScriptedAgent(context, function () { return { posted: true } })

  const ctx = harness.makeCtx({ issue: 12, groupId: null })
  const posted = await context.postGateState(ctx, 'pr-review-i2')

  assert.deepStrictEqual(posted, { posted: true })
  assert.strictEqual(ctx.gate_state_post_failed, undefined)
  assert.ok(ctx.gate_state_intent, 'expected gate_state_intent to be set')
  assert.strictEqual(ctx.gate_state_intent.repo, REPO)
  assert.strictEqual(ctx.gate_state_intent.issue, 12)
  assert.strictEqual(ctx.gate_state_intent.batch, TARGET)
  assert.strictEqual(ctx.gate_state_intent.boundary, 'pr-review-i2')
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.gate_state_intent.members)), [12])
  assert.strictEqual(ctx.deferred.length, 0)
})

test('postGateState: pins `gh issue comment <n> --repo <r> --body-file -` fed by a QUOTED heredoc, never an unquoted heredoc or --body "$(...)"', async function () {
  const context = harness.boot()
  seed(context)
  let seenPrompt = null
  harness.installScriptedAgent(context, function (prompt) { seenPrompt = String(prompt); return { posted: true } })

  const ctx = harness.makeCtx({ issue: 13 })
  await context.postGateState(ctx, 'approach')

  assert.ok(seenPrompt.includes('gh issue comment 13 --repo ' + REPO + ' --body-file - <<\'TICKETMILL_GATE_STATE_EOF\''),
    'expected the pinned --body-file heredoc command in the prompt:\n' + seenPrompt)
  // The actual pinned COMMAND line must not itself be the --body "$(...)" form
  // (the prompt's own cautionary prose legitimately mentions that string, so
  // this checks the command line specifically, not the prompt as a whole).
  assert.ok(!seenPrompt.includes('gh issue comment 13 --repo ' + REPO + ' --body "$('), 'the pinned command must not use a --body "$(...)" form')
})

// ---- 'approach' boundary: implementIssue(), approach-gate loop ----

test('implementIssue: a run whose plan stage dies still posts exactly one gate-state "approach" block (posted before the plan stage runs)', async function () {
  const context = harness.boot()
  seed(context)

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '20:setup') return { status: 'success', worktree: '/tmp/fixture-worktree', branch: 'issue-20-fixture' }
    if (label === '20:research') return { status: 'success', context: { issue_title: 'Fixture', issue_body: 'req', related_files: [], dependencies: [], prior_work: '' } }
    if (label === '20:evaluate') return { status: 'success', approach: 'do the thing', rationale: 'because', complexity: 'trivial', risks: [], alternatives_rejected: [], summary: 'initial evaluation' }
    if (label === '20:challenge-approach-i1') return { verdict: 'sound_with_caveats', summary: 'fine', findings: [] }
    if (label === '20:gate-state-approach') return { posted: true }
    // plan agent dies -> implementIssue returns fail(ctx,'halted','plan',...) immediately after.
    if (label === '20:plan') return null
    if (label === '20:halt-note-plan') return { posted: true }
    throw new Error('unexpected stage label: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 20 })
  const result = await context.implementIssue(ctx)

  assert.strictEqual(result.status, 'halted')
  assert.strictEqual(result.stage, 'plan')

  const keys = context.agent.calls.map(stageKeyOf)
  const gateStateCalls = gateStateKeys(keys)
  assert.deepStrictEqual(gateStateCalls, ['gate-state-approach'])
  assert.ok(ctx.gate_state_intent, 'the approach boundary must have posted successfully')
  assert.strictEqual(ctx.gate_state_intent.boundary, 'approach')
})

test('implementIssue: a dead gate-state-approach post changes no loop outcome — the plan stage still runs normally right after it', async function () {
  const context = harness.boot()
  seed(context)

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '25:setup') return { status: 'success', worktree: '/tmp/fixture-worktree', branch: 'issue-25-fixture' }
    if (label === '25:research') return { status: 'success', context: { issue_title: 'Fixture', issue_body: 'req', related_files: [], dependencies: [], prior_work: '' } }
    if (label === '25:evaluate') return { status: 'success', approach: 'do the thing', rationale: 'because', complexity: 'trivial', risks: [], alternatives_rejected: [], summary: 'initial evaluation' }
    if (label === '25:challenge-approach-i1') return { verdict: 'sound_with_caveats', summary: 'fine', findings: [] }
    // The gate-state post dies (STAGE_TRIES-exhausting null); postGateState
    // must swallow this and let the loop's own break stand.
    if (label === '25:gate-state-approach') return null
    // Plan runs regardless -- the dead gate-state stage above must not have
    // halted, skipped, or altered the approach gate's own outcome.
    if (label === '25:plan') return { status: 'error', error: 'stop test here (gate-state death is what is under test)' }
    if (label === '25:halt-note-plan') return { posted: true }
    throw new Error('unexpected stage label: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 25 })
  const result = await context.implementIssue(ctx)

  // The plan stage ran (and failed on its OWN scripted error) -- proving the
  // dead gate-state post did not short-circuit the approach loop's normal
  // break-and-continue.
  assert.strictEqual(result.status, 'failed')
  assert.strictEqual(result.stage, 'plan')
  assert.strictEqual(result.error, 'stop test here (gate-state death is what is under test)')

  // The approach gate itself still settled normally (unaffected by the dead post).
  assert.strictEqual(ctx.settled.length, 1)
  assert.strictEqual(ctx.settled[0].gate, 'approach challenge i1')

  // The dead post is recorded, not silently absorbed.
  assert.strictEqual(ctx.gate_state_intent, undefined)
  assert.strictEqual(ctx.gate_state_post_failed, 'approach')
})

// ---- 'approach' then 'plan', in order, before IMPLEMENT ----

test('implementIssue: a run that clears both gates posts gate-state "approach" then "plan", in that order, before the first task runs', async function () {
  const context = harness.boot()
  seed(context)

  const prompts = {}
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '21:setup') return { status: 'success', worktree: '/tmp/fixture-worktree', branch: 'issue-21-fixture' }
    if (label === '21:research') return { status: 'success', context: { issue_title: 'Fixture', issue_body: 'req', related_files: [], dependencies: [], prior_work: '' } }
    if (label === '21:evaluate') return { status: 'success', approach: 'do the thing', rationale: 'because', complexity: 'trivial', risks: [], alternatives_rejected: [], summary: 'initial evaluation' }
    if (label === '21:challenge-approach-i1') return { verdict: 'sound_with_caveats', summary: 'fine', findings: [] }
    if (label === '21:gate-state-approach') { prompts.approach = prompt; return { posted: true } }
    if (label === '21:plan') return { status: 'success', summary: 'planned', tasks: [{ id: 1, description: 'Implement the fixture feature', agent: 'implementer' }], task_list_markdown: '' }
    if (label === '21:challenge-plan-i1') return { verdict: 'sound_with_caveats', summary: 'fine', findings: [] }
    if (label === '21:gate-state-plan') { prompts.plan = prompt; return { posted: true } }
    // Fail the first task immediately so the test doesn't have to script the
    // rest of IMPLEMENT — only the ordering of the two gate-state posts above it is under test.
    if (label === '21:task-1-implement') return { status: 'error', summary: 'forced failure', error: 'stop test here' }
    if (label === '21:halt-note-implement') return { posted: true }
    throw new Error('unexpected stage label: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 21 })
  const result = await context.implementIssue(ctx)

  assert.strictEqual(result.status, 'failed')
  assert.strictEqual(result.stage, 'implement')

  const keys = context.agent.calls.map(stageKeyOf)
  const gateStateCalls = gateStateKeys(keys)
  assert.deepStrictEqual(gateStateCalls, ['gate-state-approach', 'gate-state-plan'])
  // Both boundaries land BEFORE the first task-implement stage.
  assert.ok(keys.indexOf('gate-state-plan') < keys.indexOf('task-1-implement'))

  // GATE_STATE_WRITE_SEQ (module-level, ++'d on every real postGateState()
  // call) must have actually advanced across these two same-run writes, not
  // just been present. RUN_EPOCH is identical for both (same run), so
  // write_seq is the ONLY thing diffGateStateIntent can use to order two
  // same-run boundaries against each other -- a regression that reverted the
  // increment to a static value (e.g. always null, or always the same
  // number) would leave every other assertion in this suite green while
  // silently breaking same-run ordering.
  const approachPayload = extractGateStatePayload(context, prompts.approach, REPO, 21)
  const planPayload = extractGateStatePayload(context, prompts.plan, REPO, 21)
  assert.strictEqual(typeof approachPayload.write_seq, 'number', 'expected a real numeric write_seq, not null/undefined')
  assert.strictEqual(planPayload.write_seq, approachPayload.write_seq + 1,
    'expected the module-level GATE_STATE_WRITE_SEQ counter to advance by exactly 1 between the two real postGateState() calls in this run')
})

// ---- exactly one gate-state stage per pr-review iteration ----

test('reviewAndMerge: posts exactly one gate-state stage per pr-review iteration, in iteration order, across three iterations', async function () {
  const context = harness.boot()
  seed(context, { TEST_CMD: null })

  const CHANGES_REQUESTED = { result: 'changes_requested', comments: 'needs work', issues: [{ severity: 'critical', summary: 'security hole' }], recommended_fix_agent: null, summary: 'needs work' }
  const APPROVED = { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'fine' }
  const FIX_OK = { status: 'success', commit: 'deadbeef', files_changed: [], fixes_applied: ['fixed it'], summary: 'fixed', error: null }
  const SIMPLIFY_OK = { status: 'success', commit: null, files_changed: [], summary: 'nothing to simplify' }
  const QUALITY_APPROVED = { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'clean' }

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '26:spec-review-i1') return APPROVED
    if (label === '26:code-review-i1') return CHANGES_REQUESTED
    if (label === '26:gate-state-pr-review-i1') return { posted: true }
    if (label === '26:pr-fix-i1') return FIX_OK
    if (label === '26:simplify-pr-fix-i1-i1') return SIMPLIFY_OK
    if (label === '26:quality-review-pr-fix-i1-i1') return QUALITY_APPROVED
    if (label === '26:spec-review-i2') return APPROVED
    if (label === '26:code-review-i2') return CHANGES_REQUESTED
    if (label === '26:gate-state-pr-review-i2') return { posted: true }
    if (label === '26:pr-fix-i2') return FIX_OK
    if (label === '26:simplify-pr-fix-i2-i1') return SIMPLIFY_OK
    if (label === '26:quality-review-pr-fix-i2-i1') return QUALITY_APPROVED
    // iteration 3 = MAX_PR_REVIEW_ITERATIONS -> the cap breaks WITHOUT a fix stage.
    if (label === '26:spec-review-i3') return APPROVED
    if (label === '26:code-review-i3') return CHANGES_REQUESTED
    if (label === '26:gate-state-pr-review-i3') return { posted: true }
    throw new Error('unexpected stage label: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 26, pr: 260 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(ctx.metrics.pr_review_iters, 3)

  const keys = context.agent.calls.map(stageKeyOf)
  const gateStateCalls = gateStateKeys(keys)
  assert.deepStrictEqual(gateStateCalls, ['gate-state-pr-review-i1', 'gate-state-pr-review-i2', 'gate-state-pr-review-i3'])
})

// ---- boundary 4: process_pr resume, reviewers die on iteration 1 ----

test('processIssue: a process_pr resume whose reviewers both die on iteration 1 posts exactly one "pr-review-i1-aborted" gate-state block and no other', async function () {
  const context = harness.boot()
  seed(context, { ROOT: '/tmp/ticketmill-fixture-root' })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '22:setup-for-review') return { status: 'success', worktree: '/tmp/fixture-worktree', branch: 'issue-22-fixture' }
    if (label === '22:spec-review-i1') return null // reviewer died
    if (label === '22:code-review-i1') return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'fine' }
    if (label === '22:gate-state-pr-review-i1-aborted') return { posted: true }
    if (label === '22:halt-note-pr-review') return { posted: true }
    throw new Error('unexpected stage label: ' + label)
  })

  const pre = { issue: 22, title: 'Fixture', branch: '', pr_number: 220, resume_point: 'process_pr', reason: 'open PR found on resume' }
  const result = await context.processIssue(pre)

  assert.strictEqual(result.status, 'needs_human')
  assert.strictEqual(result.stage, 'pr-review')

  const keys = context.agent.calls.map(stageKeyOf)
  const gateStateCalls = gateStateKeys(keys)
  // Exactly the aborted boundary -- never 'gate-state-approach'/'gate-state-plan'
  // (this resume path never runs implementIssue at all), and never the
  // in-loop 'gate-state-pr-review-i1' (the reviewers never both returned).
  assert.deepStrictEqual(gateStateCalls, ['gate-state-pr-review-i1-aborted'])
  assert.strictEqual(result.gate_state_intent.boundary, 'pr-review-i1-aborted')
})

// ---- STOP trip between pr-review iterations ----

test('reviewAndMerge: STOP trips during iteration 1 posts nothing new for the iteration-2 boundary that never runs', async function () {
  const context = harness.boot()
  seed(context, { TEST_CMD: null })

  const CHANGES_REQUESTED = { result: 'changes_requested', comments: 'needs work', issues: [{ severity: 'major', summary: 'thing to fix' }], recommended_fix_agent: null, summary: 'needs a fix' }

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '23:spec-review-i1') return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'fine' }
    if (label === '23:code-review-i1') return CHANGES_REQUESTED
    if (label === '23:gate-state-pr-review-i1') return { posted: true }
    if (label === '23:pr-fix-i1') return { status: 'success', commit: 'deadbeef', files_changed: [], fixes_applied: ['fixed it'], summary: 'fixed', error: null }
    if (label === '23:simplify-pr-fix-i1-i1') return { status: 'success', commit: null, files_changed: [], summary: 'nothing to simplify' }
    if (label === '23:quality-review-pr-fix-i1-i1') {
      // Trip STOP as a side effect right after the last stage of iteration 1 —
      // iteration 2 must see it at the loop's own STOP check, before any
      // review or gate-state stage for i2 runs.
      harness.readGlobal(context, 'STOP.tripped = true; STOP.reason = "test stop"')
      return { result: 'approved', comments: '', issues: [], recommended_fix_agent: null, summary: 'clean' }
    }
    throw new Error('unexpected stage label: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 23, pr: 230 })
  const result = await context.reviewAndMerge(ctx)

  assert.strictEqual(result.status, 'halted')
  assert.strictEqual(result.stage, 'pr-review')

  const keys = context.agent.calls.map(stageKeyOf)
  const gateStateCalls = gateStateKeys(keys)
  assert.deepStrictEqual(gateStateCalls, ['gate-state-pr-review-i1'])
  assert.ok(!keys.includes('spec-review-i2'), 'iteration 2 must never start once STOP has tripped')
})

// ---- shape totality on the resume_point==='skip' return ----

test('processIssue: the resume_point==="skip" return always carries gate_state_intent/gate_state_post_failed as null (no boundary can fire on this path)', async function () {
  const context = harness.boot()
  seed(context)
  harness.installScriptedAgent(context, function () { throw new Error('no agent call should happen on the skip path') })

  const pre = { issue: 24, title: 'Fixture', resume_point: 'skip', reason: 'already merged', pr_state: 'open', pr_base: null }
  const result = await context.processIssue(pre)

  assert.strictEqual(result.status, 'skipped')
  assert.strictEqual(result.gate_state_intent, null)
  assert.strictEqual(result.gate_state_post_failed, null)
})
