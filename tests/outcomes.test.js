'use strict'

// Unit tests for the issue #92 outcome-grading pure core: gradeFromObservation(),
// buildOutcomeLine(), diffOutcomeGrades(), summarizeOutcomeCoverage() (workflows/
// ticketmill.js, above the TICKETMILL-TEST-HARNESS-SPLIT marker).
//
// The premise these guard: the engine's current self-improvement signal is almost
// entirely process friction (iteration counts, gate findings), never verified
// OUTCOME quality — a run can sail through every gate friction-free and still ship
// a defect. This pure core turns raw, live-resolved gh signals (reverted / issue
// reopened / hotfixed / held up cleanly) into a deterministic grade, with
// asymmetric aging (bad news is trusted immediately; good news must wait
// min_age_days before it's certified) so "no negative signal yet" is never
// silently reported as "clean".

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// Values returned by vm-realm functions have a different prototype than this
// file's own object/array literals, which trips deepStrictEqual's prototype
// check even when structurally identical (same cross-realm reasoning as
// tests/gate-findings.test.js's/tests/gate-yield.test.js's plain() helper).
function plain(x) { return JSON.parse(JSON.stringify(x)) }

const DAY_MS = 86400000
const NOW = Date.parse('2026-07-25T00:00:00Z')

function daysAgoIso(days) {
  return new Date(NOW - days * DAY_MS).toISOString()
}

function baseObservation(over) {
  return Object.assign({
    pr_state: 'merged',
    merged_at: daysAgoIso(10),
    reverted: false,
    reopened: false,
    hotfix_pr: null,
    issue_state: 'closed',
    abandoned: false,
  }, over)
}

// ---- gradeFromObservation: min-age gating ----

test('gradeFromObservation: merged and clean but younger than min_age_days grades pending, not clean', function () {
  const context = harness.boot()
  const obs = baseObservation({ merged_at: daysAgoIso(3) })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'pending')
})

test('gradeFromObservation: merged and clean at exactly min_age_days grades clean (boundary is inclusive)', function () {
  const context = harness.boot()
  const obs = baseObservation({ merged_at: daysAgoIso(7) })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'clean')
})

test('gradeFromObservation: merged and clean well past min_age_days grades clean', function () {
  const context = harness.boot()
  const obs = baseObservation({ merged_at: daysAgoIso(30) })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'clean')
})

test('gradeFromObservation: a higher-than-default min_age_days from cfg tightens the gate', function () {
  const context = harness.boot()
  const obs = baseObservation({ merged_at: daysAgoIso(10) })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 30 })
  assert.strictEqual(g.grade, 'pending')
})

test('gradeFromObservation: omitted cfg falls back to the module OUTCOME_GRADING default (min_age_days 7)', function () {
  const context = harness.boot()
  const old = context.gradeFromObservation(baseObservation({ merged_at: daysAgoIso(8) }), NOW)
  const young = context.gradeFromObservation(baseObservation({ merged_at: daysAgoIso(2) }), NOW)
  assert.strictEqual(old.grade, 'clean')
  assert.strictEqual(young.grade, 'pending')
})

// ---- gradeFromObservation: asymmetric aging (negative signals fire immediately) ----

test('gradeFromObservation: a revert grades "reverted" immediately, even one day old', function () {
  const context = harness.boot()
  const obs = baseObservation({ merged_at: daysAgoIso(1), reverted: true })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'reverted')
})

test('gradeFromObservation: a reopened issue grades "reopened" immediately, even one day old', function () {
  const context = harness.boot()
  const obs = baseObservation({ merged_at: daysAgoIso(1), reopened: true })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'reopened')
})

test('gradeFromObservation: a cross-referenced hotfix PR grades "hotfix" immediately, even one day old', function () {
  const context = harness.boot()
  const obs = baseObservation({ merged_at: daysAgoIso(1), hotfix_pr: 555 })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'hotfix')
})

test('gradeFromObservation: negative signals outrank each other in a stable precedence (reverted first)', function () {
  const context = harness.boot()
  const obs = baseObservation({ reverted: true, reopened: true, hotfix_pr: 1 })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'reverted')
})

// ---- gradeFromObservation: terminal escape (pending's escape hatch) ----

test('gradeFromObservation: a batch PR closed without merging grades "closed_unmerged", not pending forever', function () {
  const context = harness.boot()
  const obs = baseObservation({ pr_state: 'closed', merged_at: null })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'closed_unmerged')
})

test('gradeFromObservation: an abandoned issue grades "abandoned", not pending forever', function () {
  const context = harness.boot()
  const obs = baseObservation({ pr_state: 'open', merged_at: null, abandoned: true })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'abandoned')
})

test('gradeFromObservation: a still-open batch PR with no other signal grades pending (not yet resolvable either way)', function () {
  const context = harness.boot()
  const obs = baseObservation({ pr_state: 'open', merged_at: null })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'pending')
})

// ---- deriveAbandoned (issue #103): wires issue closed-state through to the ----
// ---- `abandoned` observation field gradeFromObservation's branch 5 reads.  ----

test('deriveAbandoned: issue closed, batch PR still open -> true (the genuine gap #103 closes)', function () {
  const context = harness.boot()
  assert.strictEqual(context.deriveAbandoned('closed', 'open'), true)
})

test('deriveAbandoned: issue closed, no batch PR ever created (live_merge_state "none") -> true', function () {
  const context = harness.boot()
  assert.strictEqual(context.deriveAbandoned('closed', 'none'), true)
})

test('deriveAbandoned: issue closed, batch PR itself closed unmerged -> true', function () {
  const context = harness.boot()
  assert.strictEqual(context.deriveAbandoned('closed', 'closed'), true)
})

test('deriveAbandoned: issue closed, batch PR merged -> false (a merged PR never yields abandoned)', function () {
  const context = harness.boot()
  assert.strictEqual(context.deriveAbandoned('closed', 'merged'), false)
})

test('deriveAbandoned: issue closed, live_merge_state unknown -> false (a transient gh read failure never yields a terminal grade)', function () {
  const context = harness.boot()
  assert.strictEqual(context.deriveAbandoned('closed', 'unknown'), false)
})

test('deriveAbandoned: issue still open -> false, regardless of live_merge_state', function () {
  const context = harness.boot()
  assert.strictEqual(context.deriveAbandoned('open', 'open'), false)
})

test('deriveAbandoned: issue_state "unknown" (valid OUTCOMES_SCHEMA enum member) -> false, even with an otherwise-qualifying live_merge_state', function () {
  const context = harness.boot()
  assert.strictEqual(context.deriveAbandoned('unknown', 'open'), false)
})

test('gradeFromObservation: signals object always carries the raw fields the grade was decided from', function () {
  const context = harness.boot()
  const obs = baseObservation({ merged_at: daysAgoIso(10), hotfix_pr: 42 })
  const g = context.gradeFromObservation(obs, NOW, { min_age_days: 7 })
  assert.strictEqual(plain(g.signals).hotfix_pr, 42)
  assert.strictEqual(plain(g.signals).pr_state, 'merged')
})

// ---- buildOutcomeLine: schema_version stamp + compact shape ----

test('buildOutcomeLine stamps schema_version:1 and carries every field verbatim', function () {
  const context = harness.boot()
  const line = context.buildOutcomeLine({
    run_tag: '2026-07-18',
    batch_pr: 200,
    issue: 87,
    grade: 'clean',
    signals: { pr_state: 'merged' },
    decided_at: '2026-07-25T00:00:00Z',
  })
  assert.strictEqual(line.schema_version, 1)
  assert.strictEqual(line.run_tag, '2026-07-18')
  assert.strictEqual(line.batch_pr, 200)
  assert.strictEqual(line.issue, 87)
  assert.strictEqual(line.grade, 'clean')
  assert.strictEqual(plain(line.signals).pr_state, 'merged')
  assert.strictEqual(line.decided_at, '2026-07-25T00:00:00Z')
  // compact single-line contract, same hard rule as buildLedgerLine.
  assert.strictEqual(JSON.stringify(line).indexOf('\n'), -1)
})

test('buildOutcomeLine defaults signals to {} when omitted, never leaves it undefined', function () {
  const context = harness.boot()
  const line = context.buildOutcomeLine({ run_tag: 'r', batch_pr: 1, issue: 2, grade: 'pending', decided_at: 'x' })
  assert.deepStrictEqual(plain(line.signals), {})
})

// ---- per-issue keying ----

test('buildOutcomeLine/outcome ledger keys per member issue: two issues sharing one batch_pr are independent rows', function () {
  const context = harness.boot()
  const lineA = context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 900, issue: 10, grade: 'clean', decided_at: 'x' })
  const lineB = context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 900, issue: 11, grade: 'reverted', decided_at: 'x' })
  // Different keys despite the same run_tag+batch_pr — diffOutcomeGrades must
  // treat them as two independent targets, not collapse/overwrite one another.
  const diff = context.diffOutcomeGrades([lineA, lineB], [])
  assert.strictEqual(diff.length, 2)
  const grades = plain(diff).map(function (l) { return l.grade }).sort()
  assert.deepStrictEqual(grades, ['clean', 'reverted'])
})

// ---- diffOutcomeGrades: new/changed-only ----

test('diffOutcomeGrades: a key absent from the prior ledger is emitted as new', function () {
  const context = harness.boot()
  const current = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'pending', decided_at: 'x' })]
  const diff = context.diffOutcomeGrades(current, [])
  assert.strictEqual(diff.length, 1)
  assert.strictEqual(plain(diff)[0].grade, 'pending')
})

test('diffOutcomeGrades: an unchanged grade vs. the prior ledger is NOT re-emitted', function () {
  const context = harness.boot()
  const prior = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'pending', decided_at: 'x' })]
  const current = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'pending', decided_at: 'y' })]
  const diff = context.diffOutcomeGrades(current, prior)
  assert.strictEqual(diff.length, 0)
})

test('diffOutcomeGrades: a changed grade vs. the prior ledger (pending -> clean) IS re-emitted', function () {
  const context = harness.boot()
  const prior = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'pending', decided_at: 'x' })]
  const current = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'clean', decided_at: 'y' })]
  const diff = context.diffOutcomeGrades(current, prior)
  assert.strictEqual(diff.length, 1)
  assert.strictEqual(plain(diff)[0].grade, 'clean')
})

test('diffOutcomeGrades: unrelated keys in the prior ledger are untouched/ignored', function () {
  const context = harness.boot()
  const prior = [context.buildOutcomeLine({ run_tag: 'r0', batch_pr: 99, issue: 1, grade: 'clean', decided_at: 'x' })]
  const current = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'pending', decided_at: 'y' })]
  const diff = context.diffOutcomeGrades(current, prior)
  assert.strictEqual(diff.length, 1)
  assert.strictEqual(plain(diff)[0].run_tag, 'r1')
})

// ---- diffOutcomeGrades: skip-terminal ----

test('diffOutcomeGrades: a key already terminal (reverted) in the prior ledger is skipped even if current disagrees', function () {
  const context = harness.boot()
  const prior = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'reverted', decided_at: 'x' })]
  // A hypothetical re-observation somehow produced a different grade this pass —
  // skip-terminal means the settled terminal grade is never overwritten.
  const current = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'clean', decided_at: 'y' })]
  const diff = context.diffOutcomeGrades(current, prior)
  assert.strictEqual(diff.length, 0)
})

test('diffOutcomeGrades: each OUTCOME_TERMINAL_GRADES value is skipped once settled in the prior ledger', function () {
  const context = harness.boot()
  const grades = ['reverted', 'reopened', 'hotfix', 'closed_unmerged', 'abandoned']
  for (const grade of grades) {
    const prior = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: grade, decided_at: 'x' })]
    const current = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: grade, decided_at: 'y' })]
    const diff = context.diffOutcomeGrades(current, prior)
    assert.strictEqual(diff.length, 0, 'expected terminal grade "' + grade + '" to be skipped')
  }
})

test('diffOutcomeGrades: "clean" and "pending" are NOT terminal — a changed value still re-emits', function () {
  const context = harness.boot()
  for (const grade of ['clean', 'pending']) {
    const prior = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: grade, decided_at: 'x' })]
    const current = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'reverted', decided_at: 'y' })]
    const diff = context.diffOutcomeGrades(current, prior)
    assert.strictEqual(diff.length, 1, 'expected non-terminal grade "' + grade + '" to still allow re-emission')
  }
})

test('diffOutcomeGrades: last-line-wins across a prior ledger with duplicate keys (append-only history)', function () {
  const context = harness.boot()
  // outcomes.jsonl is append-only: the SAME key can appear twice (pending, then
  // later clean). The diff must compare against the LAST line, not the first.
  const prior = [
    context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'pending', decided_at: 'x' }),
    context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'clean', decided_at: 'y' }),
  ]
  const current = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'clean', decided_at: 'z' })]
  const diffUnchanged = context.diffOutcomeGrades(current, prior)
  assert.strictEqual(diffUnchanged.length, 0, 'the last prior line is clean, matching current — must not re-emit')

  const currentReverted = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'reverted', decided_at: 'z' })]
  const diffChanged = context.diffOutcomeGrades(currentReverted, prior)
  assert.strictEqual(diffChanged.length, 1, 'clean -> reverted is a real change off the LAST prior line and must emit')
})

test('diffOutcomeGrades: last-line-wins within currentLines itself when a caller hands in duplicate keys', function () {
  const context = harness.boot()
  const current = [
    context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'pending', decided_at: 'x' }),
    context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'clean', decided_at: 'y' }),
  ]
  const diff = context.diffOutcomeGrades(current, [])
  assert.strictEqual(diff.length, 1)
  assert.strictEqual(plain(diff)[0].grade, 'clean')
})

// ---- summarizeOutcomeCoverage ----

test('summarizeOutcomeCoverage: tallies graded/negative/pending counts and passes sample_cap_hit through', function () {
  const context = harness.boot()
  const observations = [{ a: 1 }, null, { b: 2 }, { c: 3 }] // one failed probe (null)
  const lines = [
    context.buildOutcomeLine({ run_tag: 'r', batch_pr: 1, issue: 1, grade: 'clean', decided_at: 'x' }),
    context.buildOutcomeLine({ run_tag: 'r', batch_pr: 1, issue: 2, grade: 'reverted', decided_at: 'x' }),
    context.buildOutcomeLine({ run_tag: 'r', batch_pr: 1, issue: 3, grade: 'pending', decided_at: 'x' }),
  ]
  const coverage = context.summarizeOutcomeCoverage(observations, lines, true)
  assert.strictEqual(coverage.graded_count, 3, 'the null observation must not count toward graded_count')
  assert.strictEqual(coverage.negative_count, 1)
  assert.strictEqual(coverage.pending_count, 1)
  assert.strictEqual(coverage.sample_cap_hit, true)
})

test('summarizeOutcomeCoverage: closed_unmerged/abandoned are terminal but NOT counted as negative (anti-Goodhart)', function () {
  const context = harness.boot()
  const lines = [
    context.buildOutcomeLine({ run_tag: 'r', batch_pr: 1, issue: 1, grade: 'closed_unmerged', decided_at: 'x' }),
    context.buildOutcomeLine({ run_tag: 'r', batch_pr: 1, issue: 2, grade: 'abandoned', decided_at: 'x' }),
  ]
  const coverage = context.summarizeOutcomeCoverage([{ a: 1 }, { b: 2 }], lines, false)
  assert.strictEqual(coverage.negative_count, 0)
  assert.strictEqual(coverage.pending_count, 0)
  assert.strictEqual(coverage.graded_count, 2)
  assert.strictEqual(coverage.sample_cap_hit, false)
})

test('summarizeOutcomeCoverage: empty observations/lines degrade to all-zero, never throws', function () {
  const context = harness.boot()
  const coverage = context.summarizeOutcomeCoverage([], [], false)
  assert.deepStrictEqual(plain(coverage), { graded_count: 0, negative_count: 0, pending_count: 0, sample_cap_hit: false })
})

test('summarizeOutcomeCoverage: null/undefined observations and lines degrade to all-zero, never throws', function () {
  const context = harness.boot()
  const coverage = context.summarizeOutcomeCoverage(null, undefined, undefined)
  assert.deepStrictEqual(plain(coverage), { graded_count: 0, negative_count: 0, pending_count: 0, sample_cap_hit: false })
})

// ---- module default config ----

test('OUTCOME_GRADING module default is min_age_days:7, sample_cap:20 (mirrors CLAUDE.md acceptance notes)', function () {
  const context = harness.boot()
  const og = harness.readGlobal(context, 'OUTCOME_GRADING')
  assert.strictEqual(og.min_age_days, 7)
  assert.strictEqual(og.sample_cap, 20)
})

// ---- deriveNegativeOutcomeEvents (issue #93 quality-fix, iteration 1) ----
//
// The re-derivation this fix added to close the PIN violation: given
// outcomes.jsonl's RAW, unparsed lines (REVISIT_RISK_SCHEMA.prior_ledger_lines,
// exactly as the probe returns them — never agent-interpreted), re-run
// last-line-wins keying (outcomeLineKey) and the OUTCOME_NEGATIVE_GRADES filter
// in JS, the same way diffOutcomeGrades already does. These tests guard the
// exact failure modes the code review flagged: a broken last-line-wins parse
// or a broken negative-grade filter would otherwise pass silently.

function rawLedgerLine(context, over) {
  return JSON.stringify(context.buildOutcomeLine(Object.assign({ run_tag: 'r1', batch_pr: 1, issue: 5, decided_at: 'x' }, over)))
}

test('deriveNegativeOutcomeEvents: a line whose grade is in OUTCOME_NEGATIVE_GRADES is emitted', function () {
  const context = harness.boot()
  const lines = [rawLedgerLine(context, { grade: 'hotfix' })]
  const out = context.deriveNegativeOutcomeEvents(lines)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].issue, 5)
  assert.strictEqual(out[0].batch_pr, 1)
  assert.strictEqual(out[0].grade, 'hotfix')
})

test('deriveNegativeOutcomeEvents: a line whose grade is NOT in OUTCOME_NEGATIVE_GRADES (clean/pending) is dropped', function () {
  const context = harness.boot()
  const lines = [rawLedgerLine(context, { grade: 'clean' }), rawLedgerLine(context, { issue: 6, grade: 'pending' })]
  const out = context.deriveNegativeOutcomeEvents(lines)
  assert.deepStrictEqual(plain(out), [])
})

test('deriveNegativeOutcomeEvents: last-line-wins across a duplicate key — a superseding clean line drops an earlier hotfix', function () {
  const context = harness.boot()
  const lines = [
    rawLedgerLine(context, { grade: 'hotfix', decided_at: 'x' }),
    rawLedgerLine(context, { grade: 'clean', decided_at: 'y' }),
  ]
  const out = context.deriveNegativeOutcomeEvents(lines)
  assert.deepStrictEqual(plain(out), [], 'the LAST line for this key is clean, so the earlier hotfix must not survive')
})

test('deriveNegativeOutcomeEvents: last-line-wins the other direction — a superseding hotfix line surfaces even though an earlier line was clean', function () {
  const context = harness.boot()
  const lines = [
    rawLedgerLine(context, { grade: 'clean', decided_at: 'x' }),
    rawLedgerLine(context, { grade: 'hotfix', decided_at: 'y' }),
  ]
  const out = context.deriveNegativeOutcomeEvents(lines)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].grade, 'hotfix')
})

test('deriveNegativeOutcomeEvents: pulls merged_at out of signals, defaults decided_at/batch_pr/merged_at to null when absent', function () {
  const context = harness.boot()
  const line = JSON.stringify({ run_tag: 'r1', issue: 7, grade: 'reverted', signals: { merged_at: '2026-01-01T00:00:00Z' } })
  const out = context.deriveNegativeOutcomeEvents([line])
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].batch_pr, null)
  assert.strictEqual(out[0].decided_at, null)
  assert.strictEqual(out[0].merged_at, '2026-01-01T00:00:00Z')
})

test('deriveNegativeOutcomeEvents: a malformed (non-JSON) line is skipped, not thrown', function () {
  const context = harness.boot()
  const lines = ['{not valid json', rawLedgerLine(context, { grade: 'reverted' })]
  const out = context.deriveNegativeOutcomeEvents(lines)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].grade, 'reverted')
})

test('deriveNegativeOutcomeEvents: non-array/null/undefined input degrades to [], never throws', function () {
  const context = harness.boot()
  assert.deepStrictEqual(plain(context.deriveNegativeOutcomeEvents(null)), [])
  assert.deepStrictEqual(plain(context.deriveNegativeOutcomeEvents(undefined)), [])
  assert.deepStrictEqual(plain(context.deriveNegativeOutcomeEvents('not-an-array')), [])
})

// ---- attachRevisitFiles (issue #93 quality-fix, iteration 1) ----
//
// Merges ONLY the agent's live-gh `files` resolution onto
// deriveNegativeOutcomeEvents' JS-derived, authoritative negative-event set,
// keyed by {issue, batch_pr} — grade/decided_at/merged_at are never taken from
// the agent side. A negative key the agent never resolved files for must fail
// open to files:[], not fabricate or drop the event.

test('attachRevisitFiles: merges files onto a matching {issue, batch_pr} key', function () {
  const context = harness.boot()
  const negativeEvents = [{ issue: 5, batch_pr: 1, grade: 'hotfix' }]
  const agentEvents = [{ issue: 5, batch_pr: 1, files: ['src/foo.js'] }]
  const out = context.attachRevisitFiles(negativeEvents, agentEvents)
  assert.deepStrictEqual(plain(out)[0].files, ['src/foo.js'])
  assert.strictEqual(out[0].grade, 'hotfix', 'grade must stay whatever deriveNegativeOutcomeEvents decided, untouched by the merge')
})

test('attachRevisitFiles: a negative event with no matching agent resolution fails open to files:[]', function () {
  const context = harness.boot()
  const negativeEvents = [{ issue: 5, batch_pr: 1, grade: 'reverted' }]
  const out = context.attachRevisitFiles(negativeEvents, [{ issue: 999, batch_pr: 1, files: ['unrelated.js'] }])
  assert.deepStrictEqual(plain(out)[0].files, [])
})

test('attachRevisitFiles: an agent event whose files is not an array degrades that key to [] rather than throwing', function () {
  const context = harness.boot()
  const negativeEvents = [{ issue: 5, batch_pr: 1, grade: 'reopened' }]
  const out = context.attachRevisitFiles(negativeEvents, [{ issue: 5, batch_pr: 1, files: null }])
  assert.deepStrictEqual(plain(out)[0].files, [])
})

test('attachRevisitFiles: batch_pr:null on both sides still matches (does not require batch_pr to be present)', function () {
  const context = harness.boot()
  const negativeEvents = [{ issue: 8, batch_pr: null, grade: 'hotfix' }]
  const agentEvents = [{ issue: 8, batch_pr: null, files: ['src/no-batch.js'] }]
  const out = context.attachRevisitFiles(negativeEvents, agentEvents)
  assert.deepStrictEqual(plain(out)[0].files, ['src/no-batch.js'])
})

test('attachRevisitFiles: null/undefined negativeEvents or agentEvents degrade gracefully, never throw', function () {
  const context = harness.boot()
  assert.deepStrictEqual(plain(context.attachRevisitFiles(null, null)), [])
  assert.deepStrictEqual(plain(context.attachRevisitFiles(undefined, undefined)), [])
  const out = context.attachRevisitFiles([{ issue: 5, batch_pr: 1, grade: 'hotfix' }], null)
  assert.deepStrictEqual(plain(out)[0].files, [])
})

// ---- computeRevisitRisk (issue #93): the deterministic revisit-risk flag core ----
//
// computeRevisitRisk(preflights, observations, cfg) takes each preflight's
// predicted_files (PREFLIGHT_SCHEMA) and an { events, refix_chains, now } raw
// observation bundle (already JS-derived/authoritative per deriveNegativeOutcomeEvents
// + attachRevisitFiles — see the module comment above computeRevisitRisk in
// workflows/ticketmill.js), and attaches a revisit_risk = { flagged, reasons } field
// to every preflight. These tests cover the settled plan's four acceptance cases:
// (a) a predicted_file intersecting an in-window hotfix/revert locus flags with
// reasons, (b) no history / no overlap is a clean no-op (acceptance criterion 2),
// (c) an out-of-window negative event never flags, and (d) refix_chains alone
// (no events[] overlap) never flags — annotation-only corroboration.

test('computeRevisitRisk: a predicted_file intersecting an in-window hotfix locus flags true with a reason', function () {
  const context = harness.boot()
  const preflights = [{ issue: 99, predicted_files: ['src/foo.js', 'src/bar.js'] }]
  const events = [{
    issue: 50, batch_pr: 10, grade: 'hotfix',
    decided_at: daysAgoIso(5), merged_at: daysAgoIso(20),
    files: ['src/foo.js'],
  }]
  const out = plain(context.computeRevisitRisk(preflights, { events: events, refix_chains: [], now: NOW }))
  assert.strictEqual(out[0].revisit_risk.flagged, true)
  assert.strictEqual(out[0].revisit_risk.reasons.length, 1)
  assert.match(out[0].revisit_risk.reasons[0], /src\/foo\.js/)
  assert.match(out[0].revisit_risk.reasons[0], /hotfix/)
  assert.match(out[0].revisit_risk.reasons[0], /issue #50/)
})

test('computeRevisitRisk: a predicted_file intersecting an in-window revert locus flags true with a reason', function () {
  const context = harness.boot()
  const preflights = [{ issue: 98, predicted_files: ['src/reverted.js'] }]
  const events = [{
    issue: 51, batch_pr: 11, grade: 'reverted',
    decided_at: daysAgoIso(2), merged_at: daysAgoIso(2),
    files: ['src/reverted.js'],
  }]
  const out = plain(context.computeRevisitRisk(preflights, { events: events, refix_chains: [], now: NOW }))
  assert.strictEqual(out[0].revisit_risk.flagged, true)
  assert.strictEqual(out[0].revisit_risk.reasons.length, 1)
  assert.match(out[0].revisit_risk.reasons[0], /src\/reverted\.js/)
  assert.match(out[0].revisit_risk.reasons[0], /reverted/)
})

test('computeRevisitRisk: no history at all is a clean no-op (acceptance criterion 2) — flagged:false, reasons:[]', function () {
  const context = harness.boot()
  const preflights = [{ issue: 1, predicted_files: ['src/anything.js'] }]
  const out = plain(context.computeRevisitRisk(preflights, { events: [], refix_chains: [], now: NOW }))
  assert.strictEqual(out[0].revisit_risk.flagged, false)
  assert.deepStrictEqual(out[0].revisit_risk.reasons, [])
})

test('computeRevisitRisk: history exists but does not overlap predicted_files is a clean no-op', function () {
  const context = harness.boot()
  const preflights = [{ issue: 2, predicted_files: ['src/unrelated.js'] }]
  const events = [{
    issue: 60, batch_pr: 20, grade: 'hotfix',
    decided_at: daysAgoIso(1), merged_at: daysAgoIso(1),
    files: ['src/other-area.js'],
  }]
  const out = plain(context.computeRevisitRisk(preflights, { events: events, refix_chains: [], now: NOW }))
  assert.strictEqual(out[0].revisit_risk.flagged, false)
  assert.deepStrictEqual(out[0].revisit_risk.reasons, [])
})

test('computeRevisitRisk: an out-of-window negative event never flags, even with a matching file', function () {
  const context = harness.boot()
  const preflights = [{ issue: 3, predicted_files: ['src/stale.js'] }]
  const events = [{
    issue: 61, batch_pr: 21, grade: 'reverted',
    decided_at: daysAgoIso(45), merged_at: daysAgoIso(45),
    files: ['src/stale.js'],
  }]
  const out = plain(context.computeRevisitRisk(preflights, { events: events, refix_chains: [], now: NOW }, { window_days: 30 }))
  assert.strictEqual(out[0].revisit_risk.flagged, false)
  assert.deepStrictEqual(out[0].revisit_risk.reasons, [])
})

test('computeRevisitRisk: refix_chains alone (no events[] overlap) never flags — annotation-only, not an independent driver', function () {
  const context = harness.boot()
  const preflights = [{ issue: 4, predicted_files: ['src/churned.js'] }]
  const refixChains = [{ file: 'src/churned.js', issue: 40, count: 3 }]
  const out = plain(context.computeRevisitRisk(preflights, { events: [], refix_chains: refixChains, now: NOW }))
  assert.strictEqual(out[0].revisit_risk.flagged, false)
  assert.deepStrictEqual(out[0].revisit_risk.reasons, [])
})

test('computeRevisitRisk: refix_chains corroborates (appends a reason) only for a file already flagged by a real events[] overlap', function () {
  const context = harness.boot()
  const preflights = [{ issue: 5, predicted_files: ['src/hot.js'] }]
  const events = [{
    issue: 70, batch_pr: 30, grade: 'hotfix',
    decided_at: daysAgoIso(3), merged_at: daysAgoIso(3),
    files: ['src/hot.js'],
  }]
  const refixChains = [{ file: 'src/hot.js', issue: 70, count: 3 }]
  const out = plain(context.computeRevisitRisk(preflights, { events: events, refix_chains: refixChains, now: NOW }))
  assert.strictEqual(out[0].revisit_risk.flagged, true)
  assert.strictEqual(out[0].revisit_risk.reasons.length, 2)
  assert.match(out[0].revisit_risk.reasons[1], /re-fixed/)
})

// ---- computeLaterBatchFix (issue #104) ----
//
// The sole place the later_batch_fix grade decision is made: fires iff
// observation.batch_pr_merge_sha is present in the UNION of every
// churned_regions[].blamed_shas entry — proof (via the later fix PR's own
// blame-forward resolution) that the later fix repaired a line THIS batch PR's
// squash-merge commit wrote, not bare changed_files overlap (the v1 mechanism
// plan review rejected as guaranteed-coincidental in this repo). Fails open to
// false on anything malformed or missing.

test('computeLaterBatchFix: batch_pr_merge_sha present in a region\'s blamed_shas fires true', function () {
  const context = harness.boot()
  const obs = {
    batch_pr_merge_sha: 'abc123',
    churned_regions: [{ file: 'workflows/ticketmill.js', blamed_shas: ['deadbeef', 'abc123'] }],
  }
  assert.strictEqual(context.computeLaterBatchFix(obs), true)
})

test('computeLaterBatchFix: batch_pr_merge_sha matching in the SECOND region (union across all regions) fires true', function () {
  const context = harness.boot()
  const obs = {
    batch_pr_merge_sha: 'abc123',
    churned_regions: [
      { file: 'a.js', blamed_shas: ['deadbeef'] },
      { file: 'b.js', blamed_shas: ['abc123'] },
    ],
  }
  assert.strictEqual(context.computeLaterBatchFix(obs), true)
})

test('computeLaterBatchFix: no matching SHA across any region fails open to false', function () {
  const context = harness.boot()
  const obs = {
    batch_pr_merge_sha: 'abc123',
    churned_regions: [{ file: 'a.js', blamed_shas: ['deadbeef', 'cafef00d'] }],
  }
  assert.strictEqual(context.computeLaterBatchFix(obs), false)
})

test('computeLaterBatchFix: missing batch_pr_merge_sha fails open to false, even with a matching-looking region', function () {
  const context = harness.boot()
  const obs = { churned_regions: [{ file: 'a.js', blamed_shas: ['abc123'] }] }
  assert.strictEqual(context.computeLaterBatchFix(obs), false)
})

test('computeLaterBatchFix: empty-string batch_pr_merge_sha fails open to false (never matches an empty blamed_shas hole)', function () {
  const context = harness.boot()
  const obs = { batch_pr_merge_sha: '', churned_regions: [{ file: 'a.js', blamed_shas: [''] }] }
  assert.strictEqual(context.computeLaterBatchFix(obs), false)
})

test('computeLaterBatchFix: missing/non-array churned_regions fails open to false', function () {
  const context = harness.boot()
  assert.strictEqual(context.computeLaterBatchFix({ batch_pr_merge_sha: 'abc123' }), false)
  assert.strictEqual(context.computeLaterBatchFix({ batch_pr_merge_sha: 'abc123', churned_regions: 'nope' }), false)
})

test('computeLaterBatchFix: a region missing/non-array blamed_shas is skipped, not thrown', function () {
  const context = harness.boot()
  const obs = {
    batch_pr_merge_sha: 'abc123',
    churned_regions: [{ file: 'a.js' }, { file: 'b.js', blamed_shas: null }, { file: 'c.js', blamed_shas: ['abc123'] }],
  }
  assert.strictEqual(context.computeLaterBatchFix(obs), true)
})

test('computeLaterBatchFix: a null entry inside churned_regions is skipped, not thrown', function () {
  const context = harness.boot()
  const obs = { batch_pr_merge_sha: 'abc123', churned_regions: [null, { file: 'a.js', blamed_shas: ['abc123'] }] }
  assert.strictEqual(context.computeLaterBatchFix(obs), true)
})

test('computeLaterBatchFix: null/undefined observation degrades to false, never throws', function () {
  const context = harness.boot()
  assert.strictEqual(context.computeLaterBatchFix(null), false)
  assert.strictEqual(context.computeLaterBatchFix(undefined), false)
})

// ---- isPlannedFollowup (issue #104) ----
//
// The planning-edge exclusion: a later PR/issue whose OWN body declares itself
// a pre-planned continuation of prior work must never be graded
// later_batch_fix. Validated (task 1) against real repo history: must drop
// #103's actual body ("Follow-up from #92") but NOT drop reactive-repair
// language like "regression introduced by".

test('isPlannedFollowup: the real #103 body ("Follow-up from #92...") is excluded as planned', function () {
  const context = harness.boot()
  const body = 'Follow-up from #92: reconcile the CHANGELOG entry that batch PR #106 left stale.'
  assert.strictEqual(context.isPlannedFollowup(body), true)
})

test('isPlannedFollowup: reactive-repair language ("regression introduced by...") is NOT excluded', function () {
  const context = harness.boot()
  const body = 'Fixes a regression introduced by #106 in the outcome-grading precedence order.'
  assert.strictEqual(context.isPlannedFollowup(body), false)
})

test('isPlannedFollowup: is case-insensitive ("FOLLOW-UP FROM #92")', function () {
  const context = harness.boot()
  assert.strictEqual(context.isPlannedFollowup('FOLLOW-UP FROM #92'), true)
})

test('isPlannedFollowup: also matches "depends on" and "deferred from"', function () {
  const context = harness.boot()
  assert.strictEqual(context.isPlannedFollowup('This depends on #92 landing first.'), true)
  assert.strictEqual(context.isPlannedFollowup('Deferred from the original #92 scope.'), true)
})

test('isPlannedFollowup: plain unrelated prose is not planned', function () {
  const context = harness.boot()
  assert.strictEqual(context.isPlannedFollowup('This PR fixes a null-pointer crash on startup.'), false)
})

test('isPlannedFollowup: non-string/missing body degrades to false, never throws', function () {
  const context = harness.boot()
  assert.strictEqual(context.isPlannedFollowup(null), false)
  assert.strictEqual(context.isPlannedFollowup(undefined), false)
  assert.strictEqual(context.isPlannedFollowup(42), false)
})

// ---- gradeFromObservation: later_batch_fix precedence (issue #104) ----
//
// later_batch_fix sits AFTER hotfix (a same-issue cross-referenced fix is the
// stronger, more direct claim) and BEFORE closed_unmerged/abandoned (a real
// later fix landing is strictly more informative than either terminal
// escape).

function laterFixObservation(over) {
  return baseObservation(Object.assign({
    hotfix_pr: null,
    batch_pr_merge_sha: 'abc123',
    churned_regions: [{ file: 'workflows/ticketmill.js', blamed_shas: ['abc123'] }],
    later_fix_body: 'Fixes a regression introduced by the earlier batch.',
  }, over))
}

test('gradeFromObservation: a blame-forward SHA match with no planning language grades later_batch_fix', function () {
  const context = harness.boot()
  const g = context.gradeFromObservation(laterFixObservation(), NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'later_batch_fix')
})

test('gradeFromObservation: hotfix still outranks later_batch_fix when both conditions are true', function () {
  const context = harness.boot()
  const g = context.gradeFromObservation(laterFixObservation({ hotfix_pr: 777 }), NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'hotfix')
})

test('gradeFromObservation: reverted/reopened still outrank later_batch_fix', function () {
  const context = harness.boot()
  const gReverted = context.gradeFromObservation(laterFixObservation({ reverted: true }), NOW, { min_age_days: 7 })
  assert.strictEqual(gReverted.grade, 'reverted')
  const gReopened = context.gradeFromObservation(laterFixObservation({ reopened: true }), NOW, { min_age_days: 7 })
  assert.strictEqual(gReopened.grade, 'reopened')
})

test('gradeFromObservation: later_batch_fix outranks closed_unmerged', function () {
  const context = harness.boot()
  const g = context.gradeFromObservation(laterFixObservation({ pr_state: 'closed', merged_at: null }), NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'later_batch_fix')
})

test('gradeFromObservation: later_batch_fix outranks abandoned', function () {
  const context = harness.boot()
  const g = context.gradeFromObservation(laterFixObservation({ pr_state: 'open', merged_at: null, abandoned: true }), NOW, { min_age_days: 7 })
  assert.strictEqual(g.grade, 'later_batch_fix')
})

test('gradeFromObservation: a planned-followup body (isPlannedFollowup) suppresses later_batch_fix, falling through to the next branch (clean)', function () {
  const context = harness.boot()
  const g = context.gradeFromObservation(laterFixObservation({ later_fix_body: 'Follow-up from #92: see that issue for context.' }), NOW, { min_age_days: 7 })
  assert.notStrictEqual(g.grade, 'later_batch_fix')
  assert.strictEqual(g.grade, 'clean')
})

test('gradeFromObservation: no blamed-SHA match (computeLaterBatchFix false) never grades later_batch_fix', function () {
  const context = harness.boot()
  const g = context.gradeFromObservation(laterFixObservation({ batch_pr_merge_sha: 'zzz999' }), NOW, { min_age_days: 7 })
  assert.notStrictEqual(g.grade, 'later_batch_fix')
})

// ---- dual grade-set membership (issue #104 lockstep fix) ----
//
// later_batch_fix must be a member of BOTH OUTCOME_TERMINAL_GRADES (it never
// legitimately re-grades once observed) AND OUTCOME_NEGATIVE_GRADES (it is a
// genuine anti-Goodhart quality-negative signal, unlike closed_unmerged/
// abandoned which are terminal escapes, not evidence of a bad outcome).

test('later_batch_fix is a member of both OUTCOME_TERMINAL_GRADES and OUTCOME_NEGATIVE_GRADES', function () {
  const context = harness.boot()
  const terminal = harness.readGlobal(context, 'OUTCOME_TERMINAL_GRADES')
  const negative = harness.readGlobal(context, 'OUTCOME_NEGATIVE_GRADES')
  assert.notStrictEqual(terminal.indexOf('later_batch_fix'), -1)
  assert.notStrictEqual(negative.indexOf('later_batch_fix'), -1)
})

test('diffOutcomeGrades: later_batch_fix is skip-terminal — a settled later_batch_fix in the prior ledger is never re-emitted', function () {
  const context = harness.boot()
  const prior = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'later_batch_fix', decided_at: 'x' })]
  const current = [context.buildOutcomeLine({ run_tag: 'r1', batch_pr: 1, issue: 5, grade: 'clean', decided_at: 'y' })]
  const diff = context.diffOutcomeGrades(current, prior)
  assert.strictEqual(diff.length, 0)
})

test('deriveNegativeOutcomeEvents: a later_batch_fix ledger line is emitted (it is a member of OUTCOME_NEGATIVE_GRADES)', function () {
  const context = harness.boot()
  const lines = [rawLedgerLine(context, { grade: 'later_batch_fix' })]
  const out = context.deriveNegativeOutcomeEvents(lines)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].grade, 'later_batch_fix')
})
