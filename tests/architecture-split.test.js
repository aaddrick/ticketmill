'use strict'

// Gate for the docs/ARCHITECTURE.md -> docs/architecture/*.md split (issue #154).
//
// tests/fixtures/architecture-split.json is the shared manifest split.mjs
// (generate, task 2, scratchpad-only) and unsplit.mjs (reverse round-trip, a
// later task) both read. This file is the mechanical gate on that manifest:
// it proves the manifest's segments plus drops exactly cover the base
// commit's 1310 lines with no gap and no overlap, that every segment's
// `firstLine` locator is globally unique (so it can never latch onto the
// wrong occurrence), and that every segment's bounds are internally
// consistent.
//
// The base text is read from `fixture.baseCommit` via `git show`, NOT from
// the live docs/ARCHITECTURE.md -- task 2 reduces that path to a stub, so
// pinning to the base commit is what keeps this gate meaningful (and green)
// both before and after the split runs, rather than only during task 1's
// narrow pre-generation window.
//
// Deliberately NOT covered here (a later task, once sha256 is filled in): the
// true-inverse round-trip diff and the sha256 digests (the fixture's
// `sha256` field is intentionally `{}` until then).
//
// tests/fixtures/ is NOT auto-discovered by bare `node --test` (only
// tests/*.test.js is) -- this file is the actual test; the JSON is inert data.

const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'architecture-split.json')

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'))
}

// Base file lines, 1-indexed (baseLines[1] === line 1), read from the base
// commit the fixture itself names rather than the live working tree, since
// docs/ARCHITECTURE.md is reduced to a stub by the split this fixture drives.
function loadBaseLines() {
  const fixture = loadFixture()
  const raw = execFileSync('git', ['show', fixture.baseCommit + ':' + fixture.baseFile], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  const parts = raw.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  const lines = [undefined] // index 0 unused, lines are 1-indexed
  for (const p of parts) lines.push(p)
  return lines
}

// Flattens the fixture's per-output-file segments into one array of
// {firstLine, firstLineOutput, lines, lastLine, shift, file}, in the order
// the fixture lists output files and segments within each.
function allSegments(fixture) {
  const out = []
  for (const [file, entry] of Object.entries(fixture.outputs)) {
    for (const seg of entry.segments) out.push(Object.assign({ file: file }, seg))
  }
  return out
}

// Maps each base line's text to its first (1-indexed) occurrence line number.
function buildFirstLineIndex(baseLines) {
  const map = new Map()
  for (let i = 1; i < baseLines.length; i++) {
    if (!map.has(baseLines[i])) map.set(baseLines[i], i)
  }
  return map
}

// Shared by the rewrites and proseRefs gates: each {line, from} pair's `from`
// must appear exactly once, verbatim, on its own recorded base line.
function assertFromOccursOnceOnLine(baseLines, entries, label) {
  for (const r of entries) {
    const text = baseLines[r.line]
    assert.ok(text !== undefined, label + ' line ' + r.line + ' is out of bounds')
    const count = text.split(r.from).length - 1
    assert.strictEqual(count, 1,
      label + ' at line ' + r.line + ': from=' + JSON.stringify(r.from) + ' must appear exactly once, found ' + count)
  }
}

test('fixture is valid JSON with the required top-level shape', function () {
  const fixture = loadFixture()
  assert.strictEqual(fixture.baseFile, 'docs/ARCHITECTURE.md')
  assert.strictEqual(fixture.baseFileLines, 1310)
  for (const key of ['outputs', 'folds', 'rewrites', 'proseRefs', 'doNotTouch', 'drops',
    'reachabilityExempt', 'intentionallyAdded', 'intentionallyDuplicated', '_schema', 'sha256']) {
    assert.ok(Object.prototype.hasOwnProperty.call(fixture, key), 'fixture is missing top-level key: ' + key)
  }
})

test('gate: every split output file now exists on disk (task 2 has run)', function () {
  const fixture = loadFixture()
  for (const file of Object.keys(fixture.outputs)) {
    assert.strictEqual(fs.existsSync(path.join(ROOT, file)), true,
      file + ' is missing on disk; split.mjs must generate all ten docs/architecture/*.md files')
  }
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'docs', 'index.md')), true)
  // docs/ARCHITECTURE.md itself must now be the reduced stub, not the ~1300-line
  // monolith the base commit still carries.
  const stubSize = fs.statSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md')).size
  assert.strictEqual(stubSize < 30000, true,
    'docs/ARCHITECTURE.md still looks like the full monolith; task 2 must reduce it to a stub')
})

test('sha256 is intentionally empty until task 3', function () {
  const fixture = loadFixture()
  assert.deepStrictEqual(fixture.sha256, {})
})

test('coverage: segments plus drops exactly partition base lines 1-1310 (no gap, no overlap)', function () {
  const fixture = loadFixture()
  const segments = allSegments(fixture)

  // Build the [start, end] ranges for segments (from firstLine's line number,
  // resolved via the base file) and for drops (explicit start/end already).
  const baseLines = loadBaseLines()
  const firstLineNumber = buildFirstLineIndex(baseLines)

  const ranges = []
  for (const seg of segments) {
    const start = firstLineNumber.get(seg.firstLine)
    assert.ok(start !== undefined, seg.file + ': firstLine not found verbatim in base file: ' + JSON.stringify(seg.firstLine))
    const end = start + seg.lines - 1
    ranges.push({ start: start, end: end, source: seg.file + ' @ base line ' + start })
  }
  for (const drop of fixture.drops) {
    ranges.push({ start: drop.start, end: drop.end, source: 'drop @ base line ' + drop.start })
  }

  ranges.sort(function (a, b) { return a.start - b.start })

  // No overlap, no gap: each range must start exactly one past the previous one's end.
  let expectedNext = 1
  for (const r of ranges) {
    assert.strictEqual(r.start, expectedNext,
      'coverage gap or overlap before ' + r.source + ': expected next base line ' + expectedNext + ', got ' + r.start)
    assert.ok(r.end >= r.start, r.source + ': lines count must be >= 1')
    expectedNext = r.end + 1
  }
  assert.strictEqual(expectedNext - 1, fixture.baseFileLines,
    'coverage must reach exactly line ' + fixture.baseFileLines + ', last range ended at ' + (expectedNext - 1))

  // Exactly 14 segments (independently asserted, not just implied by the sum).
  assert.strictEqual(segments.length, 14)
})

test('global firstLine uniqueness: every segment locator matches exactly once in the base file', function () {
  const fixture = loadFixture()
  const segments = allSegments(fixture)
  const baseLines = loadBaseLines()

  for (const seg of segments) {
    let count = 0
    for (let i = 1; i < baseLines.length; i++) {
      if (baseLines[i] === seg.firstLine) count++
    }
    assert.strictEqual(count, 1,
      seg.file + ': firstLine ' + JSON.stringify(seg.firstLine) + ' must be globally unique in the base file, found ' + count + ' times')
  }
})

test('bounds: lastLine assertion holds (redundant check, never a locator) and ranges stay in [1, 1310]', function () {
  const fixture = loadFixture()
  const segments = allSegments(fixture)
  const baseLines = loadBaseLines()
  const firstLineNumber = buildFirstLineIndex(baseLines)

  for (const seg of segments) {
    assert.ok(Number.isInteger(seg.lines) && seg.lines >= 1, seg.file + ': lines must be a positive integer')
    const start = firstLineNumber.get(seg.firstLine)
    const end = start + seg.lines - 1
    assert.ok(start >= 1, seg.file + ': segment start below line 1')
    assert.ok(end <= fixture.baseFileLines, seg.file + ': segment end beyond line ' + fixture.baseFileLines)
    assert.strictEqual(baseLines[end], seg.lastLine,
      seg.file + ': lastLine assertion failed at base line ' + end + ' (lastLine is redundant, never a locator, but must still match)')
  }

  for (const drop of fixture.drops) {
    assert.ok(drop.start >= 1 && drop.end <= fixture.baseFileLines && drop.end >= drop.start,
      'drop range out of bounds: ' + JSON.stringify(drop))
    assert.strictEqual(drop.end - drop.start + 1, drop.lines.length,
      'drop lines payload length must match its own start/end range')
    for (let i = drop.start; i <= drop.end; i++) {
      assert.strictEqual(baseLines[i], drop.lines[i - drop.start],
        'drop payload must record the dropped base text verbatim at line ' + i)
    }
  }
})

test('rewrites: every {line, from} pair appears exactly once, verbatim, on its own base line', function () {
  const fixture = loadFixture()
  const baseLines = loadBaseLines()
  assert.strictEqual(fixture.rewrites.length, 13)
  assertFromOccursOnceOnLine(baseLines, fixture.rewrites, 'rewrite')
})

test('proseRefs: every {line, from} pair appears exactly once, verbatim, on its own base line', function () {
  const fixture = loadFixture()
  const baseLines = loadBaseLines()
  assert.strictEqual(fixture.proseRefs.length, 4)
  assertFromOccursOnceOnLine(baseLines, fixture.proseRefs, 'proseRef')
  for (const r of fixture.proseRefs) {
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'proseRef at line ' + r.line + ' must carry a reason')
  }
})

test('doNotTouch entries record the exact base text and are not among the rewrite/proseRef line numbers', function () {
  const fixture = loadFixture()
  const baseLines = loadBaseLines()
  const rewriteLines = new Set(fixture.rewrites.map(function (r) { return r.line }))
  const proseRefLines = new Set(fixture.proseRefs.map(function (r) { return r.line }))
  for (const d of fixture.doNotTouch) {
    assert.strictEqual(baseLines[d.line], d.text, 'doNotTouch line ' + d.line + ' text drifted from base file')
    assert.strictEqual(rewriteLines.has(d.line), false, 'doNotTouch line ' + d.line + ' must not also be a rewrite site')
    assert.strictEqual(proseRefLines.has(d.line), false, 'doNotTouch line ' + d.line + ' must not also be a proseRef site')
  }
})

test('reachabilityExempt lists a root and an exhaustiveness note alongside its exempt entries', function () {
  const fixture = loadFixture()
  assert.ok(typeof fixture.reachabilityExempt.root === 'string' && fixture.reachabilityExempt.root.includes('docs/index.md'))
  assert.ok(Array.isArray(fixture.reachabilityExempt.exempt) && fixture.reachabilityExempt.exempt.length === 2)
  for (const e of fixture.reachabilityExempt.exempt) {
    assert.ok(typeof e.path === 'string' && e.path.length > 0)
    assert.ok(typeof e.reason === 'string' && e.reason.length > 0)
  }
})

test('folds reference exactly the two lines named in the task (7 and 1290) and match the segment firstLineOutput', function () {
  const fixture = loadFixture()
  assert.strictEqual(fixture.folds.length, 2)
  const byLine = new Map(fixture.folds.map(function (f) { return [f.line, f] }))
  assert.ok(byLine.has(7) && byLine.get(7).from === '## Pipeline' && byLine.get(7).to === '# Pipeline')
  assert.ok(byLine.has(1290) && byLine.get(1290).from === '## Failure semantics' && byLine.get(1290).to === '# Failure semantics')

  const segments = allSegments(fixture)
  for (const f of fixture.folds) {
    const seg = segments.find(function (s) { return s.firstLine === f.from })
    assert.ok(seg, 'no segment starts at fold line ' + f.line)
    assert.strictEqual(seg.firstLineOutput, f.to)
  }
})
