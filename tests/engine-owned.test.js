'use strict'

// Unit tests for the engine-owned path helpers added for issue #3 (guardrail:
// treat engine-owned paths — the ticketmill profile, agent roster, and engine
// copy — as read-only during a run): mergeEngineOwnedGlobs (profile-extensible
// default set), engineOwnedHit (prose substring hit), buildEngineOwnedPathspec
// (git pathspec literalization), and isHardRevertPath (file-level hard-revert
// predicate). All three helpers share one literalization rule (literalizeGlob):
// a trailing run of '*' characters strips to the fixed prefix before it
// ('.claude/agents/**' -> '.claude/agents/'); an exact-file glob with no
// trailing star is left unchanged.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// bootConsolidation: same helper tests/consolidation.test.js uses — seeds a
// non-null PROFILE so consolidationEnabled(PROFILE) is true (proposeConsolidation
// free-disables its opus PROPOSE step, though never its HEAL, when PROFILE is
// null/falsy), needed by the end-to-end regime-(a) test below.
function bootConsolidation(overrides) {
  const context = harness.boot()
  context.__seed(Object.assign({ PROFILE: {} }, overrides))
  return context
}

// ---- ENGINE_OWNED_GLOBS / mergeEngineOwnedGlobs ----

test('ENGINE_OWNED_GLOBS: default set is exactly the four paths named in issue #3', function () {
  const context = harness.boot()
  // Array.from(): ENGINE_OWNED_GLOBS is a const array literal evaluated INSIDE
  // the vm context, so it's a different-realm Array (own Array.prototype) —
  // deepStrictEqual checks prototype identity and fails on a cross-realm
  // array even with identical contents. Array.from() rebuilds it as a
  // same-realm array (Array.from runs against the calling realm's Array
  // constructor) so the content comparison below is meaningful.
  const globs = Array.from(harness.readGlobal(context, 'ENGINE_OWNED_GLOBS'))

  assert.deepEqual(globs, [
    '.claude/ticketmill.json',
    '.claude/agents/**',
    '.claude/workflows/ticketmill.js',
    '.claude/scripts/ticketmill/**',
  ])
})

test('mergeEngineOwnedGlobs: appends profile.engine_owned_globs to the default set', function () {
  const context = harness.boot()
  const merged = context.mergeEngineOwnedGlobs({ engine_owned_globs: ['docs/internal/**'] })

  assert.ok(merged.indexOf('.claude/agents/**') !== -1)
  assert.ok(merged.indexOf('docs/internal/**') !== -1)
  assert.equal(merged.length, 5)
})

test('mergeEngineOwnedGlobs: a profile with no engine_owned_globs field returns just the default set', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')

  assert.deepEqual(context.mergeEngineOwnedGlobs({}), globs)
  assert.deepEqual(context.mergeEngineOwnedGlobs(null), globs)
})

// ---- engineOwnedHit ----

test('engineOwnedHit: fires on prose that plainly names an engine-owned directory glob', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')

  assert.equal(context.engineOwnedHit('Fix a bug in .claude/agents/ticketmill-implementer.md', globs), '.claude/agents/')
})

test('engineOwnedHit: fires on an exact-file glob with no trailing star', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')

  assert.equal(context.engineOwnedHit('Update .claude/ticketmill.json to add a new field', globs), '.claude/ticketmill.json')
})

test('engineOwnedHit: returns null for ordinary application-code prose', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')

  assert.equal(context.engineOwnedHit('Fix the null-pointer bug in src/parser.js', globs), null)
})

test('engineOwnedHit: case-sensitive — a differently-cased path does not hit', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')

  assert.equal(context.engineOwnedHit('Edit .CLAUDE/agents/foo.md', globs), null)
})

// ---- buildEngineOwnedPathspec ----

test('buildEngineOwnedPathspec: strips directory globs to trailing-slash prefixes, leaves exact files unchanged', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')

  // Array.from(): see the cross-realm note on the ENGINE_OWNED_GLOBS test above.
  assert.deepEqual(Array.from(context.buildEngineOwnedPathspec(globs)), [
    '.claude/ticketmill.json',
    '.claude/agents/',
    '.claude/workflows/ticketmill.js',
    '.claude/scripts/ticketmill/',
  ])
})

test('buildEngineOwnedPathspec: deduplicates a profile entry that re-lists a default glob', function () {
  const context = harness.boot()

  assert.deepEqual(Array.from(context.buildEngineOwnedPathspec(['.claude/agents/**', '.claude/agents/**'])), ['.claude/agents/'])
})

// ---- isHardRevertPath ----

test('isHardRevertPath: an engine-owned file with no lockstep override is a hard-revert candidate', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')

  assert.equal(context.isHardRevertPath('.claude/ticketmill.json', globs, []), true)
})

test('isHardRevertPath: a file outside the engine-owned set is never a hard-revert candidate', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')

  assert.equal(context.isHardRevertPath('src/index.js', globs, []), false)
})

test('isHardRevertPath: exact-entry lockstep exception — this repo\'s own lockstep_installed_paths exempts the installed engine copy', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')
  const lockstep = ['.claude/workflows/ticketmill.js']

  assert.equal(context.isHardRevertPath('.claude/workflows/ticketmill.js', globs, lockstep), false)
  // a non-lockstepped engine-owned sibling is still a hard-revert candidate
  assert.equal(context.isHardRevertPath('.claude/ticketmill.json', globs, lockstep), true)
})

test('isHardRevertPath: a lockstep path nested under a directory glob is exempted, its sibling is not', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')
  const lockstep = ['.claude/agents/pinned.md']

  assert.equal(context.isHardRevertPath('.claude/agents/pinned.md', globs, lockstep), false)
  assert.equal(context.isHardRevertPath('.claude/agents/other.md', globs, lockstep), true)
})

// ---- attachEngineOwnedIntentional (Select-phase regime classifier) ----

test('attachEngineOwnedIntentional: true when the issue title names an engine-owned path', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')
  const out = context.attachEngineOwnedIntentional([
    { issue: 1, title: 'Update .claude/ticketmill.json to add a field', body: '' },
  ], globs)

  assert.equal(out[0].engineOwnedIntentional, true)
})

test('attachEngineOwnedIntentional: true when only the BODY names an engine-owned path (title alone would miss it)', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')
  const out = context.attachEngineOwnedIntentional([
    { issue: 1, title: 'Fix the roster', body: 'This touches .claude/agents/foo.md directly.' },
  ], globs)

  assert.equal(out[0].engineOwnedIntentional, true)
})

test('attachEngineOwnedIntentional: false for ordinary application-code prose, and a missing body never throws', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')
  const out = context.attachEngineOwnedIntentional([
    { issue: 1, title: 'Fix the null-pointer bug in src/parser.js' }, // no body field at all
  ], globs)

  assert.equal(out[0].engineOwnedIntentional, false)
})

test('attachEngineOwnedIntentional: returns a NEW array, does not mutate the input preflights', function () {
  const context = harness.boot()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')
  const input = [{ issue: 1, title: 'Update .claude/ticketmill.json', body: '' }]

  const out = context.attachEngineOwnedIntentional(input, globs)

  assert.equal('engineOwnedIntentional' in input[0], false)
  assert.equal(out[0].engineOwnedIntentional, true)
  assert.notStrictEqual(out[0], input[0])
})

// ---- applyEngineOwnedRootDirtySkip (regime (a): prose targets the set AND
// root is dirty under it -> select-skip; issue #3's #77 hazard) ----

test('applyEngineOwnedRootDirtySkip: regime (a) — intentional AND root-dirty flips resume_point to skip with a reason naming the dirty paths', function () {
  const context = harness.boot()
  const preflights = [
    { issue: 1, resume_point: 'implement', reason: 'fresh', engineOwnedIntentional: true, root_dirty_engine_paths: ['.claude/agents/foo.md'] },
  ]

  const result = context.applyEngineOwnedRootDirtySkip(preflights)

  assert.deepEqual(Array.from(result.flagged), [1])
  assert.strictEqual(result.preflights[0].resume_point, 'skip')
  assert.ok(result.preflights[0].reason.indexOf('.claude/agents/foo.md') !== -1, 'reason should name the dirty path')
  assert.ok(/run this issue solo/.test(result.preflights[0].reason), 'reason should name the safe path')
})

test('applyEngineOwnedRootDirtySkip: regime (b) — intentional but root CLEAN is left untouched (deliberate engine work, e.g. issue #3 itself)', function () {
  const context = harness.boot()
  const preflights = [
    { issue: 3, resume_point: 'implement', reason: 'fresh', engineOwnedIntentional: true, root_dirty_engine_paths: [] },
  ]

  const result = context.applyEngineOwnedRootDirtySkip(preflights)

  assert.deepEqual(Array.from(result.flagged), [])
  assert.strictEqual(result.preflights[0].resume_point, 'implement')
  assert.strictEqual(result.preflights[0], preflights[0]) // untouched entry is the SAME reference
})

test('applyEngineOwnedRootDirtySkip: regime (c) — root dirty but prose does NOT target the set is left untouched (not this gate\'s job)', function () {
  const context = harness.boot()
  const preflights = [
    { issue: 5, resume_point: 'implement', reason: 'fresh', engineOwnedIntentional: false, root_dirty_engine_paths: ['.claude/ticketmill.json'] },
  ]

  const result = context.applyEngineOwnedRootDirtySkip(preflights)

  assert.deepEqual(Array.from(result.flagged), [])
  assert.strictEqual(result.preflights[0].resume_point, 'implement')
})

test('applyEngineOwnedRootDirtySkip: a mixed batch flags only the (a) issue, leaves the rest of the array untouched by reference', function () {
  const context = harness.boot()
  const preflights = [
    { issue: 1, resume_point: 'implement', reason: 'fresh', engineOwnedIntentional: true, root_dirty_engine_paths: ['.claude/agents/x.md'] },
    { issue: 2, resume_point: 'implement', reason: 'fresh', engineOwnedIntentional: false, root_dirty_engine_paths: [] },
    { issue: 3, resume_point: 'process_pr', reason: 'has PR', engineOwnedIntentional: true, root_dirty_engine_paths: [] },
  ]

  const result = context.applyEngineOwnedRootDirtySkip(preflights)

  assert.deepEqual(Array.from(result.flagged), [1])
  assert.strictEqual(result.preflights[0].resume_point, 'skip')
  assert.strictEqual(result.preflights[1], preflights[1])
  assert.strictEqual(result.preflights[2], preflights[2])
})

// ---- End-to-end (i): a skipped engine-owned issue is neither proposed for
// consolidation nor claimed. proposeConsolidation()'s own residual filter only
// admits resume_point === 'implement' into a brand-new opus-gate grouping, and
// the real Select-phase claim filter (workflows/ticketmill.js, `toClaim =
// preflights.filter(p => p.resume_point !== 'skip')`) is mirrored here — both
// existing gates key off the SAME resume_point field applyEngineOwnedRootDirtySkip
// flips, so proving the flip is enough to prove both downstream exclusions. ----

test('regime (a) end-to-end: a root-dirty engine-owned issue is select-skipped, so it is excluded from BOTH consolidation candidacy and the claim filter', async function () {
  const context = bootConsolidation()
  const globs = harness.readGlobal(context, 'ENGINE_OWNED_GLOBS')

  let rawPreflights = [
    { issue: 1, title: 'Fix .claude/agents/ticketmill-implementer.md', body: '', resume_point: 'implement', reason: 'fresh', root_dirty_engine_paths: ['.claude/agents/ticketmill-implementer.md'] },
    { issue: 2, title: 'Fix an unrelated bug', body: '', resume_point: 'implement', reason: 'fresh', root_dirty_engine_paths: [] },
  ]
  rawPreflights = context.attachEngineOwnedIntentional(rawPreflights, globs)
  const gate = context.applyEngineOwnedRootDirtySkip(rawPreflights)
  const preflights = gate.preflights

  assert.deepEqual(Array.from(gate.flagged), [1])
  assert.strictEqual(preflights[0].resume_point, 'skip')

  // not proposed for consolidation: proposeConsolidation's opus gate must never
  // even see issue #1 on its menu (only #2 is a fresh 'implement' candidate).
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === 'consolidation:marker-probe') return { markers: [] }
    if (label === 'consolidation:propose') {
      assert.ok(!prompt.includes('#1'), 'the select-skipped engine-owned issue must not be offered to the consolidation gate')
      return { groups: [], ungrouped: [2] }
    }
    throw new Error('unexpected consolidation call: ' + label)
  })
  const map = await context.proposeConsolidation(preflights)
  assert.strictEqual(map.size, 0)

  const units = context.deriveUnits(context.reconcileGroups(map, preflights), preflights)
  assert.strictEqual(units.length, 2)
  const u1 = units.find(function (u) { return u.issue === 1 })
  assert.strictEqual(u1.resume_point, 'skip') // processIssue()'s existing skip branch takes it from here

  // not claimed: mirrors the real toClaim filter (resume_point !== 'skip').
  const toClaim = preflights.filter(function (p) { return p.resume_point !== 'skip' })
  assert.deepEqual(Array.from(toClaim.map(function (p) { return p.issue })), [2])
})

// ---- runEngineOwnedGate (regimes b/c: the post-implement hard-revert backstop) ----
//
// Modeled on tests/test-loop.test.js: drive runEngineOwnedGate(ctx) with a
// scripted agent(), branching on opts.label ('<issue>:engine-owned-probe' /
// '<issue>:engine-owned-revert'), and assert on ctx.deferred/ctx.decisions and
// on which files the revert stage's own prompt names — never on ENGINE_OWNED's
// contents directly, so these tests fail if the gate ever reverts (or spares)
// the wrong file, not just if the constant changes.

const ENGINE_GLOBS = ['.claude/ticketmill.json', '.claude/agents/**', '.claude/workflows/ticketmill.js', '.claude/scripts/ticketmill/**']

function seedGate(context, overrides) {
  context.__seed(Object.assign({
    REPO: 'aaddrick/ticketmill-fixture', TARGET: 'Batch_fixture', ROOT: '/tmp/ticketmill-fixture-root',
    ENGINE_OWNED: ENGINE_GLOBS, LOCKSTEP_INSTALLED_PATHS: [],
  }, overrides))
}

test('runEngineOwnedGate: ENGINE_OWNED empty -> no-op, never even probes', async function () {
  const context = harness.boot()
  seedGate(context, { ENGINE_OWNED: [] })
  harness.installScriptedAgent(context, function () { throw new Error('agent must not be called when ENGINE_OWNED is empty') })

  const ctx = harness.makeCtx({ issue: 1 })
  const result = await context.runEngineOwnedGate(ctx)

  assert.strictEqual(result.ok, true)
  assert.deepEqual(ctx.deferred, [])
})

test('runEngineOwnedGate: no engine-owned files in the diff -> no-op, revert stage never called', async function () {
  const context = harness.boot()
  seedGate(context)
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '1:engine-owned-probe') return { changed_files: ['src/index.js', 'README.md'] }
    throw new Error('unexpected call: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 1 })
  const result = await context.runEngineOwnedGate(ctx)

  assert.strictEqual(result.ok, true)
  assert.deepEqual(ctx.deferred, [])
})

test('runEngineOwnedGate: diff probe dies -> degrades to a recorded deferred follow-up, never blocks the issue', async function () {
  const context = harness.boot()
  seedGate(context)
  harness.installScriptedAgent(context, function () { return null }) // simulates a dead agent call

  const ctx = harness.makeCtx({ issue: 1 })
  const result = await context.runEngineOwnedGate(ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.deferred.length, 1)
  assert.ok(ctx.deferred[0].indexOf('diff probe died') !== -1)
})

test('runEngineOwnedGate: regime (b) — ctx.engineOwnedIntentional true leaves engine-owned files in place, no revert stage call', async function () {
  const context = harness.boot()
  seedGate(context)
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '3:engine-owned-probe') return { changed_files: ['.claude/ticketmill.json', 'src/index.js'] }
    throw new Error('regime (b) must never call the revert stage: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 3, engineOwnedIntentional: true })
  const result = await context.runEngineOwnedGate(ctx)

  assert.strictEqual(result.ok, true)
  assert.deepEqual(ctx.deferred, [])
  assert.deepEqual(ctx.decisions, [])
})

test('runEngineOwnedGate: (i) a group-threaded non-primary deliberate member is NOT reverted', async function () {
  // Simulates deriveUnits()'s OR-fold: a group whose PRIMARY did not name an
  // engine path but a non-primary MEMBER did still threads engineOwnedIntentional
  // === true onto the unit's ctx (processIssue()'s ctx init reads it off `pre`,
  // the deriveUnits()-shaped unit — see the ctx.engineOwnedIntentional comment
  // there). The gate must honor that threaded value, not re-derive it from the
  // primary alone.
  const context = harness.boot()
  seedGate(context)
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '10:engine-owned-probe') return { changed_files: ['.claude/agents/other-role.md'] }
    throw new Error('a group-threaded deliberate member must never reach the revert stage: ' + label)
  })

  // issue 10 is the group's primary; its own prose never named an engine path,
  // but deriveUnits() OR-folded a non-primary member's hit onto the unit.
  const ctx = harness.makeCtx({
    issue: 10, groupId: 7, engineOwnedIntentional: true,
    members: [{ issue: 10, engineOwnedIntentional: false }, { issue: 11, engineOwnedIntentional: true }],
  })
  const result = await context.runEngineOwnedGate(ctx)

  assert.strictEqual(result.ok, true)
  assert.deepEqual(ctx.deferred, [])
})

test('runEngineOwnedGate: regime (c) — not intentional, reverts ONLY the engine-owned files, commits+pushes, records a deferred follow-up', async function () {
  const context = harness.boot()
  seedGate(context)
  let revertPrompt = null
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '5:engine-owned-probe') return { changed_files: ['.claude/ticketmill.json', 'src/index.js'] }
    if (label === '5:engine-owned-revert') { revertPrompt = prompt; return { status: 'success', commit: 'deadbeef', files_changed: ['.claude/ticketmill.json'], summary: 'reverted' } }
    throw new Error('unexpected call: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 5, engineOwnedIntentional: false })
  const result = await context.runEngineOwnedGate(ctx)

  assert.strictEqual(result.ok, true)
  // quoted form, not a bare substring — see the (ii) lockstep test below for why
  // ('.claude/ticketmill.json' also appears unquoted in scopeGuard()'s advisory clause).
  assert.ok(revertPrompt.indexOf('".claude/ticketmill.json"') !== -1)
  assert.ok(revertPrompt.indexOf('src/index.js') === -1, 'the revert prompt must not name a non-engine-owned file')
  assert.ok(revertPrompt.indexOf('origin/Batch_fixture') !== -1)
  assert.strictEqual(ctx.decisions.length, 1)
  assert.ok(ctx.decisions[0].entry.indexOf('.claude/ticketmill.json') !== -1)
  assert.strictEqual(ctx.deferred.length, 1)
  assert.ok(ctx.deferred[0].indexOf('.claude/ticketmill.json') !== -1)
  assert.ok(ctx.deferred[0].indexOf('dedicated issue') !== -1)
})

test('runEngineOwnedGate: revert stage fails -> records a deferred follow-up instead of halting the run', async function () {
  const context = harness.boot()
  seedGate(context)
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '6:engine-owned-probe') return { changed_files: ['.claude/ticketmill.json'] }
    if (label === '6:engine-owned-revert') return { status: 'error', summary: 'died', error: 'could not checkout', commit: null, files_changed: [] }
    throw new Error('unexpected call: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 6, engineOwnedIntentional: false })
  const result = await context.runEngineOwnedGate(ctx)

  assert.strictEqual(result.ok, true) // this gate never halts the run on its own
  assert.strictEqual(ctx.deferred.length, 1)
  assert.ok(ctx.deferred[0].indexOf('FAILED') !== -1)
  assert.ok(ctx.deferred[0].indexOf('.claude/ticketmill.json') !== -1)
})

test('runEngineOwnedGate: (ii) a lockstep path (including one nested under an engine glob) is left in place while other engine paths revert', async function () {
  const context = harness.boot()
  // '.claude/workflows/ticketmill.js' is an exact-file lockstep exception;
  // '.claude/agents/pinned.md' is a lockstep path NESTED under the
  // '.claude/agents/**' directory glob — isHardRevertPath's own file-level
  // predicate (not a glob-string set difference) is what gets nesting right.
  seedGate(context, { LOCKSTEP_INSTALLED_PATHS: ['.claude/workflows/ticketmill.js', '.claude/agents/pinned.md'] })
  let revertPrompt = null
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '7:engine-owned-probe') {
      return { changed_files: ['.claude/workflows/ticketmill.js', '.claude/agents/pinned.md', '.claude/agents/other.md', '.claude/ticketmill.json'] }
    }
    if (label === '7:engine-owned-revert') { revertPrompt = prompt; return { status: 'success', commit: 'cafef00d', files_changed: ['.claude/agents/other.md', '.claude/ticketmill.json'], summary: 'reverted' } }
    throw new Error('unexpected call: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 7, engineOwnedIntentional: false })
  const result = await context.runEngineOwnedGate(ctx)

  assert.strictEqual(result.ok, true)
  // reverted: the two non-lockstep engine-owned paths. Assert on the QUOTED form
  // ('"<path>"', from the checkout/diff-verify command list built off revertFiles)
  // rather than a bare substring — the scopeGuard() advisory clause prepended to
  // every stage prompt (see scope-guard.test.js) unconditionally lists EVERY
  // ENGINE_OWNED glob, including '.claude/workflows/ticketmill.js' itself, so a
  // bare substring check would pass even if the revert list were wrong.
  assert.ok(revertPrompt.indexOf('".claude/agents/other.md"') !== -1)
  assert.ok(revertPrompt.indexOf('".claude/ticketmill.json"') !== -1)
  // left in place: BOTH lockstep paths, the exact-file one AND the one nested under a glob
  assert.ok(revertPrompt.indexOf('".claude/workflows/ticketmill.js"') === -1, 'the exact-file lockstep path must not be in the revert command list')
  assert.ok(revertPrompt.indexOf('".claude/agents/pinned.md"') === -1, 'the lockstep path nested under .claude/agents/** must not be in the revert command list')
  // both lockstep exemptions get their own deferred note (distinct from the revert follow-up)
  assert.strictEqual(ctx.deferred.length, 2)
  assert.ok(ctx.deferred.some(function (d) { return d.indexOf('.claude/workflows/ticketmill.js') !== -1 && d.indexOf('.claude/agents/pinned.md') !== -1 && d.indexOf('NOT reverted') !== -1 }))
  assert.ok(ctx.deferred.some(function (d) { return d.indexOf('.claude/agents/other.md') !== -1 && d.indexOf('.claude/ticketmill.json') !== -1 }))
})

test('runEngineOwnedGate: ALL engine-owned files in the diff are lockstep-exempt -> no revert stage call at all', async function () {
  const context = harness.boot()
  seedGate(context, { LOCKSTEP_INSTALLED_PATHS: ['.claude/workflows/ticketmill.js'] })
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '8:engine-owned-probe') return { changed_files: ['.claude/workflows/ticketmill.js'] }
    throw new Error('must not call the revert stage when every engine-owned file is lockstep-exempt: ' + label)
  })

  const ctx = harness.makeCtx({ issue: 8, engineOwnedIntentional: false })
  const result = await context.runEngineOwnedGate(ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.deferred.length, 1)
  assert.ok(ctx.deferred[0].indexOf('NOT reverted') !== -1)
})
