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
  "serialize_globs": [],
  "docblock_globs": null,
  "docs_dir": null,
  "logs_dir": "logs/ticketmill",
  "claim_label": "ticketmill",
  "verify_notes": [],
  "warn_base_branches": [],
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
  Optional coordination overrides (each defaults to the value shown; only mention
  them if the user needs to change one): `lock_path` (default
  `/tmp/ticketmill-browser-lock`, the shared cross-agent browser lock directory),
  `stale_seconds` (default `1800`, how long before a held lock is considered dead
  and stolen), `poll_seconds` (default `15`, wait interval between lock-acquire
  retries), `port_span` (default `900`, the modulus `port_base` is spread over per
  issue number), and `artifact_dir` (default `/tmp/ticketmill-issue-{issue}`,
  `{issue}`-templated like `serve_command`'s `{port}`, where browser-verify
  screenshots/artifacts are written).
- `lockstep_installed_paths`: only needed when the repo being onboarded keeps an
  installed copy of an engine-owned file in lockstep with a source-of-truth file
  elsewhere in the same repo, kept in sync by the repo's own tooling. List those
  installed paths so the engine's post-implement guardrail exempts them from a hard
  revert instead of undoing genuine engine work. Ticketmill's own profile (this repo,
  self-hosted) sets `lockstep_installed_paths: [".claude/workflows/ticketmill.js"]`,
  since `scripts/lint-engine.js` keeps that installed copy byte-identical to
  `workflows/ticketmill.js`. Leave it empty for every other repo.
- `serialize_globs`: OPTIONAL, default `[]`. Lane scheduling (issue #1) already
  predicts likely file overlap per issue and serializes those issues instead of
  racing them — this field is only for files that heuristic alone can't be
  trusted to catch: a magnet config, a shared schema/router, anything where two
  issues touching it concurrently would conflict even if their predicted-file
  sets don't otherwise overlap. Leave it `[]` unless the user names such a file;
  propose it only when the stack detection in Step 2 surfaces an obvious
  candidate (e.g. a single central routes/config file every feature touches).
- `warn_base_branches`: OPTIONAL, default `[]`. Base branch names that should trigger
  a Select-phase warning when a batch targets one (a signal the run may be pointed at
  a branch that auto-deploys on push rather than the intended working branch). Leave
  it `[]` unless the user names CI/CD-trigger branches for this repo (e.g. a
  `deploy-prod`/`deploy-dev` convention) — never propose a default on your own.

## Step 3 — Map project agents onto pipeline roles

1. List `<ROOT>/.claude/agents/*.md`; read each frontmatter `name` + `description`.
2. Propose a role map. Roles: `implementers` (array — the agents that write code,
   ideally one per domain), `default_implementer`, `task_reviewer`, `spec_reviewer`,
   `code_reviewer`, `contrarian`, `test_validator`, `simplifier`, `docblock_writer`,
   `doc_writer`.
3. Map by what each agent's description says it does — do NOT force-fit (a UX
   reviewer is not a code reviewer). Leave a role `null` when nothing fits; the
   engine has a built-in charter for every role.
4. **Contrarian resolution** (do this before offering forge for it). The plugin
   bundles a contrarian template so this role never starts from scratch:
   1. `<ROOT>/.claude/agents/contrarian.md` exists -> use it as-is.
   2. Else `~/.claude/agents/contrarian.md` exists -> copy it into
      `<ROOT>/.claude/agents/contrarian.md` (the engine only reads the project
      roster; user-level agents are invisible to it).
   3. Else copy the bundled template:
      `${CLAUDE_PLUGIN_ROOT}/templates/agents/contrarian.md` ->
      `<ROOT>/.claude/agents/contrarian.md`.
   Either copy is immediately usable. Offer forge-agent afterward as an optional
   upgrade that grounds the copy in this repo's specific failure modes.
5. Show the map with the remaining gaps, and for each gap offer:
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
