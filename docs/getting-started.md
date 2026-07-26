# Getting started

Everything you need before your first `mill` run: what to install, what the
engine requires of your repo and machine, and the two commands that launch it.

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
