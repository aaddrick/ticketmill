'use strict'

// Regression tests for issue #48, which shipped two lockstep fixes:
//
// FIX 2 (contrarianCapFor): contrarianCapFor(complexity) is the pure helper
// (declared above the TICKETMILL-TEST-HARNESS-SPLIT marker in workflows/
// ticketmill.js) that derives the per-gate contrarian iteration cap from the
// module-level `let MAX_CONTRARIAN_ITERATIONS` binding — 'trivial' issues get
// Math.min(2, MAX_CONTRARIAN_ITERATIONS), everything else gets MAX_CONTRARIAN_
// ITERATIONS unchanged. Before issue #48, MAX_CONTRARIAN_ITERATIONS was a hardcoded
// const (3); it is now a `let` a profile can raise or lower via the optional
// profile.contrarian_max_iterations field, read/validated at Select time and
// assigned into the same binding contrarianCapFor() reads.
//
// contrarianCapFor() itself needs no seeding to reach — it's a plain declaration
// the harness loads directly. Varying MAX_CONTRARIAN_ITERATIONS uses __seed(),
// the same test-only seam every other Select-populated `let` uses (see
// tests/harness.js's module comment and e.g. tests/scope-guard.test.js's REPO
// seeding) — it mirrors what the real Select-time profile read does, just
// without running the profile-parse agent call.
//
// NOTE on the profile validation itself (Number.isInteger(cmi) && cmi >= 1, else
// throw): that check lives inside the Select phase, below the harness split
// marker (harness.boot() only loads declarations above `phase('Select')`), so it
// is not reachable through this harness — there is no pure/extractable seam for
// it the way contrarianCapFor() has. Exercising it would require either running
// the untruncated engine as a real Workflow (out of scope for this unit harness)
// or duplicating the validation logic outside the engine, which would test a
// copy, not the real thing. Left unassessed here per the task's "if reachable"
// qualifier.
//
// FIX 1 (surface cap-outs): in implementIssue's approach and plan contrarian
// loops, the branch taken when a gate hits its iteration cap without full
// acceptance (`if (iter === challengeCap) { ... }`) must push both an
// ctx.unresolved entry (carried into the first task's prompt) AND a VERIFY_SKIPS
// entry (surfaced in the batch PR's Verification Gaps section) — before this fix
// only ctx.unresolved was populated, so a cap-out was buried in the decision
// chain and never reached the human reviewer. implementIssue is declared above
// the harness split marker, so it can be driven end-to-end with a scripted
// agent() exactly like proposeConsolidation's sibling contrarian gate in
// tests/consolidation.test.js and runTestLoop in tests/test-loop.test.js — both
// tests below classify complexity 'trivial' (contrarianCapFor caps it at 2,
// minimizing scripted turns) and script the relevant challenge-*-iN stage to
// return needs_rework on every iteration so the gate never clears and the
// cap-out branch is forced.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('contrarianCapFor: default MAX_CONTRARIAN_ITERATIONS (3) -> standard=3, trivial=2', function () {
  const context = harness.boot()
  assert.strictEqual(context.contrarianCapFor('standard'), 3)
  assert.strictEqual(context.contrarianCapFor('trivial'), 2)
})

test('contrarianCapFor: profile raising MAX_CONTRARIAN_ITERATIONS to 5 -> standard=5, trivial stays capped at 2', function () {
  const context = harness.boot()
  context.__seed({ MAX_CONTRARIAN_ITERATIONS: 5 })
  assert.strictEqual(context.contrarianCapFor('standard'), 5)
  assert.strictEqual(context.contrarianCapFor('trivial'), 2)
})

test('contrarianCapFor: profile lowering MAX_CONTRARIAN_ITERATIONS to 1 -> both standard and trivial floor to 1 (Math.min)', function () {
  const context = harness.boot()
  context.__seed({ MAX_CONTRARIAN_ITERATIONS: 1 })
  assert.strictEqual(context.contrarianCapFor('trivial'), 1)
  assert.strictEqual(context.contrarianCapFor('standard'), 1)
})

// ---- FIX 1: approach-gate cap-out surfaces a VERIFY_SKIPS entry ----

test('implementIssue: an approach challenge that never clears the contrarian bar pushes a VERIFY_SKIPS entry (not just ctx.unresolved) at the cap', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '1:setup') return { status: 'success', worktree: '/tmp/ticketmill-fixture-worktree', branch: 'issue-1-fixture' }
    if (label === '1:research') return { status: 'success', context: { issue_title: 'Fixture', issue_body: 'req', related_files: [], dependencies: [], prior_work: '' } }
    if (label === '1:evaluate') return { status: 'success', approach: 'do the thing', rationale: 'because', complexity: 'trivial', risks: [], alternatives_rejected: [], summary: 'initial evaluation' }
    if (label === '1:challenge-approach-i1') {
      return { verdict: 'needs_rework', summary: 'unconvinced round 1', findings: [{ severity: 'major', summary: 'missing risk analysis', assumption_challenged: '', failure_scenario: '', impact: '', recommendation: 'add risk analysis' }] }
    }
    if (label === '1:re-evaluate-i1') return { status: 'success', approach: 'revised approach', rationale: 'addressed', risks: [], alternatives_rejected: [], summary: 'revised evaluation' }
    if (label === '1:challenge-approach-i2') {
      // Cap iteration (trivial -> challengeCap 2): still unconvinced -> never
      // clears sound_with_caveats, forcing the cap-out branch.
      return { verdict: 'needs_rework', summary: 'still unconvinced at the cap', findings: [{ severity: 'major', summary: 'risk analysis still thin', assumption_challenged: '', failure_scenario: '', impact: '', recommendation: 'get a human to weigh in' }] }
    }
    if (label === '1:cap-note-approach') return { posted: true }
    // Fail fast right after the approach gate resolves so the test doesn't have
    // to script the plan gate / task loop / PR pipeline at all.
    if (label === '1:plan') return { status: 'error', error: 'stop test here (approach gate is what is under test)' }
    if (label === '1:halt-note-plan') return { posted: true }
    throw new Error('unexpected stage label: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 1 })
  const result = await context.implementIssue(ctx)

  assert.strictEqual(result.status, 'failed')
  assert.strictEqual(result.stage, 'plan')

  // ctx.unresolved carries the finding into the first task's prompt...
  assert.strictEqual(ctx.unresolved.length, 1)
  assert.strictEqual(ctx.unresolved[0], '[approach gate, major] risk analysis still thin -> get a human to weigh in')

  // ...and VERIFY_SKIPS is what actually reaches the batch PR's Verification
  // Gaps section — this is the FIX 1 line the prior audit found untested.
  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 1)
  assert.strictEqual(verifySkips[0], '#1: approach challenge capped at 2 iterations with unresolved caveats: still unconvinced at the cap')

  // The cap-out was announced, not silently absorbed.
  const capNoteCall = context.agent.calls.find(function (c) { return c.opts.label === '1:cap-note-approach' })
  assert.ok(capNoteCall, 'expected a cap-note-approach stage call')
})

// ---- FIX 1: plan-gate cap-out surfaces a VERIFY_SKIPS entry ----

test('implementIssue: a plan challenge that never clears the contrarian bar pushes a VERIFY_SKIPS entry (not just ctx.unresolved) at the cap', async function () {
  const context = harness.boot()
  context.__seed({ PROFILE: {} })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '1:setup') return { status: 'success', worktree: '/tmp/ticketmill-fixture-worktree', branch: 'issue-1-fixture' }
    if (label === '1:research') return { status: 'success', context: { issue_title: 'Fixture', issue_body: 'req', related_files: [], dependencies: [], prior_work: '' } }
    if (label === '1:evaluate') return { status: 'success', approach: 'do the thing', rationale: 'because', complexity: 'trivial', risks: [], alternatives_rejected: [], summary: 'initial evaluation' }
    // Clear the approach gate in one shot so only the plan gate is under test.
    if (label === '1:challenge-approach-i1') return { verdict: 'sound_with_caveats', summary: 'fine', findings: [] }
    if (label === '1:plan') return { status: 'success', summary: 'planned', tasks: [{ id: 1, description: 'Implement the fixture feature', agent: 'implementer' }], task_list_markdown: '' }
    if (label === '1:challenge-plan-i1') {
      return { verdict: 'needs_rework', summary: 'unconvinced round 1', findings: [{ severity: 'major', summary: 'task ordering is wrong', assumption_challenged: '', failure_scenario: '', impact: '', recommendation: 'reorder tasks' }] }
    }
    if (label === '1:re-plan-i1') return { status: 'success', summary: 'replanned', tasks: [{ id: 1, description: 'Implement the fixture feature, reordered', agent: 'implementer' }], task_list_markdown: '' }
    if (label === '1:challenge-plan-i2') {
      // Cap iteration (trivial -> challengeCap 2): still unconvinced -> forces
      // the cap-out branch.
      return { verdict: 'needs_rework', summary: 'still unconvinced at the cap', findings: [{ severity: 'major', summary: 'task ordering still wrong', assumption_challenged: '', failure_scenario: '', impact: '', recommendation: 'get a human to weigh in' }] }
    }
    if (label === '1:cap-note-plan') return { posted: true }
    // Fail the single task immediately so the test doesn't have to script the
    // review/quality loop, test loop, or PR pipeline at all.
    if (label === '1:task-1-implement') return { status: 'error', summary: 'forced failure', error: 'stop test here (plan gate is what is under test)' }
    if (label === '1:halt-note-implement') return { posted: true }
    throw new Error('unexpected stage label: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 1 })
  const result = await context.implementIssue(ctx)

  assert.strictEqual(result.status, 'failed')
  assert.strictEqual(result.stage, 'implement')

  assert.strictEqual(ctx.unresolved.length, 1)
  assert.strictEqual(ctx.unresolved[0], '[plan gate, major] task ordering still wrong -> get a human to weigh in')

  const verifySkips = harness.readGlobal(context, 'VERIFY_SKIPS')
  assert.strictEqual(verifySkips.length, 1)
  assert.strictEqual(verifySkips[0], '#1: plan challenge capped at 2 iterations with unresolved caveats: still unconvinced at the cap')

  const capNoteCall = context.agent.calls.find(function (c) { return c.opts.label === '1:cap-note-plan' })
  assert.ok(capNoteCall, 'expected a cap-note-plan stage call')
})
