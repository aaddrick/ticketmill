'use strict'

// Tests for scripts/lint-engine.js — the zero-dep sandbox-rule lint that scans
// workflows/ticketmill.js for constructs `node --check` cannot catch (they are
// legal JavaScript but throw at runtime, or silently break resume, inside the
// Workflow tool sandbox): Date.now(), Math.random(), argless new Date(), and
// require()/import of Node builtins. It also enforces that workflows/ticketmill.js
// and .claude/workflows/ticketmill.js stay byte-identical (the LOCKSTEP-EDIT rule).
//
// lint-engine.js resolves the files it lints relative to its OWN __dirname
// (`path.resolve(__dirname, '..')`), not the process cwd — so to seed a forbidden
// construct at a controlled line without touching the real engine, each seeded-
// construct test builds a throwaway sandbox directory shaped like the real repo
// (scratch scripts/lint-engine.js + workflows/ticketmill.js + .claude/workflows/
// ticketmill.js) and spawns `node <sandbox>/scripts/lint-engine.js` as a child
// process. lint-engine.js never executes the files it scans (plain readFileSync +
// line split), so the seeded source does not need to remain valid JavaScript.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const REAL_ENGINE_PATH = path.join(ROOT, 'workflows', 'ticketmill.js')
const REAL_CLAUDE_ENGINE_PATH = path.join(ROOT, '.claude', 'workflows', 'ticketmill.js')
const REAL_LINT_SCRIPT = path.join(ROOT, 'scripts', 'lint-engine.js')

// Arbitrary insertion point, well past the file's header comments — lint-engine.js
// never evaluates the scanned source, so the file need not stay syntactically
// valid JavaScript after a construct is spliced in as its own line.
const INSERT_LINE = 25

/** Insert `codeLine` as a brand-new line so it becomes 1-based line `insertLine`. */
function seedAt(baseSource, insertLine, codeLine) {
  const lines = baseSource.split('\n')
  lines.splice(insertLine - 1, 0, codeLine)
  return lines.join('\n')
}

/**
 * Seed the non-engine lockstep pairs lint-engine.js checks, so a sandbox is
 * shaped like the real repo. Without this, every sandbox run fails on a
 * missing source before it reaches the assertion under test. Both sides are
 * written identical, so these pairs stay silent and only the engine pair
 * varies per test.
 */
function seedOtherLockstepPairs(dir) {
  const script = '#!/usr/bin/env bash\necho "{}"\n'
  fs.mkdirSync(path.join(dir, '.claude', 'scripts', 'ticketmill'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'scripts', 'setup-worktree.sh'), script)
  fs.writeFileSync(path.join(dir, '.claude', 'scripts', 'ticketmill', 'setup-worktree.sh'), script)
}

/**
 * Build a throwaway directory shaped like the real repo (scripts/lint-engine.js +
 * workflows/ticketmill.js + .claude/workflows/ticketmill.js) so lint-engine.js's
 * __dirname-relative path resolution targets the sandbox, not the real engine.
 */
function makeSandbox(workflowsSource, claudeSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticketmill-lint-test-'))
  fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude', 'workflows'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.copyFileSync(REAL_LINT_SCRIPT, path.join(dir, 'scripts', 'lint-engine.js'))
  fs.writeFileSync(path.join(dir, 'workflows', 'ticketmill.js'), workflowsSource)
  fs.writeFileSync(path.join(dir, '.claude', 'workflows', 'ticketmill.js'), claudeSource === undefined ? workflowsSource : claudeSource)
  seedOtherLockstepPairs(dir)
  return dir
}

/** Run a lint-engine.js copy as a child process; never throws on non-zero exit. */
function runLintWithArgs(lintScriptPath, args) {
  try {
    const stdout = execFileSync(process.execPath, [lintScriptPath].concat(args), { encoding: 'utf8' })
    return { code: 0, stdout: stdout, stderr: '' }
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    }
  }
}

function runLint(lintScriptPath) {
  return runLintWithArgs(lintScriptPath, [])
}

function runSandboxLint(dir) {
  return runLint(path.join(dir, 'scripts', 'lint-engine.js'))
}

/** Same as runSandboxLint but invokes `--fix` mode. */
function runSandboxLintFix(dir) {
  return runLintWithArgs(path.join(dir, 'scripts', 'lint-engine.js'), ['--fix'])
}

/**
 * Build a sandbox like makeSandbox, but omit .claude/workflows/ticketmill.js
 * entirely (directory still created, since --fix only needs to write the
 * file, not create the directory) — for exercising --fix's copy-creation path.
 */
function makeSandboxWithoutClaudeCopy(workflowsSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticketmill-lint-test-'))
  fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude', 'workflows'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.copyFileSync(REAL_LINT_SCRIPT, path.join(dir, 'scripts', 'lint-engine.js'))
  fs.writeFileSync(path.join(dir, 'workflows', 'ticketmill.js'), workflowsSource)
  seedOtherLockstepPairs(dir)
  return dir
}

function withSandbox(workflowsSource, claudeSource, fn) {
  const dir = makeSandbox(workflowsSource, claudeSource)
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function withSandboxNoClaudeCopy(workflowsSource, fn) {
  const dir = makeSandboxWithoutClaudeCopy(workflowsSource)
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const realEngineSource = fs.readFileSync(REAL_ENGINE_PATH, 'utf8')

const FORBIDDEN_CONSTRUCTS = [
  { name: 'Date.now()', codeLine: 'const _sandboxLintTest = Date.now()', messageSubstring: 'forbidden Date.now()' },
  { name: 'Math.random()', codeLine: 'const _sandboxLintTest = Math.random()', messageSubstring: 'forbidden Math.random()' },
  { name: 'argless new Date()', codeLine: 'const _sandboxLintTest = new Date()', messageSubstring: 'forbidden argless new Date()' },
  { name: 'require()', codeLine: "const _sandboxLintTest = require('fs')", messageSubstring: 'forbidden require()/import' },
  { name: 'import', codeLine: "import _sandboxLintTest from 'fs'", messageSubstring: 'forbidden require()/import' },
]

for (const construct of FORBIDDEN_CONSTRUCTS) {
  test('lint-engine catches seeded ' + construct.name + ' at the correct file:line', function () {
    const seeded = seedAt(realEngineSource, INSERT_LINE, construct.codeLine)
    withSandbox(seeded, seeded, function (dir) {
      const result = runSandboxLint(dir)
      const output = result.stdout + result.stderr

      assert.notStrictEqual(result.code, 0, 'expected non-zero exit for seeded ' + construct.name + '; got:\n' + output)

      const expectedPrefix = 'workflows/ticketmill.js:' + INSERT_LINE + ':'
      assert.ok(
        output.includes(expectedPrefix),
        'expected output to report "' + expectedPrefix + '" for seeded ' + construct.name + '; got:\n' + output,
      )
      assert.ok(
        output.includes(construct.messageSubstring),
        'expected output to include "' + construct.messageSubstring + '" for seeded ' + construct.name + '; got:\n' + output,
      )
    })
  })
}

test('lint-engine passes clean on the real workflows/ticketmill.js and .claude/workflows/ticketmill.js', function () {
  const result = runLint(REAL_LINT_SCRIPT)
  const output = result.stdout + result.stderr

  assert.strictEqual(result.code, 0, 'expected the real engine to lint clean; got:\n' + output)
  assert.ok(output.includes('clean'), 'expected a clean-pass message; got:\n' + output)
})

test('lint-engine byte-compare sync check passes when the two engine copies match', function () {
  withSandbox(realEngineSource, realEngineSource, function (dir) {
    const result = runSandboxLint(dir)
    const output = result.stdout + result.stderr
    assert.strictEqual(result.code, 0, 'expected matching copies to pass; got:\n' + output)
  })
})

test('lint-engine byte-compare sync check fails when the two engine copies differ', function () {
  const driftedClaudeCopy = realEngineSource + '\n// drifted: this copy was edited without workflows/ticketmill.js\n'
  withSandbox(realEngineSource, driftedClaudeCopy, function (dir) {
    const result = runSandboxLint(dir)
    const output = result.stdout + result.stderr

    assert.notStrictEqual(result.code, 0, 'expected drifted copies to fail; got:\n' + output)
    assert.ok(
      output.includes('.claude/workflows/ticketmill.js:1:') && output.includes('out of sync'),
      'expected an out-of-sync violation reported against .claude/workflows/ticketmill.js:1:; got:\n' + output,
    )
  })
})

// The setup script is the second lockstep pair. It went unenforced for 29
// releases and drifted: scripts/setup-worktree.sh gained an empty-slug guard
// and a stdout redirect that never reached the installed copy. The redirect
// matters because the script's contract with the engine is JSON-on-stdout, so
// a bare `git branch` writing to stdout corrupts the parse.
test('lint-engine sync check fails when the setup-worktree copies differ', function () {
  withSandbox(realEngineSource, realEngineSource, function (dir) {
    const copyPath = path.join(dir, '.claude', 'scripts', 'ticketmill', 'setup-worktree.sh')
    fs.writeFileSync(copyPath, fs.readFileSync(copyPath, 'utf8') + '# drifted\n')

    const result = runSandboxLint(dir)
    const output = result.stdout + result.stderr

    assert.notStrictEqual(result.code, 0, 'expected a drifted setup script to fail; got:\n' + output)
    assert.ok(
      output.includes('.claude/scripts/ticketmill/setup-worktree.sh:1:') && output.includes('out of sync'),
      'expected an out-of-sync violation against the installed setup script; got:\n' + output,
    )
  })
})

test('--fix repairs a drifted setup-worktree copy and preserves its mode', function () {
  withSandbox(realEngineSource, realEngineSource, function (dir) {
    const sourcePath = path.join(dir, 'scripts', 'setup-worktree.sh')
    const copyPath = path.join(dir, '.claude', 'scripts', 'ticketmill', 'setup-worktree.sh')
    fs.chmodSync(sourcePath, 0o755)
    fs.writeFileSync(copyPath, '# drifted, and not executable\n')
    fs.chmodSync(copyPath, 0o644)

    const result = runSandboxLintFix(dir)
    const output = result.stdout + result.stderr

    assert.strictEqual(result.code, 0, 'expected --fix to exit 0; got:\n' + output)
    assert.ok(
      fs.readFileSync(sourcePath).equals(fs.readFileSync(copyPath)),
      'expected the setup script copies to be byte-identical after --fix',
    )
    // A copy that lost its executable bit is broken in a way byte-compare misses.
    assert.ok(fs.statSync(copyPath).mode & 0o111, 'expected --fix to restore the executable bit')
  })
})

test('--fix creates a missing setup-worktree copy rather than failing', function () {
  withSandbox(realEngineSource, realEngineSource, function (dir) {
    const copyPath = path.join(dir, '.claude', 'scripts', 'ticketmill', 'setup-worktree.sh')
    fs.rmSync(copyPath)

    const result = runSandboxLintFix(dir)
    const output = result.stdout + result.stderr

    assert.strictEqual(result.code, 0, 'expected --fix to create the missing copy; got:\n' + output)
    assert.ok(fs.existsSync(copyPath), 'expected --fix to have created the installed setup script')
  })
})

test('check mode fails loudly when an installed copy is missing entirely', function () {
  withSandbox(realEngineSource, realEngineSource, function (dir) {
    fs.rmSync(path.join(dir, '.claude', 'scripts', 'ticketmill', 'setup-worktree.sh'))

    const result = runSandboxLint(dir)
    const output = result.stdout + result.stderr

    assert.notStrictEqual(result.code, 0, 'expected a missing installed copy to fail check mode')
    assert.ok(
      output.includes('.claude/scripts/ticketmill/setup-worktree.sh') && output.includes('not found'),
      'expected a not-found error naming the missing copy; got:\n' + output,
    )
  })
})

test('--fix repairs a drifted .claude copy (exit 0, files now byte-identical)', function () {
  const driftedClaudeCopy = realEngineSource + '\n// drifted: this copy was edited without workflows/ticketmill.js\n'
  withSandbox(realEngineSource, driftedClaudeCopy, function (dir) {
    const result = runSandboxLintFix(dir)
    const output = result.stdout + result.stderr

    assert.strictEqual(result.code, 0, 'expected --fix to exit 0 after repairing drift; got:\n' + output)

    const workflowsAfter = fs.readFileSync(path.join(dir, 'workflows', 'ticketmill.js'))
    const claudeAfter = fs.readFileSync(path.join(dir, '.claude', 'workflows', 'ticketmill.js'))
    assert.ok(workflowsAfter.equals(claudeAfter), 'expected the two copies to be byte-identical after --fix')
    assert.strictEqual(claudeAfter.toString(), realEngineSource, 'expected the .claude copy to now match the source verbatim')
  })
})

test('--fix is idempotent on already-synced copies (exit 0)', function () {
  withSandbox(realEngineSource, realEngineSource, function (dir) {
    const first = runSandboxLintFix(dir)
    assert.strictEqual(first.code, 0, 'expected first --fix run on synced copies to exit 0; got:\n' + first.stdout + first.stderr)

    const second = runSandboxLintFix(dir)
    assert.strictEqual(second.code, 0, 'expected second --fix run to also exit 0; got:\n' + second.stdout + second.stderr)

    const workflowsAfter = fs.readFileSync(path.join(dir, 'workflows', 'ticketmill.js'))
    const claudeAfter = fs.readFileSync(path.join(dir, '.claude', 'workflows', 'ticketmill.js'))
    assert.ok(workflowsAfter.equals(claudeAfter), 'expected the two copies to remain byte-identical after a second --fix run')
  })
})

test('--fix does not mask a seeded sandbox violation in the source (non-zero exit + violation message even though copies match)', function () {
  const construct = FORBIDDEN_CONSTRUCTS[0]
  const seeded = seedAt(realEngineSource, INSERT_LINE, construct.codeLine)
  // Both copies already match (no drift) so the byte-compare alone would pass —
  // --fix must still surface the source's own sandbox violation.
  withSandbox(seeded, seeded, function (dir) {
    const result = runSandboxLintFix(dir)
    const output = result.stdout + result.stderr

    assert.notStrictEqual(result.code, 0, 'expected --fix to fail on a seeded sandbox violation even with matching copies; got:\n' + output)

    const expectedPrefix = 'workflows/ticketmill.js:' + INSERT_LINE + ':'
    assert.ok(output.includes(expectedPrefix), 'expected output to report "' + expectedPrefix + '"; got:\n' + output)
    assert.ok(output.includes(construct.messageSubstring), 'expected output to include "' + construct.messageSubstring + '"; got:\n' + output)

    const workflowsAfter = fs.readFileSync(path.join(dir, 'workflows', 'ticketmill.js'))
    const claudeAfter = fs.readFileSync(path.join(dir, '.claude', 'workflows', 'ticketmill.js'))
    assert.ok(workflowsAfter.equals(claudeAfter), 'expected --fix to still have synced the copies even though the source itself is violating')
  })
})

test('--fix creates the copy when absent (byte-identical, exit 0)', function () {
  withSandboxNoClaudeCopy(realEngineSource, function (dir) {
    assert.strictEqual(fs.existsSync(path.join(dir, '.claude', 'workflows', 'ticketmill.js')), false, 'test setup sanity: copy should not exist yet')

    const result = runSandboxLintFix(dir)
    const output = result.stdout + result.stderr

    assert.strictEqual(result.code, 0, 'expected --fix to exit 0 after creating the missing copy; got:\n' + output)

    const claudeAfter = fs.readFileSync(path.join(dir, '.claude', 'workflows', 'ticketmill.js'))
    assert.strictEqual(claudeAfter.toString(), realEngineSource, 'expected the newly created copy to match the source verbatim')
  })
})

test('sanity: the real repo\'s two engine copies are themselves byte-identical', function () {
  const claudeSource = fs.readFileSync(REAL_CLAUDE_ENGINE_PATH, 'utf8')
  assert.strictEqual(claudeSource, realEngineSource, 'workflows/ticketmill.js and .claude/workflows/ticketmill.js have drifted — see the LOCKSTEP-EDIT rule')
})
