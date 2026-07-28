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
//   - Also fails if workflows/ticketmill.js is at or over the Workflow tool's
//     512 KiB script cap, which is enforced only at launch — every other check
//     in the repo passes on an engine too large to run.
//   - Also fails if .claude/workflows/ticketmill.js is not byte-identical to
//     workflows/ticketmill.js. mill-init copies the engine verbatim into each
//     target repo's .claude/workflows/, and this repo keeps its own copy in
//     lockstep as a live smoke test of that contract — drift here means one
//     copy was edited without the other.
//
// --fix mode: pass --fix to repair drift instead of just reporting it. Before
// linting, it copies workflows/ticketmill.js (the source of truth) verbatim
// over .claude/workflows/ticketmill.js — creating the copy if it's missing —
// then runs the exact same sandbox-construct scan + byte-compare as check
// mode and exits with that result. Direction is hardcoded source->copy; this
// never reads .claude/workflows/ticketmill.js to decide what to write. Source
// sandbox violations still exit 1 in --fix mode — fixing the copy never
// silently absorbs a violation in the source itself. Default (no-flag)
// invocation is unchanged, so test_command/CI behavior is untouched.
//
// Exit code: 0 = clean, 1 = one or more violations (printed as file:line: message).

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ENGINE_PATH = path.join(ROOT, 'workflows', 'ticketmill.js')
const CLAUDE_ENGINE_PATH = path.join(ROOT, '.claude', 'workflows', 'ticketmill.js')

// Every source -> installed-copy pair mill-init drops into a target repo.
// Each entry is byte-compared in check mode and overwritten source-to-copy by
// --fix. The engine was the only enforced pair until the setup script drifted:
// scripts/setup-worktree.sh gained an empty-slug guard and a stdout redirect
// (its contract with the engine is JSON-on-stdout, so a bare `git branch`
// writing to stdout corrupts the parse), and neither reached the installed
// copy for 29 releases because nothing compared them.
const LOCKSTEP_PAIRS = [
  { source: ENGINE_PATH, copy: CLAUDE_ENGINE_PATH },
  {
    source: path.join(ROOT, 'scripts', 'setup-worktree.sh'),
    copy: path.join(ROOT, '.claude', 'scripts', 'ticketmill', 'setup-worktree.sh'),
  },
]

const SANDBOX_OK = '// sandbox-ok'

// The Workflow tool refuses to launch a script file larger than 512 KiB, and
// refuses it at LAUNCH — nothing before that point notices. v0.2.0 shipped an
// engine 32 KB over this line: node --check passed, the whole suite passed, CI
// was green, and the released engine could not be run at all. So the size is
// checked here, next to the other rules that only matter at runtime.
//
// The warn band exists because the failure is a cliff, not a slope. Crossing
// the cap costs a release; crossing 92% of it costs nothing but tells you the
// next few features need to budget for it.
const ENGINE_BYTE_CAP = 524288
const ENGINE_BYTE_WARN = Math.floor(ENGINE_BYTE_CAP * 0.92)

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

// Reports a violation only when the engine is at or over the cap. The warn-band
// message goes to stderr without failing, so a run that is merely close still
// exits 0.
function checkEngineSize(filePath) {
  const relPath = path.relative(ROOT, filePath)
  const bytes = fs.statSync(filePath).size
  if (bytes >= ENGINE_BYTE_CAP) {
    return [
      relPath + ':1: ' + bytes.toLocaleString() + ' bytes exceeds the Workflow tool\'s ' +
        ENGINE_BYTE_CAP.toLocaleString() + '-byte script cap by ' +
        (bytes - ENGINE_BYTE_CAP).toLocaleString() + '. The engine cannot be launched at ' +
        'this size. Move standing prose to docs/architecture/engine-internals.md and leave ' +
        'a pointer, the way the 36 sections already there were moved',
    ]
  }
  if (bytes >= ENGINE_BYTE_WARN) {
    console.error(
      'lint-engine: WARNING — ' + relPath + ' is ' + bytes.toLocaleString() + ' bytes, within ' +
        (ENGINE_BYTE_CAP - bytes).toLocaleString() + ' bytes of the ' +
        ENGINE_BYTE_CAP.toLocaleString() + '-byte Workflow script cap'
    )
  }
  return []
}

function main() {
  const fixMode = process.argv.indexOf('--fix') !== -1

  if (!fs.existsSync(ENGINE_PATH)) {
    console.error(path.relative(ROOT, ENGINE_PATH) + ' not found')
    process.exit(1)
  }

  // Hardcoded source->copy in every pair: the tracked source is always the
  // source of truth, and --fix never reads the copy to decide what to write.
  // --fix creates a missing copy, so the check-mode hard error below does not
  // apply in fix mode.
  LOCKSTEP_PAIRS.forEach(function (pair) {
    if (!fs.existsSync(pair.source)) {
      console.error(path.relative(ROOT, pair.source) + ' not found')
      process.exit(1)
    }
    if (fixMode) {
      fs.mkdirSync(path.dirname(pair.copy), { recursive: true })
      fs.copyFileSync(pair.source, pair.copy)
      // Copy the mode too: setup-worktree.sh is executed, so a copy that
      // loses its executable bit is broken in a way a byte-compare misses.
      fs.chmodSync(pair.copy, fs.statSync(pair.source).mode)
    } else if (!fs.existsSync(pair.copy)) {
      console.error(path.relative(ROOT, pair.copy) + ' not found')
      process.exit(1)
    }
  })

  // Same scan in both modes: a sandbox violation in the source must still
  // fail --fix, not be silently carried into a freshly synced copy.
  const violations = lintEngineSource(ENGINE_PATH).concat(checkEngineSize(ENGINE_PATH))

  LOCKSTEP_PAIRS.forEach(function (pair) {
    if (!fs.readFileSync(pair.source).equals(fs.readFileSync(pair.copy))) {
      violations.push(
        path.relative(ROOT, pair.copy) +
          ':1: out of sync with ' + path.relative(ROOT, pair.source) +
          ". Installed copies must be byte-identical to their source; run " +
          "'node scripts/lint-engine.js --fix' to sync them"
      )
    }
  })

  if (violations.length) {
    violations.forEach(function (v) {
      console.error(v)
    })
    process.exit(1)
  }

  const bytes = fs.statSync(ENGINE_PATH).size
  console.log(
    'lint-engine: clean (' + path.relative(ROOT, ENGINE_PATH) + ', ' +
      LOCKSTEP_PAIRS.length + ' lockstep pairs in sync, ' + bytes.toLocaleString() +
      '/' + ENGINE_BYTE_CAP.toLocaleString() + ' bytes)'
  )
}

main()
