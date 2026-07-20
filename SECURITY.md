# Security Policy

## Supported Versions

Ticketmill ships as a rolling release. Only the latest published version, the `version` field in `.claude-plugin/plugin.json`, gets security fixes. There's no long-term support branch.

| Version | Supported |
| ------- | --------- |
| Latest  | ✅        |
| Older   | ❌        |

## Reporting a Vulnerability

Don't report security issues through public GitHub issues, discussions, or pull requests. Anyone watching the repo can see them before a fix ships, including your proof-of-concept.

Instead, use GitHub's private vulnerability reporting: https://github.com/aaddrick/ticketmill/security/advisories/new

This opens a private draft advisory that only you and the maintainer can see until it's ready to publish.

## What to Include

The more detail you give, the faster this moves. Include:

- The ticketmill engine/plugin version you tested against (from `.claude-plugin/plugin.json`)
- The shape of the target repo if it's relevant (profile config, branch protections, anything that affects reproduction)
- Steps to reproduce, ideally a minimal case
- The impact: what an attacker could actually do with it, described concretely

## Response Expectations

I maintain ticketmill solo, so response times won't match a security team with a rotation. I'll acknowledge new reports within about a week and keep you posted as I work through triage and a fix. If a report needs more time than that, I'll say so rather than go quiet.

## Coordinated Disclosure

I follow coordinated disclosure: the fix ships first, and the advisory publishes after, once a patched version is out. If you have a disclosure deadline in mind, mention it in your report and I'll work with you on timing.

## Scope

Ticketmill is an autonomous agent pipeline that runs with `gh` and `git` write access to your repos. The threat model that matters here is the engine's own automation getting turned against the repo it's operating on.

**In scope:**

- Worktree or branch escape: an issue or batch run affecting files, branches, or worktrees outside its intended scope
- Bypassing engine-owned guardrails (scope guards, the settled-decisions ledger, claim label-safety rules, the stub-task guard, or similar mechanisms in `workflows/ticketmill.js`)
- Claim spoofing: one run falsely appearing to own or have completed work that belongs to another
- Command injection via issue or PR content, for example an issue title or body reaching `scripts/setup-worktree.sh` or other shell execution in a way that runs attacker-controlled commands
- Prompt-injection paths where issue or PR text steers an agent into unintended `gh` or `git` writes (commits, comments, merges, label changes) beyond what the operator asked for

**Out of scope:**

- Vulnerabilities in the target repo's own code or dependencies that a ticketmill run happens to touch while doing its job. Report those to the target repo's own maintainers, not here.
