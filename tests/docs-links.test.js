'use strict'

// Gate for docs cross-linking (issue #154, task 5).
//
// Four independent checks over the repo's tracked markdown files:
//
//  1. Relative-link resolution: every relative markdown link and every
//     <picture> src/srcset attribute in every tracked .md file resolves to
//     a real file on disk.
//  2. Two-hop reachability: every tracked docs/*.md file sits within two
//     hops of docs/index.md, except a small, explicitly named exemption
//     list.
//  3. Exhaustiveness: that exemption list is hardcoded here (4 entries,
//     each with its own inline reason) and cross-checked against
//     tests/fixtures/architecture-split.json's reachabilityExempt, so the
//     carve-out cannot quietly grow in one place without the other
//     noticing.
//  4. Freeze-pair parity: any tracked <dir>/AGENTS.md with a sibling
//     CLAUDE.md in the same directory is byte-identical to it. This is
//     general (scans every tracked AGENTS.md, not a hardcoded pair list),
//     so it covers docs/diagrams and docs/architecture today and any
//     future pair without editing this file -- replacing the one-shot
//     `diff -q docs/diagrams/AGENTS.md docs/diagrams/CLAUDE.md` check.

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

function trackedMarkdownFiles() {
  const raw = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  return raw.split('\n').filter(function (f) { return /\.md$/.test(f) })
}

// Strips fenced code blocks (``` or ~~~) before link extraction. Without
// this, docs/diagrams/AGENTS.md's own illustrative snippets -- a literal
// <picture> example with placeholder paths like "diagrams/NAME-dark.svg",
// and a bash heredoc referencing "file://$PWD/phase-plan-light.svg" -- would
// be mistaken for real links this file expects to resolve on disk.
function stripFencedCodeBlocks(text) {
  const lines = text.split('\n')
  const out = []
  let inFence = false
  let fenceChar = null
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})/)
    if (m) {
      if (!inFence) {
        inFence = true
        fenceChar = m[1][0]
      } else if (m[1][0] === fenceChar) {
        inFence = false
        fenceChar = null
      }
      out.push('')
      continue
    }
    out.push(inFence ? '' : line)
  }
  return out.join('\n')
}

const ABSOLUTE_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function stripFragmentAndQuery(target) {
  return target.split('#')[0].split('?')[0]
}

// Pulls every link target out of one file's (already fence-stripped) text:
// markdown [text](target) / ![alt](target) links, and HTML src="..." /
// srcset="..." attributes (the <picture> blocks docs/architecture/pipeline.md
// uses for the diagram pairs). Returns raw target strings, unfiltered.
function extractLinkTargets(text) {
  const targets = []
  const linkRe = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let m
  while ((m = linkRe.exec(text))) targets.push(m[1])

  const attrRe = /\b(?:src|srcset)="([^"]+)"/g
  while ((m = attrRe.exec(text))) {
    // srcset may be a comma-separated list of "url descriptor" pairs; none
    // of this repo's srcsets carry a descriptor, but handle it anyway.
    for (const part of m[1].split(',')) {
      const token = part.trim().split(/\s+/)[0]
      if (token) targets.push(token)
    }
  }
  return targets
}

// Resolves every real (non-absolute-URL, non-fragment-only) relative target
// found in `file` (a repo-relative path) against that file's own directory.
// Returns [{ raw, resolved }], `resolved` an absolute filesystem path.
function resolvedRelativeTargets(file) {
  const abs = path.join(ROOT, file)
  const text = stripFencedCodeBlocks(fs.readFileSync(abs, 'utf8'))
  const out = []
  for (const raw of extractLinkTargets(text)) {
    if (raw.startsWith('#')) continue
    if (ABSOLUTE_SCHEME_RE.test(raw)) continue
    const clean = stripFragmentAndQuery(raw)
    if (!clean) continue
    out.push({ raw: raw, resolved: path.resolve(path.dirname(abs), clean) })
  }
  return out
}

test('relative-link resolution: every relative link / src / srcset in every tracked .md file resolves on disk', function () {
  const files = trackedMarkdownFiles()
  assert.ok(files.length > 0, 'git ls-files must return at least one tracked .md file')

  const failures = []
  for (const file of files) {
    for (const target of resolvedRelativeTargets(file)) {
      if (!fs.existsSync(target.resolved)) {
        failures.push(file + ' -> ' + target.raw + ' (resolved: ' + path.relative(ROOT, target.resolved) + ')')
      }
    }
  }
  assert.deepStrictEqual(failures, [], 'unresolved relative link(s):\n' + failures.join('\n'))
})

// The ONLY docs/*.md files allowed to sit outside two hops of docs/index.md,
// each with its own reason. Adding a fifth entry here without also updating
// tests/fixtures/architecture-split.json's reachabilityExempt.exempt (and
// vice versa) fails the exhaustiveness test below -- that is the point: the
// carve-out cannot quietly grow in only one of the two places.
const REACHABILITY_EXEMPT = [
  {
    path: 'docs/index.md',
    reason: 'The traversal root itself: it is the starting point the two-hop rule counts hops FROM, never a target that must itself be "reached".'
  },
  {
    path: 'docs/ARCHITECTURE.md',
    reason: 'Reduced redirect stub left at the old path for old bookmarks/links; it points forward into docs/architecture/ but nothing under docs/ is meant to link back to it.'
  },
  {
    path: 'docs/diagrams/CLAUDE.md',
    reason: 'Byte-identical twin of docs/diagrams/AGENTS.md, kept only so both agent-runtime filename conventions resolve to the same guidance; linking one twin is sufficient.'
  },
  {
    path: 'docs/architecture/CLAUDE.md',
    reason: 'Byte-identical twin of docs/architecture/AGENTS.md, same naming-convention pairing as the diagrams twin above; docs/architecture/index.md\'s file map links AGENTS.md only.'
  }
]

// Builds a directed graph over `docsFiles` (repo-relative paths) using only
// links that resolve to another tracked .md file within that same set.
function buildDocsLinkGraph(docsFiles) {
  const docsSet = new Set(docsFiles)
  const graph = new Map()
  for (const file of docsFiles) graph.set(file, [])
  for (const file of docsFiles) {
    for (const target of resolvedRelativeTargets(file)) {
      if (!target.resolved.endsWith('.md')) continue
      const rel = path.relative(ROOT, target.resolved).split(path.sep).join('/')
      if (docsSet.has(rel)) graph.get(file).push(rel)
    }
  }
  return graph
}

test('two-hop reachability: every tracked docs/*.md file is within two hops of docs/index.md, except the named exemptions', function () {
  const docsFiles = trackedMarkdownFiles().filter(function (f) { return f.startsWith('docs/') })
  const root = 'docs/index.md'
  assert.ok(docsFiles.includes(root), 'docs/index.md must be a tracked file')

  const graph = buildDocsLinkGraph(docsFiles)

  const reached = new Set([root])
  const hop1 = graph.get(root) || []
  for (const f of hop1) reached.add(f)
  for (const f of hop1) {
    for (const g of (graph.get(f) || [])) reached.add(g)
  }

  const exemptPaths = new Set(REACHABILITY_EXEMPT.map(function (e) { return e.path }))
  const unreached = docsFiles.filter(function (f) { return !reached.has(f) && !exemptPaths.has(f) })
  assert.deepStrictEqual(unreached, [],
    'docs file(s) unreachable within two hops of docs/index.md and not in the named exemption list: ' + unreached.join(', '))

  // Both AGENTS.md destinations of the split are real reachable pages, not
  // exempt carve-outs -- only their CLAUDE.md twins are exempt.
  assert.strictEqual(reached.has('docs/diagrams/AGENTS.md'), true, 'docs/diagrams/AGENTS.md must be reachable, not exempt')
  assert.strictEqual(reached.has('docs/architecture/AGENTS.md'), true, 'docs/architecture/AGENTS.md must be reachable, not exempt')
  assert.strictEqual(exemptPaths.has('docs/diagrams/AGENTS.md'), false)
  assert.strictEqual(exemptPaths.has('docs/architecture/AGENTS.md'), false)
})

test('reachabilityExempt is exhaustive: exactly 4 named exemptions, each with an inline reason, matching the split fixture', function () {
  assert.strictEqual(REACHABILITY_EXEMPT.length, 4)
  for (const e of REACHABILITY_EXEMPT) {
    assert.ok(typeof e.path === 'string' && e.path.length > 0, 'exemption is missing a path')
    assert.ok(typeof e.reason === 'string' && e.reason.length > 20, e.path + ' must carry a real inline reason')
  }
  assert.deepStrictEqual(
    REACHABILITY_EXEMPT.map(function (e) { return e.path }).slice().sort(),
    ['docs/ARCHITECTURE.md', 'docs/architecture/CLAUDE.md', 'docs/diagrams/CLAUDE.md', 'docs/index.md'].sort()
  )

  // Cross-check against the split fixture's own reachabilityExempt: its
  // 3-entry `exempt` array (docs/index.md is that fixture's separate `root`
  // note, not one of the 3) must equal this file's 4-entry list minus the
  // root. If the fixture's carve-out ever grows without this test being
  // updated to match (or vice versa), this assertion is what catches it.
  const fixture = loadFixture()
  const fixtureExemptPaths = fixture.reachabilityExempt.exempt.map(function (e) { return e.path }).slice().sort()
  const thisFileExemptMinusRoot = REACHABILITY_EXEMPT
    .map(function (e) { return e.path })
    .filter(function (p) { return p !== 'docs/index.md' })
    .sort()
  assert.deepStrictEqual(fixtureExemptPaths, thisFileExemptMinusRoot,
    'tests/fixtures/architecture-split.json reachabilityExempt.exempt has drifted from this test\'s REACHABILITY_EXEMPT list')
})

// Finds every tracked AGENTS.md that has a sibling CLAUDE.md in the same
// directory. General over the whole tracked-file list, not a hardcoded
// pair of paths, so a future <dir>/AGENTS.md + CLAUDE.md pair anywhere in
// the repo is picked up automatically.
function findAgentsClaudePairs(files) {
  const byDir = new Map()
  for (const f of files) {
    const base = path.basename(f)
    if (base !== 'AGENTS.md' && base !== 'CLAUDE.md') continue
    const dir = path.dirname(f)
    if (!byDir.has(dir)) byDir.set(dir, {})
    byDir.get(dir)[base] = f
  }
  const pairs = []
  for (const entry of byDir.values()) {
    if (entry['AGENTS.md'] && entry['CLAUDE.md']) {
      pairs.push({ agents: entry['AGENTS.md'], claude: entry['CLAUDE.md'] })
    }
  }
  return pairs
}

test('parity: every tracked <dir>/AGENTS.md with a sibling CLAUDE.md is byte-identical to it', function () {
  const files = trackedMarkdownFiles()
  const pairs = findAgentsClaudePairs(files)

  // Must actually find pairs, not vacuously pass. Today: docs/diagrams and
  // docs/architecture. A future pair is covered automatically without
  // editing this test; this floor just guards against the scan itself
  // silently finding nothing.
  assert.ok(pairs.length >= 2, 'expected at least the docs/diagrams and docs/architecture AGENTS.md/CLAUDE.md pairs')
  const dirs = pairs.map(function (p) { return path.dirname(p.agents) })
  assert.ok(dirs.includes('docs/diagrams'), 'docs/diagrams AGENTS.md/CLAUDE.md pair not found')
  assert.ok(dirs.includes('docs/architecture'), 'docs/architecture AGENTS.md/CLAUDE.md pair not found')

  for (const pair of pairs) {
    const agentsBuf = fs.readFileSync(path.join(ROOT, pair.agents))
    const claudeBuf = fs.readFileSync(path.join(ROOT, pair.claude))
    assert.strictEqual(agentsBuf.equals(claudeBuf), true,
      pair.agents + ' and ' + pair.claude + ' must be byte-identical (freeze pair)')
  }
})
