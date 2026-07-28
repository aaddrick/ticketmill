# Gate hygiene

Issue #162 made review findings a load-bearing artifact instead of prose a
human had to read to know whether anything needed fixing. This page covers
what changed: the finding shape, who assigns its id, the null-vs-empty
distinction three call sites now depend on, the three loop predicates and
why the merge gate's differs from the other two, and the one metric that
tells the difference apart after the fact.

## What a review finding is now

Before #162, `REVIEW_SCHEMA.issues` was `{type: 'array', items: {}}` — a
reviewer could put anything there, and nothing downstream read it. Fix
stages worked from `rev.comments`/`rev.summary`, prose a human (or a later
agent) had to parse to find the actual list of things to change. A finding
is now a typed object: `severity`, `summary`, and an engine-assigned `id`,
with an optional `recommendation` — the same required/optional split
`CHALLENGE_SCHEMA.findings` uses since #164 (see below); the `id` is the
one part of this shape that stays REVIEW_SCHEMA-only. The four
REVIEW_SCHEMA-producing prompts
(spec review, code review, quality review, test validation) all carry the
same `ISSUES_ASK` line tying the array to the verdict: every concern goes in
`issues`, a concern that only appears in `comments` will not be fixed, and
`changes_requested` with an empty `issues` is a contradiction the reviewer
should resolve by returning `approved` instead.

## The typed shape, and why CHALLENGE_SCHEMA gave up its extra required field

`CHALLENGE_SCHEMA.findings.items` (the contrarian gates' shape) and
`REVIEW_SCHEMA.issues.items` (the reviewer shape) now require the same two
fields, `severity` and `summary`, and both declare `recommendation` as an
optional string property. Both use the same three-value severity enum
(`critical`/`major`/`minor`). That parity is new: until issue #164,
`CHALLENGE_SCHEMA.findings.items` also required `recommendation`, on the
reasoning that a contrarian's job is to argue a case, so a finding without a
recommendation is an unfinished argument. Issue #164 retired that
requirement. A mandatory fix proposal turned out to be exactly the kind of
prompt elaboration that inflates rejection of correct work — a published
measurement tied it to rejecting correct code 26.2% -> 73.2% of the time —
and it fights the acceptance condition these same contrarian prompts already
state: zero critical/major findings is the expected, unremarkable outcome of
a challenge, not a failure to produce one. Requiring a `recommendation` made
a finding cheaper to emit than to withhold, pushing challengers toward the
opposite of that stated condition.

The reviewer-side half of the original reasoning survives this change
unchanged: a reviewer's job is closer to code review — "this is wrong" is a
complete, actionable finding on its own, and forcing a `recommendation` for
every nit would train reviewers to pad the field rather than skip it. That
was true before #164 and remains the reason `REVIEW_SCHEMA.issues.items`
never required the field in the first place; #164 just brought the
contrarian shape into line with it rather than changing it.

This parity is schema-level only. `ISSUES_ASK` — the shared prompt line
every `REVIEW_SCHEMA` reviewer sees — still asks in prose for "severity,
summary and a recommendation," unchanged by #164, so the two paths still
read differently to a model even though a response omitting
`recommendation` now validates identically on both. Reconciling that prose
with the schema is out of scope here. `issues` itself also stays out of
`REVIEW_SCHEMA.required` — a reviewer that never mentions the field at all
is a different, and explicitly supported, case (see below) — and `id` is
never part of either schema. The model never assigns an id, on either
path.

Issue #164 reworded the "findings ARRAY" prompt line at all three
contrarian gates that have one — consolidation, approach, and plan — not
only the approach and plan gates its issue body named. All three now ask
for the array itself as mandatory, `severity` and `summary` as required
fields, and a `recommendation` only when the challenger has a concrete fix
to propose, rather than treating a missing one as a defect in the finding.

Dropping `recommendation` from `required` changes nothing at render time.
Every one of the five challenge render sites — the consolidation, approach,
and plan gates' revise/re-plan prompts, plus the approach and plan gates'
in-loop unresolved-caveat lines — already reads the field as
`(f.recommendation || '')`, so an absent `recommendation` and an
empty-string one were already indistinguishable output before #164; the
schema change just makes the absent case reachable without failing
validation first. `findingsBlock()`, the analogous render path on the
`REVIEW_SCHEMA` side, coerces the same way — but it is a separate function
serving reviewer findings, not one of the five, and it also prefixes each
line with the engine-assigned `id` that challenge findings never carry (see
below).

## Why the engine assigns the id, not the model

Ids are assigned by `normalizeFindings(raw, source)`, one call per reviewer
per iteration, as `source + '-' + (i + 1)` — `code-i2-3` is the third
finding from the code reviewer's second iteration. Three reasons this lives
in engine code rather than the schema:

- **Stability.** The same finding must render the same id in the review
  comment, the fix stage's prompt, and the fixed agent's `fixes_applied`
  echo, across however many turns those spread over. A model re-asked to
  produce an id (even a stable-looking one like `"finding-1"`) has no
  mechanism to guarantee it matches its own earlier output byte for byte.
- **Collision safety.** Two reviewers run in parallel in the merge gate
  (spec and code review). If either invented its own ids, `finding-1` from
  one collides with `finding-1` from the other the moment their findings
  are concatenated into one `recordGateOutcome` call. Engine-assigned ids
  are namespaced by `source` (`spec-i2`, `code-i2`, `quality-<prefix>-i1`,
  `test-i1`) specifically so no two gates or reviewers can ever produce the
  same id.
- **No spoofing surface.** Keeping `id` out of the schema means a reviewer
  cannot invent an id that looks like it belongs to a different gate or
  iteration, and a fix stage's `fixes_applied` echo (see below) can be
  trusted to name a real, engine-assigned finding rather than a string the
  reviewing model made up.

## Absent vs. empty: two different signals, not one

`normalizeFindings(raw, source)` returns `null` when `raw` is not an array —
the reviewer omitted `issues` entirely — and an arity-preserving array
otherwise, including a genuinely empty array (`raw = []`). These are not the
same thing and every call site treats them differently:

- **`null` means "no structured signal at all."** The reviewer's response
  degrades to today's prose path, byte-for-byte: `findingsBlock()` falls
  back to `comments` (then `summary`, then a caller-supplied label) exactly
  as fix stages rendered before #162 existed. This is the compatibility
  leg — a reviewer that doesn't yet know about `issues`, or a schema
  validator that stripped an unrecognized shape down to nothing, still
  produces a working prompt for the fix stage, and `changes_requested` with
  `issues` omitted still routes to a fix stage, matching pre-#162 behavior.
- **`[]` means "the reviewer looked, and found nothing to fix."** This is a
  real, structured signal, not the absence of one. A reviewer that
  validates `issues: []` alongside `changes_requested` is telling the
  engine there is nothing actionable — and the engine takes that at its
  word rather than dispatching a fix stage with an empty job list.

`nothingToFix(r, f)` — used only by the merge gate — encodes this precisely:
`r.result === 'approved' || (f !== null && f.length === 0)`. Note that
`f === null` is deliberately **not** nothing-to-fix on its own: with no
structured signal at all, a prose-only `changes_requested` still goes to the
fix stage. Only a present-and-empty array counts as "this reviewer, alone,
has nothing left."

## The three loop predicates, and why the merge gate's differs

Three loops key their exit off findings now: the quality loop (task-level
review inside implementation), the test loop (test validation), and the
merge gate (`reviewAndMerge`'s spec + code review). All three still exit
clean on `result === 'approved'`. The two internal loops add one more clean
exit: **a single reviewer's normalized findings array is present and
empty** — `revFindings !== null && revFindings.length === 0` in the quality
loop, `vFindings !== null && vFindings.length === 0` in the test loop. Each
of those loops has exactly one reviewer, so "this reviewer has nothing to
fix" and "this gate iteration is clean" are the same fact.

The merge gate has two reviewers running in parallel (spec and code), and
their outcomes are decoupled: reviewer A can approve while reviewer B
requests changes with real findings, or both can request changes for
different (or no) reasons in the same iteration. Collapsing "one reviewer
has nothing to fix" to "the gate is clean" would be wrong here — the other
reviewer might still have real work outstanding. So the merge gate keeps two
distinct predicates instead of one:

- **`prReviewClean`** = `spec.result === 'approved' && code.result === 'approved'`.
  This is the *only* condition that may set `approved = true` and let the
  PR proceed to merge. It is unchanged from before #162.
- **`bothNothingToFix`** = `!prReviewClean && nothingToFix(spec, specFindings) && nothingToFix(code, codeFindings)`.
  This is a *new*, strictly weaker condition: both reviewers, independently,
  have nothing actionable, but at least one of them still formally requested
  changes (so `prReviewClean` is false). It answers a narrower question than
  `prReviewClean` — not "is the PR good enough to merge" but "would sending
  this to a fix stage accomplish anything" — and the answer to those two
  questions is allowed to differ.

## The empty-findings exit at the merge gate: needs_human, not merge

When `bothNothingToFix` is true, the merge gate does **not** approve the PR.
It breaks out of the review loop without setting `approved = true`, landing
on the same `needs_human` path a capped-out iteration already used
(`fail(ctx, 'needs_human', 'pr-review', ...)`). The reasoning: a
`changes_requested` verdict — even one carrying zero structured findings —
is not consent to merge. A permissive predicate here would let
`changes_requested` reach `gh pr merge --squash` on the strength of an
engine-side interpretation of "nothing to fix," which is exactly the kind
of judgment call that belongs to a human, not a loop predicate. The
iteration's `recordGateOutcome` call tallies this as `carried-unresolved`,
the same disposition string a capped-out iteration with real findings still
open would produce. `computeGateYield` hard-codes exactly four disposition
keys (`accepted`, `carried-unresolved`, `re-litigated`, `dismissed`); adding
a fifth would be silently dropped from every rollup that reads
`gate_findings`, so this reuses the existing vocabulary rather than
introducing one. The two `carried-unresolved` causes — cap reached with open
findings, and both reviewers independently satisfied with nothing to fix —
are distinguished only by `ctx.metrics.findings_empty_exits` and the human-
readable `haltReason` text carried into the `fail()` call, not by a new gate
outcome string.

## `findings_empty_exits`: the counter that tells the two apart

`ctx.metrics.findings_empty_exits` increments at all three empty-findings
exits: the quality loop, the test loop, and the merge gate's
`bothNothingToFix` break. It is a single run-wide counter, not one per gate
— its job is to answer "how often did this run treat an empty findings
array as a clean-enough (or at least fix-nothing) exit" across the whole
issue, not to attribute that count to a specific gate. Reading it alongside
`gate_findings[<gate>].disposition['carried-unresolved']` tells you whether
a given carried-unresolved tally at the merge gate was a real cap-out with
findings still open, or an empty-findings exit that never reached the cap.

The quality loop and test loop exits are visible outside `ctx.metrics` too.
Each one pushes a `VERIFY_SKIPS` entry, the same mechanism a capped
contrarian challenge or a skipped test loop already uses, so a
`changes_requested` verdict converted to clean surfaces in the batch PR's
Verification Gaps section instead of sitting only in a metric and a
`pushDecision()` note a human has to go looking for. The merge gate's own
empty-findings exit needs no separate `VERIFY_SKIPS` entry: it already lands
on `needs_human`, which is visible on its own (see above).

## Fix stages echo finding ids back through `fixes_applied`

Every fix stage fed by `findingsBlock()` (quality-fix, test-quality-fix,
pr-fix) is asked, via the shared `fixesAppliedIdAsk(example)` helper, to
prefix each `fixes_applied` entry with the id of the finding it resolves —
for example `"[code-i1-2] tightened the null guard"`. This closes the loop
`normalizeFindings` opened: a finding's id is stable from the moment the
engine assigns it, through the `findingsBlock()` render the fix agent reads,
to the `fixes_applied` line a human (or a later reviewer) reads back. It is
advisory, not schema-enforced — `FIX_SCHEMA.fixes_applied` is still a plain
array of strings — but it is the same low-cost, high-value pattern
`COMMIT_SHA_ASK` uses elsewhere in this file: ask for a specific, checkable
shape in the prompt rather than adding validation machinery for a
low-stakes field.

## The escaped-defect baseline shift

`computeGateYield` derives its `escaped` per-issue flag from
`gate_findings['pr-review'].count` — the SAME count field the merge gate's
`recordGateOutcome` call now populates from every one of both reviewers'
normalized findings, at *any* severity. An issue is flagged as an escaped
defect when that count is greater than zero while its early gates
(`approach`, `plan`) recorded no findings of their own (and weren't simply
dismissed for a dead challenger — see the `earlyOnlyDismissed` guard in
`computeGateYield`). Before #162, the merge gate already passed
`(spec.issues || []).concat(code.issues || [])` into `recordGateOutcome`,
and `recordGateOutcome` counts array length regardless of entry shape — so
`gate_findings['pr-review'].count` was already populated with real signal,
but only incidentally: it depended on a reviewer choosing to put a concern
in the untyped `issues` array rather than in free-text `comments`, with
nothing asking for one over the other. Now that the four rewritten prompts
ask reviewers to put every concern into `issues` rather than leaving it in
`comments`, that same count field is guaranteed and schema-backed rather
than incidental — which is the count `computeGateYield` was already reading
on one side of the `escaped` comparison. The result: the first batch report produced after
this change can show escaped defects on issues where an earlier run,
against the same reviewer behavior, would have shown none. That is a
baseline shift in what the metric can see, not a regression in what the
merge gate catches — the defects were always there in reviewer prose; they
just weren't structured, so they never reached `gate_findings`. Redefining
`escaped` to key off `severity.critical + severity.major` instead of the
flat `count` (so a pile of `minor` findings doesn't read the same as one
`critical`) is a natural follow-up, and is explicitly out of scope here.

## The quality gate

The quality loop (`runQualityLoop`, called once per task and once per
PR-fix round) is the fourth gate to record outcomes through
`recordGateOutcome`, after `approach`, `plan`, and `pr-review`. Its shape
differs from those three in ways worth spelling out: it has one reviewer
instead of two, it runs `MAX_QUALITY_ITERATIONS` times per *call* rather
than per issue, and its cap line has to survive being called several times
over the life of one issue without flooding the batch PR.

### The five-branch disposition map

Every iteration of the loop takes exactly one of five branches, and every
branch ends in exactly one `recordGateOutcome(ctx, 'quality', findings,
disposition)` call, placed immediately after the branch's verdict is known
and before (or instead of) the fix stage that verdict triggers:

- **Simplify agent dies.** `[] / 'dismissed'` — no review verdict was ever
  reached, so there is nothing to tally as a finding.
- **Review agent dies.** `[] / 'dismissed'` — same reasoning, one step later
  in the loop.
- **`rev.result === 'approved'`.** `revFindings || [] / 'accepted'` — a
  genuine clean verdict from the one reviewer this loop has.
- **The empty-findings exit.** `changes_requested` with `revFindings`
  present and empty (`revFindings !== null && revFindings.length === 0`) —
  `revFindings || [] / 'carried-unresolved'`. See below for why this is
  `'carried-unresolved'` and not `'accepted'`, even though the loop treats
  it as clean and sets `approved = true`.
- **`changes_requested` with real findings.** `revFindings || []`, with the
  same ternary the merge gate's `prReviewDisposition` uses: `iter ===
  MAX_QUALITY_ITERATIONS ? 'carried-unresolved' : 're-litigated'` —
  carried-unresolved only on the last iteration the loop is allowed to
  spend, re-litigated on every iteration before it.

The five-branch disposition map above stays five branches even though a
third death — the fix agent, not the simplify or review agent — can also
end an iteration: that death happens in the fix stage, *after* the
iteration's disposition is already recorded by one of the branches above,
so it never needs a disposition branch of its own. All three deaths `break`
immediately, the same way the loop's two clean exits leave no further work:
an issue can leave one call to this loop having recorded at most one
disposition per iteration it actually entered, never more.

### The invariant: sum(disposition) === quality_iters

`ctx.metrics.quality_iters++` fires exactly once per iteration, at the top
of the loop body, and — critically — *after* the loop's `STOP.tripped`
check, which returns `'halted'` before either statement runs. An iteration
either exits before `quality_iters` increments (the STOP path, which
returns immediately and touches nothing else) or it increments
`quality_iters` and then, on every one of the five branches above, calls
`recordGateOutcome` exactly once before the iteration ends — whether that
end is a `break` or a loop back around for another `iter`. No branch
increments `quality_iters` without also recording a disposition, and no
branch records a disposition without having incremented `quality_iters`
first. The result is exact and unconditional, per issue, with no
adjustment for STOP or anything else:

```
sum(gate_findings.quality.disposition) === ctx.metrics.quality_iters
```

This is the same one-disposition-per-iteration-entered discipline every
disposition-recording loop in this file keeps — see the merge gate's
`prReviewDisposition` call and the approach/plan contrarian gates' accept
and cap branches — but it is worth stating explicitly for quality, because
`quality_iters` is a single run-wide counter summed across every call to
`runQualityLoop` for an issue (one per task, one per PR-fix round), not a
per-call count, so the invariant has to hold across calls, not just within
one.

`quality_scopes` is `quality_iters`'s companion counter, and it counts a
different thing: calls, not iterations. `if (iter === 1)
ctx.metrics.quality_scopes++` sits inside the same loop body as
`quality_iters++`, below the same `STOP.tripped` guard described above, but
it only fires on a call's first iteration. A STOP'd entry therefore still
touches nothing — the guard returns before either statement runs, the same
fact the invariant above already establishes for `quality_iters` — and
because the increment fires at most once per call, `quality_scopes` can
never exceed the number of loops an issue actually entered, regardless of
how many iterations any of them ran. `computeFriction` is its only
consumer; see "The friction denominator: pooled, not worst-scope" below for
what it pools against.

### Why the empty-findings exit tallies carried-unresolved but returns approved

The empty-findings exit sets `approved = true` — the loop treats it as
clean, the same predicate the earlier section on this page already
establishes for the quality loop specifically — but it records
`'carried-unresolved'`, not `'accepted'`. This is deliberate, and it is the
same choice the merge gate already makes at its own empty-findings exit
(`bothNothingToFix`, described above): a `changes_requested` verdict is not
consent, even when it carries zero structured findings, and
`recordGateOutcome` should not launder that into the same disposition
string a genuine `approved` verdict earns.

Two things anchor this specifically to the quality gate:

- **`computeGateYield`'s accepted:dismissed ratio.** The Gate Yield table
  renders `accepted / (accepted + dismissed)` as a compact per-gate health
  signal — verdicts that closed clean, out of verdicts that could speak at
  all (`dismissed` means the reviewer died, not that it judged and
  rejected). Tallying the empty-findings exit as `'accepted'` would inflate
  that ratio with iterations the reviewer never actually approved; keeping
  it as `'carried-unresolved'` — a bucket the ratio's denominator doesn't
  touch — keeps `accepted` meaning only "the reviewer said approved," full
  stop. The exit stays visible in the table anyway, in the `Carried` column
  rendered beside the ratio for exactly this reason.
- **The approach contrarian gate's precedent.** The contrarian gates already
  use `'carried-unresolved'` for an iteration that falls short of a clean
  resolution without an agent dying: the approach challenge's
  cap-with-caveats branch (`recordGateOutcome(ctx, 'approach', ch.findings,
  'carried-unresolved')`) fires when the cap is reached and the run
  proceeds anyway, "WITH UNRESOLVED CAVEATS." The quality loop's
  empty-findings exit is a variant of the same idea — a verdict that is not
  the reviewer's unqualified sign-off — tallied with the disposition this
  codebase already uses for "proceeded without a clean resolution," rather
  than inventing a fifth. `computeGateYield` hard-codes exactly four
  disposition keys; a fifth would be silently dropped from the rollup.

### What quality_degrades counts, and what it doesn't

`ctx.metrics.quality_degrades` increments once per call to `runQualityLoop`
where `degraded` is `true` on exit — the two agent-death branches in the
disposition map above (simplify dies, review dies), plus a third that
sits outside that map: the fix agent dying in the fix stage, after that
iteration's disposition is already recorded. It does **not** increment on cap
exhaustion: a loop that spends all `MAX_QUALITY_ITERATIONS` iterations
re-litigating and never reaches a clean review sets neither `approved` nor
`degraded`, and falls through the loop tail the same as a converged loop,
just without `approved` ever having been set. The name reads like "quality
regressed"; what it actually counts is narrower — an agent died inside this
loop. Cap exhaustion's own signal lives at
`gate_findings.quality.disposition['carried-unresolved']`, via the
last-iteration branch of the five-way map above, not in `quality_degrades`.
The `FRICTION_WEIGHTS` comment carries this same clarification next to the
weight itself; the name stays as-is rather than being renamed, so this
change doesn't carry an unrelated rename along with it.

### The one-line-per-issue cap roll-up

Cap exhaustion — `!approved && !degraded` at the loop tail, the state left
by every iteration recording `'re-litigated'` or a final
`'carried-unresolved'` without ever reaching a clean review — gets exactly
one `VERIFY_SKIPS` entry per issue, not one per call. `runQualityLoop` runs
once per task plus once per PR-fix round, so an issue with several tasks
(or several PR-fix rounds) capping out would otherwise print one line per
call and flood the batch PR's Verification Gaps section with
near-duplicate entries for the same issue.

The roll-up works by rewriting a remembered slot instead of pushing a new
line each time: `ctx.quality_caps` collects the human-readable scope label
(`"task 3"`, `"PR-fix round 2"`) for every call that caps out, and
`ctx.quality_cap_skip_index` remembers where in `VERIFY_SKIPS` that issue's
one line lives. The first cap on an issue pushes a new entry and records
its index; every subsequent cap on the same issue rewrites that same index
in place with the updated scope list joined into one message. `VERIFY_SKIPS`
is append-only elsewhere in the engine, so rewriting a remembered index
stays valid even under pool concurrency — nothing else can have inserted
itself at that index in between. Both fields are lazily initialized (`if
(!ctx.quality_caps) ctx.quality_caps = []`, not part of the `ctx` object
literal `processIssue` builds) because `tests/harness.js`'s `makeCtx()`
enumerates `ctx`'s fields explicitly, and adding either field to the
canonical literal would mean updating that enumeration for something most
tests never touch.

The line's wording deliberately claims nothing about the PR's fate: this
loop can also exit through the degrade-window halt immediately below it in
the source, which both callers (`reviewAndMerge`, the per-task loop) turn
into a hard `fail()`. A capped-then-halted issue still gets its roll-up
line, so the wording has to hold for both outcomes — it says the review
never came back clean, not that anything merged.

### The friction denominator: pooled, not worst-scope

`computeFriction`'s quality driver divides the run-wide `quality_iters`
total by a run-wide cap, `MAX_QUALITY_ITERATIONS * quality_scopes`, rather
than the single-loop cap every other capped stage compares against. Issue
#165 is what motivated this: `quality_iters` sums iterations across every
call an issue made to `runQualityLoop` (one per task, one per PR-fix
round), so comparing that sum to one loop's cap let a multi-task issue that
cleared quality cleanly on every task still saturate the ratio to 1.0, the
same score a genuinely capped-out issue earns. Five things about the fix
are worth stating plainly, because more than one shape of fix was on the
table.

1. **Why pooled, not worst-scope (the adjudicated reason).** Pooled divides
   one run-wide sum by one run-wide cap — a mean of each call's cost
   against the cap it was actually allowed. The rejected alternative —
   track the worst single scope's iteration count and ratio that alone
   against the cap — is a max, not a mean. A max does not fix the problem
   this issue was filed over, it relocates it: one capped scope, out of
   however many tasks and PR-fix rounds an issue actually ran, would still
   pin the WHOLE issue's quality term at 1.0 forever — the same "one bad
   scope reads like every scope going badly" shape the issue's own Change
   section complains about, just moved onto a different axis. Pooling is
   the formula that lets an issue's quality friction reflect all of its
   scopes rather than its single worst one. A secondary point, not the
   deciding one: pooled also keeps the `quality` driver's rendered `value`
   as the raw `quality_iters` the metrics blob already carries, needing no
   new field; a worst-scope formula's number would appear nowhere in
   `ctx.metrics`. That legibility point is real but subordinate to the
   mean-versus-max argument above.
2. **The accepted cost: non-monotonicity.** Pooling is not monotone in
   `quality_iters`. A single-task issue that caps out on its only quality
   call scores `5/5 = 1.0`; the same issue, with a PR-fix round added that
   clears quality on that round's first iteration, scores `6/10 = 0.6` —
   MORE total quality re-work (6 iterations spent, not 5) yet a LOWER
   friction score. This is accepted, not overlooked, because diluting the
   ratio this way is safe: cap exhaustion is not this metric's job to
   preserve. It is carried by two channels that don't dilute —
   `ctx.quality_caps`'s one-per-issue `VERIFY_SKIPS` line (see "The
   one-line-per-issue cap roll-up" above) and
   `gate_findings.quality.disposition['carried-unresolved']` — and it is
   NOT carried by `quality_degrades` (see "What quality_degrades counts,
   and what it doesn't" above: that counter fires only when an agent dies
   inside the loop, never on cap exhaustion). Friction dilutes; visibility
   of the cap-out does not.
3. **Acceptance criterion 1, in its strongest form.** The issue asks for a
   multi-task issue where every quality loop passed on iteration 1 to score
   `0` on the quality term. Read literally, that criterion is unmet by both
   formulas the issue sanctions — the adopted pooled ratio and the
   worst-scope alternative it names as acceptable — on a fixture where
   every call's first iteration is also its last: both compute `1/5 = 0.2`
   per scope, one iteration actually run against a five-iteration cap, not
   `0`. That is not a defect unique to pooling; it is a fact about the
   issue's own Change section, which defines the ratio as `min(1,
   iters/cap)` counting from 1 on a clean pass, not from 0. A formula that
   scores exactly `0` on this fixture would have to be piecewise —
   exempting iteration 1 specially, and only for multi-scope issues, since
   the single-scope case already produced `0.2` under the pre-this-change
   formula and nothing asks for that to change. `0.2` is the
   sibling-consistent answer: it is what every other capped stage in this
   file already scores on a same-shape one-clean-iteration case.
4. **The corrected invariant pair.** Stage drivers (`weight: null`) satisfy
   `contribution === Math.min(1, value / cap)` and `cap === baseCap *
   (scopes ?? 1)`, where `value` is the stage's raw metric (`quality_iters`
   for the quality driver) and `baseCap` is that stage's `MAX_*` constant.
   Signal drivers (a numeric `weight`) satisfy `value * weight ===
   contribution`. Every entry in the `drivers` array is one shape or the
   other.
5. **Why `scopes` is `null`, not `1`, on the other six stage drivers.**
   Only the quality driver carries a `scopes` count backed by an actual
   counter. `task_review_attempts` and `browser_iters` are multi-scope
   aggregates in exactly the same sense `quality_iters` is —
   `task_review_attempts` sums across every task's own review-attempt
   loop, `browser_iters` sums across the `implement` and `pre-merge` calls
   to `runBrowserCheck` — but neither has a scope counter backing it yet.
   Giving them `scopes: 1` would be a false claim: it would assert those
   aggregates were pooled over exactly one invocation, when the aggregate
   is provably drawn from more than one. `null` claims nothing, which is
   the honest state for both of them; pooling `task_review_attempts` and
   `browser_iters` the same way this change pools `quality_iters` is a
   natural follow-up, out of scope here. The remaining four stages
   (`approach`, `plan`, `test`, `pr-review`) are genuinely single-scope —
   one loop, one call, per issue — so `scopes: null` there means "no scope
   count applies," not "not yet counted."

Quality friction scores computed under this pooled denominator are not
comparable to quality friction scores from a run predating this change: the
same issue, run twice, can report a different quality contribution for
reasons that have nothing to do with how hard it fought. Compare quality
friction only within reports generated by the same version of this engine.

## Rebuttal: a finding is a hypothesis, not a command (issue #167)

Before this issue, a fix agent shown a reviewer's findings had exactly two
moves: comply, or return `status: 'error'` and degrade the whole gate. There
was no schema field for "I checked this and the reviewer is wrong" — a
fixer that disagreed either silently rewrote code to satisfy a finding it
believed was mistaken, or burned a `status: 'error'` disproportionate to the
actual disagreement. This section covers the fix: a `rebutted` field on
`FIX_SCHEMA`, a shared prompt framing that tells a fixer a finding is a
hypothesis to verify rather than an instruction to obey, and the
deterministic machinery that keeps a rebut-everything round from quietly
passing as a resolved gate.

### What a rebuttal is, and the evidence it must carry

`FIX_SCHEMA.rebutted` is `[{finding_id, evidence}]`. A fixer that judged a
rendered finding wrong records it here instead of touching code for it.
`evidence` is not "I disagree" — the shared prompt framing asks for "the
concrete check you ran that disproves it (a command, a line reference, a
test result — not just disagreement)." That concrete-evidence bar is
prompt-only: it cannot be checked mechanically, since the engine has no way
to judge whether a string is actually a command, a line reference, or a
test result versus prose that merely looks like one. What `normalizeRebuttals`
enforces mechanically is narrower — only non-blankness: an entry with a
blank `evidence` (or a blank `finding_id`) is silently dropped, so literally
empty disagreement can never survive normalization, but a non-blank
`evidence: 'I disagree'` passes every mechanical check and becomes a
rebuttal the engine acts on. A rebuttal can also only target a finding the fixer was
actually shown with a bracketed id (e.g. `[code-i1-2]`) — the same
`normalizeFindings`-assigned id `findingsBlock()` prefixes onto every
rendered finding line. Anything a fixer sees only as prose (`comments`,
`summary`) has no id to rebut against; it must be fixed outright or
addressed in the fixer's own `summary`. This is enforced twice, once as an
instruction (the last clause of the shared framing below) and once
mechanically (`normalizeRebuttals` matches `finding_id` against exactly the
finding set rendered to that fixer, and drops anything that doesn't match —
see below).

### Three evaluator-fed gates, not five

The shared framing lives in one constant, `FINDING_HYPOTHESIS_ASK`, wired
into exactly three fix prompts: quality-fix, test-quality-fix, and pr-fix.
These three share a trait the other two fix stages don't: their findings
come from a reviewer's *judgment* of the diff — a code reviewer, a test
validator, a spec/code reviewer pair — which can be wrong the same way any
review can be wrong. That is genuinely a hypothesis to verify.

The two oracle-fed fix stages, test-fix and browser-fix, are deliberately
untouched. Their "findings" are not a reviewer's opinion; they are the
direct output of running something — a failing test, a broken page
interaction — which is ground truth, not a judgment call. Both already
carry a correct anti-rebuttal guard that predates this issue: test-fix
reads "Fix the real defect — do NOT delete or weaken assertions just to
make the failure disappear," and browser-fix reads "Fix the real defect —
do NOT hide the symptom (e.g. removing the interaction that fails)." Wiring
`FINDING_HYPOTHESIS_ASK`'s "verify before acting, rebut if wrong" framing
into either of those prompts would tell the same fixer, in the same
response, to treat a failing assertion or a broken click as a hypothesis it
might disprove — directly inverting a guard that exists precisely because a
fixer's own doubt about a failing test is not evidence the test is wrong.
This is why the framing is scoped to exactly three gates rather than all
five fix stages that share `FIX_SCHEMA`.

### `FIX_SCHEMA.rebutted` is schema-wide; only three sites read it

`FIX_SCHEMA` is one shared schema feeding every `agent()` call that returns
a fix — six call sites in total: quality-fix, browser-fix, test-fix,
test-quality-fix, the per-task review fix, and pr-fix. Adding `rebutted` to
`FIX_SCHEMA` makes it schema-valid at all six; nothing in the schema itself
scopes it to the three evaluator-fed gates. The scoping is enforced by
control flow instead: `normalizeRebuttals(fix.rebutted, findings)` — the
sole consumer of the field — is only ever called at quality-fix,
test-quality-fix, and pr-fix. The other three fix stages never read
`fix.rebutted` at all. A model at test-fix, browser-fix, or the task-review
fix that populates `rebutted` anyway (nothing in the schema stops it) gets
no framing telling it the field exists, and the engine silently ignores
whatever it returned — those three fixers behave identically to before this
issue, byte for byte. This mirrors the precedent `REVIEW_SCHEMA.issues`
already set: `rebutted` stays out of `FIX_SCHEMA.required`, so a fixer that
never disagrees — the entire population before this issue, and every
oracle-fed or task-review fixer after it — omits the key and produces an
unchanged response.

### `normalizeRebuttals`: every drop fails toward today's behavior

`normalizeRebuttals(raw, findings)` turns the raw `rebutted` array into the
validated list the three evaluator-fed gates act on. Every failure mode
drops the offending entry rather than trusting it: a non-array `raw`
(including the omitted-field case, the common one) returns `[]`; an entry
with a blank `finding_id` or blank `evidence` is dropped; an entry whose
`finding_id` doesn't match any id in `findings` — the exact,
possibly-`null` array actually rendered to that fixer (the union of
`specFindings`/`codeFindings` at pr-fix, since one fixer sees both
reviewers' blocks in one prompt) — is also dropped. There is no failure
path that trusts an unverifiable or spoofed rebuttal; a dropped entry is
simply absent from the list the gate acts on, the same as if the fixer had
never mentioned it, so a malformed or fabricated rebuttal degrades to
silence rather than to something the engine might mistakenly honor.

### The three per-gate exits, and why only `pr-review` can block a merge

All three evaluator-fed gates share one predicate, evaluated after a fix
stage returns: a round is rebuttal-only when it rebutted at least one
finding and applied none (`normalizeRebuttals(...).length > 0 &&
fixes_applied.length === 0 && files_changed.length === 0`). What each gate
does with that fact differs, because the three gates don't carry the same
stakes:

- **quality-fix** cannot block a merge — `runQualityLoop` only gates one
  task's implementation or one PR-fix round's cleanup. A rebuttal-only round
  there sets a third loop-exit flag (`rebutted`, kept separate from
  `degraded` so it doesn't inflate `quality_degrades` or trip the rolling
  degrade window) and stops the loop immediately rather than spending its
  remaining iterations re-litigating a dispute only a reviewer or a human
  can adjudicate. `retypeGateDisposition` moves that iteration's
  already-booked disposition to `carried-unresolved` after the fact.
- **test-quality-fix** cannot block a merge either — `runTestLoop` only
  ever returns `{ ok: true }` or `{ ok: false }` for a dead agent; a
  rebuttal-only round there returns `{ ok: true }`, the same clean-exit
  shape the loop uses elsewhere, so nothing routes through a path that
  could fail the run. Unlike quality, this loop books no `gate_findings`
  entry at all (`test-quality` isn't one of the four gates
  `recordGateOutcome` tracks), so there is no disposition to retype here —
  the round is visible only through `ctx.contested` and the metrics counter
  below.
- **pr-fix** is the one gate whose clean verdict (`prReviewClean`, both
  reviewers approved) is the *only* condition that may set
  `reviewAndMerge`'s `approved = true` and let the PR proceed to
  `gh pr merge --squash`. Treating a rebuttal-only round there as a clean
  exit the way quality and test-quality can would let a fixer's own,
  unadjudicated disagreement stand in for a reviewer's approval — exactly
  the judgment call this codebase already reserves for a human (see the
  empty-findings exit above, which reasons the same way about
  `changes_requested`). So pr-fix does not exit on a rebuttal-only round;
  it `continue`s the review loop into another iteration instead, with the
  disputed findings now carried in `contestedBlock` for the next reviewer
  to adjudicate. `retypeGateDisposition` fires here too, moving the
  iteration's booked disposition to `carried-unresolved` — on every
  rebuttal-only round, not just the first, including the halting one below.

A local counter, `rebuttalRoundsUsed`, permits exactly ONE rebuttal-only
pr-fix round per `reviewAndMerge()` call before this gate stops giving a
disputing fixer another iteration: a second one in the same call sets
`haltReason` and breaks into the existing `needs_human` path, the same
shape as the `bothNothingToFix`/`capReached` breaks above it, rather than
`continue`-ing indefinitely. There's no id-equality check guarding that
counter because none is needed: `REVIEW_SCHEMA` ids are
`source + '-' + (i + 1)` with the iteration baked into `source`, so a
second round's ids are disjoint from the first round's by construction —
`rebuttalRoundsUsed` alone is sufficient. Unlike the quality/test loops,
pr-fix does not push a second `pushDecision` on a rebuttal-only round
either; the `pushDecision` already fired for every non-error fix, right
after the stage returns, covers it.

### `contestedBlock` versus `settledBlock`: a deliberate contract inversion

`contestedBlock(ctx)` renders `ctx.contested` — the list a rebuttal-only
round pushes onto — back to the *next* reviewer at all three review prompts
that already render `settledBlock`. It is shaped like `settledBlock` on
purpose (same defensive read, same last-6 window, same `''`-when-empty
render) but it carries the opposite trust contract, and that inversion is
deliberate, not an oversight to reconcile:

- `settledBlock` renders a decision an earlier gate already *adjudicated* —
  its instruction is "don't re-open this without new evidence; re-litigating
  a settled decision without new evidence is itself a process failure."
- `contestedBlock` renders a rebuttal nobody has adjudicated yet — its
  instruction is the opposite: verify the fixer's evidence yourself, drop
  the finding if it holds, re-raise it as a finding this iteration if it
  doesn't, and never let it sit contested indefinitely with neither
  outcome. It also carries an explicit override: whichever iteration-2+
  instruction the same prompt carries elsewhere — code review's "don't
  re-flag issues already addressed or accepted," spec review's "stay
  consistent with your own prior reviews" — does NOT apply to anything in
  this block, because a contested finding is neither already addressed nor
  previously ruled on.

Reusing `settleDecision()`/`settledBlock()` for a rebuttal would tell the
next reviewer to treat an unadjudicated dispute as already-settled, which
is precisely the failure mode this whole framing exists to avoid: a
fixer's own say-so standing in for a real verdict. `contestedBlock` never
calls `settleDecision()` — and, as of this issue, nothing else removes an
entry from `ctx.contested` either. There is no code path that closes a
contested entry: a reviewer's verify-then-drop-or-re-raise ruling is
advisory prose in that review's own response, not a ledger mutation, so a
contested entry persists for the life of the issue and keeps re-rendering
to every later review of that gate — including a quality-review at task N
re-rendering an entry a task-1 rebuttal-only round contested — no matter
how many iterations follow the round that contested it, and even after a
later reviewer has actually ruled on it in prose. Closing the ledger entry
once a later review rules on it is a known gap left for a follow-up issue,
not a design decision.

### `rebuttal_only_rounds`: at `pr-review`, the first increment is a continuation, not an exit

`ctx.metrics.rebuttal_only_rounds` increments at all three rebuttal-only
exits above — quality, test-quality, and pr-review — the same run-wide,
not-per-gate shape `findings_empty_exits` already uses. At quality and
test-quality, every increment corresponds 1:1 with an exit from that loop:
the loop stops, the round is done. At pr-review, that is NOT true for the
first increment in a given `reviewAndMerge()` call: a single rebuttal-only
pr-fix round `continue`s into another review iteration rather than halting,
so `rebuttal_only_rounds` going from 0 to 1 on an issue can mean nothing
more than "the merge gate looped once more" — the same issue can still go
on to reach `prReviewClean` cleanly on a later iteration. A *second*
rebuttal-only round in the same call is a halt, not a continuation, joining
the cap-reached and empty-findings breaks on the `needs_human` path — but
the counter does not increment on that second round: it tracks
continuations, not rounds, and the halt is already carried by `haltReason`
and the `needs_human` status, so counting it again would double-book a
signal the status code already carries. Since `pr-fix` runs at most at
iterations 1 and 2 of `MAX_PR_REVIEW_ITERATIONS = 3`, this still bounds an
issue to at most two rebuttal-only pr-fix rounds regardless of what the
counter reads. Reading `rebuttal_only_rounds` at pr-review without also
checking whether the issue ultimately reached `approved` will misread a
continuation as a stall.

One gap worth naming plainly rather than leaving implicit: `rebuttal_only_rounds`
is not one of `FRICTION_WEIGHTS`' drivers, and `test-quality` has no
`gate_findings` entry to retype in the first place (see above), so a
rebuttal-only round at test-quality is invisible to `computeFriction` and to
every `gate_findings` rollup — it shows up only in this counter, in
`ctx.contested`/`contestedBlock`, and in its own `VERIFY_SKIPS` line. This
is accepted, not overlooked: a rebuttal genuinely costs less rework than a
fix round did, and the two gates that do retype a disposition
(quality, pr-review) still carry the signal into `gate_findings` where a
rollup can see it.

## Durable per-issue gate state

Issue #166 gave every issue a durable record of its own gate/contrarian
history, carried on the issue itself so it survives a run boundary.
`processIssue` builds a fresh `ctx` on every invocation — `settled: []`,
`ctx.metrics.pr_review_iters: 0`, and so on — and the `process_pr` resume
path (a healed run that finds an open PR and jumps straight to
`reviewAndMerge(ctx)`) never runs the approach or plan gates at all. Before
this issue, neither loss was visible anywhere a human or a later run could
read it back: `runs.jsonl` is gitignored/host-local and doesn't carry
`gate_findings`, and the full per-issue detail under `logs/<logs_dir>/runs/`
is never read back by the engine. This section covers the mechanism that
fixes that: a title-gated `## Gate State` issue comment, mirroring the
`CONSOLIDATION_*` marker subsystem end to end (title-gated, fence-extracted,
append-only, closed with the canonical scope-guard marker). It is substrate
only — nothing reads or acts on the recorded state yet; see `seeded_from`
below for the shape that leaves for a future consumer.

### The comment shape: JSON, not consolidation's flat lines

`buildGateStateComment` renders a fixed shape — the `GATE_STATE_TITLE` line,
one deliberately non-directive human summary line, a `<details>`-wrapped
fenced JSON payload, and the canonical `<!-- ticketmill <repo>#<issue> -->`
marker as the last non-empty line, exactly the structure `parseGateStateComment`
requires on read. That payload departs from the consolidation markers'
own convention in one specific way: consolidation markers are flat,
`oneLine()`-rendered `key: value` text, parsed back out with a regex.
Gate state can't use that shape, because `settled` — the same array
`settleDecision`/`settledBlock` already maintain on `ctx`, capped here to
its last 6 entries the same way `settledBlock` caps its own render — is an
array of five-field objects (`topic`, `gate`, `decision`, `why`, `rejected`)
carrying free text a human or an earlier agent wrote. That text can contain
apostrophes, backticks, or newlines; `oneLine()`'s single-line-per-field
convention can't express it without lossy flattening. `JSON.stringify`/
`JSON.parse` round-trips it exactly instead, so `buildGateStatePayload`
assembles a real object (`schema`, `repo`, `issue`, `run`, `batch`, `epoch`,
`write_seq`, `boundary`, `group_id`, `members`, `seeded_from`, `gate_budgets`,
`settled`)
and the comment fences it as JSON rather than trying to force it through
consolidation's flat format.

### Four write boundaries, and the one that deliberately has none

`postGateState(ctx, boundary)` is called at four points in `processIssue`'s
implementation path, each a place a gate has just resolved and nothing has
failed the issue yet:

- **`'approach'`**, once, right after the approach-gate contrarian loop. All
  four of that loop's exits (dead contrarian, `sound_with_caveats`, cap-out,
  a dead re-evaluate) are `break`s out of the same loop, so one post placed
  immediately after it durably records the approach gate's outcome
  regardless of which exit fired.
- **`'plan'`**, once, right after the plan-gate contrarian loop, for the
  same reason — its own four exits are all `break`s into the same
  post-loop line.
- **`'pr-review-i' + iter`**, once per merge-gate iteration, called from
  *inside* `reviewAndMerge`'s review loop, immediately after that
  iteration's `recordGateOutcome(ctx, 'pr-review', ...)` call and before
  the clean-approval, nothing-to-fix, and cap-reached branches that follow
  it. It stays inside the loop deliberately: those three per-iteration
  exits are the loop's own exits, and this is the one line in the loop body
  every one of them passes through with `iter` — the value the boundary
  name is built from — still in scope. A post moved to after the loop
  would not reliably see that per-iteration state.
- **`'pr-review-i' + iter + '-aborted'`**, once, at the `return
  fail(ctx, 'needs_human', ...)` a dead PR reviewer takes — the `!spec ||
  !code` branch. This is its own boundary, not a reuse of the in-loop one
  above, because it is the *only* exit from the review loop a resumed run
  can reach without ever having gone through `recordGateOutcome` for this
  iteration: the `process_pr` resume path calls `reviewAndMerge(ctx)`
  directly, so the approach and plan gates — and their own boundary posts
  — never run on a resume. Without a dedicated post here, a resumed run
  whose reviewers die on iteration 1 would record nothing at all for the
  issue. `ctx.metrics.pr_review_iters` is already `iter` at this point (set
  at the top of the loop body, before the reviews are dispatched), so no
  extra plumbing is needed to name the boundary correctly.

A fifth candidate exit — `if (STOP.tripped) return fail(...)` at the very
top of the review loop — deliberately gets no post of its own. This is a
recorded decision, not an oversight: the STOP check runs *before*
`ctx.metrics.pr_review_iters = iter` is assigned, so it splits into exactly
two cases. On iteration 1, the check can only fire before that assignment,
so `pr_review_iters` is still its ctx-init value of 0 and no agent has
acted this iteration — there is nothing this boundary could record that the
`'plan'` boundary immediately before this loop hasn't already captured.
On iteration 2 or later, the state is already durable: the *previous*
iteration's in-loop `'pr-review-i' + iter` post already recorded that
iteration's `recordGateOutcome` result before this iteration ever started.
Either way, a post at the STOP exit would be redundant with a boundary that
already fired.

### Append-only, positional last-wins: idempotence without an exists-check

Gate-state comments are never edited or deleted — every boundary just posts
a new one. Reading a live issue's history means walking its gate-state
comments *positionally*, newest to oldest, and taking the first usable one
— the same append-only/last-wins contract the `outcomes.jsonl`/
`diffOutcomeGrades` pipeline and the consolidation markers' own heal pass
already use. This is what makes the write side idempotent for free: a
retried or re-run boundary that posts the same payload a second time
doesn't need to check whether an equivalent comment already exists first,
because whichever copy is newest on the thread is the one a reader will
select. Consolidation's own marker posts *do* need an "SKIP if one already
exists" check in their prompt, because a marker's meaning is binary
presence (is this issue in a group or not); a gate-state comment's meaning
is a value that can legitimately change between posts (an iteration count,
a settled list), so there's no equivalent presence check to make, and none
is attempted.

### Four states on read, and why `absent` must be falsifiable

`selectGateState(rows, evidence, priorWork)` is the single decision point
for "what does this issue's gate-state trail say, and can it be trusted?"
It resolves to exactly one of four states:

- **`found`** — at least one comment parses. Selection walks blocks newest
  to oldest and returns the first one whose author is trusted (see below);
  every newer, parseable-but-untrusted block passed over on the way counts
  into `skipped`.
- **`malformed`** — at least one comment exists on the thread, but none of
  them parse (wrong title, missing scope-guard marker, unparseable fence).
- **`absent`** — zero gate-state comments, and nothing else about the issue
  is evidence prior work happened.
- **`read-failed`** — the probe or the parse never produced usable data at
  all.

Only `read-failed` gets a distinct log path built specifically to make a
broken read impossible to mistake for a clean one: `fetchGateStateBlocks`'s
per-issue diagnostic line and `verifyGateState`'s per-issue outcome line
both name it explicitly, separately from `found`/`absent`/`malformed`,
because it is the one state that means the run learned nothing reliable
about this issue's history rather than learning that the history is empty
or broken.

`absent` is the state that most needs to be earned rather than assumed.
Zero blocks and a zero `total` looks, on its own, exactly like a genuinely
fresh issue that has never reached a gate. But it looks *identical* to a
truncated or failed read on an issue that has real history — and the only
way to tell those two apart is to check something the gate-state read
itself has no access to: whether this issue shows other independent
evidence of prior work. `hasGateStatePriorWork(priorWork)` makes that check
explicit — a non-null `pr_number`, a `worktree_exists` of `true`, or a
`resume_point` other than `'implement'` — any one of these means a prior
run plainly did *something* here, so zero gate-state comments next to any
of them is contradictory, not confirmatory. `selectGateState` treats that
combination as `read-failed`, never `absent`. Absence is only accepted as
genuine when zero blocks/zero `total` is *not* contradicted by that
independent evidence. A second, narrower check runs first and
unconditionally, ahead of the prior-work cross-check: zero blocks with a
nonzero `total` is self-contradictory on its face (the probe reports
gate-state comments exist but produced none) — the exact shape a truncated
or corrupted read would take — so it is always `read-failed` regardless of
prior-work evidence. `total` is computed by the SAME title-gated jq filter
`blocks` uses (never a bare count of every comment on the issue), so this
branch is reachable only under a genuinely truncated or corrupted read —
not, as an earlier build of this jq idiom let happen, on any ordinary issue
that had simply received one unrelated human or bot comment.

### The jq-pinned read idiom, not `fetchConsolidationMarkers`'s bare read

`fetchGateStateBlocks` sits right next to `fetchConsolidationMarkers` in
the source and is shaped like it — one whole-set probe over every candidate
issue — but deliberately does not copy its read idiom. `fetchConsolidationMarkers`
hands the agent a bare `gh issue view <n> --repo <r> --json comments` and
trusts the agent's own judgment to pick out the right comment; a truncated
or partial response can get silently read as "no marker" with nothing to
catch the difference. Gate state instead pins the same deterministic
"last title-gated comment" idiom the claim probe already uses
(`gh issue view <n> --repo <r> --json comments --jq '{total, blocks}'`,
computed by `gateStateProbeCommandLine()`, where both `total` and `blocks`
run through the identical `select(.body | startswith("## Gate State"))`
filter): jq, not the agent, computes the exact return shape. The agent's
only job is relaying that command's stdout verbatim as `raw` — it never
parses or judges it. `parseGateStateProbeRow`
is what actually decides whether a read succeeded, and it is built so a
truncated or non-JSON `raw` string can never validate: any shape mismatch —
missing/wrong-typed `total`, `blocks` not an array, a block missing a
string `body` — returns the same `{ok: false, total: 0, blocks: []}` a
JSON parse failure would, which `selectGateState` reads as `read-failed`,
never as zero blocks. This is the structural fix the falsifiable-absent
rule above builds on: because the agent never selects or summarizes, a
truncated read has no path to presenting itself as an absent one. The same
pinned idiom, via the shared `gateStateProbeCommandLine`/`chunkGateStateIssues`
helpers, backs `verifyGateState`'s Report-phase read-back too — one idiom,
two call sites, so the read-side probe and its self-validation sweep can't
drift apart.

### Trust before last-wins

Selection is not simply "take the newest parseable comment." Within a
single issue's blocks, `selectGateState` walks newest to oldest and returns
the first block whose author is trusted, via `isTrustedGateStateAuthor` —
not the first block that merely parses. Every newer block that parses but
fails the trust check is passed over and counted into `skipped`, so a
caller can tell "the newest record was trusted" apart from "the newest
usable record we found was actually several posts back." If no block on
the issue is authored by a trusted identity, selection falls back to the
newest block that parses at all (the degenerate all-untrusted case),
returned with `trusted: false` and `skipped: 0` — there's real data, just
not from a source this run is willing to vouch for on its own, and the
caller is left able to tell the two cases apart rather than treating them
identically.

### `intent-only-on-success`, and the `post-failed` sweep outcome it enables

`postGateState` sets `ctx.gate_state_intent` to the payload it just built
only when the posting agent reports `posted === true`. Every other
outcome — a dead agent after its one retry, an explicit `posted: false`, a
schema mismatch — instead sets `ctx.gate_state_post_failed = boundary` (the
last such failure wins across an issue's several boundaries) and pushes a
`ctx.deferred` note, without ever touching `gate_state_intent`. This
asymmetry is what makes `verifyGateState`'s Report-phase sweep meaningful:
if intent were set unconditionally, a routine, already-logged posting miss
would look, to `diffGateStateIntent`, exactly like real corruption — an
intended payload with nothing on GitHub to match it. Because intent is only
recorded on a confirmed post, the sweep can distinguish the two outcomes
cleanly: `'post-failed'` (no intent recorded, but a failure was) reports
the benign, already-known miss; `'mismatch'` is reserved for a case where
this run genuinely believed it posted successfully and the read-back
disagrees.

### The trust model: `self_login` primary, a bounded claim fallback

`isTrustedGateStateAuthor(login, selfLogin, claimAuthors, batch)` checks two
signals, in order. The primary signal is identity: `login === selfLogin`,
where `selfLogin` is this deployment's own authenticated GitHub identity
(`gh api user --jq .login`, resolved once per probe chunk and reduced to
the first non-empty result). This is what closes a self-bootstrap trust
hole a capped approach-gate contrarian challenge flagged against a
`claim_authors`-only rule: without a primary signal independent of claims,
a stale, forged, or simply mistaken claim comment's author would still
count as trusted evidence. The fallback — for installation tokens where
`gh api user` 403s and `selfLogin` can't resolve — is `claimAuthors`, but
restricted: a claiming login only counts if its claim is either fresh
(`ageSeconds < CLAIM_STALE_SECONDS`) or matches this run's own batch
branch. A claim that is neither fresh nor batch-matching authored no work
in the scope of this run and is not evidence of anything current — trusting
it would let a stale or forged claim from an unrelated run's history stand
in for real authorship.

### `RUN_EPOCH`: derived, never a new clock

Nothing in this subsystem calls a wall clock of its own. `scripts/lint-engine.js`
forbids `Date.now()` outright (it breaks resume inside the Workflow-tool
sandbox), so `RUN_EPOCH` is derived from wall-clock reads two other probes
already make: `deriveRunEpoch((outcomeGradeR && outcomeGradeR.now) ||
(revisitRiskR && revisitRiskR.now))`, run once at Select immediately after
both are awaited. Both `.now` values are a probe-returned `date -u
+%Y-%m-%dT%H:%M:%SZ` string, the same idiom the outcome-grading and
revisit-risk probes already used before this issue — no new probe call was
added purely to get a clock reading. `deriveRunEpoch` turns that string
into epoch milliseconds via the existing `toEpochMs`, or explicit `null` on
anything unparseable (deliberately never `NaN`, so a downstream
`gateStateEpochStale` subtraction against an unusable "now" reads as
unknown/stale rather than silently comparing false). `CLAIM_STALE_SECONDS`
(12h, the same constant the claim-staleness window already uses) is
documented here as the *intended* staleness bound for a gate-state block's
`epoch` — `gateStateEpochStale` computes it — but nothing at this tier
reads or enforces that `stale` flag. It's substrate for a future consumer,
carried through so one doesn't need a shape change to start acting on it.

### `write_seq`: orders same-run writes; `epoch` can't

`RUN_EPOCH` is assigned once at Select and is therefore identical across
every boundary a single run posts — it answers "how old is this run's data"
(what `gateStateEpochStale` needs), not "which of two same-run writes came
later" (what `diffGateStateIntent`'s `'superseded'` verdict needs). Those are
different questions with different answers: two boundaries from the same run
always carry the same `epoch`, so an epoch comparison between them is always
a tie, never an order. `GATE_STATE_WRITE_SEQ` is a separate module-level
counter — not a clock, a plain incrementing integer — that `postGateState`
bumps once per call and embeds on the payload as `write_seq`. Call order is
write order (a single issue's boundaries always post sequentially within
that issue's own `await` chain), so `diffGateStateIntent` orders same-run
writes on `write_seq`, never `epoch`.

### `seeded_from`: a discriminator with no reader yet

`buildGateStatePayload`'s `seeded_from` field names the `{run, epoch}` of
the gate-state block a resumed run's `gate_budgets` were carried forward
from, distinguishing a cumulative count (seeded from a prior run's
recorded state) from a fresh one (this run's budgets started at zero). It
is always `null` at this tier: no consumer seeds `gate_budgets` from a
prior block yet, so every call site passes `null`, and only the field's
presence in the schema — not its value — is what `parseGateStateComment`
round-trips against. A future consumer fills it in without needing a shape
change here.

### The group-identity gap

A gate-state comment posts only on `ctx.issue` — the group's current
primary — at each boundary, never on every live member the way
`postConsolidationMarkers` posts a marker on every member of a
materialized group (a group marker on the primary, a member marker on each
other live member). That asymmetry leaves a real gap: a group's logical
primary can move on re-anchor (the original primary closing or dropping
out, promoting a different member), and a re-anchored primary's own issue
thread carries no gate-state history of its own — the accumulated
`approach`/`plan`/`pr-review` iteration counts live only on the *old*
primary's thread. A resumed run on the newly-anchored primary reads
`absent` (or, if other evidence of prior work exists, `read-failed`)
rather than finding continuity, and fails open to a fresh budget rather
than inheriting the group's real history. This is a known, undocumented-
until-now gap at this tier, not a bug fixed here — it's why `group_id` and
`members` ride in every payload regardless: so a reader (today, a human;
later, a real consumer) can at least see which issues a surviving primary's
recorded state was speaking for, even when the full trail isn't reachable
from wherever the group currently anchors.

### A probe, not a preflight step

The issue that proposed this work described the read side as "add a step
to the preflight probe." What shipped instead is a separate, chunked,
whole-set probe (`fetchGateStateBlocks`, called once at Select over every
candidate issue, chunked at `MAX_GATE_STATE_PROBE_CHUNK`) rather than an
extra instruction folded into the existing per-issue preflight agent call.
The deviation is deliberate: the jq-pinned read idiom this subsystem needs
(see above) is a deterministic command with a fixed, verifiable return
shape, which fits a purpose-built probe far better than one more ask
layered onto a preflight prompt that already has several unrelated jobs.
`PREFLIGHT_SCHEMA` still carries the four gate-state fields the issue's
wording anticipated (`gate_state_blocks`, `gate_state_read_ok`,
`gate_state_total_comments`, `gate_state_trust`) — but they are written
unconditionally by `attachGateStateBlocks`, in JS, joining the probe's raw
per-issue rows onto each preflight after the fact, and always clobbering
any value an upstream agent might have hallucinated onto those same field
names. The preflight *agent* is never asked to produce them.

## Provenance: the frozen passage this page supersedes

`docs/architecture/metrics.md:81-84` — the "Completing the gate findings
tally" passage ending "`gate_findings['pr-review'].severity` stays zero
across the board" — describes the state of the world *before* this issue.
It is now inaccurate: severity counts are real as of the change this page
documents. That passage is not corrected in place. It sits inside
`metrics.md`'s single tracked provenance segment (`tests/fixtures/architecture-split.json`
records that segment as starting at line 5 and running 329 lines — 328 of
them on disk, lines 5 through the 332-line file's end, plus one trailing
blank line stripped when the file was written — everything but the
four-line synthetic H1 and lede above it), which `tests/architecture-provenance.test.js` hashes
verbatim against a digest recorded when `docs/ARCHITECTURE.md` was split
into this directory. Editing any character inside a tracked segment turns
that test red; there is no partial-credit edit. This page is the correction
and the durable source of truth going forward — `metrics.md:81-84` stays
exactly as it reads, byte for byte, as a historical snapshot superseded by
this document.

This page also supersedes `metrics.md:114` — the `computeGateYield(results)`
lede sentence, "rolls the three gates' `gate_findings` tallies." That
sentence goes stale the moment the change this page documents merges:
`computeGateYield` rolls up whichever gates appear in `gate_findings`,
and `quality` recording outcomes through `recordGateOutcome` means a fourth
gate now routinely shows up in that rollup, not three. Like the passage
above, it cannot be corrected in place — and for the same structural
reason, more bluntly here: `metrics.md`'s only tracked segment isn't scoped
to this sentence, or to any sentence. `tests/fixtures/architecture-split.json`
records exactly one segment for the whole file: 329 lines starting at its
first heading, 328 of them on disk (through the 332-line file's end) plus
one trailing blank line stripped when the file was written — everything
but the file's four-line synthetic H1 and lede. `tests/architecture-provenance.test.js` hashes that
one segment verbatim, so it hashes the file from its first heading to the
end, which includes line 114. Editing any character inside that segment,
including the word "three" in this sentence, turns that test red.
`metrics.md:114` stays exactly as it reads, superseded by this page the
same way `metrics.md:81-84` already is.

This page also supersedes `metrics.md:13-14` — "Seven capped pipeline
stages (approach, plan, task-review, quality, test, browser, pr-review)
each contribute `min(1, iters/cap)` to that score." That sentence is now
true of six stages only: as of the change this page documents, the quality
driver's contribution is `min(1, quality_iters / (MAX_QUALITY_ITERATIONS *
quality_scopes))`, pooled across however many calls an issue made to
`runQualityLoop`, not `min(1, iters/cap)` against one loop's cap (see "The
friction denominator: pooled, not worst-scope" above). The other six stages
are unaffected. Like the two passages above, it cannot be corrected in
place — it sits inside the same 329-line tracked segment
`tests/architecture-provenance.test.js` hashes verbatim — so
`metrics.md:13-14` stays exactly as it reads, superseded by this page.

Worth noting separately: the very next sentence, `metrics.md:15-17`'s "an
issue whose stages all pass first try scores 0 across every one of them,"
was already inaccurate before this change, and not for a reason this
change introduces. Passing "first try" means an iteration count of 1, not
0 — every one of the seven capped stages counts its iterations from `iter
= 1` (the four `= iter` assignments at `workflows/ticketmill.js:3631`,
`:4430`, `:4576`, `:4853`, and the three `++` increments at `:3099`,
`:3320`, `:4710`, all inside loops that open `for (let iter = 1; ...)`), so
`min(1, 1/cap)` is `1/cap`, not `0`, for any cap greater than 1. This
sentence was inaccurate the moment it shipped, independent of anything
issue #165 changes; this page does not attempt to correct it beyond
flagging it here, since doing so is out of scope for the denominator fix
this page otherwise documents.
