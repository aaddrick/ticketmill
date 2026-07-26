---
name: mill-review
description: Read-only cross-run analysis of ticketmill's own process ledger (logs/ticketmill). Use when asked to review ticketmill's run history, invoke /ticketmill:mill-review, retrospect on past mill/batch runs, or produce a cross-run trend dashboard for the pipeline itself.
---

<!--
FLAG FOR BATCH REVIEWER: issue #94's body says the local dashboard is a
"committed logs/ticketmill/dashboard.md fallback." Step 7c below deliberately
ships it as a LOCAL, GITIGNORED, NEVER-COMMITTED file instead. The ledger it
renders (runs.jsonl, runs/*.json, outcomes.jsonl) already lives under the
repo's blanket `logs/` gitignore rule, and committing a summary of that
otherwise-untracked, per-host data would make it the one tracked file in an
all-untracked tree. This is a known, called-out deviation from the issue's
literal wording, decided during approach-challenge (iteration 2,
"sound_with_caveats") and carried into the plan explicitly as vetoable. If
the batch reviewer disagrees, the fix is narrow: drop the `logs/` ignore for
this one path (`!logs/ticketmill/dashboard.md`) and add `git add -f` in
Step 7c. Don't reinterpret this as a bug.
-->

# mill-review: cross-run trend dashboard for ticketmill's own process ledger

Ticketmill journals every batch run it executes against itself and against
target repos into a local, gitignored ledger. This skill reads that ledger,
never writes to it, and turns it into three views of one data model: things
said out loud in the conversation, a shareable HTML Artifact, and a local
markdown fallback for sessions without Artifact support.

This skill is read-only against the ledger and touches no engine-owned path.
Its only write is the local dashboard file in Step 7c.

## Step 1: Resolve the ledger root (never hard-code it)

1. `ROOT = $(git rev-parse --show-toplevel)`. If that command fails (not a
   git repo, detached context), fall back to `ROOT = $(pwd)`.
2. Look for `<ROOT>/.claude/ticketmill.json`. If it exists and parses, read
   `logs_dir` from it. If the file is missing, unparsable, or `logs_dir` is
   absent, default `logs_dir` to `logs/ticketmill`, the profile schema's own
   documented default.
3. `LOGS = <ROOT>/<logs_dir>`.

Never substitute a literal absolute path for `LOGS` in any step below, even
as a shortcut. This same skill runs against ticketmill's own ledger and
against any onboarded target repo's ledger, and the two roots differ.

## Step 2: Parse the optional window argument

The slash command takes one optional argument, the window:

- **No argument**: use every run in the ledger.
- **A bare integer `N`**: the last `N` runs in `runs.jsonl` (file order is
  append order, so "last N" is the final N lines).
- **A date range `YYYY-MM-DD..YYYY-MM-DD`**: derive each run's date from its
  `batch_branch` field (format `Batch_YYYY-MM-DD_HHMMSS`, then take the date
  segment). If `batch_branch` is missing or doesn't match that shape, fall
  back to the mtime of `runs/<run_tag>.json` (or of the `runs.jsonl` file
  itself for a run with no per-run file). Keep runs whose derived date falls
  inside the inclusive range.

If the argument doesn't parse as either shape, say so plainly and fall back
to "every run," rather than guessing.

## Step 3: Load the ledger, read-only

Read exactly these four sources under `LOGS`. Do not glob `LOGS/*.json` or
otherwise scan the directory broadly. Legacy `summary-*.json` and
`summary-*.md` files sit alongside the JSONL ledger from before the
`runs.jsonl` + `runs/<tag>.json` format existed, and folding them in would
double-count runs that also have a `runs.jsonl` line.

1. **`LOGS/runs.jsonl`**: one JSON object per line, one line per run. This
   is the run index: `run_tag`, `state`, `batch_branch`, `batch_pr`, `counts`,
   `tokens_total`, `tokens_by_model`, `reconciles`, `reconcile_error`,
   `verification_gaps`, `stop_tripped`, and (only on newer runs)
   `trustworthy` and `by_issue_shape`. Apply the Step 2 window here.
2. **`LOGS/runs/<run_tag>.json`** for every run_tag selected in step 1 above
   (skip a run whose file is missing, note it as a gap, and don't error).
   This is the detailed per-run record: `completeness`, `friction_churn`,
   `rework_tax`, `gate_yield`, `by_issue_shape`, and `results[]` (per-issue
   metrics, tokens, timeline, handoff_notes, gate_findings).

   **Not every run's file has every block.** The reducers that produce
   `completeness`, `friction_churn`, `rework_tax`, `gate_yield`, and
   `by_issue_shape` were added at different times. Older run files predate
   some of them entirely. Treat an absent block as "no signal for this run,"
   never as zero. A missing `friction_churn` is not the same fact as a
   `friction_churn` present with `has_signal: false`.
3. **`LOGS/outcomes.jsonl`**: one JSON object per `(run_tag, batch_pr,
   issue)` grading event, append-only. The same `(run_tag, issue)` pair can
   appear more than once as its grade evolves (e.g. `pending` → `clean`).
   The *last* line for a given `(run_tag, issue)` pair wins. This matches
   the engine's own read convention. Build the outcome scorecard from the
   winning line per pair only.
4. **`LOGS/process-retrospective.md`**: read the whole file, but pull three
   things specifically:
   - The **Active Learnings** bullet list (for the stale/contradicted check
     in Step 6).
   - The **Deprecated Learnings** section (explicitly retired learnings).
   - The **Lane Prediction Accuracy** table (`| Date | Issues | Coverage |
     Precision |`). Read its rows verbatim, and don't recompute coverage or
     precision from raw data even if the inputs look derivable.

If any of the four sources is missing entirely (a fresh repo with no runs
yet), don't fail: report zero runs and skip straight to Step 7 with an
explicit "no runs recorded yet" surface.

## Step 4: Build one data model

Assemble a single in-memory structure, one row per selected run, before
producing any output. Each row carries:

- Identity: `run_tag`, derived date (Step 2), `batch_branch`, `batch_pr`,
  issue numbers involved.
- `completeness` verbatim, or `null` if the run's file predates that block.
- `friction_churn` verbatim (the whole `{friction, churn}` shape), or `null`.
- `rework_tax` verbatim, including its own `trusted` / `suppressed_reason`
  fields, or `null`.
- `gate_yield` verbatim, or `null`.
- `by_issue_shape` verbatim, or `null`.
- `tokens_by_model` / `tokens.by_model` (whichever the schema version has).
- The winning outcome-grade per issue in this run, from Step 3.3 (or `null`
  per issue if no grading event exists yet, since most current runs are
  entirely `pending`).
- `results[].handoff_notes` and `results[].timeline`, kept for Step 6's
  chronic-stage and agent-attribution passes.

Every downstream surface (Step 7's three outputs) reads from this one
structure. Don't re-derive any per-run number from raw fields once it's in
the model. If a value belongs in the model, it was reused verbatim from
Step 3, not recomputed.

## Step 5: Apply the volume gate

Set `MIN_RUNS = 5`. This is the default, and there's no profile field for
it. Name it plainly in the output so a human reading the highlights or
dashboard knows it's a fixed threshold, not a computed one.

1. Count `N` = number of runs in the Step 4 model (after the Step 2 window).
2. **`N < MIN_RUNS`**: this is the *below-threshold* path.
   - Do not render a trend line for anything.
   - Show per-run summaries instead: one block per run, its metrics as
     point values, not a series.
   - Attach the **issue-class heterogeneity caveat** explicitly: at low
     volume, runs mix wildly different issue shapes (a one-file doc fix next
     to a four-task schema feature), so a naive "run 3 was better than run 1"
     read is an artifact of which issues happened to land in which run, not
     a trend. Say this once, prominently, not as a footnote.
3. **`N >= MIN_RUNS`**: the *trend* path, but gate **per metric**, not
   globally, because a metric can have fewer trustworthy points than `N`:
   - A run contributes a point to a metric's trend only if that metric's
     block is present (Step 3.2) AND, where the block itself carries a trust
     flag (`rework_tax.trusted`, `completeness.trustworthy`), that flag is
     true. A `rework_tax` block present with `trusted: false` and a
     `suppressed_reason` contributes **no point** to the rework-tax trend.
     Show the suppression reason instead of estimating a value.
   - If a metric's trustworthy-point count is still below `MIN_RUNS` even
     though `N >= MIN_RUNS` overall, that metric individually falls back to
     the below-threshold treatment (per-run summary, no trend line) while
     other, better-covered metrics still get trend lines. Tag every rendered
     point with which run it came from and whether it was trustworthy.
4. **Lane precision is gated on its own**, independent of the JSONL-derived
   metrics above, because it comes from a hand-maintained markdown table
   (Step 3.4) that currently holds only a handful of rows. Apply the same
   `MIN_RUNS` threshold to the row count of the Lane Prediction Accuracy
   table itself. Below it, show the raw rows as-is with a one-line note that
   there isn't yet enough history for a trend read. Don't extrapolate.

## Step 6: Derive the seven analyses from the one model

Do this once. Both Step 7 surfaces render the same derived values.

1. **Outcome scorecard.** Bucket each `(run, issue)` winning grade from Step
   4: `clean` → held; `reverted` / `reopened` / `hotfix` → negative
   (break out by which); `closed_unmerged` / `abandoned` → a separate
   "never shipped" bucket; `pending` → not yet decided. Report the fraction
   held vs. negative **only over decided outcomes** (exclude pending from
   the denominator) and separately report how many are still pending. If
   every graded outcome in the window is `pending`, say exactly that: "N
   outcomes recorded, all still pending, no verdict yet." Don't print a 0%
   or 100% held rate that implies a verdict that doesn't exist.
2. **Trends or per-run summaries**, per Step 5, for: friction score,
   rework-tax fraction, gate-yield ratio, lane precision/coverage, and
   token cost. Every rendered point carries its run_tag and a completeness/
   trust tag (trustworthy, present-but-untrusted, or absent).
3. **Chronic bumpy stages / issue classes.** Using each run's own
   `friction_churn.friction.top_stages` / `top_issues` (already computed, so
   don't re-score anything), tally which stage names and issue shapes recur
   as top contributors across *multiple* runs. A stage that tops the list in
   one run is a data point. One that tops the list in three of five runs is
   chronic: call out the latter and cite the run_tags.
4. **Churn hotspots & re-fix chains.** Union `friction_churn.churn.hotspots`
   and `.refix_chains` across the window's runs verbatim (each run's own
   list, concatenated and deduplicated by file path or chain identity, not
   recomputed). A file or chain appearing in only one run is a hotspot for
   that run. One appearing across runs is worth flagging as recurring.
5. **Agent-attribution summary.** Aggregate `tokens_by_model` (or
   `tokens.by_model`) across the window's runs to show relative spend by
   model tier, and separately tally `handoff_notes` by their `[stage]`
   prefix (e.g. `[quality-fix]`, `[test-quality-fix]`, `[simplify]`) to show
   which pipeline stages are generating the most handoff volume. Both are
   straight sums over already-recorded per-run data.
6. **Stale / contradicted learnings.** Two sources, both from
   `process-retrospective.md`: (a) every entry already moved to the
   **Deprecated Learnings** section (list them), and (b) any **Active
   Learnings** bullet that contains its own internal "Superseded,"
   "Contradicted," "Fixed," or "Reconfirmed... not the...previously
   observed" language. These are learnings the file keeps active but has
   partially walked back inline rather than deprecating outright. Flag both
   kinds. Don't silently drop either.
7. **Ranked "what I'd change next."** A short (5-7 item) judgment list, each
   item citing the run_tag(s)/evidence backing it, ordered by how much
   evidence supports it. A chronic stage confirmed across most of the window
   outranks a one-off observation from a single run. This is the one
   analysis that's genuinely synthesized rather than aggregated. Still base
   every item on something visible in the Step 4 model or the retrospective,
   not on outside knowledge of the codebase.

## Step 7: Emit three surfaces from the one model

All three read the same Step 6 output. Produce them in this order.

### 7a. Inline highlights

Print directly in the conversation, in this order: outcome scorecard,
trend-or-summary block per metric (each tagged per Step 5), chronic
bumpy stages/issue classes, churn hotspots & re-fix chains, agent-attribution
summary, stale/contradicted learnings, ranked "what I'd change next." Keep
this readable as text. It's the fallback surface if nothing else below
works.

### 7b. Self-contained HTML Artifact

Load the **dataviz** skill before writing any chart markup, palette, or
layout. Do this every time, not just on first use in a session. Follow its
form heuristic and palette for whichever panels apply:

- Outcome scorecard as stat tiles (held / negative-by-kind / never-shipped /
  pending), with the "graceful all-pending" text state when nothing is
  decided yet.
- Either trend charts (above-gate metrics) or a per-run summary table
  (below-gate metrics), never both for the same metric, with every point's
  hover/label carrying its completeness/trust tag from Step 5.
- A chronic-stage/issue-class panel, a churn hotspots & re-fix chains list,
  an agent-attribution breakdown, and a stale-learnings callout.
- The ranked "what I'd change next" list, rendered last.

Publish it via the Artifact tool (favicon required: pick one that fits a
data/analytics artifact). If the Artifact tool isn't available in this
session, say so and move on to 7c. Don't treat it as a failure, and don't
attempt to hand-roll an equivalent HTML file some other way.

### 7c. Local dashboard.md fallback (this skill's only write)

Write the same Step 6 model, rendered as markdown, to
`<LOGS>/dashboard.md`. Overwrite it in place each run: this is a snapshot,
not a history log.

- This is the **only** file this skill writes. Every other step is
  read-only against the ledger.
- `<LOGS>` already sits under this repo's blanket `logs/` gitignore rule.
  **Do not edit `.gitignore`** to carve out an exception, and **do not**
  `git add -f` this file. It stays local and untracked, exactly like the
  ledger files it summarizes. See the FLAG FOR BATCH REVIEWER note at the
  top of this file. This is the one deliberate, called-out deviation from
  the issue's literal wording, and it's still open for the batch reviewer
  to veto.
- If `<LOGS>` doesn't exist yet (a repo with an empty ledger), create it
  before writing `dashboard.md`, but create nothing else there.

## Guardrails

- **Never recompute** friction, churn, rework tax, or gate yield. Every one
  of those is a Tier 2 reducer's precomputed output, stored per run. Read
  it verbatim in Step 3, carry it verbatim through Step 4. If a number this
  skill would need doesn't exist in the ledger, report it as missing, don't
  derive a substitute.
- **Never backfill a suppressed metric.** `rework_tax.trusted: false` with a
  `suppressed_reason` means the reducer itself decided the token data
  wasn't trustworthy enough to report a number. Showing an estimate anyway
  defeats the reason it suppressed in the first place. Surface the
  suppression reason as the answer.
- **Never glob the log directory broadly.** Read exactly `runs.jsonl`,
  `runs/<tag>.json` for tags present in the (windowed) `runs.jsonl`,
  `outcomes.jsonl`, and `process-retrospective.md`. Legacy `summary-*`
  files are out of scope by construction, not by exclusion filter.
- **Never hard-code an absolute ledger path.** Every read in Step 3 goes
  through the `LOGS` resolved in Step 1, for both this repo and any other
  onboarded target repo this skill might run against.
- **No engine-owned paths.** This skill never reads or writes
  `.claude/ticketmill.json`'s content beyond the single `logs_dir` lookup in
  Step 1, and never touches `.claude/agents/**`, `.claude/workflows/
  ticketmill.js`, or `.claude/scripts/ticketmill/**`.
