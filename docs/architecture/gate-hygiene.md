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
with an optional `recommendation`. The four REVIEW_SCHEMA-producing prompts
(spec review, code review, quality review, test validation) all carry the
same `ISSUES_ASK` line tying the array to the verdict: every concern goes in
`issues`, a concern that only appears in `comments` will not be fixed, and
`changes_requested` with an empty `issues` is a contradiction the reviewer
should resolve by returning `approved` instead.

## The typed shape, and why it's one field looser than CHALLENGE_SCHEMA

`CHALLENGE_SCHEMA.findings` (the contrarian gates' shape) requires
`severity`, `summary`, and `recommendation`. `REVIEW_SCHEMA.issues.items`
requires only `severity` and `summary`; `recommendation` is optional. Both
use the same three-value severity enum (`critical`/`major`/`minor`). The gap
is deliberate, not an oversight: a contrarian's job is to argue a case, so a
finding without a recommendation is an unfinished argument. A reviewer's job
is closer to code review — "this is wrong" is a complete, actionable finding
on its own, and forcing a `recommendation` for every nit would train
reviewers to pad the field rather than skip it. `issues` itself stays out of
`REVIEW_SCHEMA.required` — a reviewer that never mentions the field at all
is a different, and explicitly supported, case (see below) — and `id` is
never part of the schema. The model never assigns an id.

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

## Provenance: the frozen passage this page supersedes

`docs/architecture/metrics.md:81-84` — the "Completing the gate findings
tally" passage ending "`gate_findings['pr-review'].severity` stays zero
across the board" — describes the state of the world *before* this issue.
It is now inaccurate: severity counts are real as of the change this page
documents. That passage is not corrected in place. It sits inside
`metrics.md`'s single tracked provenance segment (`tests/fixtures/architecture-split.json`
records that segment as starting at line 5 and running 329 lines — the
entire file), which `tests/architecture-provenance.test.js` hashes
verbatim against a digest recorded when `docs/ARCHITECTURE.md` was split
into this directory. Editing any character inside a tracked segment turns
that test red; there is no partial-credit edit. This page is the correction
and the durable source of truth going forward — `metrics.md:81-84` stays
exactly as it reads, byte for byte, as a historical snapshot superseded by
this document.
