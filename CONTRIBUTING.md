# Contributing to ticketmill

This repo is the ticketmill plugin itself: the engine (`workflows/ticketmill.js`),
skills (`skills/*/SKILL.md`), agent templates, and the worktree setup script are
the product. There is no runtime app to boot. A handful of rules here aren't
obvious from browsing the code, so they're collected below.

## Prerequisites

Node >= 22 is required. This is documented, not enforced — there's no
`package.json`, so no `engines` field checks it for you. Make sure your local
Node satisfies it before running the test suite.

## Running the test suite

Run the profile's `test_command` verbatim:

```bash
node --check workflows/ticketmill.js && node scripts/lint-engine.js && bash -n scripts/setup-worktree.sh && node -e "['.claude-plugin/plugin.json','.claude-plugin/marketplace.json'].forEach(f=>JSON.parse(require('fs').readFileSync(f,'utf8')))" && node --test && bash tests/setup-worktree.test.sh
```

Note the bare `node --test`, not `node --test tests/`: it auto-discovers
`tests/*.test.js` on its own, and the directory-arg form throws
`MODULE_NOT_FOUND` on Node 22.22.0.

## Lockstep-edit rule

`workflows/ticketmill.js` and `.claude/workflows/ticketmill.js` are the same
engine and must stay byte-identical in every commit. `scripts/lint-engine.js`
enforces this with a byte-compare and fails the whole `test_command` if they
drift. Whenever you edit `workflows/ticketmill.js`, sync the copy in the same
commit:

```bash
node scripts/lint-engine.js --fix
```

Never edit only one copy.

## Engine sandbox rules

The Workflow tool sandbox that runs `workflows/ticketmill.js` forbids
`Date.now()`, `Math.random()`, argless `new Date()`, and any filesystem or
Node API (`require`/`import`). All of these are legal JavaScript, so
`node --check` passes on every one of them, but they throw at runtime and
silently break resume. `scripts/lint-engine.js` catches this with a
line-by-line text scan, wired into `test_command` right after `node --check`.

Pure-comment lines are skipped (the engine's own docs legitimately name these
APIs), and a line carrying the literal `// sandbox-ok` marker is the only
escape hatch. Use it sparingly and only when the line is genuinely not the
forbidden construct — deliberately narrower than a pattern-based exception,
so a false positive has to be spelled out per line rather than silently
suppressing a whole rule.

## Release discipline

Every change updates `CHANGELOG.md` and bumps the version in
`.claude-plugin/plugin.json`, via conventional commits. `.claude-plugin/marketplace.json`
has no version field — never add one.
