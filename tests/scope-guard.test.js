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
