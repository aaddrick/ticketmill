# Skills

Ticketmill installs as four Claude Code skills, invoked with `/ticketmill:<name>`.
Each does one job in the lifecycle: onboard a repo once, launch batches against
it, fill an agent gap on request, and review the run history afterward.

## `/ticketmill:mill-init`

One-time onboarding of a repo for ticketmill batch processing. Runs a doctor
pass that proves your install commands and test suite work in a scratch
worktree, writes the `.claude/ticketmill.json` profile, maps the project's own
agents onto pipeline roles, and generates missing agents for role gaps.

Use before the first `mill` run in a repo, or to repair an existing profile
after your toolchain or agent set changes. See [Getting started](getting-started.md).

## `/ticketmill:mill`

Launches a batch run: for each selected GitHub issue, research, contrarian-gated
approach and plan, per-task implementation with quality loops, a test loop, PR
creation, spec and code review loops, and a squash-merge into a batch
integration branch. The run ends with one batch PR for a human to review and
merge.

Use to batch-process, mill, or autonomously implement a set of GitHub issues.
Requires prior onboarding via `mill-init`. See [Run options](run-options.md)
for every knob and [Running a batch](running-a-batch.md) for what a live run
looks like.

## `/ticketmill:forge-agent`

Generates a project-specific agent definition for a pipeline role (implementer,
code reviewer, test validator, and so on), grounded in domain research and the
actual codebase rather than generic knowledge.

Use when `mill-init` finds a role gap, or when asked to create an agent for a
repo. See [How agents work](agents.md) for how role staffing and fallback
charters work.

## `/ticketmill:mill-review`

Read-only cross-run analysis of ticketmill's own process ledger
(`logs/ticketmill`): a cross-run trend dashboard built from the run summaries,
the outcomes ledger, and the process retrospective.

Use to review ticketmill's run history, retrospect on past `mill` runs, or
produce a trend dashboard for the pipeline itself. Nothing it does writes to
the target repo.
