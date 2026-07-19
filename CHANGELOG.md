# Changelog

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
