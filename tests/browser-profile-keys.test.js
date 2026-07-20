'use strict'

// Unit tests for the profile.browser configurability added for issue #39:
// bwLock(), bwPort(), and bwArtifactDir() each late-bind against the module-level
// `BROWSER` let (workflows/ticketmill.js), falling back to the historical
// hardcoded values when profile.browser is unset (BROWSER === null) or a given
// key is omitted. bwAcquire() also substitutes profile.browser.stale_seconds /
// poll_seconds into the generated lock-wait shell snippet, and bwRelease() (like
// bwAcquire) calls bwLock() rather than the old BW_LOCK constant, so it too must
// pick up a configured lock_path.
//
// All four functions are declared above the TICKETMILL-TEST-HARNESS-SPLIT marker,
// so they're reachable via harness.boot(). BROWSER itself is only assigned from
// PROFILE at Select time (below the split marker), so tests reach it directly —
// `readGlobal(context, 'BROWSER = {...}')` — the same way __seed() repopulates
// other Select-populated lets, since BROWSER has no __seed() entry of its own.

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

test('bwLock: defaults to /tmp/ticketmill-browser-lock when profile.browser is unset', function () {
  const context = harness.boot()
  assert.strictEqual(context.bwLock(), '/tmp/ticketmill-browser-lock')
})

test('bwLock: uses profile.browser.lock_path when set', function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { serve_command: 'x', lock_path: '/mnt/shared/ticketmill-browser-lock' }")
  assert.strictEqual(context.bwLock(), '/mnt/shared/ticketmill-browser-lock')
})

test('bwPort: defaults to port_base 8100 and port_span 900 when profile.browser is unset', function () {
  const context = harness.boot()
  assert.strictEqual(context.bwPort(7), 8100 + (7 % 900))
  assert.strictEqual(context.bwPort(950), 8100 + (950 % 900))
})

test('bwPort: uses profile.browser.port_base and port_span when set', function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { serve_command: 'x', port_base: 3000, port_span: 100 }")
  assert.strictEqual(context.bwPort(7), 3000 + (7 % 100))
  assert.strictEqual(context.bwPort(142), 3000 + (142 % 100))
})

test('bwArtifactDir: defaults to /tmp/ticketmill-issue-<n> when profile.browser is unset', function () {
  const context = harness.boot()
  assert.strictEqual(context.bwArtifactDir(39), '/tmp/ticketmill-issue-39')
})

test('bwArtifactDir: uses profile.browser.artifact_dir template ({issue} placeholder) when set', function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { serve_command: 'x', artifact_dir: '/data/ticketmill/{issue}/artifacts' }")
  assert.strictEqual(context.bwArtifactDir(39), '/data/ticketmill/39/artifacts')
})

test('bwArtifactDir: appends -<issue> when profile.browser.artifact_dir has no {issue} placeholder', function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { serve_command: 'x', artifact_dir: '/data/ticketmill-artifacts' }")
  assert.strictEqual(context.bwArtifactDir(39), '/data/ticketmill-artifacts-39')
})

test('bwAcquire: default command string carries the hardcoded stale/poll seconds (1800/15) when profile.browser is unset', function () {
  const context = harness.boot()
  const cmd = context.bwAcquire('issue-39')
  assert.ok(cmd.includes('/tmp/ticketmill-browser-lock'))
  assert.ok(cmd.includes('-gt 1800 '))
  assert.ok(cmd.includes('sleep 15'))
})

test('bwAcquire: command string carries configured stale_seconds/poll_seconds', function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { serve_command: 'x', stale_seconds: 600, poll_seconds: 5 }")
  const cmd = context.bwAcquire('issue-39')
  assert.ok(cmd.includes('-gt 600 '))
  assert.ok(cmd.includes('sleep 5'))
  assert.ok(!cmd.includes('-gt 1800 '))
  assert.ok(!cmd.includes('sleep 15'))
})

test('bwRelease: default command string targets /tmp/ticketmill-browser-lock when profile.browser is unset', function () {
  const context = harness.boot()
  const cmd = context.bwRelease('issue-39')
  assert.ok(cmd.includes('/tmp/ticketmill-browser-lock/owner'))
  assert.ok(cmd.includes('rm -rf /tmp/ticketmill-browser-lock'))
})

test('bwRelease: command string targets profile.browser.lock_path when set', function () {
  const context = harness.boot()
  harness.readGlobal(context, "BROWSER = { serve_command: 'x', lock_path: '/mnt/shared/ticketmill-browser-lock' }")
  const cmd = context.bwRelease('issue-39')
  assert.ok(cmd.includes('/mnt/shared/ticketmill-browser-lock/owner'))
  assert.ok(cmd.includes('rm -rf /mnt/shared/ticketmill-browser-lock'))
  assert.ok(!cmd.includes('/tmp/ticketmill-browser-lock'))
})
