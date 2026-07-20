'use strict'

// Unit tests for shouldWarnBaseBranch(profile, base) (workflows/ticketmill.js,
// added for issue #36) — the pure predicate behind the Select-phase "base branch
// looks like a CI/CD trigger branch" warning. Before this issue the check was a
// hardcoded `BASE === 'deploy-prod' || BASE === 'deploy-dev'` literal that baked
// one repo's branch-naming convention into the stack-agnostic engine; it's now
// driven by the OPTIONAL profile.warn_base_branches array (default []), read the
// same normalize-or-[] way as PROFILE.lockstep_installed_paths.
//
// The function is declared above the TICKETMILL-TEST-HARNESS-SPLIT marker
// specifically so it's reachable here — the `if (shouldWarnBaseBranch(...)) log(...)`
// call site itself lives below the marker (it needs the real PROFILE/BASE
// populated at Select) and is not exercised by node --test.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('shouldWarnBaseBranch: fires when base is a member of profile.warn_base_branches', function () {
  const context = harness.boot()

  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: ['deploy-prod', 'deploy-dev'] }, 'deploy-prod'), true)
  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: ['deploy-prod', 'deploy-dev'] }, 'deploy-dev'), true)
})

test('shouldWarnBaseBranch: does not fire when base is absent from the list', function () {
  const context = harness.boot()

  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: ['deploy-prod', 'deploy-dev'] }, 'main'), false)
})

test('shouldWarnBaseBranch: default profile field ([]) never fires — the engine bakes in no project-shaped branch names', function () {
  const context = harness.boot()

  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: [] }, 'deploy-prod'), false)
  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: [] }, 'deploy-dev'), false)
})

test('shouldWarnBaseBranch: a profile with no warn_base_branches field degrades cleanly to no warning, not a throw', function () {
  const context = harness.boot()

  assert.equal(context.shouldWarnBaseBranch({}, 'deploy-prod'), false)
  assert.equal(context.shouldWarnBaseBranch(null, 'deploy-prod'), false)
  assert.equal(context.shouldWarnBaseBranch(undefined, 'deploy-prod'), false)
})

test('shouldWarnBaseBranch: a non-array warn_base_branches value normalizes to [] instead of throwing', function () {
  const context = harness.boot()

  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: 'deploy-prod' }, 'deploy-prod'), false)
  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: 42 }, 'deploy-prod'), false)
})

test('shouldWarnBaseBranch: list entries are coerced with String(), matching a non-string base by its string form', function () {
  const context = harness.boot()

  // A profile authored with a non-string entry (e.g. a stray JSON number) still
  // matches a base branch whose string form is equal — same .map(String)
  // coercion idiom mergeEngineOwnedGlobs/LOCKSTEP_INSTALLED_PATHS use.
  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: [123] }, '123'), true)
})

test('shouldWarnBaseBranch: match is exact, not a substring/prefix hit', function () {
  const context = harness.boot()

  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: ['deploy-prod'] }, 'deploy-prod-2'), false)
  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: ['deploy-prod'] }, 'pre-deploy-prod'), false)
})

test('shouldWarnBaseBranch: a repo that opts a non-deploy-* name into the list still warns on it (stack-agnostic, no baked-in names)', function () {
  const context = harness.boot()

  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: ['release'] }, 'release'), true)
  assert.equal(context.shouldWarnBaseBranch({ warn_base_branches: ['release'] }, 'deploy-prod'), false)
})
