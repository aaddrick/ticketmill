# Running a batch

Where a live run narrates itself, what happens to the work it deliberately
left undone, and what to do when a run dies partway through.

## Watching a run

The run narrates itself in the places you already look:

- **The issue trail.** Every stage posts a comment as it happens, and every
  review/fix loop iteration posts its own, so the trail shows each round of a
  negotiation rather than one "implemented" note at the end. A halt posts the
  failed stage plus resume instructions. Each comment carries an
  `<!-- ticketmill owner/repo#N -->` marker naming the issue it belongs to.
- **The PRs.** The per-issue PR collects the spec and code review rounds. The
  batch PR carries the Verification Gaps section: every check that did not run,
  in front of the human who is about to merge.
- **The logs dir** (`logs_dir`, default `logs/ticketmill`). Each run writes
  `runs/<run_label>.json` (the machine-readable record: per-issue metrics, tokens,
  and timelines, written deterministically by the mill skill so nothing is truncated)
  and appends one line to `runs.jsonl` (the cross-run ledger). It also writes
  `summary-<run_label>.md` (the human version) and appends to the running
  `process-retrospective.md`. A read-only pass also back-annotates prior runs'
  merged PRs with what actually happened to them (reverted, reopened, hotfixed, or
  held up cleanly) and appends the result to `outcomes.jsonl`, so self-improvement
  has an outcome signal alongside the process-friction one.
- **Live.** While a run is going, `/workflows` in Claude Code shows the progress
  tree: which issues are in flight and which stage each one is in.

## Follow-up issues

Besides comments and labels, the engine writes one more thing to your tracker:
at each successful squash-merge, it files new issues for work the run saw and
deliberately did not do.

- Two sources feed them. The merge stage scans the PR and issue trails for
  deferred-work phrases ("follow-up", "out of scope but", "technical debt",
  "future improvement", "consider adding"). It also drains a ledger the
  pipeline carries: reviewer suggestions that passed review without being
  required, tasks that failed review and were left incomplete, and reviews
  skipped because a reviewer died.
- Each distinct actionable item becomes one issue that references the source PR
  and issue, labeled bug, enhancement, or tech-debt. The merge agent checks for
  existing duplicates first, so a resumed run does not re-file.
- Only merged issues file follow-ups. A failed or halted issue gets a halt
  comment instead, and the deferred work stays visible in its trail.
- Created issue numbers come back in the per-issue results, so the run report
  lists what got filed.

## Resuming an interrupted run

Runs die for boring reasons: the laptop loses power, the session hits a usage
limit, the API has an outage. The engine treats all of them as expected weather.

- **Session still alive.** Resume in place with
  `Workflow({ scriptPath, resumeFromRunId: "wf_..." })`. The journal replays
  every completed stage from cache and picks up at the first unfinished one.
- **Session gone** (power loss, restart, new machine). Re-run with the same args
  plus `batch_branch: "Batch_<timestamp>"` from the dead run. The preflight
  probe reads live GitHub and git state and routes each issue: merged or closed
  skips, an open per-issue PR goes straight to review and merge, and a partial
  branch keeps implementing. Worktree setup is idempotent, and both the planner
  and every implement prompt check existing commits before adding work.
- **Lost the batch branch name with the session?** It survives in three places:
  on the remote (`git branch -r` lists `Batch_<timestamp>`, pushed at run
  start), in the run report under the logs dir if the run got that far, and in
  the `## Ticketmill Claimed` comment on any issue the run claimed.
- **Usage limits trip a breaker on purpose.** Three consecutive agent deaths is
  the signature of a limit or an outage, so the run stops launching issues and
  writes a resume plan instead of failing the batch one issue at a time.
- **Your own interruption never blocks you.** A resumed run on the same batch
  branch recognizes the dead run's claims as its own and continues; other
  maintainers' runs see them as foreign until the 12-hour staleness window
  clears them.
- **Every halted issue tells you where it stopped.** The halt comment names the
  failed stage and repeats the resume instructions.
