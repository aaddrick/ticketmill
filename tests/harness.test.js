'use strict'

// Tests for the harness itself (tests/harness.js), not the engine's helpers —
// those get their own test files (see tests/*.test.js) once the harness is
// proven trustworthy. Two properties matter before anything is built on top of
// this harness:
//   1. __seed() actually mutates the module-scope `let` bindings it targets, and
//      that mutation is visible afterward (not just "didn't throw").
//   2. The harness has teeth: evaluating deliberately broken engine source makes
//      a real assertion about that source's behavior fail, proving this isn't a
//      syntax-only check like `node --check`.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('harness self-test: __seed mutates module-scope let bindings and the mutation reads back', function () {
  const context = harness.boot()

  // Before seeding, TEST_CMD is whatever the engine's own declaration initialized
  // it to (undefined — it's declared `let TEST_CMD` with no initializer).
  assert.strictEqual(harness.readGlobal(context, 'TEST_CMD'), undefined)

  assert.strictEqual(typeof context.__seed, 'function', 'expected __seed to attach to the vm global as a top-level function declaration')
  context.__seed({ TEST_CMD: 'npm test', PROFILE: { test_command: 'npm test' }, ROLES: { implementer: 'demo' } })

  // readGlobal() runs a second script in the SAME vm context, sharing the one
  // global lexical environment the first run created — this is what proves the
  // seed actually took, not merely that __seed() returned without throwing.
  assert.strictEqual(harness.readGlobal(context, 'TEST_CMD'), 'npm test')
  assert.deepStrictEqual(harness.readGlobal(context, 'PROFILE'), { test_command: 'npm test' })
  assert.deepStrictEqual(harness.readGlobal(context, 'ROLES'), { implementer: 'demo' })

  // 'k' in o membership: seeding TEST_CMD: null must be distinguishable from
  // "key omitted" — a profile with no test gate is a valid, explicit state.
  context.__seed({ TEST_CMD: null })
  assert.strictEqual(harness.readGlobal(context, 'TEST_CMD'), null)
})

test('harness teeth meta-test: disabling the stub-task guard fails the real assertion', function () {
  const raw = harness.loadTruncatedSource()
  const needle = 'if (t.description.length >= 12) return true'
  assert.ok(raw.includes(needle), 'mutation anchor not found — sanitizeTasks\' stub-guard source changed; update this meta-test')

  // Deliberately break the stub-task guard: accept any non-empty description,
  // including single-character stubs the real guard is supposed to drop.
  const mutated = raw.replace(needle, 'if (t.description.length >= 0) return true')
  assert.notStrictEqual(mutated, raw)

  const context = harness.loadEngine(harness.createContext(), mutated)
  const ctx = harness.makeCtx({ issue: 99 })
  const stubResult = context.sanitizeTasks(ctx, [{ id: 1, description: 'x' }])

  // This is the assertion a real sanitizeTasks unit test makes: a sub-12-char
  // stub description is dropped, leaving an empty task list. Under the mutated
  // source the guard no longer drops anything, so this assertion must fail —
  // proving the harness (and the eventual real test) actually catches the
  // regression instead of rubber-stamping any source that merely parses.
  assert.throws(function () {
    assert.strictEqual(stubResult.length, 0, 'stub task should have been dropped by sanitizeTasks')
  }, assert.AssertionError)

  // Control: the SAME check against the real, unmutated source passes — so the
  // failure above is caused by the mutation, not a bug in this meta-test.
  const realContext = harness.boot()
  const realResult = realContext.sanitizeTasks(harness.makeCtx({ issue: 99 }), [{ id: 1, description: 'x' }])
  assert.strictEqual(realResult.length, 0)
})

// ---- issue #165: freshMetrics() (above) is hand-synced to processIssue()'s
// ctx.metrics object literal in workflows/ticketmill.js because the harness
// can't import the engine — this parity test gives that hand-sync contract
// teeth. It regex-reads the single-line `metrics: { ... },` literal straight
// out of the engine source and asserts its key set equals
// Object.keys(harness.freshMetrics()), so a field added/removed on either
// side without the other fails loudly here instead of silently drifting. ----

test('harness parity: freshMetrics() key set matches the single-line metrics literal in workflows/ticketmill.js', function () {
  const raw = harness.readEngineSource()

  // Exactly one `metrics: { ... },` literal is expected in the whole file
  // (processIssue()'s ctx init) — matched on its own line so a second,
  // unrelated `metrics:` occurrence elsewhere can't be picked up by accident.
  const matches = raw.match(/^\s*metrics:\s*\{[^\n{}]*\},\s*$/gm) || []
  assert.strictEqual(matches.length, 1, 'expected exactly one single-line "metrics: { ... }," literal in workflows/ticketmill.js — if it moved, was reformatted across lines, or a second one was added, update this regex and tests/harness.js\'s freshMetrics() together: found ' + matches.length)

  const body = matches[0].replace(/^\s*metrics:\s*\{/, '').replace(/\},\s*$/, '')
  const engineKeys = body.split(',').map(function (pair) { return pair.trim().split(':')[0].trim() }).filter(Boolean)
  assert.ok(engineKeys.length > 0, 'expected to parse at least one key out of the metrics literal: ' + matches[0])

  const harnessKeys = Object.keys(harness.freshMetrics())
  assert.deepStrictEqual(engineKeys.slice().sort(), harnessKeys.slice().sort(), 'freshMetrics() key set has drifted from workflows/ticketmill.js\'s metrics literal')
})
