# Troubleshooting

- **"Workflow tool unavailable" hard-stop.** The `mill` skill refuses to fake the
  pipeline inline. See [Requirements](getting-started.md#requirements) above for why an imitation run isn't safe.
  Fix: enable the `Workflow` tool in Claude Code, then retry.
- **Bootstrap probe failed.** The engine couldn't auto-discover your repo root or
  `owner/name` slug from git/gh. Fix: pass `root` and `repo` explicitly, per the
  [Run options](run-options.md#run-options) table above.
- **Doctor pass fails during `mill-init`.** Your install commands or test suite
  don't run cleanly in a scratch worktree, so `mill-init` refuses to write a
  profile. Fix: get the toolchain working locally first, then re-run
  `mill-init`. See [Quickstart](getting-started.md#quickstart) above.
- **Lost the batch branch name.** It survives in three places: `git branch -r`
  (pushed at run start), the run report under the logs dir, and the
  `## Ticketmill Claimed` comment on any issue the run claimed. See
  [Resuming an interrupted run](running-a-batch.md#resuming-an-interrupted-run) above.
- **Stale browser lock after a hard kill.** A run that dies mid-browser-stage can
  leave the host-global lock at `/tmp/ticketmill-browser-lock` held. You usually
  don't need to do anything: the next run's poll steals it once it clears the
  30-minute default (`stale_seconds`). Delete the lock file by hand if you want
  it cleared sooner. Both the path and the staleness window are configurable via
  `profile.browser.lock_path` and `profile.browser.stale_seconds`.
- **A run skips your issue with no error.** Another batch claimed it less than
  12 hours ago. Either wait out the staleness window and re-run, or read the
  `## Ticketmill Claimed` comment on the issue to find the owning run's batch
  branch and host.
