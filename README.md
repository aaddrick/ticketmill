# ticketmill

Batch-process GitHub issues end-to-end, autonomously, with the paranoia built in.

For each selected issue, the engine runs: research, an approach evaluation challenged
by a contrarian gate, a task plan challenged again, per-task implementation with
review and quality loops, a test loop, PR creation, parallel spec + code review
loops, and a squash-merge into a batch integration branch. The run ends with one
batch PR that a human reviews and merges. The engine never merges to your base
branch itself.

Ticketmill is stack-agnostic: it learns your toolchain from a per-repo profile
(`.claude/ticketmill.json`) and staffs its pipeline with your repo's own agents
(`.claude/agents/*.md`). It generates missing ones on request.

## Install

```bash
claude plugin marketplace add aaddrick/ticketmill
/plugin install ticketmill@ticketmill
```

## Requirements

- **Claude Code with the `Workflow` tool available.** The engine is a workflow
  script; the `mill` skill hard-stops if the tool is missing rather than simulate
  the pipeline inline (an imitation run has no journal, claims, breakers, or
  resumability).
- **`gh` (GitHub CLI), authenticated, with write access to the target repo.**
  `gh auth status` must succeed and the token must be able to write to the repo:
  the engine reads issues and creates labels, issue/PR comments, branches, and
  pull requests. `mill-init` probes this during onboarding.
- **`git`** with worktree support (any modern version). Each issue is implemented
  in its own worktree branched from the batch branch.
- **A target repo that is a git clone with a GitHub remote** (`gh repo view` must
  resolve an `owner/name` slug).
- **A per-repo profile at `.claude/ticketmill.json`**, written by
  `/ticketmill:mill-init`. No profile, no run. The engine never guesses a
  toolchain.
- **A locally runnable toolchain.** The profile's `install_commands` and
  `test_command` must work on the machine running the batch. `mill-init`'s doctor
  pass proves this once in a scratch worktree before the profile is written.
- Optional: **browser verification** (`profile.browser`) additionally needs a
  servable UI and the Claude browser MCP tools available in the session.

## Quickstart

```text
/ticketmill:mill-init      # once per repo: doctor pass, profile, agent staffing
/ticketmill:mill           # per batch: "mill issues 701 and 702 against dev"
```

`mill-init` refuses to write a profile it hasn't proven: it creates a scratch
worktree, runs your install commands and test suite there once, and only then
records the profile. That converts "the test env is broken" from N expensive
mid-batch failures into one onboarding failure.

First run in a repo? Ask for a dry run ("mill issue 701 against dev, dry run").
It probes every issue and reports the routing plan (skip / review-only /
implement) without changing anything.

## Run options

Every run is a `Workflow` call with an `args` object. The `mill` skill assembles
it from your request; these are the knobs it can turn:

| Arg | Meaning |
|---|---|
| `branch` | Required. The base branch the final batch PR targets (e.g. `dev`, `main`) |
| `issues` | Explicit issue numbers, e.g. `[701, 702]`. Provide this or `labels` |
| `labels` | Select issues by label instead of by number |
| `limit` | Cap for label selection (default 50) |
| `state` | Issue state for label selection (default `open`) |
| `no_assignee` | With `labels`: select only issues nobody is assigned to |
| `concurrency` | Issue pipelines running in parallel: 1-5, default 2 |
| `dry_run` | Read-only preview: probes every issue and reports the routing plan |
| `run_label` | Tag for claims and report filenames. Pass today's date so reports don't collide |
| `batch_branch` | Resume a prior run by reusing its `Batch_<timestamp>` branch |
| `root`, `repo` | Auto-discovered from git and gh; pass explicitly if the bootstrap probe fails |

`concurrency` is parallelism across issues within one run: each pipeline gets
its own worktree (and its own port when browser verification is on), and browser
stages serialize through a shared lock at any setting. For coordination across
runs on different machines, see Overlapping batches below.

If you state the same options every time, put them in a skill: a small project
skill that invokes `/ticketmill:mill` with your standing preferences (say,
always `no_assignee`, concurrency 3, and your team's label conventions) turns a
paragraph of instructions into one command.

## What makes it trustworthy

The engine is a port of a private orchestrator that earned its guardrails through
incident retrospectives. The machinery it keeps:

- **Human merge gate.** Per-issue PRs merge into a `Batch_<timestamp>` branch only.
  The final `Batch -> base` PR is created, never merged, and carries the
  `Closes #N` lines plus a **Verification Gaps** section listing every check that
  did not run (tests disabled, browser skipped, missing agents). Gaps are shown to
  the reviewing human, not buried in logs.
- **Tests are never silently skipped.** No profile, no run. `"test_command": null`
  is accepted only as an explicit recorded decision, and it still shows up as a
  verification gap on the batch PR.
- **Contrarian gates** stress-test the approach and the plan before any code is
  written, with calibrated severity rules, a settled-decisions ledger to stop
  re-litigation churn, and iteration caps that carry unresolved findings forward
  loudly instead of dropping them.
- **Cross-run claims.** Issues are claimed before work starts, so batches started
  by different maintainers never double-process an issue (see Overlapping batches
  below).
- **Mechanical merge recovery, tested before it's trusted.** A PR that goes
  `CONFLICTING` after review gets one automatic rebase-and-retest attempt
  before the run gives up on it: rebase onto the batch branch, resolve
  mechanical conflicts, then a mandatory full test run on the exact state
  about to be pushed. Anything that needs a human judgment call, or that
  can't be re-verified green, still escalates to `needs_human` instead of
  guessing.
- **Circuit breakers.** Three failed issues, or three consecutive agent deaths
  (the usage-limit signature), stop the run with a resume plan instead of burning
  through the batch.
- **Resumable everywhere.** An interrupted run loses nothing: every path back is
  covered in Resuming an interrupted run below.
- **Scope guards.** Every agent prompt pins its GitHub writes to its own issue and
  stamps comments with a machine-checkable marker; contrarian gates delete
  misfiled comments from concurrent pipelines.
- **Self-improving.** Each run distills durable learnings into
  `logs/ticketmill/process-retrospective.md` and injects them into the next run's
  planning, review, and test prompts.

## Watching a run

The run narrates itself in the places you already look:

- **The issue trail.** Every stage posts a comment as it happens, and every
  review/fix loop iteration posts its own, so the trail shows each round of a
  negotiation rather than one "implemented" note at the end. A halt posts the
  failed stage plus resume instructions. Each comment carries an
  `<!-- ticketmill owner/repo#N -->` marker naming the issue it belongs to.
- **The PRs.** The per-issue PR collects the spec and code review rounds. The
  batch PR carries the Verification Gaps section: every check that did not run,
  in front of the human who is about to merge.
- **The logs dir** (`logs_dir`, default `logs/ticketmill`). Each run writes
  `summary-<run_label>.json` (machine-readable, per-issue outcomes and stage
  timelines)
  and `summary-<run_label>.md` (the human version), and appends to the running
  `process-retrospective.md`.
- **Live.** While a run is going, `/workflows` in Claude Code shows the progress
  tree: which issues are in flight and which stage each one is in.

## Follow-up issues

Besides comments and labels, the engine writes one more thing to your tracker:
at each successful squash-merge, it files new issues for work the run saw and
deliberately did not do.

- Two sources feed them. The merge stage scans the PR and issue trails for
  deferred-work phrases ("follow-up", "out of scope but", "technical debt",
  "future improvement", "consider adding"). It also drains a ledger the
  pipeline carries: reviewer suggestions that passed review without being
  required, tasks that failed review and were left incomplete, and reviews
  skipped because a reviewer died.
- Each distinct actionable item becomes one issue that references the source PR
  and issue, labeled bug, enhancement, or tech-debt. The merge agent checks for
  existing duplicates first, so a resumed run does not re-file.
- Only merged issues file follow-ups. A failed or halted issue gets a halt
  comment instead, and the deferred work stays visible in its trail.
- Created issue numbers come back in the per-issue results, so the run report
  lists what got filed.

## Overlapping batches

Two maintainers can start batches on different machines with overlapping issue
lists. Claims keep them from colliding:

- Before any work starts, a run claims every issue it selected: a claim label
  plus a `## Ticketmill Claimed` comment recording the batch branch, run tag,
  host, and start time.
- A run that finds a fresh foreign claim (under 12 hours old) on an issue skips
  it and processes the rest of its batch. When two runs start at the same
  moment, both post and then re-read: the earlier claim wins.
- Claims from your own batch branch count as yours. That is what lets a resumed
  run pick its issues back up instead of skipping them.
- Claims release when an issue merges or halts, plus a sweep at report time. A
  run that dies without releasing is covered by the 12-hour staleness window.
- Claims are advisory and fail open: if the claim step itself dies, the run
  proceeds. The worst case is two runs implementing the same issue in their own
  batch branches, and the humans reviewing those two batch PRs resolve it.
  Neither run writes to your base branch either way.

## Resuming an interrupted run

Runs die for boring reasons: the laptop loses power, the session hits a usage
limit, the API has an outage. The engine treats all of them as expected weather.

- **Session still alive.** Resume in place with
  `Workflow({ scriptPath, resumeFromRunId: "wf_..." })`. The journal replays
  every completed stage from cache and picks up at the first unfinished one.
- **Session gone** (power loss, restart, new machine). Re-run with the same args
  plus `batch_branch: "Batch_<timestamp>"` from the dead run. The preflight
  probe reads live GitHub and git state and routes each issue: merged or closed
  skips, an open per-issue PR goes straight to review and merge, and a partial
  branch keeps implementing. Worktree setup is idempotent, and both the planner
  and every implement prompt check existing commits before adding work.
- **Lost the batch branch name with the session?** It survives in three places:
  on the remote (`git branch -r` lists `Batch_<timestamp>`, pushed at run
  start), in the run report under the logs dir if the run got that far, and in
  the `## Ticketmill Claimed` comment on any issue the run claimed.
- **Usage limits trip a breaker on purpose.** Three consecutive agent deaths is
  the signature of a limit or an outage, so the run stops launching issues and
  writes a resume plan instead of failing the batch one issue at a time.
- **Your own interruption never blocks you.** A resumed run on the same batch
  branch recognizes the dead run's claims as its own and continues; other
  maintainers' runs see them as foreign until the 12-hour staleness window
  clears them.
- **Every halted issue tells you where it stopped.** The halt comment names the
  failed stage and repeats the resume instructions.

## How agents work

Ticketmill thinks in roles. Your profile's `roles` map assigns each role to an
agent in your repo's `.claude/agents/`. Every role also has a built-in fallback
charter, so a role left `null` still runs on the generic charter. If the profile
names an agent whose file is missing, the engine uses the fallback and lists the
gap in the batch PR's Verification Gaps section.

| Role (profile key) | What it does in the pipeline |
|---|---|
| `implementers` | The agents that write code: an array, ideally one per domain (e.g. backend, frontend). The planner assigns each task to the best fit |
| `default_implementer` | The implementer used when no domain-specific one fits a task |
| `task_reviewer` | After each task: verifies the implementation achieves the task goal against the actual diff |
| `spec_reviewer` | At the PR gate: verifies the PR fulfills the *issue's* requirements and flags scope creep for removal |
| `code_reviewer` | At the PR gate (parallel with spec review): correctness, security, error handling, codebase conventions |
| `contrarian` | Devil's-advocate gate that stress-tests the approach and the task plan before any code is written |
| `test_validator` | Audits tests for cheating: hollow assertions, mock abuse, missing edge cases, tests that pass without exercising the change |
| `simplifier` | Quality loop: refines changed code for clarity and consistency without changing behavior (gated by `simplify_globs`) |
| `docblock_writer` | Writes doc comments for changed code in the project's style (gated by `docblock_globs`) |
| `doc_writer` | Writes technical design docs into `docs_dir` after review passes (skipped when `docs_dir` is `null`) |

One mechanism, deliberately: a stage's subagent is instructed to read the mapped
agent file and adopt its persona. The engine never depends on the session's agent
registry, so a freshly generated agent works in the very next run, and behavior is
identical before and after a session restart.

Role staffing happens during onboarding. mill-init reads each agent in your
repo's `.claude/agents/` and maps it to a role by what its description says it
does. It never force-fits: a UX reviewer is not a code reviewer, and a role with
no honest match stays `null`. The contrarian role fills automatically from a
bundled template copied into your repo (mill-init prefers a
`~/.claude/agents/contrarian.md` of your own if one exists). Every other gap
gets an inline choice: keep the built-in charter, or have
`/ticketmill:forge-agent` write a project agent grounded in domain research plus
your actual codebase conventions. A forged agent updates the role map itself, so
the profile needs no hand edits.

## Profile reference

See the annotated schema in the header of `workflows/ticketmill.js`. The
load-bearing fields:

| Field | Meaning |
|---|---|
| `test_command` | Required key. Command string, or explicit `null` (no test gate, surfaced on every batch PR) |
| `test_globs` | Changed-file patterns that count as testable |
| `install_commands`, `env_files` | Per-worktree provisioning (run/copied at issue setup) |
| `verify_notes` | Environment preconditions injected into test/fix prompts (required services, seed data) |
| `roles` | Role-to-agent map; `implementers` is the list the planner assigns tasks to |
| `simplify_globs`, `docblock_globs`, `docs_dir` | Gate the simplify, docblock, and tech-docs stages; `null` skips |
| `browser` | Opt-in live browser verification (serve command with `{port}`, UI globs, notes). Also accepts optional `lock_path` (default `/tmp/ticketmill-browser-lock`), `stale_seconds` (default `1800`), `poll_seconds` (default `15`), `port_span` (default `900`), and `artifact_dir` (default `/tmp/ticketmill-issue-{issue}`, `{issue}`-templated like `serve_command`'s `{port}`) |
| `models` | Per-stage model/effort overrides |
| `consolidation` | Default `true`. Set `false` to disable the Select-phase consolidation gate entirely (a resumed run still heals any group a prior run already committed to) |
| `serialize_globs` | Optional, default `[]`. Patterns worth trusting as a lane-scheduling hint beyond predicted-file overlap alone: a shared schema, a magnet config, anything two issues could conflict on without their own predicted paths overlapping |
| `warn_base_branches` | Optional, default `[]`. Base branch names that trigger a Select-phase warning when a batch targets one of them (PRs normally target the working branch, not a branch that auto-deploys on push). Unset/`[]` = no warning |

## Repo layout

```
.claude-plugin/    plugin.json + marketplace.json (this repo is its own marketplace)
workflows/         ticketmill.js, the engine (invoked via Workflow scriptPath)
skills/            mill (launch), mill-init (onboarding), forge-agent (agent generation)
templates/         agents/contrarian.md, copied into repos that lack one
scripts/           setup-worktree.sh, deterministic worktree creation
docs/              ARCHITECTURE.md
```

Note: workflow scripts are not a registered Claude Code plugin component, which is
why `mill-init` copies the engine into your repo's `.claude/workflows/` and the
`mill` skill invokes it by `scriptPath`. A plain git clone of this repo works too;
the plugin install just adds the namespaced skills.

## Author

[aaddrick](https://github.com/aaddrick) · [LinkedIn](https://www.linkedin.com/in/aaddrick/)

## License

MIT
