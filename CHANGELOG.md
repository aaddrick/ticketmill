# Changelog

## 0.1.36 (2026-07-26)

Documentation only. No engine, skill, or profile behavior changes.

The pipeline diagram in `docs/ARCHITECTURE.md` was one mermaid flowchart
holding roughly thirty nodes across five nested subgraphs. Mermaid's dagre
renderer handles chained subgraphs with per-subgraph `direction` overrides
badly, and the result was dense enough that nobody read it.

- `docs/diagrams/` (new): the pipeline redrawn as six [D2](https://d2lang.com)
  diagrams — one overview plus one per phase (Select, Plan, Build, Ship,
  Report). Each renders to a committed light/dark SVG pair, paired in the doc
  through a `<picture>` element so it follows the reader's GitHub theme. Two
  themes rather than one because d2 inlines custom fills instead of emitting
  them into its `prefers-color-scheme` block, so a single SVG cannot carry
  both palettes.
- `docs/diagrams/render.sh` (new): regenerates every SVG. The `.d2` sources
  are the source of truth; the SVGs are generated and committed so reading the
  docs needs no toolchain.
- `docs/diagrams/CLAUDE.md`, `docs/diagrams/AGENTS.md` (new): byte-identical
  guidance for anyone editing these files — theme contract, the width budget
  that keeps text legible in GitHub's ~1012px column, and the layout
  constraints found the hard way (nested container `direction` is ignored by
  both bundled engines; `|md|` labels render as `foreignObject` and do not
  survive an `<img>` embed).
- `docs/ARCHITECTURE.md`: `## Pipeline` now carries the overview, a legend for
  the shared shape and color vocabulary, and a per-phase section.
- `.claude/agents/ticketmill-code-reviewer.md`: the docs-drift rule named "the
  mermaid-diagrammed flow"; it now points at the D2 sources and requires
  `render.sh` to be re-run in the same commit as a stage-order change.
- `README.md`: repo layout line mentions `docs/diagrams/`.

## 0.1.35 (2026-07-25)

Fifteen milled issues, batched as maintenance and hardening across the
engine, outcome grading, the profile, and the docs. Patch bump
(0.1.34 -> 0.1.35). Every change is a correctness fix, a re-activated
opt-in, or tighter test coverage. None of it adds a new stage or a
user-facing feature.

Engine correctness and hardening:

- `workflows/ticketmill.js` (#62): `isBudgetExhaustedError` now matches
  a real exhaustion signature instead of a bare `token` noun. Auth and
  rate-limit errors that happen to carry the word "token" stop
  false-positiving as budget exhaustion. Covered by
  `tests/budget-exhaustion.test.js`; rationale in `docs/ARCHITECTURE.md`.
- `workflows/ticketmill.js` (#65): `aggregateTokens` no longer labels a
  stage-only-attributed breakdown as approximate at concurrency > 1. The
  `reconciles` flag reads true when the split is actually exact.
  `tests/token-usage.test.js`, with the reasoning in
  `docs/ARCHITECTURE.md`.
- `workflows/ticketmill.js` (#69): `bwPort` coerces `port_span` to a
  positive integer, the same coercion `stale_seconds` and `poll_seconds`
  already had. A string value in the browser profile can't skew the port
  math anymore. `tests/browser-profile-keys.test.js`.
- `workflows/ticketmill.js` (#79): a Layer 2 post-hoc check now validates
  the commit SHAs agents post in their reports. An agent claims a SHA;
  the engine confirms it against the real commit after the fact.
  `tests/commit-sha-probe.test.js`, `tests/pr-review-gate.test.js`, and
  `docs/ARCHITECTURE.md`.

Outcome grading and token analytics:

- `workflows/ticketmill.js` (#103): a closed issue now threads through to
  the `abandoned` observation field in outcome grading. A
  closed-unmerged target grades as abandoned rather than getting dropped.
  `tests/outcomes.test.js`, `docs/ARCHITECTURE.md`.
- `workflows/ticketmill.js` (#104): outcome grading v2 brings back the
  `later_batch_fix` signal. It fires on an issue cross-reference or
  region churn. Bare file overlap no longer counts, so two issues
  touching the same file don't read as one fixing the other.
  `tests/outcomes.test.js`, `docs/ARCHITECTURE.md`.
- `workflows/ticketmill.js` (#111): `reconcile_error` is re-scoped to a
  per-issue pool. That closes the attribution gap that made efficiency
  analytics read as suppressed when the numbers were fine.
  `tests/token-reconcile.test.js`, `docs/ARCHITECTURE.md`.
- `workflows/ticketmill.js` (#113): the lane predictor stops
  over-predicting the engine cluster for "add a skill / doc" issues. Doc
  and skill work now lands in its own lane instead of the engine one.
  `tests/lane-predict-shape-gate.test.js`, `docs/ARCHITECTURE.md`.

Profile, agents, and docs:

- `.claude/ticketmill.json` (#67): the LOCKSTEP-EDIT RULE note now tells
  agents to run `node scripts/lint-engine.js --fix` instead of the manual
  `cp workflows/ticketmill.js .claude/workflows/ticketmill.js`, matching
  the wording already in `docs/ARCHITECTURE.md`. Text-only change; no
  engine behavior, lockstep enforcement, or lint logic is affected.
- `.claude/ticketmill.json` (#83, #112): the `release` stage opt-in is
  re-activated in ticketmill's own profile. It fires on the next
  self-mill run. This batch doesn't trigger it. `docs/ARCHITECTURE.md`.
- `.claude/agents/ticketmill-implementer.md`,
  `.claude/agents/ticketmill-code-reviewer.md` (#82): both charters now
  read release discipline as batch-level rather than per-issue, so an
  implementer doesn't try to cut a release per merged issue.
  `docs/ARCHITECTURE.md`.
- `README.md`, `skills/mill-init/SKILL.md` (#70): both now spell out that
  `profile.browser.artifact_dir` is deleted with `rm -rf` on cleanup. A
  mis-pointed base path is a footgun, so the caution is explicit in
  `workflows/ticketmill.js` and the user-facing docs.

Test coverage:

- `tests/run-record.test.js` (#85): a regression test pins run-report
  `by_issue` entries so later issues in a large batch keep their `pr`,
  `follow_ups`, and `timeline` fields.
- `tests/harness.js` (#115): a first-class `assertVmEqual` helper covers
  the cross-vm-context assertion gotcha. `tests/gate-findings.test.js`
  uses it in place of the ad-hoc comparison it had before.

## 0.1.34 (2026-07-25)

Tier 4 of the observability upgrade, one milled issue (#94): the
mill-review skill and a cross-run trend dashboard. Patch bump
(0.1.33 -> 0.1.34). This is the human-facing analyze step of the
flywheel, a read-only report over everything the earlier tiers
accumulate.

- New `skills/mill-review/SKILL.md` (#94) mapping to
  `/ticketmill:mill-review`, a read-only skill that makes no repo
  changes. It takes an optional window arg (last N runs or a date
  range) and reads `logs/ticketmill/runs.jsonl`, `outcomes.jsonl`,
  the per-run `runs/<tag>.json` records, and
  `process-retrospective.md`.
- Reuses the Tier 2 reducers (#94): `computeFriction` and
  `computeChurn` run over the ledger rather than reimplementing the
  math. The skill is a thin read-analyze-present wrapper, so there's
  one source of truth for the numbers.
- Highlights report (#94): an outcome scorecard (the fraction of
  each run's PRs that held up versus hotfixed, reverted, or
  reopened, from the #92 outcome ledger); per-stage friction,
  rework-tax, gate-yield, lane precision, and token cost/issue
  trends, each point tagged with its completeness score; chronic
  bumpy stages, churn hotspots and re-fix chains, an
  agent-attribution summary, stale or contradicted learnings, and a
  ranked "what I'd change next."
- Output surfaces (#94): prints the highlights inline and renders a
  trend dashboard as a self-contained HTML Artifact (charts via the
  dataviz skill). A committed `logs/ticketmill/dashboard.md`
  fallback covers sessions without Artifacts.
- Trend guardrails (#94): every trend chart gates on a minimum run
  count and carries an issue-class heterogeneity caveat. A doc-heavy
  batch and an architecture-heavy batch aren't comparable on raw
  friction. Below the threshold the skill shows per-run summaries
  only, not trend lines. Validated via the writing-skills skill;
  prose ran through the aaddrick-voice + removing-ai-tells process.

## 0.1.33 (2026-07-25)

Tier 3 of the observability upgrade, one milled issue (#93): a
preflight revisit risk-flag. Patch bump (0.1.32 -> 0.1.33). This
closes the forward-looking side of the production-feedback gap. A
run can now react when an area it's about to touch has a bad recent
track record. Depends on the outcome ledger (#92) and Tier 1 churn
data.

- Read-only Select-phase agent (#93): a dedicated `agent()` probe
  fires concurrently beside `learnPromise` and `outcomeGradePromise`
  so its latency hides behind the existing preflight probes. For
  each issue's predicted files, it checks whether recent ticketmill
  PRs touched the same area and were later reverted, hot-fixed, or
  reopened. It reads `outcomes.jsonl` (#92), the `runs.jsonl` churn
  history, and live `gh pr view --json files`, and returns raw
  observations only. The engine decides the flag post-hoc in
  deterministic JS, per the same sandbox split as #92.
- New module const `REVISIT_RISK = { window_days: 30 }` (#93), a
  30-day lookback beside `OUTCOME_GRADING`, plus a
  `REVISIT_RISK_SCHEMA`. The pure reducers `deriveNegativeOutcomeEvents`/
  `attachRevisitFiles`/`computeRevisitRisk` derive the flag, and
  `unionRevisitRisk` combines risk across a consolidated group's
  member issues.
- Risk-flag rendering (#93): the resulting `revisit_risk` threads
  through the unit rails (`deriveUnits`) and renders as a risk-flag
  block into the approach and plan prompts. Example: "this area was
  re-fixed twice in the last 30 days and the earlier fix regressed:
  prefer a conservative approach and add regression coverage." When
  no predicted file matches a recently-reverted or hot-fixed area,
  the probe is a clean no-op and no flag appears.
- Tests (#93): `computeRevisitRisk` cases added to
  `tests/outcomes.test.js` — a matching-history case that raises the
  flag and a no-history case that stays silent. Full suite 504
  `node --test` cases green; engine copies byte-identical
  (lockstep-linted).

## 0.1.32 (2026-07-25)

Tier 2b of the observability upgrade, milled as one batch of four
issues (#89, #91, #92, #97): per-run friction and churn surfaced in
the batch PR, two efficiency and quality reducers, an outcome-grading
eval anchor, and a proactive token cost governor. Patch bump
(0.1.31 -> 0.1.32). The batch spanned an initial run and a
server-error resume; the merged run record notes the split.

Per-run friction and churn (#89), surfaced in the batch-PR body where
a human already reviews. This-run only: at current data volume
cross-run trends mislead (Simpson's paradox), so trends are deferred
to a later mill-review skill behind a run-count gate.

- `computeFriction(results)` (#89): per issue and per stage, a
  normalized score weighting iteration-vs-cap ratios,
  `quality_degrades`, `test_quality_fix_rounds`, contrarian cap-outs
  (unresolved and carried forward), `merge_thrash`, and
  `needs_human`. Ranks the bumpiest stages and issues this run.
- `computeChurn(results, {serializeGlobs, engineOwned})` (#89):
  within-run churn read from the retained `changed_files` and
  `touch_counts` (#87): files touched by many issues in the batch,
  plus re-fix chains. Buckets by `serialize_globs` and engine-owned
  paths so expected-hot files stay separate from surprising ones.
- `composeFrictionChurn(...)` (#89): folds both into a `## Friction
  & Churn` section rendered next to `## Verification Gaps` in the
  batch-PR body. Renders when there is signal, omits cleanly when
  there isn't.
- Tests (#89): `tests/friction.test.js`, `tests/churn.test.js`, and
  `tests/compose-friction-churn.test.js` cover a synthetic re-fix
  chain and the hotspot threshold.

Two efficiency and quality reducers (#91), pure JS, surfaced per run.

- `computeReworkTax(results)` (#91): the fraction of tokens spent in
  fix and retry loops (quality-fix, test-fix, test-quality-fix,
  pr-fix, merge-conflict-resolve) versus first-pass work, per issue
  and per run. Classifies and sums per-stage token deltas, which
  required a `byStage:{}` accumulator on the `ctx.tokens` init. Gated
  on #90 reconciliation: output is suppressed or explicitly scoped
  when the run's tokens don't reconcile, so no efficiency headline
  lands on untrustworthy data.
- `computeGateYield(results)` (#91): per contrarian gate, findings
  raised, an accepted-vs-dismissed ratio, and an escaped-defect
  signal (a finding raised late at PR review that the earlier
  approach and plan gates missed). Consumes the `gate_findings` tally
  from #87. The ratio folds only literal accepted and dismissed
  dispositions; carried-unresolved and re-litigated count toward the
  gate total but not the ratio.
- Tests (#91): `tests/rework-tax.test.js` pins a known rework
  fraction and `tests/gate-yield.test.js` covers the escaped-defect
  case.

Outcome grading (#92): back-annotating merged PRs into an outcome
ledger. Nearly all of ticketmill's signal to date is process friction
(Tier 1/2a), not outcome quality, so friction-driven self-improvement
is Goodhart-able: a run can look clean by every process metric while
shipping a PR that gets reverted the next day. This adds a read-only
pass that resolves what actually happened to a prior run's merged PRs
and records it, so later tiers have an eval anchor.

- Pure grading core (#92): `gradeFromObservation`/`buildOutcomeLine`/
  `diffOutcomeGrades`/`summarizeOutcomeCoverage`, added above the
  `TICKETMILL-TEST-HARNESS-SPLIT` marker alongside the existing
  `buildRunRecord`/`buildLedgerLine` pair. Grades are asymmetric on
  age: negative signals (reverted, reopened, hotfixed) grade
  immediately at any age, while a clean grade is gated behind
  `OUTCOME_GRADING.min_age_days` (default 7, overridable via
  `profile.outcome_grading`) so a PR isn't declared clean before it's
  had time to fail. `closed_unmerged`/`abandoned` are a terminal
  escape hatch for targets that can never reach clean. Rows are keyed
  by `run_tag`+`batch_pr`+`issue` (one per member issue) and stamped
  `schema_version: 1`. 30 new unit tests (`tests/outcomes.test.js`).
- Read-only Select-phase agent (#92): `outcomeGradePromise` fires
  alongside `learnPromise` so its latency hides behind the existing
  preflight probes. Per the fs/git/gh-free sandbox, the agent does
  target discovery in-prompt (walks the run-history ledger, expands
  member issues, skips already-terminally-graded targets, bounded by
  `sample_cap`) and live `gh pr view`/`gh issue view`/`gh search`
  reads, returning raw observations plus the verbatim prior ledger
  lines only — never a grade decision. The engine grades post-hoc in
  deterministic JS and adds `outcomes`/`outcomes_path`/
  `outcomes_coverage` to the final return, next to `record`/`ledger`.
- Deterministic ledger write (#92): `skills/mill/SKILL.md` seeds
  `<logs_dir>/outcomes.jsonl` if absent and appends each returned
  outcome as one compact JSON line, in run order. Append-only, like
  the `runs.jsonl` step beside it — the skill never rewrites, dedups,
  or drops a line; `diffOutcomeGrades` already decided what to emit.
  `outcomes.jsonl` is a per-host, gitignored local artifact.

Proactive token cost estimator and budget guard (#97), so ticketmill
can stop before the account ceiling instead of after. Depends on the
`runs.jsonl` ledger (#86) and pairs with the rework-tax reducer
(#91). Before this, the only budget guards were reactive — the
3-consecutive-death circuit breaker and the budget-exhausted-error
trip — which only fire after the account limit is already killing
agents. This adds a pre-run estimate and an always-on hard-floor
guard that halt cleanly before spend gets that far.

- Ledger schema foundation (#97): `buildRunRecord`/`buildLedgerLine`
  gain a compact `by_issue_shape` block (`{issue, pf, tokens, tracked,
  member_count}` per issue, joined from units + `tokenAgg.by_issue` at
  record-build time) and `effective_concurrency` (`min(CONCURRENCY,
  lanes.length)`), so trusted single-lane runs are attributable even
  when the run-level `CONCURRENCY` arg says otherwise.
  `schema_version` 1 -> 2.
- Pure `estimateCost(history, issues)` reducer (#97): flattens only
  trusted `by_issue_shape` rows (`effective_concurrency===1`,
  `member_count===1`, parent-run `reconcile_error` under a coarse
  admission bar) into per-predicted-files-band medians, and degrades
  honestly to `{estimate:null, confidence:'insufficient'}` on thin or
  high-error history rather than guessing. Group units estimate as the
  sum of each member's own band estimate, poisoned to `null` by any
  unknown member.
- `cost_estimate` on the `dry_run` preview (#97): per-issue
  estimate+confidence, three independent oversized flags (structural
  group size, predicted-files-band ceiling, multiple-of-global-median),
  and a batch projection that never reports a bare total when any
  member is unknown — it always carries an "estimable K of N, M
  unknown" coverage note.
- Always-on `token_budget` guard (#97): resolved from a run arg or
  `profile.token_budget`, as an absolute OUTPUT-token ceiling or a
  relative `"Nx"`-of-median form. A hard floor
  (`spentTokens()>=budget`) trips a distinct `budget_halt` state with
  its own `resume_hint` at any concurrency, with an estimate-aware
  pre-check layered on top so a run can stop before starting an
  oversized issue, not just after. Kept separate from the existing
  death-signature circuit breaker.
- `skills/mill/SKILL.md` (#97): reads `runs.jsonl` and passes it as
  `args.history` on every invocation (live and `dry_run`), and
  documents `token_budget`'s two forms and the `cost_estimate` preview
  fields for the skill to relay.

Engine copies stay byte-identical (lockstep-linted). Full
test_command green: 475 `node --test` cases + 32
`setup-worktree.test.sh` cases.

## 0.1.31 (2026-07-25)

Tier 2a of the observability upgrade: the data-enrichment foundation
the per-run analytics tiers build on. One issue (#87). Patch bump by
choice (0.1.30 -> 0.1.31). The per-issue `ctx` object gathered rich
friction data during a run but dropped several signals and never kept
the actual list of files an issue changed, so "which files got
revisited" couldn't be computed. This enriches `ctx` in pure JS, with
no new agent calls beyond reusing the engine-owned diff probe.

- Changed files retained (#87): the engine-owned diff probe
  (`probeChangedFiles`) now runs once post-implement for every issue
  and stores `changed_files`/`added_files` on `ctx`. Before, the probe
  was gated on engine-owned globs and its result was discarded, so the
  file list an issue touched never survived past the implement stage.
- Within-issue re-touch tally (#87): `tallyTouches` derives
  `touch_counts` from the fix-stage `files_changed` fields, counting
  how many times each file was revisited inside a single issue. A file
  touched three times signals churn a merged diff alone hides.
- Derived friction fields (#87): `frictionFields` adds
  `contrarian_capped` (a contrarian gate hit its iteration cap with
  unresolved caveats), `test_quality_fix_rounds`, `needs_human`, and
  `unresolved_count`. These roll scattered per-stage state into flat
  fields a trend query can read without walking the run tree.
- Gate findings tally (#87): `recordGateOutcome` writes `gate_findings`
  per contrarian gate: a count plus severity mix and disposition
  (accepted / dismissed / carried-unresolved), reusing the
  settled-decisions ledger. Scoped to the two per-issue contrarian
  gates (approach, plan). The review/task gates don't carry a
  severity-tagged findings array, so a severity mix can't be honestly
  derived for them.
- Per-run completeness block (#87): `computeCompleteness` records
  whether every issue's `metrics` landed, whether tokens reconciled,
  and whether `changed_files` was captured for each merged issue.
  Downstream trends carry a trust flag off this. It distinguishes an
  issue skipped by design from one that failed, since both lack a
  `metrics` key.

Every new field is threaded through all three result returns
(completed / failure / skip). 31 new reducer tests run over fixture
`ctx` objects. Engine copies stay byte-identical (lockstep-linted).

## 0.1.30 (2026-07-25)

Tier 1 of the observability and self-improvement upgrade: the foundation the
later tiers build on. Three issues. The bump stays a patch by choice
(0.1.29 -> 0.1.30) even though this tier is load-bearing. The rest of the
upgrade lands across later batches.

- Telemetry truncation (#86): the Report phase used to hand the run's JSON to
  the report agent as `resultsJson.slice(0, 30000)`, so the engine truncated
  the payload in plain JS before any agent ever saw it. An 8-issue run already
  serialized past 24,000 chars. 18-issue runs overflowed, and every per-issue
  `metrics` block after the cut never reached disk. The committed
  `summary-2026-07-19-f.json` proves it: 18 results, zero metrics blocks. The
  fix is a pure `buildRunRecord()`/`buildLedgerLine()` pair above the harness
  split, unit-tested for zero field loss at 100-issue scale. The report agent
  now writes only the human `summary-<tag>.md`. The workflow return carries
  `record`, `ledger`, `run_tag`, and `logs_dir`, so the `mill` skill persists
  the full machine record to `<logs_dir>/runs/<run_tag>.json` with a
  deterministic `Write` outside the sandbox, plus a one-line append to
  `<logs_dir>/runs.jsonl`, the cross-run ledger. The record bytes never pass
  through a model. The old `summary-<tag>.json` is no longer written: nothing
  consumed it.

- Learning injection (#88): `learn()`, the retrospective digest injector, now
  reaches the implement, spec-review, and code-review stages too. Before this,
  only planning, the two contrarian gates, and the test stages saw prior-run
  learnings. Implement now sees the `error_patterns` and `workflow` digests.
  Spec review picks up `workflow`, and the merge-gate reviewer gets
  `error_patterns` plus `quality_loop`. Lessons now land where code is written
  and reviewed, close to where the mistakes they describe actually happen.

- Token reconciliation (#90): `aggregateTokens` now returns `attributed` (the
  summed per-issue and per-stage deltas) and `reconcile_error`, defined as
  `|spent - attributed| / spent`. That fraction is the concurrency-independent
  honesty signal. The pre-existing `reconciles` boolean reads true whenever
  concurrency is 1 and anything was tracked, without ever comparing the sums,
  so it reports true even when a large slice of spend went unattributed. About
  26% does at concurrency 1: the PR-review, merge, and report spend goes
  unbracketed. `reconcile_error` exposes that gap, and downstream efficiency
  metrics must gate on it rather than on the boolean. `LEARN` was also added to
  the `__seed` test hook.

## 0.1.29 (2026-07-20)

- Release stage (#57): the pipeline used to defer the CHANGELOG entry and
  `.claude-plugin/plugin.json` version bump to "the docblocks/PR-consolidation
  stage," but no stage ever actually performed it — Batch 2026-07-19-e (PR
  #56) merged real engine changes to main with the version and CHANGELOG left
  stale, requiring a manual repair commit (v0.1.28). Adds an OPTIONAL,
  profile-gated `release` field (`version_files`, `changelog`, `bump`)
  and a Report-phase batch release stage that runs once per batch, before the
  batch-PR agent, so the bump lands inside the human-reviewed diff by
  construction. The stage regenerates a single CHANGELOG section in place
  (idempotent across resumes) and bumps the configured version file(s) in an
  ephemeral `git worktree` — the run root is never mutated, and a push
  failure is non-fatal-but-logged. The `release` field is defined in the
  engine; activating it in this repo's own `.claude/ticketmill.json` was
  attempted, then deferred/reverted per the engine-owned-paths scope guard
  (`.claude/ticketmill.json` is out of scope for this issue), so profile
  activation is a follow-up. The new stage will not fire for this batch
  regardless, since the running engine at the run root predates it — so
  this entry and the version bump (0.1.28 -> 0.1.29) are done by hand this
  one time.

  Deferred follow-up (out of scope for this issue): `.claude/agents/
  ticketmill-implementer.md` and `ticketmill-code-reviewer.md` still read as
  if release discipline were per-issue ("every change updates CHANGELOG.md
  and bumps the version... with a conventional commit"). Now that the bump is
  batch-level and owned by the Report-phase release stage, both charters need
  realignment: implementers should not bump per-issue, and the code reviewer
  should not flag a per-issue PR for a missing bump. `.claude/agents/**` is
  engine-owned and out of scope for this issue.

## 0.1.28 (2026-07-19)

Batch 2026-07-19-e (PR #56, squash-merged as 3665bb4): eight issues.

- Results contract (#16, PR #31): renamed `by_issue[].byModel` to `by_model`
  in `aggregateTokens()` output, so `resultsJson.tokens` is snake_case
  throughout (`run_total`, `by_issue`, `by_model`). The engine-internal
  `ctx.tokens.byModel` shape is unchanged. Updated the matching assertion in
  `tests/token-usage.test.js`.
- Merge stage (#21, PR #49): dropped the undocumented tries=1 override on the
  `merge-preflight-guard` `stage()` call, the only stage in the engine passing
  a literal sixth arg. The guard is a read-only, idempotent check (`git fetch`
  plus `merge-base --is-ancestor`) at the end of a costly
  rebase/resolve/green-test sequence, so a single transient agent death threw
  all that work away and escalated straight to needs_human. It now gets the
  default `STAGE_TRIES` (2) like its git-mechanics siblings. Two regression
  tests in `tests/merge-auto-resolve.test.js` pin both edges: a first-attempt
  null is retried, and the retry ceiling is exactly 2.
- Test docs (#22, PR #50): rewrote the `installScriptedResponder` header
  comment in `tests/merge-auto-resolve.test.js`. It claimed a throw on an
  unscripted stage key makes the test "fail loudly". Per the harness contract,
  `stage()` catches a non-budget throw and retries it the same as a null
  return, then gives up quietly. The comment now describes the real mechanism:
  a responder-level guard that surfaces an unscripted stage at the agent-call
  boundary, useful for debugging. Comment-only change.
- Docs check (#24, PR #51): verified `docs/ARCHITECTURE.md` already carries
  the "Lane scheduling" design-decision section (landed with PR #23). No
  changes needed.
- Dry-run preview (#25, PR #52): a lane's `issues:` array now lists every
  member issue of a consolidated group unit. It used to show only the group's
  primary. The flatten-and-dedup lives in a new `laneMemberIssues(units,
  unitIndices)` helper, declared before the harness split so it's directly
  unit-testable, with 5 tests in `tests/lanes.test.js`. Display-only fix; the
  scheduling itself already used full member sets.
- Engine-owned gate (#28, PR #53): hardened the regime (c) revert.
  `git checkout origin/<TARGET> -- <path>` fails on a file created fresh on
  the branch, since there's no baseline copy to restore. The diff probe now
  also returns `added_files`, and the revert partitions accordingly: created
  files get `git rm`, existing files still go through checkout, both in the
  same revert commit. A probe response without `added_files` degrades to the
  prior checkout-then-defer behavior. Regression tests for both paths in
  `tests/engine-owned.test.js`.
- Prompt cleanup (#29, PR #54): renumbered the preflight probe prompt's
  duplicate "4." steps (a merge artifact) to a clean 1..6 sequence. Cosmetic
  only; the probe schema names every field explicitly.
- Resume correctness (#30, PR #55): a resumed run no longer drops `Closes #N`
  lines for issues whose per-issue PR merged into the batch branch in a prior
  pass. Those issues preflight as skipped, and the batch PR body was rebuilt
  from this pass's completed results alone, so the human's batch merge left
  them open. A new pure `batchClosesIssues(results)` keys inclusion on a
  shipped set instead: completed, or skipped with `merged_into_target` true.
  That flag is a plain JS string match at the skip return, `pr_state ===
  'merged' && pr_base === TARGET` (`pr_base` is a new preflight schema field),
  so a PR merged into a different run's batch branch never counts. The same
  set drives the batch PR's create/update gate, title count, Consolidated
  Groups section, and Closes lines, so the four agree by construction.
  Covered by `tests/batch-closes-issues.test.js`, plus a new ARCHITECTURE.md
  design-decision entry.

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
