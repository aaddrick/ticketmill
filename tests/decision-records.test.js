'use strict'

// Unit tests for the ctx-scoped record-keeping helpers: the decision chain
// (pushDecision/decisionChain), the settled-decisions ledger
// (settleDecision/settledBlock), handoff notes (collectNotes/notesBlock), and
// the report/retro timeline() renderer. All are pure given a ctx object
// shaped like harness.makeCtx().

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ---- decision chain ----

test('decisionChain: renders "(none yet)" with no decisions', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 1 })
  assert.strictEqual(context.decisionChain(ctx), '(none yet)')
})

test('decisionChain: renders pushed decisions in order, joined by blank lines', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 1 })

  context.pushDecision(ctx, 'Research', 'Found the root cause quickly.')
  context.pushDecision(ctx, 'Evaluate', 'Chose approach A over B.')

  const chain = context.decisionChain(ctx)
  assert.strictEqual(chain, ctx.decisions.map(function (r) { return r.entry }).join('\n\n'))
  assert.ok(chain.includes('### [#1] Research\nFound the root cause quickly.'))
  assert.ok(chain.includes('### [#1] Evaluate\nChose approach A over B.'))
})

test('decisionChain: drops records stamped for a different issue (cross-pipeline contamination guard)', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 1 })

  context.pushDecision(ctx, 'Research', 'Own finding.')
  // Simulate a foreign/unstamped record landing in the same array (as could
  // happen if ctx objects were ever mixed up across concurrent pipelines).
  ctx.decisions.push({ issue: 999, entry: '### [#999] Foreign\nShould be dropped' })

  const chain = context.decisionChain(ctx)
  assert.ok(chain.includes('Own finding.'))
  assert.ok(!chain.includes('Foreign'))
  assert.ok(!chain.includes('Should be dropped'))
})

test('decisionChain: bounds long chains to the first 4 plus the last 6 entries, with an elision marker', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 2 })

  for (let i = 0; i < 13; i++) context.pushDecision(ctx, 'D' + i, 'body ' + i)

  const entries = ctx.decisions.map(function (r) { return r.entry })
  const expected = entries.slice(0, 4)
    .concat(['…(3 earlier entries elided)…'])
    .concat(entries.slice(-6))
    .join('\n\n')

  assert.strictEqual(context.decisionChain(ctx), expected)
})

// ---- settled-decisions ledger ----

test('settledBlock: empty when nothing has been settled', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 3 })
  assert.strictEqual(context.settledBlock(ctx), '')
})

test('settledBlock: renders topic, decision, why, and rejected alternatives', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 3 })

  context.settleDecision(ctx, 'Approach', 'Contrarian-1', 'Use approach A', 'because simpler', ['approach B', 'approach C'])

  const block = context.settledBlock(ctx)
  assert.ok(block.startsWith('## Adjudicated decisions'))
  assert.ok(block.includes('- [Contrarian-1] Approach: Use approach A'))
  assert.ok(block.includes('Why: because simpler'))
  assert.ok(block.includes('Rejected alternatives: approach B; approach C'))
})

test('settledBlock: only renders the most recent 6 settled decisions', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 4 })

  for (let i = 0; i < 7; i++) context.settleDecision(ctx, 'Topic' + i, 'Gate', 'Decision' + i, '', [])

  const block = context.settledBlock(ctx)
  assert.ok(!block.includes('Topic0:'))
  assert.ok(block.includes('Topic1:'))
  assert.ok(block.includes('Topic6:'))
})

// ---- handoff notes ----

test('notesBlock: empty with no notes collected', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 5 })
  assert.strictEqual(context.notesBlock(ctx), '')
})

test('collectNotes/notesBlock: prefixes with the source stage, trims, and drops blanks', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 5 })

  context.collectNotes(ctx, 'task-1', { notes_for_downstream: ['first note', '   ', 'second note'] })

  assert.deepStrictEqual(ctx.notes, ['[task-1] first note', '[task-1] second note'])
  const block = context.notesBlock(ctx)
  assert.ok(block.startsWith('## Handoff notes from earlier agents in this run'))
  assert.ok(block.includes('- [task-1] first note'))
  assert.ok(block.includes('- [task-1] second note'))
})

test('collectNotes: a missing/null response is a no-op', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 5 })
  context.collectNotes(ctx, 'x', null)
  context.collectNotes(ctx, 'x', undefined)
  assert.deepStrictEqual(ctx.notes, [])
})

test('collectNotes: trims the accumulated notes list to the most recent 12', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 6 })

  for (let i = 0; i < 13; i++) context.collectNotes(ctx, 'agent', { notes_for_downstream: ['note ' + i] })

  assert.strictEqual(ctx.notes.length, 12)
  assert.strictEqual(ctx.notes[0], '[agent] note 1') // note 0 pushed out
  assert.strictEqual(ctx.notes[11], '[agent] note 12')
})

// ---- timeline ----

test('timeline: renders "title — body" when a second line exists, title-only otherwise', function () {
  const context = harness.boot()
  const ctx = harness.makeCtx({ issue: 8 })

  context.pushDecision(ctx, 'Research', 'Found **the** cause of the bug in the parser.')
  context.pushDecision(ctx, 'NoBodyTitle', '')

  assert.deepStrictEqual(context.timeline(ctx), [
    'Research — Found the cause of the bug in the parser.',
    'NoBodyTitle',
  ])
})
