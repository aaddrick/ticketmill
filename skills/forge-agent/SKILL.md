---
name: forge-agent
description: Generate a project-specific agent definition for a ticketmill pipeline role (implementer, code reviewer, test validator, etc). Use when mill-init finds a role gap, or when asked to create an agent for a repo. Produces .claude/agents/<name>.md grounded in domain research and the actual codebase.
---

# forge-agent — generate a project agent for a pipeline role

Writing an agent is Test-Driven Development applied to a role definition: gather
evidence first (domain best practices + how THIS codebase actually works), write the
persona against that evidence, then check it against representative tasks. An agent
written from generic knowledge alone is a generic agent — the codebase context is
what earns its keep.

## Inputs

- The ROLE it fills (one of ticketmill's: implementer for a domain, task_reviewer,
  spec_reviewer, code_reviewer, contrarian, test_validator, simplifier,
  docblock_writer, doc_writer — or any role the user names).
- The target repo root.

## Step 1 — Research the domain

Use WebSearch for the agent's domain, current year:
- "[domain/framework] best practices [year]"
- "[domain] anti-patterns" / "common mistakes"
- "[technology] security considerations" (when applicable)

Harvest concrete, actionable items — these feed the anti-patterns section. Skip
generic advice ("write clean code") that changes no behavior.

## Step 2 — Ground it in the codebase

1. Read the repo's CLAUDE.md and README for hard conventions.
2. Explore the structure the agent will work in (key directories, existing services/
   modules, naming patterns, test layout).
3. Read 1-2 existing agents in `.claude/agents/` for coordination conventions and
   deferral relationships to keep consistent.

## Step 3 — Write the agent

File: `<ROOT>/.claude/agents/<kebab-case-name>.md`

```markdown
---
name: agent-name
description: [Role statement]. Use for [specific task types].
---

You are a [specific role] with expertise in [domains], working on [this project].

## Core competencies
- [Capability]: specifics

**Not in scope** (defer to [other-agent]): [excluded domains]

## Anti-patterns to avoid
- **[Specific mistake]** — [what to do instead]   <- from research AND this codebase

## Project context
[Directory structure the agent works in; key commands (test, build, lint);
conventions from CLAUDE.md that constrain this agent's work]

## Coordination
[How it reports completion; who it defers to]
```

Quality bars (all must hold):
- Description under 500 chars, states triggers, contains NO process summary
  (a process in the description gets followed INSTEAD of the agent body).
- Persona names the project and stack — never "you are a helpful assistant".
- Every anti-pattern is actionable and specific; at least a few must come from
  THIS codebase, not just the web research.
- Explicit scope boundaries with deferral targets when sibling agents exist.
- Omit `model:` frontmatter unless the role demonstrably needs a specific tier.

## Step 4 — Check it

Pick 1-2 representative tasks for the role (e.g. for a code_reviewer: review the
repo's most recent real PR diff). Walk through how the agent body handles them.
Close the loopholes you find (scope violations, missing project commands, vague
guidance) before delivering.

## Step 5 — Deliver

1. Show the user the file and where it landed.
2. If invoked from mill-init: update the role map entry to the new agent name.
3. Mark expectations honestly: the agent is **unvetted** until it has been observed
   on real tasks — recommend watching its first mill run's review/fix iterations
   (the run report's per-issue timeline shows exactly where an agent thrashed).
4. Note the session-restart caveat: ticketmill's engine uses the agent file
   immediately (stage subagents read it directly), but the agent will not appear
   in the Task tool's registry for direct use until the session restarts.
