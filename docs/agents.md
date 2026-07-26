# How agents work

See [Agents and models](architecture/agents-and-models.md) for why persona-by-reference exists and how model policy is chosen; this page covers how to configure roles for your own repo.

Ticketmill thinks in roles. Your profile's `roles` map assigns each role to an
agent in your repo's `.claude/agents/`. Every role also has a built-in fallback
charter, so a role left `null` still runs on the generic charter. If the profile
names an agent whose file is missing, the engine uses the fallback and lists the
gap in the batch PR's Verification Gaps section.

| Role (profile key) | What it does in the pipeline |
|---|---|
| `implementers` | The agents that write code: an array, ideally one per domain (e.g. backend, frontend). The planner assigns each task to the best fit |
| `default_implementer` | The implementer used when no domain-specific one fits a task |
| `task_reviewer` | After each task: verifies the implementation achieves the task goal against the actual diff |
| `spec_reviewer` | At the PR gate: verifies the PR fulfills the *issue's* requirements and flags scope creep for removal |
| `code_reviewer` | At the PR gate (parallel with spec review): correctness, security, error handling, codebase conventions |
| `contrarian` | Devil's-advocate gate that stress-tests the approach and the task plan before any code is written |
| `test_validator` | Audits tests for cheating: hollow assertions, mock abuse, missing edge cases, tests that pass without exercising the change |
| `simplifier` | Quality loop: refines changed code for clarity and consistency without changing behavior (gated by `simplify_globs`) |
| `docblock_writer` | Writes doc comments for changed code in the project's style (gated by `docblock_globs`) |
| `doc_writer` | Writes technical design docs into `docs_dir` after review passes (skipped when `docs_dir` is `null`) |

One mechanism, deliberately: a stage's subagent is instructed to read the mapped
agent file and adopt its persona. The engine never depends on the session's agent
registry, so a freshly generated agent works in the very next run, and behavior is
identical before and after a session restart.

Role staffing happens during onboarding. mill-init reads each agent in your
repo's `.claude/agents/` and maps it to a role by what its description says it
does. It never force-fits: a UX reviewer is not a code reviewer, and a role with
no honest match stays `null`. The contrarian role fills automatically from a
bundled template copied into your repo (mill-init prefers a
`~/.claude/agents/contrarian.md` of your own if one exists). Every other gap
gets an inline choice: keep the built-in charter, or have
`/ticketmill:forge-agent` write a project agent grounded in domain research plus
your actual codebase conventions. A forged agent updates the role map itself, so
the profile needs no hand edits.
