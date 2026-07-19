'use strict'

// Unit tests for runPool (issue #1, lane scheduling): the lane-aware work-stealing
// pool that replaced the old flat "shared `next` counter over items" pool. Covers:
//   - no-overlap degeneration: singleton lanes (explicit or omitted) behave
//     byte-for-byte like the old flat pool (worker count, call order, results
//     shape, keyed by original item index)
//   - a multi-unit lane drains its units SERIALLY (never two units of the same
//     lane in flight at once), in depends_on order, while DIFFERENT lanes still
//     run concurrently against each other
//   - the STOP sweep produces exactly one not_started result per remaining unit,
//     across both the lane a worker was mid-drain on AND every lane no worker had
//     stolen yet
//   - a throw from fn() mid-lane is isolated to that one unit (a `failed` result)
//     and never tears down a sibling lane's results via a rejected Promise.all
//   - results always stays length === items.length, keyed by ORIGINAL item index

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

function bootPool(overrides) {
  const logs = []
  const context = harness.createContext(Object.assign({ log: function (msg) { logs.push(msg) } }, overrides))
  harness.loadEngine(context)
  context.logs = logs
  return context
}

function unit(issue, extra) {
  return Object.assign({ issue: issue, title: 'issue #' + issue, members: [{ issue: issue }], depends_on: [] }, extra)
}

function tripStop(context, reason) {
  harness.readGlobal(context, 'STOP.tripped = true; STOP.reason = ' + JSON.stringify(reason || 'test stop') + ';')
}

// ---- no-overlap: byte-for-byte degeneration ----

test('runPool: with lanes omitted, results are keyed by original item index and shaped exactly like a direct fn() call', async function () {
  const context = bootPool()
  const items = [unit(1), unit(2), unit(3)]
  const calls = []
  const results = await context.runPool(items, 2, async function (item) {
    calls.push(item.issue)
    return { issue: item.issue, status: 'completed' }
  })
  assert.strictEqual(results.length, 3)
  assert.deepStrictEqual(Array.from(results).map(function (r) { return r.issue }), [1, 2, 3])
  assert.deepStrictEqual(Array.from(results).map(function (r) { return r.status }), ['completed', 'completed', 'completed'])
  assert.deepStrictEqual(calls.slice().sort(), [1, 2, 3])
})

test('runPool: explicit all-singleton lanes produce IDENTICAL results/call-order to omitting lanes entirely', async function () {
  const items = [unit(1), unit(2), unit(3), unit(4)]
  async function fn(item) { return { issue: item.issue, status: 'completed' } }

  const contextA = bootPool()
  const callsA = []
  const resultsA = await contextA.runPool(items, 2, async function (item) { callsA.push(item.issue); return fn(item) })

  const contextB = bootPool()
  const callsB = []
  const singletonLanes = items.map(function (_, i) { return { unitIndices: [i] } })
  const resultsB = await contextB.runPool(items, 2, async function (item) { callsB.push(item.issue); return fn(item) }, singletonLanes)

  assert.deepStrictEqual(callsA, callsB, 'worker scheduling over singleton lanes must match the omitted-lanes path exactly')
  assert.deepStrictEqual(Array.from(resultsA), Array.from(resultsB))
})

test('runPool: worker count is min(limit, laneCount) — a singleton-lane run over 2 items with limit 5 starts only 2 workers', async function () {
  const context = bootPool()
  const items = [unit(1), unit(2)]
  let concurrent = 0
  let maxConcurrent = 0
  await context.runPool(items, 5, async function (item) {
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    await new Promise(function (resolve) { setTimeout(resolve, 5) })
    concurrent--
    return { issue: item.issue, status: 'completed' }
  })
  assert.strictEqual(maxConcurrent, 2, 'only 2 items exist, so only 2 workers should ever be in flight regardless of limit=5')
})

// ---- lane-aware serial drain ----

test('runPool: a multi-unit lane drains its units SERIALLY, in depends_on order (not plain ascending index order)', async function () {
  const context = bootPool()
  // index 0 (issue 10) depends on issue 20 (index 1) — depends_on order must run
  // index 1 BEFORE index 0, the reverse of plain ascending unitIndices order.
  const items = [unit(10, { depends_on: [20] }), unit(20)]
  const order = []
  const results = await context.runPool(items, 2, async function (item) {
    order.push(item.issue)
    await new Promise(function (resolve) { setTimeout(resolve, 5) })
    return { issue: item.issue, status: 'completed' }
  }, [{ unitIndices: [0, 1] }])
  assert.deepStrictEqual(order, [20, 10], 'depends_on must reorder the drain: 20 (the dependency) before 10 (the dependent)')
  // results stay keyed by ORIGINAL item index regardless of drain order.
  assert.strictEqual(results[0].issue, 10)
  assert.strictEqual(results[1].issue, 20)
})

test('runPool: units within the SAME lane never overlap in flight, but DIFFERENT lanes run concurrently', async function () {
  const context = bootPool()
  const items = [unit(1), unit(2), unit(3), unit(4)]
  const lanes = [{ unitIndices: [0, 1] }, { unitIndices: [2, 3] }] // lane A: 0,1 -- lane B: 2,3
  const laneOf = { 0: 'A', 1: 'A', 2: 'B', 3: 'B' }
  const activeInLane = { A: 0, B: 0 }
  const violations = []
  let crossLaneOverlapSeen = false
  const results = await context.runPool(items, 2, async function (item) {
    const idx = item.issue - 1
    const lane = laneOf[idx]
    activeInLane[lane]++
    if (activeInLane[lane] > 1) violations.push('lane ' + lane + ' had ' + activeInLane[lane] + ' units in flight at once')
    if (activeInLane.A > 0 && activeInLane.B > 0) crossLaneOverlapSeen = true
    await new Promise(function (resolve) { setTimeout(resolve, 8) })
    activeInLane[lane]--
    return { issue: item.issue, status: 'completed' }
  }, lanes)
  assert.deepStrictEqual(violations, [], 'no lane should ever have more than one unit in flight at once')
  assert.strictEqual(crossLaneOverlapSeen, true, 'lane A and lane B should still run concurrently against each other (2 workers, 2 lanes)')
  assert.strictEqual(results.length, 4)
  assert.deepStrictEqual(Array.from(results).map(function (r) { return r.status }), ['completed', 'completed', 'completed', 'completed'])
})

// ---- STOP sweep ----

test('runPool: once STOP trips, every remaining unit in the draining lane AND every un-stolen lane gets exactly one not_started result', async function () {
  const context = bootPool()
  const items = [unit(1), unit(2), unit(3), unit(4), unit(5), unit(6)]
  // lane A (0,1) is worked by the one worker (limit=1); lanes B (2,3) and C (4,5)
  // are never even stolen before STOP trips inside lane A's first unit.
  const lanes = [{ unitIndices: [0, 1] }, { unitIndices: [2, 3] }, { unitIndices: [4, 5] }]
  const calls = []
  const results = await context.runPool(items, 1, async function (item) {
    calls.push(item.issue)
    tripStop(context, 'budget exhausted (test)')
    return { issue: item.issue, status: 'completed' }
  }, lanes)
  assert.strictEqual(results.length, 6)
  assert.deepStrictEqual(calls, [1], 'fn should be called exactly once — item 1 — before STOP trips')
  assert.strictEqual(results[0].status, 'completed', 'the unit already in flight when STOP tripped keeps its real result')
  for (let i = 1; i < 6; i++) {
    assert.strictEqual(results[i].status, 'not_started', 'unit index ' + i + ' expected not_started')
    assert.strictEqual(results[i].error, 'not launched: budget exhausted (test)')
    assert.deepStrictEqual(results[i].members, [items[i].issue])
  }
})

test('runPool: STOP tripped before the pool ever starts sweeps every unit not_started, results.length still items.length', async function () {
  const context = bootPool()
  tripStop(context, 'pre-tripped')
  const items = [unit(1), unit(2), unit(3)]
  const results = await context.runPool(items, 2, async function () {
    throw new Error('fn must never be called once STOP is already tripped')
  }, items.map(function (_, i) { return { unitIndices: [i] } }))
  assert.strictEqual(results.length, 3)
  for (const r of results) assert.strictEqual(r.status, 'not_started')
})

// ---- throw isolation ----

test('runPool: a throw mid-lane is isolated to that unit (failed status) and never tears down a sibling lane\'s results', async function () {
  const context = bootPool()
  const items = [unit(1), unit(2), unit(3), unit(4)]
  // lane A (0,1): unit 0 throws. lane B (2,3): both succeed normally, on a
  // separate worker running concurrently.
  const lanes = [{ unitIndices: [0, 1] }, { unitIndices: [2, 3] }]
  const results = await context.runPool(items, 2, async function (item) {
    await new Promise(function (resolve) { setTimeout(resolve, 5) })
    if (item.issue === 1) throw new Error('boom')
    return { issue: item.issue, status: 'completed' }
  }, lanes)
  assert.strictEqual(results.length, 4, 'a throw must never shrink the results array')
  assert.strictEqual(results[0].status, 'failed')
  assert.ok(/boom/.test(results[0].error))
  assert.strictEqual(results[0].stage, 'pool')
  assert.deepStrictEqual(results[0].members, [1])
  // Lane A's SECOND unit still runs (the throw only aborted unit 0, not the lane).
  assert.strictEqual(results[1].status, 'completed')
  assert.strictEqual(results[1].issue, 2)
  // Lane B (a different lane, on a different worker) is completely unaffected.
  assert.strictEqual(results[2].status, 'completed')
  assert.strictEqual(results[2].issue, 3)
  assert.strictEqual(results[3].status, 'completed')
  assert.strictEqual(results[3].issue, 4)
})

test('runPool: a synchronously-thrown (non-Error) value from fn() is still isolated to one unit', async function () {
  const context = bootPool()
  const items = [unit(1), unit(2)]
  const results = await context.runPool(items, 2, async function (item) {
    if (item.issue === 1) throw 'plain string throw' // eslint-disable-line no-throw-literal
    return { issue: item.issue, status: 'completed' }
  }, items.map(function (_, i) { return { unitIndices: [i] } }))
  assert.strictEqual(results.length, 2)
  assert.strictEqual(results[0].status, 'failed')
  assert.ok(/plain string throw/.test(results[0].error))
  assert.strictEqual(results[1].status, 'completed')
})
