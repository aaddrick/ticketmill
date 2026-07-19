#!/usr/bin/env bash
# tests/setup-worktree.test.sh
#
# Plain-bash test harness for scripts/setup-worktree.sh. No bats-core, no
# global installs. Each case builds its own scratch REPO_ROOT + WORKTREES_DIR
# (never the real repo), an offline local bare `origin` seeded with the base
# branch, and a temp-dir fake `gh` prepended to PATH so the script never
# touches the network or a real GitHub issue.
#
# Assertions check the script's JSON stdout (parsed with `node -e`) and the
# resulting git state — never the script's source text.
set -euo pipefail

REPO_TOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_TOP/scripts/setup-worktree.sh"
BASE_BRANCH="main"
REPO_SLUG="acme/widgets"

PASS=0
FAIL=0
CLEANUP_DIRS=()

# shellcheck disable=SC2329 # invoked indirectly via `trap cleanup EXIT`
cleanup() {
    local d
    for d in "${CLEANUP_DIRS[@]:-}"; do
        [[ -n "$d" && -d "$d" ]] && rm -rf "$d"
    done
}
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); echo "ok   - $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL - $*"; }

assert_eq() {
    local expected="$1" actual="$2" msg="$3"
    if [[ "$expected" == "$actual" ]]; then
        ok "$msg"
    else
        fail "$msg (expected [$expected] got [$actual])"
    fi
}

# Evaluates a `[[ ... ]]` (or any) condition given as a single string. Using
# eval (rather than "$@") lets callers pass real [[ ]] syntax — including
# glob/pattern matches like `[[ "$x" == foo-* ]]` — which "$@" can't execute
# since `[[` is only special as the first word of a real command, not as a
# positional argument to another command.
assert_true() {
    local msg="$1" cond="$2"
    if eval "$cond"; then
        ok "$msg"
    else
        fail "$msg"
    fi
}

assert_valid_json() {
    local json="$1" msg="$2"
    if node -e 'JSON.parse(process.argv[1])' "$json" >/dev/null 2>&1; then
        ok "$msg"
    else
        fail "$msg (not valid JSON: $json)"
    fi
}

# Reads a top-level string field out of a JSON blob. Falls back to an empty
# string on parse failure so one bad case can't abort the whole harness via
# set -e — the preceding assert_valid_json call is what records that failure.
json_get() {
    local json="$1" key="$2"
    node -e '
        const o = JSON.parse(process.argv[1]);
        const k = process.argv[2];
        if (!(k in o)) process.exit(3);
        process.stdout.write(String(o[k]));
    ' "$json" "$key" 2>/dev/null || echo ""
}

# --- scratch repo builder ---------------------------------------------------
# Populates globals: WORK (scratch root), ORIGIN (bare, seeded with
# $BASE_BRANCH), REPO_ROOT (a clone of ORIGIN), WORKTREES_DIR (not yet
# created — the script creates it), GH_BIN (dir holding a fake `gh`).
new_scratch() {
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/setup-worktree-test.XXXXXX")
    CLEANUP_DIRS+=("$WORK")

    local seed="$WORK/seed"
    ORIGIN="$WORK/origin.git"
    REPO_ROOT="$WORK/repo"
    WORKTREES_DIR="$WORK/worktrees"
    GH_BIN="$WORK/bin"

    git init -q -b "$BASE_BRANCH" "$seed"
    git -C "$seed" -c user.email=test@example.com -c user.name=test \
        commit -q --allow-empty -m "initial commit"
    git clone -q --bare "$seed" "$ORIGIN"
    git clone -q "$ORIGIN" "$REPO_ROOT"
    git -C "$REPO_ROOT" config user.email test@example.com
    git -C "$REPO_ROOT" config user.name test

    mkdir -p "$GH_BIN"
    cat > "$GH_BIN/gh" <<'EOF'
#!/usr/bin/env bash
# Fake gh: ignore all args, echo the stubbed title (mirrors --jq '.title').
echo "${GH_STUB_TITLE:-Stub Issue Title}"
EOF
    chmod +x "$GH_BIN/gh"
}

# Invokes the real script with the fake gh prepended to PATH. Always pass the
# scratch REPO_ROOT/WORKTREES_DIR explicitly — never the real repo.
run_script() {
    PATH="$GH_BIN:$PATH" "$SCRIPT" "$@"
}

# --- shellcheck (guarded, skipped if not installed) -------------------------
run_shellcheck() {
    echo "--- shellcheck: scripts/setup-worktree.sh ---"
    if command -v shellcheck >/dev/null 2>&1; then
        if shellcheck "$SCRIPT"; then
            ok "shellcheck: scripts/setup-worktree.sh is clean"
        else
            fail "shellcheck: scripts/setup-worktree.sh reported issues"
        fi
    else
        echo "skip - shellcheck not installed, skipping lint check"
    fi
}

# --- case 1: fresh creation --------------------------------------------------
case_fresh_creation() {
    echo "--- case 1: fresh creation ---"
    new_scratch
    local issue=101
    export GH_STUB_TITLE="Fix the Sprocket Widget!!"

    local out
    out=$(run_script "$issue" "$BASE_BRANCH" "$REPO_ROOT" "$WORKTREES_DIR" "$REPO_SLUG")

    assert_valid_json "$out" "case1: stdout is valid JSON"
    assert_eq "success" "$(json_get "$out" status)" "case1: status is success"

    local branch worktree
    branch=$(json_get "$out" branch)
    worktree=$(json_get "$out" worktree)

    assert_eq "issue-${issue}-fix-the-sprocket-widget" "$branch" \
        "case1: branch is slugified from the stubbed title"
    assert_eq "${WORKTREES_DIR}/issue-${issue}" "$worktree" "case1: worktree path"

    assert_true "case1: worktree directory exists" "[[ -d \"$worktree\" ]]"

    local actual_branch
    actual_branch=$(git -C "$worktree" branch --show-current)
    assert_eq "$branch" "$actual_branch" "case1: worktree is checked out on the reported branch"

    unset GH_STUB_TITLE
}

# --- case 2: idempotent reuse, title changed --------------------------------
case_idempotent_reuse() {
    echo "--- case 2: idempotent reuse (title changed) ---"
    new_scratch
    local issue=202
    local old_branch="issue-${issue}-old-slug"

    git -C "$REPO_ROOT" branch "$old_branch" "$BASE_BRANCH" >/dev/null
    git -C "$REPO_ROOT" worktree add -q "$WORKTREES_DIR/issue-${issue}" "$old_branch"

    local sentinel="$WORKTREES_DIR/issue-${issue}/SENTINEL.txt"
    echo "do-not-destroy" > "$sentinel"

    export GH_STUB_TITLE="A Totally Different New Title"
    local out
    out=$(run_script "$issue" "$BASE_BRANCH" "$REPO_ROOT" "$WORKTREES_DIR" "$REPO_SLUG")

    assert_valid_json "$out" "case2: stdout is valid JSON"
    assert_eq "success" "$(json_get "$out" status)" "case2: status is success"
    assert_eq "$old_branch" "$(json_get "$out" branch)" \
        "case2: reuses the existing branch despite the changed title"

    assert_true "case2: worktree directory still exists" \
        "[[ -d \"$WORKTREES_DIR/issue-${issue}\" ]]"
    assert_eq "do-not-destroy" "$(cat "$sentinel" 2>/dev/null || echo MISSING)" \
        "case2: pre-planted sentinel file survived (no destroy)"

    unset GH_STUB_TITLE
}

# --- case 3: stale worktree replacement -------------------------------------
case_stale_replacement() {
    echo "--- case 3: stale worktree replacement ---"
    new_scratch
    local issue=303
    local stale_branch="scratch"

    git -C "$REPO_ROOT" branch "$stale_branch" "$BASE_BRANCH" >/dev/null
    git -C "$REPO_ROOT" worktree add -q "$WORKTREES_DIR/issue-${issue}" "$stale_branch"
    echo "stale-marker" > "$WORKTREES_DIR/issue-${issue}/STALE.txt"

    export GH_STUB_TITLE="Brand New Slug Title"
    local out
    out=$(run_script "$issue" "$BASE_BRANCH" "$REPO_ROOT" "$WORKTREES_DIR" "$REPO_SLUG")

    assert_valid_json "$out" "case3: stdout is valid JSON"
    assert_eq "success" "$(json_get "$out" status)" "case3: status is success"

    local branch
    branch=$(json_get "$out" branch)
    assert_true "case3: new branch matches the issue-<N>-* prefix" \
        "[[ \"$branch\" == issue-${issue}-* ]]"
    assert_true "case3: new branch is not the stale branch" \
        "[[ \"$branch\" != \"$stale_branch\" ]]"
    assert_true "case3: stale marker file is gone (worktree was recreated)" \
        "[[ ! -f \"$WORKTREES_DIR/issue-${issue}/STALE.txt\" ]]"

    local actual_branch
    actual_branch=$(git -C "$WORKTREES_DIR/issue-${issue}" branch --show-current)
    assert_eq "$branch" "$actual_branch" "case3: worktree is checked out on the new branch"

    unset GH_STUB_TITLE
}

# --- case 4: missing args ----------------------------------------------------
case_missing_args() {
    echo "--- case 4: missing args ---"
    local out
    if ! out=$("$SCRIPT" 1 2 3); then
        ok "case4: exits non-zero for missing args"
    else
        fail "case4: expected non-zero exit for missing args"
    fi

    assert_valid_json "$out" "case4: stdout is valid JSON on usage error"
    assert_eq "error" "$(json_get "$out" status)" "case4: status is error"
}

# --- case 5: unfetchable base branch -----------------------------------------
case_unfetchable_base() {
    echo "--- case 5: unfetchable base branch ---"
    new_scratch
    local issue=505
    local bogus_base="no-such-base-branch"

    export GH_STUB_TITLE="Some Fresh Title"
    local out
    if ! out=$(run_script "$issue" "$bogus_base" "$REPO_ROOT" "$WORKTREES_DIR" "$REPO_SLUG" 2>/dev/null); then
        ok "case5: exits non-zero for an unfetchable base branch"
    else
        fail "case5: expected non-zero exit for an unfetchable base branch"
    fi

    assert_valid_json "$out" "case5: stdout is valid JSON"
    assert_eq "error" "$(json_get "$out" status)" "case5: status is error"
    assert_eq "Could not fetch origin/${bogus_base}" "$(json_get "$out" error)" \
        "case5: error message names the unfetchable base branch"

    unset GH_STUB_TITLE
}

# --- run ---------------------------------------------------------------------
echo "=== setup-worktree.sh test suite ==="
run_shellcheck
case_fresh_creation
case_idempotent_reuse
case_stale_replacement
case_missing_args
case_unfetchable_base

echo
echo "=== $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
exit 0
