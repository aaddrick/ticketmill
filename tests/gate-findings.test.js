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

// ---- CHALLENGE_SCHEMA.findings.items (issue #164) ----
//
// A structural assertion, not a behavioral one: tests/harness.js stubs
// agent() and never validates opts.schema, so no harness test in this suite
// can exercise the real JSON-schema validator against a live agent call. This
// reads the schema object straight off the vm context instead, to prove the
// required list actually changed rather than just trusting the source edit.

test('CHALLENGE_SCHEMA.findings.items: required is exactly [severity, summary], recommendation optional-but-declared (#164)', function () {
  const context = harness.boot()
  const schema = harness.readGlobal(context, 'CHALLENGE_SCHEMA')

  // Array.from(): required is a const array literal evaluated inside the vm
  // context, so it's a different-realm Array — deepEqual (this file's
  // assert.deepEqual is node:assert/strict, i.e. deepStrictEqual) checks
  // prototype identity and fails on a cross-realm array even with identical
  // contents. Array.from() rebuilds it same-realm first. See
  // tests/engine-owned.test.js:35 for the same hazard against ENGINE_OWNED_GLOBS.
  const required = Array.from(schema.properties.findings.items.required)
  assert.deepEqual(required, ['severity', 'summary'])

  assert.strictEqual(schema.properties.findings.items.properties.recommendation.type, 'string')
})

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

// ---- FIX_SCHEMA.rebutted (issue #167) ----
//
// Mirrors REVIEW_SCHEMA.issues (:450): declared on the schema so a fixer CAN
// disagree, but not in FIX_SCHEMA's own required list, so a fixer that never
// disagrees (every fixer before this issue) omits the key and validates
// exactly as before.

test('FIX_SCHEMA: required is still exactly [status, summary] — rebutted is declared but optional (#167)', function () {
  const context = harness.boot()
  const schema = harness.readGlobal(context, 'FIX_SCHEMA')

  assert.deepStrictEqual(Array.from(schema.required), ['status', 'summary'])
  assert.deepStrictEqual(Array.from(schema.properties.rebutted.items.required), ['finding_id', 'evidence'])
  assert.strictEqual(schema.properties.rebutted.type, 'array')
})

// ---- FINDING_HYPOTHESIS_ASK (issue #167) ----
//
// Shared verbatim by the three evaluator-fed fix stages (quality-fix,
// test-quality-fix, pr-fix). The consequence clause is gate-agnostic on
// purpose: it must read true whichever of the three gates renders it,
// including pr-review, where a rebuttal-only round continues into another
// review iteration rather than halting the gate on the spot — so the string
// must NOT claim an immediate exit or that no further fix round runs.

test('FINDING_HYPOTHESIS_ASK: contains no immediate-exit wording (#167)', function () {
  const context = harness.boot()
  const ask = harness.readGlobal(context, 'FINDING_HYPOTHESIS_ASK')

  assert.ok(!/ends this gate immediately/i.test(ask), 'must not claim the gate ends immediately: ' + ask)
  assert.ok(!/no further fix round runs/i.test(ask), 'must not claim no further fix round runs: ' + ask)
})

test('FINDING_HYPOTHESIS_ASK: carries the verify-before-acting, rebut-only-what-you-did-not-fix, and bracketed-id clauses', function () {
  const context = harness.boot()
  const ask = harness.readGlobal(context, 'FINDING_HYPOTHESIS_ASK')

  assert.ok(/hypothesis/i.test(ask), 'must frame findings as hypotheses: ' + ask)
  assert.ok(/rebutted/.test(ask), 'must name the `rebutted` field: ' + ask)
  assert.ok(/fixes_applied/.test(ask), 'must name the `fixes_applied` field: ' + ask)
  assert.ok(/bracketed id/i.test(ask), 'must restrict rebuttal to bracketed-id findings: ' + ask)
})

// ---- normalizeRebuttals(raw, findings) (issue #167) ----
//
// Turns FIX_SCHEMA's `rebutted` array into a validated list, mirroring
// normalizeFindings()'s fail-toward-existing-behavior contract: every drop
// (blank finding_id/evidence, an id absent from the rendered finding set)
// silently drops the entry rather than trusting it.

test('normalizeRebuttals: a non-array raw (undefined — a fixer that never disagreed) returns []', function () {
  const context = harness.boot()
  const findings = context.normalizeFindings([{ severity: 'major', summary: 'a' }], 'code-i1')

  harness.assertVmEqual(context.normalizeRebuttals(undefined, findings), [])
  harness.assertVmEqual(context.normalizeRebuttals(null, findings), [])
  harness.assertVmEqual(context.normalizeRebuttals('not an array', findings), [])
})

test('normalizeRebuttals: drops entries with a blank/missing finding_id', function () {
  const context = harness.boot()
  const findings = context.normalizeFindings([{ severity: 'major', summary: 'a' }], 'code-i1')

  const out = context.normalizeRebuttals([
    { finding_id: '', evidence: 'checked it, still wrong' },
    { evidence: 'no finding_id key at all' },
    { finding_id: '   ', evidence: 'whitespace-only id' },
  ], findings)

  harness.assertVmEqual(out, [])
})

test('normalizeRebuttals: drops entries with a blank/missing evidence', function () {
  const context = harness.boot()
  const findings = context.normalizeFindings([{ severity: 'major', summary: 'a' }], 'code-i1')

  const out = context.normalizeRebuttals([
    { finding_id: 'code-i1-1', evidence: '' },
    { finding_id: 'code-i1-1' },
    { finding_id: 'code-i1-1', evidence: '   ' },
  ], findings)

  harness.assertVmEqual(out, [])
})

test('normalizeRebuttals: drops a finding_id absent from the rendered finding set — a fixer cannot rebut an id it was never shown', function () {
  const context = harness.boot()
  const findings = context.normalizeFindings([{ severity: 'major', summary: 'a' }], 'code-i1')

  const out = context.normalizeRebuttals([
    { finding_id: 'code-i1-99', evidence: 'this id was never rendered to me' },
  ], findings)

  harness.assertVmEqual(out, [])
})

test('normalizeRebuttals: findings === null (issues omitted, prose-fallback path) drops every rebuttal — nothing was ever rendered with an id', function () {
  const context = harness.boot()

  const out = context.normalizeRebuttals([
    { finding_id: 'code-i1-1', evidence: 'some evidence' },
  ], null)

  harness.assertVmEqual(out, [])
})

test('normalizeRebuttals: a surviving entry carries the matched finding\'s summary through', function () {
  const context = harness.boot()
  const findings = context.normalizeFindings([
    { severity: 'major', summary: 'the null guard is too loose' },
    { severity: 'minor', summary: 'nit: naming' },
  ], 'code-i1')

  const out = context.normalizeRebuttals([
    { finding_id: 'code-i1-1', evidence: 'ran the reproducer at commit abc123, guard already covers this input' },
  ], findings)

  harness.assertVmEqual(out, [
    {
      finding_id: 'code-i1-1',
      evidence: 'ran the reproducer at commit abc123, guard already covers this input',
      summary: 'the null guard is too loose',
    },
  ])
})

test('normalizeRebuttals: arity is NOT preserved (unlike normalizeFindings) — drops are just dropped, never placeholder-preserved', function () {
  const context = harness.boot()
  const findings = context.normalizeFindings([{ severity: 'major', summary: 'a' }], 'code-i1')

  const out = context.normalizeRebuttals([
    { finding_id: 'code-i1-1', evidence: 'valid' },
    { finding_id: '', evidence: 'blank id, dropped' },
    { finding_id: 'code-i1-1', evidence: 'a second valid rebuttal of the same finding, also kept' },
  ], findings)

  assert.strictEqual(out.length, 2)
})

// ---- contestedBlock(ctx) (issue #167) ----
//
// Renders findings a fixer rebutted but nobody has adjudicated yet, back to
// the NEXT reviewer. Deliberately does NOT call settleDecision() — this is a
// dispute ledger, not an adjudication ledger.

test('contestedBlock: an empty/absent ctx.contested renders as the empty string', function () {
  const context = harness.boot()

  assert.strictEqual(context.contestedBlock({ contested: [] }), '')
  assert.strictEqual(context.contestedBlock({}), '')
  assert.strictEqual(context.contestedBlock(null), '')
  assert.strictEqual(context.contestedBlock(undefined), '')
})

test('contestedBlock: a single entry renders its gate, id, finding summary, and the fixer\'s evidence', function () {
  const context = harness.boot()
  const block = context.contestedBlock({
    contested: [
      { gate: 'quality', id: 'quality-task-1-i1-2', summary: 'the null guard is too loose', evidence: 'ran the reproducer, guard already covers this input' },
    ],
  })

  assert.ok(block.includes('quality'), 'must name the gate: ' + block)
  assert.ok(block.includes('quality-task-1-i1-2'), 'must name the finding id: ' + block)
  assert.ok(block.includes('the null guard is too loose'), 'must include the finding summary: ' + block)
  assert.ok(block.includes('ran the reproducer, guard already covers this input'), 'must include the fixer\'s evidence: ' + block)
})

test('contestedBlock: the heading names entries as contested and explicitly NOT adjudicated', function () {
  const context = harness.boot()
  const block = context.contestedBlock({ contested: [{ gate: 'quality', id: 'x-1', summary: 's', evidence: 'e' }] })
  const heading = block.split('\n')[0]

  assert.ok(/contested/i.test(heading), 'heading must name entries as contested: ' + heading)
  assert.ok(/not adjudicated/i.test(heading), 'heading must state these are NOT adjudicated: ' + heading)
})

test('contestedBlock: closing contract is INVERTED from settledBlock — it tells the reviewer to adjudicate, not to leave settled decisions alone', function () {
  const context = harness.boot()
  const block = context.contestedBlock({ contested: [{ gate: 'quality', id: 'x-1', summary: 's', evidence: 'e' }] })

  // settledBlock's contract discourages re-opening without new evidence;
  // contestedBlock's contract does the opposite — it requires the reviewer to
  // actually make a call (verify -> drop, or re-raise as a fresh finding).
  assert.ok(/verify the rebuttal/i.test(block), 'must instruct the reviewer to verify the rebuttal: ' + block)
  assert.ok(/drop/i.test(block), 'must offer "drop the finding" as one adjudicated outcome: ' + block)
  assert.ok(/re-raise/i.test(block), 'must offer "re-raise" as the other adjudicated outcome: ' + block)
  assert.ok(!/re-litigating.*process failure/i.test(block), 'must NOT carry settledBlock\'s discourage-reopening contract: ' + block)
})

test('contestedBlock: states a contested finding is not "already addressed" and that the iteration-2+ do-not-re-flag instruction does not apply to it', function () {
  const context = harness.boot()
  const block = context.contestedBlock({ contested: [{ gate: 'quality', id: 'x-1', summary: 's', evidence: 'e' }] })

  assert.ok(/not.*already addressed/i.test(block), 'must state a contested finding is not "already addressed": ' + block)
  assert.ok(/does not apply|not apply/i.test(block), 'must state the iteration-2+ do-not-re-flag instruction does not apply here: ' + block)
})

test('contestedBlock: renders only the last 6 entries', function () {
  const context = harness.boot()
  const contested = []
  for (let i = 1; i <= 9; i++) contested.push({ gate: 'quality', id: 'x-' + i, summary: 'summary ' + i, evidence: 'evidence ' + i })

  const block = context.contestedBlock({ contested: contested })

  for (let i = 1; i <= 3; i++) assert.ok(!new RegExp('\\bx-' + i + '\\b').test(block), 'entry x-' + i + ' should have been dropped by the last-6 window: ' + block)
  for (let i = 4; i <= 9; i++) assert.ok(new RegExp('\\bx-' + i + '\\b').test(block), 'entry x-' + i + ' should be within the last-6 window: ' + block)
})

// ---- retypeGateDisposition(ctx, gate, from, to) (issue #167) ----
//
// Moves exactly one count from disposition bucket `from` to `to` within an
// already-recorded ctx.gate_findings[gate] entry, without touching `count`
// or `severity`.

test('retypeGateDisposition: moves one count from an existing bucket to a new one, leaving count/severity untouched', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 10 })
  context.recordGateOutcome(ctx, 'quality', [{ severity: 'major', summary: 'a' }], 'carried-unresolved')

  context.retypeGateDisposition(ctx, 'quality', 'carried-unresolved', 'rebutted-unresolved')

  const g = ctx.gate_findings.quality
  assert.strictEqual(g.count, 1)
  harness.assertVmEqual(g.severity, { critical: 0, major: 1, minor: 0 })
  harness.assertVmEqual(g.disposition, { 'rebutted-unresolved': 1 })
})

test('retypeGateDisposition: is a no-op when the `from` bucket does not exist on that gate', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 11 })
  context.recordGateOutcome(ctx, 'quality', [{ severity: 'minor', summary: 'a' }], 'accepted')

  context.retypeGateDisposition(ctx, 'quality', 'carried-unresolved', 'rebutted-unresolved')

  harness.assertVmEqual(ctx.gate_findings.quality.disposition, { accepted: 1 })
})

test('retypeGateDisposition: is a no-op when the gate itself was never recorded — never throws', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 12 })

  assert.doesNotThrow(function () { context.retypeGateDisposition(ctx, 'quality', 'carried-unresolved', 'rebutted-unresolved') })
  assert.deepStrictEqual(ctx.gate_findings, {})
})

test('retypeGateDisposition: defensive against a missing/partial ctx — never throws', function () {
  const context = harness.boot()

  assert.doesNotThrow(function () { context.retypeGateDisposition(null, 'quality', 'a', 'b') })
  assert.doesNotThrow(function () { context.retypeGateDisposition({}, 'quality', 'a', 'b') })
})

test('retypeGateDisposition: from === to is a count-preserving no-op — reachable at MAX_QUALITY_ITERATIONS, where iteration 5 already books carried-unresolved before any fix runs', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 13 })
  context.recordGateOutcome(ctx, 'quality', [{ severity: 'major', summary: 'a' }], 'carried-unresolved')
  context.recordGateOutcome(ctx, 'quality', [{ severity: 'minor', summary: 'b' }], 'carried-unresolved')
  context.recordGateOutcome(ctx, 'quality', [{ severity: 'critical', summary: 'c' }], 'carried-unresolved')

  const before = JSON.parse(JSON.stringify(ctx.gate_findings.quality))

  context.retypeGateDisposition(ctx, 'quality', 'carried-unresolved', 'carried-unresolved')

  const g = ctx.gate_findings.quality
  assert.strictEqual(g.count, 3)
  harness.assertVmEqual(g.severity, { critical: 1, major: 1, minor: 1 })
  harness.assertVmEqual(g.disposition, { 'carried-unresolved': 3 })
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), before)
})
