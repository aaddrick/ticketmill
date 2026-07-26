# Cost and tokens

Ticketmill tracks spend as a signal, never as a gate, unless a human explicitly asks it to be one. This page covers the token instrumentation, the cost estimator, and the token_budget guard that make that tracking possible.

## Token tracking: instrumentation, never a gate

`stage()` samples the runtime's `budget.spent()` (cumulative output tokens for
the whole run) before and after each retry loop, attributing the delta to
`ctx.tokens.total` and `ctx.tokens.byModel[opts.model]`. That sampling sits in
its own `try/finally` wrapped around the existing retry loop. A tracking
failure, whether `budget.spent()` throws or the runtime hook is missing
outright, can never change `stage()`'s retry, STOP, or return behavior. This
is instrumentation, not a gate: a run with no working counter still ships,
just with "not tracked" standing in for the numbers instead of a false zero.

Not every token spend has a `ctx` to attribute to. Preflight's learnings
read, the claims Promise.all, and the Select-phase consolidation gate
(`proposeConsolidation()` and `postConsolidationMarkers()`) all run before or
between per-issue stages, outside any issue's context. `STAGE_TOKENS` (a
`{ preflight, select }` map) and its `addStage(bucket, before)` helper
bracket those four run-body regions the same way `stage()` brackets a retry
loop: sample `spentTokens()` immediately before the region, then again right
after, and accumulate the guarded delta. `addStage()` runs in its own
try/catch, so a tracking failure there can't touch run-body control flow
either. Every bracketed region sits strictly before `runPool()`, the only
concurrent region in the engine, so these deltas stay exact regardless of
`CONCURRENCY` even when the per-issue breakdown below them doesn't.

`aggregateTokens(results, spent, concurrency, byStage, poolSpend)` turns the
per-issue deltas, plus that `STAGE_TOKENS` map, into a "## Token Usage"
section in plain JS. The pipeline injects the finished markdown into the
batch PR and run report prompts verbatim, so no subagent is ever asked to sum
or double-check the arithmetic. `byStage` is optional and defaults to `{}`,
so 3-arg callers still work; each nonzero bucket folds into the running sum
exactly once and renders as its own labeled row ("preflight (orchestration)",
"select-phase (orchestration)"), never silently absorbed into the remainder
row below it. `poolSpend`, a 5th optional argument, re-scopes the
`reconcile_error` signal (issue #111, below).

Only the per-issue rows are affected by concurrency. At concurrency 1, an
issue's stage deltas can't overlap, so they're an exact partition of that
issue's run: `reconciles: true` when `spent` and some tracked data both
exist. Above concurrency 1, several issues' stages run against the same
shared monotonic counter, and `agent()` returns schema content only, never a
per-call usage figure. There is no way to split a shared counter's movement
across concurrent callers, so a per-issue row over-counts and the breakdown
is labeled approximate (`reconciles: false`). That downgrade only applies
when some per-issue row is actually tracked (`anyTracked`).

A resumed run can carry its whole breakdown in `STAGE_TOKENS` buckets alone,
with every per-issue row untracked. There's no per-issue over-count to guard
against there: those buckets are sampled outside the concurrent pool, so
they stay exact regardless of `CONCURRENCY`. `reconciles` stays `true` for
that stage-only shape even above concurrency 1 (issue #65). The narrative
footnote follows the same split. It warns about approximation only when
`anyTracked` is true, so a stage-only breakdown above concurrency 1 renders
with no warning, having earned none.

The "orchestration/unattributed" remainder row (`spent` minus the summed
per-issue and stage deltas, floored at 0) renders whenever `budget.spent()`
is available at all, not only when the table reconciles. A Quality Review
finding caught the earlier version hiding this: a resumed run where no
per-issue row and no stage bucket ever attributed a delta, but
`budget.spent()` was still a real nonzero number, fell through to "Per-issue
/ per-model breakdown: not tracked" while the "Run total" line above it still
showed the true spend. The table and the summary line disagreed. The
remainder row now carries that full, otherwise-invisible spend instead, and
the breakdown renders (with per-issue cells reading "not tracked") as long as
either `spent` or a stage/per-issue delta is available. Per-issue PR bodies
get one line of the same figures (that issue's stages only, not the run
total or the stage buckets).

Tokens only, never dollars: price varies by model and shifts over time, so no
currency figure appears anywhere in the engine, profile, or output. The
per-model-tier breakdown is what lets a human run that math outside the tool.

## Closing the attribution gap: reconcile_error re-scoped to the pool (issue #111)

`reconcile_error` had a floor problem baked into its own denominator. It
divided the attribution gap by the full run total, `spent`, and that total
always includes PR-review, merge, report, retrospective, and outcome-grading
spend, none of which `stage()` ever brackets. Even a perfectly-attributed
per-issue pool still reported a permanent, nonzero `reconcile_error`, roughly
a quarter of spend on a typical concurrency-1 run. `computeReworkTax`'s 0.05
trust gate could never clear that floor, so the rework-tax signal went quiet
on nearly every real run, defeating the point of #90's own reconciliation
check.

**`POOL_SPEND` brackets the one concurrent region from outside it.** The run
body now samples `spentTokens()` immediately before and after the
`runPool()` call, the same before/after idiom `addStage()` already uses for
the preflight/select brackets above. The delta stays exact regardless of
`CONCURRENCY`, since it's sampled outside any per-issue stage's own tracking.

**When `poolSpend` is finite, `reconcile_error` re-scopes to it.** The
denominator becomes `poolSpend`, and the numerator becomes `perIssueSum`, the
per-issue tracked totals only, never the stage buckets (those are bracketed
outside the pool by construction and were never part of what `poolSpend`
measures). At concurrency 1 this reconciles near-exactly, since both sides
sum the same contiguous deltas, and it still catches a future bare-`agent()`
regression inside the pool at any concurrency. The run-total-vs-pool gap
itself doesn't disappear. It surfaces honestly as its own
`orchestration_overhead` field, `max(0, spent - poolSpend)`, rendered as its
own markdown line, instead of being folded into (or driving) the
attribution-error signal. `pool_spend` and `orchestration_overhead` are both
`null` when `poolSpend` is absent or non-finite, and every existing 3-/4-arg
caller keeps the pre-#111 formula byte for byte. `run_total`, `attributed`,
and `remainder` are unchanged either way: they still describe the full run
against the full `sumDeltas`.

The estimator's coarser 0.5 bar (`ESTIMATOR_MAX_RECONCILE_ERROR`, "Cost
estimator" below) predates this fix and was sized to admit that ~0.26
baseline as expected, not pathological. Runs recorded going forward carry the
pool-scoped `reconcile_error` instead, so a clean concurrency-1 run now
reconciles near 0. The 0.5 bar stays in place unchanged: it's headroom for
older ledger rows recorded under the pre-#111 formula now, rather than a
ceiling calibrated to an expected quarter of unattributed spend.

## Budget-exhaustion detection: a noun+verb match, not a keyword sweep

`isBudgetExhaustedError(msg)` decides what a caught stage error means: real
runtime token exhaustion, which trips the whole-run `tripStop()`, or an
ordinary per-attempt death, which retries and then falls through to
`recordAgentDeath()`. It used to fire on a bare keyword sweep: any message
containing "budget", "token target", or "ceiling" tripped the whole run.
That caught more than exhaustion. A target repo's own domain error, a
"budget" feature or a "ceiling" config value, matched the same sweep with
nothing to do with tokens. An ordinary agent death got misreported as
exhaustion, and the whole batch halted with every remaining issue left
unstarted.

The check now requires a budget/ceiling noun (or `token` narrowed to its
plural `tokens` or a qualified form like `token budget`/`token limit`) to
co-occur with an exhaustion-shaped verb: exhaust, exceed, deplete, ran out,
overrun/overage, went over, ran over, over budget, over the limit, or limit
reached. Either alone isn't enough. The "over" family is anchored to those
overrun-shaped phrases rather than the bare word "over", which turns up in
ordinary prose ("budget review is over") without meaning exhaustion. Bare
singular `token` was dropped from the noun set (issue #62): it was broad
enough to co-occur with an exhaustion verb in unrelated auth/rate-limit
errors (an expired auth token, an API rate limit, a CSRF token check), each
misreported as budget exhaustion. Narrowing to the qualified/plural forms
also closed a recall gap: the old bare-`token` pattern never matched the
plural, so "ran out of tokens" fell through to the death-counter backstop
instead of tripping the fast path.

Anchoring to the runtime's exact exhaustion error string was rejected: that
text isn't documented anywhere accessible, and the runtime's budget object
exposes only `.spent()`, no `.remaining()` and no structured error field. A
wrong guess would silently disable real exhaustion detection, so the match
stays semantic instead. `recordAgentDeath()`'s existing three-consecutive-
death circuit breaker is the backstop for any true exhaustion the tightened
match still misses.

## Cost estimator and token_budget guard: stopping before the ceiling, not after

Everything above stops a run only once something has already gone wrong: the
circuit breaker after three failures, the consecutive-death counter after
three dead agents, the budget-exhaustion match after a real exhaustion error.
Issue #97 adds a second, proactive layer that estimates a run's spend before
it starts and can halt it before the account ceiling is ever reached.

**The ledger gains a shape row.** `buildIssueShapeRows()` joins each result
against its scheduling unit and its `tokenAgg.by_issue` entry into a compact
`{issue, pf, tokens, tracked, member_count}` record, one per unit. A group
unit's `pf` is already the union across members (`deriveUnits`' own
contract), and its `tokens` is the whole group's total, never the primary
issue's share alone. `buildRunRecord` carries these rows as `by_issue_shape`,
plus `effective_concurrency` (`min(CONCURRENCY, lanes.length)`, the same
number the lane-scheduling preview already logs), and `buildLedgerLine`
copies both onto the `runs.jsonl` line verbatim. `schema_version` moves 1 ->
2 for the addition. This is the estimator's only input: an issue's shape,
and whether the run it happened in was single-lane enough to trust.

**`estimateCost` medians over trusted rows only.** `buildTrustedPfBands()`
keeps a `by_issue_shape` row only when its parent run has
`effective_concurrency === 1` (attribution is only exact at that
concurrency, see "Token tracking" above), `member_count === 1` (a group's
whole-group total would inflate a singleton's band), and a `reconcile_error`
at or under 0.5. That bar is deliberately coarser than the 0.05 one
`computeReworkTax` uses to trust a run's own numbers. Before issue #111
re-scoped `reconcile_error` to the per-issue pool (see "Closing the
attribution gap" above), a clean single-lane run still left roughly a
quarter of its spend as unbracketed orchestration overhead, and the strict
bar would have starved the estimator down to almost no history at all. The
0.5 bar stays unchanged, now mostly headroom for older ledger rows recorded
under the pre-#111 formula: a run recorded after the fix reconciles near 0 at
concurrency 1 and clears either bar easily. Rows are bucketed by
predicted-files band (`0`, `1`, `2-3`,
`4-7`, `8-15`, `16+`), and a band only reports a median once it holds 3 or
more samples. Below that it degrades to `{estimate: null, confidence:
'insufficient'}` rather than print a number built from one or two data
points. A group's estimate is the sum of its members' own individual
estimates, each banded on its own shape. Any unknown member poisons the sum
to null instead of quietly understating it.

**The dry_run preview surfaces the estimate before a run is even launched.**
`buildCostEstimate()` wraps the estimator with three independent oversized
flags and a batch projection. `structural` fires on a 4+ member
consolidation group and needs no history at all. `pf_ceiling` fires on a
predicted-files count at the top band, also history-free, but is evadable:
the predicted-files probe fails open to `[]` on any doubt, so an
under-predicted issue simply won't trip it. `multiple_of_median` fires when
an estimate is 3x or more of the batch's own historical median, and needs
trusted history to fire at all. The batch projection never reports a bare
`projected_total` when any issue's estimate is null. It carries a
`coverage_note` ("estimable K of N, M unknown") instead, so the preview
never reads more confident than the data underneath it.

**The `token_budget` guard runs underneath every real run, always on.**
`resolveTokenBudget()` accepts an absolute OUTPUT-token ceiling or a
relative `"Nx"` multiple of the batch's own historical median, run arg
winning over `profile.token_budget`. A relative spec with no trusted history
to multiply degrades to "guard off" rather than a false floor. Two checks
layer inside `drainUnit`, ahead of the existing `STOP.tripped` check: a hard
floor (`spentTokens() >= budget`) that needs no estimate at all, and an
estimate-aware pre-check layered on top of it (`spent + estimateByIssue[issue]
> budget`) that only fires when that unit carries a real number. `STOP`
gained a `kind` field so this proactive trip stays distinct from every
reactive breaker above: `state` reports `budget_halt`, not
`circuit_breaker`, and carries its own `resume_hint` (raise the budget or
split the remaining issues, then resume with `batch_branch`) instead of the
generic "an agent kept dying" framing the reactive breakers use.

**The sandbox has no filesystem, so the skill does the reading.**
`skills/mill/SKILL.md` reads `runs.jsonl`, parses each line, and passes the
array as `history` on every `Workflow()` call, dry_run and a live run alike,
because the estimator and the pre-check are both pure functions over that
array, not a file read. Skipping this step on a live run leaves the
estimate-aware pre-check permanently dark. The hard floor still runs either
way, since it needs no history to work.
