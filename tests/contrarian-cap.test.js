'use strict'

// Regression tests for issue #48's FIX 2: contrarianCapFor(complexity) is the pure
// helper (declared above the TICKETMILL-TEST-HARNESS-SPLIT marker in workflows/
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
