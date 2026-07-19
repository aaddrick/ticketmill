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

Requirements: Claude Code with the Workflow tool available, `gh` authenticated with
write access to the target repo, and `git`.

## Quickstart

```text
/ticketmill:mill-init      # once per repo: doctor pass, profile, role map
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

Ticketmill thinks in roles: implementers (per domain), task reviewer, spec
reviewer, code reviewer, contrarian, test validator, simplifier, docblock writer,
doc writer. Your profile maps roles to agents in your repo's `.claude/agents/`.

One mechanism, deliberately: a stage's subagent is instructed to read the mapped
agent file and adopt its persona. The engine never depends on the session's agent
registry, so a freshly generated agent works in the very next run, and behavior is
identical before and after a session restart. Unfilled roles fall back to built-in
charters and are reported as such.

Missing an agent for a role? `/ticketmill:forge-agent` generates one grounded in
domain research plus your actual codebase conventions.

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
scripts/           setup-worktree.sh, deterministic worktree creation
docs/              ARCHITECTURE.md
```

Note: workflow scripts are not a registered Claude Code plugin component, which is
why `mill-init` copies the engine into your repo's `.claude/workflows/` and the
`mill` skill invokes it by `scriptPath`. A plain git clone of this repo works too;
the plugin install just adds the namespaced skills.

## License

MIT
