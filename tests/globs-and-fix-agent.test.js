'use strict'

// Unit tests for the profile glob matcher (globToRe/matchesGlobs, used by
// runQualityLoop's simplify-scope check and the test loop's testGlobs check)
// and pickFixAgent (chooses a quality-review's recommended_fix_agent only if
// it's a known implementer, else falls back).

const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./harness')

// ---- globToRe / matchesGlobs ----

test('globToRe: "**" crosses directory boundaries', function () {
  const context = harness.boot()
  const re = context.globToRe('workflows/**')
  assert.ok(re.test('workflows/ticketmill.js'))
  assert.ok(re.test('workflows/sub/dir/file.js'))
  assert.ok(!re.test('scripts/setup-worktree.sh'))
})

test('globToRe: a single "*" does not cross a "/" segment boundary', function () {
  const context = harness.boot()
  const re = context.globToRe('*.md')
  assert.ok(re.test('CHANGELOG.md'))
  assert.ok(!re.test('docs/CHANGELOG.md'))
})

test('globToRe: "**/" plus a trailing "*" pattern matches nested and top-level files alike', function () {
  const context = harness.boot()
  const re = context.globToRe('tests/**/*.test.js')
  assert.ok(re.test('tests/sub/foo.test.js'))
  assert.ok(re.test('tests/foo.test.js'))
  assert.ok(!re.test('tests/foo.js'))
})

test('matchesGlobs: null/undefined globs matches everything (no scope restriction configured)', function () {
  const context = harness.boot()
  assert.strictEqual(context.matchesGlobs('anything/at/all.js', null), true)
  assert.strictEqual(context.matchesGlobs('anything/at/all.js', undefined), true)
})

test('matchesGlobs: an empty glob array matches nothing', function () {
  const context = harness.boot()
  assert.strictEqual(context.matchesGlobs('workflows/ticketmill.js', []), false)
})

test('matchesGlobs: matches if any glob in the list matches the file', function () {
  const context = harness.boot()
  assert.strictEqual(context.matchesGlobs('workflows/ticketmill.js', ['workflows/**', 'scripts/**']), true)
  assert.strictEqual(context.matchesGlobs('README.md', ['workflows/**', 'scripts/**']), false)
})

// ---- pickFixAgent ----

test('pickFixAgent: uses the recommended agent when it is a known implementer', function () {
  const context = harness.boot()
  context.__seed({ IMPLEMENTERS: ['alice', 'bob'], DEFAULT_IMPLEMENTER: 'alice' })
  assert.strictEqual(context.pickFixAgent('bob', null), 'bob')
})

test('pickFixAgent: falls back past an unknown recommended agent to the fallback, then DEFAULT_IMPLEMENTER', function () {
  const context = harness.boot()
  context.__seed({ IMPLEMENTERS: ['alice', 'bob'], DEFAULT_IMPLEMENTER: 'alice' })

  assert.strictEqual(context.pickFixAgent('carol', null), 'alice') // unknown, no fallback -> DEFAULT_IMPLEMENTER
  assert.strictEqual(context.pickFixAgent('carol', 'bob'), 'bob') // unknown, explicit fallback wins
  assert.strictEqual(context.pickFixAgent(null, 'bob'), 'bob') // no recommendation at all -> fallback
  assert.strictEqual(context.pickFixAgent(null, null), 'alice') // no recommendation, no fallback -> DEFAULT_IMPLEMENTER
})
