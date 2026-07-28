# Working on the architecture docs

Read this before editing anything under `docs/architecture/`. Ten of the files
in this directory used to be one file, `docs/ARCHITECTURE.md`, split into
topic-sized pages by issue #154; any file added since is new material, not
part of that split. The split is provable: a committed test reconstructs the
original document from the ten split-derived files and checks it byte for
byte against a digest recorded when the split happened.

> **Parity note:** `CLAUDE.md` and `AGENTS.md` in this directory are byte-identical
> on purpose, so an agent finds the same guidance under whichever name its harness
> looks for. If you change one, copy it over the other in the same commit:
> `cp docs/architecture/CLAUDE.md docs/architecture/AGENTS.md`.

## THE INVARIANT

Every one of these files is a mix of two kinds of text, and they are not
interchangeable:

- **Moved prose.** Paragraphs, headings, tables, and code blocks carried over
  verbatim from the original `docs/ARCHITECTURE.md`, with only mechanical
  changes applied (a heading demoted or promoted a fixed number of levels, a
  handful of `docs/diagrams/...` links rewritten to `../diagrams/...`, four
  cross-references reworded from "above"/"below" to name the file the
  referenced section now lives in). `tests/architecture-provenance.test.js`
  hashes this text, GIT-FREE, against `tests/fixtures/architecture-split.json`
  and fails if a single character of it differs from what shipped in the
  split.
- **Authored text.** Each file's one-sentence lede under its title, the seven
  synthetic `#` titles given to files whose first moved section didn't carry
  a natural H1 of its own, and `index.md`'s file-map table. None of this
  existed in the original document. All of it is ordinary prose you can edit
  freely, the same as any other doc in this repo.

If you can't tell which kind a given line is, check
`tests/fixtures/architecture-split.json`: the `outputs` entry for your file
lists exactly which line ranges came from the base document (by an exact
`firstLine`/`lines` locator) and what heading shift applies to them.
Everything in a file that isn't inside one of its listed segments is
authored text.

## What happens if you edit moved prose anyway

`node --test` goes red on `tests/architecture-provenance.test.js`, in one of
two ways:

- **Per-file check fails**: the file whose moved prose you touched no longer
  hashes to its recorded digest. The failure names the file.
- **Whole-document check fails**: the full reconstruction across all ten
  files no longer hashes to the recorded digest, even if no per-file check
  caught it (this can happen for a rewrite or cross-reference edit, since
  those live outside any single file's segment list).

Either way, the fix is the same: **revert the edit to the moved prose, and
open a follow-up issue for the wording change you wanted.** Do not edit the
test's expected digest to make it pass. A red result here means the
provenance proof no longer holds, the same proof that made this split safe
to ship.

## What lives here

| File | Contents |
| --- | --- |
| `index.md` | Base lines 1-6 (the opening paragraph) plus the file map below. |
| `pipeline.md` | `## Pipeline` folded into its own H1: the overview picture, the provenance paragraph, the legend, and all five phase sections. |
| `agents-and-models.md` | Persona-by-reference and model policy. |
| `profile-and-environment.md` | The required profile and the mill-init doctor pass. |
| `invocation-and-guardrails.md` | Invocation, the sandbox lint, and the engine-owned path guardrail. |
| `branching-and-merge.md` | The batch-branch model, release stage, and merge auto-resolve. |
| `metrics.md` | Friction and churn, rework tax, gate yield, and outcome grading. |
| `gate-hygiene.md` | Typed review findings, engine-assigned ids, the three loop predicates, and gate-outcome tallying (the quality gate's disposition map, its cap, and its supersession of `metrics.md:114`). Authored text, added after the split; not tracked in the provenance fixture, the same as the `AGENTS.md`/`CLAUDE.md` row below. |
| `failure-semantics.md` | How the run fails, halts, and resumes (two segments, emitted out of source order: the short bullet list first, the incident-derived-machinery table second). |
| `cost-and-tokens.md` | Token tracking, cost estimation, and the token_budget guard. |
| `scheduling.md` | Claims interop, the consolidation gate, and lane scheduling. |
| `AGENTS.md`, `CLAUDE.md` | This freeze pair. Not moved prose; not tracked in the provenance fixture. |

`docs/ARCHITECTURE.md` (one level up) is a permanent redirect stub left at the
old path for old bookmarks and links; it is not meant to be edited beyond
that, and nothing under `docs/` links back to it.

## Adding or restructuring a section

The provenance test only knows about the ten files and line ranges recorded
when the split happened. It has no opinion on new material:

1. New prose (a new section, a new page) is authored text from the moment
   you write it. Add it wherever it reads best; there's nothing to keep in
   sync.
2. If you genuinely need to reshuffle moved prose across files (not just add
   to it), treat it as a second split-style change: it needs its own fixture
   update and its own one-time provenance re-proof, the same way issue #154
   built this one. Don't hand-edit the fixture's `sha256` values
   to match a reshuffle; regenerate them the way the fixture's own
   `sha256._schema` note describes.
3. Either way, keep `index.md`'s file map current. It's authored text, so
   the provenance test won't catch a stale row, but a reader following it
   will.

## A frozen passage that is now stale prose

`metrics.md:81-84` ("Completing the gate findings tally", ending
"`gate_findings['pr-review'].severity` stays zero across the board") is
moved prose describing the state of the world before issue #162, and it was
already inaccurate when it shipped: the merge gate already fed real,
non-zero counts into `gate_findings['pr-review'].severity` whenever a
reviewer happened to name a concern in `issues` rather than `comments`.
Issue #162 is what makes the correction worth writing down: severity counts
are now guaranteed and schema-backed rather than incidental. The sentence
cannot be corrected in place — it sits inside a tracked segment — so it was
left exactly as it shipped and superseded by `gate-hygiene.md`, which is
the correction and the durable source of truth. Read `gate-hygiene.md`'s
provenance paragraph before trusting anything `metrics.md` says about
`gate_findings['pr-review'].severity`.

A second, unrelated sentence in the same file goes stale the same way, for
the same structural reason: `metrics.md:114`, the `computeGateYield(results)`
lede — "rolls the three gates' `gate_findings` tallies" — describes a world
where `approach`, `plan`, and `pr-review` were the only gates that ever
appeared in `gate_findings`. Issue #163 makes that untrue: the quality loop
now records outcomes through `recordGateOutcome` too, so a fourth gate
routinely shows up in the same rollup. This sentence cannot be corrected in
place either, and not merely because it sits inside a tracked segment the
way `metrics.md:81-84` does — `metrics.md`'s only tracked segment is not
scoped to a passage within the file, it spans nearly the whole file:
`tests/fixtures/architecture-split.json` records one segment for
`metrics.md`, 329 lines starting at its first heading and running to the
end of the 332-line file — everything but the four-line synthetic H1 and
lede above that heading. `tests/architecture-provenance.test.js` hashes
that segment verbatim, so it hashes the file from its first heading to the
end, and there is no partial-credit edit even smaller than the one
described above. `metrics.md:114`
stays exactly as it reads, superseded by `gate-hygiene.md`'s "The quality
gate" section, the same way `metrics.md:81-84` is superseded by the section
above it.
