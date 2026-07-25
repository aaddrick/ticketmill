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
