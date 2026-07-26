# Run options and overlapping batches

Every knob the `mill` skill can turn on a run, and how two maintainers can
start batches on the same repo without colliding.

## Run options

Every run is a `Workflow` call with an `args` object. The `mill` skill assembles
it from your request; these are the knobs it can turn:

| Arg | Meaning |
|---|---|
| `branch` | Required. The base branch the final batch PR targets (e.g. `dev`, `main`) |
| `issues` | Explicit issue numbers, e.g. `[701, 702]`. Provide this or `labels` |
| `labels` | Select issues by label instead of by number |
| `limit` | Cap for label selection (default 50) |
| `state` | Issue state for label selection (default `open`) |
| `no_assignee` | With `labels`: select only issues nobody is assigned to |
| `concurrency` | Issue pipelines running in parallel: 1-5, default 2 |
| `dry_run` | Read-only preview: probes every issue and reports the routing plan |
| `run_label` (alias `date`) | Tag for claims and report filenames. Pass today's date so reports don't collide |
| `batch_branch` | Resume a prior run by reusing its `Batch_<timestamp>` branch |
| `token_budget` | Halt the run BEFORE it overspends: an absolute OUTPUT-token count, or a relative `"Nx"` / `{multiple_of_median}` form. Run arg wins over the profile field of the same name (see the `mill` skill's `token_budget` section) |
| `root`, `repo` | Auto-discovered from git and gh; pass explicitly if the bootstrap probe fails |

`concurrency` is parallelism across issues within one run: each pipeline gets
its own worktree (and its own port when browser verification is on), and browser
stages serialize through a shared lock at any setting. For coordination across
runs on different machines, see Overlapping batches below.

If you state the same options every time, put them in a skill: a small project
skill that invokes `/ticketmill:mill` with your standing preferences (say,
always `no_assignee`, concurrency 3, and your team's label conventions) turns a
paragraph of instructions into one command.

## Overlapping batches

Two maintainers can start batches on different machines with overlapping issue
lists. Claims keep them from colliding:

- Before any work starts, a run claims every issue it selected: a claim label
  plus a `## Ticketmill Claimed` comment recording the batch branch, run tag,
  host, and start time.
- A run that finds a fresh foreign claim (under 12 hours old) on an issue skips
  it and processes the rest of its batch. When two runs start at the same
  moment, both post and then re-read: the earlier claim wins.
- Claims from your own batch branch count as yours. That is what lets a resumed
  run pick its issues back up instead of skipping them.
- Claims release when an issue merges or halts, plus a sweep at report time. A
  run that dies without releasing is covered by the 12-hour staleness window.
- Claims are advisory and fail open: if the claim step itself dies, the run
  proceeds. The worst case is two runs implementing the same issue in their own
  batch branches, and the humans reviewing those two batch PRs resolve it.
  Neither run writes to your base branch either way.
