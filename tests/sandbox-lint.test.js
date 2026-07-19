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
  return dir
}

/** Run a lint-engine.js copy as a child process; never throws on non-zero exit. */
function runLint(lintScriptPath) {
  try {
    const stdout = execFileSync(process.execPath, [lintScriptPath], { encoding: 'utf8' })
    return { code: 0, stdout: stdout, stderr: '' }
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    }
  }
}

function runSandboxLint(dir) {
  return runLint(path.join(dir, 'scripts', 'lint-engine.js'))
}

function withSandbox(workflowsSource, claudeSource, fn) {
  const dir = makeSandbox(workflowsSource, claudeSource)
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

test('sanity: the real repo\'s two engine copies are themselves byte-identical', function () {
  const claudeSource = fs.readFileSync(REAL_CLAUDE_ENGINE_PATH, 'utf8')
  assert.strictEqual(claudeSource, realEngineSource, 'workflows/ticketmill.js and .claude/workflows/ticketmill.js have drifted — see the LOCKSTEP-EDIT rule')
})
