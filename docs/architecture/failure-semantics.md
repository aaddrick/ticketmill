# Failure semantics

- Stage dies twice -> the issue fails/halts at that stage with an issue comment
  carrying resume instructions; the claim is released.
- Three issue failures, or three consecutive agent deaths -> circuit breaker:
  remaining issues are marked `not_started`, the report carries a resume plan.
- `token_budget` reached or projected to be exceeded -> `budget_halt`, a state
  distinct from `circuit_breaker`: the run stopped on purpose, before starting
  an issue, not because an agent failed. Its own `resume_hint` names raising
  the budget or splitting the remaining issues as the next step.
- Quality loop degrades (non-fatal) but 3 degrades in a rolling window of 5 halt
  the issue: that rate signals a systemic problem, not flakiness.
- Reviewer death at the PR gate -> `needs_human`, PR left open; reviewer death at
  the task gate -> provisional accept, flagged for extra PR-gate scrutiny.
- A failed consolidation group -> ONE circuit-breaker increment, not one per
  member (`fail()` runs exactly once per unit); every member issue's claim is
  released; each member gets its own resume comment naming the group and the
  failing stage, so any one member's trail is enough to understand the whole
  unit halted together. On resume, preflight healing recognizes the group from
  that comment's marker and re-proposes the SAME group rather than reprocessing
  its members as independent issues.

## Incident-derived machinery (preserved from the source engine)

| Mechanism | Incident it answers |
|---|---|
| Scope guard + comment markers + misfiled-comment deletion | A concurrent pipeline posted one issue's plan onto another issue |
| Stub-task guard (`sanitizeTasks`) | A placeholder plan record shadowed a real plan and dispatched an empty task |
| Settled-decisions ledger | Contrarian gates oscillated (drop -> hardcode -> drop) across iterations, burning opus time re-litigating |
| "A finding is a hypothesis" in revision prompts | A wrong Major was adopted without verification, causing the oscillation above |
| Handoff notes ledger | Env workarounds were rediscovered from scratch several stages later |
| Test loop halts (never degrades) | Silent test skips shipped broken code |
| Claim protocol with label-safety rules | A claim agent once replaced an issue's full label set |
| Browser lock (mkdir + owner + stale-steal) | Concurrent agents hijacked each other's browser tabs |
| Degrade windows + circuit breakers | Distinguish one flaky stage from a systemic failure worth stopping for |
| `isBudgetExhaustedError` noun+verb match | A bare keyword sweep on "budget"/"ceiling" matched a target repo's own domain errors, misreporting an ordinary agent death as token exhaustion and halting every remaining issue |
| `COMMIT_SHA_ASK` guard (Layer 1: advisory prompt) + `probeCommitShas` (Layer 2: post-hoc existence check) | Twice, an agent typed a fabricated or shortened commit SHA into a posted comment instead of reading the real one, requiring a fixup edit |
| `VERIFY_SKIPS` entry on a contrarian cap-out | An approach or plan gate's cap-out reached only `ctx.unresolved`, never the batch PR's Verification Gaps section, so a caveat worth a human's attention could ship and merge unseen |
| Report-phase release stage (`releaseEnabled`, `deriveReleaseVersion`) | A batch of real engine changes (PR #56) merged with the CHANGELOG and version file left stale, because the pipeline had always assumed some later stage bumped them and no stage ever did |
