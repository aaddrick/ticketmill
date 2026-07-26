# Branching and merge

The batch-branch model, the Closes-lines bookkeeping, the release stage, and merge auto-resolve's one mechanical recovery attempt.

## Batch branch model

`args.branch` (BASE) receives exactly one PR per run, created for a human.
Per-issue PRs squash-merge into `Batch_<timestamp>`; issue closure fires from the
batch PR's `Closes #N` lines when the human merges it. This keeps N issues'
worth of autonomous merges off the base branch while preserving per-issue review
trails.

## Closes lines: keyed off shipped issues, not raw completion status

The batch PR's `Closes #N` lines used to come straight from `results.filter(r
=> r.status === 'completed')`. That's correct for a single, unbroken pass, but
it breaks on a healing or resumed run. An issue whose per-issue PR already
merged into TARGET during a PRIOR pass preflights this pass as `status:
'skipped'` (a related PR is already merged, so Select routes it straight to
`resume_point: 'skip'`). Filtering on `completed` alone drops that issue from
the Closes lines silently, and it stays open when the human merges the batch
PR.

`batchClosesIssues(results)` fixes this by keying inclusion on a `shipped` set
instead of raw status: an issue counts as shipped when `status ===
'completed'`, or when `status === 'skipped'` and `merged_into_target ===
true`. `merged_into_target` is computed in JS at the `resume_point === 'skip'`
return, as `pre.pr_state === 'merged' && pre.pr_base === TARGET`. That's a
plain string match against TARGET, the one value in scope that's
authoritative about which batch branch this run owns. It guards the
mirror-image bug too: a PR merged into a DIFFERENT batch branch, a
concurrent run's own TARGET or straight into BASE, must not count as shipped
into this one. `pr_base` is a new preflight schema field, read from `gh pr
list --json ...,baseRefName` at probe time alongside the existing `pr_state`.

`batchClosesIssues` flatMaps over each result's `members` (falling back to
`[r.issue]` when the result isn't grouped) and dedups, so a shipped
consolidation group still closes every member, not just its primary. The
same `shippedIssues` set now drives the batch PR's create/update gate, the
title's issue count, and the "## Consolidated Groups" section as well as the
Closes lines, so a resumed pass can't rebuild one of those four pieces
in a way that disagrees with the other three.

## Release stage: batch-level CHANGELOG and version bump, gated

A batch of real engine changes once merged to BASE with the CHANGELOG and
`.claude-plugin/plugin.json` version left stale (PR #56). Nothing in the
pipeline ever bumped them; every stage assumed some other stage did. Fixing
the stale state took a manual repair commit. The Report phase now owns this
job as its own optional stage, gated on `profile.release`. Left unset (the
default), the stage never runs and never calls an agent.

`releaseEnabled(profile)` requires an explicit `profile.release.version_files`
array with at least one entry. Setting it opts a repo in; it names the JSON
file(s) carrying a top-level `"version"` key, plus an optional `changelog`
path (default `CHANGELOG.md`) and an optional `bump` override
(`"major"|"minor"|"patch"`). `version_files` should name only the canonical
copy: a path also listed in `profile.lockstep_installed_paths` has its own
mirroring tooling keeping it in sync, so bumping it here too would just fight
that sync. `marketplace.json` carries no version field of its own and should
never be listed.

The stage runs once per batch, immediately before the batch-PR agent, and
only when `shippedIssues.length` is nonzero. Running it there rather than
per-issue is deliberate: a batch-level bump lands inside the human-reviewed
TARGET -> BASE diff by construction, instead of scattering version churn
across every per-issue PR that merges into the batch branch.

**BASE-anchored derivation, never TARGET.** `deriveReleaseVersion(baseVersion,
commitTypes, profile)` computes the next version from the version currently
committed on `origin/BASE`, read by a read-only probe agent, never from
`origin/TARGET`. A resumed or healing Report pass recomputes the identical
next version instead of bumping a version TARGET already carries from an
earlier pass. `commitTypes` comes from the batch's own commit log
(`git log BASE..TARGET --pretty=%s`); any `feat` prefix shipped bumps minor,
otherwise the bump is patch, unless `profile.release.bump` overrides it. A
non-semver `baseVersion` makes the function throw, and the call site treats
that as a non-fatal, logged skip rather than failing the run.

**Idempotent CHANGELOG anchor.** `releaseChangelogAnchor(version, runTag)`
builds the one heading the write agent looks for and regenerates in place:
`## [<version>] - <runTag>`. It's anchored to the computed version and the
run's fixed `RUN_TAG`, never to a wall-clock date, so calling it twice with
the same batch produces the same string even if the second call happens after
midnight. A prior pass's draft section gets its body replaced, not
duplicated.

**Ephemeral worktree, root never touched.** The write agent runs the
`doc_writer` persona in a fresh `git worktree add` checked out from
`origin/TARGET`, bumps the version file(s), regenerates the CHANGELOG
section, commits, and pushes back to TARGET. `ROOT` itself is never checked
out or mutated, and the worktree is removed in a `finally` block regardless
of whether the write agent succeeded, so a dead agent can't leave it behind.
A push failure is logged and pushed onto `VERIFY_SKIPS` rather than retried
or treated as fatal: the commit still exists locally-to-the-worktree-run and
can be pushed by hand before the batch PR merges.

**Known collision, not corruption.** Two batch PRs open concurrently against
the same BASE both compute BASE-plus-bump to the same next version, and
collide on the version file and CHANGELOG section at the second human merge.
That surfaces as an ordinary git conflict at the human merge gate. Manual
version bumps carried the same exposure already; this stage doesn't add a
new failure mode.

**This repo's own profile now opts in.** Issue #83 named
`.claude/ticketmill.json` as explicitly in scope, and the change landed the
`release` object: `version_files: [".claude-plugin/plugin.json"]`,
`changelog: "CHANGELOG.md"`, `bump: null`. `profile.release` is read once
at engine startup, so the batch that adds the field still runs on the old,
unset profile. The stage takes effect starting with the next self-mill
run, not the run that turned it on. The two agent charters
(`.claude/agents/ticketmill-implementer.md` and
`ticketmill-code-reviewer.md`, both engine-owned) have been realigned to
match: the implementer no longer bumps the version or adds a CHANGELOG
entry per-issue, and the code reviewer no longer flags a per-issue PR for
a missing bump. Both describe that release discipline as batch-level,
owned by the gated Report-phase `release` stage.

## Merge auto-resolve: one mechanical recovery attempt before needs_human

A PR whose preflight reads `CONFLICTING` used to escalate straight to
`needs_human`, even when the conflict was mechanical: a sibling issue's
commits already landed on the batch branch, or two hunks that just don't
overlap. `runMergeAutoResolve(ctx)` runs immediately before the merge stage
and gives that case one recovery attempt first. It follows the same shape as
`runBrowserCheck`: a probe decides whether to act at all, then a bounded chain
of mechanical git stages plus one judgment stage does the work.

The probe reads mergeability through `mergeSettlePoll`, a shared bash loop
(up to 6 polls, 5 seconds apart) rather than one read. GitHub recomputes
`mergeable: UNKNOWN` asynchronously for a few seconds after a push, so a
single read can misjudge a perfectly fine PR as unresolvable. The merge
stage's own preflight polls the same way right before it merges, for the same
reason.

Only `CONFLICTING` triggers the rest of the flow. On that state, the still-open
worktree fetches and rebases onto the batch branch's current tip. A clean
rebase counts as resolved too, even with zero conflicts, because the merged
diff still differs from the head that spec and code review actually looked
at. Surviving conflicts go to an implementer-persona resolver stage that
prefers keeping both sides of a hunk over discarding either, since the other
side is almost always a sibling issue's change already on the batch branch.
A hunk that needs a semantic judgment call aborts the rebase instead of
guessing.

Every rebase, resolved or clean, is followed by a mandatory, forced run of
`runTestLoop(ctx, true)`. The `forced` flag skips the loop's usual "no
testable code changed" shortcut. It exists to answer one narrow question:
does the exact tree about to be force-pushed pass. A rebase can pull in
commits whose diff looks unchanged against the target while the tree that
would actually get pushed has moved.

A thrash guard runs right after: it checks the batch branch hasn't moved
again while those tests were running. If it has, the state that just went
green is already stale. The flow escalates instead of silently re-rebasing
and pushing content the tests never verified, bumping
`ctx.metrics.merge_thrash`. An earlier draft of this flow re-rebased and
pushed at that point instead; the guard is a deliberate, contrarian-adjudicated
reversal of that choice. The final push uses `--force-with-lease`, never a
plain `--force`, so a stale lease from concurrent access fails loud instead of
clobbering someone else's push.

Gated on a real `test_command`: with `test_command: null` there's no suite to
re-verify against, so the safety property this flow exists to provide doesn't
apply. A `CONFLICTING` PR under a no-test profile falls straight through to
the merge stage's own preflight, unchanged, exactly as before this mechanism
existed.

`ctx.metrics.merge_auto_resolved` increments only after the merge stage's own
subsequent preflight confirms a real merge. The force-push alone never bumps
it, so a PR that auto-resolve fixed but that then blocks at the merge stage
for an unrelated reason can't inflate the count. When the merge does go through,
the Implementation Complete comment says explicitly that the merged diff
diverged from the head spec and code review reviewed.

`aggregateMergeAutoResolve(results)` rolls the per-issue metrics up into a
"## Merge Auto-Resolution" section for the batch PR body and the run report,
following the same JS-computed, verbatim-injected pattern as
`aggregateTokens` (cost-and-tokens.md): no subagent ever sums or double-checks this
arithmetic. It reads `merge_auto_resolved` and `merge_thrash` off every
result, including a `needs_human` result the thrash guard escalated, since
`fail()` carries `ctx.metrics` through. The two counts never overlap: a
thrashed issue escalates before it can also count as resolved.

## Commit SHA integrity: read it, don't recall it

Every stage prompt that asks an agent to post a comment with a commit SHA
appends `COMMIT_SHA_ASK`. It tells the agent to run
`git -C <worktree> log -1 --format=%H` and paste that output exactly, with
no edits. The instruction rules out typing, shortening, guessing, or
recalling a SHA from memory.

The rule exists because agents did exactly that. Twice, a posted comment
carried a SHA the agent invented rather than one it read from git, and a
later stage had to post a fixup comment with the correct value.

`COMMIT_SHA_ASK` is declared once and reused across eight stage prompts:
simplify, quality fix, browser fix, test fix, test quality fix, task
implementation, task review fix, and PR review fix. Sharing one constant
keeps the wording in sync across all of them if it changes later.

### Layer 2: post-hoc validation of the posted SHA (issue #79)

`COMMIT_SHA_ASK` is advisory only: it tells an agent how to get the real
SHA, but the `commit` field a stage returns is still unverified free text.
Nothing stopped a stage from posting a fabricated or stale SHA anyway.
`collectPostedCommit(ctx, stageName, r)` is called at all eight
`COMMIT_SHA_ASK` sites and appends every non-null `commit` a stage reports
to `ctx.postedCommits` (guarding a null stage result and a stage that
reported no commit at all, e.g. a fix stage that made no changes).

`probeCommitShas(ctx)` then validates that list once per issue, from
`reviewAndMerge()`, immediately before `runMergeAutoResolve()`. Same
read-only-dispatch shape as `probeChangedFiles()` immediately above it in
`workflows/ticketmill.js`: it early-returns with **no dispatch** when
`ctx.postedCommits` is empty (the common case: most stages never report a
commit), otherwise it dispatches a single read-only haiku probe that runs
`git -C <worktree> cat-file -e <sha>^{commit}` for every distinct SHA
collected and reports back which ones did not resolve. The probe runs
before merge-auto-resolve deliberately: a rebase there legitimately
rewrites every commit's SHA, and validating pre-rebase (while every posted
SHA still resolves in the worktree) means there is nothing left to
re-validate afterward.

The check is advisory-flag, never-halt, same as the engine-owned gate and
`probeChangedFiles()`: a missing SHA pushes a `VERIFY_SKIPS` entry (so it
surfaces in the batch PR's Verification Gaps section) and a `ctx.deferred`
note naming the posting stage, but never blocks the issue. A dead probe
(the agent call dies through every retry) degrades to a recorded
`ctx.deferred` note instead, same fail-open posture as every other
degrade-safe probe in this engine. One dispatch validates every SHA posted
during the issue, not eight per-site round-trips.
