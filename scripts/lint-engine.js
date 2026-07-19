#!/usr/bin/env node
'use strict'

// scripts/lint-engine.js — zero-dep sandbox-rule lint for workflows/ticketmill.js.
//
// The Workflow tool sandbox forbids Date.now(), Math.random(), argless
// `new Date()`, and any filesystem/Node API (require/import) — they are all
// legal JavaScript, so `node --check` passes on them, but they throw at
// runtime or silently break resume. This script does a dumb, loud,
// line-by-line text scan for those constructs so a violation is caught
// before it ever reaches a live run.
//
// Rules:
//   - Pure-comment lines (first non-whitespace characters on the line are
//     `//`) are skipped — the engine's own doc comments legitimately mention
//     these APIs by name (see the two `Date.now()` mentions near the top of
//     workflows/ticketmill.js explaining why wall-clock time isn't available).
//   - Any line containing the literal token `// sandbox-ok` is skipped
//     entirely. This is the ONLY exception mechanism — no weaker
//     pattern-based allowances. Use it sparingly and only when the line is
//     genuinely not the forbidden construct (e.g. a string literal or a
//     trailing/inline comment that happens to contain one of these tokens).
//   - Also fails if .claude/workflows/ticketmill.js is not byte-identical to
//     workflows/ticketmill.js. mill-init copies the engine verbatim into each
//     target repo's .claude/workflows/, and this repo keeps its own copy in
//     lockstep as a live smoke test of that contract — drift here means one
//     copy was edited without the other.
//
// Exit code: 0 = clean, 1 = one or more violations (printed as file:line: message).

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ENGINE_PATH = path.join(ROOT, 'workflows', 'ticketmill.js')
const CLAUDE_ENGINE_PATH = path.join(ROOT, '.claude', 'workflows', 'ticketmill.js')

const SANDBOX_OK = '// sandbox-ok'

const RULES = [
  {
    test: function (line) {
      return line.indexOf('Date.now(') !== -1
    },
    message: 'forbidden Date.now() — throws in the Workflow tool sandbox and breaks resume',
  },
  {
    test: function (line) {
      return line.indexOf('Math.random(') !== -1
    },
    message: 'forbidden Math.random() — throws in the Workflow tool sandbox',
  },
  {
    test: function (line) {
      return /\bnew\s+Date\s*\(\s*\)/.test(line)
    },
    message: 'forbidden argless new Date() — throws in the Workflow tool sandbox and breaks resume',
  },
  {
    test: function (line) {
      return /\brequire\s*\(/.test(line) || /^\s*import\b/.test(line) || /[^.\w]import\s*\(/.test(line)
    },
    message: 'forbidden require()/import — no filesystem or Node APIs in the Workflow tool sandbox',
  },
]

function isPureCommentLine(line) {
  return /^\s*\/\//.test(line)
}

function lintEngineSource(filePath) {
  const relPath = path.relative(ROOT, filePath)
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split('\n')
  const violations = []
  lines.forEach(function (line, i) {
    if (isPureCommentLine(line)) return
    if (line.indexOf(SANDBOX_OK) !== -1) return
    RULES.forEach(function (rule) {
      if (rule.test(line)) {
        violations.push(relPath + ':' + (i + 1) + ': ' + rule.message)
      }
    })
  })
  return violations
}

function main() {
  if (!fs.existsSync(ENGINE_PATH)) {
    console.error(path.relative(ROOT, ENGINE_PATH) + ' not found')
    process.exit(1)
  }
  if (!fs.existsSync(CLAUDE_ENGINE_PATH)) {
    console.error(path.relative(ROOT, CLAUDE_ENGINE_PATH) + ' not found')
    process.exit(1)
  }

  const violations = lintEngineSource(ENGINE_PATH)

  const engineBuf = fs.readFileSync(ENGINE_PATH)
  const claudeEngineBuf = fs.readFileSync(CLAUDE_ENGINE_PATH)
  if (!engineBuf.equals(claudeEngineBuf)) {
    violations.push(
      path.relative(ROOT, CLAUDE_ENGINE_PATH) +
        ':1: out of sync with ' + path.relative(ROOT, ENGINE_PATH) +
        ' — the two engine copies must be byte-identical; edit workflows/ticketmill.js ' +
        'then copy it verbatim over .claude/workflows/ticketmill.js in the same change'
    )
  }

  if (violations.length) {
    violations.forEach(function (v) {
      console.error(v)
    })
    process.exit(1)
  }

  console.log('lint-engine: clean (' + path.relative(ROOT, ENGINE_PATH) + ')')
}

main()
