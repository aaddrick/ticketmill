# Changelog

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
