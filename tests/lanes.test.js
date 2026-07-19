'use strict'

// Unit tests for computeLanes (issue #1, lane scheduling): the pure reducer that
// groups deriveUnits()'s output into lanes of unit INDICES that must run
// serially instead of racing. Covers:
//   - no overlap anywhere -> every unit is its own lane (byte-for-byte
//     degeneration to today's every-unit-races pool)
//   - trusted edges (serialize_globs, depends_on) unite even with zero
//     predicted-file overlap, and are never dissolved
//   - the cohesion-aware collapse guard: a heuristic lane reducing to exactly
//     one co-predicted path is a single-path promiscuous connector and is
//     dissolved (those units race); a lane sharing >=2 co-predicted paths is a
//     genuine cluster and survives intact
//   - the basename fallback only fires when no full path is shared, and is
//     itself subject to the same cohesion guard
//   - the DF magnet signal is logged but never drops an intersection key or
//     suppresses an edge on its own — only the collapse guard does that
//   - a lane's merged predicted_files list is bounded (MAX_LANE_PREDICTED_FILES)

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

function bootLanes(overrides) {
  const logs = []
  const context = harness.createContext(Object.assign({ log: function (msg) { logs.push(msg) } }, overrides))
  harness.loadEngine(context)
  context.__seed({ PROFILE: {} })
  context.logs = logs
  return context
}

function unit(issue, predictedFiles, extra) {
  return Object.assign({ issue: issue, members: [{ issue: issue }], predicted_files: predictedFiles || [], depends_on: [] }, extra)
}

// ---- no-overlap: byte-for-byte degeneration ----

test('computeLanes: units with no shared paths, no serialize_globs, no depends_on each get their own singleton lane', function () {
  const context = bootLanes()
  const units = [unit(1, ['a.js']), unit(2, ['b.js']), unit(3, ['c.js'])]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 3)
  for (const l of lanes) assert.strictEqual(l.unitIndices.length, 1)
  assert.deepStrictEqual(Array.from(lanes).map(function (l) { return l.unitIndices[0] }), [0, 1, 2])
})

test('computeLanes: units with no predicted_files at all are each their own singleton lane', function () {
  const context = bootLanes()
  const units = [unit(1, []), unit(2, []), unit(3, [])]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 3)
})

// ---- trusted: serialize_globs ----

test('computeLanes: serialize_globs unites units matched by the same pattern even with zero full-path overlap, and is never dissolved', function () {
  const context = bootLanes()
  const units = [unit(1, ['migrations/001.sql']), unit(2, ['migrations/002.sql']), unit(3, ['src/unrelated.js'])]
  const lanes = context.computeLanes(units, ['migrations/**'])
  assert.strictEqual(lanes.length, 2)
  const merged = lanes.find(function (l) { return l.unitIndices.length === 2 })
  assert.deepStrictEqual(Array.from(merged.unitIndices), [0, 1])
})

test('computeLanes: an empty/absent serialize_globs list unites nothing on its own', function () {
  const context = bootLanes()
  const units = [unit(1, ['migrations/001.sql']), unit(2, ['migrations/002.sql'])]
  assert.strictEqual(context.computeLanes(units, []).length, 2)
  assert.strictEqual(context.computeLanes(units, null).length, 2)
  assert.strictEqual(context.computeLanes(units, undefined).length, 2)
})

// ---- trusted: depends_on ----

test('computeLanes: a depends_on reference unites two units with zero predicted-file overlap', function () {
  const context = bootLanes()
  const units = [unit(1, ['a.js'], { depends_on: [2] }), unit(2, ['b.js'])]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 1)
  assert.deepStrictEqual(Array.from(lanes[0].unitIndices), [0, 1])
})

test('computeLanes: depends_on resolves against ANY live member\'s issue number, not just a unit\'s own/primary issue', function () {
  const context = bootLanes()
  // unit 0 is a merged group whose primary is issue 10 but also carries member issue 11
  const group = { issue: 10, members: [{ issue: 10 }, { issue: 11 }], predicted_files: [], depends_on: [] }
  const dependent = unit(99, ['z.js'], { depends_on: [11] }) // refs the group's non-primary member
  const lanes = context.computeLanes([group, dependent], [])
  assert.strictEqual(lanes.length, 1)
})

test('computeLanes: a depends_on-only lane with < 2 co-predicted paths is correctly serialized AND never logs a spurious collapse-guard dissolve (the guard only touches heuristic edges)', function () {
  const context = bootLanes()
  const units = [unit(1, ['a.js'], { depends_on: [2] }), unit(2, ['b.js'])]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 1, 'depends_on unites the pair into one lane regardless of path cohesion')
  assert.deepStrictEqual(Array.from(lanes[0].unitIndices), [0, 1])
  assert.ok(!context.logs.some(function (l) { return /collapse guard dissolved/.test(l) }),
    'a trusted-only lane (no heuristic edge involved) must never be reported as dissolved — it was never touched by the guard')
})

test('computeLanes: serialize_globs-only lane with < 2 co-predicted paths never logs a spurious collapse-guard dissolve', function () {
  const context = bootLanes()
  const units = [unit(1, ['migrations/001.sql']), unit(2, ['migrations/002.sql'])]
  context.computeLanes(units, ['migrations/**'])
  assert.ok(!context.logs.some(function (l) { return /collapse guard dissolved/.test(l) }),
    'a trusted-only lane (serialize_globs, no heuristic edge) must never be reported as dissolved')
})

// ---- cohesion-aware collapse guard ----

test('computeLanes: a heuristic lane sharing exactly ONE co-predicted path is a single-path promiscuous connector and is dissolved (races)', function () {
  const context = bootLanes()
  const units = [unit(1, ['SecurityHeaders.php']), unit(2, ['SecurityHeaders.php']), unit(3, ['SecurityHeaders.php'])]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 3, 'single shared path is not enough cohesion to survive the collapse guard')
  for (const l of lanes) assert.strictEqual(l.unitIndices.length, 1)
})

test('computeLanes: a heuristic lane sharing >=2 co-predicted paths is a genuine cluster and is kept intact, even spanning most of the batch', function () {
  const context = bootLanes()
  const shared = ['SecurityHeaders.php', 'SecurityHeadersTest.php']
  const units = [unit(1, shared.slice()), unit(2, shared.slice()), unit(3, shared.slice())]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 1, '>=2 shared paths exempts the lane from the collapse guard')
  assert.deepStrictEqual(Array.from(lanes[0].unitIndices), [0, 1, 2])
})

test('computeLanes: two independent single-path edges combining into one lane with 2 DISTINCT co-predicted paths survive (aggregate cohesion, not per-edge)', function () {
  const context = bootLanes()
  // 0-1 share only pathA; 1-2 share only pathB; the lane {0,1,2} co-predicts 2
  // distinct paths in aggregate even though no single edge does.
  const units = [unit(1, ['pathA.js']), unit(2, ['pathA.js', 'pathB.js']), unit(3, ['pathB.js'])]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 1)
  assert.deepStrictEqual(Array.from(lanes[0].unitIndices), [0, 1, 2])
})

test('computeLanes: a magnet-only rider touching one member of a genuine 2-path cluster does NOT ride along into that cluster\'s lane (scoped cohesion, not whole-component)', function () {
  const context = bootLanes()
  // 0 and 1 share only magnet.php with 2 and each other (single-path, weak) — 2
  // also shares impl.js + impl.test.js with 3 (a genuine 2-path cluster). The
  // whole trial component {0,1,2,3} would wrongly read as cohesive (3 distinct
  // paths in aggregate) if cohesion were computed over the whole component
  // instead of per weak-edge-only chain: units 0 and 1 must stay singleton
  // (race) while 2 and 3 serialize on their own genuine overlap.
  const units = [
    unit(1, ['magnet.php']),
    unit(2, ['magnet.php']),
    unit(3, ['magnet.php', 'impl.js', 'impl.test.js']),
    unit(4, ['impl.js', 'impl.test.js'])
  ]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 3, 'expected {0},{1},{2,3} — not one merged lane of all four')
  const sizes = Array.from(lanes).map(function (l) { return l.unitIndices.length }).sort()
  assert.deepStrictEqual(sizes, [1, 1, 2])
  const merged = lanes.find(function (l) { return l.unitIndices.length === 2 })
  assert.deepStrictEqual(Array.from(merged.unitIndices), [2, 3], 'the genuine 2-path cluster (units 3,4) must be the one that survives')
})

// ---- basename fallback ----

test('computeLanes: a shared basename with no full-path overlap forms a heuristic edge, but is dissolved absent reinforcing full-path cohesion', function () {
  const context = bootLanes()
  const units = [unit(1, ['src/a/config.js']), unit(2, ['src/b/config.js'])]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 2, 'basename-only overlap alone is not >=2 full-path cohesion')
})

test('computeLanes: full-path intersection takes priority over basename — an exact shared path is used directly', function () {
  const context = bootLanes()
  const shared = ['src/shared/config.js', 'src/shared/config.test.js']
  const units = [unit(1, shared.slice()), unit(2, shared.slice())]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 1)
})

// ---- DF signal: advisory/metric-only ----

test('computeLanes: a DF magnet (matched by more than half the batch, min 3) is logged but never drops the intersection key or suppresses a cohesive lane', function () {
  const context = bootLanes()
  const shared = ['SecurityHeaders.php', 'SecurityHeadersTest.php']
  const units = [unit(1, shared.slice()), unit(2, shared.slice()), unit(3, shared.slice())]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 1, 'DF magnet signal must not dissolve a >=2-path cohesive lane')
  assert.ok(context.logs.some(function (l) { return /DF magnet signal \(advisory only/.test(l) }), 'expected an advisory DF log line')
})

test('computeLanes: serialize_globs paths are never counted toward the DF magnet signal', function () {
  const context = bootLanes()
  const units = [unit(1, ['migrations/x.sql']), unit(2, ['migrations/x.sql']), unit(3, ['migrations/x.sql'])]
  context.computeLanes(units, ['migrations/**'])
  assert.ok(!context.logs.some(function (l) { return /DF magnet signal/.test(l) }), 'serialize_globs-matched paths must be excluded from DF counting')
})

test('computeLanes: no magnet below the threshold (min 3, > half the batch) produces no DF log line', function () {
  const context = bootLanes()
  const units = [unit(1, ['a.js', 'shared.js']), unit(2, ['b.js', 'shared.js']), unit(3, ['c.js']), unit(4, ['d.js']), unit(5, ['e.js'])]
  context.computeLanes(units, [])
  assert.ok(!context.logs.some(function (l) { return /DF magnet signal/.test(l) }))
})

// ---- bounded predicted-set growth ----

test('computeLanes: a lane\'s merged predicted_files list is capped at MAX_LANE_PREDICTED_FILES', function () {
  const context = bootLanes()
  const units = []
  for (let i = 0; i < 10; i++) {
    const files = []
    for (let j = 0; j < 10; j++) files.push('gen/file-' + i + '-' + j + '.js')
    units.push(unit(i + 1, files))
  }
  // Force every unit into one lane via a catch-all serialize_globs pattern.
  const lanes = context.computeLanes(units, ['gen/**'])
  assert.strictEqual(lanes.length, 1)
  assert.ok(lanes[0].predicted_files.length <= 60, 'expected the merged predicted_files list to be capped, got ' + lanes[0].predicted_files.length)
  assert.ok(lanes[0].predicted_files.length > 0)
})

// ---- lane shape sanity ----

test('computeLanes: lanes are sorted by lowest unit index, and every lane carries its member unitIndices plus a predicted_files list', function () {
  const context = bootLanes()
  const units = [unit(1, ['a.js'], { depends_on: [3] }), unit(2, ['b.js']), unit(3, ['c.js'])]
  const lanes = context.computeLanes(units, [])
  assert.strictEqual(lanes.length, 2)
  assert.deepStrictEqual(Array.from(lanes[0].unitIndices), [0, 2])
  assert.deepStrictEqual(Array.from(lanes[1].unitIndices), [1])
  assert.ok(Array.isArray(lanes[0].predicted_files))
})

// ---- computeLanes({ trustedOnly: true }) (issue #1, used by the real-run
// collapse guard below) ----

test('computeLanes: trustedOnly unions serialize_globs and depends_on but skips heuristic edges, the DF log, and the dissolve log entirely', function () {
  const context = bootLanes()
  const units = [unit(1, ['SecurityHeaders.php'], { depends_on: [2] }), unit(2, ['SecurityHeaders.php']), unit(3, ['SecurityHeaders.php'])]
  const lanes = context.computeLanes(units, [], { trustedOnly: true })
  // 0-1 unite via depends_on; 2 has no trusted edge to either -> stays singleton,
  // even though all three would heuristically merge under the default mode.
  assert.strictEqual(lanes.length, 2)
  const sizes = Array.from(lanes).map(function (l) { return l.unitIndices.length }).sort()
  assert.deepStrictEqual(sizes, [1, 2])
  assert.ok(!context.logs.length, 'trustedOnly must skip the DF/dissolve log paths entirely')
})

// ---- applyRealRunCollapseGuard (issue #1) ----

function laneUnit(issue, predictedFiles, extra) {
  return Object.assign({ issue: issue, members: [{ issue: issue }], predicted_files: predictedFiles || [], depends_on: [] }, extra)
}

test('applyRealRunCollapseGuard: no-op (same array reference) when unitCount < concurrency, even with a severe collapse ratio', function () {
  const context = bootLanes()
  const units = [laneUnit(1, ['a.js']), laneUnit(2, ['b.js']), laneUnit(3, ['c.js'])]
  const lanes = [{ unitIndices: [0, 1, 2], predicted_files: ['a.js'] }] // one giant lane, ratio would be severe
  const guard = context.applyRealRunCollapseGuard(units, lanes, 5, [])
  assert.strictEqual(guard.dissolvedCount, 0)
  assert.strictEqual(guard.lanes, lanes, 'must return the SAME array reference on the no-op path')
})

test('applyRealRunCollapseGuard: no-op when collapse_ratio >= 0.5', function () {
  const context = bootLanes()
  const units = [laneUnit(1, ['a.js']), laneUnit(2, ['a.js']), laneUnit(3, ['c.js']), laneUnit(4, ['d.js'])]
  // 2 lanes for 4 units at concurrency 4 -> ratio 2/4 = 0.5, not < 0.5.
  const lanes = [{ unitIndices: [0, 1], predicted_files: ['a.js'] }, { unitIndices: [2] }, { unitIndices: [3] }]
  const guard = context.applyRealRunCollapseGuard(units, lanes, 4, [])
  assert.strictEqual(guard.dissolvedCount, 0)
  assert.strictEqual(guard.lanes, lanes)
})

// Every fixture below pads unitCount up to (>=) concurrency with a SECOND lane
// built on serialize_globs (a trusted edge) so that padding lane is provably kept
// regardless of the guard's cohesion check — isolating each assertion to what
// happens to the ONE lane under test.
function paddingUnits(startIssue, count) {
  const out = []
  for (let i = 0; i < count; i++) out.push(laneUnit(startIssue + i, ['pad/file-' + i + '.js']))
  return out
}

test('applyRealRunCollapseGuard: dissolves a single-path magnet lane back to singletons when triggered', function () {
  const context = bootLanes()
  // 8 units: {0,1,2} merged on nothing but a single shared magnet path (the exact
  // shape this guard exists to catch as a final safety net, independent of
  // whatever produced `lanes`); {3..7} trusted via serialize_globs (padding, kept
  // unconditionally). laneCount 2 for 8 units at concurrency 8 gives ratio =
  // min(8,2)/min(8,8) = 2/8 = 0.25 < 0.5, well inside the trigger band.
  const units = [
    laneUnit(1, ['magnet.php']), laneUnit(2, ['magnet.php']), laneUnit(3, ['magnet.php']),
  ].concat(paddingUnits(4, 5))
  const lanes = [
    { unitIndices: [0, 1, 2], predicted_files: ['magnet.php'] }, // synthetic magnet lane
    { unitIndices: [3, 4, 5, 6, 7] }, // trusted (serialize_globs) padding lane
  ]
  const guard = context.applyRealRunCollapseGuard(units, lanes, 8, ['pad/**'])
  assert.ok(guard.collapseRatio < 0.5, 'expected the fixture to actually trigger the guard: got ' + guard.collapseRatio)
  assert.strictEqual(guard.dissolvedCount, 1)
  assert.strictEqual(guard.lanes.length, 4) // {3,4,5,6,7} kept whole + 3 dissolved singletons
  const singles = Array.from(guard.lanes).filter(function (l) { return l.unitIndices.length === 1 }).map(function (l) { return l.unitIndices[0] }).sort()
  assert.deepStrictEqual(singles, [0, 1, 2])
  const kept = Array.from(guard.lanes).find(function (l) { return l.unitIndices.length === 5 })
  assert.deepStrictEqual(Array.from(kept.unitIndices), [3, 4, 5, 6, 7])
})

test('applyRealRunCollapseGuard: a lane sharing >= 2 paths across its whole membership is exempt even when triggered', function () {
  const context = bootLanes()
  const units = [
    laneUnit(1, ['impl.js', 'impl.test.js']), laneUnit(2, ['impl.js', 'impl.test.js']), laneUnit(3, ['impl.js', 'impl.test.js']),
  ].concat(paddingUnits(4, 5))
  const lanes = [
    { unitIndices: [0, 1, 2], predicted_files: ['impl.js', 'impl.test.js'] }, // genuine cluster
    { unitIndices: [3, 4, 5, 6, 7] }, // trusted (serialize_globs) padding lane
  ]
  const guard = context.applyRealRunCollapseGuard(units, lanes, 8, ['pad/**'])
  assert.ok(guard.collapseRatio < 0.5)
  assert.strictEqual(guard.dissolvedCount, 0)
  assert.strictEqual(guard.lanes, lanes)
})

test('applyRealRunCollapseGuard: a trusted lane (depends_on) is kept even when triggered and even with < 2 shared paths', function () {
  const context = bootLanes()
  const units = [
    laneUnit(1, ['a.js'], { depends_on: [2] }), laneUnit(2, ['b.js']),
  ].concat(paddingUnits(3, 6))
  const lanes = [
    { unitIndices: [0, 1], predicted_files: ['a.js', 'b.js'] }, // trusted via depends_on, zero shared paths
    { unitIndices: [2, 3, 4, 5, 6, 7] }, // trusted (serialize_globs) padding lane
  ]
  const guard = context.applyRealRunCollapseGuard(units, lanes, 8, ['pad/**'])
  assert.ok(guard.collapseRatio < 0.5)
  assert.strictEqual(guard.dissolvedCount, 0, 'a trusted lane must never be dissolved by this guard, no matter its path cohesion')
  assert.strictEqual(guard.lanes, lanes)
})
