'use strict'

// Completeness gate for the README -> docs/ topic-file extraction (issue #154,
// originating from member issue #155). This is the task-1 census machinery
// (tests/architecture-split.test.js's coverage/uniqueness style) run a second
// time against a different move: instead of proving docs/ARCHITECTURE.md's
// 1310 lines are exactly partitioned, it proves README.md's own 15 H2
// sections (as they stood at commit ac612eb, the batch base before this
// extraction) each still exist exactly once across README.md plus docs/*.md,
// with Install and Quickstart explicitly allow-listed to appear twice (the
// condensed happy path stays in README, the full section moves verbatim into
// docs/getting-started.md).
//
// The canonical heading list is read from
// tests/fixtures/readme-base-headings.json, a committed, byte-checked copy
// of README.md's 15 base H2 headings at that commit -- NOT re-derived from
// git history at test time. A shallow CI checkout (actions/checkout@v4's
// default fetch-depth: 1) does not have that commit's blob, and the
// eventual squash-merge rewrites history anyway, so pinning to a committed
// fixture is what keeps this gate meaningful and runnable everywhere,
// forever, the same discipline tests/architecture-provenance.test.js
// already uses for its own GIT-FREE reconstruction.

const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const HEADINGS_FIXTURE_FILE = path.join(__dirname, 'fixtures', 'readme-base-headings.json')

// Only Install and Quickstart are allowed to appear in both README.md (as a
// condensed happy path) and docs/getting-started.md (verbatim, in full).
// Every other one of the 15 base H2s must land in exactly one place after
// the extraction: README.md if it stayed a front-door section, or exactly
// one docs/*.md file if it moved.
const ALLOWED_DUPLICATES = new Set(['Install', 'Quickstart'])

// A single-section file that moves whole (Troubleshooting, How agents work,
// Profile reference) gets its own H2 folded up into that file's H1, the same
// "## X" -> "# X" fold tests/fixtures/architecture-split.json's `folds`
// documents for the architecture split -- the heading TEXT is unchanged,
// only the level. So this census matches on heading text with its leading
// `#`s stripped, not on an exact "## " prefix.
function headingText(line) {
  const m = line.match(/^(#{1,6})\s+(.*)$/)
  return m ? m[2] : null
}

function readBaseReadmeHeadings() {
  const fixture = JSON.parse(fs.readFileSync(HEADINGS_FIXTURE_FILE, 'utf8'))
  assert.ok(Array.isArray(fixture.headings) && fixture.headings.length > 0,
    'tests/fixtures/readme-base-headings.json must carry a non-empty headings array')
  return fixture.headings
}

function docsTopLevelMdFiles() {
  const raw = execFileSync('git', ['ls-files', 'docs'], { cwd: ROOT, encoding: 'utf8' })
  return raw.split('\n').filter(function (f) {
    // docs/*.md only -- direct children of docs/, not docs/architecture/**
    // or docs/diagrams/** (those are a different split with their own H2s,
    // not this extraction's destination set).
    return /^docs\/[^/]+\.md$/.test(f)
  })
}

function countHeadingOccurrences(heading, files) {
  let count = 0
  const locations = []
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const line of text.split('\n')) {
      if (headingText(line) === heading) {
        count++
        locations.push(file)
      }
    }
  }
  return { count: count, locations: locations }
}

test('base README.md at ac612eb has exactly 15 H2 sections', function () {
  const headings = readBaseReadmeHeadings()
  assert.strictEqual(headings.length, 15, 'base heading count drifted from the 15 this census assumes: ' + headings.join(', '))
})

test('every base README H2 appears exactly once across README.md + docs/*.md, except the allow-listed Install/Quickstart duplication', function () {
  const headings = readBaseReadmeHeadings()
  const files = ['README.md'].concat(docsTopLevelMdFiles())
  assert.ok(files.includes('docs/getting-started.md'), 'docs/getting-started.md must exist for this census to be meaningful')

  const failures = []
  for (const heading of headings) {
    const expected = ALLOWED_DUPLICATES.has(heading) ? 2 : 1
    const result = countHeadingOccurrences(heading, files)
    if (result.count !== expected) {
      failures.push(heading + ': expected ' + expected + ' occurrence(s), found ' + result.count + ' (' + result.locations.join(', ') + ')')
    }
  }
  assert.deepStrictEqual(failures, [], 'README H2 census mismatch:\n' + failures.join('\n'))
})

test('Install and Quickstart, the only allow-listed duplicates, land in README.md and docs/getting-started.md specifically', function () {
  const readmeHeadings = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('\n').map(headingText)
  const gettingStartedHeadings = fs.readFileSync(path.join(ROOT, 'docs', 'getting-started.md'), 'utf8').split('\n').map(headingText)
  for (const heading of ALLOWED_DUPLICATES) {
    assert.ok(readmeHeadings.includes(heading), heading + ' must still appear in README.md')
    assert.ok(gettingStartedHeadings.includes(heading), heading + ' must appear verbatim in docs/getting-started.md')
  }
})
