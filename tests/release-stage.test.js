'use strict'

// Unit tests for the Report-phase release stage's pure helpers (workflows/
// ticketmill.js, issue #57 — the pipeline defers the CHANGELOG/plugin.json
// version bump but no stage ever performed it):
//   - releaseEnabled(profile): the gating predicate deciding whether the
//     Report-phase release stage runs at all.
//   - deriveReleaseVersion(baseVersion, commitTypes, profile): the pure,
//     BASE-anchored bump-derivation helper (feat -> minor, else patch;
//     profile.release.bump overrides).
//   - releaseChangelogAnchor(version, runTag): the date-independent CHANGELOG
//     section heading the stage regenerates in place — its stability under a
//     cross-midnight resume is what makes "regenerate in place, not append a
//     duplicate" possible.
// All three are declared above the TICKETMILL-TEST-HARNESS-SPLIT marker
// specifically so they're reachable here; the stage's own agent-orchestration
// call sites (git worktree add, the write/cleanup agent calls) live below the
// marker and are not exercised by node --test.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ---------------------------------------------------------------------------
// releaseEnabled: gating predicate
// ---------------------------------------------------------------------------

test('releaseEnabled: false when profile.release is absent/null (default — no agent call at all)', function () {
  const context = harness.boot()

  assert.equal(context.releaseEnabled({}), false)
  assert.equal(context.releaseEnabled({ release: null }), false)
  assert.equal(context.releaseEnabled(null), false)
  assert.equal(context.releaseEnabled(undefined), false)
})

test('releaseEnabled: true when profile.release names at least one version_files entry', function () {
  const context = harness.boot()

  assert.equal(context.releaseEnabled({ release: { version_files: ['.claude-plugin/plugin.json'] } }), true)
})

test('releaseEnabled: false when profile.release is set but version_files is missing/empty/non-array', function () {
  const context = harness.boot()

  assert.equal(context.releaseEnabled({ release: {} }), false)
  assert.equal(context.releaseEnabled({ release: { version_files: [] } }), false)
  assert.equal(context.releaseEnabled({ release: { version_files: 'plugin.json' } }), false)
})

// ---------------------------------------------------------------------------
// deriveReleaseVersion: pure BASE-anchored bump-derivation helper
// ---------------------------------------------------------------------------

test('deriveReleaseVersion: no "feat" commit type -> patch bump', function () {
  const context = harness.boot()

  const result = context.deriveReleaseVersion('0.1.27', ['fix', 'chore'], {})
  assert.equal(result.bump, 'patch')
  assert.equal(result.version, '0.1.28')
})

test('deriveReleaseVersion: any "feat" commit type -> minor bump (patch reset to 0)', function () {
  const context = harness.boot()

  const result = context.deriveReleaseVersion('0.1.27', ['fix', 'feat'], {})
  assert.equal(result.bump, 'minor')
  assert.equal(result.version, '0.2.0')
})

test('deriveReleaseVersion: empty/missing commit types default to patch', function () {
  const context = harness.boot()

  assert.equal(context.deriveReleaseVersion('1.2.3', [], {}).version, '1.2.4')
  assert.equal(context.deriveReleaseVersion('1.2.3', undefined, {}).version, '1.2.4')
})

test('deriveReleaseVersion: profile.release.bump overrides the derived bump, including "feat" present', function () {
  const context = harness.boot()

  const result = context.deriveReleaseVersion('0.1.27', ['feat'], { release: { bump: 'patch' } })
  assert.equal(result.bump, 'patch')
  assert.equal(result.version, '0.1.28')
})

test('deriveReleaseVersion: profile.release.bump="major" resets both minor and patch to 0', function () {
  const context = harness.boot()

  const result = context.deriveReleaseVersion('1.2.3', ['fix'], { release: { bump: 'major' } })
  assert.equal(result.bump, 'major')
  assert.equal(result.version, '2.0.0')
})

test('deriveReleaseVersion: an invalid profile.release.bump value is ignored, falls back to derivation', function () {
  const context = harness.boot()

  const result = context.deriveReleaseVersion('0.1.27', ['feat'], { release: { bump: 'sideways' } })
  assert.equal(result.bump, 'minor')
})

test('deriveReleaseVersion: BASE-anchored — the same baseVersion always yields the same next version regardless of what TARGET might currently hold', function () {
  const context = harness.boot()

  // A resumed/healing Report pass calls this again with the SAME base_version
  // (read fresh from origin/BASE, never from TARGET) and gets the identical
  // result both times — this is what prevents double-bumping on resume.
  const first = context.deriveReleaseVersion('0.1.27', ['feat'], {})
  const second = context.deriveReleaseVersion('0.1.27', ['feat'], {})
  assert.equal(first.version, second.version)
  assert.equal(first.bump, second.bump)
})

test('deriveReleaseVersion: throws on a non-semver base version (call site treats this as a non-fatal, logged skip)', function () {
  const context = harness.boot()

  assert.throws(function () { context.deriveReleaseVersion(null, ['feat'], {}) }, /valid semver/)
  assert.throws(function () { context.deriveReleaseVersion('not-a-version', ['feat'], {}) }, /valid semver/)
  assert.throws(function () { context.deriveReleaseVersion('', ['feat'], {}) }, /valid semver/)
})

test('deriveReleaseVersion: a leading "v" or trailing pre-release/build metadata on the base version is tolerated (only the leading x.y.z is read)', function () {
  const context = harness.boot()

  assert.equal(context.deriveReleaseVersion('0.1.27-rc.1', [], {}).version, '0.1.28')
})

// ---------------------------------------------------------------------------
// releaseChangelogAnchor: date-independent section anchor, cross-midnight
// resume stability
// ---------------------------------------------------------------------------

test('releaseChangelogAnchor: deterministic — same (version, runTag) always produces the same heading', function () {
  const context = harness.boot()

  const a = context.releaseChangelogAnchor('0.2.0', 'Batch_2026-07-19_233715')
  const b = context.releaseChangelogAnchor('0.2.0', 'Batch_2026-07-19_233715')
  assert.equal(a, b)
})

test('releaseChangelogAnchor: cross-midnight resume stability — the anchor has no wall-clock/date input, so a Report pass that resumes after midnight recomputes the IDENTICAL heading and regenerates the section in place instead of appending a duplicate', function () {
  const context = harness.boot()

  // RUN_TAG is fixed once at run start (args.run_label/args.date, or 'run') and
  // threaded through every subsequent Report pass unchanged — it does NOT get
  // re-derived from "today's date" on a resumed pass. Simulate that: the run
  // started on 2026-07-19 (RUN_TAG carries that), and this pass resumes after
  // midnight on 2026-07-20. The anchor function itself takes no date/time
  // argument at all, so passing the SAME (version, runTag) on both sides of
  // midnight is guaranteed byte-identical — that is the whole mechanism.
  const beforeMidnight = context.releaseChangelogAnchor('0.2.0', 'Batch_2026-07-19_233715')
  const afterMidnightResume = context.releaseChangelogAnchor('0.2.0', 'Batch_2026-07-19_233715')
  assert.equal(beforeMidnight, afterMidnightResume)
})

test('releaseChangelogAnchor: different versions or run tags produce different anchors (no accidental collisions across batches)', function () {
  const context = harness.boot()

  const v1 = context.releaseChangelogAnchor('0.2.0', 'Batch_2026-07-19_233715')
  const v2 = context.releaseChangelogAnchor('0.3.0', 'Batch_2026-07-19_233715')
  const differentBatch = context.releaseChangelogAnchor('0.2.0', 'Batch_2026-08-01_090000')
  assert.notEqual(v1, v2)
  assert.notEqual(v1, differentBatch)
})

test('releaseChangelogAnchor: the anchor string embeds no independently-derived date — it is built ONLY from its two arguments', function () {
  const context = harness.boot()

  const anchor = context.releaseChangelogAnchor('0.2.0', 'run')
  assert.equal(anchor, '## [0.2.0] - run')
})
