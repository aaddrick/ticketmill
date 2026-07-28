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

// ---- escaped defects vs a dead challenger ----

test('computeGateYield: a pr-review finding IS NOT an escaped defect when every early gate that recorded an outcome only dismissed (dead challenger, nothing adjudicated)', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 9,
      gate_findings: {
        approach: gate(0, {}, { dismissed: 1 }),
        'pr-review': gate(2, { major: 2 }, { accepted: 1 }),
      },
    },
  ]
  const gy = context.computeGateYield(results)

  // The approach challenger died, so it never judged the work. Its zero finding
  // count is an absence of judgment, not a clean pass, and calling the later
  // pr-review findings "escaped" would invent a defect out of a dead agent.
  assert.deepStrictEqual(plain(gy.escaped_defects), [])
  assert.deepStrictEqual(plain(gy.by_issue), [{ issue: 9, escaped: false }])
})

test('computeGateYield: a dismissed early gate does not mask a genuine escape when the OTHER early gate adjudicated clean', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 10,
      gate_findings: {
        approach: gate(0, {}, { dismissed: 1 }),
        plan: gate(0, {}, { accepted: 1 }),
        'pr-review': gate(2, { major: 2 }, { accepted: 1 }),
      },
    },
  ]
  const gy = context.computeGateYield(results)

  // plan reached a real disposition and found nothing, so the escape is real.
  assert.deepStrictEqual(plain(gy.escaped_defects), [{ issue: 10, count: 2 }])
  assert.deepStrictEqual(plain(gy.by_issue), [{ issue: 10, escaped: true }])
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
  // ...but it must still be COUNTED, in its own column. The ratio's denominator
  // stays accepted+dismissed; re-litigated and carried are reported beside it.
  assert.strictEqual(approach.relitigated, 0)
  assert.strictEqual(approach.carried, 1)
  assert.match(gy.markdown, /\| Re-litigated \| Carried \|/)
})

test('computeGateYield: a gate that only ever re-litigated reports its iterations even though the ratio is null', function () {
  const context = harness.boot()
  const results = [
    { issue: 1, gate_findings: { approach: gate(8, { major: 3, minor: 5 }, { 're-litigated': 2, 'carried-unresolved': 1 }) } },
  ]
  const gy = context.computeGateYield(results)

  const approach = plain(gy.by_gate).approach
  assert.strictEqual(approach.ratio, null)
  assert.strictEqual(approach.relitigated, 2)
  assert.strictEqual(approach.carried, 1)
  // The row an operator most needs to see used to render as a bare em dash.
  assert.match(gy.markdown, /\| approach \| 8 \| 0 \| 3 \| 5 \| — \| 2 \| 1 \|/)
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

// ---- issue #163: the new 'quality' gate key rolls into by_gate/has_signal
// exactly like every other gate, but is neither an EARLY_GATE nor the
// ESCAPE_GATE, so it must never perturb escaped_defects/by_issue. ----

test('computeGateYield: a quality key tallies into by_gate but never affects escaped_defects — a pr-review finding still escapes with no approach/plan present', function () {
  const context = harness.boot()
  const results = [
    {
      issue: 11,
      gate_findings: {
        quality: gate(3, { major: 3 }, { 're-litigated': 2, 'carried-unresolved': 1 }),
        'pr-review': gate(1, { minor: 1 }, { accepted: 1 }),
      },
    },
  ]
  const gy = context.computeGateYield(results)

  // Same escape outcome as if 'quality' were absent entirely (compare against
  // tests/gate-yield.test.js's own escaped-defect case above): quality is not
  // in EARLY_GATES, so it contributes nothing to earlyCount.
  assert.deepStrictEqual(plain(gy.escaped_defects), [{ issue: 11, count: 1 }])
  assert.deepStrictEqual(plain(gy.by_issue), [{ issue: 11, escaped: true }])

  const quality = plain(gy.by_gate).quality
  assert.strictEqual(quality.count, 3)
  assert.deepStrictEqual(quality.severity, { critical: 0, major: 3, minor: 0 })
})

test('computeGateYield: an issue with ONLY quality gate_findings (no pr-review at all) is never flagged as an escaped defect', function () {
  const context = harness.boot()
  const results = [
    { issue: 12, gate_findings: { quality: gate(4, { major: 4 }, { 're-litigated': 4 }) } },
  ]
  const gy = context.computeGateYield(results)

  assert.deepStrictEqual(plain(gy.escaped_defects), [])
  assert.deepStrictEqual(plain(gy.by_issue), [{ issue: 12, escaped: false }])
})

// ---- issue #163: the quality-denominator footnote renders only when a
// 'quality' key is actually present in this run's gate_findings ----

test('computeGateYield: the quality-denominator footnote renders when a quality key is present, and is absent otherwise', function () {
  const context = harness.boot()

  const withoutQuality = context.computeGateYield([
    { issue: 20, gate_findings: { approach: gate(1, { minor: 1 }, { accepted: 1 }) } },
  ])
  assert.doesNotMatch(withoutQuality.markdown, /quality runs once per task/)

  const withQuality = context.computeGateYield([
    { issue: 21, gate_findings: { quality: gate(1, { minor: 1 }, { accepted: 1 }) } },
  ])
  assert.match(withQuality.markdown, /quality runs once per task plus once per PR-fix round/)
})
