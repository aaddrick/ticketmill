'use strict'

// Unit tests for probeCommitShas(ctx) and collectPostedCommit(ctx, stage, r)
// (issue #79, Layer 2 — post-hoc validation of agent-posted commit SHAs).
//
// Follow-up to #47/PR #78's COMMIT_SHA_ASK (Layer 1, advisory only — it tells
// an agent HOW to fetch the real SHA, but the `commit` field a stage returns
// is still unverified free text). Layer 2 adds a post-hoc existence check:
// probeCommitShas() dispatches ONE read-only haiku probe per issue that runs
// `git cat-file -e <sha>^{commit}` against every SHA collectPostedCommit()
// gathered into ctx.postedCommits, and flags (never halts on) any SHA that
// does not resolve.
//
// Modeled on tests/changed-files-probe.test.js (same read-only-probe,
// degrade-on-death shape as probeChangedFiles() immediately above it in
// workflows/ticketmill.js), but this probe additionally: (a) early-returns
// with NO dispatch when ctx.postedCommits is empty (the common case), and
// (b) on a live response, flags unresolved SHAs via VERIFY_SKIPS + ctx.deferred
// rather than populating ctx fields.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

function seedProbe(context, overrides) {
  context.__seed(Object.assign({ REPO: 'aaddrick/ticketmill-fixture', TARGET: 'Batch_fixture' }, overrides))
}

test('probeCommitShas: every posted SHA resolves -> no VERIFY_SKIPS entries and no ctx.deferred notes', async function () {
  const context = harness.boot()
  seedProbe(context)
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    assert.strictEqual(label, '20:commit-sha-probe')
    return { unresolved_shas: [] }
  })

  const ctx = harness.makeCtx({ issue: 20 })
  ctx.postedCommits.push({ stage: 'task-1-implement', commit: 'a'.repeat(40) })
  ctx.postedCommits.push({ stage: 'pr-fix-i1', commit: 'b'.repeat(40) })

  await context.probeCommitShas(ctx)

  assert.deepStrictEqual(ctx.deferred, [])
  // Array.from(): VERIFY_SKIPS is read out of the vm context, so it's a
  // different-realm Array (own Array.prototype) — deepStrictEqual checks
  // prototype identity and fails on a cross-realm array even with identical
  // contents. Array.from() rebuilds it as a same-realm array first (same
  // workaround tests/engine-owned.test.js documents for ENGINE_OWNED_GLOBS).
  const skips = Array.from(harness.readGlobal(context, 'VERIFY_SKIPS'))
  assert.deepStrictEqual(skips, [])
})

test('probeCommitShas: a missing SHA pushes exactly one VERIFY_SKIPS entry and one ctx.deferred entry naming the posting stage, and does not halt the run', async function () {
  const context = harness.boot()
  seedProbe(context)
  const fabricated = 'c'.repeat(40)
  harness.installScriptedAgent(context, function () { return { unresolved_shas: [fabricated] } })

  const ctx = harness.makeCtx({ issue: 21 })
  ctx.postedCommits.push({ stage: 'task-3-implement', commit: fabricated })

  await context.probeCommitShas(ctx)

  const skips = Array.from(harness.readGlobal(context, 'VERIFY_SKIPS'))
  assert.strictEqual(skips.length, 1)
  assert.match(skips[0], /#21/)
  assert.ok(skips[0].includes(fabricated), skips[0])
  assert.ok(skips[0].includes('task-3-implement'), skips[0])

  assert.strictEqual(ctx.deferred.length, 1)
  assert.match(ctx.deferred[0], /#21/)
  assert.ok(ctx.deferred[0].includes('task-3-implement'), ctx.deferred[0])
  assert.ok(ctx.deferred[0].includes(fabricated), ctx.deferred[0])

  // Never halts: the function returns normally (no throw) and callers can
  // proceed past it, exactly as probeChangedFiles()'s own degrade path does.
})

test('probeCommitShas: a dead probe (agent returns null through every retry) degrades — a ctx.deferred note is recorded, no VERIFY_SKIPS entry, never throwing or blocking the caller', async function () {
  const context = harness.boot()
  seedProbe(context)
  harness.installScriptedAgent(context, function () { return null }) // simulates a dead agent call, exhausting stage()'s retries

  const ctx = harness.makeCtx({ issue: 22 })
  ctx.postedCommits.push({ stage: 'quality-fix-implement-i1', commit: 'd'.repeat(40) })

  await context.probeCommitShas(ctx)

  assert.strictEqual(ctx.deferred.length, 1)
  assert.ok(ctx.deferred[0].includes('Commit-SHA probe'), ctx.deferred[0])
  assert.ok(ctx.deferred[0].includes('#22'), ctx.deferred[0])

  const skips = Array.from(harness.readGlobal(context, 'VERIFY_SKIPS'))
  assert.deepStrictEqual(skips, [])
})

test('probeCommitShas: empty ctx.postedCommits early-returns with no stage dispatched', async function () {
  const context = harness.boot()
  seedProbe(context)
  const scriptedAgent = harness.installScriptedAgent(context, function () {
    throw new Error('agent must not be called when ctx.postedCommits is empty')
  })

  const ctx = harness.makeCtx({ issue: 23 })
  assert.deepStrictEqual(ctx.postedCommits, [])

  await context.probeCommitShas(ctx)

  assert.strictEqual(scriptedAgent.calls.length, 0)
  assert.deepStrictEqual(ctx.deferred, [])
  const skips = Array.from(harness.readGlobal(context, 'VERIFY_SKIPS'))
  assert.deepStrictEqual(skips, [])
})

test('collectPostedCommit: a stage result with a non-null commit is pushed onto ctx.postedCommits with its stage name', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 24 })

  context.collectPostedCommit(ctx, 'task-2-implement', { commit: 'e'.repeat(40) })

  // ctx.postedCommits is itself a real-realm array (built by makeCtx() in
  // this host realm; push() mutates it in place without changing its own
  // prototype), but each pushed {stage, commit} object literal is
  // constructed INSIDE collectPostedCommit's vm realm, so it carries a
  // different-realm Object.prototype — deepStrictEqual's prototype-identity
  // check fails on that alone even though the fields match (same cross-realm
  // issue Array.from() works around for arrays; here .map() rebuilds each
  // element as a plain host-realm object before comparing).
  const rows = ctx.postedCommits.map(function (p) { return { stage: p.stage, commit: p.commit } })
  assert.deepStrictEqual(rows, [{ stage: 'task-2-implement', commit: 'e'.repeat(40) }])
})

test('collectPostedCommit: a null stage result is a no-op (no push, no throw)', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 25 })

  context.collectPostedCommit(ctx, 'task-2-fix-a1', null)

  assert.deepStrictEqual(ctx.postedCommits, [])
})

test('collectPostedCommit: a stage result with a null/absent commit is a no-op (e.g. a fix stage that made no changes)', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 26 })

  context.collectPostedCommit(ctx, 'simplify-implement-i1', { commit: null })
  context.collectPostedCommit(ctx, 'quality-fix-implement-i1', {})

  assert.deepStrictEqual(ctx.postedCommits, [])
})
