# Metrics

The run grades itself on the way out: friction and churn, rework tax, gate yield, and outcome/revisit-risk. Together they say how hard the run fought and whether that fight paid off.

## Friction & churn: a weighted per-run score, not a raw iteration count

A run's difficulty used to live only inside each issue's raw metrics:
iteration counts per stage, scattered across a JSON blob nobody scanned
across a whole batch. `computeFriction(results)` turns those counts into one
score per issue, so a human can see which issues actually fought back
without reading every per-issue block.

Seven capped pipeline stages (approach, plan, task-review, quality, test,
browser, pr-review) each contribute `min(1, iters/cap)` to that score.
Clearing a gate under its cap costs nothing: an issue whose stages all pass
first try scores 0 across every one of them, no matter how many stages it
has. On top of the seven ratios, weighted signal terms add friction a
capped ratio can't see. `needs_human` carries the heaviest weight (2), since
it's the one outcome a run can produce that never resolved on its own.
`merge_thrash` (1.5) follows, since it forces a mandatory re-test and
re-rebase cycle. `contrarian_capped` (1) is a flat penalty for hitting a
contrarian cap with findings still open, and `unresolved_count` (0.25 per
finding) adds granularity on top of it, so a capped-out issue carrying five
open findings scores higher than one carrying only one. `quality_degrades`
(0.5) and `test_quality_fix_rounds` (0.3) round out the list. The order and
size of these weights tracks how much extra rework each signal actually
costs, independent of how often it fires.

Each nonzero stage or signal becomes one entry in that issue's `drivers`
list, sorted by contribution. That's what lets the rendered table explain
why an issue ranked where it did, instead of showing a bare number.

`computeChurn(results, opts)` runs alongside it, reading the
`changed_files`/`touch_counts` fields #87 added to `ctx`, and finds two
different shapes of rework:

- **Cross-issue hotspots**: a file touched by `HOTSPOT_ISSUE_THRESHOLD` (2)
  or more distinct issues in the same run. Two issues landing on the same
  file already counts as a collision worth flagging. One issue touching many
  files across a run is ordinary and never trips this.
- **Re-fix chains**: a file one issue's own `touch_counts` revisited
  `REFIX_THRESHOLD` (3) or more times. The bar mirrors the "3+ fix rounds is
  a smell" heuristic the quality and test loops already apply informally.

Both get bucketed through the same `matchesGlobs` helper the lane scheduler
uses for `serialize_globs`/engine-owned globs. A file matching
`serialize_globs` buckets there first, since the profile already expects it
to run hot. Anything left matching `ENGINE_OWNED` buckets next, and
everything else lands in `surprising`. A `surprising` hotspot is the one
worth a human's attention: neither the profile nor the engine's own file
list predicted it would collide.

`composeFrictionChurn(results, opts)` combines both rollups into one "##
Friction & Churn" section, following the same JS-computed, verbatim-injected
pattern as `aggregateTokens` (cost-and-tokens.md) and `aggregateMergeAutoResolve` (branching-and-merge.md). The whole
section is gated on `has_signal`, so a clean run, every stage under its cap
and no hotspots or re-fix chains, renders nothing rather than an empty
heading. `buildRunRecord` carries the same rollup under a `friction_churn`
key: machine-readable fields only, no markdown, additive alongside the
existing `tokens` and `merge_auto_resolve` blocks.

## Rework tax and gate yield: did the fight pay for itself

Friction & churn scores how hard a run fought. Rework tax and gate yield ask
a narrower question: how much of that fight was wasted motion, and did the
paranoid gates catch anything worth their cost. Both are pure JS reducers,
built the same way as `composeFrictionChurn` above. Each computes once,
injects its markdown verbatim into the batch PR and run report, and adds
machine-readable fields to `buildRunRecord` alongside `friction_churn`.

**Completing the gate findings tally.** `recordGateOutcome` (#87) tallied
findings for the approach and plan contrarian gates only. `reviewAndMerge`
now calls it for `pr-review` too, the third and last per-issue gate. The
disposition vocabulary carries over unchanged: `accepted` when both the spec
and code reviewer approve in the same iteration (the same condition that
trips the `approved = true` break just below it), `carried-unresolved` when
the iteration cap is reached without a clean pass, and `re-litigated`
otherwise, since the loop revises and sends the PR back for another review.
A dead reviewer never reaches this line: `reviewAndMerge` already fails the
run with `needs_human` first. One gap carries through the tally.
`REVIEW_SCHEMA`'s `issues` field has no `severity`, unlike the contrarian
gates' `CHALLENGE_SCHEMA`. The review prompts never ask for one, so
`gate_findings['pr-review'].severity` stays zero across the board while
`disposition` and `count` still carry real signal for that gate.

**Per-stage token tracking.** `stage()` already attributed each retry loop's
token delta to `ctx.tokens.total` and `ctx.tokens.byModel`. It now attributes
the same delta to `ctx.tokens.byStage[key]`, keyed by the literal stage name
the caller passed in, things like `quality-fix-i1` or `pr-fix`. No new
sampling runs and no new failure mode opens up. The accumulation rides the
same try/finally block that already guards the total and per-model sums.

**`computeReworkTax(results, tokenAgg)`** classifies each `byStage` key
against a fixed prefix list: `quality-fix`, `test-fix`, `test-quality-fix`,
`pr-fix`, `merge-conflict-resolve`. Anything matching one of those prefixes
counts as rework. Everything else counts as first-pass work. The list checks
the compound `test-quality-fix` prefix before the shorter `quality-fix` and
`test-fix` prefixes it would otherwise match as a substring, then sums both
buckets per issue and across the run.

The result is only as trustworthy as the token accounting under it. Above
concurrency 1, overlapping issues' stages attribute the same shared counter
movement to each of their own `byStage` keys, the exact over-count
`aggregateTokens` already documents for its per-issue rows. `computeReworkTax`
gates on `tokenAgg.reconcile_error` staying at or under
`MAX_RECONCILE_ERROR_FOR_TRUST` (#90's honest reconciliation signal). It
never gates on the coarser `reconciles` boolean, because an untrusted
`reconcile_error` taints the rework fraction the same way it taints the run
total. A run that fails the check still returns its raw per-issue sums. Only
the run-level fraction and the rendered signal go quiet, with a stated
reason, so a machine consumer can see what was computed without the run
treating it as trustworthy.

**`computeGateYield(results)`** rolls the three gates' `gate_findings`
tallies into one table: findings, severity mix, and an accepted-to-dismissed
ratio, summed across every issue in the run. Alongside it sits the signal
the reducer exists for, an escaped defect: an issue where `pr-review` raised
findings but neither `approach` nor `plan` raised any. The check counts
findings rather than weighing severity, matching the issue's own definition.
It answers one question directly: did the early gates ever get a look at
this, or did it only surface because nothing upstream ever saw it.

## Outcome grading: a quality anchor beside the friction signal

Friction, churn, rework tax, and gate yield all measure how hard a run
fought. None of them measure whether the result was any good. An issue
can clear every gate on the first try, score zero friction, and still
ship a defect that gets reverted the next day. Self-improvement built
only on process signal is Goodhart-able for exactly that reason, so
issue #92 adds a read-only pass that back-annotates a prior run's merged
batch PRs with what actually happened to them, and records it in
`<logs_dir>/outcomes.jsonl`.

**Split across the sandbox boundary, like learnings.** The Select-phase
sandbox has no fs/git/gh (see "Sandbox lint" in invocation-and-guardrails.md), so it can't walk
`runs.jsonl` or shell out to `gh` itself. An `outcome-grade` agent stage
does both jobs live: it reads the run-history ledger and each run's full
record to build the list of gradable targets (a merged member issue of a
prior run's batch PR), then resolves one raw observation per target with
`gh pr view`, `gh issue view`, and `gh search`: live reads, never the
run record's own possibly-stale status. It fires alongside `learnPromise`
so its latency hides behind the same preflight probes, and it is
strictly read-only: no git fetch, no local writes, no state-changing `gh`
command.

The agent never decides a grade. It returns `observations` (one raw
object per target), `prior_ledger_lines` (the raw text of
`outcomes.jsonl`, verbatim and unparsed), and `now` (its own `date -u`
read, since the sandbox forbids `Date.now()`). Everything downstream of
that is deterministic JS above the `TICKETMILL-TEST-HARNESS-SPLIT`
marker, unit-tested directly in `tests/outcomes.test.js` without ever
shelling out.

**`gradeFromObservation`** applies a fixed precedence: `reverted` >
`reopened` > `hotfix` > `later_batch_fix` > `closed_unmerged` >
`abandoned` > `clean` > `pending`. The aging is deliberately asymmetric.
A bad outcome is real the moment it's observed and grades immediately,
at any age. A clean grade waits: `merged, no negative signal` only
becomes `clean` once the
PR has stood for `min_age_days` (default 7, profile-overridable via
`outcome_grading.min_age_days`, mirroring the
`profile.contrarian_max_iterations` guard). Before that it grades
`pending`, because "no negative signal yet" is not the same claim as
"held up cleanly". `closed_unmerged` and `abandoned` are a terminal
escape hatch for targets that will never see a merge and so can never
earn `clean` any other way.

**`abandoned` needed its own wiring (issue #103).** The precedence list
above already named `abandoned`, but nothing ever populated it: #92/PR#102
left the field unset on every observation, so that branch was dead code.
The fix threads `issue_state` off the same `gh issue view --json
state,timelineItems` read step 2c already runs for `reopen_found` and
`hotfix_ref`. No extra `gh` call needed. `deriveAbandoned(issue_state,
live_merge_state)` then decides the field: true only when the issue is
closed AND the batch PR's live state is `open`, `closed`, or `none`.
`merged` is excluded on purpose, since a merged PR that later goes bad
already has `closed_unmerged` and `clean` to describe it. `unknown` is
excluded too, so a transient `gh pr view` read failure can never produce
a terminal grade off a signal that never resolved. A failed `gh issue
view` read reports `issue_state: "unknown"`, same fallback contract as
the other fields in that step.

**`diffOutcomeGrades`** is the only thing allowed to decide what gets
appended. It compares this pass's freshly graded lines against
`prior_ledger_lines` (both sides read last-line-wins, since the ledger is
append-only) and keeps only lines that are new or whose grade changed,
skipping any key whose prior grade is already terminal
(`reverted`/`reopened`/`hotfix`/`later_batch_fix`/`closed_unmerged`/
`abandoned`: `OUTCOME_TERMINAL_GRADES`) so settled history never gets
bloated or second-guessed by a possibly-flaky re-read. `summarizeOutcomeCoverage`
rolls the pass into `graded_count`/`negative_count`/`pending_count`/
`sample_cap_hit`, so a later tier can read one small object instead of
re-walking the ledger.

**Persistence follows the `record`/`ledger` contract exactly.** The
engine returns `outcomes` (the diffed, new-or-changed lines only),
`outcomes_path`, and `outcomes_coverage` alongside `record`/`ledger`.
`skills/mill/SKILL.md` seeds `outcomes.jsonl` if it doesn't exist yet and
appends each entry as its own compact JSON line, in order: a plain,
dumb append, never a rewrite or a dedup, matching how the skill already
writes `runs.jsonl`. `outcomes.jsonl` is a per-host, gitignored local
artifact, and target selection is bounded by
`outcome_grading.sample_cap` (default 20, oldest-unobserved-first) so one
pass stays cheap and history catches up over many runs instead of trying
to grade everything at once.

**`later_batch_fix` reopens a signal a plan review rejected once already
(issue #104).** An early design for #92 tried to catch "this batch
caused a later fix" by intersecting `changed_files` across two diffs,
the batch PR's and a later PR's. Plan review killed it: in a
monolith-shaped repo where nearly every issue touches
`workflows/ticketmill.js`, file overlap is guaranteed and proves
nothing. `later_batch_fix` asks a stronger question instead. Did the
later fix PR's own `git blame` on the pre-image lines it just replaced
name THIS batch PR's own squash-merge commit as the SHA that introduced
them. That's a line-level, blame-forward resolution done entirely in
the later PR's own coordinate space, never a synthesized intersection
across two unrelated diffs.

**`computeLaterBatchFix(observation)`** fires iff `batch_pr_merge_sha`
is a non-empty string and appears in the union of every
`churned_regions[].blamed_shas` entry. `churned_regions` is an array of
`{file, blamed_shas}`, one entry per hunk in the later fix PR's diff,
each already resolved live by the outcome-grade agent stage: a
read-only `git blame <commit>^ -L <range> -- <file>` on this repo's own
non-shallow local clone, never a `git fetch`. Anything malformed or
absent (no SHA, no regions, a region missing `blamed_shas`) fails open
to `false`, the same ethos as `ageInDays`/`deriveAbandoned`.

**`isPlannedFollowup(bodyText)` keeps a pre-planned continuation out of
the grade.** A later PR whose own body reads as a scheduled next step
("follow-up from", "follow up from", "depends on", "deferred from";
case-insensitive) isn't repairing a defect. It's doing work that was
always going to happen. Validated against real history: #103's body
("Follow-up from #92...") is excluded, while reactive language like
"regression introduced by" stays eligible. `gradeFromObservation` only
assigns `later_batch_fix` when `computeLaterBatchFix` fires AND
`isPlannedFollowup` doesn't.

**It sits below `hotfix`, above the terminal escapes.** A same-issue
cross-reference (`hotfix`) is a more direct claim than a blame-forward
resolution against a different PR, so it still wins when both are
true. A real later fix landing is strictly more informative than
`closed_unmerged`/`abandoned`, so `later_batch_fix` outranks both. It
joined `OUTCOME_TERMINAL_GRADES` (a blame-forward resolution never
un-happens) and `OUTCOME_NEGATIVE_GRADES` (it's the same "this shipped
a defect" claim as revert/reopen/hotfix, just resolved a different
way).

**Revisit risk doesn't cover it yet, on purpose.** `later_batch_fix`'s
evidence, `churned_regions`, lives in the later PR's own coordinate
space, not a diff the revisit-risk pass can walk to a file list.
Translating it back would reintroduce the coincidental-overlap risk
the mechanism exists to avoid. `attachRevisitFiles` returns `files: []`
for it, always: an explicit fail-open, not a silent gap. Real coverage
is a follow-up.

## Revisit risk: flagging a preflight from recent negative outcomes

Outcome grading records whether a merged issue held up. Revisit risk reads
that same ledger to warn the next issue before it starts. Issue #93 adds a
Select-phase pass that flags a preflight when a file it's likely to touch
was recently reverted, hot-fixed, or reopened, and threads that flag into
the evaluate, approach-challenge, and plan prompts so the run treats the
area with more care.

**Same split as outcome grading, and the same PIN.** The Select sandbox
still can't shell out, so a `revisit-risk` agent stage does the live
reads. It cats `outcomes.jsonl` for `prior_ledger_lines` (raw, unparsed
lines, the same contract as `OUTCOMES_SCHEMA`'s field of the same name),
then for any ledger key already graded with a member of
`OUTCOME_NEGATIVE_GRADES` (reverted, reopened, hotfix, or
`later_batch_fix` as of issue #104) within a target-selection window,
resolves that regression's `files` with a live `gh` read.
`later_batch_fix` always resolves to `files: []` (see above); the other
three grades resolve a real file list. It fires alongside `learnPromise` and
`outcomeGradePromise`, in the same `STAGE_TOKENS.preflight` bracket, and
it is strictly read-only. `computeRevisitRisk`, above the
`TICKETMILL-TEST-HARNESS-SPLIT` marker, is the only place that decides a
flag. The agent itself never grades.

**A quality-fix iteration closed a PIN violation.** The first pass
trusted the agent's own last-line-wins parse of `outcomes.jsonl` as the
flag decision, the exact thing #92's `OUTCOMES_SCHEMA` was built to rule
out, and code review caught it with a `changes_requested` verdict.
`deriveNegativeOutcomeEvents` fixes it: it re-derives grade, `decided_at`,
and `merged_at` straight from `prior_ledger_lines`, using the same
`outcomeLineKey` grouping and last-line-wins logic `diffOutcomeGrades`
already uses, and keeps only keys whose current grade is in
`OUTCOME_NEGATIVE_GRADES`. `attachRevisitFiles` then merges on just the
one piece of the agent's output that's genuinely judgment-requiring: the
live-`gh`-resolved `files` list, keyed by `{issue, batch_pr}`. A negative
key the agent never resolved files for still comes through with
`files: []`, never fabricated.

**The recency anchor is when the risk became known, not when the change
merged.** `computeRevisitRisk` ages each event off `decided_at`, falling
back to `merged_at` only when `decided_at` is missing, and compares that
age against `profile.revisit_risk.window_days` (default 30, the same
override guard as `outcome_grading.min_age_days`). A preflight needs to
know how recently the team learned an area is risky. A regression that
merged months ago but was only reverted this week is still fresh news to
a run starting today, even though the underlying merge is old.

**Matching and corroboration.** A preflight flags when any of its
`predicted_files` (normalized: case-sensitive, slash-normalized)
intersects an in-window event's `files`, with one reason string per
match. `refix_chains` (#89's within-issue re-fix counts) can only
annotate a file that already flagged from a real event overlap; they
never flag on their own. Churn alone has no proven link to a bad outcome,
and in a monolith-shaped repo like this one it would flag almost every
engine-touching issue.

**Threaded like `engineOwnedIntentional`.** `deriveUnits()` OR-folds
`revisit_risk` across a group's live members with `unionRevisitRisk`. One
flagged member is enough to flag the whole unit, and reasons concatenate
rather than dedupe, since each one already names its own file, issue, and
grade. `processIssue` reads the value off `pre` onto `ctx` once at init,
the same pattern `engineOwnedIntentional` uses just above it, so every
stage downstream sees the identical value. Its own default,
`{flagged: false, reasons: []}`, matches `computeRevisitRisk`'s clean
no-op shape, so a preflight that never carried the field (a resume-skip
stub, say) can't crash a downstream read.

**Rendering is a clean no-op when nothing is flagged.** `revisitRiskBlock(ctx)`
returns an empty string unless `ctx.revisit_risk.flagged` is true, so a
run with no history match renders byte-identical evaluate,
approach-challenge, and plan prompts to before this feature existed. When
it does fire, `pushDecision` records it in the decision chain once, right
after worktree setup, and each of the three prompt sites then renders it
inline: the flagged file and its prior grade, and a push toward a
conservative approach with added regression coverage.
