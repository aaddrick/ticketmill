# Agents and models

Ticketmill picks a persona and a model for every stage instead of guessing. This page covers the persona-by-reference mechanism and the model policy behind that choice.

## One agent mechanism: persona-by-reference

Roles map to agent files in the target repo (`profile.roles`). A stage prompt
instructs its subagent to read `<root>/.claude/agents/<name>.md` first and adopt
the persona; unfilled roles get a built-in charter inlined. The engine never
passes `agentType`.

Why not use the registry when available and inline otherwise? Because the two
paths produce materially different agents (registry loads the file as a system
prompt; truncated inlining ships a near-generic one), and which path you got
would depend on whether the agent predated the session. Quality would vary
run-to-run for reasons invisible in any log. One mechanism keeps behavior
deterministic, makes freshly generated agents usable immediately, and costs one
extra file read per stage.

## Model policy

Judgment gates (evaluate, plan, contrarian challenges, final code review) default
to opus at high effort; workhorse implementation and reviews run sonnet;
mechanical probes and the test runner are haiku at low effort. Override any stage
via `profile.models`.

## Contrarian cap depth is profile-configurable, and cap-outs are never silent

`MAX_CONTRARIAN_ITERATIONS` was a hardcoded `3`. It's now a `let`, defaulting
to `3` but overridable per repo through the optional
`profile.contrarian_max_iterations` (any integer >= 1, validated at Select
time and rejected otherwise). A repo whose issues run deep and contentious
can raise the ceiling. One that wants faster turnaround can lower it.

A trivial-complexity issue never gets the full ceiling, whatever the profile
sets. `contrarianCapFor(complexity)` floors its per-gate cap at
`Math.min(2, MAX_CONTRARIAN_ITERATIONS)`. A docs-only fix shouldn't burn opus
time re-litigating a settled call, and a profile that drops the ceiling
below 2 tightens trivial issues along with everything else. The function is
pure and declared above the harness split marker, so tests exercise it
directly instead of seeding module state.

Hitting the cap on the approach or plan gate still lets the issue proceed
with the gate's unresolved caveats, the same fallback the engine has always
used. That cap-out now also pushes an entry onto `VERIFY_SKIPS`. Previously
it landed only in `ctx.unresolved`, which feeds the first implementation
task's prompt but never reaches the batch PR body. A caveat worth a human's
attention could ship, merge, and never appear in the one artifact a reviewer
actually reads. Every cap-out on either gate now lands in the batch PR's
Verification Gaps section beside the other skipped-verification kinds.
