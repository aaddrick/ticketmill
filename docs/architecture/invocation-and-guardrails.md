# Invocation and guardrails

How a run is invoked, where the engine's own files live, and the guardrails that keep an issue from touching engine-owned paths by accident.

## Invocation: scriptPath, with the engine copied into the target repo

Workflow scripts are not a registered plugin component (no `workflows` field in
plugin.json). mill-init therefore copies the engine into the target repo's
`.claude/workflows/` so runs work on any machine with the repo checked out,
plugin installed or not. The `mill` skill hard-stops when the Workflow tool is
unavailable and explicitly forbids simulating the pipeline inline: an imitation
run has no journal, no claims, no breakers, and no resumability, which is worse
than not running.

Because mill-init copies files verbatim into target repos, each copied file
exists twice and the two must stay byte-identical. `scripts/lint-engine.js`
byte-compares every such pair on each test run and fails loud on drift. Edit
only the source, then run `node scripts/lint-engine.js --fix` in the same
commit to write it verbatim over the installed copy. The pairs are the engine
(`workflows/ticketmill.js`) and the worktree setup script
(`scripts/setup-worktree.sh`).

The setup script was added to that check after it drifted unnoticed for 29
releases. It had picked up an empty-slug guard and a redirect that keeps `git
branch` off stdout, and neither reached the installed copy, because the
byte-compare only ever covered the engine. The stdout redirect is the reason
this matters beyond tidiness: the script's contract with the engine is
JSON-on-stdout, so anything else written there corrupts the parse. `--fix`
also copies the source's mode, since a setup script that loses its executable
bit is broken in a way a byte-compare cannot see.

## Sandbox lint: catching rules `node --check` can't see

The Workflow tool sandbox forbids `Date.now()`, `Math.random()`, argless
`new Date()`, and any filesystem/Node API (`require`/`import`) inside the engine
script: all legal JavaScript, so `node --check` passes on every one of them,
but they throw at runtime and silently break resume (wall-clock time and
randomness aren't available in that sandbox; see the comments near the top of
`workflows/ticketmill.js`). That gap used to live only as tribal knowledge in
`verify_notes`. `scripts/lint-engine.js` makes it a mechanical, line-by-line text
scan wired into `test_command` right after `node --check`, so a violation fails
CI instead of a live run. Pure-comment lines are skipped (the engine's own docs
legitimately name these APIs), and a line carrying the literal `// sandbox-ok`
marker is the only escape hatch, deliberately narrower than a pattern-based
exception, so it has to be spelled out per line rather than silently suppressing
a whole rule.

## Engine-owned path guardrail: three regimes

A worktree only sees committed state. A freshly forged agent file, or a
profile field just added at the repo root, stays invisible there until it's
committed. An implementer that "reconciles" what looks like a stale diff in
the worktree can restore the old committed version straight from git
history. A later batch merge then overwrites the uncommitted root-tree work
without ever raising a conflict: that's nonconvexlabs-com#77, the incident
this guardrail exists to close.

Engine-owned paths are the run's own tooling: the ticketmill profile
(`.claude/ticketmill.json`), the agent roster (`.claude/agents/**`), and the
engine's own installed copy (`.claude/workflows/ticketmill.js`,
`.claude/scripts/ticketmill/**`). A profile can extend that default set via
`profile.engine_owned_globs`. These paths stay read-only for a run unless an
issue's own title or body plainly names one of them.

Three regimes cover what happens next.

**(a) Select-phase skip.** When an issue's prose names an engine-owned path
(`engineOwnedHit`, a case-sensitive substring match) and the preflight probe
finds the root tree already dirty under that same path
(`root_dirty_engine_paths`), the issue is routed straight to `resume_point:
skip` before a worktree is ever built. This is the only regime the engine
can catch ahead of time, and only because git tracks the dirt: an
uncommitted rename or a change outside git's view still slips through.

**(b) Deliberate engine work, clean root.** An issue whose prose names an
engine-owned path, with a clean root tree, is intentional engine work: this
repo's own ticketmill issues look exactly like this. `ctx.engineOwnedIntentional`
is computed once at Select from title and body, then OR-folded across a
consolidation group's live members in `deriveUnits()` so a non-primary
group member's intent survives `pickPrimary`'s unrelated choice of primary.
The post-implement gate reads that flag and leaves the diff exactly as
committed.

**(c) Incidental change.** Engine-owned paths turn up in the diff, but
nothing in the issue's prose named them. `runEngineOwnedGate(ctx)` runs
right before the test loop, not after like `runBrowserCheck`, so a revert it
triggers gets re-validated by that same run's test suite in-band rather than
landing unverified. A deterministic JS pass filters the diff against the
engine-owned set, then splits it again with `isHardRevertPath`: a
single-purpose stage hard-reverts every path that isn't also listed in
`profile.lockstep_installed_paths`, committing and pushing the revert. A
lockstep path is exempt because it's a deliberate installed copy of a
source-of-truth file elsewhere in the repo, kept in sync by the repo's own
tooling: this repo sets `[".claude/workflows/ticketmill.js"]`, since
`scripts/lint-engine.js` already keeps it byte-identical to
`workflows/ticketmill.js`. Reverting a lockstep path here would fight that
sync instead of undoing an incidental restore, so any drift on that path is
left for `lint-engine`'s byte-compare to catch on its own.

Checkout alone doesn't cover every case. `git checkout origin/<TARGET> --
<path>` fails with "pathspec did not match any file(s)" on a path absent
from the baseline: a file created fresh on the branch. Checkout restores
from a baseline copy, and a created file has none. So the diff probe also
returns `added_files`, from a second `--diff-filter=A` command, and
`runEngineOwnedGate` partitions `revertFiles` against that list:
`createdFiles` get `git rm`, `existingFiles` still go through checkout, and
both commands land in the same revert commit. An older or degraded probe
response can omit `added_files`, since the schema field is optional.
`createdFiles` then stays empty, and every path falls into the checkout
group, reproducing the prior behavior: checkout fails on the missing
pathspec, and the gate degrades to a recorded `ctx.deferred` follow-up
instead of blocking the issue.

`scopeGuard()` carries a fourth, advisory layer on top of the two gates
above: a clause appended to every stage prompt, unconditionally, telling the
agent never to stage, commit, or restore an engine-owned path outside these
mechanisms. It has to stay generic rather than naming a regime, since an
agent mid-stage has no reliable way to know which one it's in. The one
stage that's deliberately excused from that clause is the regime (c) revert
stage itself: its prompt opens with an explicit override, because it is the
guardrail acting on the agent's behalf, ahead of the checkout instruction
the general clause would otherwise contradict.

The gate never halts a run on its own. A dead diff probe or a failed revert
stage degrades to a recorded `ctx.deferred` follow-up instead of blocking an
otherwise-green issue.
