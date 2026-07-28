'use strict'

// Unit tests for recordGateOutcome(ctx, gate, findings, disposition) (issue #87
// task 4) — the pure per-gate tally that accumulates ctx.gate_findings[gate]
// across the approach/plan contrarian gates' iterations: a running finding
// count, a severity mix (critical/major/minor), and a disposition histogram
// (accepted / carried-unresolved / re-litigated / dismissed — one of the four
// exact outcomes those gates' own control flow already distinguishes).
//
// Also covers normalizeFindings()/findingsBlock() (issue #162) — the helpers
// that turn a REVIEW_SCHEMA `issues` array into engine-assigned structured
// findings and render them for the fix stages, with the reviewer-omitted-the-
// key case falling back to today's prose path.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('recordGateOutcome: a fresh gate key tallies count and severity mix from its findings', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 1 })

  context.recordGateOutcome(ctx, 'approach', [
    { severity: 'critical', summary: 'a' },
    { severity: 'major', summary: 'b' },
    { severity: 'minor', summary: 'c' },
  ], 'carried-unresolved')

  harness.assertVmEqual(ctx.gate_findings.approach, {
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
  harness.assertVmEqual(g.severity, { critical: 0, major: 2, minor: 1 })
  harness.assertVmEqual(g.disposition, { 're-litigated': 2, accepted: 1 })
})

test('recordGateOutcome: different gate keys tally independently', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 3 })

  context.recordGateOutcome(ctx, 'approach', [{ severity: 'critical', summary: 'a' }], 'accepted')
  context.recordGateOutcome(ctx, 'plan', [{ severity: 'minor', summary: 'b' }], 'dismissed')

  assert.strictEqual(ctx.gate_findings.approach.count, 1)
  assert.strictEqual(ctx.gate_findings.plan.count, 1)
  harness.assertVmEqual(ctx.gate_findings.approach.disposition, { accepted: 1 })
  harness.assertVmEqual(ctx.gate_findings.plan.disposition, { dismissed: 1 })
})

test('recordGateOutcome: a "quality" gate key tallies independently, without perturbing the "approach"/"plan" buckets already recorded on the same ctx', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 3.5 })

  context.recordGateOutcome(ctx, 'approach', [{ severity: 'critical', summary: 'a' }], 'accepted')
  context.recordGateOutcome(ctx, 'plan', [{ severity: 'minor', summary: 'b' }], 'dismissed')
  context.recordGateOutcome(ctx, 'quality', [
    { severity: 'major', summary: 'c' },
    { severity: 'major', summary: 'd' },
  ], 're-litigated')

  harness.assertVmEqual(ctx.gate_findings.quality, {
    count: 2,
    severity: { critical: 0, major: 2, minor: 0 },
    disposition: { 're-litigated': 1 },
  })
  // The pre-existing keys are untouched by the new 'quality' call.
  assert.strictEqual(ctx.gate_findings.approach.count, 1)
  harness.assertVmEqual(ctx.gate_findings.approach.disposition, { accepted: 1 })
  assert.strictEqual(ctx.gate_findings.plan.count, 1)
  harness.assertVmEqual(ctx.gate_findings.plan.disposition, { dismissed: 1 })
})

test('recordGateOutcome: a "dismissed" outcome (dead challenger) with no findings still tallies the disposition', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 4 })

  context.recordGateOutcome(ctx, 'approach', [], 'dismissed')

  harness.assertVmEqual(ctx.gate_findings.approach, {
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
  harness.assertVmEqual(g.severity, { critical: 0, major: 0, minor: 0 })
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

  harness.assertVmEqual(result.gate_findings.approach, {
    count: 1,
    severity: { critical: 0, major: 1, minor: 0 },
    disposition: { 'carried-unresolved': 1 },
  })
})

// ---- normalizeFindings(raw, source) (issue #162) ----
//
// Turns a REVIEW_SCHEMA `issues` array into the engine's structured finding
// shape, or signals "reviewer omitted the key" (null) so fix-stage call sites
// can fall back to today's prose-only prompt byte-for-byte.

test('normalizeFindings: a non-array raw (undefined — the reviewer omitted `issues`) returns null', function () {
  const context = harness.boot()
  assert.strictEqual(context.normalizeFindings(undefined, 'quality-task-1-i1'), null)
  assert.strictEqual(context.normalizeFindings(null, 'quality-task-1-i1'), null)
  assert.strictEqual(context.normalizeFindings('not an array', 'quality-task-1-i1'), null)
})

test('normalizeFindings: an empty array returns an empty array, not null', function () {
  const context = harness.boot()
  harness.assertVmEqual(context.normalizeFindings([], 'quality-task-1-i1'), [])
})

test('normalizeFindings: assigns stable engine ids across a multi-entry array as source + "-" + (i+1)', function () {
  const context = harness.boot()
  const out = context.normalizeFindings([
    { severity: 'critical', summary: 'a', recommendation: 'fix a' },
    { severity: 'major', summary: 'b' },
    { severity: 'minor', summary: 'c' },
  ], 'code-i2')

  harness.assertVmEqual(out, [
    { id: 'code-i2-1', severity: 'critical', summary: 'a', recommendation: 'fix a' },
    { id: 'code-i2-2', severity: 'major', summary: 'b', recommendation: '' },
    { id: 'code-i2-3', severity: 'minor', summary: 'c', recommendation: '' },
  ])
})

test('normalizeFindings: a bare-string entry becomes {summary: String(entry)} with an unspecified severity', function () {
  const context = harness.boot()
  const out = context.normalizeFindings(['just a string finding'], 'quality-task-1-i1')

  harness.assertVmEqual(out, [{ id: 'quality-task-1-i1-1', severity: 'unspecified', summary: 'just a string finding' }])
})

test('normalizeFindings: an out-of-enum/missing severity coerces to "unspecified" (defence-in-depth, not a validated live path)', function () {
  const context = harness.boot()
  const out = context.normalizeFindings([
    { severity: 'blocker', summary: 'bad enum value' },
    { summary: 'no severity field at all' },
  ], 'quality-task-1-i1')

  assert.strictEqual(out[0].severity, 'unspecified')
  assert.strictEqual(out[1].severity, 'unspecified')
})

test('normalizeFindings: arity is preserved even when one entry in the array is malformed', function () {
  const context = harness.boot()
  const out = context.normalizeFindings([
    { severity: 'major', summary: 'a real finding' },
    null,
    { severity: 'minor', summary: 'another real finding' },
  ], 'quality-task-1-i1')

  assert.strictEqual(out.length, 3)
  assert.strictEqual(out[0].id, 'quality-task-1-i1-1')
  assert.strictEqual(out[1].id, 'quality-task-1-i1-2')
  assert.strictEqual(out[1].severity, 'unspecified')
  assert.strictEqual(out[2].id, 'quality-task-1-i1-3')
})

// ---- findingsBlock(findings, comments, fallbackLabel) (issue #162) ----
//
// The single renderer feeding every fix stage. Three branches: null (omitted
// issues -> today's prose path, byte-identical), non-empty (rendered work
// list + prose context), empty array (explicit no-findings line + prose still
// present — an empty array never suppresses or demotes prose).

test('findingsBlock: findings === null emits exactly what the site emitted before this change (comments || summary || fallback)', function () {
  const context = harness.boot()
  assert.strictEqual(context.findingsBlock(null, 'reviewer prose comments', 'fallback label'), 'reviewer prose comments')
  assert.strictEqual(context.findingsBlock(null, '', 'reviewer summary as fallback'), 'reviewer summary as fallback')
  assert.strictEqual(context.findingsBlock(null, undefined, undefined), '')
})

test('findingsBlock: a non-empty findings array renders the "- [id] [severity] summary -> recommendation" line shape plus a context-labeled prose block', function () {
  const context = harness.boot()
  const findings = [
    { id: 'code-i2-3', severity: 'major', summary: 'summary', recommendation: 'recommendation' },
  ]
  const block = context.findingsBlock(findings, 'some prose comments', 'fallback')

  assert.ok(block.includes('- [code-i2-3] [major] summary -> recommendation'), 'missing the rendered finding line: ' + block)
  assert.ok(/context/i.test(block), 'prose heading must be labeled as context, not the work list: ' + block)
  assert.ok(block.includes('some prose comments'), 'prose comments must still render below the findings: ' + block)
})

test('findingsBlock: an empty findings array emits an explicit no-findings line AND still renders the prose block below (never suppresses/demotes prose)', function () {
  const context = harness.boot()
  const block = context.findingsBlock([], 'this prose must still show up', 'fallback')

  assert.ok(/no structured findings/i.test(block), 'must state plainly that no structured findings were named: ' + block)
  assert.ok(block.includes('this prose must still show up'), 'prose must not be suppressed/demoted by an empty findings array: ' + block)
})

test('findingsBlock: a non-null findings array with falsy comments falls back to fallbackLabel, not "(none)" (PR #169 code review)', function () {
  const context = harness.boot()
  const findings = [
    { id: 'code-i1-1', severity: 'minor', summary: 'summary', recommendation: 'recommendation' },
  ]

  // Non-empty findings, empty comments: every call site passes `rev.summary ||
  // '<label>'` as fallbackLabel, so this is the exact shape a reviewer that
  // fills `issues` and `summary` but leaves `comments` empty produces.
  const nonEmptyBlock = context.findingsBlock(findings, '', 'reviewer summary as fallback')
  assert.ok(nonEmptyBlock.includes('reviewer summary as fallback'), 'must fall back to fallbackLabel, not drop it: ' + nonEmptyBlock)
  assert.ok(!nonEmptyBlock.includes('(none)'), 'must not show the bare "(none)" placeholder when a fallbackLabel is available: ' + nonEmptyBlock)

  // Empty findings, empty comments: same fallback chain applies.
  const emptyBlock = context.findingsBlock([], '', 'reviewer summary as fallback')
  assert.ok(emptyBlock.includes('reviewer summary as fallback'), 'must fall back to fallbackLabel, not drop it: ' + emptyBlock)

  // No comments AND no fallbackLabel: the chain's final link still applies.
  const noFallbackBlock = context.findingsBlock(findings, '', '')
  assert.ok(noFallbackBlock.includes('(none)'), 'must fall through to the literal "(none)" placeholder when nothing else is available: ' + noFallbackBlock)
})

// ---- nothingToFix(r, f) (issue #162) ----
//
// Per-reviewer predicate used only by the pr-review merge gate: true when this
// ONE reviewer, alone, has nothing actionable — either an outright approval
// (regardless of what `issues` carries alongside it — the doc comment above
// nothingToFix is explicit that this holds "regardless of what issues carries
// alongside an approval"), or a changes_requested with a present-but-empty
// normalized findings array. `f === null` (issues omitted) is deliberately NOT
// nothing-to-fix on its own. Every pr-review-gate.test.js fixture with an
// approved reviewer also happens to carry issues: [], which independently
// satisfies the second branch, and bothNothingToFix's own AND short-circuits
// before nothingToFix ever runs when both reviewers approve (prReviewClean).
// So none of those scenarios can tell the two branches of the OR apart. These
// units isolate each branch directly against the real function.

test('nothingToFix: an approved result is nothing-to-fix even when issues alongside it is non-empty', function () {
  const context = harness.boot()
  const approvedWithIssues = { result: 'approved', issues: [{ severity: 'minor', summary: 'nit' }] }
  const findings = context.normalizeFindings(approvedWithIssues.issues, 'code-i1')

  assert.strictEqual(context.nothingToFix(approvedWithIssues, findings), true)
})

test('nothingToFix: an approved result is nothing-to-fix even when findings is null (issues omitted)', function () {
  const context = harness.boot()
  const approvedNoIssuesKey = { result: 'approved' }

  assert.strictEqual(context.nothingToFix(approvedNoIssuesKey, null), true)
})

test('nothingToFix: a changes_requested result with a present-but-empty findings array is nothing-to-fix', function () {
  const context = harness.boot()
  const changesRequestedEmpty = { result: 'changes_requested' }

  assert.strictEqual(context.nothingToFix(changesRequestedEmpty, []), true)
})

test('nothingToFix: a changes_requested result with findings === null (issues omitted) is NOT nothing-to-fix', function () {
  const context = harness.boot()
  const changesRequestedOmitted = { result: 'changes_requested' }

  assert.strictEqual(context.nothingToFix(changesRequestedOmitted, null), false)
})

test('nothingToFix: a changes_requested result with a non-empty findings array is NOT nothing-to-fix', function () {
  const context = harness.boot()
  const changesRequestedReal = { result: 'changes_requested' }
  const findings = context.normalizeFindings([{ severity: 'major', summary: 'real problem' }], 'code-i1')

  assert.strictEqual(context.nothingToFix(changesRequestedReal, findings), false)
})
