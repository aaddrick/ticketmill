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

The rest of the manual lives in [docs/](docs/index.md):

- [Getting started](docs/getting-started.md): full install requirements and the
  quickstart above, unabridged.
- [Run options](docs/run-options.md): every `mill` argument, plus running
  overlapping batches across machines.
- [Running a batch](docs/running-a-batch.md): watching a run, follow-up
  issues, and resuming after an interruption.
- [Troubleshooting](docs/troubleshooting.md).
- [How agents work](docs/agents.md): the role map and how staffing works.
- [Profile reference](docs/profile.md): every `.claude/ticketmill.json` field.
- [Skills](docs/skills.md): the four `/ticketmill:*` skills.

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
  by different maintainers never double-process an issue (see
  [Overlapping batches](docs/run-options.md#overlapping-batches)).
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
  covered in [Resuming an interrupted run](docs/running-a-batch.md#resuming-an-interrupted-run).
- **Scope guards.** Every agent prompt pins its GitHub writes to its own issue and
  stamps comments with a machine-checkable marker; contrarian gates delete
  misfiled comments from concurrent pipelines.
- **Self-improving.** Each run distills durable learnings into
  `logs/ticketmill/process-retrospective.md` and injects them into the next run's
  planning, review, and test prompts.

## Repo layout

```
.claude-plugin/    plugin.json + marketplace.json (this repo is its own marketplace)
workflows/         ticketmill.js, the engine (invoked via Workflow scriptPath)
skills/            mill (launch), mill-init (onboarding), forge-agent (agent generation),
                   mill-review (read-only cross-run trend dashboard over the run ledger)
templates/         agents/contrarian.md, copied into repos that lack one
scripts/           setup-worktree.sh (worktree creation), lint-engine.js (sandbox/lockstep gate)
tests/             the test suite gating every run
docs/              index.md + topic guides (getting-started, run-options, profile,
                   agents, skills, running-a-batch, troubleshooting), architecture/
                   (design decisions, split by topic), diagrams/ (D2 sources +
                   generated SVGs, see render.sh)
.claude/           this repo's own ticketmill profile, workflows/, and agents/ (it self-hosts its mill runs)
```

Note: workflow scripts are not a registered Claude Code plugin component, which is
why `mill-init` copies the engine into your repo's `.claude/workflows/` and the
`mill` skill invokes it by `scriptPath`. A plain git clone of this repo works too;
the plugin install just adds the namespaced skills. This repo runs `mill` on itself: it
carries its own `.claude/ticketmill.json` profile plus a `.claude/workflows/ticketmill.js`
lockstep-installed copy of `workflows/ticketmill.js` (see `lockstep_installed_paths`
in the [profile reference](docs/profile.md)) and `.claude/agents/*.md`, the forged
agent personas that do the work.

## Author

[aaddrick](https://github.com/aaddrick) · [LinkedIn](https://www.linkedin.com/in/aaddrick/)

## License

MIT
