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
