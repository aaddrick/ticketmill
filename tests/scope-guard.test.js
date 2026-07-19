'use strict'

// Unit tests for scopeGuard(ctx) — the per-prompt guard that pins every gh
// command an agent runs to its own issue (and PR, once one exists), and
// stamps posted comments with a machine-checkable marker so contrarian gates
// can detect and delete misfiled cross-pipeline comments.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('scopeGuard: pins issue number, repo, and comment marker; no PR/browser lines when absent', function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture' })
  const ctx = harness.makeCtx({ issue: 4, pr: null })

  const guard = context.scopeGuard(ctx)

  assert.ok(guard.startsWith('## Scope guard (ticketmill)'))
  assert.ok(guard.includes('You are working EXCLUSIVELY on issue #4 of aaddrick/ticketmill-fixture.'))
  assert.ok(guard.includes('MUST target issue #4 exactly'))
  assert.ok(guard.includes('<!-- ticketmill aaddrick/ticketmill-fixture#4 -->'))
  // no PR yet -> no "(PR #...)" / "or PR #..." fragments
  assert.ok(!guard.includes('PR #'))
  // BROWSER defaults to null (unseeded) -> no lock-guard lines
  assert.ok(!guard.includes('lock-guarded'))
})

test('scopeGuard: includes the PR number in both the identity line and the target line once a PR exists', function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture' })
  const ctx = harness.makeCtx({ issue: 9, pr: 12 })

  const guard = context.scopeGuard(ctx)

  assert.ok(guard.includes('issue #9 of aaddrick/ticketmill-fixture (PR #12).'))
  assert.ok(guard.includes('MUST target issue #9 or PR #12 exactly'))
})

// ---- group unit branch (isGroup = ctx.members.length > 1) ----

test('scopeGuard: a group unit widens the guard to every member issue instead of a single issue number', function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture' })
  const ctx = harness.makeCtx({
    issue: 1, pr: null, groupId: 1,
    members: [{ issue: 1 }, { issue: 2 }, { issue: 3 }],
  })

  const guard = context.scopeGuard(ctx)

  assert.ok(guard.startsWith('## Scope guard (ticketmill)'))
  assert.ok(guard.includes('You are working EXCLUSIVELY on consolidation group 1 of aaddrick/ticketmill-fixture, covering member issues: #1, #2, #3.'))
  assert.ok(guard.includes('Every gh issue comment / gh pr comment / gh issue edit command MUST target one of these member issues (#1, #2, #3) exactly'))
  // singleton-only phrasing must NOT leak into the group branch
  assert.ok(!guard.includes('You are working EXCLUSIVELY on issue #'))
  assert.ok(!guard.includes('<!-- ticketmill aaddrick/ticketmill-fixture#1 -->')) // no single canned marker line — it's per-member
  assert.ok(guard.includes("End every comment you post on a member issue with THAT issue's own marker line: <!-- ticketmill aaddrick/ticketmill-fixture#<that member's number> -->."))
  // no PR yet -> no "(PR #...)" / "or PR #..." fragments
  assert.ok(!guard.includes('PR #'))
})

test('scopeGuard: a group unit with a PR appends the PR number to both the identity and target lines', function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture' })
  const ctx = harness.makeCtx({
    issue: 1, pr: 20, groupId: 1,
    members: [{ issue: 1 }, { issue: 4 }],
  })

  const guard = context.scopeGuard(ctx)

  assert.ok(guard.includes('consolidation group 1 of aaddrick/ticketmill-fixture (PR #20), covering member issues: #1, #4.'))
  assert.ok(guard.includes('MUST target one of these member issues (#1, #4) or PR #20 exactly'))
})

// ---- engine-owned advisory clause (issue #3, defense-in-depth layer 1) ----

test('scopeGuard: appends the engine-owned advisory clause, naming every path, when ENGINE_OWNED is populated', function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture', ENGINE_OWNED: ['.claude/ticketmill.json', '.claude/agents/**'] })
  const ctx = harness.makeCtx({ issue: 4, pr: null })

  const guard = context.scopeGuard(ctx)

  assert.ok(guard.includes('Engine-owned paths (.claude/ticketmill.json, .claude/agents/**) are OUT OF SCOPE'))
  assert.ok(guard.includes('do not stage, commit, or restore them from git history'))
  assert.ok(guard.includes('surface the discrepancy as a'))
})

test('scopeGuard: omits the engine-owned clause entirely when ENGINE_OWNED is empty (unseeded default)', function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture' })
  const ctx = harness.makeCtx({ issue: 4, pr: null })

  const guard = context.scopeGuard(ctx)

  assert.ok(!guard.includes('Engine-owned paths'))
})

test('scopeGuard: the engine-owned clause is unconditional — present for a group unit too, not just singletons', function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture', ENGINE_OWNED: ['.claude/workflows/ticketmill.js'] })
  const ctx = harness.makeCtx({
    issue: 1, pr: null, groupId: 1,
    members: [{ issue: 1 }, { issue: 2 }],
  })

  const guard = context.scopeGuard(ctx)

  assert.ok(guard.includes('Engine-owned paths (.claude/workflows/ticketmill.js) are OUT OF SCOPE'))
})
