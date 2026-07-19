'use strict'

// Unit tests for the consolidation gate (issue #14): the pure reducers
// (healGroups/reconcileGroups/deriveUnits) and the control flow that drives
// them (proposeConsolidation's opus gate + capped contrarian challenge,
// fail()/processIssue's group failure semantics). Covers task 7's acceptance
// bar:
//   - a no-overlap run yields zero groups so deriveUnits produces only
//     singletons (the byte-for-byte guarantee)
//   - a group proposal is accepted after a contrarian pass
//   - a group rejected at the contrarian cap dissolves back to independent issues
//   - a failed group produces exactly one breaker increment and releases
//     every member's claim (driven through processIssue/fail)
//   - healGroups re-proposes the same group from a marker on resume
//   - reconcileGroups handles re-anchor/dissolve

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

function bootConsolidation(overrides) {
  const context = harness.boot()
  context.__seed(Object.assign({ PROFILE: {} }, overrides))
  return context
}

// ---- no-overlap run: zero groups -> deriveUnits produces only singletons ----

test('proposeConsolidation + deriveUnits: a no-overlap run (opus gate returns groups: []) yields only singleton units, byte-for-byte like the un-grouped preflights', async function () {
  const context = bootConsolidation()
  const candidates = [
    { issue: 1, title: 'Fix A', resume_point: 'implement' },
    { issue: 2, title: 'Fix B', resume_point: 'implement' },
    { issue: 3, title: 'Fix C', resume_point: 'implement' },
  ]

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === 'consolidation:marker-probe') return { markers: [] }
    if (label === 'consolidation:propose') return { groups: [], ungrouped: [1, 2, 3] }
    throw new Error('unexpected consolidation call in a no-overlap run: ' + label)
  })

  const map = await context.proposeConsolidation(candidates)
  assert.strictEqual(map.size, 0)

  const reconciled = context.reconcileGroups(map, candidates)
  assert.strictEqual(reconciled.size, 0)

  const units = context.deriveUnits(reconciled, candidates)
  assert.strictEqual(units.length, 3)
  units.forEach(function (u, i) {
    assert.strictEqual(u.issue, candidates[i].issue)
    assert.strictEqual(u.groupId, null)
    assert.strictEqual(u.members.length, 1)
    assert.strictEqual(u.members[0], candidates[i]) // same live preflight ref, not a copy
  })
})

test('proposeConsolidation: a single candidate free-skips with no agent call at all', async function () {
  const context = bootConsolidation()
  harness.installScriptedAgent(context, function (prompt, opts) {
    throw new Error('agent must not be called when there is only one candidate: ' + ((opts && opts.label) || ''))
  })
  const map = await context.proposeConsolidation([{ issue: 1, title: 'Solo', resume_point: 'implement' }])
  assert.strictEqual(map.size, 0)
})

// ---- group proposal accepted after a contrarian pass ----

test('proposeConsolidation: a proposed group is accepted once the contrarian pass returns sound_with_caveats (after one needs_rework + revise round)', async function () {
  const context = bootConsolidation()
  const candidates = [
    { issue: 1, title: 'API surface A', resume_point: 'implement' },
    { issue: 2, title: 'API surface B', resume_point: 'implement' },
    { issue: 3, title: 'Unrelated', resume_point: 'implement' },
  ]

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === 'consolidation:marker-probe') return { markers: [] }
    if (label === 'consolidation:propose') {
      return { groups: [{ primary: 1, members: [1, 2], subsystem: 'shared api', shared_surface: 'same endpoint tests', rationale: 'initial rationale' }], ungrouped: [3] }
    }
    if (label === 'consolidation:challenge-g1-i1') {
      return { verdict: 'needs_rework', summary: 'unconvinced', findings: [{ severity: 'major', summary: 'need more evidence', recommendation: 'confirm the shared surface', assumption_challenged: '', failure_scenario: '', impact: '' }] }
    }
    if (label === 'consolidation:revise-g1-i1') {
      return { groups: [{ primary: 1, members: [1, 2], subsystem: 'shared api', shared_surface: 'same endpoint tests', rationale: 'confirmed: same integration tests cover both' }] }
    }
    if (label === 'consolidation:challenge-g1-i2') {
      return { verdict: 'sound_with_caveats', summary: 'confirmed', findings: [] }
    }
    throw new Error('unexpected consolidation call: ' + label)
  })

  const map = await context.proposeConsolidation(candidates)
  assert.strictEqual(map.size, 1)
  const entry = map.get(1)
  assert.strictEqual(entry.groupId, 1)
  assert.strictEqual(entry.primary, 1)
  assert.deepStrictEqual(entry.members.slice(), [1, 2])
  assert.strictEqual(entry.subsystem, 'shared api')
  assert.strictEqual(entry.rationale, 'confirmed: same integration tests cover both')

  // Exactly two challenge rounds happened (revise-then-accept), not looped further.
  const challengeCalls = context.agent.calls.filter(function (c) { return c.opts.label.indexOf('consolidation:challenge-g1-') === 0 })
  assert.strictEqual(challengeCalls.length, 2)
})

// ---- group rejected at the contrarian cap dissolves back to independent issues ----

test('proposeConsolidation: a group that never clears the contrarian bar DISSOLVES at MAX_CONTRARIAN_ITERATIONS, leaving members as independent issues', async function () {
  const context = bootConsolidation()
  const MAX_CONTRARIAN_ITERATIONS = harness.readGlobal(context, 'MAX_CONTRARIAN_ITERATIONS')
  const candidates = [
    { issue: 1, title: 'A', resume_point: 'implement' },
    { issue: 2, title: 'B', resume_point: 'implement' },
    { issue: 3, title: 'C', resume_point: 'implement' },
  ]

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === 'consolidation:marker-probe') return { markers: [] }
    if (label === 'consolidation:propose') {
      return { groups: [{ primary: 1, members: [1, 2], subsystem: 'sub', shared_surface: 'surf', rationale: 'r0' }], ungrouped: [3] }
    }
    if (/^consolidation:challenge-g1-i\d+$/.test(label)) {
      // Always unconvinced, every iteration -> never sound_with_caveats.
      return { verdict: 'needs_rework', summary: 'still unconvinced', findings: [{ severity: 'major', summary: 'still not a real shared surface', recommendation: 'split them', assumption_challenged: '', failure_scenario: '', impact: '' }] }
    }
    if (/^consolidation:revise-g1-i\d+$/.test(label)) {
      // The revision defends the same grouping unchanged, so it keeps failing.
      return { groups: [{ primary: 1, members: [1, 2], subsystem: 'sub', shared_surface: 'surf', rationale: 'r0' }] }
    }
    if (label === 'consolidation:dissolve-note-g1') return { posted: true }
    throw new Error('unexpected consolidation call: ' + label)
  })

  const map = await context.proposeConsolidation(candidates)
  assert.strictEqual(map.size, 0) // dissolved: no group entry survives

  const challengeCalls = context.agent.calls.filter(function (c) { return c.opts.label.indexOf('consolidation:challenge-g1-') === 0 })
  assert.strictEqual(challengeCalls.length, MAX_CONTRARIAN_ITERATIONS) // capped, not looped forever

  const dissolveNoteCalls = context.agent.calls.filter(function (c) { return c.opts.label === 'consolidation:dissolve-note-g1' })
  assert.strictEqual(dissolveNoteCalls.length, 1) // the dissolve is announced exactly once

  // Members fall through to ordinary independent-issue singletons downstream.
  // (reconcileGroups/deriveUnits are pure — they never mutate the preflights
  // they're given, so candidates can be reused directly, same as the
  // no-overlap test above.)
  const units = context.deriveUnits(context.reconcileGroups(map, candidates), candidates)
  assert.strictEqual(units.length, 3)
  units.forEach(function (u) { assert.strictEqual(u.groupId, null) })
})

// ---- a failed group: exactly one breaker increment, every member's claim released ----

test('processIssue -> fail(): a failed group unit increments BATCH.failures exactly once and instructs releasing every member claim', async function () {
  const context = bootConsolidation({ REPO: 'aaddrick/ticketmill-fixture' })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === '1:setup') return { status: 'error', error: 'setup script failed' }
    if (label === '1:halt-note-setup') return { posted: true }
    throw new Error('unexpected stage label for a group failing at setup: ' + label)
  })

  const pre = {
    issue: 1, title: 'Group primary', branch: '', pr_number: null, resume_point: 'implement',
    members: [{ issue: 1 }, { issue: 2 }], groupId: 1,
  }
  const result = await context.processIssue(pre)

  assert.strictEqual(result.status, 'failed')
  assert.strictEqual(result.stage, 'setup')
  assert.deepStrictEqual(result.members.slice(), [1, 2])

  // Exactly one breaker increment for the whole group, not one per member.
  const batchFailures = harness.readGlobal(context, 'BATCH.failures')
  assert.strictEqual(batchFailures, 1)
  const stopTripped = harness.readGlobal(context, 'STOP.tripped')
  assert.strictEqual(stopTripped, false) // one failure alone must not trip the circuit breaker

  // The halt note fans the claim-release instruction out to every member issue.
  const haltNoteCall = context.agent.calls.find(function (c) { return c.opts.label === '1:halt-note-setup' })
  assert.ok(haltNoteCall, 'expected a halt-note-setup stage call')
  assert.ok(haltNoteCall.prompt.includes('gh issue edit 1 --repo aaddrick/ticketmill-fixture --remove-label ticketmill'))
  assert.ok(haltNoteCall.prompt.includes('gh issue edit 2 --repo aaddrick/ticketmill-fixture --remove-label ticketmill'))
  assert.ok(haltNoteCall.prompt.includes('part of consolidation group 1'))

  // Only one stage() call happened per stage — setup never retried (it returned
  // a live, if erroring, response) — and only one halt-note posted for the unit.
  assert.strictEqual(context.agent.calls.length, 2)
})

// ---- healGroups re-proposes the same group from a marker on resume ----

test('healGroups: reconstructs a prior group from its primary-side marker comment alone', function () {
  const context = bootConsolidation()
  const candidates = [{ issue: 5 }, { issue: 6 }]
  const body = context.buildConsolidationGroupComment('aaddrick/ticketmill-fixture', 5, 5, [5, 6], 'shared subsystem', 'shared rationale')

  const healed = context.healGroups(candidates, [{ issue: 5, body: body }])

  assert.strictEqual(healed.size, 1)
  const g = healed.get(5)
  assert.strictEqual(g.groupId, 5)
  assert.strictEqual(g.primary, 5)
  // g.members was built by parseConsolidationGroupComment() INSIDE the vm context
  // (via string.split/map on the comment body) -- it's a vm-realm array even
  // though it only holds numbers, so Array.from() (constructed by THIS realm's
  // Array) is required before deepStrictEqual; a bare .slice() would still
  // construct via the vm-realm's species and fail the prototype check.
  assert.deepStrictEqual(Array.from(g.members), [5, 6])
  assert.strictEqual(g.subsystem, 'shared subsystem')
  assert.strictEqual(g.rationale, 'shared rationale')
})

test('healGroups: falls back to reconstructing from member-side markers alone when the primary marker was never fetched', function () {
  const context = bootConsolidation()
  const candidates = [{ issue: 7 }, { issue: 8 }]
  const memberBody = context.buildConsolidatedMemberComment('aaddrick/ticketmill-fixture', 8, 7, 7, 'r')

  const healed = context.healGroups(candidates, [{ issue: 8, body: memberBody }])

  assert.strictEqual(healed.size, 1)
  const g = healed.get(7)
  assert.strictEqual(g.primary, 7)
  assert.deepStrictEqual(Array.from(g.members).sort(), [7, 8])
})

test('proposeConsolidation: on resume, a fully-healed group short-circuits the opus gate and contrarian challenge entirely', async function () {
  const context = bootConsolidation()
  const candidates = [{ issue: 10, title: 'Primary' }, { issue: 11, title: 'Absorbed' }]
  const groupBody = context.buildConsolidationGroupComment('aaddrick/ticketmill-fixture', 10, 10, [10, 11], 'sub', 'rationale')

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === 'consolidation:marker-probe') return { markers: [{ issue: 10, body: groupBody }] }
    throw new Error('resumed group must not re-run the opus gate or contrarian challenge: ' + label)
  })

  const map = await context.proposeConsolidation(candidates)

  assert.strictEqual(map.size, 1)
  const g = map.get(10)
  assert.strictEqual(g.primary, 10)
  assert.deepStrictEqual(Array.from(g.members), [10, 11])
  assert.strictEqual(context.agent.calls.length, 1) // only the marker probe ran
})

test('proposeConsolidation: PROFILE.consolidation === false still heals a group a prior run already committed to', async function () {
  const context = bootConsolidation({ PROFILE: { consolidation: false } })
  const candidates = [{ issue: 20, title: 'Primary' }, { issue: 21, title: 'Absorbed' }]
  const groupBody = context.buildConsolidationGroupComment('aaddrick/ticketmill-fixture', 20, 20, [20, 21], 'sub', 'rationale')

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === 'consolidation:marker-probe') return { markers: [{ issue: 20, body: groupBody }] }
    throw new Error('disabling the gate must not skip healing an already-committed group: ' + label)
  })

  const map = await context.proposeConsolidation(candidates)
  assert.strictEqual(map.size, 1)
  assert.strictEqual(map.get(20).primary, 20)
})

// ---- reconcileGroups: re-anchor / dissolve ----

test('reconcileGroups: a member skip-flipped since proposal is excluded, the rest of the group stays intact', function () {
  const context = bootConsolidation()
  const map = new Map()
  map.set(1, { groupId: 1, primary: 1, members: [1, 2, 3], subsystem: 's', rationale: 'r' })
  const live = [
    { issue: 1, resume_point: 'implement' },
    { issue: 2, resume_point: 'implement' },
    { issue: 3, resume_point: 'skip' }, // flipped since proposal
  ]

  const reconciled = context.reconcileGroups(map, live)

  assert.strictEqual(reconciled.size, 1)
  const g = reconciled.get(1)
  assert.strictEqual(g.groupId, 1)
  assert.strictEqual(g.primary, 1) // primary untouched, still live
  assert.deepStrictEqual(g.members.slice(), [1, 2]) // #3 excluded
  assert.strictEqual(g.subsystem, 's')
  assert.strictEqual(g.rationale, 'r')
})

test('reconcileGroups: a lost primary re-anchors onto the lowest-numbered live member, under the SAME stable groupId', function () {
  const context = bootConsolidation()
  const map = new Map()
  map.set(1, { groupId: 1, primary: 1, members: [1, 2, 3], subsystem: 's', rationale: 'r' })
  const live = [
    { issue: 1, resume_point: 'skip' }, // the proposed primary is gone
    { issue: 2, resume_point: 'implement' },
    { issue: 3, resume_point: 'implement' },
  ]

  const reconciled = context.reconcileGroups(map, live)

  assert.strictEqual(reconciled.size, 1)
  const g = reconciled.get(1)
  assert.strictEqual(g.groupId, 1) // the stable id NEVER moves...
  assert.strictEqual(g.primary, 2) // ...even though the logical primary re-anchors
  assert.deepStrictEqual(g.members.slice(), [2, 3])
})

// ---- worktreeAnchor: stable groupId anchor vs. mutable primary ----

test('worktreeAnchor: for a group unit, anchors on the stable groupId even when it differs from the (re-anchored) primary issue', function () {
  const context = bootConsolidation()
  // A re-anchor scenario: the group's stable id is 5 (its original lowest member),
  // but ctx.issue (the current logical primary) has moved on to 7 — worktreeAnchor
  // must still return the stable id, never ctx.issue, or a resumed run would spawn
  // a second, orphaned worktree (see the function's own comment).
  const ctx = harness.makeCtx({ issue: 7, groupId: 5, members: [{ issue: 5 }, { issue: 7 }] })
  assert.strictEqual(context.worktreeAnchor(ctx), 5)
  assert.notStrictEqual(context.worktreeAnchor(ctx), ctx.issue)
})

test('worktreeAnchor: a singleton (groupId null) anchors on ctx.issue itself', function () {
  const context = bootConsolidation()
  const ctx = harness.makeCtx({ issue: 9, groupId: null })
  assert.strictEqual(context.worktreeAnchor(ctx), 9)
})

// ---- proposeConsolidation DEDUPE: overlapping proposed groups ----

test('proposeConsolidation: DEDUPE drops a later proposed group that overlaps an already-claimed member, first-seen wins', async function () {
  const context = bootConsolidation()
  const candidates = [
    { issue: 1, title: 'A', resume_point: 'implement' },
    { issue: 2, title: 'B (claimed by both proposed groups)', resume_point: 'implement' },
    { issue: 3, title: 'C', resume_point: 'implement' },
    { issue: 4, title: 'D', resume_point: 'implement' },
  ]

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === 'consolidation:marker-probe') return { markers: [] }
    if (label === 'consolidation:propose') {
      return {
        groups: [
          { primary: 1, members: [1, 2], subsystem: 's1', shared_surface: 'surf1', rationale: 'r1' },
          // Shares issue #2 with the first group above -> must be dropped whole,
          // not trimmed (trimming could orphan its primary or shrink it further).
          { primary: 2, members: [2, 3], subsystem: 's2', shared_surface: 'surf2', rationale: 'r2' },
        ],
        ungrouped: [4],
      }
    }
    if (label === 'consolidation:challenge-g1-i1') {
      return { verdict: 'sound_with_caveats', summary: 'confirmed', findings: [] }
    }
    if (/^consolidation:(challenge|revise)-g2-/.test(label)) {
      throw new Error('the overlapping second group must never reach the contrarian challenge: ' + label)
    }
    throw new Error('unexpected consolidation call: ' + label)
  })

  const map = await context.proposeConsolidation(candidates)

  // Only the first-claimed group (#1, members [1,2]) survives.
  assert.strictEqual(map.size, 1)
  const entry = map.get(1)
  assert.deepStrictEqual(entry.members.slice(), [1, 2])

  // The dropped group's non-overlapping member (#3) falls through as an ordinary
  // singleton once reconciled/derived, same as #4 (which was never grouped at all).
  const reconciled = context.reconcileGroups(map, candidates)
  const units = context.deriveUnits(reconciled, candidates)
  assert.strictEqual(units.length, 3) // group-unit {1,2} + singleton 3 + singleton 4
  const singleton3 = units.find(function (u) { return u.issue === 3 })
  assert.ok(singleton3)
  assert.strictEqual(singleton3.groupId, null)
  const singleton4 = units.find(function (u) { return u.issue === 4 })
  assert.ok(singleton4)
  assert.strictEqual(singleton4.groupId, null)

  // No challenge call ever fired for the dropped group.
  const g2Calls = context.agent.calls.filter(function (c) { return c.opts.label.indexOf('-g2-') !== -1 })
  assert.strictEqual(g2Calls.length, 0)
})

// ---- postConsolidationMarkers: posts the group marker on the primary and the ----
// ---- member marker on every other live member; skips singleton units ----

test('postConsolidationMarkers: posts one group marker on the primary and one member marker per other member; skips singletons', async function () {
  const context = bootConsolidation({ REPO: 'aaddrick/ticketmill-fixture' })

  harness.installScriptedAgent(context, function (prompt, opts) {
    const label = (opts && opts.label) || ''
    if (label === 'consolidation:mark-primary-g1') return { posted: true }
    if (label === 'consolidation:mark-member-2') return { posted: true }
    if (label === 'consolidation:mark-member-3') return { posted: true }
    throw new Error('unexpected consolidation-marker call for a run with one group + one singleton: ' + label)
  })

  const units = [
    {
      issue: 1, groupId: 1, subsystem: 'shared subsystem', rationale: 'shared rationale',
      members: [{ issue: 1 }, { issue: 2 }, { issue: 3 }],
    },
    { issue: 9, groupId: null, members: [{ issue: 9 }] }, // singleton — must be skipped entirely
  ]

  await context.postConsolidationMarkers(units)

  assert.strictEqual(context.agent.calls.length, 3) // 1 primary marker + 2 member markers; nothing for the singleton
  const labels = context.agent.calls.map(function (c) { return c.opts.label })
  assert.deepStrictEqual(labels.sort(), ['consolidation:mark-member-2', 'consolidation:mark-member-3', 'consolidation:mark-primary-g1'])

  const primaryCall = context.agent.calls.find(function (c) { return c.opts.label === 'consolidation:mark-primary-g1' })
  assert.ok(primaryCall.prompt.includes('Post the consolidation GROUP marker comment on issue #1'))
  assert.ok(primaryCall.prompt.includes(context.buildConsolidationGroupComment('aaddrick/ticketmill-fixture', 1, 1, [1, 2, 3], 'shared subsystem', 'shared rationale')))
  // idempotency check present verbatim
  assert.ok(primaryCall.prompt.includes('SKIP posting if any comment\'s first line is exactly "## Consolidation Group" and it contains'))

  const member2Call = context.agent.calls.find(function (c) { return c.opts.label === 'consolidation:mark-member-2' })
  assert.ok(member2Call.prompt.includes('Post the consolidation MEMBER marker comment on issue #2'))
  assert.ok(member2Call.prompt.includes(context.buildConsolidatedMemberComment('aaddrick/ticketmill-fixture', 2, 1, 1, 'shared rationale')))
  assert.ok(member2Call.prompt.includes('SKIP posting if any comment\'s first line is exactly "## Consolidated"'))

  const member3Call = context.agent.calls.find(function (c) { return c.opts.label === 'consolidation:mark-member-3' })
  assert.ok(member3Call.prompt.includes('Post the consolidation MEMBER marker comment on issue #3'))
})

test('postConsolidationMarkers: never posts a member marker for the primary itself, and no-ops entirely when every unit is a singleton', async function () {
  const context = bootConsolidation()
  harness.installScriptedAgent(context, function (prompt, opts) {
    throw new Error('no marker calls expected for an all-singleton run: ' + ((opts && opts.label) || ''))
  })

  await context.postConsolidationMarkers([
    { issue: 1, groupId: null, members: [{ issue: 1 }] },
    { issue: 2, groupId: null, members: [{ issue: 2 }] },
  ])

  assert.strictEqual(context.agent.calls.length, 0)
})

test('reconcileGroups: fewer than 2 live members dissolves the group entirely', function () {
  const context = bootConsolidation()
  const map = new Map()
  map.set(1, { groupId: 1, primary: 1, members: [1, 2, 3], subsystem: 's', rationale: 'r' })
  const live = [
    { issue: 1, resume_point: 'skip' },
    { issue: 2, resume_point: 'process_pr' },
    { issue: 3, resume_point: 'implement' }, // only one survivor
  ]

  const reconciled = context.reconcileGroups(map, live)

  assert.strictEqual(reconciled.size, 0)
  assert.strictEqual(reconciled.has(1), false)
})
