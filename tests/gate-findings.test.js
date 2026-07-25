'use strict'

// Unit tests for recordGateOutcome(ctx, gate, findings, disposition) (issue #87
// task 4) — the pure per-gate tally that accumulates ctx.gate_findings[gate]
// across the approach/plan contrarian gates' iterations: a running finding
// count, a severity mix (critical/major/minor), and a disposition histogram
// (accepted / carried-unresolved / re-litigated / dismissed — one of the four
// exact outcomes those gates' own control flow already distinguishes).

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ctx.gate_findings' nested {severity, disposition} objects are built inside
// the vm-realm engine function, so their prototype differs from this file's
// own object literals and fails deepStrictEqual's prototype check even when
// structurally identical (same cross-realm reasoning as tests/token-usage.test.js's
// Object.assign({}, ...) and the harness's documented Array.from(...) workaround).
// The data is plain JSON (numbers/strings only), so a JSON round-trip is a safe,
// realm-agnostic normalizer for the whole nested shape.
function plain(x) { return JSON.parse(JSON.stringify(x)) }

test('recordGateOutcome: a fresh gate key tallies count and severity mix from its findings', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 1 })

  context.recordGateOutcome(ctx, 'approach', [
    { severity: 'critical', summary: 'a' },
    { severity: 'major', summary: 'b' },
    { severity: 'minor', summary: 'c' },
  ], 'carried-unresolved')

  assert.deepStrictEqual(plain(ctx.gate_findings.approach), {
    count: 3,
    severity: { critical: 1, major: 1, minor: 1 },
    disposition: { 'carried-unresolved': 1 },
  })
})

test('recordGateOutcome: repeated calls for the same gate accumulate rather than overwrite', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 2 })

  context.recordGateOutcome(ctx, 'plan', [{ severity: 'major', summary: 'x' }], 're-litigated')
  context.recordGateOutcome(ctx, 'plan', [{ severity: 'major', summary: 'y' }, { severity: 'minor', summary: 'z' }], 're-litigated')
  context.recordGateOutcome(ctx, 'plan', [], 'accepted')

  const g = ctx.gate_findings.plan
  assert.strictEqual(g.count, 3)
  assert.deepStrictEqual(plain(g.severity), { critical: 0, major: 2, minor: 1 })
  assert.deepStrictEqual(plain(g.disposition), { 're-litigated': 2, accepted: 1 })
})

test('recordGateOutcome: different gate keys tally independently', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 3 })

  context.recordGateOutcome(ctx, 'approach', [{ severity: 'critical', summary: 'a' }], 'accepted')
  context.recordGateOutcome(ctx, 'plan', [{ severity: 'minor', summary: 'b' }], 'dismissed')

  assert.strictEqual(ctx.gate_findings.approach.count, 1)
  assert.strictEqual(ctx.gate_findings.plan.count, 1)
  assert.deepStrictEqual(plain(ctx.gate_findings.approach.disposition), { accepted: 1 })
  assert.deepStrictEqual(plain(ctx.gate_findings.plan.disposition), { dismissed: 1 })
})

test('recordGateOutcome: a "dismissed" outcome (dead challenger) with no findings still tallies the disposition', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 4 })

  context.recordGateOutcome(ctx, 'approach', [], 'dismissed')

  assert.deepStrictEqual(plain(ctx.gate_findings.approach), {
    count: 0,
    severity: { critical: 0, major: 0, minor: 0 },
    disposition: { dismissed: 1 },
  })
})

test('recordGateOutcome: an unrecognized/missing severity value is counted but not bucketed (never throws)', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 5 })

  context.recordGateOutcome(ctx, 'approach', [{ summary: 'no severity field' }], 'accepted')

  const g = ctx.gate_findings.approach
  assert.strictEqual(g.count, 1)
  assert.deepStrictEqual(plain(g.severity), { critical: 0, major: 0, minor: 0 })
})

test('recordGateOutcome: defensive against a missing/partial ctx or gate name — never throws', function () {
  const context = harness.boot()

  assert.doesNotThrow(function () { context.recordGateOutcome(null, 'approach', [{ severity: 'major' }], 'accepted') })
  assert.doesNotThrow(function () { context.recordGateOutcome({}, 'approach', [{ severity: 'major' }], 'accepted') })
  const ctx = harness.makeCtx({ issue: 6 })
  assert.doesNotThrow(function () { context.recordGateOutcome(ctx, '', [{ severity: 'major' }], 'accepted') })
  assert.deepStrictEqual(ctx.gate_findings, {})
})

// ---- wiring into an actual return site: fail() carries ctx.gate_findings through ----

test('fail(): the returned result carries ctx.gate_findings exactly as tallied', async function () {
  const context = harness.boot()
  context.__seed({ REPO: 'aaddrick/ticketmill-fixture', TARGET: 'Batch_fixture' })
  harness.installScriptedAgent(context, function () { return { posted: true } })

  const ctx = harness.makeCtx({ issue: 8 })
  context.recordGateOutcome(ctx, 'approach', [{ severity: 'major', summary: 'm' }], 'carried-unresolved')

  const result = await context.fail(ctx, 'needs_human', 'some-stage', 'boom')

  assert.deepStrictEqual(plain(result.gate_findings.approach), {
    count: 1,
    severity: { critical: 0, major: 1, minor: 0 },
    disposition: { 'carried-unresolved': 1 },
  })
})
