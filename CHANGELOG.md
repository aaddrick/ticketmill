# Changelog

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
