'use strict'

// Integration tests for the durable per-issue gate-state READ path (issue
// #166, task 3): fetchGateStateBlocks() (the whole-set, jq-pinned, chunked
// probe) and attachGateStateBlocks()'s real-data join (extended in this task
// to accept the probe's raw rowsByIssue + self_login, beyond task 1's
// defaulting-only single-arg shape).
//
// tests/gate-state.test.js already proves the pure layer this is built on
// (parseGateStateProbeRow, selectGateState, isTrustedGateStateAuthor, ...) in
// isolation; these tests instead drive fetchGateStateBlocks() through the
// real control flow (loaded via tests/harness.js, same pattern as
// tests/gate-state-post.test.js), proving:
//   - attachGateStateBlocks is total (every preflight gets all four fields)
//     and non-mutating.
//   - attachGateStateBlocks clobbers a hallucinated agent-supplied
//     gate_state_blocks — both when real join data exists for that issue
//     (real data wins) and when it does not (safe defaults win) — these four
//     fields are NEVER read back off the preflight's own pre-existing value.
//   - a dead probe (every chunk's agent call dies) marks every issue
//     read-failed (via synthesized exit_ok:false stub rows, never a silent
//     drop).
//   - one dead chunk of three leaves the other two chunks' issues intact.
//   - truncated/non-JSON jq stdout (agent succeeded, jq output is garbage)
//     yields read-failed, never a fake "absent".
//   - partial coverage (an issue outside the queried issueNumbers set
//     entirely) leaves that issue at attachGateStateBlocks' safe defaults.
//   - a probe returning nothing (empty issueNumbers) leaves preflights'
//     OTHER fields byte-identical.
//   - the self_login reduction across chunks picks the FIRST non-empty
//     login, in chunk order, ignoring later ones.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

const REPO = 'aaddrick/ticketmill-fixture'
const TARGET = 'Batch_2026-07-27_fixture'

function seed(context, overrides) {
  context.__seed(Object.assign({ PROFILE: {}, REPO: REPO, TARGET: TARGET }, overrides))
}

function jqRow(total, blocks) {
  return JSON.stringify({ total: total, blocks: blocks || [] })
}

// ---- attachGateStateBlocks: total, non-mutating, clobbers hallucinated fields ----

test('attachGateStateBlocks: total and non-mutating over a real rowsByIssue join', function () {
  const context = harness.boot()
  const preflights = [
    { issue: 1, pr_number: null },
    { issue: 2, pr_number: null },
  ]
  const rowsByIssue = {
    1: { raw: jqRow(3, [{ body: 'not a gate-state comment', author_login: 'someone', author_association: 'NONE' }]), exit_ok: true },
  }
  const attached = harness.normalize(context.attachGateStateBlocks(preflights, rowsByIssue, 'ticketmill-bot'))

  assert.strictEqual(attached.length, 2)
  // issue 1: covered, valid read, zero matching blocks (comment didn't title-match, but
  // parseGateStateProbeRow doesn't re-filter -- the jq already did; this fixture's single
  // "block" entry is just illustrative of the shape, total/blocks pass through as given)
  assert.strictEqual(attached[0].gate_state_read_ok, true)
  assert.strictEqual(attached[0].gate_state_total_comments, 3)
  assert.strictEqual(attached[0].gate_state_trust, 'ticketmill-bot')
  // issue 2: not in rowsByIssue at all -- fail-open defaults
  assert.deepStrictEqual(attached[1], {
    issue: 2, pr_number: null,
    gate_state_blocks: [], gate_state_read_ok: false, gate_state_total_comments: 0, gate_state_trust: 'ticketmill-bot',
  })
  // non-mutating: original preflight objects never gained the new keys
  assert.strictEqual(Object.prototype.hasOwnProperty.call(preflights[0], 'gate_state_blocks'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(preflights[1], 'gate_state_blocks'), false)
})

test('attachGateStateBlocks: clobbers a hallucinated agent-supplied gate_state_blocks with real join data', function () {
  const context = harness.boot()
  const preflights = [
    { issue: 1, gate_state_blocks: ['a hallucinated block the agent invented'], gate_state_read_ok: true, gate_state_total_comments: 99, gate_state_trust: 'not-a-real-login' },
  ]
  const rowsByIssue = { 1: { raw: jqRow(1, [{ body: 'real body', author_login: 'ticketmill-bot', author_association: 'OWNER' }]), exit_ok: true } }
  const attached = harness.normalize(context.attachGateStateBlocks(preflights, rowsByIssue, 'ticketmill-bot'))

  assert.deepStrictEqual(attached[0].gate_state_blocks, ['real body'])
  assert.strictEqual(attached[0].gate_state_total_comments, 1)
  assert.strictEqual(attached[0].gate_state_trust, 'ticketmill-bot')
})

test('attachGateStateBlocks: clobbers a hallucinated agent-supplied gate_state_blocks even with NO join data (never falls back to the preflight\'s own value)', function () {
  const context = harness.boot()
  const preflights = [
    { issue: 1, gate_state_blocks: ['a hallucinated block'], gate_state_read_ok: true, gate_state_total_comments: 7, gate_state_trust: 'someone-else' },
  ]
  const attached = harness.normalize(context.attachGateStateBlocks(preflights, {}, ''))

  assert.deepStrictEqual(attached[0].gate_state_blocks, [])
  assert.strictEqual(attached[0].gate_state_read_ok, false)
  assert.strictEqual(attached[0].gate_state_total_comments, 0)
  assert.strictEqual(attached[0].gate_state_trust, '')
})

test('attachGateStateBlocks: partial coverage -- an issue outside rowsByIssue entirely gets the safe defaults', function () {
  const context = harness.boot()
  const preflights = [{ issue: 1 }, { issue: 2 }, { issue: 3 }]
  const rowsByIssue = {
    1: { raw: jqRow(0, []), exit_ok: true },
    2: { raw: jqRow(0, []), exit_ok: true },
    // issue 3 never queried at all (e.g. fetchGateStateBlocks was called with issueNumbers=[1,2])
  }
  const attached = harness.normalize(context.attachGateStateBlocks(preflights, rowsByIssue, 'bot'))
  assert.strictEqual(attached[0].gate_state_read_ok, true)
  assert.strictEqual(attached[1].gate_state_read_ok, true)
  assert.deepStrictEqual(attached[2], { issue: 3, gate_state_blocks: [], gate_state_read_ok: false, gate_state_total_comments: 0, gate_state_trust: 'bot' })
})

test('attachGateStateBlocks: truncated jq stdout yields gate_state_read_ok:false (read-failed), never a fake successful-empty read', function () {
  const context = harness.boot()
  const preflights = [{ issue: 1 }]
  const rowsByIssue = { 1: { raw: '{"total": 4, "blocks": [{"body": "trun', exit_ok: true } } // truncated mid-stream
  const attached = harness.normalize(context.attachGateStateBlocks(preflights, rowsByIssue, ''))
  assert.strictEqual(attached[0].gate_state_read_ok, false)
  assert.strictEqual(attached[0].gate_state_total_comments, 0)
  assert.deepStrictEqual(attached[0].gate_state_blocks, [])
})

test('attachGateStateBlocks: a probe returning nothing (no rowsByIssue, no self_login) leaves every OTHER preflight field byte-identical', function () {
  const context = harness.boot()
  const preflights = [{ issue: 1, title: 'fixture', pr_number: 5, resume_point: 'process_pr' }]
  const attached = harness.normalize(context.attachGateStateBlocks(preflights))
  assert.strictEqual(attached[0].issue, 1)
  assert.strictEqual(attached[0].title, 'fixture')
  assert.strictEqual(attached[0].pr_number, 5)
  assert.strictEqual(attached[0].resume_point, 'process_pr')
  assert.strictEqual(attached[0].gate_state_read_ok, false)
})

// ---- fetchGateStateBlocks: chunking, dead-chunk isolation, self_login reduction ----

test('fetchGateStateBlocks: a fully dead probe (every chunk agent call dies) marks every issue read-failed via explicit exit_ok:false stub rows', async function () {
  const context = harness.boot()
  seed(context)
  harness.installScriptedAgent(context, function () { return null }) // every chunk call dies

  const result = await context.fetchGateStateBlocks([1, 2, 3], {})
  const rows = harness.normalize(result.rowsByIssue)
  assert.strictEqual(result.self_login, '')
  for (const n of [1, 2, 3]) {
    assert.deepStrictEqual(rows[n], { raw: '', exit_ok: false }, 'issue #' + n + ' must be an explicit read-failed stub, not silently absent')
  }
})

test('fetchGateStateBlocks: one dead chunk of three leaves the other two chunks\' issues intact', async function () {
  const context = harness.boot()
  seed(context)
  // 11 issues -> chunks of [5, 5, 1] at MAX_GATE_STATE_PROBE_CHUNK=5 -- three chunks.
  const issues = []
  for (let i = 1; i <= 11; i++) issues.push(i)
  harness.installScriptedAgent(context, function (prompt, opts) {
    if (opts.label === 'gate-state-probe-c1') return null // the middle chunk (issues 6-10) dies
    const chunkIssues = opts.label === 'gate-state-probe-c0' ? issues.slice(0, 5) : issues.slice(10, 11)
    return { self_login: 'ticketmill-bot', rows: chunkIssues.map(function (n) { return { issue: n, raw: jqRow(0, []), exit_ok: true } }) }
  })

  const result = await context.fetchGateStateBlocks(issues, {})
  const rows = harness.normalize(result.rowsByIssue)
  for (const n of [1, 2, 3, 4, 5]) assert.strictEqual(rows[n].exit_ok, true, 'issue #' + n + ' (surviving chunk 0) must be intact')
  for (const n of [6, 7, 8, 9, 10]) assert.deepStrictEqual(rows[n], { raw: '', exit_ok: false }, 'issue #' + n + ' (dead chunk 1) must be read-failed')
  assert.strictEqual(rows[11].exit_ok, true, 'issue #11 (surviving chunk 2) must be intact')
})

test('fetchGateStateBlocks: truncated jq stdout (agent succeeded, jq output is garbage) logs read-failed, never absent', async function () {
  const context = harness.boot()
  seed(context)
  const logs = []
  context.log = function (msg) { logs.push(String(msg)) }
  harness.installScriptedAgent(context, function () {
    return { self_login: 'bot', rows: [{ issue: 42, raw: '{"total": 2, "blocks": [{"bo', exit_ok: true }] }
  })

  await context.fetchGateStateBlocks([42], {})
  const line = logs.find(function (l) { return l.indexOf('#42') !== -1 })
  assert.ok(line, 'expected a log line naming issue #42: ' + JSON.stringify(logs))
  assert.ok(line.indexOf('read-failed') !== -1, 'expected "read-failed", got: ' + line)
  assert.ok(line.indexOf('absent') === -1, 'must never log a truncated read as absent: ' + line)
})

test('fetchGateStateBlocks: a genuinely empty issue (valid read, zero blocks, zero total, no prior-work evidence) logs absent', async function () {
  const context = harness.boot()
  seed(context)
  const logs = []
  context.log = function (msg) { logs.push(String(msg)) }
  harness.installScriptedAgent(context, function () {
    return { self_login: 'bot', rows: [{ issue: 7, raw: jqRow(0, []), exit_ok: true }] }
  })

  await context.fetchGateStateBlocks([7], { 7: { pr_number: null, worktree_exists: false, resume_point: 'implement' } })
  const line = logs.find(function (l) { return l.indexOf('#7') !== -1 })
  assert.ok(line && line.indexOf('absent') !== -1 && line.indexOf('unexpected') === -1, 'expected a plain "absent" line: ' + JSON.stringify(logs))
})

test('fetchGateStateBlocks: zero blocks WITH prior-work evidence (an open PR) logs the distinct suspicious-absent line, not a bare read-failed', async function () {
  const context = harness.boot()
  seed(context)
  const logs = []
  context.log = function (msg) { logs.push(String(msg)) }
  harness.installScriptedAgent(context, function () {
    return { self_login: 'bot', rows: [{ issue: 9, raw: jqRow(3, []), exit_ok: true }] } // total>0, zero gate-state blocks
  })

  await context.fetchGateStateBlocks([9], { 9: { pr_number: 123, worktree_exists: false, resume_point: 'process_pr' } })
  const line = logs.find(function (l) { return l.indexOf('#9') !== -1 })
  assert.ok(line, 'expected a log line for issue #9: ' + JSON.stringify(logs))
  assert.ok(line.indexOf('unexpected') !== -1 && line.indexOf('PR #123') !== -1, 'expected the distinct greppable suspicious-case string: ' + line)
})

test('fetchGateStateBlocks: partial coverage -- an issue outside the queried issueNumbers set gets no row and no log line at all', async function () {
  const context = harness.boot()
  seed(context)
  const logs = []
  context.log = function (msg) { logs.push(String(msg)) }
  harness.installScriptedAgent(context, function () {
    return { self_login: 'bot', rows: [{ issue: 1, raw: jqRow(0, []), exit_ok: true }] }
  })

  const result = await context.fetchGateStateBlocks([1], {})
  assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.normalize(result.rowsByIssue), '2'), false)
  assert.strictEqual(logs.some(function (l) { return l.indexOf('#2') !== -1 }), false)
})

test('fetchGateStateBlocks: a probe called with no issues at all returns empty and makes no agent call', async function () {
  const context = harness.boot()
  seed(context)
  const agentStub = harness.installScriptedAgent(context, function () { return { self_login: 'bot', rows: [] } })

  const result = await context.fetchGateStateBlocks([], {})
  assert.deepStrictEqual(harness.normalize(result.rowsByIssue), {})
  assert.strictEqual(result.self_login, '')
  assert.strictEqual(agentStub.calls.length, 0)
})

test('fetchGateStateBlocks: self_login reduction picks the FIRST non-empty login across chunks, in chunk order', async function () {
  const context = harness.boot()
  seed(context)
  const issues = []
  for (let i = 1; i <= 11; i++) issues.push(i) // three chunks: c0 (1-5), c1 (6-10), c2 (11)
  harness.installScriptedAgent(context, function (prompt, opts) {
    const login = opts.label === 'gate-state-probe-c0' ? '' : opts.label === 'gate-state-probe-c1' ? 'first-real-login' : 'second-real-login'
    const n = opts.label === 'gate-state-probe-c0' ? issues.slice(0, 5) : opts.label === 'gate-state-probe-c1' ? issues.slice(5, 10) : issues.slice(10, 11)
    return { self_login: login, rows: n.map(function (x) { return { issue: x, raw: jqRow(0, []), exit_ok: true } }) }
  })

  const result = await context.fetchGateStateBlocks(issues, {})
  assert.strictEqual(result.self_login, 'first-real-login')
})
