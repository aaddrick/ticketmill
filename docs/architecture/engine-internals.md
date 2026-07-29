# Engine internals

Long-form commentary lifted out of `workflows/ticketmill.js`. The engine is run by
the Claude Code Workflow tool, which refuses any script file of 512 KiB or more,
and the file had grown past that ceiling. Moving the standing prose here bought the
room back without discarding the reasoning it records.

Every section below is the engine's own comment text, moved verbatim. At each site
the code keeps a one-sentence summary and a pointer to the section here that
carries the rest.

This page is authored text added after the issue #154 split, so it is not tracked
in the provenance fixture.

## Contents

- [`ticketmill`](#ticketmill)
- [`later-fix-pr`](#later-fix-pr)
- [`gate-state-issue`](#gate-state-issue)
- [`buildGateStatePayload`](#buildgatestatepayload)
- [`selectGateState`](#selectgatestate)
- [`diffGateStateIntent`](#diffgatestateintent)
- [`attachGateStateBlocks`](#attachgatestateblocks)
- [`CONSOLIDATION`](#consolidation)
- [`reconcileGroups`](#reconcilegroups)
- [`deriveUnits`](#deriveunits)
- [`computeLanes`](#computelanes)
- [`applyRealRunCollapseGuard`](#applyrealruncollapseguard)
- [`isBudgetExhaustedError`](#isbudgetexhaustederror)
- [`gate-findings-tally`](#gate-findings-tally)
- [`findingsBlock`](#findingsblock)
- [`pure-aggregation-per`](#pure-aggregation-per)
- [`reconcile_error`](#reconcile-error)
- [`FRICTION_WEIGHTS`](#friction-weights)
- [`computeFriction`](#computefriction)
- [`engine-owned-gate`](#engine-owned-gate)
- [`probeCommitShas`](#probecommitshas)
- [`merge-auto-resolve`](#merge-auto-resolve)
- [`PROPOSECONSOLIDATION`](#proposeconsolidation)
- [`fetchGateStateBlocks`](#fetchgatestateblocks)
- [`verifyGateState`](#verifygatestate)
- [`gate-findings-tally-2`](#gate-findings-tally-2)
- [`bounded-worker-pool`](#bounded-worker-pool)
- [`buildIssueShapeRows`](#buildissueshaperows)
- [`buildRunRecord`](#buildrunrecord)
- [`buildTrustedPfBands`](#buildtrustedpfbands)
- [`computeLaterBatchFix`](#computelaterbatchfix)
- [`gradeFromObservation`](#gradefromobservation)
- [`computeRevisitRisk`](#computerevisitrisk)
- [`deriveNegativeOutcomeEvents`](#derivenegativeoutcomeevents)
- [`select-consolidation-gate`](#select-consolidation-gate)
- [`cost-estimate-preview`](#cost-estimate-preview)

## ticketmill

```
=============================================================================
ticketmill — stack-agnostic batch issue processing engine.

Ported from flyspacea's batch-issues.js (itself a workflow port of
batch-orchestrator.sh + implement-issue-orchestrator.sh). The process
machinery — contamination guards, settled-decision ledger, handoff notes,
claims, circuit breakers, degrade windows, preflight healing — encodes
multiple runs of retrospective learnings and is preserved intact. What
changed is everything project-shaped: agents, test commands, doc
conventions, and browser verification now come from the TARGET REPO via
its .claude/ticketmill.json profile and its .claude/agents/ directory.

USAGE
Workflow({ scriptPath: '<repo>/.claude/workflows/ticketmill.js',
args: { branch: 'dev', issues: [701, 702] } })
Workflow({ scriptPath: ..., args: { branch: 'dev', labels: ['frontend'],
no_assignee: true, limit: 10 } })
Safe preview (probe only, no changes):
Workflow({ scriptPath: ..., args: { branch: 'dev', issues: [701], dry_run: true } })

PROFILE (.claude/ticketmill.json in the target repo — written by mill-init)
The profile is REQUIRED. A missing profile halts the run: the engine never
guesses a toolchain, because a wrong guess silently skips verification and
silently-skipped verification ships broken code (the original engine's v4
retro paid for that lesson; see TEST LOOP below).
{
"repo": "owner/name",              // optional; discovered from gh if omitted
"test_command": "php artisan test",// REQUIRED KEY. null = "this project has
// no test gate" — an explicit human
// decision recorded by mill-init, and
// surfaced in the batch PR body.
"test_globs": ["**/*.php", "tests/**"], // changed files that count as testable
"install_commands": ["composer install --no-interaction"],
"env_files": [".env"],             // copied root -> worktree at setup
"simplify_globs": ["**/*.php"],    // files worth a simplify pass; null = always run
"serialize_globs": ["**/config/*.php"], // OPTIONAL (issue #1, lane scheduling):
// any two issues whose predicted_files both
// hit one of these patterns are a TRUSTED
// edge for computeLanes() — they always run
// in the same serial lane instead of racing,
// never dissolved by the collapse guard.
// Use it for hot/shared files (a central
// router, a schema, a magnet config) that
// predicted_files' own path-overlap
// heuristic can't be trusted to catch on its
// own. Unset/[] = only depends_on and actual
// predicted-file overlap drive lanes.
"docblock_globs": ["app/**/*.php"],// files needing docblocks; null = skip stage
"docs_dir": "docs",                // tech-docs stage target; null = skip stage
"release": null,                   // OPTIONAL, default null (stage skipped
// entirely, no agent call): batch-level
// CHANGELOG + version-file bump, owned by the
// Report phase, run ONCE per batch immediately
// before the batch PR agent — so the bump
// lands inside the human-reviewed TARGET->BASE
// diff by construction. Per-issue stages must
// NOT bump versions themselves.
// { "version_files": [".claude-plugin/plugin.json"],
//   "changelog": "CHANGELOG.md",  // default shown
//   "bump": null }               // "major"|"minor"|"patch" override;
//                                // unset = derive from shipped
//                                // commit types (any "feat" -> minor,
//                                // else patch) — see deriveReleaseVersion().
// version_files: JSON file(s) with a top-level "version"
// string key, bumped in place. Name the CANONICAL file only —
// never a path also listed in lockstep_installed_paths; that
// file's own mirroring tooling keeps it in sync, a second bump
// commit would just fight it. marketplace.json carries no
// version field of its own — never add one here or anywhere else.
// The next version is always computed from origin/BASE's
// version_files[0] (never TARGET), so a resumed/healing pass
// regenerates the identical version + CHANGELOG section in place
// instead of double-bumping. CAVEAT: two batch PRs open
// concurrently against the same BASE both compute BASE+bump to
// the same next version and collide on version_files/changelog at
// the second human merge — a git conflict at the human merge gate
// (pre-existing under manual bumps, not made worse), not silent
// corruption. The generated CHANGELOG entry is an explicit draft;
// the human reviewer refines wording inside the batch PR.
"consolidation": true,             // OPTIONAL, default true: Select-phase gate
// that groups issues cheaper to resolve as
// one unit. false disables the gate entirely
// (no gate agent call); see
// consolidationEnabled().
"logs_dir": "logs/ticketmill",
"claim_label": "ticketmill",
"verify_notes": ["tests need the pgvector container: podman start ncl_test"],
"engine_owned_globs": [],          // extends the built-in engine-owned set
// (.claude/ticketmill.json, .claude/agents/**,
// .claude/workflows/ticketmill.js,
// .claude/scripts/ticketmill/**) — read-only
// during a run; see ENGINE_OWNED_GLOBS.
"lockstep_installed_paths": [],    // engine-owned paths that are a deliberate
// installed copy of a source-of-truth file
// elsewhere in THIS repo, kept in lockstep by
// its own tooling — exempted from the
// post-implement hard-revert gate; see
// isHardRevertPath. This repo sets
// [".claude/workflows/ticketmill.js"].
"warn_base_branches": [],          // OPTIONAL (issue #36), default []: base
// branch names that trigger a Select-phase
// WARNING when a batch's target branch looks
// like a CI/CD deploy-trigger branch (PRs
// normally target the working branch, not a
// branch that auto-deploys on push). Unset/[]
// = no warning; the engine bakes in no
// project-shaped branch names of its own.
"contrarian_max_iterations": 3,    // OPTIONAL, default 3: caps the approach/plan
// (and consolidation) contrarian challenge
// gates' iterations before proceeding with
// unresolved caveats (recorded in the batch
// PR's Verification Gaps). Must be an integer
// >= 1 if set. 'trivial'-complexity issues get
// min(2, this value) per gate regardless.
"browser": null,                   // OPT-IN browser verification:
// { "serve_command": "php artisan serve --port={port}", "build_command": null,
//   "ui_globs": ["resources/views/**"], "port_base": 8100, "notes": "...",
//   "port_span": 900, "lock_path": "/tmp/ticketmill-browser-lock",
//   "stale_seconds": 1800, "poll_seconds": 15,
//   "artifact_dir": "/tmp/ticketmill-issue-{issue}" }
// All five of port_span/lock_path/stale_seconds/poll_seconds/artifact_dir are
// optional and default to the values shown above; artifact_dir substitutes
// {issue} if present (like serve_command's {port}), else appends -<issue>.
// CAUTION: the resolved artifact_dir is deleted with `rm -rf` on cleanup
// (both the browser-verify cleanup stage and the final reviewAndMerge
// cleanup) - it must be a dedicated scratch path, never a project dir,
// shared mount, or $HOME.
"models": { "plan": { "model": "opus", "effort": "high" } }, // OPTIONAL per-stage
// model/effort overrides, keyed by stage name.
// Valid keys (25): probe, setup, research,
// evaluate, consolidation, contrarian, plan,
// implement, taskReview, simplify, qReview,
// fix, testRun, testValidate, browser,
// docblock, pr, specReview, codeReview,
// techDocs, merge, release, report, retro,
// learnings.
// The `M` map below is the source of truth
// for these keys and their defaults.
"roles": {
"implementers": ["laravel-backend-developer", "frontend-developer"],
"default_implementer": "laravel-backend-developer",
"task_reviewer": "spec-reviewer", "spec_reviewer": "spec-reviewer",
"code_reviewer": "code-reviewer", "contrarian": "contrarian",
"test_validator": "php-test-validator", "simplifier": null,
"docblock_writer": null, "doc_writer": null
}
}

AGENT MODEL (single mechanism, on purpose)
Roles are filled by the target repo's own agents (.claude/agents/<name>.md),
referenced by name in profile.roles. A stage prompt instructs its subagent to
READ the agent file first and adopt the persona — the engine never passes
agentType, so behavior does not depend on what the session's agent registry
happened to load at startup (newly generated agents work immediately, and a
run behaves the same before and after a session restart). Roles left null or
pointing at a missing file fall back to a built-in role charter, loudly.

BATCH BRANCH MODEL
args.branch (BASE) is only ever the target of ONE human-reviewed PR. At startup
the run creates TARGET = Batch_<start timestamp> from origin/BASE (timestamp via
a `date` probe — Date.now() is unavailable here). All worktrees branch from
TARGET, all diffs/reviews compare against TARGET, and per-issue PRs squash-merge
into TARGET. The run ends by opening a PR TARGET -> BASE with "Closes #N" for
every completed issue — NEVER auto-merged; issues stay open until a human merges
that PR (per-issue merges into a non-default branch don't fire "Closes #"). To
heal/resume a batch, re-run with args.batch_branch: 'Batch_<ts>'.

CROSS-RUN ISSUE CLAIMS (multi-machine coordination)
At Select time — BEFORE the concurrency queue drains — the run claims every
selected issue: a claim label + a "## Ticketmill Claimed" comment carrying
batch branch, run tag, host, and a started epoch. A second run started
elsewhere claims at ITS Select phase, finds a fresh foreign claim (< 12h),
and skips the issue; a post-then-verify race check (earlier epoch wins)
settles simultaneous starts. Claims from the SAME batch branch are recognized
as our own (resume). One-way compatibility: fresh claims left by the older
batch-issues engine ("## Batch Processing Claimed" / batch-in-flight label)
are honored as foreign claims too. Releases: per-issue at merge and on halt
notes, plus a Report-phase sweep; a dead run's claims expire via the 12h
staleness window. Claims are advisory — a died claim agent fails open.

BROWSER VERIFICATION (opt-in, serial)
Only when profile.browser is configured. UI-testable changes (diff touches
profile.browser.ui_globs) get a live-browser pass twice: after the test loop
('implement') and after PR reviews approve ('pre-merge'). The browser MCP is
ONE shared instance, so all browser stages across concurrent pipelines run
through a chained mutex; probes and fix stages run outside the lock. Each
pass boots profile.browser.serve_command (with {port} substituted per issue).
Two-layer locking: the JS mutex only orders stages THIS SCRIPT schedules, so
a host-global mkdir lock (default /tmp/ticketmill-browser-lock, owner file,
default 30-min stale-steal, default 15s poll — all overridable via
profile.browser.lock_path/stale_seconds/poll_seconds) additionally guards the
browser itself; ad-hoc agent use goes through the same lock.

RESTARTABLE (two independent paths)
1. Same session, exact resume: Workflow({ scriptPath, resumeFromRunId: 'wf_...' })
2. Any session: re-run with the SAME args (+ batch_branch). The Select-phase
preflight reads GitHub/git state and routes each issue: merged/closed ->
skip; open PR -> review+merge only; partial branch/worktree -> implement
continues (setup is idempotent; every implement prompt checks existing
commits first).

SELF-HEALING
- Every stage retries once with an attempt-stamped prompt (distinct journal key).
- Schema-forced structured output (the harness retries schema mismatches).
- Quality-loop stage errors degrade the task and continue (halt only when >= 3
of the last 5 tasks degraded).
- Test-loop stage errors halt the issue loudly (silent degradation would ship
broken code when CI does not run the suite).
- Circuit breakers: >= 3 issues failed, or >= 3 consecutive agent deaths
(the usage-limit signature) -> stop launching, report a resume plan.
- Failures post an issue comment with the halt stage + resume instructions.

CROSS-PIPELINE CONTAMINATION GUARDS
- Scope guard: every stage prompt pins gh comment/edit targets to its own issue
and requires an "<!-- ticketmill <repo>#<issue> -->" marker on every comment.
- Contrarian gates mechanically delete trail comments whose marker names a
different issue (misfiled by a concurrent pipeline).
- Decision-chain records are issue-stamped; decisionChain() drops mis-stamped
records. sanitizeTasks() drops stub task descriptions (< 12 chars) so a
placeholder plan fails and retries instead of dispatching an empty task.

LOOP-STEP VISIBILITY: every review/fix loop iteration posts its own issue/PR
comment — the trail shows each round, not just "Task N Implemented".

CONTEXT THREADING (how earlier agents inform later ones, 3-4 stages downstream)
- Decision chain: distilled per-stage summaries injected into judgment stages.
- Settled ledger: decisions adjudicated at contrarian gates travel forward with
a "re-open only with new evidence" contract.
- Handoff notes: work stages return notes_for_downstream (env quirks, anchoring
gotchas); a bounded ledger is injected into later implement/fix/test prompts.
- Learnings digest: one Select-phase agent distills process-retrospective.md
once; category sections are injected per stage.
- Issue trail: contrarian gates read the full GitHub comment trail — the
uncompressed record — before challenging.

MODEL POLICY (override per stage via profile.models)
haiku/low  : mechanical gh/git probes, setup script, running the test suite,
batch-branch creation, UI-file probes
sonnet     : research, implementation, fixes, simplify, per-task reviews,
test validation, browser verification, docs, PR/merge mechanics,
reporting
opus       : judgment gates — evaluate, plan, contrarian challenges (high
effort), and the final pre-merge code review (high effort)
=============================================================================
```

## later-fix-pr

```
later_fix_pr/batch_pr_merge_sha/churned_regions/later_fix_body (issue
#104): RAW inputs to computeLaterBatchFix/isPlannedFollowup only —
this agent never decides later_batch_fix itself (same PIN as every
other field on this schema). later_fix_pr is the number of the first
later, DISTINCT, merged PR that cross-references THIS batch PR's own
timeline and survives the prompt's cheap planning-edge pre-filter
(null if none). later_fix_body is that PR's raw body text verbatim
(null if later_fix_pr is null) — the sole input to the post-hoc
isPlannedFollowup exclusion; deliberately absent from
pickOutcomeSignals' compact `signals` (prose, not a compact signal).
batch_pr_merge_sha is THIS batch PR's own squash-merge commit SHA
(null if unresolved/unmerged). churned_regions is an array of
{ file, blamed_shas } — one entry per hunk in later_fix_pr's diff,
each resolved via a read-only `git blame` of the PRE-IMAGE lines it
replaced, blamed_shas holding every distinct commit SHA those lines
attribute to (empty array if later_fix_pr is null or unresolved).
```

## gate-state-issue

```
=============================================================================
GATE STATE (issue #166): durable per-issue gate/contrarian state carried on
the issue itself across a run boundary. Substrate only in this tier -- no
consumer reads/acts on it yet (see the design note on buildGateStatePayload's
`seeded_from`). Mirrors the CONSOLIDATION_* marker subsystem immediately
above end to end: a title-gated comment, fence-extracted payload, canonical
scope-guard marker as its LAST line, append-only with positional last-wins
(read: newest wins, exactly like the outcomes.jsonl/diffOutcomeGrades
contract and the consolidation markers' own heal pass). Departs from that
precedent in one place: the payload is fenced JSON, not consolidation's flat
regex-parsed key:value lines, because `settled` (settleDecision/settledBlock
above) is an array of five-field objects carrying free text that may itself
contain newlines -- oneLine()'s single-line-per-field convention can't
express that without lossy flattening, while JSON.stringify/JSON.parse
round-trips it exactly, apostrophes and all.
=============================================================================
```

## buildGateStatePayload

```
buildGateStatePayload: assembles the JSON payload embedded in a gate-state
comment. `settled` is capped to its last 6 entries here (mirrors
settledBlock's own slice(-6)) so a long-running issue's payload never grows
unbounded regardless of how many gates it has cleared. `seeded_from` names
the {run, epoch} of the block THIS ctx's `gate_budgets` were carried forward
from, when a resume seeds them from a prior run's recorded state, or null
when they started at zero this run. It is ALWAYS null at this tier: no
consumer seeds gate_budgets from a prior block yet (substrate only, no
consumer -- see the section banner above), so every call site passes null.
The field's PRESENCE, not its value, is what parseGateStateComment's schema
round-trips against -- a future consumer fills it in without a shape change
here. `write_seq` (issue #166 PR #177 review) is the GATE_STATE_WRITE_SEQ
counter value at the moment this payload was built -- unlike `epoch`
(identical across every boundary in a run), this varies write to write, so
diffGateStateIntent can order two same-run writes against each other. null
when the caller doesn't supply one (e.g. a hand-built test fixture, never a
real postGateState() call, which always passes it). Every field defaults
defensively (never throws on a sparse `o`) so a caller mid-construction
(e.g. a boundary with no group) gets a valid, schema-conformant payload
rather than an exception.
```

## selectGateState

```
selectGateState: the single decision point for "what does this issue's
gate-state comment trail say, and can it be trusted?" Turns `rows` (one
issue's already-parsed probe result -- parseGateStateProbeRow's {ok, total,
blocks} shape, optionally carrying the agent-level `exit_ok` alongside it;
blocks are oldest-first, mirroring GitHub's own comment order), `evidence`
({repo, issue, self_login, claim_authors, batch, run_epoch}), and
`priorWork` ({pr_number, worktree_exists, resume_point}) into exactly one
of four states:
- 'read-failed' -- the probe/parse never produced usable data (an
explicit agent-level exit_ok:false, OR parseGateStateProbeRow's own
ok:false), OR the falsifiable-absent rule fires (below). This is what
makes a truncated/broken read structurally impossible to misread as
genuine absence.
- 'absent' -- zero blocks, zero total, and nothing else on this issue
(pr_number/worktree_exists/resume_point) is evidence prior work ever
happened -- a genuinely fresh issue.
- 'malformed' -- at least one block exists, but NONE of them parse
(title-gated, fence-extracted, marker-checked -- see
parseGateStateComment): the newest fails and every older one fails too.
- 'found' -- at least one block parses. Selection is EXPLICIT TRUST-
BEFORE-LAST-WINS: walk blocks newest -> oldest, return the first one
whose author is trusted (isTrustedGateStateAuthor), counting every
newer untrusted-but-parseable block passed over into `skipped`. If NO
block is trusted, this is the degenerate all-untrusted case: state
stays 'found' (there IS data, just not from a trusted author) using the
newest PARSEABLE block's payload, `trusted: false`, and `skipped: 0`
(nothing was skipped to reach it -- it's the first thing the walk
looked at). `trusted` is kept on the result specifically so a caller
can distinguish this degenerate case from an ordinary trusted find.
`stale` (only meaningful when `state === 'found'`) comes from
gateStateEpochStale against the SELECTED payload.

FALSIFIABLE-ABSENT RULE: zero blocks + total===0 is only accepted as
genuine absence when nothing else on this issue is evidence prior work
happened. If `pr_number` is non-null, OR `worktree_exists` is true, OR
`resume_point` is anything other than 'implement', a prior run plainly did
SOMETHING here, so zero gate-state comments is contradictory --
read-failed, never absent. Zero blocks with no such evidence stays absent.
This is NEVER inferred from an empty blocks array alone -- always from this
explicit cross-check against independently-sourced preflight evidence.
A second, narrower contradiction is checked first and unconditionally:
zero blocks but total>0 is self-contradictory on its face (the probe says
comments exist but produced none) -- exactly the truncated/corrupted-read
shape this whole design exists to make undetectable-as-absence, so it is
always read-failed regardless of `hasPriorWork`. `total` is computed by
gateStateProbeCommandLine's jq using the SAME title-gated filter `blocks`
uses (never a bare all-comments count), so this branch is reachable only
under a genuinely truncated/corrupted read, not on any ordinary issue
carrying an unrelated human or bot comment.

hasGateStatePriorWork: shared with fetchGateStateBlocks' diagnostic log
(below the split), which needs the same fact to tell the falsifiable-absent
case apart from an ordinary read-failed -- kept as one pure helper rather
than two copies of the same three-condition check.
```

## diffGateStateIntent

```
diffGateStateIntent: compares the payload THIS run intended to post
(`intent`) against a payload actually read back (`actual` -- e.g.
selectGateState's `.payload`, or the Report-phase verify sweep's direct
re-read). Three verdicts:
- 'match'      -- byte-for-byte the same write (JSON.stringify-equal).
- 'superseded' -- `actual` is a LATER write from the SAME run (same
`run`, later `write_seq`) -- expected and not alarming:
a later boundary in this same run posted after `intent`
was captured (e.g. a later pr-review iteration's write
landing after an earlier iteration's intent snapshot).
Ordering is on `write_seq`, NOT `epoch` (issue #166 PR
#177 review) -- RUN_EPOCH is assigned once at Select and
is identical on every boundary a single run posts, so it
can never distinguish an earlier write from a later one
within that run; only the monotonic per-write
GATE_STATE_WRITE_SEQ counter does.
- 'mismatch'   -- anything else: a different run's write sitting where
ours should be, an EARLIER write, or same-run content
that disagrees without a later write_seq to explain it
-- real corruption or a lost write.
```

## attachGateStateBlocks

```
attachGateStateBlocks: per-preflight normalizer AND real-data join, mirroring
attachEngineOwnedIntentional's shape (:3023) -- guarantees every preflight
carries all four gate-state PREFLIGHT_SCHEMA fields (gate_state_blocks,
gate_state_read_ok, gate_state_total_comments, gate_state_trust)
UNCONDITIONALLY. Pure and side-effect-free: returns a NEW array, never
mutates `preflights` or `rowsByIssue`.

`rowsByIssue` (optional; keyed by issue NUMBER) carries fetchGateStateBlocks'
RAW per-issue probe rows -- {raw, exit_ok} straight off GATE_STATE_PROBE_SCHEMA,
UNPARSED -- this function is what runs parseGateStateProbeRow, so a truncated
or non-JSON `raw` string handed in here surfaces as gate_state_read_ok:false,
never as an empty-but-successful read. `selfLogin` is the reduced
self_login string (see fetchGateStateBlocks below the split) stored verbatim
as gate_state_trust -- a FUTURE consumer's selectGateState call uses it as
evidence.self_login; this function itself never decides trust or state.

Every preflight's four fields are ALWAYS computed fresh from `rowsByIssue`/
`selfLogin` -- NEVER read back off the preflight object's own pre-existing
values, even when `rowsByIssue` has no entry for that issue. This is
deliberate: these four fields are read-only FACTS this run's own probe
resolved, never something an upstream agent (e.g. the preflight probe,
which happens to share PREFLIGHT_SCHEMA) gets to assert on its own — a
hallucinated gate_state_blocks arriving on `p` from anywhere else is always
clobbered to the real (or fail-open default) value, exactly like
attachEngineOwnedIntentional never trusts an agent-supplied regime.
```

## CONSOLIDATION

```
=============================================================================
CONSOLIDATION (unit-of-work) FOUNDATIONS

A "unit" is either a singleton (today's per-issue path, verbatim) or a group
(a primary issue + members[] processed as one worktree/branch/research/plan/PR).
With zero groups every unit is a singleton, so a no-overlap run behaves
byte-for-byte like today — that's the acceptance bar this whole abstraction is
built to preserve.

Judgment (the opus gate + capped contrarian challenge that PROPOSES groups) is not
implemented here — this section only holds the pure, harness-testable plumbing it
will be built on: the schema above, the comment markers that let a resumed run
recognize a prior consolidation, and the reducers that turn "what the markers say"
plus "what's live right now" into the units runPool() actually processes.

STABLE GROUP ID: a group's PHYSICAL identity (worktree issue-N, branch issue-N-*,
PR head — see scripts/setup-worktree.sh and the process_pr path) is bound to a
group id that is chosen once and never changes. The group's LOGICAL primary (the
issue carrying the comment trail) can move on re-anchor (e.g. the original primary
got skip-flipped by a resume), but the group id does not — mixing the two up is
exactly the contradiction the approach-gate contrarian caught. By convention the
group id is the lowest issue number that has EVER been a member (see
stableGroupId()); it is also the key healGroups()/reconcileGroups() index by.
=============================================================================
```

## reconcileGroups

```
reconcileGroups: make LIVE claimed preflights authoritative over group membership.
A member whose live preflight resume_point is 'skip' (already merged, closed,
claimed by another concurrent run, ...) is excluded — it takes its own ordinary
path (a skip singleton) instead of blocking or corrupting the group. A member
resolved to 'implement' OR 'process_pr' stays live and IN the group: 'process_pr'
is exactly the state every member lands in when a PRIOR run created the group's
shared PR (one "Closes #N" per member) but crashed/failed before merging it — on
resume, the preflight probe matches that SAME PR for every member, so the whole
group must keep routing together as one unit (worktreeAnchor's stable groupId,
one reviewAndMerge call on the shared PR) instead of splintering into N
independent process_pr singletons that would each attempt to review/merge it.
If the excluded member was the group's primary, the group re-anchors onto
another live member (lowest issue number, for determinism) — groupId, and
therefore the group's worktree/branch/PR identity, never moves. A group left
with fewer than 2 live members dissolves entirely (returns no entry): its one
remaining member, if any, falls through to deriveUnits as an ordinary
singleton, same as if it had never been grouped.
```

## deriveUnits

```
deriveUnits: the final translation from "reconciled groups" + "live preflights" to
the array runPool() actually iterates. Every reconciled group becomes ONE unit
(a live-preflight-shaped object for the primary, with members: the live preflight
refs of every group member, groupId, subsystem, rationale attached); every other
live preflight becomes an ordinary singleton unit (members: [self], groupId: null)
— the exact shape processIssue()'s ctx init below defaults to, so a no-group run
produces units identical to today's preflights array.
engineOwnedIntentional (issue #3) is OR-folded across a group's live memberRefs
(.some), not just inherited from the primary — Object.assign({}, primaryRef, ...)
below would otherwise silently carry ONLY the primary's own flag, and pickPrimary
picks a primary for group-identity reasons entirely orthogonal to intent (lowest
issue number / proposed primary), so a deliberate-engine member that isn't the
primary would be invisible to any consumer reading it off the unit. A singleton
unit needs no such fold: Object.assign({}, p, {...}) below already spreads p's
OWN engineOwnedIntentional through untouched.

predicted_files/depends_on (issue #1, lane scheduling): every preflight carries
these two OPTIONAL arrays (normalized to [] by the probe's .then() above). A
singleton unit carries its own straight through the Object.assign spread below
(p.predicted_files/p.depends_on are already on p) — no extra work needed. A
group unit's predicted_files is the union over every live member (unionField
above); its depends_on is that same union MINUS any ref onto a fellow member of
THIS group — that dependency is already satisfied by the merge (both issues land
in the same unit), so keeping it would dangle a lane edge onto an issue number
that no longer exists as its own unit once grouped.

revisit_risk (issue #93): OR-folded across a group's live memberRefs exactly
like engineOwnedIntentional above and for the same reason — a member whose
OWN revisit_risk is flagged must not go invisible just because pickPrimary
chose a different (unflagged) member as primary. reasons are concatenated
(not deduped: each reason already names the specific file/issue/grade it
came from, so two members flagging on genuinely different evidence should
both surface). A singleton unit needs no fold: Object.assign({}, p, {...})
below already spreads p's OWN revisit_risk through untouched.
```

## computeLanes

```
computeLanes: pure reducer (issue #1, lane scheduling) that groups deriveUnits()'s
output into lanes — sets of unit INDICES that must run serially (one worker
draining the lane in order) instead of racing. Reuses globToRe/matchesGlobs
(defined below; hoisted, so fine to call from here) for glob matching. Returns
an array of { unitIndices: [index,...], predicted_files: [path,...] }, one per
connected component, sorted by each lane's lowest unit index for determinism;
a unit connected to nothing is its own lane of size 1 — with no overlap
anywhere, this returns units.length singleton lanes, degenerating byte-for-byte
to today's every-unit-races-every-unit pool.

Union-find over unit indices with two edge tiers:
- TRUSTED (always unite, never dissolved): a serialize_globs pattern matched
by >=1 predicted_files path of each unit (same pattern), or a depends_on
reference from one unit onto another (resolved via each unit's own issue
plus every member's issue, so a grouped unit's members all resolve to it).
- HEURISTIC (unite unless suppressed by the collapse guard below): a shared
normalized predicted_files path between two units, or — only when no path
is shared — a shared basename (weaker, e.g. same filename in different
directories).

Cohesion-aware collapse guard (NOT size-keyed — a lane's fate never depends on
how many units or edges it has, only on overlap structure): every heuristic
edge is graded by what the SPECIFIC PAIR it connects directly co-predicts —
STRONG (that pair alone shares >=2 distinct paths/basenames — e.g. an
implementation file plus its test) is self-sufficient and always survives.
WEAK (that pair shares exactly one) only survives as part of a WEAK-EDGE-ONLY
chain whose edges collectively touch >=2 DISTINCT keys, counted strictly from
the weak edges' own shared keys — never inherited from a neighboring strong
cluster's unrelated paths. That scoping is what stops a single popular path
(a magnet) from dragging a unit that touches only it into a lane that is
cohesive for entirely unrelated reasons: a unit sharing only a magnet path
with one member of a genuine 2-path cluster must not serialize with the whole
cluster just because that cluster happens to pass the >=2 bar on its own.
A weak chain that never reaches 2 distinct keys is a single-path promiscuous
connector — the shape a magnet file produces (many otherwise unrelated units
all touching one popular path) — and dissolves back to trusted-only, i.e.
those units race instead of serializing. Trusted edges are never touched by
this guard.

DF (document-frequency) signal: advisory/metric-only, logged when a predicted
path is matched by more than half the batch (min 3 units) — surfaced for human
visibility but NEVER used to drop an intersection key or suppress an edge; that
job belongs solely to the collapse guard above. serialize_globs paths are never
counted toward DF (they're a deliberate trusted signal, not a magnet).

opts.trustedOnly (issue #1, lane scheduling — used by the real-run collapse
guard right before runPool() drains, workflows below the harness split): skips
the DF log and the whole heuristic-edge/collapse-guard section, unioning ONLY
serialize_globs + depends_on. Lets the drive code ask "which of the lanes I
already computed would exist on trusted edges ALONE?" without re-deriving that
graph by hand — a lane whose membership is identical trustedOnly is provably
never touched by a heuristic edge and must never be dissolved.
```

## applyRealRunCollapseGuard

```
applyRealRunCollapseGuard: pure reducer (issue #1, lane scheduling) — a final,
run-time safety net called immediately before runPool()'s real drain (dry-run
separately previews lanes read-only, before claims settle — see the DRY_RUN
block). computeLanes() already guards its OWN edges locally/per-chain (see its
module comment) — this is coarser and whole-batch scoped, for a shape its local
view can't see: a long chain of pairwise-weak edges, each sharing a DIFFERENT
path with its neighbor, can reach computeLanes()'s own ">=2 distinct keys" bar
in aggregate without the lane, taken as a whole, actually cohering around
anything. Only recomputes anything when collapse_ratio (effective lane
concurrency over what a flat pool would've given) < 0.5 AND there was enough
work to want that concurrency in the first place (unitCount >= concurrency) —
with too little work, `lanes` passes through completely untouched.

Mirrors computeLanes()'s discriminator one level up (whole lanes, not edges): a
lane whose membership is IDENTICAL to recomputing computeLanes() with heuristic
edges disabled (serialize_globs + depends_on only, via { trustedOnly: true }) is
TRUSTED and is always kept, no matter its size. Any other multi-unit lane is
HEURISTIC; it survives only if its units, taken as a whole, actually co-predict
>= 2 distinct paths (a genuinely cohesive cluster) — otherwise it's a
single-path magnet connector computeLanes()'s local/chained view let slip
through in aggregate, and is dissolved back into one singleton lane per unit
(those units then race instead of serializing).

Returns { lanes, dissolvedCount, collapseRatio } so the caller can log/branch
without duplicating the ratio math; `lanes` is the SAME array reference when
dissolvedCount is 0 (no-op fast path).
```

## isBudgetExhaustedError

```
isBudgetExhaustedError: only a real budget/token-exhaustion signature is
fatal for the whole run (tripStop), not a per-attempt death — shared by
stage() and consolidationAgent() so the two call sites can't drift on what
counts as one. Requires a budget/ceiling/tokens NOUN to co-occur with an
exhaust/exceed/deplete/ran-out/overrun-shaped/limit-reached VERB; either
alone is not enough, so a target repo's own domain error that merely names
"budget" (no exhaustion verb) or merely exceeds something unrelated (no
budget noun) is left to the ordinary per-attempt retry + recordAgentDeath()
path instead of halting the whole run. The noun side deliberately excludes
bare singular "token": that word alone is common in non-budget domain
errors (auth tokens, CSRF tokens, API rate-limit tokens) and, paired with
an exhaustion-shaped verb like "limit reached", produced false positives
(e.g. "authentication token expired; retry limit reached"). "token" only
counts when pluralized ("tokens", as in "ran out of tokens") or directly
qualified by "budget"/"limit" ("token budget", "token limit"). The "over"
family is deliberately anchored to overrun-shaped phrasing (overrun/
overage/went over/ran over/over budget/over the limit) rather than the
bare word "over", which shows up in ordinary prose ("budget review is
over") without meaning exhaustion.
```

## gate-findings-tally

```
----- gate findings tally (issue #87 task 3, issue #91 wired in pr-review, issue #163 wired in quality) -----
Per-gate (the two per-issue contrarian gates 'approach'/'plan', the
per-task-plus-per-PR-fix-round 'quality' code-review gate, plus the
per-task 'pr-review' merge gate) tally of finding counts, severity mix, and
how that gate ITERATION resolved:
accepted            - the gate iteration passed clean: for approach/plan,
verdict sound_with_caveats with zero critical/major
(the same condition that triggers settleDecision());
for pr-review, both spec and code review returned
'approved' — still the only condition that may set
reviewAndMerge's approved = true, though (issue
#162) it is no longer the same condition that ends
the loop: an unclean iteration where both
reviewers independently had nothing to fix now
exits early too, tallied below as carried-unresolved.
carried-unresolved  - the gate did not reach a clean pass: either (a) the
iteration cap was reached without both reviewers
approving — for approach/plan, critical/major
findings are still open (they ride into
ctx.unresolved) — or (b) for pr-review (issue #162)
and quality (issue #163) alike, the reviewer(s)
requested changes while naming no structured
findings to fix, so a fix stage would have had
nothing to act on — or (c), added by issue #167, a
fix agent shown this gate's findings rebutted every
one of them (FIX_SCHEMA.rebutted, normalized by
normalizeRebuttals()) and applied no fix
(fixes_applied and files_changed both empty):
retypeGateDisposition() retypes that iteration's
already-booked disposition to carried-unresolved
after the fact, at quality and pr-review — the two
of these gates whose disposition this tally actually
records. test-quality has the identical
rebuttal-only exit (same predicate, same
FIX_SCHEMA.rebutted field) but books no
gate_findings entry in the first place (it isn't one
of the four gates this tally covers), so route (c)
at test-quality is visible only via
ctx.metrics.rebuttal_only_rounds and the
contested-findings ledger, never in this tally. For
pr-review, (a) and (b) land on the same needs_human
outcome; only ctx.metrics.findings_empty_exits
distinguishes them from each other. (c) at pr-review
does NOT land on needs_human the first time it
fires — a single rebuttal-only pr-fix round
continues the review loop into another iteration
instead; only a second rebuttal-only round in the
same reviewAndMerge() call joins (a) and (b) on
needs_human. ctx.metrics.rebuttal_only_rounds is
what distinguishes (c) from (a)/(b): a
carried-unresolved pr-review tally with
rebuttal_only_rounds > 0 for that iteration means a
fixer disputed the findings, not that the cap ran out
or nothing was named. quality has a single reviewer,
not a pair, so its (b) is one changes_requested
verdict with issues: [] — that branch sets
runQualityLoop's own approved = true (see below) even
though it still tallies carried-unresolved here:
"clean" for the loop's control flow and "clean" for
this gate tally answer different questions. Route (c)
at quality also sets its own loop-exit flag
(`rebutted`, kept separate from `degraded`) rather
than approved = true — a rebuttal-only round is a
dispute, not a clean review, so it does not get the
same "clean for control flow" treatment (b) does.
re-litigated        - neither of the above: the loop revises and
re-contests, so these findings get judged again
next iteration (a fix stage for pr-review, a
re-evaluate stage for approach/plan).
dismissed           - the gate produced no adjudicated verdict at all
(challenger/reviewer agent died) — any findings
were never actually judged. pr-review has no
equivalent call: a dead reviewer there fails the
run immediately (see reviewAndMerge) rather than
tallying an outcome. quality has two dismissed
call sites instead (see runQualityLoop): the
simplify agent dying before a review verdict ever
existed, and the review agent itself dying.
One call per gate ITERATION (not per finding), so `disposition` tallies
outcomes while `severity` sums every finding's severity across every
iteration of that gate. Bounded implicitly: one entry per gate name;
approach/plan run at most challengeCap (<= MAX_CONTRARIAN_ITERATIONS) times,
pr-review at most MAX_PR_REVIEW_ITERATIONS times, per issue/task. quality
runs once per task plus once per PR-fix round (up to
MAX_QUALITY_ITERATIONS iterations each), so its denominator is not
directly comparable to pr-review, which runs once per issue (up to
MAX_PR_REVIEW_ITERATIONS iterations) — see the footnote in
computeGateYield.
NOTE (issue #162): REVIEW_SCHEMA.issues is now typed the same shape as
CHALLENGE_SCHEMA.findings (severity/summary required, recommendation
optional — literally true on both schemas as of #164, which dropped
recommendation from CHALLENGE_SCHEMA.findings.items' required list), and
all four REVIEW_SCHEMA-producing prompts (spec review, code
review, quality review, test validation) ask for it via ISSUES_ASK. Before
this change, the same call site already passed `(spec.issues ||
[]).concat(code.issues || [])` into recordGateOutcome, which counts by
entry length regardless of shape — so `gate_findings['pr-review'].severity`
already carried real, non-zero counts whenever a reviewer happened to put a
concern in `issues` rather than `comments`. Now that all four prompts ask
for it explicitly, those counts are guaranteed and schema-backed rather
than incidental. `unspecified` is
still possible in principle (recordGateOutcome only increments a bucket
for the three known severities) but should not occur in practice: the
schema requires `severity` to be one of critical/major/minor, and
normalizeFindings only falls back to 'unspecified' for a shape that slips
past validation.
```

## findingsBlock

```
findingsBlock (issue #162): the single renderer feeding every fix stage (quality-
fix, pr-fix, test-quality-fix) — the ONE place that decides what a fix agent sees
of a review, so structured findings and prose comments never drift apart across
the three sites. Three branches:
findings === null   - the reviewer omitted `issues`; emit EXACTLY what the
call site emitted before this change (comments falling
back to summary falling back to a caller-supplied
label) so this leg is a byte-identical prompt to today.
findings.length > 0 - render the work list using the existing pr-fix line
shape (:4259) with the id prefixed, then the prose
`comments` below under a context-only heading — the
fix agent's job list is the findings, not the prose.
(issue #167: a fix agent may rebut, not fix, any
finding rendered here — record the disagreement in
FIX_SCHEMA.rebutted with the concrete evidence that
disproves it, rather than changing code to satisfy a
finding it judged wrong. Only a finding that reaches
this branch, carrying the bracketed id this renderer
prefixes onto each line, can be rebutted; a finding
that shows up only in the `comments` prose below, or
only via the findings === null fallback above, has no
id to rebut against and must be fixed outright or
addressed in the fixer's own summary instead.)
findings.length === 0 - a reviewer that validated `issues: []` alongside
changes_requested (reached only by the pr-review gate
in task 2, where one reviewer has zero findings and
the other has some — both internal loops here exit
before ever rendering this branch). State plainly that
no structured findings were named, and still render
the prose below under the same context heading: an
empty array must never suppress or demote prose.
```

## pure-aggregation-per

```
Pure aggregation of per-issue/per-stage token deltas into per-issue,
per-model, and per-stage subtotals, plus a finished markdown "## Token
Usage" section — all math done here in JS, never delegated to an LLM.
Takes no globals; harness-testable in isolation.
results      - the run's per-issue result array. Entries lacking a `.tokens`
field entirely (skipped/not_started — never got a ctx) or
carrying `.tokens.tracked === false` (ctx existed but no stage
ever sampled a usable budget.spent() pair) both render
"not tracked", never a false zero.
spent        - the guarded, run-wide budget.spent() total (Number or null).
concurrency  - CONCURRENCY. Only per-issue rows are affected by it:
=== 1: per-issue stage deltas cannot overlap, so they're an exact
partition of that portion of the run (reconciles: true, given spent
and some tracked data).
> 1: multiple issues' stages run side by side against ONE shared
monotonic counter — agent() returns schema content only, never a
per-call usage figure, so there is no way to split budget.spent()'s
movement between concurrent callers. Overlapping stages each see (and
get attributed) the same movement, so per-issue deltas over-count and
the whole breakdown is labelled approximate (reconciles: false) —
but ONLY when some per-issue row is actually tracked (anyTracked).
If every per-issue row is untracked and the breakdown is carried
entirely by stage buckets (below), there is no per-issue over-count
to guard against — those buckets are region-boundary-bracketed
outside the concurrent pool regardless of concurrency — so that
stage-only breakdown still reconciles exactly (reconciles: true)
even at concurrency > 1.
byStage      - optional (normalizes to {}, so existing 3-arg callers are
unaffected): a flat { preflight, select, ... } map of
region-bracketed orchestration spend sampled OUTSIDE the
concurrent per-issue pool (see STAGE_TOKENS), so it's exact
regardless of `concurrency`. Every nonzero bucket folds
into sumDeltas exactly once and renders as its own labeled
row (STAGE_LABELS) — never absorbed silently into the
remainder below, and never double-counted by it. A run
where every per-issue result is untracked but the stage
buckets are populated (e.g. a resumed run) still counts as
"tracked" and still renders a breakdown, via anyStage.
poolSpend    - optional (issue #111; absent/non-finite preserves every
byte of pre-#111 behavior for existing 3-/4-arg callers,
including reconcile_error's denominator): the exact
budget.spent() delta bracketed immediately around the
runPool() call (sampled OUTSIDE this function, by the
caller — see the runPool() call site), i.e. the per-issue
pool's own share of the run. When finite, reconcile_error
is RE-SCOPED off the full run total to this pool-scoped
denominator: |poolSpend - perIssueSum| / poolSpend, where
perIssueSum is ONLY the per-issue tracked totals (NOT
byStage's preflight/select buckets, which are bracketed
outside the pool by construction and so are never part of
what poolSpend measures). At concurrency 1 this reconciles
near-exactly (both sides sum the same contiguous
spentTokens() deltas), same caveat as `reconciles` above —
it still catches a future bare-agent() regression inside
the pool, and remains a real (non-tautological) check at
concurrency > 1. The run-total-vs-pool gap (max(0, spent -
poolSpend) — preflight/select-phase orchestration plus
anything else sampled outside the pool, e.g. the
claims-release sweep) is surfaced honestly as its own
`orchestration_overhead` field/markdown line instead of
being folded into (or driving) the attribution-error
signal. `pool_spend`/`orchestration_overhead` are both null
when poolSpend is absent/non-finite. run_total/attributed/
remainder (below) are UNCHANGED by poolSpend — they still
describe the full run against the full sumDeltas, exactly
as before.
remainder (whatever budget.spent() counted that no per-issue row or stage
bucket attributed — max(0, spent - sumDeltas)) is computed and rendered as
its own "orchestration/unattributed" row whenever `spent` is available,
regardless of concurrency/reconciles — including the approximate
concurrency>1 case, so that spend is never left implicit — since the stage
buckets are already folded into sumDeltas, it is never double-counted.
```

## reconcile_error

```
reconcile_error (issue #90, re-scoped by #111): the HONEST reconciliation
signal downstream efficiency metrics (rework-tax, issue #91) MUST gate on,
never on the `reconciles` boolean above (which is defined true whenever
concurrency===1 and some spend is tracked, OR whenever concurrency>1 but
no per-issue row is tracked — in neither case ever comparing the
attributed sum to a real total).

When poolSpend is finite (issue #111): re-scoped to the per-issue-
attributable slice — reconcile_error = |poolSpend - perIssueSum| /
poolSpend, where poolSpend is the exact budget.spent() delta bracketed
around the runPool() call and perIssueSum is ONLY the per-issue tracked
totals (stage buckets are bracketed outside the pool, so they're outside
this denominator too — see the poolSpend param doc above). This avoids
the old formula's dominant failure mode: unbracketed late-stage spend
(PR-review/merge/report/retrospective/...) inflating |spent -
attributed| against the FULL run total even though that spend was never
attributable to a per-issue row in the first place. The run-total-vs-pool
gap is surfaced honestly instead, as orchestration_overhead below.

When poolSpend is absent/non-finite: falls back to the pre-#111 formula,
byte-identical for existing 3-/4-arg callers — reconcile_error = |spent -
attributed| / spent, null when budget.spent() is unavailable, or when
spent is 0 and nothing was attributed (trivially exact, error 0).
```

## FRICTION_WEIGHTS

```
FRICTION_WEIGHTS (issue #89): named per-signal weights for computeFriction's
non-stage "signal terms" — friction sources a capped iteration ratio can't
see. Multiplied by the signal's raw count (1 for a boolean signal) and
summed alongside the seven capped stage ratios. Ordered/weighted by how much
extra rework each signal actually costs:
needs_human             - the unit never resolved on its own; the single
worst outcome a run can produce, so it dominates.
merge_thrash             - the batch branch moved again mid-rebase, forcing
a mandatory re-test + re-rebase cycle.
contrarian_capped        - a flat penalty for hitting a contrarian cap WITH
findings still unresolved (frictionFields).
unresolved_count         - per-finding granularity ON TOP OF contrarian_capped,
so a capped-out issue carrying five open findings
scores higher than one carrying only one.
quality_degrades         - each time the quality loop's simplify, review,
or fix AGENT DIED mid-loop (see runQualityLoop),
not each time the loop merely regressed on
quality. Cap exhaustion (all iterations spent
without a clean review, no agent death) also
returns 'degraded' from runQualityLoop, but the
increment above only fires on the agent-death
branches — cap exhaustion never touches this
counter. Its own signal lives at
gate_findings.quality['carried-unresolved']
instead (issue #163); the misleading name is
kept as-is to avoid an unrelated rename.
test_quality_fix_rounds  - each extra fix round the test-quality gate forced.
```

## computeFriction

```
computeFriction (issue #89): pure per-issue/per-stage friction rollup — no
LLM math, same "load via harness.boot(), call directly" pattern as
aggregateTokens/aggregateMergeAutoResolve above, meant to be injected
verbatim (via composeFrictionChurn) into the batch-PR body / report agent.

Each of the seven capped pipeline stages (approach/plan/task-review/quality/
test/browser/pr-review) contributes a normalized min(1, iters/cap) ratio —
running below a cap is normal, not friction. Four of the seven stages
(approach/plan/test/pr-review) run at most once per issue, so their
denominator is that single loop's cap; quality is the one whose pooled
denominator is implemented here (cap * quality_scopes, via multiScopeField
below) rather than one loop's cap against a multi-loop numerator.
task-review and browser are multi-scope aggregates too and not yet counted
this way (see multiScopeField below).

Caps are read LIVE off module scope inside the function body (MAX_CONTRARIAN_
ITERATIONS et al — the same idiom aggregateTokens uses reading STAGE_LABELS),
never captured once at module load, so a __seed()-overridden cap in tests
changes the ratio it computes, not a stale snapshot.

On top of the seven ratios, FRICTION_WEIGHTS-weighted signal terms add
friction a pure iteration count can't see: frictionFields' contrarian_capped/
unresolved_count/needs_human (spread onto every result — see frictionFields'
own doc comment) plus ctx.metrics' quality_degrades/test_quality_fix_rounds/
merge_thrash. Each nonzero stage/signal becomes one entry in that issue's
`drivers` breakdown, sorted by contribution descending, so the markdown/JSON
both explain WHY an issue ranked where it did, not just its final score.

Defensive the same way aggregateMergeAutoResolve is about a null/empty
results array or a result missing .metrics — degrades to a clean, empty,
has_signal:false rollup, never throws.
```

## engine-owned-gate

```
=============================================================================
ENGINE-OWNED GATE (issue #3, regimes b/c) — the deterministic post-implement
backstop. scopeGuard()'s engine-owned clause (above) is advisory layer 1; this
is layer 2. Modeled on runBrowserCheck immediately above: a READ-ONLY probe
runs `git diff --name-only` against the batch baseline and returns every
changed file; JS (never the agent) filters that list via matchesGlobs against
ENGINE_OWNED, then routes on ctx.engineOwnedIntentional — computed once at
Select from THIS issue's own prose (engineOwnedHit) and OR-folded across a
consolidation group's live members (deriveUnits) — per the three-regime model
documented above ENGINE_OWNED_GLOBS:
(b) intentional: this issue's own prose plainly targets the engine-owned
set, so an engine-owned diff is expected, deliberate work (e.g. issue
#3 itself). Leave the implementation exactly as committed — no revert.
(c) NOT intentional, but engine-owned paths showed up in the diff anyway:
the incidental/paraphrased silent-restore vector nonconvexlabs-com #77
actually was. A single-purpose stage hard-reverts ONLY the paths where
isHardRevertPath(f, ENGINE_OWNED, LOCKSTEP_INSTALLED_PATHS) is true —
lockstep-installed paths (e.g. this repo's own
.claude/workflows/ticketmill.js) are deliberately exempted so a
source-of-truth edit's installed lockstep copy is never clobbered by
this gate; any resulting divergence is left for the test loop's own
lint-engine byte-compare to catch in-band — see isHardRevertPath's doc
comment — to the batch baseline (origin/TARGET), commits, and pushes.
Placed BEFORE runTestLoop() in implementIssue() (not near runBrowserCheck,
which runs AFTER the test loop) so a revert this gate makes is re-validated
by the SAME run's test suite / lint-engine byte-compare, in-band, rather
than landing unverified.
Never halts the run on its own: a dead probe or a failed/dead revert stage
degrades to a recorded deferred follow-up (mirrors the anti-pattern rule —
a skipped verification must be recorded, never silently swallowed) so a
plumbing hiccup in this gate never blocks an otherwise-green issue.
Returns { ok: true } always.
=============================================================================
probeChangedFiles (issue #87): READ-ONLY diff probe that captures the FINAL
changed-file list for an issue, run once, unconditionally, from
reviewAndMerge() immediately before the merge stage — after the full
review/fix loop (pr-fix, merge-auto-resolve) has already landed, and before
the merge stage's own worktree teardown. This is deliberately a SEPARATE
probe from runEngineOwnedGate's own post-implement one just below: that gate
snapshots the diff right after implementation (its revert-or-not decision
needs the pre-review state), while this one snapshots the diff analytics
downstream (touch_counts, completeness scoring) actually want — the merged
result including any PR-review fixes or auto-resolve rebasing. Populates
ctx.changed_files/ctx.added_files. On a dead/degraded probe, leaves both
null (never []) so `!= null` distinguishes "captured, zero files" from
"probe never ran" for downstream completeness scoring.
```

## probeCommitShas

```
probeCommitShas (issue #79, Layer 2 — post-hoc validation of agent-posted
commit SHAs): follow-up to #47/PR #78's COMMIT_SHA_ASK (Layer 1, advisory
only — it tells the agent HOW to get the real SHA, but the `commit` field a
stage returns is still unverified free text). Same read-only-dispatch shape
as probeChangedFiles() immediately above, but a DIFFERENT call site in
reviewAndMerge(): probeCommitShas() runs BEFORE runMergeAutoResolve(),
deliberately, because a rebase+force-push there legitimately rewrites every
commit's SHA (parent hashes change) — validating pre-rebase, while every
posted SHA still resolves in the worktree, means there is nothing left to
re-validate afterward and no reset of ctx.postedCommits is needed. Checks
ctx.postedCommits — every non-null `commit` collectPostedCommit() gathered
at the 8 COMMIT_SHA_ASK sites, all of which fire earlier in reviewAndMerge()
than this call — instead of the working diff. Early-returns with NO dispatch
when nothing was posted (the common case: many stages never report a
commit). One read-only haiku probe for the whole issue, not eight per-site
round-trips. On a missing SHA: flagged via VERIFY_SKIPS (surfaces in the
batch PR's Verification Gaps section) and ctx.deferred (fabrication-incident
framing naming the posting stage) — never halts. On probe death:
degrade-recorded via ctx.deferred, never blocks — mirrors probeChangedFiles.
```

## merge-auto-resolve

```
=============================================================================
MERGE AUTO-RESOLVE (mechanical CONFLICTING recovery, modeled on
runBrowserCheck: an internal probe decides whether to act at all, then a
bounded sequence of mechanical git stages plus one judgment stage do the
work.) Inserted into reviewAndMerge immediately before the merge stage, so a
PR that preflights CONFLICTING gets one mechanical recovery attempt before
falling back to today's immediate needs_human escalation.

Flow: settle-poll probe -> only on CONFLICTING: fetch+rebase onto TARGET's
current tip in the still-live worktree -> on rebase conflicts, a
conflict-resolver stage (implementer persona, judgment call) prefers keeping
BOTH sides of a hunk, aborts on anything semantic -> mandatory GREEN test
loop on the rebased state, FORCED (the safety property here is the test
suite re-verifying the EXACT state about to be force-pushed, not the
resolver's judgment — it must not skip just because the rebase itself
touched no test-glob files) -> a cheap guard that TARGET hasn't moved again
while tests were running (if it has, escalate rather than silently
re-rebasing and force-pushing content tests never verified — see the guard
below) -> force-push with lease.

Gated on a real test_command: with test_command:null there is no suite to
re-verify against — the stated safety property does not exist — so this
whole flow is skipped and a CONFLICTING PR falls straight through to the
merge stage's own preflight (today's behavior, unchanged: the fallback, not
the default).

Returns { ok: true, resolved: boolean } | { ok: false, error }
resolved: true only when this flow actually rebased the branch onto a
newer TARGET tip and force-pushed it — including a CLEAN rebase with no
conflicts (e.g. already-upstream sibling commits), since the merged diff
still differs from the reviewed head either way. The caller bumps
ctx.metrics.merge_auto_resolved itself, and only once the merge stage that
follows actually reports merged=true — a resolved-but-still-blocked PR
(re-conflicted again, or another preflight reason) must not inflate the
metric.
=============================================================================
```

## PROPOSECONSOLIDATION

```
=============================================================================
PROPOSECONSOLIDATION (Select-phase judgment gate; ABOVE the harness split like
implementIssue/reviewAndMerge, so tests/harness.js can drive it with a scripted
agent()). Takes EVERY live preflight, any resume_point — not just 'implement' —
because the HEAL phase below must recognize a group whose members have since
flipped to 'process_pr' (the shared PR already exists; a prior run crashed
after creating it) or 'skip' (one member resolved independently); filtering the
candidate set to 'implement' up front would hide those markers from healGroups()
entirely. Only the PROPOSE phase (brand-new opus-gate groupings) is restricted
to 'implement' candidates — see its own filter below. Proposes grouping
candidate issues into ONE worktree/branch/research/plan/PR unit when — and only
when — they share the same subsystem AND acceptance surface, or one explicitly
depends on another. Grouping is the EXCEPTION: the conservative-bar prompt below
treats "shared files touched" as a hint, never a reason, and an empty run
(0 or 1 candidates) short-circuits for free with no agent call at all.

TWO-PHASE, LIKE THE APPROACH/PLAN GATES IN implementIssue() — WITH ONE
DELIBERATE ASYMMETRY:
1. HEAL: fold in any group a PRIOR run already proposed and recorded via
comment markers (buildConsolidationGroupComment/buildConsolidatedMemberComment,
see the CONSOLIDATION FOUNDATIONS block above) — a resumed run recognizes an
existing decision instead of re-litigating it. This runs even when
PROFILE.consolidation === false: turning the gate off mid-run must not
un-heal a group a PRIOR run already committed to.
2. PROPOSE + CHALLENGE: only the residual, unmarked candidates go in front of
the opus gate; each proposed group then runs a CAPPED contrarian challenge
(reusing CHALLENGE_SCHEMA and the 'contrarian' role, exactly like the
approach/plan gates). THE ASYMMETRY: where those gates proceed-with-caveats
at the cap, a contested consolidation group instead DISSOLVES back into
independent issues. Grouping entangles multiple issues' worktree/branch/PR
into one unit — an unresolved "maybe these shouldn't be one unit" is not a
caveat implementation can absorb the way "maybe this approach has a risk"
is, and the safe fallback (process each issue independently) is always
available — so the gate takes it instead of forcing a doubtful merge
through. The same reasoning is why a DEAD challenger also dissolves rather
than proceeding unchallenged (implementIssue's gates fail open there
because the issue MUST be implemented regardless; this gate is a pure
optimization it is always safe to skip).

DRY_RUN: the marker heal and the opus PROPOSAL are read-only (gh issue view /
--json reads only — no writes) and run exactly the same under DRY_RUN as for
real. The CONTRARIAN CHALLENGE is skipped ENTIRELY under DRY_RUN (it posts
trail comments) — a dry run previews the raw, PRE-CHALLENGE proposal instead
(each such entry carries dry_run_preview: true so a caller never mistakes an
unchallenged preview group for a finalized one).

MARKERS: posting the group/member consolidation-marker comments themselves is
deliberately NOT this function's job. Real membership is only settled after
claims (a member can be excluded by reconcileGroups() if its claim races or its
resume_point flips) — see reconcileGroups()/deriveUnits() above. Posting markers
here, before claims, could stamp a marker naming a member that never actually
joins the live unit; the post-claim materialization step (Select-phase wiring)
owns marker posting instead.

RETURN: Map<groupId, {groupId, primary, members: [issueNumbers], subsystem,
rationale, dry_run_preview?}> — the SAME shape healGroups()/reconcileGroups()
return, so a caller can hand it straight to reconcileGroups(map, livePreflights)
after claims. Only ACCEPTED groups (healed, or opus-proposed + contrarian-
accepted) appear; dissolved/never-grouped candidates are simply absent — callers
fall them through to deriveUnits()'s ordinary singleton path, exactly like an
issue that was never a consolidation candidate at all.
=============================================================================
```

## fetchGateStateBlocks

```
fetchGateStateBlocks: READ-ONLY (safe under DRY_RUN) — the whole-set gate-
state read, shaped like fetchConsolidationMarkers just above it, but the
READ IDIOM is deliberately NOT that one: fetchConsolidationMarkers hands the
agent a bare `gh issue view --json comments` and trusts its own judgment to
pick the right comment, which lets a truncated response get silently
misread as "no marker". Gate state instead pins the claim probe's
deterministic idiom (the per-issue `gh issue view ... --jq '{total, blocks}'`
a few thousand lines below, in the claims loop) verbatim, one command per
issue: jq computes the EXACT return shape, so a short/truncated read is a
JSON.parse failure (parseGateStateProbeRow), never a fake "zero blocks".
The agent's ONLY job per issue is relaying that command's stdout — it never
parses or judges it.

Chunked at MAX_GATE_STATE_PROBE_CHUNK issues per agent call — belt-and-
braces, not a truncation defense (the jq pin already makes a truncated READ
structurally impossible to misread): a chunk whose agent call dies (throws,
budget-exhausted, or returns a malformed response) marks ONLY its own
chunk's issues read-failed via synthesized {raw: '', exit_ok: false} stub
rows — surviving chunks still report normally, rather than one dead call
taking the whole candidate set down with it. A LIVE chunk that returns a
schema-valid `rows` array simply missing one of its assigned issues (which
GATE_STATE_PROBE_SCHEMA cannot forbid) gets the SAME stub backfilled after
the chunk loop below, for the same reason: a queried-but-unanswered issue
must read as read-failed, never silently as absent.

self_login reduction: each chunk independently runs `gh api user --jq
.login` (a single-object endpoint, so the file's "never a bare gh api"
pagination rule does not apply) since chunks run in parallel and none of
them can see another's result. The FIRST chunk (in `chunks` order) that
reports a non-empty login wins — every chunk is hitting the SAME
authenticated identity, so this is a redundant-computation reduction, not a
disagreement to arbitrate; an empty string means no chunk could resolve it
(an installation token, or every chunk died), which isTrustedGateStateAuthor
treats as "primary trust unavailable, fall through to claim_authors".

`priorWorkByIssue` ({issue: {pr_number, worktree_exists, resume_point}}) is
NEVER sent to the agent (it stays a pure verbatim relay) — it feeds ONLY
the per-issue log line below, via selectGateState's falsifiable-absent rule,
so "zero gate-state comments but a PR is already open" logs as the
DISTINCT, greppable suspicious case rather than a bare "absent" that could
hide a real read problem.

Returns { rowsByIssue, self_login } — rowsByIssue is RAW ({issue: {raw,
exit_ok}}), unparsed on purpose: attachGateStateBlocks (above the split) is
what runs parseGateStateProbeRow, so this function's own contract stays a
thin, mirror-of-fetchConsolidationMarkers relay with no decision logic of
its own beyond the per-issue log line (which is diagnostic output, not a
decision fed back into the run).
```

## verifyGateState

```
verifyGateState (issue #166, task 4): the Report-phase self-validation
sweep that proves post -> GitHub -> read -> parse for gate state in one
run. ONE stage for the WHOLE run (never 2N per-issue calls, and never the
old per-boundary-during-processIssue design GATE_STATE_VERIFY_SCHEMA's
original comment described -- that design was superseded by this
Report-phase sweep before this task landed), chunked at
MAX_GATE_STATE_PROBE_CHUNK like fetchGateStateBlocks (:4544, via the shared
chunkGateStateIssues helper) -- belt-and-braces: a dead chunk's agent call
only takes its own chunk's issues down with it, surviving chunks report
normally.

The verify prompt carries ONLY the issue numbers and the pinned per-issue
jq idiom fetchGateStateBlocks uses (via the shared gateStateProbeCommandLine
helper) -- it NEVER carries
ctx.gate_state_intent or any other part of the payload being checked
against. This is load-bearing: if the prompt included the intended
payload, the agent could satisfy the schema by echoing it back rather than
actually relaying gh's real output, and the "comparison" would prove
nothing. JS alone -- never the agent -- runs parseGateStateProbeRow, then
parseGateStateComment on the newest returned block, then diffGateStateIntent
against the result's own gate_state_intent.

phase('Report') runs on every terminal exit of a batch (STOP.tripped fills
the remaining results as 'not_started' and returns; a per-unit throw is
isolated to that unit by runPool -- see :5871), so `results` passed in here
always carries every issue's FINAL gate-state fields for this run, on every
exit path, not just a clean finish.

Six outcomes, logged one per issue via `log()`. NON-FATAL end to end:
this sweep never mutates a result's status, never throws past its own call
site, and a dead/misbehaving chunk degrades to 'read-failed' for that
chunk's issues rather than aborting the sweep. 'mismatch' and 'read-failed'
additionally push a VERIFY_SKIPS entry (issue #166 PR #177 review) -- every
other outcome is either nothing-to-verify or a clean/expected result, but
these two mean this run's self-validation either proved nothing
('read-failed') or found evidence of a lost/corrupted write ('mismatch'),
which belongs in the batch PR's Verification Gaps section, the human's only
window into what this run couldn't verify.
- 'no-intent'   -- this run never recorded a successful gate-state post
for this issue AND never recorded a failed one either
(gate_state_intent and gate_state_post_failed both
absent) -- e.g. not_started, preflight-skipped, or the
unit died before its first boundary. Nothing to
verify; not alarming.
- 'post-failed' -- postGateState() itself already reported the post
failed (ctx.gate_state_post_failed set, no intent
recorded) -- Task 2's KNOWN non-fatal path. Kept as
its own outcome so this benign, already-logged miss is
never reported alongside genuine read-back corruption.
- 'read-failed' -- the verify probe itself couldn't produce usable data
for this issue this run (no row at all, an explicit
exit_ok:false, or parseGateStateProbeRow rejected the
stdout shape) -- never conflated with a real mismatch.
- 'match'       -- diffGateStateIntent found the newest gate-state block
read back byte-identical to what this run intended.
- 'superseded'  -- diffGateStateIntent found a later write from the SAME
run sitting where the intent snapshot was taken from
(e.g. a later pr-review iteration posted after an
earlier iteration's intent was captured) -- expected,
not alarming, so this run's own later boundary is
never reported as corruption. A DIFFERENT run's write
(concurrent or otherwise) is never 'superseded' --
diffGateStateIntent requires `intent.run === actual.run`
before it even looks at ordering, so that case always
falls through to 'mismatch' below.
- 'mismatch'    -- anything else diffGateStateIntent returns: a
different run's write, an earlier write, no
gate-state block found at all despite a recorded
successful post, or same-run content that disagrees
without a later write_seq to explain it. Real
corruption or a lost write.
```

## gate-findings-tally-2

```
gate_findings tally (issue #91, retyped by issue #162): one call per
PR-review iteration, using the same disposition vocabulary as the
approach/plan gates above (see the doc comment on recordGateOutcome) —
this is the only gate #87 left unwired, so an "escaped defect" (finding
absent at approach/plan, present here) was previously undetectable.
Each reviewer's `issues` is normalized under its OWN source prefix
('spec-i'/'code-i' + iter) before the two arrays are concatenated for
the tally — the two reviews run through parallel() above and land in
one bucket, so model-chosen or shared ids would collide across
reviewers or iterations. 'accepted' means both reviewers approved (the
ONLY condition that may set approved = true, below). Two other ways an
iteration can end without a clean pass: the cap was reached with real
findings still open (same shape as the contrarian gates'
'carried-unresolved'), or both reviewers independently had nothing to
fix (nothingToFix, above) while the pair as a whole wasn't clean —
tallied as the SAME 'carried-unresolved' string (computeGateYield hard-
codes exactly four disposition keys; a fifth would be silently
dropped), distinguished only by ctx.metrics.findings_empty_exits and
haltReason's text. Otherwise the loop continues into a fix stage and
gets re-reviewed, i.e. 're-litigated'.
```

## bounded-worker-pool

```
Bounded worker pool (issue-level concurrency; agent-level pool is capped by the
harness). Lane-aware work-stealing (issue #1, lane scheduling): `lanes` — the
computeLanes() shape, [{unitIndices:[idx,...], ...}], omitted, or empty — groups
`items` INDICES into sets that must run serially instead of racing. min(limit,
lanes.length) workers each steal ONE WHOLE LANE at a time (a shared `nextLane`
counter — the same "grab whatever's next" contract the old flat pool had over
`items` directly) and drain every unit in that lane ONE AT A TIME, in
depends_on order (laneDrainOrder() below), before stealing another lane.

No lanes arg — or every lane a singleton, which is exactly what computeLanes()
returns when nothing overlaps — degenerates BYTE-FOR-BYTE to the pre-lane pool:
each lane is one item, so "steal a lane, drain it serially" IS "grab the next
item", in the same original order, with workers = min(limit, items.length).

results stays length === items.length, keyed by ORIGINAL item index regardless
of lane membership or drain order — every caller downstream (counts, batch PR
body, run report) already assumes that flat, index-stable shape.

STOP is checked before EVERY unit, not once per lane: once tripped, every
remaining unit in the lane a worker is currently draining gets a not_started
result without calling fn — and so does every unit in every lane no worker has
stolen yet, because a worker that finishes (or STOP-sweeps) its current lane
immediately steals the next one and STOP-sweeps that too. Exactly one
not_started per remaining unit, same shape the old flat pool produced per
remaining item.

A throw from fn() is caught PER UNIT inside drainUnit(), never left to bubble
into Promise.all: it becomes a `failed` result for that one unit and the worker
moves on (next unit in the lane, then next lane) exactly like a stage()-level
failure would. So Promise.all over the worker promises never rejects because of
unit-level work — a throw partway through one lane can never tear down another
lane's in-flight or already-written results, and results.length always stays
items.length no matter what any single fn() call does.

budgetCtx (issue #97 task 4, OPTIONAL — undefined/omitted is a no-op, matching
every existing caller/test that doesn't pass a 5th arg): { budget, estimateByIssue }
where `budget` is the already-resolved OUTPUT-token ceiling (resolveTokenBudget's
output — null/non-finite means "guard off", checked once per call so a caller
never has to special-case "no budget set") and `estimateByIssue` is
buildBudgetEstimateMap()'s {issue -> estimate|null} lookup. Checked in drainUnit
immediately before STOP.tripped is consulted, so a fresh trip here funnels
through the exact same not_started result-shape as every other STOP reason —
no separate code path to drift from. Two layered checks, hard floor first:
1. HARD FLOOR (PRIMARY, history-free, honest at ANY concurrency): spentTokens()
is the real guarded monotonic run-wide counter (see its own module comment)
— a plain >= budget compare needs no per-unit estimate at all, so it is the
backstop even when history is empty or every estimate is null.
2. ESTIMATE-AWARE PRE-CHECK (layered ON TOP, only reached if the hard floor
didn't already trip): spentTokens() + estimateByIssue[unit.issue] > budget.
Only fires when that unit's estimate is a finite number — a null estimate
(insufficient history, or any group member unestimable) is left to the hard
floor rather than guessed at, per estimateIssue()'s own "null poisons the
sum" contract.
```

## buildIssueShapeRows

```
buildIssueShapeRows (issue #97 task 1): per-unit "shape" summary joined from
`results` (this run's per-issue/per-group outcome records) and `units` (the
lane-scheduling units that produced them — index-aligned with `results`, see
runPool()'s own module comment, but looked up by issue number here rather than
position so a future reordering can never silently mismatch). Feeds the
history estimateCost() reduces over (issue #97 task 2): one row per unit —
issue        - the unit's primary issue number (r.issue).
pf           - predicted_files count. For a group unit (member_count > 1)
this is ALREADY the union over every member — deriveUnits()
computes it via unionField(memberRefs, 'predicted_files')
before the unit ever reaches the pool (see its module
comment) — never a per-member sum computed here.
tokens       - this row's token total, joined off tokenAgg.by_issue (itself
one entry per result — for a group unit that IS the whole
group's total, not the primary's share of it alone).
tracked      - whether `tokens` is a real, budget-derived number.
member_count - result.members.length (memberIssues(ctx) at the result-build
site, line ~4378 — results never carry a raw groupId, only
the resolved member-issue list). >1 flags a group unit so
estimateCost() never files its union pf + whole-group total
into a singleton's pf-band.
```

## buildRunRecord

```
buildRunRecord (issue #86): assemble the FULL, untruncated machine-readable record
for a run. Pure and above the split marker so tests can prove — at 18-issue+ scale —
that no per-issue metrics/timeline block is dropped. This object is what the outer
`mill` skill writes verbatim to <logs_dir>/runs/<run_tag>.json with a real fs Write
(deterministic, outside the sandbox). It is NOT handed to an agent to serialize: the
old path fed JSON.stringify(...).slice(0, 30000) to the report agent, which silently
cut the tail (an 18-issue run overflowed 30 000 chars, so the last issues' metrics
never reached disk). The Report agent now renders only the human-readable .md; the
bytes of the machine record never pass through a model. Shape is byte-for-byte the
prior `resultsJson` payload plus a `schema_version` and `run_tag` header, plus (issue
#87 task 5) a `completeness` trust flag — see computeCompleteness() just above — plus
(issue #97 task 1) `by_issue_shape`/`effective_concurrency`, the estimator's raw
history input. `f.units` is optional (defaults to [], pf falls open to 0) so every
existing caller/fixture that predates issue #97 keeps working unchanged.
`f.effectiveConcurrency` mirrors the dry_run lane preview's own
`Math.min(CONCURRENCY, lanes.length)` (see the routing-plan preview above) — the
caller passes it through rather than this pure function re-deriving it, since
CONCURRENCY/lanes are real-run-only bindings outside buildRunRecord's inputs.
```

## buildTrustedPfBands

```
buildTrustedPfBands: flattens `history` (an array of parsed runs.jsonl
ledger lines, i.e. buildLedgerLine's own output shape) into per-pf-band
token samples, keeping ONLY rows that clear every trust gate:
- the row's PARENT RUN has effective_concurrency === 1 (issue #97's
Revised Evaluation i1: recovers the default serialize_globs single-lane
case with exact per-issue attribution — concurrency>1 runs are excluded
wholesale, not row-by-row, since attribution is ambiguous for every row
in that run, not just some).
- the row's PARENT RUN's reconcile_error is finite and <=
ESTIMATOR_MAX_RECONCILE_ERROR (the coarse pathology bar above, not
MAX_RECONCILE_ERROR_FOR_TRUST).
- the row itself has member_count === 1 (issue #97's Revised Plan i2: a
group-unit row carries the union pf + WHOLE-GROUP token total under
task 1's contract — filing that into a singleton pf-band would
over-estimate every future singleton issue in that band).
- the row itself is tracked with a finite token total (buildIssueShapeRows
already sets tokens:null/tracked:false together when untracked, but
both are checked here so the gate reads as self-contained, not
dependent on that invariant holding forever).
Returns { [bandKey]: { median, count } } for every band with >=1 trusted
sample — NOT necessarily >= ESTIMATOR_MIN_BAND_SAMPLES; estimateIssue()
applies that threshold per-lookup so a caller inspecting `bands` directly
(e.g. a future oversized-multiple-of-median check) can still see the raw
sample count behind a band that estimateIssue() itself would call
insufficient.
```

## computeLaterBatchFix

```
computeLaterBatchFix (issue #104): the sole place the later_batch_fix grade
decision is made — reintroduces the v1-dropped "this batch caused a later
fix" signal, but gated on a fundamentally different, stronger mechanism than
the raw changed_files overlap plan review rejected (guaranteed-coincidental
in this repo, where every tier touches workflows/ticketmill.js). Instead of
"did the two diffs touch the same file", this asks "did the later fix PR's
own blame-forward resolution name THIS batch PR's own squash-merge commit as
the SHA that introduced the lines it just changed" — proof the later fix is
repairing a line the batch PR itself wrote, resolved entirely in the later
PR's own coordinate space (a read-only `git blame` on the pre-image lines it
replaced), never a synthesized/translated hunk-range intersection across two
diffs' distinct coordinate spaces (the mechanism approach-challenge
iteration 1 replaced).

observation.churned_regions: an array of { file, blamed_shas } entries — one
per churned region (hunk) in the later fix PR's diff, each already resolved
live by the Select-phase agent. blamed_shas is itself an array (a region can
span lines last touched by more than one prior commit) of commit SHA
strings.

Fires iff observation.batch_pr_merge_sha is a non-empty string AND appears
in the UNION of every region's blamed_shas. Fails open to false on anything
malformed or missing (no batch_pr_merge_sha, no churned_regions, a region
missing blamed_shas) — same fail-open ethos as ageInDays/deriveAbandoned: an
unresolvable signal must never manufacture a grade.
```

## gradeFromObservation

```
gradeFromObservation (issue #92): the deterministic grade decision. Takes ONE
raw observation (as resolved live via gh by the Select-phase outcome-observation
agent — never a stale pre-merge record), `now` (a Date/epoch-ms/ISO string —
ALWAYS injected by the caller; this function itself never calls Date.now() or
argless `new Date()`, which the sandbox forbids and lint-engine.js enforces),
and `cfg` (defaults to OUTCOME_GRADING; pass an explicit object to override
min_age_days in tests or from a profile-loaded config).

Asymmetric aging is the whole point: a bad outcome is real the moment it's
observed and grades immediately, at any age. A good outcome is not certified
until it's had time to prove itself — "no negative signal yet" is not the same
claim as "held up cleanly", so `clean` is gated behind cfg.min_age_days.

Precedence (first match wins):
1. reverted   — a revert commit referencing this PR/issue was found.
2. reopened   — the issue's timeline shows it reopened after this run closed it.
3. hotfix     — a later PR cross-references this issue as a fix for it.
4. later_batch_fix (issue #104) — computeLaterBatchFix's blame-forward
resolution named this batch PR's own merge SHA as the origin of the
lines a later PR just repaired, AND that later PR/issue isn't itself
declaring a pre-planned continuation (isPlannedFollowup). Sits below
hotfix (a same-issue cross-referenced fix is the stronger, more direct
claim) and above closed_unmerged/abandoned (a real later fix landing is
strictly more informative than either terminal escape).
5. closed_unmerged — batch_pr closed without ever merging: this target can
never reach "clean" (there was nothing to hold up), so it gets a terminal
escape now instead of sitting `pending` forever.
6. abandoned  — the issue itself was abandoned (closed, no PR ever merged),
same terminal-escape reasoning as closed_unmerged.
7. clean      — merged, no negative signal, and >= min_age_days old.
8. pending    — everything else (merged but still too young, or state unknown).
```

## computeRevisitRisk

```
computeRevisitRisk (issue #93): the deterministic flag decision — mirrors
gradeFromObservation's raw-observation-in/deterministic-decision-out shape
per #92's PIN (the Select-phase revisit probe returns raw events only; this
pure function is the only place that decides a flag). Takes `preflights`
(each carrying predicted_files, PREFLIGHT_SCHEMA), `observations` (an
{events, refix_chains, now} object — `events` here is NOT the probe's raw
REVISIT_RISK_SCHEMA.events[] directly; the caller builds it by running
deriveNegativeOutcomeEvents over prior_ledger_lines and merging the probe's
`files` on top via attachRevisitFiles, see the Select-phase post-hoc call
site below — so by the time it reaches here, grade/decided_at/merged_at are
already JS-derived and authoritative, never agent-supplied), and `cfg`
(defaults to REVISIT_RISK; pass an explicit object to override window_days
in tests). Returns a NEW array (mirrors
attachEngineOwnedIntentional's non-mutating shape) — every preflight comes
back with a `revisit_risk = { flagged, reasons }` field attached;
`{ flagged: false, reasons: [] }` is the clean no-op shape acceptance
criterion 2 requires when there is no matching history.

Recency anchor polarity (approach-challenge caveat 2): each event's window
membership is computed from its `decided_at` (when the outcome ledger
DECIDED the negative grade — i.e. when a revisit-risk probe could first have
seen it), falling back to `merged_at` only when decided_at is missing (an
older ledger line predating that field). This is deliberately
OBSERVATION-time, not EVENT-time: the signal this probe feeds a preflight is
"how recently did we LEARN this area is risky", not "how recently did the
regression itself land" — a regression that merged months ago but was only
just discovered (reverted/hotfixed/reopened, decided this week) is fresh
news to a run starting today, even though the underlying merge is old.
`merged_at` is the truer EVENT-time anchor and would be defensible too; this
function commits to `decided_at` and this comment is what makes that choice
legible rather than accidental.

Matching: a normalized-path (case-sensitive, slash-normalized) intersection
of each preflight's predicted_files against every in-window event's files[]
— any overlap sets flagged:true and adds one reason per matching event.
`refix_chains` (issue #89's within-issue re-fix chains) never flags on its
own — it only appends a corroborating reason for a file that ALREADY
flagged from a real events[] overlap, per approach-challenge-i2's F1: churn/
edit-frequency alone has zero outcome coupling and would flag almost every
engine-touching issue in a monolith-shaped repo like this one.
```

## deriveNegativeOutcomeEvents

```
deriveNegativeOutcomeEvents (issue #93 quality-fix, iteration 1 — code review
verdict changes_requested): the deterministic last-line-wins +
OUTCOME_NEGATIVE_GRADES filter over outcomes.jsonl's RAW, unparsed lines
(REVISIT_RISK_SCHEMA.prior_ledger_lines) — this is the ONLY place that
decides which {run_tag,batch_pr,issue} keys are "negative right now". It
mirrors diffOutcomeGrades' own last-line-wins grouping (same outcomeLineKey,
same JSON.parse-drop-bad-lines-rather-than-abort tolerance) but reads the
OTHER direction: instead of skipping already-terminal keys, it keeps only
keys whose current grade is a member of OUTCOME_NEGATIVE_GRADES.

Why this exists: the revisit-risk probe's own in-prompt parse of
outcomes.jsonl (REVISIT_RISK_SCHEMA's module comment, steps 1a-1c) is
target-selection scaffolding ONLY — it decides which keys are worth a live
gh call to resolve `files` for for. Before this fix, the agent's own
last-line-wins/grade judgment was what got returned and trusted, the exact
PIN violation #92's OUTCOMES_SCHEMA was built to avoid. This function is
what closes that gap: computeRevisitRisk's `events` input is now built
EXCLUSIVELY from this function's output (grade/decided_at/merged_at) plus
the agent's raw `files` resolution merged on by the caller — never from the
agent's own per-event grade.
```

## select-consolidation-gate

```
---- Select: consolidation gate (judgment call — see the PROPOSECONSOLIDATION
module comment above the harness split for the full design). EVERY preflight is
a candidate here, regardless of resume_point — NOT filtered to 'implement' —
because proposeConsolidation()'s HEAL phase must see 'process_pr'/'skip' members
too: a group whose members ALL flipped to 'process_pr' (a prior run created the
shared PR but crashed/failed before merging it — spec review, code review, and
merge all happen post-PR, in reviewAndMerge) still needs to be recognized as ONE
group so its whole unit routes together through processIssue's process_pr branch
(one setup + one reviewAndMerge on the shared PR), not as N independent
process_pr singletons that would each attempt to review/merge the SAME PR.
proposeConsolidation() itself restricts brand-new opus-gate proposals to
'implement' candidates only (see its own filter) — only the HEAL step is
resume_point-agnostic. proposeConsolidation() free-skips internally with NO
agent call at all when candidates.length <= 1, and skips the opus proposal (but
still heals a group a PRIOR run already committed to, via comment markers) when
PROFILE.consolidation is explicitly false — see its module comment on why the
heal must survive a mid-run flag flip. It is read-only and side-effect-free
under DRY_RUN: the marker-heal and opus proposal both run (gh reads only); the
comment-posting contrarian challenge is skipped entirely.
```

## cost-estimate-preview

```
Cost-estimate preview (issue #97 task 3) — built off the SAME previewUnits
the lane-scheduling preview above already derived, so a unit's shape here
matches the unit a real run would actually drain. Scoped to
resume_point === 'implement' units ONLY (Quality Review, task 3 iteration
1): a 'skip' unit does no real work at all (processIssue's
resume_point==='skip' early return) and a 'process_pr' unit pays only
rework-tax, not a fresh implement-shaped run — charging either the SAME
full pf-band-median estimate as a genuine implement would inflate
batch_projection.projected_total and could spuriously trip
oversized.multiple_of_median on an already-skipped/healed issue. A unit's
own `.resume_point` is inherited straight from its preflight/primaryRef in
deriveUnits(), so this filter needs no new plumbing. Task 4/5's live-run
pre-check reuses this SAME filtered construction so the estimate map it
builds off of stays unpolluted too. Each surviving unit becomes one
buildCostEstimate() `issues[]` entry: `pf` is the unit's own predicted_files
count (already the union for a group unit — deriveUnits() computes it that
way, see its module comment), `member_count` its live member count, and
`members` (only when >1) each member's OWN predicted_files count — NOT the
union — mirroring estimateCost()'s group contract (each member bands on its
own shape, see estimateIssue()'s module comment).
```
