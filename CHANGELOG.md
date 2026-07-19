# Changelog

## 0.1.27 (2026-07-19)

- Set `serialize_globs` in this repo's own profile to the two engine copies
  (`workflows/ticketmill.js`, `.claude/workflows/ticketmill.js`). Lane
  scheduling (#1) predicts file overlap heuristically; this pins the known
  magnet so engine-touching issues are never raced even when prediction
  misses. Batch 2026-07-19-d demonstrated the failure mode: issues #1 and #2
  each landed ~1,000 lines in the engine ahead of #3, whose PR then needed
  manual conflict resolution.

## 0.1.26 (2026-07-19)

- Docs (#3, tech-docs stage): added an "Engine-owned path guardrail: three
  regimes" section to `docs/ARCHITECTURE.md`, covering the select-phase skip
  (regime a), deliberate engine work with a clean root (regime b), and the
  post-implement hard-revert gate for incidental changes (regime c), plus
  `scopeGuard()`'s advisory clause and the revert stage's override. Names the
  incident (nonconvexlabs-com#77) and the `profile.engine_owned_globs` /
  `profile.lockstep_installed_paths` fields. `skills/mill/SKILL.md` and
  `skills/mill-init/SKILL.md` already covered the user-facing side (task 4);
  this closes the design-decision record in ARCHITECTURE.md, which had no
  entry for the new machinery. No engine code changed.

## 0.1.25 (2026-07-19)

- Docs (#3, task 4 of 4): closed out the engine-owned path guardrail with doc
  notes in `skills/mill/SKILL.md` and `skills/mill-init/SKILL.md`. `mill` now
  explains why a config-changing issue needs a clean root tree before launch:
  the engine only sees committed state per worktree, so an uncommitted
  root-tree edit under an engine-owned path can get silently clobbered by a
  stale committed version. `mill-init` documents the
  `lockstep_installed_paths` profile field, the escape hatch that keeps this
  repo's own self-hosted `.claude/workflows/ticketmill.js` copy out of the
  post-implement hard-revert gate. No engine code changed; lockstep copy and
  full `test_command` suite reverified clean.

## 0.1.24 (2026-07-19)

- Fix (#3, task 3 quality fix): resolved a prompt self-contradiction flagged
  in quality review. `scopeGuard()`'s engine-owned advisory clause is
  prepended to EVERY stage prompt, including `runEngineOwnedGate`'s own
  `engine-owned-revert` stage — so the agent carrying out a regime (c)
  revert was told, one paragraph earlier in the same prompt, never to stage,
  commit, or restore those exact paths. The revert stage's prompt now opens
  with an explicit override line stating the guard clause does not apply to
  it ("this stage IS the deterministic guardrail acting on your behalf"),
  ahead of the checkout/commit/push instructions it excuses. Added a
  dedicated `tests/engine-owned.test.js` case asserting both the guard
  clause and the override are present, and that the override precedes the
  checkout instruction.

## 0.1.23 (2026-07-19)

- Engine-owned path guardrail, task-time backstop (#3, task 3 of 4): two
  layers now enforce regimes (b)/(c) of the three-regime model during
  implementation, on top of task 2's select-phase regime (a) skip.
  Layer 1 (advisory): `scopeGuard()` — prepended to EVERY stage prompt,
  unconditionally, not just at concurrency > 1 — appends a clause naming
  `ENGINE_OWNED` and instructing agents never to stage, commit, or restore
  those paths from git history for any reason, surfacing a discrepancy as a
  deferred note instead. Layer 2 (deterministic backstop): a new
  `runEngineOwnedGate(ctx)`, modeled on `runBrowserCheck`, runs right after
  the task/quality loop and BEFORE `runTestLoop` (so a revert this gate makes
  is re-validated by the SAME run's test suite / `lint-engine` byte-compare,
  in-band). A read-only probe lists this issue's changed files against the
  batch baseline; JS (never the agent) filters via `matchesGlobs` against
  `ENGINE_OWNED`, then routes on `ctx.engineOwnedIntentional` (now threaded
  onto `ctx` at `processIssue()` init from the `deriveUnits()`-shaped unit):
  regime (b) — this issue's own prose targets the set — leaves the
  implementation exactly as committed, no revert; regime (c) — it doesn't,
  but engine-owned paths showed up anyway — a single-purpose stage hard
  reverts ONLY the paths where `isHardRevertPath(f, ENGINE_OWNED,
  LOCKSTEP_INSTALLED_PATHS)` is true to the batch baseline, commits, and
  pushes, while lockstep-installed paths (e.g. this repo's own
  `.claude/workflows/ticketmill.js`) are left in place for the test loop's
  own lint-engine byte-compare to catch any divergence in-band. The gate
  never halts the run on its own — a dead probe or a failed/dead revert
  degrades to a recorded `ctx.deferred` follow-up instead of blocking an
  otherwise-green issue. Added `tests/engine-owned.test.js` coverage for
  `runEngineOwnedGate` across every regime and edge case, including a
  group-threaded non-primary deliberate member correctly NOT being reverted,
  and a lockstep path nested under an engine-owned directory glob being left
  in place alongside an exact-file lockstep path while sibling engine-owned
  paths still revert; extended `tests/scope-guard.test.js` for the new
  advisory clause. Task 4 (doc notes in `skills/mill/SKILL.md` and
  `skills/mill-init/SKILL.md`) remains.

## 0.1.22 (2026-07-19)

- Engine-owned path guardrail, select-phase skip (#3, task 2 of 4): the
  preflight probe now also reads each issue's `body` and runs
  `git -C ROOT status --porcelain` against the literalized engine-owned
  pathspec (`buildEngineOwnedPathspec`, computed once after the profile
  loads), returning any dirty paths as a new `root_dirty_engine_paths` field
  (both added to `PREFLIGHT_SCHEMA`). A JS pass right after the probe returns
  computes `engineOwnedIntentional` per issue (`engineOwnedHit` over
  title+body) and attaches it; `deriveUnits` OR-folds the flag across a
  group's live members (`memberRefs.some`) instead of inheriting only the
  primary's own flag, since `pickPrimary` picks a primary for group-identity
  reasons unrelated to intent. A deterministic pass between the preflight log
  and the consolidation gate — regime (a) of the three-regime model — flips
  `resume_point` to `skip` for any issue where `engineOwnedIntentional` is
  true AND `root_dirty_engine_paths` is non-empty, naming the dirty paths and
  the safe path in the reason; the existing skip branch, claim filter, and
  `reconcileGroups`/`deriveUnits` member-drop handle it from there with no
  new plumbing. Added `tests/engine-owned.test.js` coverage for
  `attachEngineOwnedIntentional` and `applyEngineOwnedRootDirtySkip` (all
  three regimes) plus an end-to-end test proving a flagged issue is excluded
  from both consolidation candidacy and the claim filter, and
  `tests/consolidation.test.js` coverage proving a group's
  `engineOwnedIntentional` is true even when the deliberate-engine member
  isn't the primary. Regime (b) (deliberate engine work, clean root — e.g.
  issue #3 itself) and the post-implement hard-revert gate (regime (c)) are
  task 3.

## 0.1.21 (2026-07-19)

- Engine-owned path guardrail, foundation (#3, task 1 of 4): added
  `ENGINE_OWNED_GLOBS` (`.claude/ticketmill.json`, `.claude/agents/**`,
  `.claude/workflows/ticketmill.js`, `.claude/scripts/ticketmill/**`) — paths
  a run must treat as read-only, extensible via a new optional
  `profile.engine_owned_globs` (`mergeEngineOwnedGlobs`). Added a new optional
  `profile.lockstep_installed_paths` (default `[]`) naming engine-owned paths
  that are a deliberate installed copy of a source-of-truth file elsewhere in
  the repo; this repo sets `[".claude/workflows/ticketmill.js"]`. Three pure
  helpers, unit-tested via `tests/engine-owned.test.js`:
  `engineOwnedHit(text, globs)` (case-sensitive substring hit against a
  literalized prefix, for detecting when an issue's prose plainly targets an
  engine-owned path), `buildEngineOwnedPathspec(globs)` (the same
  literalization built into a `git ... --` pathspec), and
  `isHardRevertPath(file, engineGlobs, lockstepPaths)` (file-level predicate
  built on the existing `matchesGlobs`, not a glob-string set difference, so a
  lockstep path nested under a directory glob is correctly exempted). Neither
  helper is wired into a gate yet — that's tasks 2 (select-phase skip) and 3
  (post-implement hard-revert) of #3.

## 0.1.20 (2026-07-19)

- Test quality fix for the merge auto-resolve harness coverage (#2): closed a
  green-by-omission gap where `aggregateMergeAutoResolve` (the run-level
  rollup that feeds the batch-PR body, the final agent report, and
  `resultsJson.merge_auto_resolve`) had zero test coverage despite having four
  distinct markdown branches. Added `tests/merge-auto-resolve-aggregate.test.js`
  covering all four (none / resolved-only / thrash-only / both) plus the
  missing-metrics and empty/null-input degrade paths, modeled on the sibling
  `aggregateTokens` coverage in `tests/token-usage.test.js`. Also added a new
  scenario to `tests/merge-auto-resolve.test.js` driving the full
  `reviewAndMerge()` for the case the code comment above the metric-bump line
  explicitly calls out but no test previously verified: `runMergeAutoResolve`
  resolves cleanly (rebase, forced green tests, force-push all succeed) but
  the merge stage's own subsequent preflight then blocks for an unrelated
  reason — asserting `ctx.metrics.merge_auto_resolved` stays at 0 in that
  case, not just when auto-resolve itself declines or aborts.

## 0.1.19 (2026-07-19)

- Merge stage auto-rebase and resolve for CONFLICTING PRs (#2). Previously any
  PR the preflight found `CONFLICTING` escalated straight to `needs_human`,
  even for mechanical conflicts like already-upstream sibling-issue commits or
  non-overlapping hunks. A new `runMergeAutoResolve(ctx)` runs immediately
  before the merge stage: it probes mergeability through a shared
  `mergeSettlePoll` helper (a verbatim bash backoff loop that tolerates
  GitHub's transient `mergeable: UNKNOWN` after a push rather than
  misreading it as blocked), and on `CONFLICTING` rebases the issue branch
  onto the batch branch's live tip in the still-open worktree. Any surviving
  hunks go to an implementer-persona conflict-resolver stage that prefers
  keeping both sides' changes and runs `git rebase --abort` rather than guess
  on a semantic conflict. A forced, skip-bypassing `runTestLoop` run on the
  exact rebased state is mandatory before anything is pushed — the test suite
  is the safety property, not the resolver's judgment. A thrash guard checks
  the batch branch didn't move again while tests ran and escalates (bumping
  `ctx.metrics.merge_thrash`) rather than replaying an unverified rebase, so
  only a state `runTestLoop` actually verified is ever force-pushed with
  `--force-with-lease`. Any rebase, resolver-abort, or test failure falls
  through to today's immediate `needs_human` escalation with the worktree
  preserved, unchanged. `ctx.metrics.merge_auto_resolved` increments only
  after a confirmed squash-merge on the auto-resolved state, and the Task
  Complete PR comment now notes when the merged diff diverged from the
  reviewed head. Run-level auto-resolution and thrash counts are rolled up by
  a new `aggregateMergeAutoResolve()` and surfaced in both the batch PR body
  and the run report's new "Merge Auto-Resolution" section. Gated on a real
  `test_command`: profiles with `test_command: null` still escalate
  immediately, since `runTestLoop` can't provide the mandatory-green
  safety net there. Covered by `tests/merge-auto-resolve.test.js` (6
  harness-driven `node:test` cases spanning the acceptance criteria,
  including the `UNKNOWN`-settle probe and a non-test-glob forced-run case).

## 0.1.18 (2026-07-19)

- Added a consolidation gate to Select (#14). It's an opus-tier judgment call,
  deliberately conservative: shared files alone are never sufficient reason. It
  proposes folding selected issues sharing a subsystem and acceptance surface
  (or an explicit dependency) into one worktree/branch/research/plan/PR. The
  proposal runs the same capped contrarian challenge pattern as the
  approach/plan gates, with one asymmetry: hitting the iteration cap dissolves
  the contested group back to independent issues rather than proceeding with
  caveats, since independent per-issue processing is always a safe fallback. A
  group's physical identity (worktree, branch, PR head) binds to a stable
  group id rather than the mutable "primary" issue, so a primary can re-anchor
  onto another live member after claims settle without moving anyone's
  worktree. Every unit of work above the harness split is layered on top of the
  existing per-issue path (`ctx.members = [ctx.issue]` for a singleton), so a
  no-overlap run with zero proposed groups is byte-for-byte unchanged. A failed
  group counts as one circuit-breaker increment; every member's claim releases
  and gets its own resume comment naming the group and failing stage; resuming
  re-proposes the same group from that comment's marker instead of reprocessing
  members individually. Disable via the new `profile.consolidation: false` flag.
  See docs/ARCHITECTURE.md's "Consolidation gate" and "Failure semantics"
  entries for the full design rationale.

## 0.1.17 (2026-07-19)

- Test quality fix (#11): the previous test pass only exercised the pure
  `aggregateTokens()` helper — the half of #11 that does the actual token
  attribution, `stage()`'s tokensBefore/tokensAfter instrumentation and the
  guarded `spentTokens()` wrapper it depends on, had no direct coverage, and
  `tests/harness.js`'s `makeCtx()` fixture had no `tokens` field, so every
  existing `stage()`-driving test silently no-opped through the new branch.
  Added `tests/token-tracking.test.js`: seven tests drive `spentTokens()`
  directly across all its guard branches (budget missing, `.spent` not a
  function, `.spent()` throwing, and non-finite/non-numeric returns), and
  eight more call `context.stage(...)` directly with a scripted, stateful
  `budget.spent()` to prove the delta math end-to-end — the `Math.max(0, ...)`
  clamp on a backwards-moving counter, one before/after sample spanning the
  whole retry loop (not one per attempt), `byModel` accumulation across
  multiple calls to the same model, the no-model and no-`ctx.tokens` no-ops,
  and a permanently-throwing `budget.spent()` never affecting `stage()`'s
  return value. `tests/harness.js`'s `makeCtx()` now defaults `ctx.tokens` to
  the same zeroed/untracked shape `processIssue()` builds, closing the
  fixture gap for future stage()-driving tests too.

## 0.1.16 (2026-07-19)

- Fixed `aggregateTokens()` (#11 quality review) so `resultsJson.tokens.run_total`
  never disagrees with the "## Token Usage" markdown it ships alongside. When
  `budget.spent()` is unavailable but a stage delta was still tracked,
  `run_total` used to fall back to the summed deltas — a real number — while
  the markdown unconditionally said "Run total: not tracked". `run_total` is
  now `null` in that case too, matching the prose. Added a regression test in
  `tests/token-usage.test.js`.

## 0.1.15 (2026-07-19)

- Added per-run token tracking (#11). `stage()` samples the runtime's guarded
  `budget.spent()` before and after each retry loop, attributing the delta to
  `ctx.tokens.total` and `ctx.tokens.byModel[opts.model]` with no wall-clock
  dependency and no effect on retry/STOP control flow. A new pure
  `aggregateTokens(results, spent, concurrency)` helper turns those per-issue
  deltas into a "## Token Usage" section: at concurrency 1 an
  "orchestration/unattributed" remainder row makes the table reconcile
  exactly to the run's `budget.spent()` total; at concurrency above 1 the
  whole breakdown is labelled approximate, since a single shared monotonic
  counter can't be split across overlapping concurrent stages. Surfaced in
  the batch PR body, the run report JSON/markdown, and per-issue PR bodies
  (subtotal only). Tokens only — no currency or per-token price anywhere, and
  a missing/unavailable counter renders "not tracked" rather than a false
  zero. Added `tests/token-usage.test.js` covering both reconciliation modes
  and the "not tracked" degrade path via the harness.

## 0.1.14 (2026-07-19)

- Forged `.claude/agents/ticketmill-doc-writer.md` and staffed the profile's
  `doc_writer` role with it. The agent distills the maintainer's voice rules
  (position-first structure, FK 6-8 readability, short-long sentence rhythm)
  and an AI-tell scrub list directly into the file, so the engine's tech-docs
  stage produces prose in the house voice on any machine, with no dependency
  on user-level agents.
- Widened `simplify_globs` with `tests/**/*.js` and `tests/**/*.sh`. The
  first batch run skipped every simplify pass with "no in-scope files in
  change" because the work landed in `tests/`, which the globs didn't cover.

## 0.1.13 (2026-07-19)

- Added `.github/workflows/ci.yml`: runs the profile's `test_command` on
  every pull request (no branch filter) and on pushes to `main`, on
  `ubuntu-latest` with Node 22. `permissions: contents: read` only — no
  secrets, no `gh` auth, no `GITHUB_TOKEN` beyond checkout's default. The
  run step extracts the command via
  `jq -r '.test_command // ""' .claude/ticketmill.json` and executes it
  with `bash -c`, so the command itself is never restated in the YAML —
  `.claude/ticketmill.json` stays the single source of truth. An empty
  `test_command` prints a `::notice::` and exits 0 instead of failing. A
  syntax error anywhere in the profile's test chain (engine, scripts,
  manifests, unit/bash suites) now turns this check red on the PR.

## 0.1.12 (2026-07-19)

- Added `scripts/lint-engine.js`, a zero-dependency sandbox-rule lint for
  `workflows/ticketmill.js`. The Workflow tool sandbox forbids `Date.now()`,
  `Math.random()`, argless `new Date()`, and any filesystem/Node API
  (`require`/`import`) — all legal JavaScript, so `node --check` passes on
  them, but they throw at runtime or silently break resume. The lint does a
  dumb, loud, line-by-line text scan for those constructs and prints
  `file:line: message` on any hit, skipping pure-comment lines (the engine's
  own doc comments legitimately name these APIs) and any line carrying the
  literal `// sandbox-ok` marker, the only escape hatch (no weaker
  pattern-based exceptions).
- The same script also fails if `.claude/workflows/ticketmill.js` is not
  byte-identical to `workflows/ticketmill.js` — the two are supposed to be
  the same engine, and drift means one copy was edited without the other.
  Wired `node scripts/lint-engine.js` into `test_command` in
  `.claude/ticketmill.json` immediately after `node --check`, and reinforced
  the lockstep-edit rule in `verify_notes`.
- Forward-synced `.claude/workflows/ticketmill.js` from `workflows/
  ticketmill.js` as part of landing this lint: the `.claude` copy had drifted
  27 lines behind (missing the `sanitizeTasks` lift-to-top-level refactor and
  the `__seed` test-harness hook from issues #4/#5's already-stacked work,
  which landed only in `workflows/`). This commit's diff to the `.claude`
  copy is therefore mostly that non-lint catch-up churn, not new lint logic.
- Added `tests/sandbox-lint.test.js`: for each forbidden construct, seeds it
  into a throwaway sandbox copy of the engine and runs the lint as a child
  process, asserting a non-zero exit and the correct `file:line` in the
  output; asserts the real engine lints clean; and asserts the byte-compare
  sync check passes when the two engine copies match and fails (reporting
  `.claude/workflows/ticketmill.js:1:`) when they differ.

## 0.1.11 (2026-07-19)

- Added `tests/setup-worktree.test.sh`, a self-contained plain-bash suite for
  `scripts/setup-worktree.sh` (no bats, no global installs). Each of its five
  cases builds a fresh scratch git repo plus an offline local bare `origin`
  seeded with the base branch, and stubs `gh` on `PATH` so the script runs
  with no network and no `gh` auth: fresh branch/worktree creation with valid
  JSON stdout, idempotent reuse of an `issue-<N>-*` branch even when the
  upstream title changes (a pre-planted sentinel file proves the worktree
  isn't destroyed), stale-worktree replacement when the checked-out branch
  doesn't match the prefix, a missing-args usage error, and an unfetchable
  base-branch error — the last two assert a non-zero exit plus the JSON error
  shape. Also runs `shellcheck` on the script when available.
- Fixed a real contract bug the new suite caught: `git branch <name>
  origin/<base>` in `scripts/setup-worktree.sh` was unredirected and leaked a
  "set up to track ..." line onto stdout on every fresh-branch path,
  corrupting the JSON-on-stdout contract the engine parses. Redirected it to
  match the adjacent `worktree add` call.
- Wired `&& bash tests/setup-worktree.test.sh` onto the profile's
  `test_command` in `.claude/ticketmill.json`, appended after the existing
  `node --test` entry — a `.test.sh` file is invisible to `node --test`'s
  `tests/*.test.js` discovery, so both suites run and neither shadows the
  other.

## 0.1.10 (2026-07-19)

- Wired `node --test` into the profile's `test_command`, after the existing
  `node --check` / `bash -n` / manifest-JSON smoke checks — the 33-test suite
  added in issue #4 (`tests/`: a truncate-and-evaluate vm harness plus unit
  tests for `sanitizeTasks`, `scopeGuard`, the decision/settled/notes ledger
  helpers, `timeline`, `pickFixAgent`, `globToRe`/`matchesGlobs`, and the test
  loop's `MAX_TEST_ITERATIONS` cap) now gates every mill run instead of just
  syntax checks.
- Confirmed the gate has teeth two ways: the repeatable `tests/harness.test.js`
  meta-test (mutates the stub-task guard in memory and asserts the resulting
  unit-test assertion fails), and a one-time hand check that reverting a
  covered helper on disk turns `node --test` red (3/33 failing), then cleanly
  reverting it back to green.
- `test_command` uses bare `node --test` (auto-discovers `tests/*.test.js`),
  not `node --test tests/` — the directory-argument form throws
  `MODULE_NOT_FOUND` on Node 22.22.0.

## 0.1.9 (2026-07-19)

- Onboarded this repo for its own mill runs (dogfooding): `.claude/ticketmill.json`
  profile, forged implementer / code-reviewer / test-validator agents, contrarian
  copied into the project roster, engine + setup script copied to `.claude/`.
- The profile's test_command is a syntax/manifest smoke check for now; issues
  #4-#7 build the real test engine via ticketmill itself.

## 0.1.8 (2026-07-18)

- README: the Quickstart dry-run example is a plain request now, no longer a
  Workflow call. The mill skill takes "dry run" in natural language.
- README: Run options now suggests a small skill invoking /ticketmill:mill for
  standing preferences, instead of restating options every run.

## 0.1.7 (2026-07-18)

- README: new Follow-up issues section on the one place the engine files new
  issues (successful merges), what feeds them, and how they are labeled and
  deduplicated.
- ARCHITECTURE: rebuilt the pipeline diagram. Quoted labels with `<br/>` breaks
  instead of `\n` (fixes clipped boxes), phase rows stacked left-to-right
  instead of one tall chain, explicit challenge/fix loop edges with caps, and a
  dashed learnings edge into the next run. Render-checked in a browser.

## 0.1.6 (2026-07-18)

- README: added an Author section above the license, with GitHub and LinkedIn
  links.

## 0.1.5 (2026-07-18)

- README: new Run options section documenting every workflow arg and its
  default, plus what `concurrency` does and does not parallelize.
- README: new Watching a run section on the issue comment trail, the PR
  review rounds, the logs dir outputs, and live progress via /workflows.
- README: new Overlapping batches section explaining the claim protocol when
  maintainers start batches with overlapping issue lists. The Cross-run claims
  bullet now points there.
- README: new Resuming an interrupted run section covering both resume paths,
  finding the batch branch after a dead session, and the usage-limit breaker.
  The Resumable everywhere bullet now points there.

## 0.1.4 (2026-07-18)

- README: "How agents work" now describes init-time role staffing. mill-init
  maps existing agents by their descriptions without force-fitting, resolves the
  contrarian role from the bundled template, and offers forge-agent inline for
  each remaining gap. A forged agent updates the role map itself.
- README: the Quickstart mill-init comment says "agent staffing" instead of
  "role map".

## 0.1.3 (2026-07-18)

- README: expanded the one-line requirements note into a full Requirements
  section (Workflow tool, authenticated `gh` with repo write access, git
  worktrees, GitHub remote, verified profile, locally runnable toolchain,
  optional browser MCP).
- README: documented all ten `roles` profile keys in a table, with each role's
  pipeline responsibility drawn from the engine's built-in charters, and
  clarified when a fallback charter is a Verification Gap (missing agent file)
  versus not (role explicitly `null`).

## 0.1.2 (2026-07-18)

- The bundled contrarian template is now the verbatim canonical agent from
  https://github.com/aaddrick/contrarian (dropped the 0.1.1 evidence-discipline
  addition; the engine's gate prompts already carry verify-before-asserting
  instructions, so the agent file stays true to its source).

## 0.1.1 (2026-07-18)

- Bundle a contrarian agent template (`templates/agents/contrarian.md`) with an
  evidence-discipline section. mill-init now resolves the contrarian role by
  copying: project copy if present, else the user's `~/.claude/agents/contrarian.md`,
  else the bundled template. forge-agent remains the optional
  project-grounding upgrade.

## 0.1.0 (2026-07-18)

Initial release.

- Engine (`workflows/ticketmill.js`): stack-agnostic port of the flyspacea
  batch-issues workflow. Profile-driven toolchain (`.claude/ticketmill.json`),
  role-based agent staffing from the target repo's `.claude/agents/`, explicit
  test-gate decisions, Verification Gaps surfaced on the batch PR, opt-in browser
  verification, claims interop with the ancestor engine.
- Skills: `mill` (launch, with Workflow-tool hard-stop), `mill-init` (onboarding
  with doctor pass and role mapping), `forge-agent` (project-grounded agent
  generation).
- `scripts/setup-worktree.sh`: deterministic worktree creation; prefix-based
  branch reuse, submodule init, no language-specific installs.
- Plugin packaged as its own single-plugin marketplace.
