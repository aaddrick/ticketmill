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

First run in a repo? Use a dry run. It probes every issue and reports the routing
plan (skip / review-only / implement) without changing anything:

```js
Workflow({
  scriptPath: "<repo>/.claude/workflows/ticketmill.js",
  args: { branch: "dev", issues: [701], dry_run: true }
})
```

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
- **Cross-run claims.** Issues are claimed via label + comment before work starts,
  so concurrent runs on other machines skip them; stale claims (12h) expire; claims
  are advisory and fail open.
- **Circuit breakers.** Three failed issues, or three consecutive agent deaths
  (the usage-limit signature), stop the run with a resume plan instead of burning
  through the batch.
- **Resumable everywhere.** Same-session journal replay via `resumeFromRunId`, or
  from any session by re-running with the same args plus `batch_branch`; a
  preflight probe routes each issue from live GitHub state.
- **Scope guards.** Every agent prompt pins its GitHub writes to its own issue and
  stamps comments with a machine-checkable marker; contrarian gates delete
  misfiled comments from concurrent pipelines.
- **Self-improving.** Each run distills durable learnings into
  `logs/ticketmill/process-retrospective.md` and injects them into the next run's
  planning, review, and test prompts.

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
| `browser` | Opt-in live browser verification (serve command with `{port}`, UI globs, notes) |
| `models` | Per-stage model/effort overrides |

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

## License

MIT
