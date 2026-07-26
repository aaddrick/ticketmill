# Scheduling

Claims interop, the consolidation gate, and lane scheduling: how the engine decides what to group and what to run concurrently.

## Claims interop

Ticketmill honors fresh claims left by its ancestor engine ("## Batch Processing
Claimed" comments) as foreign claims, one-way, so both can coexist on a repo
during a migration without double-processing issues.

## Consolidation gate: grouping issues cheaper to resolve as one unit

Select can propose folding several selected issues into ONE worktree, branch,
research/plan pass, and PR when they share a subsystem and acceptance surface
(or an explicit dependency) closely enough that solving them separately would
duplicate work. This is a judgment call, not a heuristic: `proposeConsolidation()`
is an opus-tier gate, prompted with a deliberately conservative bar. Grouping
is the exception. Shared files alone are never sufficient reason, only a
hint. The proposal then runs the same capped contrarian challenge pattern as
the approach/plan gates before it can take effect, reusing `CHALLENGE_SCHEMA`
and the settled-decisions ledger.

Everywhere else, the engine layers a group on top of the existing per-issue
path rather than replacing it: a unit is a singleton (`ctx.members = [ctx.issue]`,
the original code path verbatim) or a group (`ctx.members.length > 1`), so a
no-overlap run with zero proposed groups is byte-for-byte identical to the
engine before this gate existed. Grouping tags plan tasks by originating issue
(no synthesized merged-issue text); one primary issue carries the comment
trail while absorbed members get a "consolidated into #X" marker comment; the
group PR carries one `Closes #N` per member.

**Stable group id, not the mutable primary.** A group's physical identity
(worktree path, branch name, PR head) is bound to a `stableGroupId()`: the
lowest issue number ever in the group, rather than to whichever issue is
currently "primary." The two need to differ: claims settle after the proposal
is judged, so a proposed primary can turn out to be already claimed or to flip
to `skip` before materialization, forcing a re-anchor onto another live
member. If the physical identity had been hard-bound to the primary, re-anchoring
would mean silently moving a worktree/branch/PR that another process might
already be looking at. Binding identity to a stable id instead makes re-anchor
just a bookkeeping update: the same worktree and branch persist across a
primary change, and a resumed run's marker heal recognizes the group by that
id even after a re-anchor.

**Cap-dissolves, not proceed-with-caveats.** The approach and plan contrarian
gates proceed with unresolved caveats when the iteration cap is hit, because a
single issue still has to go somewhere. A consolidation proposal has a safe
fallback the others don't: independent per-issue processing, which is exactly
what the engine already does everywhere else. So hitting `MAX_CONTRARIAN_ITERATIONS`
on a group challenge, or a dead challenger/reviser mid-loop, DISSOLVES the
group back to its independent member issues instead of shipping a
still-contested grouping decision. Conservatism costs nothing here: dissolving
only forgoes an efficiency, it never blocks progress.

**Profile flag.** `profile.consolidation` (boolean, default `true`) disables
the gate entirely when set to `false`. No proposal runs and no contrarian
challenge runs, though a resumed run still heals any group a prior run already
committed to via its comment markers, so turning the flag off mid-run can't
strand a group that already exists on GitHub. Runs with at most one candidate
issue (any resume_point) skip the gate for free: there is nothing to group.
Only fresh `implement`-bound candidates are ever offered to the opus PROPOSE
step for a brand-new grouping decision; the marker HEAL step runs over every
candidate regardless of resume_point (see below).

**Billing anchor.** A group's tokens book under the primary issue, not spread
across members: `aggregateTokens()` (cost-and-tokens.md)'s per-issue breakdown keys off each
result's `issue` field, which for a group unit is `ctx.issue`. That's the
(possibly re-anchored) primary, so the run report's Token Usage table shows
one row for the whole group and absorbed members show no row of their own.

**Resumed groups stay grouped across every live resume_point.**
`proposeConsolidation()` is handed EVERY selected issue's preflight, not just
`implement`-bound ones, so its HEAL step can recognize a group whose members
have since flipped to `process_pr` (the shared PR already exists: a prior run
created it but crashed or failed before merging, in `reviewAndMerge`, which
covers spec review, code review, and merge) or `skip` (one member resolved
independently). `reconcileGroups()` keeps a member live, and IN the group,
when its resume_point is `implement` OR `process_pr`; only `skip` excludes it.
That is what keeps a post-PR-crash resume routing the whole group through ONE
`process_pr` unit (one worktree, one `reviewAndMerge` call on the shared PR)
instead of splintering into one independent `process_pr` singleton per
member, each attempting to review/merge the SAME PR.

**Known gap: partial-branch members aren't excluded.** A member issue that
already has unmerged work sitting on its own `issue-<N>` branch
(`commits_ahead > 0` on its preflight) is not currently filtered out of
consolidation: neither `consolidationCandidates` nor `reconcileGroups()` checks
`commits_ahead`. If such an issue is folded into a group, `setup-worktree.sh`
runs against the group's `worktreeAnchor()` instead of the member's own
branch, so those pre-existing commits are not carried forward. They are
effectively orphaned rather than merged. This is a known caveat, not yet a
mechanical exclusion; treat an `implement`-bound issue with nonzero
`commits_ahead` as a poor consolidation candidate until `reconcileGroups` is
extended to drop it.

## Lane scheduling: serializing issues with predicted file conflicts

Concurrent issues that touch the same file race by default: two implementers
land conflicting edits, and review has to reconcile a diff nobody expected.
Lane scheduling groups issues likely to overlap into one lane, and a single
worker drains that lane serially instead of racing every unit against the
whole pool.

**Predictions come from preflight, not a title heuristic.** Each preflight
probe resolves real repo-relative paths against `origin/TARGET` (fetched once
up front, shared read-only across every issue's probe rather than refetched
per issue) and reads `depends_on #N` / `follow-up to #N` references out of
the issue body. Both fields fail open to `[]` on any doubt. A wrong guess
would wrongly serialize two unrelated issues; an empty prediction only costs
the batch today's ordinary racing behavior.

**A deliverable-shape gate runs before that resolution, for net-new skill or
doc issues.** Retro #94 ('add skills/mill-review/SKILL.md') is why. The
original resolution always fell through to a broad `git grep`/`git ls-tree`
match against `origin/TARGET`. The two ~7,300-line engine copies plus
`.claude/ticketmill.json` mention nearly every ticketmill concept, so a
net-new skill or doc issue's generic identifiers matched the engine cluster.
The asset the issue was about to create resolved to nothing: a
precision-zero prediction, serializing the issue into the wrong lane. The
gate checks first. Does the issue read as adding a new skill or doc/markdown
asset, and does the body avoid naming an engine/profile/schema keyword
(`workflows/ticketmill.js`, `.claude/ticketmill.json`, `lint-engine`, or a
term describing the engine/profile/schema itself)? If both hold,
`predicted_files` becomes the new asset's path exactly as written, plus the
repo's top-level README if it has one, and the broad resolution is skipped.
Every other issue shape falls through to the identifier extraction and
`git grep`/`git ls-tree` resolution unchanged.

**`computeLanes()` is a union-find over predicted-file overlap, with two edge
tiers.** Trusted edges, a `serialize_globs` pattern hit or a `depends_on`
reference, always unite their units and are never dissolved. Heuristic
edges, a shared predicted path or (only when no path matches) a shared
basename, unite units too, but only survive a cohesion-aware collapse guard.
A pair sharing two or more distinct paths is a genuine cluster, an
implementation file plus its test, say, and always stands. A pair sharing
exactly one path only survives as part of a weak-edge-only chain that
reaches two distinct shared keys entirely on its own, never inherited from a
neighboring strong cluster. A single popular path touched by many otherwise
unrelated units, a magnet config or a central router, can't drag them into
one lane by itself. That's the failure mode the guard exists to catch: one
file everyone happens to touch is not evidence that any two of them conflict.

**Document frequency is advisory, never a filter.** A path matched by more
than half the batch (minimum 3 units) gets logged as a magnet signal, for
visibility in run logs and the DRY_RUN preview. It never drops an
intersection key or suppresses an edge; only the collapse guard does that.

**A second, coarser guard runs immediately before the real drain.**
`computeLanes()` guards each weak-edge chain locally, but a long run of
pairwise-weak edges, each sharing a different path with its neighbor, can
clear that local two-distinct-keys bar in aggregate without the lane, taken
as a whole, actually cohering around anything. `applyRealRunCollapseGuard()`
only recomputes when the batch is large enough to want the concurrency
(`unitCount >= concurrency`) and the lanes produced are running noticeably
narrower than a flat pool would (`collapse_ratio < 0.5`). A lane whose exact
membership also comes out of `computeLanes({ trustedOnly: true })` is
trusted and always kept. Everything else is re-checked whole-lane, fresh,
for at least two paths shared across its own units, and dissolved back to
one singleton lane per unit if it doesn't clear that bar.

**`runPool()` steals whole lanes, not items.** A worker grabs the next
unclaimed lane and drains every unit in it one at a time, in `depends_on`
topological order, before stealing another lane. No `lanes` argument, or
every lane a singleton (what `computeLanes()` returns when nothing
overlaps), degenerates byte-for-byte to the pre-lane pool: one lane per item,
drained in original order, `min(limit, items.length)` workers. STOP is still
checked per unit, and a thrown error is still isolated to the one unit that
threw, so lane draining changes nothing about failure isolation or
resumability.

**DRY_RUN previews the same lane graph, read-only.** The claim loop never
runs during a preview, so a preview's lanes can still diverge from a real
run's if a claim race flips a `resume_point` between the two. The preview
reports each lane's issues, predicted files, and provenance (`trusted`,
`heuristic`, or `none` for an unconnected singleton), plus `collapse_ratio`,
`prediction_coverage`, any DF-flagged magnet paths, and whether the shared
`origin/TARGET` fetch failed, which would mean every prediction in the
preview is grounded against a stale ref.

**The retrospective measures its own accuracy.** For each completed unit
that predicted files and produced a merged PR, the retro agent diffs the
PR's actual changed files against `predicted_files` and appends one
coverage/precision row to a new "## Lane Prediction Accuracy" section in
`process-retrospective.md`. That closes the loop: the same memory file a
human reads to judge whether the prediction step is worth trusting, or needs
a `serialize_globs` hint for a repo's actual magnet files.

**Bounds are read-only aids, not correctness inputs.** A lane's merged
`predicted_files` list caps at `MAX_LANE_PREDICTED_FILES` (60); the retro's
predicted-vs-actual sample caps at `MAX_LANE_ACCURACY_SAMPLES` (40). Both
only limit what a human or a prompt sees, never what `computeLanes()` unions
or what `runPool()` drains.

**Profile flag.** `serialize_globs` (optional, default `[]`) names patterns
worth trusting even when predicted-file overlap alone wouldn't catch them: a
shared schema, a central config, anything two issues could conflict on
without their own predicted paths overlapping. Left unset, the engine still
lanes on `depends_on` and predicted-file overlap alone.
