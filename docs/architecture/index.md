# Ticketmill Architecture

Ticketmill is a deterministic orchestration script (`workflows/ticketmill.js`) run
by the Claude Code Workflow tool. Control flow (loops, gates, caps, breakers) is
plain JavaScript; every unit of actual work is a schema-validated subagent call.

| File | Contents |
| --- | --- |
| [pipeline.md](pipeline.md) | The five-phase pipeline overview picture, the legend, and the Select/Plan/Build/Ship/Report phase sections. |
| [agents-and-models.md](agents-and-models.md) | Persona-by-reference and model policy. |
| [profile-and-environment.md](profile-and-environment.md) | The required profile and the mill-init doctor pass. |
| [invocation-and-guardrails.md](invocation-and-guardrails.md) | Invocation, the sandbox lint, and the engine-owned path guardrail. |
| [branching-and-merge.md](branching-and-merge.md) | The batch-branch model, release stage, and merge auto-resolve. |
| [metrics.md](metrics.md) | Friction and churn, rework tax, gate yield, and outcome grading. |
| [gate-hygiene.md](gate-hygiene.md) | Typed review findings, engine-assigned ids, the absent-vs-empty distinction, the three loop predicates, and gate-outcome tallying (the quality gate's disposition map, its cap, and its supersession of `metrics.md:114`). |
| [failure-semantics.md](failure-semantics.md) | How the run fails, halts, and resumes. |
| [cost-and-tokens.md](cost-and-tokens.md) | Token tracking, cost estimation, and the token_budget guard. |
| [scheduling.md](scheduling.md) | Claims interop, the consolidation gate, and lane scheduling. |
| [AGENTS.md](AGENTS.md) | Freeze pair with CLAUDE.md, constraining tech-docs to this directory's conventions. |
