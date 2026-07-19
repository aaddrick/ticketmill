---
name: mill-init
description: One-time onboarding of a repo for ticketmill batch processing - verifies the environment with a doctor pass, writes the .claude/ticketmill.json profile, maps the project's agents onto pipeline roles, and generates missing agents. Use before the first mill run in a repo, or to repair/update an existing profile.
---

# mill-init — onboard a repo for ticketmill

Produces everything a `mill` run needs, and refuses to write a profile it hasn't
proven works. Do the steps in order; each gates the next.

## Step 1 — Preconditions

1. Confirm you are in a git repo with a GitHub remote: `git rev-parse --show-toplevel`
   and `gh repo view --json nameWithOwner`. Record ROOT and the `owner/name` slug.
2. Confirm `gh auth status` succeeds and the token can write issues
   (`gh label list` is a cheap probe).
3. If `<ROOT>/.claude/ticketmill.json` already exists, read it and tell the user —
   this run will UPDATE it (show a diff at the end), not silently replace it.

## Step 2 — Detect the stack and propose a profile

Inspect the repo (build files, CI config, CLAUDE.md, README) and propose values for
every profile field. Show the user the proposal and confirm the load-bearing ones:

```json
{
  "repo": "owner/name",
  "test_command": "php artisan test",
  "test_globs": ["**/*.php", "tests/**"],
  "install_commands": ["composer install --no-interaction"],
  "env_files": [".env"],
  "simplify_globs": ["**/*.php"],
  "docblock_globs": null,
  "docs_dir": null,
  "logs_dir": "logs/ticketmill",
  "claim_label": "ticketmill",
  "verify_notes": [],
  "browser": null,
  "models": {},
  "roles": { }
}
```

Field rules:
- `test_command` is REQUIRED and may be `null` ONLY as an explicit human decision.
  If you find no test suite, ASK: "I found no test command. Ticketmill will merge
  code that no automated test has exercised, and every batch PR will carry a
  visible 'Verification Gaps' notice. Confirm `test_command: null`?" Never write
  null on your own initiative.
- `env_files`: files the test suite needs that git doesn't track (e.g. `.env`).
  They are copied root -> worktree at issue setup.
- `verify_notes`: environment preconditions agents must know (required containers,
  seed commands, service dependencies). Anything you needed in Step 4 belongs here.
- `browser`: OPT-IN. Only propose it for projects with a servable UI AND if the user
  wants live browser verification: `{ "serve_command": "... --port={port}",
  "build_command": null, "ui_globs": [...], "port_base": 8100, "notes": "..." }`.

## Step 3 — Map project agents onto pipeline roles

1. List `<ROOT>/.claude/agents/*.md`; read each frontmatter `name` + `description`.
2. Propose a role map. Roles: `implementers` (array — the agents that write code,
   ideally one per domain), `default_implementer`, `task_reviewer`, `spec_reviewer`,
   `code_reviewer`, `contrarian`, `test_validator`, `simplifier`, `docblock_writer`,
   `doc_writer`.
3. Map by what each agent's description says it does — do NOT force-fit (a UX
   reviewer is not a code reviewer). Leave a role `null` when nothing fits; the
   engine has a built-in charter for every role.
4. Show the map with the gaps, and for each gap offer:
   - leave it on the built-in charter (fine for v1), or
   - generate a project-specific agent now via the `forge-agent` skill
     (`/ticketmill:forge-agent`). Generated agents land in `<ROOT>/.claude/agents/`
     and work in the very next mill run — the engine has stage subagents read the
     agent file directly, so no session restart is needed for ENGINE use. (A restart
     IS needed before the agent shows up for direct Task-tool use.)

## Step 4 — Doctor pass (environment proof; gates writing the profile)

Never trust an unproven profile. In a scratch worktree:

1. `git worktree add /tmp/ticketmill-doctor-<repo> HEAD`
2. Copy each `env_files` entry from ROOT into it.
3. Run each `install_commands` entry; then run `test_command` (unless null).
4. Every failure here is a finding: fix the profile (missing env file, missing
   service, wrong command) and re-run, or record the precondition in `verify_notes`.
   Only proceed when install + tests pass in the scratch worktree, because this is
   exactly what the engine will do per issue — a failure here would otherwise recur
   as N expensive mid-batch failures.
5. Clean up: `git worktree remove --force /tmp/ticketmill-doctor-<repo>`.

If `browser` is configured, also boot `serve_command` once (any port) and curl it.

## Step 5 — Write everything

1. Write the confirmed profile to `<ROOT>/.claude/ticketmill.json`.
2. Copy the engine and setup script into the repo so runs don't depend on the
   plugin being installed on every machine:
   - `${CLAUDE_PLUGIN_ROOT}/workflows/ticketmill.js` -> `<ROOT>/.claude/workflows/ticketmill.js`
   - `${CLAUDE_PLUGIN_ROOT}/scripts/setup-worktree.sh` -> `<ROOT>/.claude/scripts/ticketmill/setup-worktree.sh` (chmod +x)
3. Ensure `.gitignore` covers `.worktrees/` and the profile's `logs_dir`.
4. Offer to commit the onboarding files (profile, engine copy, setup script,
   .gitignore) — recommended, so teammates and other machines get them.

## Step 6 — Hand off

Print the ready-to-run invocation, pre-filled with the repo's real base branch:

```
Workflow({
  scriptPath: "<ROOT>/.claude/workflows/ticketmill.js",
  args: { branch: "<base>", issues: [<n>], dry_run: true, run_label: "<today>" }
})
```

Recommend the `dry_run: true` first run, and note that `/ticketmill:mill` handles
launches from here on.
