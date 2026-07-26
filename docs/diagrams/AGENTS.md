# Working on the pipeline diagrams

Read this before editing anything in `docs/diagrams/`. Most of what follows is
a lesson learned the expensive way — by rendering something that looked fine
locally and was unreadable, invisible, or mirrored once it landed in
`docs/ARCHITECTURE.md`.

> **Parity note:** `CLAUDE.md` and `AGENTS.md` in this directory are byte-identical
> on purpose, so an agent finds the same guidance under whichever name its harness
> looks for. If you change one, copy it over the other in the same commit:
> `cp docs/diagrams/CLAUDE.md docs/diagrams/AGENTS.md`.

## What lives here

| File | Role |
| --- | --- |
| `theme-light.d2`, `theme-dark.d2` | Palette + class definitions. No nodes, no edges. |
| `pipeline-overview.d2` | The hero diagram: five phases end to end. |
| `phase-{select,plan,build,ship,report}.d2` | One diagram per phase. |
| `render.sh` | Regenerates every SVG. The only supported way to produce them. |
| `*-light.svg`, `*-dark.svg` | **Generated.** Never hand-edit. |

Diagram bodies contain **no colors**. They reference class names only. All
color lives in the two theme files.

## Requirements

[D2](https://d2lang.com) v0.7.x. There is no `package.json` in this repo and d2
is not vendored, so you must supply the binary:

```bash
# Either put d2 on PATH, or point render.sh at it:
D2=/path/to/d2 ./render.sh
```

To fetch it without piping a remote script into a shell:

```bash
curl -fsSL -o d2.tar.gz \
  https://github.com/terrastruct/d2/releases/download/v0.7.1/d2-v0.7.1-linux-amd64.tar.gz
tar -xzf d2.tar.gz          # binary lands at d2-v0.7.1/bin/d2
```

## How to make a change

1. Edit the `.d2` body (or a theme file).
2. Run `./render.sh`. It writes **both** the light and dark SVG for every
   diagram — always commit the pair.
3. Eyeball the result at the width it will actually be viewed at. See
   "Verifying" below. Do not skip this; nearly every rule on this page exists
   because something passed a compile and failed a look.
4. If you added or removed a diagram, update the `<picture>` blocks in
   `docs/ARCHITECTURE.md` to match.
5. If you changed what a class *means*, update the legend table in the
   `## Pipeline` section of `docs/ARCHITECTURE.md`. The table and the theme
   files are a contract; they drift silently.

`render.sh` builds each diagram by **concatenating** a theme file and a body
file into a temp file. That is why bodies must not declare their own `vars`
or `classes` blocks — they would collide with the theme's.

## Theme contract

`theme-light.d2` and `theme-dark.d2` must define **exactly the same class
names**. A body references a class that only one theme defines and that mode's
render silently falls back to d2 defaults.

Current vocabulary — keep it in sync with the legend in `ARCHITECTURE.md`:

| Class | Means |
| --- | --- |
| `stage` | An ordinary stage: one schema-validated subagent call |
| `gate` | A gate or capped loop — somewhere the run can iterate or stall |
| `optional` | Gated on profile config, skipped by default (dashed border) |
| `terminal` | A terminal state for that phase |
| `human` | The one place a human is required |
| `phase` | A container/grouping box |
| `flow` | A normal forward edge |
| `loop` | A backward edge: rework, re-review, retry (dashed amber) |

## Hard-won rules

### d2 comments are `#`, not `//`

`//` is not a comment. d2 parses those lines as shape declarations, and you get
a bogus node plus a confusing parse error somewhere else in the file — often
pointing at a line that is fine. A `*` inside such a line is read as a glob
operator, which is how this first surfaced.

### Never use `|md|` blocks

Markdown blocks render into `<svg:foreignObject>`. That is HTML inside an SVG,
and support for it collapses the moment the SVG is loaded through an `<img>`
tag — which is exactly how GitHub embeds these. It also ignored the line breaks
we wrote and let text overflow its box.

Use plain quoted labels with `\n` instead. They render as native `<text>`
elements, d2 sizes the box correctly around them, and they work everywhere.

Verify after any label change:

```bash
grep -c foreignObject *.svg    # must be 0 for every file
```

### Two themes exist because d2 inlines custom fills

d2 does emit a `prefers-color-scheme` block, but only for its *built-in* theme
colors. Any `style.fill` you write yourself is inlined as a literal hex value
and will not adapt. One SVG therefore cannot carry both palettes.

Hence: two renders per diagram, paired in `ARCHITECTURE.md` through a
`<picture>` element, which GitHub officially supports:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/NAME-dark.svg">
  <img alt="..." src="diagrams/NAME-light.svg">
</picture>
```

### The canvas must stay transparent

Both themes set a root-level `style.fill: transparent`. Without it d2 paints an
opaque white background rect, which renders as a white slab behind the dark
diagram on GitHub's dark theme, and makes dark container titles unreadable.
Do not remove it.

### Layout engine is dagre, deliberately

Set once, in the theme files. ELK was tried and rejected: given two
structurally identical stage/gate pairs (the approach gate and the plan gate in
`phase-plan.d2`), its cycle-breaker resolved them in opposite directions, so one
pair read left-to-right and the other read right-to-left in the same diagram.
Reordering the edge declarations moved the problem instead of fixing it. Dagre
lays both out consistently and draws the back-edges as clean symmetric curves.

Dagre exposes only `--dagre-nodesep` and `--dagre-edgesep`. There is no
rank-separation knob, so you cannot tighten a diagram horizontally by
configuration — see the width budget below.

### Nested container `direction` does not work

In d2 v0.7.1 a `direction` set on a container is ignored by **both** dagre and
ELK; only the root direction applies. Verified with a minimal three-node case.

This rules out the wrapped "snake" layout (invisible row containers to fold a
long chain into two rows). Do not spend time on it. If you need to reduce
width, reduce rank count.

### Avoid 3-cycles inside a container

`phase-build.d2` originally drew `implement -> task review -> quality -> implement`.
That third edge closes a cycle in which no node is an unambiguous entry point,
and dagre responded by laying the entire group out right-to-left.

The fix was to drop the closing edge and state the repetition in the container
label instead: `"PER TASK — repeats for every planned task"`. A two-node cycle
(`task review -> implement`, the capped findings loop) is fine and renders as a
tidy back-edge.

### Width budget: rank count is the only real lever

GitHub's markdown column is roughly **1012px**. d2's SVGs are responsive, so a
wider diagram is scaled down and its text shrinks with it.

Each sequential stage adds ~70px of fixed inter-rank spacing *on top of* its own
box width. An eight-stage row renders ~2300px wide, scales to 0.44, and turns
14px text into ~6px. Unreadable.

Raising the font size does not help: box widths grow with the text, so the ratio
barely moves. The levers that actually work, in order:

1. **Merge adjacent bookkeeping stages.** "Load profile" + "Resolve roles"
   became one node. Fewer ranks, and it reads better.
2. **Shorten label lines.** Box width tracks the *longest line*, so three short
   lines beat two long ones.
3. **Drop redundant terminal nodes** where the next diagram already shows them.

Keep phase diagrams at **six or fewer ranks** and **under ~1750px** natural
width. `phase-ship.d2` at ~1725px is the current widest — treat that as the
ceiling, not a target. Check after every edit:

```bash
for f in *-light.svg; do
  printf "%-30s " "$f"; grep -o 'width="[0-9]*" height="[0-9]*"' "$f" | head -1
done
```

The overview is the exception: it is vertical (`direction: down`) and narrow
(~389px), so GitHub scales it *up* and it renders large and crisp. Do not
convert it to `direction: right` — that measured 3511px wide.

### Edge semantics: container vs child

`rv -> bw2` in `phase-ship.d2` leaves the *container*, not one reviewer, because
the gate is spec **and** code review both approving in the same iteration.
Drawing it from `rv.code` implied code review alone gated the merge. When an
edge represents a joint condition, source it from the container.

## Verifying

Compiling is not verifying. Render at real width and look at it:

```bash
cat > /tmp/preview.html <<HTML
<html><body style="margin:0;background:#fff">
<div style="max-width:1012px;margin:0 auto">
  <img src="file://$PWD/phase-plan-light.svg" style="max-width:100%">
</div></body></html>
HTML
google-chrome --headless --disable-gpu --screenshot=/tmp/preview.png \
  --window-size=1030,900 --hide-scrollbars file:///tmp/preview.html
```

Swap the background to `#0d1117` and the `-light` suffix to `-dark` to check
dark mode. Both must be checked — they are separate files and a theme edit can
break one while leaving the other correct.

Note that `inkscape` and `rsvg-convert` will *not* show you what GitHub shows;
they warn `unknown type: svg:foreignObject` and skip content. Use a browser.

## Repo conventions that apply here

- Diagram edits are documentation changes and still follow the repo release
  process: CHANGELOG entry, `.claude-plugin/plugin.json` version bump,
  conventional commit.
- A change to engine stage order or caps must update both the affected `.d2`
  **and** the committed SVGs in the same commit, or the docs ship a stale
  picture of the pipeline. `ticketmill-code-reviewer` flags this.
- The generated SVGs are intentionally committed. Contributors and CI do not
  need d2 installed to read the docs — only to change them.
