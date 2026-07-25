'use strict'

// Unit tests for computeGateYield(results) (issue #91 task 2) — the pure
// per-run rollup of the gate_findings tally recordGateOutcome() builds per
// issue (issue #87 task 3's approach/plan wiring, issue #91 task 1's
// pr-review wiring): per-gate finding count, severity mix, accepted-vs-
// dismissed ratio, and a count-based "escaped defect" signal (a finding
// raised at the late 'pr-review' gate that both early gates -- 'approach'
// and 'plan' -- missed entirely).

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// by_gate/by_issue/escaped_defects are built inside the vm-realm engine
// function, so their prototype differs from this file's own object/array
// literals and fails deepStrictEqual's prototype check even when
// structurally identical (same cross-realm reasoning as
// tests/gate-findings.test.js's plain() helper).
function plain(x) { return JSON.parse(JSON.stringify(x)) }

function gate(count, severity, disposition) {
  return {
    count: count,
    severity: Object.assign({ critical: 0, major: 0, minor: 0 }, severity),
    disposition: disposition || {},
  }
}

// ---- escaped-defect case ----

test('computeGateYield: a pr-review finding with no approach/plan findings is flagged as an escaped defect', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 5,
      gate_findings: {
        'pr-review': gate(2, { major: 2 }, { accepted: 2 }),
      },
    },
  ]
  const gy = context.computeGateYield(results)

  assert.deepStrictEqual(plain(gy.escaped_defects), [{ issue: 5, count: 2 }])
  assert.deepStrictEqual(plain(gy.by_issue), [{ issue: 5, escaped: true }])
  assert.strictEqual(gy.has_signal, true)
  assert.match(gy.markdown, /Escaped defects/)
  assert.match(gy.markdown, /#5/)
})

// ---- control: earlier gates already raised findings -> not flagged ----

test('computeGateYield: a pr-review finding IS NOT an escaped defect when approach or plan already raised findings', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 6,
      gate_findings: {
        approach: gate(1, { minor: 1 }, { accepted: 1 }),
        plan: gate(0, {}, {}),
        'pr-review': gate(1, { major: 1 }, { accepted: 1 }),
      },
    },
  ]
  const gy = context.computeGateYield(results)

  assert.deepStrictEqual(plain(gy.escaped_defects), [])
  assert.deepStrictEqual(plain(gy.by_issue), [{ issue: 6, escaped: false }])
  assert.match(gy.markdown, /No escaped defects this run/)
})

test('computeGateYield: an issue with no pr-review findings at all is never flagged, regardless of approach/plan', function () {
  const context = harness.boot()
  const results = [
    { issue: 7, gate_findings: { approach: gate(3, { critical: 1 }, { 'carried-unresolved': 3 }) } },
    { issue: 8, gate_findings: {} },
  ]
  const gy = context.computeGateYield(results)

  assert.deepStrictEqual(plain(gy.escaped_defects), [])
  assert.deepStrictEqual(plain(gy.by_issue), [{ issue: 7, escaped: false }, { issue: 8, escaped: false }])
})

// ---- accepted-vs-dismissed ratio ----

test('computeGateYield: accepted-vs-dismissed ratio sums across issues and ignores non-accepted/dismissed dispositions', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, gate_findings: { approach: gate(2, { minor: 2 }, { accepted: 1, 'carried-unresolved': 1 }) } },
    { issue: 2, gate_findings: { approach: gate(1, { major: 1 }, { dismissed: 1 }) } },
    { issue: 3, gate_findings: { approach: gate(1, { major: 1 }, { accepted: 1 }) } },
  ]
  const gy = context.computeGateYield(results)

  const approach = plain(gy.by_gate).approach
  assert.strictEqual(approach.count, 4)
  assert.deepStrictEqual(approach.severity, { critical: 0, major: 2, minor: 2 })
  // accepted: 1 (issue1) + 1 (issue3) = 2; dismissed: 1 (issue2) -- the
  // 'carried-unresolved' disposition on issue1 must NOT be folded into either bucket.
  assert.strictEqual(approach.accepted, 2)
  assert.strictEqual(approach.dismissed, 1)
  assert.ok(Math.abs(approach.ratio - (2 / 3)) < 1e-9)
})

test('computeGateYield: a gate with zero accepted and zero dismissed findings has a null ratio, rendered as an em dash', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, gate_findings: { plan: gate(2, { minor: 2 }, { 're-litigated': 2 }) } },
  ]
  const gy = context.computeGateYield(results)

  assert.strictEqual(gy.by_gate.plan.ratio, null)
  assert.match(gy.markdown, /—/, 'markdown table renders the null ratio as an em dash')
})

// ---- defensive ----

test('computeGateYield: defensive against missing/empty inputs -- never throws', function () {
  const context = harness.boot()

  assert.doesNotThrow(function () { context.computeGateYield(null) })
  assert.doesNotThrow(function () { context.computeGateYield(undefined) })

  const empty = context.computeGateYield([])
  assert.deepStrictEqual(plain(empty.by_gate), {})
  assert.deepStrictEqual(plain(empty.escaped_defects), [])
  assert.strictEqual(empty.has_signal, false)
  assert.match(empty.markdown, /No gate findings recorded this run/)
})

test('computeGateYield: a result missing gate_findings entirely degrades cleanly (no throw, not counted)', function () {
  const context = harness.boot()
  const results = [{ issue: 1 }, { issue: 2, gate_findings: null }]
  const gy = context.computeGateYield(results)

  assert.deepStrictEqual(plain(gy.by_gate), {})
  assert.deepStrictEqual(plain(gy.by_issue), [{ issue: 1, escaped: false }, { issue: 2, escaped: false }])
  assert.strictEqual(gy.has_signal, false)
})
