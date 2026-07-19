'use strict'

// tests/harness.js — loads workflows/ticketmill.js's pure/near-pure helpers into a
// throwaway node:vm context so they can be unit-tested directly, without ever
// running the engine as a real Workflow (no gh, no network, no wall-clock).
//
// WHY THIS EXISTS: the engine is a top-level ESM module (`export const meta`, then
// top-level `await agent(...)` calls, ending in a final `return`). It cannot be
// require()d or import()ed by plain Node — it only runs inside Claude Code's
// Workflow tool, which injects globals (agent, parallel, pipeline, phase, log,
// args, budget) and drives the top-level await. This harness instead:
//   1. Reads workflows/ticketmill.js as TEXT (never executes the real file directly).
//   2. Strips the leading `export` keyword (`export const meta` -> `const meta`) so
//      the source is a plain script, not a module record.
//   3. Truncates the text at a stable marker comment
//      ("TICKETMILL-TEST-HARNESS-SPLIT") that sits just above `phase('Select')` —
//      everything from that call onward (all top-level `await agent(...)` calls,
//      the Select/Report orchestration, and the final `return`) is dropped. What
//      remains is ONLY declarations: `const`/`let` bindings, and `function`/`async
//      function` declarations (including the lifted `sanitizeTasks`, `scopeGuard`,
//      `decisionChain`, `runTestLoop`, the test-only `__seed` hook, etc).
//   4. Runs that remainder as a NON-STRICT node:vm script in a fresh vm context
//      whose global object is pre-seeded with stub globals (agent, parallel,
//      pipeline, phase, log, budget, args). Non-strict matters: top-level
//      `function` declarations in non-strict global code attach to the global
//      object, so tests can read them straight off the context (`ctx.sanitizeTasks`,
//      `ctx.scopeGuard`, ...). Top-level `const`/`let` do NOT attach to the global
//      object — they stay in the context's shared global LEXICAL environment,
//      exactly like multiple <script> tags in a browser realm — so module state
//      (PROFILE, TEST_CMD, IMPLEMENTERS, ...) stays closed over by the functions
//      that reference it, invisible to the outside except through those functions
//      (or through readGlobal(), for tests that need to peek/prove state directly).
//
// If workflows/ticketmill.js's shape changes (the split marker is removed/reworded,
// or `phase('Select')` moves before it), loadEngine() throws immediately with a
// message telling you to update this file — it never silently truncates the wrong
// thing.

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ENGINE_PATH = path.join(__dirname, '..', 'workflows', 'ticketmill.js')

// The split anchor is two-part on purpose: the marker comment is the
// human-visible, grep-able contract ("don't reword this without updating the
// harness"); phase('Select') is the actual mechanical cut point. Requiring the
// marker to appear BEFORE the phase('Select') call catches both "marker deleted"
// and "phase('Select') moved above the marker" as loud failures, not silent
// mis-truncation.
const SPLIT_MARKER = 'TICKETMILL-TEST-HARNESS-SPLIT'
const SELECT_ANCHOR = "phase('Select')"

// A ctx.metrics shape matching processIssue()'s initial object exactly (workflows/
// ticketmill.js, ~line 1673) — kept in sync by hand since the harness can't import it.
function freshMetrics() {
  return {
    approach_iters: 0, plan_iters: 0, tasks_done: 0, tasks_failed: 0,
    task_review_attempts: 0, quality_iters: 0, quality_degrades: 0,
    test_iters: 0, browser_iters: 0, pr_review_iters: 0,
  }
}

// A ctx.tokens shape matching processIssue()'s initial object exactly (workflows/
// ticketmill.js, ~line 1823) — stage()'s token-tracking finally-block only fires
// when `ctx && ctx.tokens` is truthy, so any fixture ctx omitting this field
// silently no-ops through that instrumentation instead of exercising it.
function freshTokens() {
  return { total: 0, byModel: {}, tracked: false }
}

/** Read workflows/ticketmill.js as text (never executed directly). */
function readEngineSource() {
  return fs.readFileSync(ENGINE_PATH, 'utf8')
}

/**
 * Strip the leading `export` keyword and truncate at the stable harness-split
 * marker (everything from `phase('Select')` onward — all top-level await and the
 * final return — is dropped). Returns declarations only: consts/lets and
 * function/async function declarations. Throws loudly if the engine's shape no
 * longer matches what this harness expects.
 */
function truncateSource(raw) {
  if (!/^export\s/.test(raw)) {
    throw new Error('harness: expected workflows/ticketmill.js to start with "export " — source shape changed, update tests/harness.js')
  }
  const stripped = raw.replace(/^export\s+/, '')
  const markerIdx = stripped.indexOf(SPLIT_MARKER)
  if (markerIdx === -1) {
    throw new Error('harness: split marker "' + SPLIT_MARKER + '" not found in workflows/ticketmill.js — was the marker comment removed or reworded? Update it and tests/harness.js together.')
  }
  const anchorIdx = stripped.indexOf(SELECT_ANCHOR, markerIdx)
  if (anchorIdx === -1) {
    throw new Error('harness: could not find "' + SELECT_ANCHOR + '" after the split marker — engine source shape changed, update tests/harness.js')
  }
  return stripped.slice(0, anchorIdx)
}

/** Convenience: readEngineSource() + truncateSource() in one call. */
function loadTruncatedSource() {
  return truncateSource(readEngineSource())
}

/**
 * Build a fresh vm context pre-seeded with stubbed Workflow-tool globals.
 * `overrides.args` is merged over the {branch, repo} defaults (args.branch is
 * required — workflows/ticketmill.js throws at load time without it).
 * Individual globals (agent, parallel, pipeline, phase, log, budget) can be
 * overridden via `overrides` for tests that need custom behavior from the start;
 * most tests instead load with the defaults and call installScriptedAgent()
 * afterward to swap in a scripted agent().
 */
function createContext(overrides) {
  const o = overrides || {}
  const context = {
    agent: async function defaultAgentStub() { return null },
    parallel: async function defaultParallel(fns) { return Promise.all((fns || []).map(function (fn) { return fn() })) },
    pipeline: async function defaultPipeline(fns) {
      let result
      for (const fn of (fns || [])) result = await fn(result)
      return result
    },
    phase: function defaultPhase() {},
    log: function defaultLog() {},
    budget: { spent: function () { return 0 } },
    args: Object.assign({ branch: 'main', repo: 'aaddrick/ticketmill-fixture' }, o.args),
  }
  for (const key of ['agent', 'parallel', 'pipeline', 'phase', 'log', 'budget']) {
    if (Object.prototype.hasOwnProperty.call(o, key)) context[key] = o[key]
  }
  vm.createContext(context)
  return context
}

/**
 * Evaluate the truncated engine source in `context` (as produced by
 * createContext()). Pass `source` explicitly to run deliberately mutated source
 * (used by the teeth meta-test below); omit it to load the real, unmodified
 * engine declarations. Returns `context` for chaining.
 */
function loadEngine(context, source) {
  const code = source === undefined ? loadTruncatedSource() : source
  vm.runInContext(code, context, { filename: 'workflows/ticketmill.js (truncated)' })
  return context
}

/** createContext() + loadEngine() in one call — the common case for a test. */
function boot(overrides) {
  return loadEngine(createContext(overrides))
}

/**
 * Read a top-level `let`/`const` binding (or any expression) out of a context
 * that already had loadEngine() run against it. Works because every
 * vm.runInContext() call against the SAME contextified object shares one global
 * lexical environment (like multiple <script> tags sharing a page's top-level
 * `let`s) — so this sees whatever the engine's module-level bindings currently
 * hold, including after __seed() mutated them.
 */
function readGlobal(context, expr) {
  return vm.runInContext(expr, context)
}

/**
 * Shared ctx shape for helper/loop tests — mirrors processIssue()'s ctx object
 * literal in workflows/ticketmill.js (~line 1666) field for field:
 *   issue     - number, the GitHub issue number (scopeGuard/pushDecision stamp records with it)
 *   title     - string
 *   worktree  - string, absolute path to the issue's git worktree
 *   branch    - string, the issue's working branch
 *   pr        - number|null
 *   decisions - [] consumed by pushDecision()/decisionChain()/timeline()
 *   degrades  - [] (quality-loop degrade accounting; unused by most helper tests)
 *   deferred  - [] (unused by most helper tests)
 *   settled   - [] consumed by settleDecision()/settledBlock()
 *   notes     - [] consumed by collectNotes()/notesBlock()
 *   unresolved- [] (critical/major findings carried past a contrarian cap)
 *   approach  - string, evaluate's one-line approach summary
 *   members   - [{issue}] consolidation-unit member refs (deriveUnits() shape);
 *               defaults to a self-reference singleton [{issue: <this ctx's issue>}],
 *               matching processIssue()'s own default for a no-group run.
 *   groupId   - number|null, stable consolidation-group id; null outside a group
 *   metrics   - { approach_iters, plan_iters, tasks_done, tasks_failed,
 *                 task_review_attempts, quality_iters, quality_degrades,
 *                 test_iters, browser_iters, pr_review_iters } — all start at 0;
 *               loop tests assert against ctx.metrics.<field> after driving a
 *               loop, e.g. ctx.metrics.test_iters === MAX_TEST_ITERATIONS.
 *   tokens    - { total, byModel, tracked } — stage()'s token-tracking finally-block
 *               target; starts zeroed/untracked like the real ctx, so a stage()-driving
 *               test only needs to override `budget` to exercise the instrumentation.
 * Pass `overrides` to set any field (e.g. `{ issue: 42 }`); deep fields like
 * `metrics`/`tokens` are shallow-merged over the zeroed defaults.
 */
function makeCtx(overrides) {
  const o = overrides || {}
  const issue = ('issue' in o) ? o.issue : 1
  return Object.assign(
    {
      issue: issue,
      title: 'Fixture issue',
      worktree: '/tmp/ticketmill-fixture-worktree',
      branch: 'issue-1-fixture',
      pr: null,
      decisions: [],
      degrades: [],
      deferred: [],
      settled: [],
      notes: [],
      unresolved: [],
      approach: '',
      members: [{ issue: issue }],
      groupId: null,
      metrics: freshMetrics(),
      tokens: freshTokens(),
    },
    o,
    { metrics: Object.assign(freshMetrics(), o.metrics) },
    { tokens: Object.assign(freshTokens(), o.tokens) },
  )
}

/**
 * Swap `context.agent` for a scripted responder so tests can drive control flow
 * (retry loops, quality gates, the test loop) deterministically.
 *
 * `responder(prompt, opts, callNumber)` is invoked for every agent() call the
 * loaded engine code makes (callNumber is 1-based). Return:
 *   - a plain object matching the stage's schema shape -> stage() treats it as a
 *     live agent response (no retry).
 *   - null/undefined -> simulates a dead/failed agent call; stage() retries up to
 *     STAGE_TRIES times, then gives up (this is how you drive a real loop-cap test:
 *     have the responder return a "failed" shape forever and assert the loop stops
 *     at its MAX_* cap rather than looping forever).
 *   - throwing -> stage() catches it and logs, same retry behavior as null (unless
 *     the message matches /budget|token target|ceiling/i, which trips the
 *     circuit breaker instead — see tripStop() in the engine).
 *
 * opts.label is "<issue>:<stageKey>" (e.g. "1:test-run-i3") — the most reliable
 * way to branch behavior per call site; opts also carries opts.schema if a
 * responder wants to validate its own canned shape against it.
 *
 * The installed stub also exposes `.calls`, an array of every {prompt, opts} it
 * was invoked with, so tests can assert on call count / ordering / labels.
 */
function installScriptedAgent(context, responder) {
  const calls = []
  async function scriptedAgent(prompt, opts) {
    calls.push({ prompt: prompt, opts: opts })
    return responder(prompt, opts, calls.length)
  }
  scriptedAgent.calls = calls
  context.agent = scriptedAgent
  return scriptedAgent
}

module.exports = {
  ENGINE_PATH,
  SPLIT_MARKER,
  SELECT_ANCHOR,
  readEngineSource,
  truncateSource,
  loadTruncatedSource,
  createContext,
  loadEngine,
  boot,
  readGlobal,
  makeCtx,
  installScriptedAgent,
  freshMetrics,
  freshTokens,
}
