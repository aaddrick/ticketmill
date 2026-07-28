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
