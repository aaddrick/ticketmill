---
name: mill
description: Launch a ticketmill batch run - autonomously implement a set of GitHub issues end-to-end (plan, implement, test, review, merge into a human-reviewed batch PR). Use when asked to batch-process, mill, or autonomously implement GitHub issues. Requires prior onboarding via mill-init.
---

# mill — launch a ticketmill batch run

Runs the ticketmill engine: for each selected GitHub issue — research, contrarian-gated
approach and plan, per-task implementation with quality loops, a test loop, PR creation,
spec + code review loops, and a squash-merge into a batch integration branch. The run
ends with ONE batch PR for a human to review and merge; the engine never merges to the
base branch itself.

## Hard preconditions — check these IN ORDER before doing anything else

1. **The Workflow tool must be available in this session.** Check your available tools
   for a tool named `Workflow` that accepts a `scriptPath` input.
   **If it is not available: STOP IMMEDIATELY.** Tell the user:
   > The ticketmill engine requires the Claude Code Workflow tool, which is not
   > available in this session/plan. The engine cannot run without it.

   **NEVER attempt to simulate, approximate, or hand-execute the batch pipeline
   yourself** (no ad-hoc issue implementing, no manual worktree orchestration in
   place of the engine). The engine's value is its journaling, claims, circuit
   breakers, and resumability — an inline imitation has none of those and is
   strictly worse than not running at all.

2. **The target repo must have a profile** at `<repo-root>/.claude/ticketmill.json`.
   If missing, stop and direct the user to run `/ticketmill:mill-init` first. Do not
   write a profile ad hoc — mill-init exists to verify the environment (doctor pass)
   before a profile is trusted.

3. **Locate the engine script**, in this order:
   1. `${CLAUDE_PLUGIN_ROOT}/workflows/ticketmill.js` (plugin install)
   2. `<repo-root>/.claude/workflows/ticketmill.js` (copied by mill-init)

   If neither exists, stop and direct the user to `/ticketmill:mill-init`.

## Engine-owned paths need a clean root tree

If an issue's fix touches the ticketmill profile (`.claude/ticketmill.json`), the
agent roster (`.claude/agents/**`), or the engine copy (`.claude/workflows/ticketmill.js`,
`.claude/scripts/ticketmill/**`), check the root working tree before you launch. The
engine works from each issue's own worktree, and that worktree only sees committed
state. Uncommitted edits sitting in the root tree, like a freshly forged agent or a
profile field you just added, are invisible to it.

That gap turns dangerous when the issue's own fix targets the same path. The engine
can "reconcile" by restoring the old committed version from git history. A later
batch merge then overwrites your uncommitted work without ever raising a conflict.
The engine's Select-phase preflight catches this when it can: an issue whose title or
body plainly names an engine-owned path gets routed to skip if the root tree is dirty
under that path. But the preflight only sees what git tracks. Commit or stash
root-tree changes to those paths first, or hold the issue back and run it solo once
the batch finishes.

## Gather run parameters

From the user's request (ask only if genuinely ambiguous):

- `branch` (required): the base branch the final batch PR targets (e.g. `dev`, `main`).
- Issue selection (exactly one):
  - `issues`: explicit array of issue numbers, e.g. `[701, 702]`
  - `labels`: array of label names (optionally with `limit`, `state`, `no_assignee: true`)
- Optional: `concurrency` (1-5, default 2), `run_label` (defaults to today's date —
  pass `run_label: "<YYYY-MM-DD>"` so report filenames don't collide),
  `dry_run: true` for a read-only preview, `batch_branch: "Batch_..."` to resume a
  prior batch, `token_budget` to halt the run BEFORE it overspends — see its own
  section below.

Suggest `dry_run: true` for a user's FIRST run in a repo — it probes every issue and
reports the routing plan (skip / review-only / implement) without changing anything.

## token_budget — a proactive spend ceiling (optional)

`token_budget` stops the run cleanly BEFORE starting an issue whose projected spend
would exceed it. This is distinct from the engine's existing reactive circuit
breaker (which only trips AFTER agents are already dying against the account
ceiling) — the point is to stop before the ceiling, not after.

Accepts either form, as a run arg or a `token_budget` field in the target repo's
`.claude/ticketmill.json` profile (run arg wins if both are set):

- an absolute **OUTPUT-token** count — a number or numeric string (e.g. `500000`
  or `"500000"`). This is the same unit the engine's own spend tracking uses
  (`budget.spent()` counts OUTPUT tokens only; input tokens are not counted), so an
  absolute `token_budget` is directly comparable to what you'd see in an account's
  usage dashboard for OUTPUT.
- a relative multiple of this batch's own trusted historical median — a string like
  `"5x"` or an object `{ "multiple_of_median": 5 }`. Unit-invariant: works
  regardless of what a "normal" issue costs in this particular repo. Needs trusted
  history to resolve against (see "honest-posture note" below); with none yet
  available it degrades to "guard off" rather than a false floor, and the engine
  logs why.

Two guard layers run underneath, always on whenever a budget resolves — a hard
floor (spend already at or over budget) needs no history or estimate at all, so it
protects every run regardless of how thin history is; a lighter pre-check layers on
top once trusted per-issue estimates exist. You don't need to do anything to enable
either layer beyond setting `token_budget`.

When the guard trips, the run halts with `state: 'budget_halt'` — a distinct state
from `state: 'circuit_breaker'` — carrying its own `resume_hint` (raise
`token_budget` or split the remaining issues into a smaller batch, then resume with
`batch_branch` per "Resuming" below). Relay this distinction to the user rather than
folding it into generic "the run stopped" language: a budget halt means the guard
worked as intended, not that something broke.

## Read prior-run history (before EVERY Launch — live runs and dry_run alike)

The cost estimator and the `token_budget` pre-check are both pure reducers over
history handed in as a run arg — the engine sandbox has no filesystem access, so
this skill is the only place that can read `runs.jsonl` and pass it in. Do this
before every `Workflow(...)` call below, **including `dry_run: true`** — skipping it
on a dry run makes the `cost_estimate` preview report `history_available: false`
regardless of how much real history exists on disk, and skipping it on a live run
leaves the `token_budget` pre-check permanently dark (the hard floor still runs, but
with no advance warning).

1. Resolve `logs_dir` from the profile you already loaded for precondition #2
   (`<repo-root>/.claude/ticketmill.json`'s `logs_dir` field, default
   `logs/ticketmill`).
2. If `<repo-root>/<logs_dir>/runs.jsonl` does not exist yet, pass `history: []` —
   this is the expected first-run case; the estimator degrades honestly (see below)
   rather than needing seed data.
3. Otherwise read the file, split it into lines, and `JSON.parse` each non-empty
   line into an array of objects. Skip (don't fail the whole read over) any single
   line that fails to parse — a partially-written line from a crashed prior run must
   not block this run from launching.
4. Pass that array as `args.history` on the `Workflow(...)` call.

## Launch

```
Workflow({
  scriptPath: "<resolved engine path>",
  args: {
    branch: "dev", issues: [701, 702], run_label: "2026-07-18",
    history: [ /* parsed runs.jsonl lines from the step above — every invocation */ ]
  }
})
```

The workflow runs in the background. When it completes, relay the result: state,
per-issue outcomes, the batch PR number (stress that a HUMAN must review and merge
it), any `verification_gaps` (these are important — they list checks that did not
run), and the `resume_hint` if the run did not fully complete.

## Relay the dry_run cost-estimate preview

When `dry_run: true`, the return's `cost_estimate` block estimates spend BEFORE
committing to a real run — a pre-split nudge, not a guarantee. Relay it to the user
alongside the routing plan:

- **Per-issue** (`cost_estimate.by_issue`): each entry's `estimate` (projected
  OUTPUT tokens, or `null`) and `confidence` (`'insufficient'` when same-shape
  history is too thin to trust — an honest degrade, never a guess).
- **Oversized flags** (`cost_estimate.by_issue[].oversized`): three independent
  signals; any one should read to the user as "consider splitting this issue before
  running it":
  - `structural` — a consolidated group with 4+ member issues. History-free, fires
    even on a repo's very first run.
  - `pf_ceiling` — predicted-files count at or above the top size band. Also
    history-free, but easy to evade (an under-predicted file list simply won't
    trip it) — never treat it as load-bearing on its own.
  - `multiple_of_median` — the issue's own estimate is a large multiple of this
    batch's trusted historical median. Needs trusted history to fire at all.
- **Batch projection** (`cost_estimate.batch_projection`): never reports a bare
  summed `projected_total` if any issue's estimate is `null` (`projected_total`
  itself is `null` in that case) — always relay its `coverage_note` ("estimable K
  of N, M unknown") instead, so the preview never reads more confident than the
  underlying data actually supports.
- **Honest-posture note**: `cost_estimate.history_available` reports whether the
  `history` you passed in above carried any lines at all — a whole-run signal,
  distinct from a per-issue `'insufficient'` confidence (which can still happen
  even WITH history, if same-shape history is thin). Either way, **trusted history
  only accrues from runs recorded with `effective_concurrency === 1`** (a
  serialized run, or one whose lanes happened to collapse to one) — a default
  `concurrency: 2` product batch's own history never feeds the estimator, by
  design, because per-issue tokens can't be attributed honestly across concurrent
  lanes. That's not a gap this estimator can close by reading more history; it's
  exactly why the history-free `structural`/`pf_ceiling` flags above and the
  always-on `token_budget` hard floor exist — they're what protect a
  `concurrency: 2` batch in the absence of a trustworthy per-issue estimate. Tell
  the user this plainly rather than letting silence read as "the estimator just
  hasn't warmed up yet": if they want the per-issue estimator itself to start
  lighting up, they need at least one `concurrency: 1` (or naturally single-lane)
  run in their history.
- **Two reconcile-error bars — name them distinctly, don't conflate them**: the
  engine gates two different things on a run's `reconcile_error` (its token-
  accounting gap), at two different thresholds, for two different purposes. The
  strict bar (0.05) is what the engine uses to decide whether a run's OWN numbers
  are trustworthy enough to display (e.g. its rework-tax figure). The coarser bar
  (0.5) is estimator-only — it's the pathology threshold for admitting a history
  ROW into the cost-estimator's per-band medians in the first place, deliberately
  looser because even a good `effective_concurrency === 1` run still leaves some
  routine unattributed spend (parallel subagent overhead) that would otherwise
  starve the estimator of any usable history at all. A run can fail the strict
  0.05 bar (so the engine won't display that run's own rework-tax) while still
  passing the coarse 0.5 bar (so the estimator still learns from its
  `by_issue_shape` rows) — that's expected behavior, not a contradiction, so don't
  describe a run as "untrusted" without saying for which of the two purposes.

## Persist the run record (do this the moment the workflow returns)

The return value carries the authoritative machine-readable record. **Write it yourself
with the `Write` tool — never ask an agent to serialize it** (the engine used to hand a
`.slice(0, 30000)` of the JSON to the report agent, which silently dropped the tail;
on an 18-issue run every per-issue `metrics` block after the cut was lost). The engine
now returns the full object so the outer skill can persist it with deterministic file
IO, outside the sandbox.

When the return includes a `record` object (older engines omit it — then skip this):

1. Write `record` as pretty-printed JSON to `<logs_dir>/runs/<run_tag>.json` (both
   `logs_dir` and `run_tag` are fields on the return). Create the `runs/` directory
   first. Write it **verbatim** — every per-issue `metrics`/`tokens`/`timeline` block
   must land; this file is the source of truth for every observability tier built on top.
   **Collision guard:** if `run_tag` is the literal `run` (no `run_label` was passed),
   substitute today's date (`date +%F`) into the filename — `runs/<YYYY-MM-DD>.json` —
   exactly as the engine does for the human `.md`, so successive default-tag runs don't
   clobber the source-of-truth record. (Normally you pass `run_label`, so this never
   fires; it's the same defense the `.md` already carries.)
2. Append the return's `ledger` object as a **single compact JSON line** (no
   pretty-printing, one line) to `<logs_dir>/runs.jsonl` — the cross-run ledger. Always
   append; never overwrite.

The agent-written `summary-<run_tag>.md` remains the human narrative; `runs/<run_tag>.json`
is the machine record.

When the return also includes an `outcomes` array (older engines omit it — then skip this):

3. If `<logs_dir>/outcomes.jsonl` does not exist yet, create it empty first (seed it) —
   same as `runs/` gets created before the first write above.
4. Append each entry in `outcomes` to `<logs_dir>/outcomes.jsonl` as its own **single
   compact JSON line** (no pretty-printing, one line per entry), in the order given.
   This is a **plain append — never rewrite the file, never de-dup, never drop a line**.
   The engine's `diffOutcomeGrades` already decided which grades are new or changed
   before returning `outcomes`; the skill's only job here is dumb, deterministic append,
   identical in spirit to the `runs.jsonl` append above. "Last-line-wins per
   `run_tag`+`batch_pr`+`issue` key" is a convention for whatever later *reads* this
   file (e.g. a Tier 5 consumer) — it is not something the skill enforces on write.

`outcomes.jsonl` is a per-host local artifact, same as `runs.jsonl` and `runs/*.json`
(`logs/` is gitignored) — it is never committed, and grades accrue only from runs
executed on this host.

## Resuming

- Same session: `Workflow({scriptPath, resumeFromRunId: "wf_..."})` replays completed
  stages from the journal.
- Any session: re-run with the same args PLUS `batch_branch: "Batch_<ts>"` from the
  prior run's output — the preflight skips finished work and continues partial work.
