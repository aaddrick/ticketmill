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
  prior batch.

Suggest `dry_run: true` for a user's FIRST run in a repo — it probes every issue and
reports the routing plan (skip / review-only / implement) without changing anything.

## Launch

```
Workflow({
  scriptPath: "<resolved engine path>",
  args: { branch: "dev", issues: [701, 702], run_label: "2026-07-18" }
})
```

The workflow runs in the background. When it completes, relay the result: state,
per-issue outcomes, the batch PR number (stress that a HUMAN must review and merge
it), any `verification_gaps` (these are important — they list checks that did not
run), and the `resume_hint` if the run did not fully complete.

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

## Resuming

- Same session: `Workflow({scriptPath, resumeFromRunId: "wf_..."})` replays completed
  stages from the journal.
- Any session: re-run with the same args PLUS `batch_branch: "Batch_<ts>"` from the
  prior run's output — the preflight skips finished work and continues partial work.
