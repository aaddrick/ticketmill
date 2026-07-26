# Profile reference

See [Profile and environment](architecture/profile-and-environment.md) for why the profile is required and how mill-init proves it; this page is the field-by-field reference for configuring one.

See the annotated schema in the header of `workflows/ticketmill.js`. The
load-bearing fields:

| Field | Meaning |
|---|---|
| `test_command` | Required key. Command string, or explicit `null` (no test gate, surfaced on every batch PR) |
| `test_globs` | Changed-file patterns that count as testable |
| `install_commands`, `env_files` | Per-worktree provisioning (run/copied at issue setup) |
| `verify_notes` | Environment preconditions injected into test/fix prompts (required services, seed data) |
| `roles` | Role-to-agent map; `implementers` is the list the planner assigns tasks to |
| `simplify_globs` | Files worth a simplify pass; unset/`null` runs the simplifier against every changed file (fail-open), it does NOT skip the stage |
| `docblock_globs`, `docs_dir` | Gate the docblock and tech-docs stages; `null` skips |
| `browser` | Opt-in live browser verification (serve command with `{port}`, UI globs, notes). Also accepts optional `lock_path` (default `/tmp/ticketmill-browser-lock`), `stale_seconds` (default `1800`), `poll_seconds` (default `15`), `port_span` (default `900`), and `artifact_dir` (default `/tmp/ticketmill-issue-{issue}`, `{issue}`-templated like `serve_command`'s `{port}`); **caveat:** the resolved `artifact_dir` is deleted with `rm -rf` on cleanup (both the per-issue browser-verify stage and the final batch cleanup), so it must be a dedicated scratch path (never a project directory, shared mount, or `$HOME`) |
| `models` | Per-stage model/effort overrides. Valid stage keys are enumerated in the header schema comment (`workflows/ticketmill.js`), adjacent to the `M` map that is their source of truth |
| `consolidation` | Default `true`. Set `false` to disable the Select-phase consolidation gate entirely (a resumed run still heals any group a prior run already committed to) |
| `release` | Optional, default `null` (Report-phase release stage skipped entirely). Set `{ version_files: [...] }` to opt in to a once-per-batch CHANGELOG entry and version bump on the canonical version file(s), landed before the batch PR. Also accepts optional `changelog` (default `CHANGELOG.md`) and `bump` (`"major"\|"minor"\|"patch"` override; unset derives `feat` -> minor, else patch, from the batch's shipped commit types) |
| `serialize_globs` | Optional, default `[]`. Patterns worth trusting as a lane-scheduling hint beyond predicted-file overlap alone: a shared schema, a magnet config, anything two issues could conflict on without their own predicted paths overlapping |
| `warn_base_branches` | Optional, default `[]`. Base branch names that trigger a Select-phase warning when a batch targets one of them (PRs normally target the working branch, not a branch that auto-deploys on push). Unset/`[]` = no warning |
| `claim_label` | GitHub label applied to an issue when a run claims it (cross-run coordination; see header schema) |
| `engine_owned_globs` | Optional, default `[]`. Extends the built-in engine-owned path set (`.claude/ticketmill.json`, `.claude/agents/**`, `.claude/workflows/ticketmill.js`, `.claude/scripts/ticketmill/**`), read-only during a run |
| `lockstep_installed_paths` | Optional, default `[]`. Engine-owned paths that are a deliberate installed copy of a source-of-truth file elsewhere in this repo, exempted from the post-implement hard-revert gate |
| `logs_dir` | Directory for run summaries and retrospective learnings |

**Correction made during the docs/ move (issue #154/#155):** the table this page
replaces described `simplify_globs`, `docblock_globs`, and `docs_dir` as one
row sharing a single "`null` skips" behavior. `runQualityLoop`'s
`PROFILE.simplify_globs || null` is fail-open: an unset or `null`
`simplify_globs` matches every file, so the simplifier still runs. Only
`docblock_globs` and `docs_dir` skip their stage on `null`. The table above
reflects the corrected behavior; the row split is the only content change made
while moving this table out of README.
