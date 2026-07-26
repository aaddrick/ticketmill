# Architecture docs have moved

This file used to hold the whole architecture write-up; it now lives at
[docs/architecture/index.md](architecture/index.md), split across the files below.

| File | Contents |
| --- | --- |
| [pipeline.md](architecture/pipeline.md) | The five-phase pipeline overview picture, the legend, and the Select/Plan/Build/Ship/Report phase sections. |
| [agents-and-models.md](architecture/agents-and-models.md) | Persona-by-reference and model policy. |
| [profile-and-environment.md](architecture/profile-and-environment.md) | The required profile and the mill-init doctor pass. |
| [invocation-and-guardrails.md](architecture/invocation-and-guardrails.md) | Invocation, the sandbox lint, and the engine-owned path guardrail. |
| [branching-and-merge.md](architecture/branching-and-merge.md) | The batch-branch model, release stage, and merge auto-resolve. |
| [metrics.md](architecture/metrics.md) | Friction and churn, rework tax, gate yield, and outcome grading. |
| [failure-semantics.md](architecture/failure-semantics.md) | How the run fails, halts, and resumes. |
| [cost-and-tokens.md](architecture/cost-and-tokens.md) | Token tracking, cost estimation, and the token_budget guard. |
| [scheduling.md](architecture/scheduling.md) | Claims interop, the consolidation gate, and lane scheduling. |
| [AGENTS.md](architecture/AGENTS.md) | Freeze pair with CLAUDE.md, constraining tech-docs to this directory's conventions. |
