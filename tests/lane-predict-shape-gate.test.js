'use strict'

// Unit tests for PREDICTED_FILES_ASK(ROOT, TARGET) (issue #113) — the
// module-scope pure function the preflight probe's step-5 predicted_files
// prompt text was extracted into (workflows/ticketmill.js, ~line 1883,
// alongside COMMIT_SHA_ASK).
//
// Retro (#94, 'add skills/mill-review/SKILL.md'): the original step-5
// identifier->tree resolution always fell through to a broad `git grep`/
// `git ls-tree` match against origin/TARGET, and the two ~7,300-line engine
// copies plus .claude/ticketmill.json mention nearly every ticketmill
// concept — so a net-new skill/doc issue's generic identifiers grep-matched
// the engine cluster (workflows/ticketmill.js, .claude/workflows/ticketmill.js,
// scripts/lint-engine.js, .claude/ticketmill.json) while the not-yet-created
// asset path itself resolved to nothing, yielding a precision-0 prediction.
// The fix prepends a deliverable-shape gate ahead of the broad resolution;
// this file asserts (via harness.boot()/readGlobal(), never a live LLM) that
// the emitted prompt text actually carries:
//   1. the doc/skill narrowing branch + its narrow-single-file instruction
//      (criterion 1 — an 'add a skill' issue predicts a narrow set, not the
//      engine cluster);
//   2. the engine-keyword escape hatch that routes engine/profile/schema-
//      naming bodies back to the broad resolution path (guards criterion 2);
//   3. the preserved engine-shaped resolution language (git grep / git
//      ls-tree, identifier extraction) proving the token-budget-style path
//      is unchanged;
//   4. an interpolation sentinel check — PREDICTED_FILES_ASK('SENTINEL_ROOT',
//      'SENTINEL_TARGET') must interpolate both sentinels into the emitted
//      text, and the literal substring 'null' must NOT appear — proving this
//      is a live (ROOT, TARGET) function, not a load-time string that would
//      have captured the module-scope `let ROOT = null` / `let TARGET = null`
//      bindings (see the extraction comment directly above the constant).

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('PREDICTED_FILES_ASK: emits the doc/skill deliverable-shape narrowing branch with its narrow-single-file instruction', function () {
  const context = harness.boot()
  const text = harness.readGlobal(context, "PREDICTED_FILES_ASK('ROOT', 'TARGET')")

  // Criterion 1: an 'add a skill'/new doc issue must be steered to a narrow
  // prediction, not the broad engine-cluster resolution below.
  assert.match(text, /Deliverable-shape gate/i)
  assert.match(text, /adding\/creating a NEW skill or a new doc\/markdown asset/i)
  assert.match(text, /predicted_files = the new asset'?s path exactly as written/i)
  assert.match(text, /Skip steps a-c below entirely/i)
})

test('PREDICTED_FILES_ASK: emits the engine-keyword escape hatch routing engine/profile/schema-naming bodies back to the broad resolution path', function () {
  const context = harness.boot()
  const text = harness.readGlobal(context, "PREDICTED_FILES_ASK('ROOT', 'TARGET')")

  // Criterion-2 guard: the gate must name the engine/profile/schema keywords
  // that abstain from narrowing, and explicitly fall through otherwise.
  assert.match(text, /engine\/profile\/schema keyword/i)
  assert.match(text, /workflows\/ticketmill\.js/)
  assert.match(text, /\.claude\/ticketmill\.json/)
  assert.match(text, /lint-engine/i)
  assert.match(text, /fall through to/i)
  assert.match(text, /steps a-c below, unchanged/i)
})

test('PREDICTED_FILES_ASK: preserves the engine-shaped resolution language (identifier extraction, git grep, git ls-tree) unchanged', function () {
  const context = harness.boot()
  const text = harness.readGlobal(context, "PREDICTED_FILES_ASK('ROOT', 'TARGET')")

  // Criterion 2: today's token-budget-style broad resolution (5a/5b/5c) must
  // still be present verbatim so an engine-shaped issue's prediction is
  // unchanged.
  assert.match(text, /extract ONLY high-signal identifiers/i)
  assert.match(text, /backticked spans/i)
  assert.match(text, /git .*grep -l -I -F -i/)
  assert.match(text, /git .*ls-tree -r --name-only/)
  assert.match(text, /Dedupe and cap at 20 paths/i)
})

test('PREDICTED_FILES_ASK: interpolates live ROOT/TARGET sentinels (not the module-scope null defaults)', function () {
  const context = harness.boot()
  const text = harness.readGlobal(context, "PREDICTED_FILES_ASK('SENTINEL_ROOT', 'SENTINEL_TARGET')")

  assert.ok(text.includes('SENTINEL_ROOT'), 'expected ROOT sentinel to appear in the emitted text')
  assert.ok(text.includes('SENTINEL_TARGET'), 'expected TARGET sentinel to appear in the emitted text')
  assert.ok(!text.includes('null'), 'literal "null" must not appear — proves ROOT/TARGET interpolation is live, not a captured module-scope null')
})
