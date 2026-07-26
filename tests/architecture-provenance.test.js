'use strict'

// Durable provenance proof for the docs/ARCHITECTURE.md -> docs/architecture/*.md
// split (issue #154). GIT-FREE, unlike tests/architecture-split.test.js: it
// never shells out to git and never reads any base-commit blob. It reads only
// the committed docs/architecture/*.md files plus tests/fixtures/architecture-split.json,
// so it stays meaningful forever, long after `ac612eb` stops being a
// reachable ancestor of anything.
//
// It proves two things, both against digests baked into the fixture's
// `sha256` field:
//
//  1. Per output file: locate each of that file's segments by an exact
//     whole-line search for `firstLineOutput`, take `lines` lines from
//     there, re-promote headings (reverse the shift, or restore the literal
//     fold text on a fold's own first line), join that file's own segments
//     back together, and hash the result. A mismatch here means the moved
//     prose in THAT file was hand-edited after the split -- the file's
//     freely-editable lede/title/file-map are never included in this hash,
//     only the segments the fixture tracks.
//
//  2. The whole document: place every file's reversed segments plus the two
//     dropped lines at their fixed position in the base document's own
//     SOURCE order (a hardcoded structural fact about the frozen base
//     commit, verified once, non-committed, against
//     `git show ac612eb07f68d57e8f43a312cc76275064930bde:docs/ARCHITECTURE.md`
//     with an empty diff before being baked into the fixture), reverse the
//     13 diagram-link rewrites and 4 proseRefs, and hash the resulting
//     1310-line text. A mismatch here means something changed anywhere in
//     the moved prose, the rewrites, or the proseRefs.
//
// A red run here means moved prose (or a rewrite/proseRef) was edited after
// the split landed. The fix is to revert that edit and open a follow-up
// issue for the wording change, not to update this test's expectations.

const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname, '..')
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'architecture-split.json')

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'))
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

// The base document's own line order, as a fixed structural fact about the
// frozen base commit (ac612eb07f68d57e8f43a312cc76275064930bde). This is NOT
// re-derived from git at test time -- that is exactly what makes this test
// GIT-FREE. It was established once by resolving every segment's `firstLine`
// against `git show <baseCommit>:docs/ARCHITECTURE.md` (a one-time,
// non-committed proof; see the sha256._schema note in the fixture) and is
// simply the ascending order of the resulting base line numbers:
//   1 index.md#0, 7 pipeline.md#0, 95-96 drop, 97 agents-and-models.md#0,
//   112 profile-and-environment.md#0, 136 invocation-and-guardrails.md#0,
//   179 branching-and-merge.md#0, 359 metrics.md#0,
//   688 invocation-and-guardrails.md#1, 768 failure-semantics.md#1,
//   786 branching-and-merge.md#1, 835 agents-and-models.md#1,
//   867 cost-and-tokens.md#0, 1095 scheduling.md#0, 1290 failure-semantics.md#0
const SOURCE_ORDER = [
  { file: 'docs/architecture/index.md', segmentIndex: 0 },
  { file: 'docs/architecture/pipeline.md', segmentIndex: 0 },
  { drop: [95, 96] },
  { file: 'docs/architecture/agents-and-models.md', segmentIndex: 0 },
  { file: 'docs/architecture/profile-and-environment.md', segmentIndex: 0 },
  { file: 'docs/architecture/invocation-and-guardrails.md', segmentIndex: 0 },
  { file: 'docs/architecture/branching-and-merge.md', segmentIndex: 0 },
  { file: 'docs/architecture/metrics.md', segmentIndex: 0 },
  { file: 'docs/architecture/invocation-and-guardrails.md', segmentIndex: 1 },
  { file: 'docs/architecture/failure-semantics.md', segmentIndex: 1 },
  { file: 'docs/architecture/branching-and-merge.md', segmentIndex: 1 },
  { file: 'docs/architecture/agents-and-models.md', segmentIndex: 1 },
  { file: 'docs/architecture/cost-and-tokens.md', segmentIndex: 0 },
  { file: 'docs/architecture/scheduling.md', segmentIndex: 0 },
  { file: 'docs/architecture/failure-semantics.md', segmentIndex: 0 }
]

// Reads `outputPath` off disk (git-free), locates `seg` within it by an
// exact whole-line search for `firstLineOutput`, takes `seg.lines` lines from
// there, and reverses the heading shift (or the fold, on a fold's own first
// line). Returns the reversed line array -- this is what that segment's text
// looked like in the base document, before the split.
function reverseSegment(outputPath, seg, foldFromByTo) {
  const abs = path.join(ROOT, outputPath)
  const raw = fs.readFileSync(abs, 'utf8')
  const fileLines = raw.split('\n')
  if (fileLines[fileLines.length - 1] === '') fileLines.pop()

  const hits = []
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i] === seg.firstLineOutput) hits.push(i)
  }
  assert.strictEqual(hits.length, 1,
    outputPath + ': firstLineOutput ' + JSON.stringify(seg.firstLineOutput) + ' matched ' + hits.length + ' lines (expected exactly 1)')

  const startIdx = hits[0]
  const endIdx = startIdx + seg.lines - 1
  // writeLines() (the generator, scratchpad-only) strips ALL trailing blank
  // lines from a file at write time, so a segment whose own last line is
  // blank and which happens to be the last thing written to its file loses
  // that blank on disk. Pad back in blank lines and pin the final line to
  // the fixture's recorded `lastLine` rather than treating this as an
  // overrun -- `lastLine` is the redundant-but-authoritative record of what
  // that line actually was.
  while (fileLines.length <= endIdx) fileLines.push('')
  const segLines = fileLines.slice(startIdx, endIdx + 1)
  if (segLines[segLines.length - 1] !== seg.lastLine) segLines[segLines.length - 1] = seg.lastLine

  const isFold = foldFromByTo.has(segLines[0]) && segLines[0] === seg.firstLineOutput
  for (let i = 0; i < segLines.length; i++) {
    if (i === 0 && isFold) continue
    if (seg.shift === 0) continue
    const m = /^(#{1,6})(\s.*)$/.exec(segLines[i])
    if (!m) continue
    const restoredHashes = m[1].length - seg.shift
    assert.ok(restoredHashes >= 1, outputPath + ': heading restore underflow within a reversed segment')
    segLines[i] = '#'.repeat(restoredHashes) + m[2]
  }
  if (isFold) segLines[0] = foldFromByTo.get(segLines[0])

  return segLines
}

test('per-file provenance: each output file\'s own segments, reversed, hash to the recorded digest', function () {
  const fixture = loadFixture()
  const foldFromByTo = new Map(fixture.folds.map(function (f) { return [f.to, f.from] }))

  for (const [outputPath, spec] of Object.entries(fixture.outputs)) {
    const expected = fixture.sha256[outputPath]
    assert.strictEqual(typeof expected, 'string', 'fixture.sha256 is missing an entry for ' + outputPath)

    const joined = []
    for (const seg of spec.segments) {
      const block = reverseSegment(outputPath, seg, foldFromByTo)
      if (joined.length) joined.push('')
      joined.push(...block)
    }
    const actual = sha256(joined.join('\n') + '\n')
    assert.strictEqual(actual, expected,
      outputPath + ': reversed-segment digest drifted from tests/fixtures/architecture-split.json. ' +
      'This means the moved prose in this file was hand-edited after the split; revert the edit and ' +
      'open a follow-up issue for the wording change instead of updating this digest.')
  }
})

test('whole-document provenance: every segment plus both dropped lines, reassembled in source order, hash to the recorded digest', function () {
  const fixture = loadFixture()
  const foldFromByTo = new Map(fixture.folds.map(function (f) { return [f.to, f.from] }))

  assert.strictEqual(SOURCE_ORDER.length, 15, 'SOURCE_ORDER must carry exactly 14 segments + 1 drop')
  const segmentEntries = SOURCE_ORDER.filter(function (e) { return !e.drop })
  assert.strictEqual(segmentEntries.length, 14)
  const dropEntries = SOURCE_ORDER.filter(function (e) { return e.drop })
  assert.strictEqual(dropEntries.length, 1)

  let working = []
  for (const entry of SOURCE_ORDER) {
    if (entry.drop) {
      const drop = fixture.drops.find(function (d) { return d.start === entry.drop[0] && d.end === entry.drop[1] })
      assert.ok(drop, 'SOURCE_ORDER references a drop range not present in the fixture: ' + JSON.stringify(entry.drop))
      working.push(...drop.lines)
    } else {
      const spec = fixture.outputs[entry.file]
      assert.ok(spec, 'SOURCE_ORDER references an unknown output file: ' + entry.file)
      const seg = spec.segments[entry.segmentIndex]
      assert.ok(seg, 'SOURCE_ORDER references an out-of-range segment index for ' + entry.file)
      working.push(...reverseSegment(entry.file, seg, foldFromByTo))
    }
  }

  for (const rewrite of fixture.rewrites) {
    const text = working[rewrite.line - 1]
    const idx = text.indexOf(rewrite.to)
    assert.ok(idx !== -1, 'reverse-rewrite at line ' + rewrite.line + ': ' + JSON.stringify(rewrite.to) + ' not found in reconstructed text')
    working[rewrite.line - 1] = text.slice(0, idx) + rewrite.from + text.slice(idx + rewrite.to.length)
  }
  for (const proseRef of fixture.proseRefs) {
    const text = working[proseRef.line - 1]
    const idx = text.indexOf(proseRef.to)
    assert.ok(idx !== -1, 'reverse-proseRef at line ' + proseRef.line + ': ' + JSON.stringify(proseRef.to) + ' not found in reconstructed text')
    working[proseRef.line - 1] = text.slice(0, idx) + proseRef.from + text.slice(idx + proseRef.to.length)
  }

  assert.strictEqual(working.length, fixture.baseFileLines,
    'reconstructed line count ' + working.length + ' != fixture.baseFileLines ' + fixture.baseFileLines)

  const actual = sha256(working.join('\n') + '\n')
  assert.strictEqual(actual, fixture.sha256.reconstructed,
    'whole-document reconstruction drifted from tests/fixtures/architecture-split.json\'s sha256.reconstructed. ' +
    'This means moved prose, a rewrite, or a proseRef was hand-edited after the split; revert the edit and ' +
    'open a follow-up issue for the wording change instead of updating this digest.')
})
