'use strict'

// Integration tests for the durable per-issue gate-state Report-phase
// self-validation sweep (issue #166, task 4): verifyGateState(results).
//
// tests/gate-state.test.js already proves the pure layer this is built on
// (parseGateStateProbeRow, parseGateStateComment, diffGateStateIntent,
// buildGateStatePayload/buildGateStateComment) in isolation; these tests
// instead drive verifyGateState() through the real control flow (loaded via
// tests/harness.js, same pattern as tests/gate-state-read.test.js), proving:
//   - all six outcomes are logged correctly: no-intent, post-failed,
//     read-failed, match, superseded, mismatch.
//   - a fully dead verify stage (every chunk's agent call dies) logs every
//     issue-with-an-intent as read-failed, never silently skipped.
//   - one dead chunk of two leaves the other chunk's issue intact.
//   - the prompt handed to the agent NEVER carries the payload being
//     verified against — only issue numbers and the pinned jq command — so
//     a scripted agent has no way to "cheat" the comparison.
//   - the sweep never makes an agent call at all when nothing has an intent
//     (every result is no-intent/post-failed).

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

const REPO = 'aaddrick/ticketmill-fixture'
const TARGET = 'Batch_2026-07-27_fixture'

function seed(context, overrides) {
  context.__seed(Object.assign({ PROFILE: {}, REPO: REPO, TARGET: TARGET }, overrides))
}

function jqRaw(blocks) {
  return JSON.stringify({ total: blocks.length, blocks: blocks })
}

function block(body) {
  return { body: body, author_login: 'ticketmill-bot', author_association: 'OWNER' }
}

function makeResult(context, issue, overrides) {
  return Object.assign({ issue: issue, title: 'fixture', gate_state_intent: null, gate_state_post_failed: null }, overrides)
}

function intentFor(context, issue, run, epoch, boundary) {
  return context.buildGateStatePayload({ repo: REPO, issue: issue, run: run || 'run-1', batch: TARGET, epoch: (epoch === undefined ? 1000 : epoch), boundary: boundary || 'plan' })
}

function bodyFor(context, issue, payload) {
  return context.buildGateStateComment(REPO, issue, payload)
}

function logsOf(context) {
  const logs = []
  context.log = function (msg) { logs.push(String(msg)) }
  return logs
}

function outcomeLine(logs, issue) {
  return logs.find(function (l) { return l.indexOf('#' + issue + ':') !== -1 })
}

// ---- no-intent / post-failed: no probe call needed ----

test('verifyGateState: a result with neither gate_state_intent nor gate_state_post_failed logs no-intent and makes no agent call', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  const agentStub = harness.installScriptedAgent(context, function () { return null })

  const results = [makeResult(context, 1)]
  await context.verifyGateState(results)

  assert.strictEqual(agentStub.calls.length, 0, 'no-intent/post-failed-only results must never trigger a probe call')
  assert.ok(outcomeLine(logs, 1).indexOf('no-intent') !== -1, outcomeLine(logs, 1))
})

test('verifyGateState: gate_state_post_failed set (no intent) logs post-failed, distinct from no-intent', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  harness.installScriptedAgent(context, function () { return null })

  const results = [makeResult(context, 2, { gate_state_post_failed: 'approach' })]
  await context.verifyGateState(results)

  assert.ok(outcomeLine(logs, 2).indexOf('post-failed') !== -1, outcomeLine(logs, 2))
})

// ---- match / superseded / mismatch: probe returns real data ----

test('verifyGateState: newest block round-trips byte-identical to the intent -- logs match', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  const payload = intentFor(context, 3)
  harness.installScriptedAgent(context, function () {
    return { rows: [{ issue: 3, raw: jqRaw([block(bodyFor(context, 3, payload))]), exit_ok: true }] }
  })

  const results = [makeResult(context, 3, { gate_state_intent: payload })]
  await context.verifyGateState(results)

  assert.ok(outcomeLine(logs, 3).indexOf('match') !== -1 && outcomeLine(logs, 3).indexOf('mismatch') === -1, outcomeLine(logs, 3))
})

test('verifyGateState: newest block is a LATER write from the SAME run -- logs superseded, not mismatch', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  const intent = intentFor(context, 4, 'run-1', 1000, 'pr-review-i1')
  const later = intentFor(context, 4, 'run-1', 2000, 'pr-review-i2')
  harness.installScriptedAgent(context, function () {
    return { rows: [{ issue: 4, raw: jqRaw([block(bodyFor(context, 4, intent)), block(bodyFor(context, 4, later))]), exit_ok: true }] }
  })

  const results = [makeResult(context, 4, { gate_state_intent: intent })]
  await context.verifyGateState(results)

  assert.ok(outcomeLine(logs, 4).indexOf('superseded') !== -1, outcomeLine(logs, 4))
})

test('verifyGateState: newest block is a DIFFERENT run\'s write -- logs mismatch, real corruption never hidden as superseded', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  const intent = intentFor(context, 5, 'run-1', 1000)
  const otherRun = intentFor(context, 5, 'concurrent-run', 2000)
  harness.installScriptedAgent(context, function () {
    return { rows: [{ issue: 5, raw: jqRaw([block(bodyFor(context, 5, otherRun))]), exit_ok: true }] }
  })

  const results = [makeResult(context, 5, { gate_state_intent: intent })]
  await context.verifyGateState(results)

  assert.ok(outcomeLine(logs, 5).indexOf('mismatch') !== -1, outcomeLine(logs, 5))
})

test('verifyGateState: an intent recorded but zero gate-state blocks read back -- logs mismatch (a lost write), never silently absent', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  const intent = intentFor(context, 6)
  harness.installScriptedAgent(context, function () {
    return { rows: [{ issue: 6, raw: jqRaw([]), exit_ok: true }] }
  })

  const results = [makeResult(context, 6, { gate_state_intent: intent })]
  await context.verifyGateState(results)

  assert.ok(outcomeLine(logs, 6).indexOf('mismatch') !== -1, outcomeLine(logs, 6))
})

// ---- read-failed: probe/parse itself is unusable ----

test('verifyGateState: exit_ok:false on the probe row logs read-failed', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  const intent = intentFor(context, 7)
  harness.installScriptedAgent(context, function () {
    return { rows: [{ issue: 7, raw: '', exit_ok: false }] }
  })

  const results = [makeResult(context, 7, { gate_state_intent: intent })]
  await context.verifyGateState(results)

  assert.ok(outcomeLine(logs, 7).indexOf('read-failed') !== -1, outcomeLine(logs, 7))
})

test('verifyGateState: truncated/non-JSON jq stdout (agent succeeded, jq output is garbage) logs read-failed, never a fake match/mismatch', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  const intent = intentFor(context, 8)
  harness.installScriptedAgent(context, function () {
    return { rows: [{ issue: 8, raw: '{"total": 1, "blocks": [{"bo', exit_ok: true }] }
  })

  const results = [makeResult(context, 8, { gate_state_intent: intent })]
  await context.verifyGateState(results)

  assert.ok(outcomeLine(logs, 8).indexOf('read-failed') !== -1, outcomeLine(logs, 8))
})

test('verifyGateState: a fully dead verify stage (every chunk agent call dies) logs read-failed for every issue with an intent, none silently dropped', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  harness.installScriptedAgent(context, function () { return null })

  const results = [1, 2, 3].map(function (n) { return makeResult(context, n, { gate_state_intent: intentFor(context, n) }) })
  await context.verifyGateState(results)

  for (const n of [1, 2, 3]) {
    const line = outcomeLine(logs, n)
    assert.ok(line, 'expected a log line for issue #' + n)
    assert.ok(line.indexOf('read-failed') !== -1, line)
  }
})

test('verifyGateState: one dead chunk of two leaves the other chunk\'s issue intact', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  // MAX_GATE_STATE_PROBE_CHUNK is 5 -- 6 issues-with-intent -> two chunks: c0 (1-5), c1 (6).
  const issues = [1, 2, 3, 4, 5, 6]
  const intents = {}
  for (const n of issues) intents[n] = intentFor(context, n)

  harness.installScriptedAgent(context, function (prompt, opts) {
    if (opts.label === 'gate-state-verify-c0') return null // first chunk dies
    return { rows: [6].map(function (n) { return { issue: n, raw: jqRaw([block(bodyFor(context, n, intents[n]))]), exit_ok: true } }) }
  })

  const results = issues.map(function (n) { return makeResult(context, n, { gate_state_intent: intents[n] }) })
  await context.verifyGateState(results)

  for (const n of [1, 2, 3, 4, 5]) assert.ok(outcomeLine(logs, n).indexOf('read-failed') !== -1, 'dead chunk 0 issue #' + n + ': ' + outcomeLine(logs, n))
  assert.ok(outcomeLine(logs, 6).indexOf('match') !== -1, 'surviving chunk 1 issue #6: ' + outcomeLine(logs, 6))
})

// ---- the prompt never carries the payload being verified against ----

test('verifyGateState: the agent prompt carries only issue numbers and the pinned jq command -- never the intent payload', async function () {
  const context = harness.boot()
  seed(context)
  const intent = intentFor(context, 9, 'run-1', 1000, 'plan')
  const agentStub = harness.installScriptedAgent(context, function () {
    return { rows: [{ issue: 9, raw: jqRaw([block(bodyFor(context, 9, intent))]), exit_ok: true }] }
  })

  const results = [makeResult(context, 9, { gate_state_intent: intent })]
  await context.verifyGateState(results)

  assert.strictEqual(agentStub.calls.length, 1)
  const prompt = agentStub.calls[0].prompt
  // the intent's JSON-serialized settled/gate_budgets payload must never appear verbatim
  // in the prompt text -- only its issue number and the fixed jq idiom may.
  assert.ok(prompt.indexOf(JSON.stringify(intent)) === -1, 'prompt must never embed the intent payload')
  assert.ok(prompt.indexOf('"schema"') === -1, 'prompt must never embed payload JSON keys')
  assert.ok(prompt.indexOf('gh issue view <n> --repo ' + REPO) !== -1, 'prompt must carry the pinned jq idiom')
  assert.ok(prompt.indexOf('Issues in this call: 9') !== -1, 'prompt must carry the issue number')
})

test('verifyGateState: nothing to verify (every result no-intent/post-failed) makes zero agent calls', async function () {
  const context = harness.boot()
  seed(context)
  const agentStub = harness.installScriptedAgent(context, function () { return { rows: [] } })

  const results = [
    makeResult(context, 1),
    makeResult(context, 2, { gate_state_post_failed: 'plan' }),
    null, // runPool can leave holes-shaped defensively -- must never throw
  ]
  await context.verifyGateState(results)

  assert.strictEqual(agentStub.calls.length, 0)
})

// ---- a dead sweep call site never disturbs unrelated Report-phase work ----
// (verifyGateState itself is exercised above; the Report-phase call site wraps
// it in try/catch -- see workflows/ticketmill.js's phase('Report') section --
// so a throw inside this function cannot be reached from outside it without
// reconstructing the whole Report phase. What matters at this layer is that
// verifyGateState() itself never throws even when handed maximally hostile
// input, which the `null` entry in the previous test, and the malformed rows
// below, already cover.)

test('verifyGateState: a chunk response with a non-array `rows` field is treated the same as a dead chunk (read-failed), never throws', async function () {
  const context = harness.boot()
  seed(context)
  const logs = logsOf(context)
  const intent = intentFor(context, 10)
  harness.installScriptedAgent(context, function () { return { rows: 'not-an-array' } })

  const results = [makeResult(context, 10, { gate_state_intent: intent })]
  await context.verifyGateState(results)

  assert.ok(outcomeLine(logs, 10).indexOf('read-failed') !== -1, outcomeLine(logs, 10))
})
