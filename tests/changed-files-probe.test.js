'use strict'

// Unit tests for probeChangedFiles(ctx) (issue #87 task 1) — the READ-ONLY
// diff probe reviewAndMerge() calls once, unconditionally, immediately before
// the merge stage, to capture the FINAL changed/added file lists (including
// any PR-review fixes and auto-resolve rebasing) into ctx.changed_files/
// ctx.added_files for downstream analytics.
//
// Modeled on tests/engine-owned.test.js's runEngineOwnedGate tests (same
// DIFF_PROBE_SCHEMA-shaped 'changed-files-probe' stage), but this is a
// DIFFERENT probe — runEngineOwnedGate's own inline post-implement probe is
// untouched and out of scope here; see the doc comment directly above
// probeChangedFiles() in workflows/ticketmill.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

function seedProbe(context, overrides) {
  context.__seed(Object.assign({ REPO: 'aaddrick/ticketmill-fixture', TARGET: 'Batch_fixture' }, overrides))
}

test('probeChangedFiles: success path populates ctx.changed_files and ctx.added_files from the probe response', async function () {
  const context = harness.boot()
  seedProbe(context)
  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    assert.strictEqual(label, '9:changed-files-probe')
    return { changed_files: ['workflows/ticketmill.js', 'tests/changed-files-probe.test.js'], added_files: ['tests/changed-files-probe.test.js'] }
  })

  const ctx = harness.makeCtx({ issue: 9 })
  await context.probeChangedFiles(ctx)

  assert.deepStrictEqual(ctx.changed_files, ['workflows/ticketmill.js', 'tests/changed-files-probe.test.js'])
  assert.deepStrictEqual(ctx.added_files, ['tests/changed-files-probe.test.js'])
  assert.deepStrictEqual(ctx.deferred, [])
})

test('probeChangedFiles: an empty diff (nothing changed) sets both lists to [], not null — "captured, zero files" must stay distinguishable from "probe never ran"', async function () {
  const context = harness.boot()
  seedProbe(context)
  harness.installScriptedAgent(context, function () { return { changed_files: [], added_files: [] } })

  const ctx = harness.makeCtx({ issue: 10 })
  await context.probeChangedFiles(ctx)

  assert.deepStrictEqual(ctx.changed_files, [])
  assert.deepStrictEqual(ctx.added_files, [])
  assert.notStrictEqual(ctx.changed_files, null)
})

test('probeChangedFiles: an omitted added_files field (schema does not require it) defaults to []', async function () {
  const context = harness.boot()
  seedProbe(context)
  harness.installScriptedAgent(context, function () { return { changed_files: ['README.md'] } })

  const ctx = harness.makeCtx({ issue: 11 })
  await context.probeChangedFiles(ctx)

  assert.deepStrictEqual(ctx.changed_files, ['README.md'])
  // The fallback `[]` here is constructed INSIDE probeChangedFiles' own vm
  // realm (probe.added_files is undefined so the `||` right-hand side fires),
  // so it carries a different-realm Array.prototype than this test file's
  // literal — Array.from() rebuilds it in THIS realm before comparing (same
  // workaround tests/engine-owned.test.js documents for ENGINE_OWNED_GLOBS).
  assert.deepStrictEqual(Array.from(ctx.added_files), [])
})

test('probeChangedFiles: a dead probe (agent returns null through every retry) degrades — ctx.changed_files/added_files stay null (never []), and a deferred note is recorded, never throwing or blocking the caller', async function () {
  const context = harness.boot()
  seedProbe(context)
  harness.installScriptedAgent(context, function () { return null }) // simulates a dead agent call, exhausting stage()'s retries

  const ctx = harness.makeCtx({ issue: 12 })
  await context.probeChangedFiles(ctx)

  assert.strictEqual(ctx.changed_files, null)
  assert.strictEqual(ctx.added_files, null)
  assert.strictEqual(ctx.deferred.length, 1)
  assert.ok(ctx.deferred[0].includes('Changed-files probe'), ctx.deferred[0])
  assert.ok(ctx.deferred[0].includes('#12'), ctx.deferred[0])
})
