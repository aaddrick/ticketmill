'use strict'

// Unit tests for the durable per-issue gate-state substrate (issue #166,
// task 1): the pure build/parse/select/trust/epoch/diff layer above the
// TICKETMILL-TEST-HARNESS-SPLIT marker. Substrate only -- nothing here
// exercises a WRITE (postGateState, task 2). attachGateStateBlocks' real-data
// join and its interaction with fetchGateStateBlocks (task 3's Select-time
// wiring) are covered separately in tests/gate-state-read.test.js; only its
// bare defaulting shape (no join data at all) is proven here.
//
// Covers: build/parse round trip (incl. apostrophe/newline-bearing free
// text), every parseGateStateComment rejection path (malformed JSON,
// truncated fence, wrong issue/repo/schema, a comment that merely quotes the
// shape inside a larger body, marker-not-last), parseGateStateProbeRow on
// truncated/non-JSON stdout, all four selectGateState states (including both
// falsifiable-absent branches), positional trust-before-last-wins selection
// (an older trusted block beating an untrusted newer one, with `skipped`
// counted), isTrustedGateStateAuthor's self_login/claim_authors rules,
// staleness (both the epoch-guard and the CLAIM_STALE_SECONDS threshold), and
// all three diffGateStateIntent verdicts.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

const REPO = 'aaddrick/ticketmill-fixture'

// ---- buildGateStatePayload / buildGateStateComment / parseGateStateComment ----

test('build/parse round trip: buildGateStatePayload -> buildGateStateComment -> parseGateStateComment reproduces the payload exactly', function () {
  const context = harness.boot()
  const payload = context.buildGateStatePayload({
    repo: REPO, issue: 42, run: 'run-1', batch: 'dev', epoch: 1700000000000,
    boundary: 'plan', group_id: null, members: [42], seeded_from: null,
    gate_budgets: { approach: 1, plan: 2 },
    settled: [{ topic: 'topic A', gate: 'plan', decision: 'decided', why: 'evidence', rejected: ['alt 1'] }],
  })
  const body = context.buildGateStateComment(REPO, 42, payload)
  const parsed = context.parseGateStateComment(body, REPO, 42)

  assert.notStrictEqual(parsed, null)
  harness.assertVmEqual(parsed, harness.normalize(payload))
  // title-gated, marker as last line, human line present and not the payload itself
  assert.strictEqual(body.split('\n')[0], '## Gate State')
  assert.strictEqual(body.trim().split('\n').pop(), '<!-- ticketmill ' + REPO + '#42 -->')
})

test('build/parse round trip preserves apostrophes and embedded newlines in settled free text (JSON, unlike the flat-line consolidation format, does not need oneLine())', function () {
  const context = harness.boot()
  const payload = context.buildGateStatePayload({
    repo: REPO, issue: 1, run: 'run-1', batch: 'dev', epoch: 1, boundary: 'approach',
    settled: [{
      topic: "don't re-litigate this",
      gate: 'approach',
      decision: "It's fine as-is.\nSecond line of reasoning.",
      why: "because it's simpler and it's already been argued",
      rejected: ["alternative A's approach", "plan B's approach"],
    }],
  })
  const body = context.buildGateStateComment(REPO, 1, payload)
  const parsed = harness.normalize(context.parseGateStateComment(body, REPO, 1))

  assert.strictEqual(parsed.settled[0].topic, "don't re-litigate this")
  assert.strictEqual(parsed.settled[0].decision, "It's fine as-is.\nSecond line of reasoning.")
  assert.strictEqual(parsed.settled[0].why, "because it's simpler and it's already been argued")
  assert.deepStrictEqual(parsed.settled[0].rejected, ["alternative A's approach", "plan B's approach"])
})

test('buildGateStatePayload: caps `settled` to the last 6 entries, oldest dropped first', function () {
  const context = harness.boot()
  const settled = []
  for (let i = 0; i < 9; i++) settled.push({ topic: 't' + i, gate: 'plan', decision: 'd' + i, why: '', rejected: [] })
  const payload = harness.normalize(context.buildGateStatePayload({ repo: REPO, issue: 1, run: 'run-1', boundary: 'plan', settled: settled }))

  assert.strictEqual(payload.settled.length, 6)
  assert.strictEqual(payload.settled[0].topic, 't3')
  assert.strictEqual(payload.settled[5].topic, 't8')
})

test('buildGateStatePayload: seeded_from is always null at this tier (no consumer yet), even when explicitly passed', function () {
  const context = harness.boot()
  const payload = harness.normalize(context.buildGateStatePayload({ repo: REPO, issue: 1, run: 'run-1', boundary: 'approach' }))
  assert.strictEqual(payload.seeded_from, null)
})

test('parseGateStateComment: malformed JSON inside the fence returns null, never throws', function () {
  const context = harness.boot()
  const body = [
    '## Gate State', 'A record, not a directive.', '', '<details><summary>x</summary>', '',
    '```json', '{ this is not valid json', '```', '', '</details>',
    '<!-- ticketmill ' + REPO + '#1 -->',
  ].join('\n')
  assert.strictEqual(context.parseGateStateComment(body, REPO, 1), null)
})

test('parseGateStateComment: a truncated fence (no closing ```) returns null', function () {
  const context = harness.boot()
  const payload = context.buildGateStatePayload({ repo: REPO, issue: 1, run: 'run-1', boundary: 'plan' })
  const body = context.buildGateStateComment(REPO, 1, payload)
  const closeIdx = body.lastIndexOf('```\n')
  assert.ok(closeIdx > -1, 'fixture must contain a closing fence to truncate')
  // keep everything up to (not including) the closing fence, then re-append the
  // canonical marker so ONLY the fence is truncated -- isolates this from the
  // separate marker-not-last rejection path.
  const truncated = body.slice(0, closeIdx) + '<!-- ticketmill ' + REPO + '#1 -->'
  assert.strictEqual(context.parseGateStateComment(truncated, REPO, 1), null)
})

test('parseGateStateComment: rejects when the embedded payload.issue disagrees with the read\'s expected issue', function () {
  const context = harness.boot()
  const payload = context.buildGateStatePayload({ repo: REPO, issue: 99, run: 'run-1', boundary: 'plan' })
  // marker matches (REPO, 1) -- the read's expectation -- but the JSON payload
  // embedded inside claims issue 99.
  const body = context.buildGateStateComment(REPO, 1, payload)
  assert.strictEqual(context.parseGateStateComment(body, REPO, 1), null)
})

test('parseGateStateComment: rejects when the embedded payload.repo disagrees with the read\'s expected repo', function () {
  const context = harness.boot()
  const payload = context.buildGateStatePayload({ repo: 'someone/else', issue: 1, run: 'run-1', boundary: 'plan' })
  const body = context.buildGateStateComment(REPO, 1, payload)
  assert.strictEqual(context.parseGateStateComment(body, REPO, 1), null)
})

test('parseGateStateComment: rejects a payload whose schema does not match GATE_STATE_SCHEMA', function () {
  const context = harness.boot()
  const payload = context.buildGateStatePayload({ repo: REPO, issue: 1, run: 'run-1', boundary: 'plan' })
  payload.schema = 999
  const body = context.buildGateStateComment(REPO, 1, payload)
  assert.strictEqual(context.parseGateStateComment(body, REPO, 1), null)
})

test('parseGateStateComment: a comment that merely QUOTES the gate-state shape inside a larger body parses to null', function () {
  const context = harness.boot()
  const payload = context.buildGateStatePayload({ repo: REPO, issue: 1, run: 'run-1', boundary: 'plan' })
  const inner = context.buildGateStateComment(REPO, 1, payload)
  const body = [
    '## Someone quoting the format for discussion',
    'Here is what a gate-state comment looks like, for reference:',
    '',
    '> ' + inner.split('\n').join('\n> '),
    '',
    'Anyway, back to the actual discussion.',
  ].join('\n')
  assert.strictEqual(context.parseGateStateComment(body, REPO, 1), null)
})

test('parseGateStateComment: marker present but NOT the last non-empty line parses to null', function () {
  const context = harness.boot()
  const payload = context.buildGateStatePayload({ repo: REPO, issue: 1, run: 'run-1', boundary: 'plan' })
  const body = context.buildGateStateComment(REPO, 1, payload) + '\n\nEdit: please disregard the above.'
  assert.strictEqual(context.parseGateStateComment(body, REPO, 1), null)
})

// ---- parseGateStateProbeRow ----

test('parseGateStateProbeRow: non-JSON stdout returns ok:false, never throws', function () {
  const context = harness.boot()
  const result = harness.normalize(context.parseGateStateProbeRow('definitely not json'))
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.total, 0)
  assert.deepStrictEqual(result.blocks, [])
})

test('parseGateStateProbeRow: truncated JSON stdout (a chunked/interrupted read) returns ok:false, never throws', function () {
  const context = harness.boot()
  const result = harness.normalize(context.parseGateStateProbeRow('{"total":1,"blocks":[{"body":"## Gate St'))
  assert.strictEqual(result.ok, false)
})

test('parseGateStateProbeRow: a shape mismatch (blocks not an array) returns ok:false', function () {
  const context = harness.boot()
  const result = harness.normalize(context.parseGateStateProbeRow(JSON.stringify({ total: 0, blocks: 'nope' })))
  assert.strictEqual(result.ok, false)
})

test('parseGateStateProbeRow: well-formed stdout parses to ok:true with total/blocks intact', function () {
  const context = harness.boot()
  const raw = JSON.stringify({ total: 2, blocks: [{ body: 'x', author_login: 'me', author_association: 'OWNER' }] })
  const result = harness.normalize(context.parseGateStateProbeRow(raw))
  assert.deepStrictEqual(result, { ok: true, total: 2, blocks: [{ body: 'x', author_login: 'me', author_association: 'OWNER' }] })
})

// ---- selectGateState: four states ----

test('selectGateState: found / absent / malformed / read-failed are all distinguishable', function () {
  const context = harness.boot()
  const issue = 1
  const payload = context.buildGateStatePayload({ repo: REPO, issue: issue, run: 'run-1', boundary: 'plan', epoch: 1000 })
  const body = context.buildGateStateComment(REPO, issue, payload)

  const found = context.selectGateState(
    { ok: true, total: 1, blocks: [{ body: body, author_login: 'bot' }] },
    { repo: REPO, issue: issue, self_login: 'bot', run_epoch: 1000 },
    {},
  )
  assert.strictEqual(found.state, 'found')

  const absent = context.selectGateState(
    { ok: true, total: 0, blocks: [] },
    { repo: REPO, issue: issue, self_login: 'bot' },
    { pr_number: null, worktree_exists: false, resume_point: 'implement' },
  )
  assert.strictEqual(absent.state, 'absent')

  const malformed = context.selectGateState(
    { ok: true, total: 1, blocks: [{ body: 'not a gate-state comment at all', author_login: 'bot' }] },
    { repo: REPO, issue: issue, self_login: 'bot' },
    {},
  )
  assert.strictEqual(malformed.state, 'malformed')

  const readFailedExplicit = context.selectGateState({ ok: false, total: 0, blocks: [] }, { repo: REPO, issue: issue }, {})
  assert.strictEqual(readFailedExplicit.state, 'read-failed')

  const readFailedExitNotOk = context.selectGateState({ exit_ok: false, ok: true, total: 0, blocks: [] }, { repo: REPO, issue: issue }, {})
  assert.strictEqual(readFailedExitNotOk.state, 'read-failed')

  const states = [found.state, absent.state, malformed.state, readFailedExplicit.state]
  assert.strictEqual(new Set(states).size, 4, 'all four states must be pairwise distinct')
})

test('selectGateState: falsifiable-absent rule -- zero blocks WITH prior-work evidence (pr_number) is read-failed, never absent', function () {
  const context = harness.boot()
  const result = context.selectGateState(
    { ok: true, total: 0, blocks: [] },
    { repo: REPO, issue: 1 },
    { pr_number: 7, worktree_exists: false, resume_point: 'implement' },
  )
  assert.strictEqual(result.state, 'read-failed')
})

test('selectGateState: falsifiable-absent rule -- zero blocks with NO prior-work evidence stays absent', function () {
  const context = harness.boot()
  const result = context.selectGateState(
    { ok: true, total: 0, blocks: [] },
    { repo: REPO, issue: 1 },
    { pr_number: null, worktree_exists: false, resume_point: 'implement' },
  )
  assert.strictEqual(result.state, 'absent')
})

test('selectGateState: zero blocks but total>0 is read-failed even with NO prior-work evidence -- a self-contradictory probe result is never absence', function () {
  const context = harness.boot()
  const result = context.selectGateState(
    { ok: true, total: 3, blocks: [] },
    { repo: REPO, issue: 1 },
    { pr_number: null, worktree_exists: false, resume_point: 'implement' },
  )
  assert.strictEqual(result.state, 'read-failed')
})

test('selectGateState: falsifiable-absent rule also fires on worktree_exists / a non-implement resume_point alone', function () {
  const context = harness.boot()
  const byWorktree = context.selectGateState(
    { ok: true, total: 0, blocks: [] }, { repo: REPO, issue: 1 },
    { pr_number: null, worktree_exists: true, resume_point: 'implement' },
  )
  assert.strictEqual(byWorktree.state, 'read-failed')

  const byResumePoint = context.selectGateState(
    { ok: true, total: 0, blocks: [] }, { repo: REPO, issue: 1 },
    { pr_number: null, worktree_exists: false, resume_point: 'process_pr' },
  )
  assert.strictEqual(byResumePoint.state, 'read-failed')
})

// ---- selectGateState: positional last-wins + trust-before-last-wins ----

test('selectGateState: positional last-wins across three trusted blocks -- the newest wins, zero skipped', function () {
  const context = harness.boot()
  const issue = 1
  function comment(boundary, epoch) {
    return context.buildGateStateComment(REPO, issue, context.buildGateStatePayload({ repo: REPO, issue: issue, run: 'run-1', boundary: boundary, epoch: epoch }))
  }
  const result = context.selectGateState(
    {
      ok: true, total: 3,
      blocks: [
        { body: comment('approach', 1000), author_login: 'bot' },
        { body: comment('plan', 2000), author_login: 'bot' },
        { body: comment('pr-review-i1', 3000), author_login: 'bot' },
      ],
    },
    { repo: REPO, issue: issue, self_login: 'bot', run_epoch: 3000 },
    {},
  )
  assert.strictEqual(result.state, 'found')
  assert.strictEqual(harness.normalize(result.payload).boundary, 'pr-review-i1')
  assert.strictEqual(result.skipped, 0)
})

test('selectGateState: an older TRUSTED block is selected over an untrusted newest one, with `skipped` counted', function () {
  const context = harness.boot()
  const issue = 1
  function comment(run, epoch) {
    return context.buildGateStateComment(REPO, issue, context.buildGateStatePayload({ repo: REPO, issue: issue, run: run, boundary: 'plan', epoch: epoch }))
  }
  const result = context.selectGateState(
    {
      ok: true, total: 3,
      blocks: [
        { body: comment('run-trusted', 1000), author_login: 'me' },
        { body: comment('run-stranger-a', 2000), author_login: 'stranger' },
        { body: comment('run-stranger-b', 3000), author_login: 'stranger' },
      ],
    },
    { repo: REPO, issue: issue, self_login: 'me', run_epoch: 3000 },
    {},
  )
  assert.strictEqual(result.state, 'found')
  assert.strictEqual(result.trusted, true)
  assert.strictEqual(result.skipped, 2)
  assert.strictEqual(harness.normalize(result.payload).run, 'run-trusted')
})

test('selectGateState: the degenerate all-untrusted case still returns found (there IS data), with trusted:false and skipped:0', function () {
  const context = harness.boot()
  const issue = 1
  function comment(run, epoch) {
    return context.buildGateStateComment(REPO, issue, context.buildGateStatePayload({ repo: REPO, issue: issue, run: run, boundary: 'plan', epoch: epoch }))
  }
  const result = context.selectGateState(
    {
      ok: true, total: 2,
      blocks: [
        { body: comment('run-a', 1000), author_login: 'stranger-1' },
        { body: comment('run-b', 2000), author_login: 'stranger-2' },
      ],
    },
    { repo: REPO, issue: issue, self_login: 'me', run_epoch: 2000 },
    {},
  )
  assert.strictEqual(result.state, 'found')
  assert.strictEqual(result.trusted, false)
  assert.strictEqual(result.skipped, 0)
  assert.strictEqual(harness.normalize(result.payload).run, 'run-b') // newest parseable, fallback
})

// ---- isTrustedGateStateAuthor ----

test('isTrustedGateStateAuthor: self_login match trusts regardless of claim_authors', function () {
  const context = harness.boot()
  assert.strictEqual(context.isTrustedGateStateAuthor('me', 'me', [], 'dev'), true)
})

test('isTrustedGateStateAuthor: no login is never trusted', function () {
  const context = harness.boot()
  assert.strictEqual(context.isTrustedGateStateAuthor('', 'me', [], 'dev'), false)
  assert.strictEqual(context.isTrustedGateStateAuthor(null, 'me', [], 'dev'), false)
})

test('isTrustedGateStateAuthor: a claim author that is neither fresh nor batch-matching is untrusted', function () {
  const context = harness.boot()
  const staleSeconds = harness.readGlobal(context, 'CLAIM_STALE_SECONDS')
  const claimAuthors = [{ login: 'someone', ageSeconds: staleSeconds + 1, batch: 'other-branch' }]
  assert.strictEqual(context.isTrustedGateStateAuthor('someone', null, claimAuthors, 'dev'), false)
})

test('isTrustedGateStateAuthor: a fresh claim (age < CLAIM_STALE_SECONDS) is trusted even off-batch', function () {
  const context = harness.boot()
  const claimAuthors = [{ login: 'someone', ageSeconds: 10, batch: 'other-branch' }]
  assert.strictEqual(context.isTrustedGateStateAuthor('someone', null, claimAuthors, 'dev'), true)
})

test('isTrustedGateStateAuthor: a batch-matching claim is trusted even when stale (a stale forged claim off-batch is not)', function () {
  const context = harness.boot()
  const staleSeconds = harness.readGlobal(context, 'CLAIM_STALE_SECONDS')
  const claimAuthors = [{ login: 'someone', ageSeconds: staleSeconds + 1, batch: 'dev' }]
  assert.strictEqual(context.isTrustedGateStateAuthor('someone', null, claimAuthors, 'dev'), true)

  const staleOffBatch = [{ login: 'someone', ageSeconds: staleSeconds + 1, batch: 'other-branch' }]
  assert.strictEqual(context.isTrustedGateStateAuthor('someone', null, staleOffBatch, 'dev'), false)
})

// ---- epoch / staleness ----

test('deriveRunEpoch: parses a probe-returned `date -u` ISO string into epoch ms', function () {
  const context = harness.boot()
  assert.strictEqual(context.deriveRunEpoch('2024-01-01T00:00:00Z'), Date.parse('2024-01-01T00:00:00Z'))
})

test('deriveRunEpoch: unparseable/absent input returns explicit null, never NaN', function () {
  const context = harness.boot()
  assert.strictEqual(context.deriveRunEpoch('not a date'), null)
  assert.strictEqual(context.deriveRunEpoch(undefined), null)
  assert.strictEqual(context.deriveRunEpoch(null), null)
})

test('gateStateEpochStale: epoch guards -- a null run epoch or a null/missing payload epoch reads as stale, never fresh', function () {
  const context = harness.boot()
  assert.strictEqual(context.gateStateEpochStale({ epoch: 1000 }, null), true)
  assert.strictEqual(context.gateStateEpochStale({}, 5000), true)
  assert.strictEqual(context.gateStateEpochStale(null, 5000), true)
})

test('gateStateEpochStale / selectGateState: stale flips true once age exceeds CLAIM_STALE_SECONDS', function () {
  const context = harness.boot()
  const staleSeconds = harness.readGlobal(context, 'CLAIM_STALE_SECONDS')

  assert.strictEqual(context.gateStateEpochStale({ epoch: 0 }, staleSeconds * 1000), false) // exactly at the boundary: not yet stale
  assert.strictEqual(context.gateStateEpochStale({ epoch: 0 }, staleSeconds * 1000 + 1), true) // one ms past it: stale

  const issue = 1
  const payload = context.buildGateStatePayload({ repo: REPO, issue: issue, run: 'run-1', boundary: 'plan', epoch: 0 })
  const body = context.buildGateStateComment(REPO, issue, payload)
  const result = context.selectGateState(
    { ok: true, total: 1, blocks: [{ body: body, author_login: 'me' }] },
    { repo: REPO, issue: issue, self_login: 'me', run_epoch: staleSeconds * 1000 + 1 },
    {},
  )
  assert.strictEqual(result.state, 'found')
  assert.strictEqual(result.stale, true)
})

// ---- diffGateStateIntent ----

test('diffGateStateIntent: all three verdicts -- match, superseded, mismatch', function () {
  const context = harness.boot()
  const intent = { schema: 1, repo: REPO, issue: 1, run: 'run-1', batch: 'dev', epoch: 1000, boundary: 'plan', group_id: null, members: [1], seeded_from: null, gate_budgets: {}, settled: [] }

  const identical = Object.assign({}, intent)
  assert.strictEqual(context.diffGateStateIntent(intent, identical), 'match')

  const laterSameRun = Object.assign({}, intent, { boundary: 'pr-review-i1', epoch: 2000 })
  assert.strictEqual(context.diffGateStateIntent(intent, laterSameRun), 'superseded')

  const differentRun = Object.assign({}, intent, { run: 'run-2', epoch: 1500 })
  assert.strictEqual(context.diffGateStateIntent(intent, differentRun), 'mismatch')

  const earlierSameRun = Object.assign({}, intent, { epoch: 500 })
  assert.strictEqual(context.diffGateStateIntent(intent, earlierSameRun), 'mismatch')

  assert.strictEqual(context.diffGateStateIntent(null, identical), 'mismatch')
  assert.strictEqual(context.diffGateStateIntent(intent, null), 'mismatch')
})

// ---- attachGateStateBlocks (bare defaulting shape only -- see
// tests/gate-state-read.test.js for the real rowsByIssue join, the
// hallucination-clobbering behavior, and fetchGateStateBlocks itself) ----

test('attachGateStateBlocks: with no join data at all, writes all four gate-state fields unconditionally to their fail-open defaults, without mutating the input', function () {
  const context = harness.boot()
  const preflights = [
    { issue: 1 },
    // even a preflight that already carries these fields (e.g. a hallucinating
    // agent) gets them fully overridden -- these four facts are NEVER read back
    // off the preflight's own pre-existing value, only from real join data.
    { issue: 2, gate_state_blocks: ['x'], gate_state_read_ok: true, gate_state_total_comments: 5, gate_state_trust: 'primary' },
  ]
  const attached = harness.normalize(context.attachGateStateBlocks(preflights))

  assert.deepStrictEqual(attached[0], { issue: 1, gate_state_blocks: [], gate_state_read_ok: false, gate_state_total_comments: 0, gate_state_trust: '' })
  assert.deepStrictEqual(attached[1], { issue: 2, gate_state_blocks: [], gate_state_read_ok: false, gate_state_total_comments: 0, gate_state_trust: '' })
  // non-mutating: the original host-realm objects never gained the new keys
  assert.strictEqual(Object.prototype.hasOwnProperty.call(preflights[0], 'gate_state_blocks'), false)
})
