# Changelog

## 0.1.13 (2026-07-19)

- Added `.github/workflows/ci.yml`: runs the profile's `test_command` on
  every pull request (no branch filter) and on pushes to `main`, on
  `ubuntu-latest` with Node 22. `permissions: contents: read` only — no
  secrets, no `gh` auth, no `GITHUB_TOKEN` beyond checkout's default. The
  run step extracts the command via
  `jq -r '.test_command // ""' .claude/ticketmill.json` and executes it
  with `bash -c`, so the command itself is never restated in the YAML —
  `.claude/ticketmill.json` stays the single source of truth. An empty
  `test_command` prints a `::notice::` and exits 0 instead of failing. A
  syntax error anywhere in the profile's test chain (engine, scripts,
  manifests, unit/bash suites) now turns this check red on the PR.

## 0.1.12 (2026-07-19)

- Added `scripts/lint-engine.js`, a zero-dependency sandbox-rule lint for
  `workflows/ticketmill.js`. The Workflow tool sandbox forbids `Date.now()`,
  `Math.random()`, argless `new Date()`, and any filesystem/Node API
  (`require`/`import`) — all legal JavaScript, so `node --check` passes on
  them, but they throw at runtime or silently break resume. The lint does a
  dumb, loud, line-by-line text scan for those constructs and prints
  `file:line: message` on any hit, skipping pure-comment lines (the engine's
  own doc comments legitimately name these APIs) and any line carrying the
  literal `// sandbox-ok` marker, the only escape hatch (no weaker
  pattern-based exceptions).
- The same script also fails if `.claude/workflows/ticketmill.js` is not
  byte-identical to `workflows/ticketmill.js` — the two are supposed to be
  the same engine, and drift means one copy was edited without the other.
  Wired `node scripts/lint-engine.js` into `test_command` in
  `.claude/ticketmill.json` immediately after `node --check`, and reinforced
  the lockstep-edit rule in `verify_notes`.
- Forward-synced `.claude/workflows/ticketmill.js` from `workflows/
  ticketmill.js` as part of landing this lint: the `.claude` copy had drifted
  27 lines behind (missing the `sanitizeTasks` lift-to-top-level refactor and
  the `__seed` test-harness hook from issues #4/#5's already-stacked work,
  which landed only in `workflows/`). This commit's diff to the `.claude`
  copy is therefore mostly that non-lint catch-up churn, not new lint logic.
- Added `tests/sandbox-lint.test.js`: for each forbidden construct, seeds it
  into a throwaway sandbox copy of the engine and runs the lint as a child
  process, asserting a non-zero exit and the correct `file:line` in the
  output; asserts the real engine lints clean; and asserts the byte-compare
  sync check passes when the two engine copies match and fails (reporting
  `.claude/workflows/ticketmill.js:1:`) when they differ.

## 0.1.11 (2026-07-19)

- Added `tests/setup-worktree.test.sh`, a self-contained plain-bash suite for
  `scripts/setup-worktree.sh` (no bats, no global installs). Each of its five
  cases builds a fresh scratch git repo plus an offline local bare `origin`
  seeded with the base branch, and stubs `gh` on `PATH` so the script runs
  with no network and no `gh` auth: fresh branch/worktree creation with valid
  JSON stdout, idempotent reuse of an `issue-<N>-*` branch even when the
  upstream title changes (a pre-planted sentinel file proves the worktree
  isn't destroyed), stale-worktree replacement when the checked-out branch
  doesn't match the prefix, a missing-args usage error, and an unfetchable
  base-branch error — the last two assert a non-zero exit plus the JSON error
  shape. Also runs `shellcheck` on the script when available.
- Fixed a real contract bug the new suite caught: `git branch <name>
  origin/<base>` in `scripts/setup-worktree.sh` was unredirected and leaked a
  "set up to track ..." line onto stdout on every fresh-branch path,
  corrupting the JSON-on-stdout contract the engine parses. Redirected it to
  match the adjacent `worktree add` call.
- Wired `&& bash tests/setup-worktree.test.sh` onto the profile's
  `test_command` in `.claude/ticketmill.json`, appended after the existing
  `node --test` entry — a `.test.sh` file is invisible to `node --test`'s
  `tests/*.test.js` discovery, so both suites run and neither shadows the
  other.

## 0.1.10 (2026-07-19)

- Wired `node --test` into the profile's `test_command`, after the existing
  `node --check` / `bash -n` / manifest-JSON smoke checks — the 33-test suite
  added in issue #4 (`tests/`: a truncate-and-evaluate vm harness plus unit
  tests for `sanitizeTasks`, `scopeGuard`, the decision/settled/notes ledger
  helpers, `timeline`, `pickFixAgent`, `globToRe`/`matchesGlobs`, and the test
  loop's `MAX_TEST_ITERATIONS` cap) now gates every mill run instead of just
  syntax checks.
- Confirmed the gate has teeth two ways: the repeatable `tests/harness.test.js`
  meta-test (mutates the stub-task guard in memory and asserts the resulting
  unit-test assertion fails), and a one-time hand check that reverting a
  covered helper on disk turns `node --test` red (3/33 failing), then cleanly
  reverting it back to green.
- `test_command` uses bare `node --test` (auto-discovers `tests/*.test.js`),
  not `node --test tests/` — the directory-argument form throws
  `MODULE_NOT_FOUND` on Node 22.22.0.

## 0.1.9 (2026-07-19)

- Onboarded this repo for its own mill runs (dogfooding): `.claude/ticketmill.json`
  profile, forged implementer / code-reviewer / test-validator agents, contrarian
  copied into the project roster, engine + setup script copied to `.claude/`.
- The profile's test_command is a syntax/manifest smoke check for now; issues
  #4-#7 build the real test engine via ticketmill itself.

## 0.1.8 (2026-07-18)

- README: the Quickstart dry-run example is a plain request now, no longer a
  Workflow call. The mill skill takes "dry run" in natural language.
- README: Run options now suggests a small skill invoking /ticketmill:mill for
  standing preferences, instead of restating options every run.

## 0.1.7 (2026-07-18)

- README: new Follow-up issues section on the one place the engine files new
  issues (successful merges), what feeds them, and how they are labeled and
  deduplicated.
- ARCHITECTURE: rebuilt the pipeline diagram. Quoted labels with `<br/>` breaks
  instead of `\n` (fixes clipped boxes), phase rows stacked left-to-right
  instead of one tall chain, explicit challenge/fix loop edges with caps, and a
  dashed learnings edge into the next run. Render-checked in a browser.

## 0.1.6 (2026-07-18)

- README: added an Author section above the license, with GitHub and LinkedIn
  links.

## 0.1.5 (2026-07-18)

- README: new Run options section documenting every workflow arg and its
  default, plus what `concurrency` does and does not parallelize.
- README: new Watching a run section on the issue comment trail, the PR
  review rounds, the logs dir outputs, and live progress via /workflows.
- README: new Overlapping batches section explaining the claim protocol when
  maintainers start batches with overlapping issue lists. The Cross-run claims
  bullet now points there.
- README: new Resuming an interrupted run section covering both resume paths,
  finding the batch branch after a dead session, and the usage-limit breaker.
  The Resumable everywhere bullet now points there.

## 0.1.4 (2026-07-18)

- README: "How agents work" now describes init-time role staffing. mill-init
  maps existing agents by their descriptions without force-fitting, resolves the
  contrarian role from the bundled template, and offers forge-agent inline for
  each remaining gap. A forged agent updates the role map itself.
- README: the Quickstart mill-init comment says "agent staffing" instead of
  "role map".

## 0.1.3 (2026-07-18)

- README: expanded the one-line requirements note into a full Requirements
  section (Workflow tool, authenticated `gh` with repo write access, git
  worktrees, GitHub remote, verified profile, locally runnable toolchain,
  optional browser MCP).
- README: documented all ten `roles` profile keys in a table, with each role's
  pipeline responsibility drawn from the engine's built-in charters, and
  clarified when a fallback charter is a Verification Gap (missing agent file)
  versus not (role explicitly `null`).

## 0.1.2 (2026-07-18)

- The bundled contrarian template is now the verbatim canonical agent from
  https://github.com/aaddrick/contrarian (dropped the 0.1.1 evidence-discipline
  addition; the engine's gate prompts already carry verify-before-asserting
  instructions, so the agent file stays true to its source).

## 0.1.1 (2026-07-18)

- Bundle a contrarian agent template (`templates/agents/contrarian.md`) with an
  evidence-discipline section. mill-init now resolves the contrarian role by
  copying: project copy if present, else the user's `~/.claude/agents/contrarian.md`,
  else the bundled template. forge-agent remains the optional
  project-grounding upgrade.

## 0.1.0 (2026-07-18)

Initial release.

- Engine (`workflows/ticketmill.js`): stack-agnostic port of the flyspacea
  batch-issues workflow. Profile-driven toolchain (`.claude/ticketmill.json`),
  role-based agent staffing from the target repo's `.claude/agents/`, explicit
  test-gate decisions, Verification Gaps surfaced on the batch PR, opt-in browser
  verification, claims interop with the ancestor engine.
- Skills: `mill` (launch, with Workflow-tool hard-stop), `mill-init` (onboarding
  with doctor pass and role mapping), `forge-agent` (project-grounded agent
  generation).
- `scripts/setup-worktree.sh`: deterministic worktree creation; prefix-based
  branch reuse, submodule init, no language-specific installs.
- Plugin packaged as its own single-plugin marketplace.
