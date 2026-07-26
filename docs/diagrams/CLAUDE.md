# Working on the pipeline diagrams

Read this before editing anything in `docs/diagrams/`. Most of what follows is
a lesson learned the expensive way: rendering something that looked fine
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
| `pipeline-overview.d2` | The hero diagram: the whole run, end to end. |
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
   diagram. Always commit the pair.
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
or `classes` blocks. They would collide with the theme's.

## Theme contract

`theme-light.d2` and `theme-dark.d2` must define **exactly the same class
names**. If a body references a class that only one theme defines, that mode's
render silently falls back to d2 defaults.

Current vocabulary. Keep it in sync with the legend in `ARCHITECTURE.md`:

| Class | Means |
| --- | --- |
| `stage` | An ordinary stage: one schema-validated subagent call |
| `gate` | A gate or capped loop: somewhere the run can iterate or stall |
| `optional` | Gated on profile config, skipped by default (dashed border) |
| `terminal` | A terminal state for that phase |
| `human` | The one place a human is required |
| `phase` | A container/grouping box |
| `flow` | A normal forward edge |
| `loop` | A backward edge: rework, re-review, retry (dashed amber) |

## Hard-won rules

### d2 comments are `#`, not `//`

`//` is not a comment. d2 parses those lines as shape declarations, and you get
a bogus node plus a confusing parse error somewhere else in the file, often
pointing at a line that is fine. A `*` inside such a line is read as a glob
operator, which is how this first surfaced.

### Never use `|md|` blocks

Markdown blocks render into `<svg:foreignObject>`. That is HTML inside an SVG,
and support for it collapses the moment the SVG is loaded through an `<img>`
tag, which is exactly how GitHub embeds these. It also ignored the line breaks
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

So: two renders per diagram, paired in `ARCHITECTURE.md` through a
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

### Five of the six are grid snakes; select is the exception

Every diagram except `phase-select.d2` sets `grid-rows` / `grid-columns`. A
grid diagram bypasses the layout engine entirely, so the `layout-engine: dagre`
in the theme files applies to select alone.

The split is between **chains** and **branches**. A chain wraps cleanly in a
grid. A fan-out does not (see the diagonal rule below), so select stays on
dagre, which draws it as a proper decision tree.

Reading order is **boustrophedon**: row 1 left-to-right, the flow drops straight
down the last column, row 2 reads back right-to-left. That is what keeps the
wrap edge orthogonal. A naive left-to-right wrap sends a diagonal all the way
back across the image.

Cells fill **row-major over declaration order**, and declaration order is the
only thing that controls placement. Declare `grid-rows` *before* `grid-columns`;
reversed, d2 packs the cells column-major instead.

### THE DIAGONAL RULE

Grid connections are center-to-center straight segments with **no path-finding**
([d2 docs](https://d2lang.com/tour/grid-diagrams/)). An edge is orthogonal only
when its two cells are *neighbours* sharing a row or a column:

- same row, adjacent columns → horizontal
- same column, adjacent rows → vertical
- anything else → a diagonal
- an edge spanning two cells in a row draws straight **through** the cell
  between them (fine if that cell is an invisible spacer, ugly if it is a box)

So place nodes to suit the edges, not the reading order, and check every new
edge against this rule. There is no engine to rescue a bad placement.

Two consequences to know before you fight them:

- **A fan-out cannot be drawn orthogonally as sibling cells.** Only one target
  can share a column with its source, so every other branch edge is a diagonal.
  Containers do not rescue this either (see "Column width is shared"). A
  branching diagram belongs on the layout engine, not in a grid. That is why
  `phase-select.d2` is not a grid.
- **Neither engine can wrap a chain for you.** d2 does not expose ELK's
  [`wrapping.strategy`](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-wrapping-strategy.html)
  (its ELK config is a fixed typed struct), and a `direction` set on a
  container is ignored by both dagre and ELK. Grid is the only wrap mechanism.
  Do not spend time re-testing these.

### Two-cycles get one bidirectional connector

Grid draws both directions of a 2-cycle on the same center-to-center line, so
writing `a -> b` and `b -> a` stacks two labels on top of each other. Use a
single `a <-> b` with a combined label instead.

Keep those labels short and multi-line. The label is centered on the connector,
so a label wider than the gap hides the very edge it describes. Widen
`horizontal-gap` or shorten the text.

### Loops name the work, not just the arrow

A self-loop like `tl -> tl: "fix"` says nothing about where the run picks back
up. Where the rework is a genuinely distinct stage, give it a cell:
`phase-build.d2` has an explicit **Fix failing tests** node and `phase-ship.d2`
an explicit **Fix findings** node, each joined to its gate by a `<->`
connector.

Where the rework is just re-running the stage before it, a bidirectional
connector is enough. That is the contrarian gates in `phase-plan.d2`. The
per-task repetition in `phase-build.d2` rides in the quality-loop label (`↺ next
task`) because drawing it would span two cells and cut through the task-review
box.

### Spacer cells are load-bearing

`sp1: "" { style.opacity: 0 }` cells pad a row so the wrap lands in the right
column. Deleting one reflows the entire grid. Renumber rather than remove.

### Column width is shared

A grid column takes the width of its widest cell, so one verbose box stretches
everything above and below it. This bit twice:

- `phase-select.d2`'s three outcomes, wrapped in a container to keep the fan
  orthogonal, stretched the Preflight probe into a wide empty band. Stacking
  them as a nested grid inside that container only moved the distortion: the
  Claim issues box became a tall one instead, and the diagram grew to 636px.
  The distortion cannot be styled away, because the container *is* one cell.
  Select left the grid entirely.
- `phase-ship.d2` originally wrapped spec and code review in a container, which
  stretched Fix findings and Squash-merge into oversized boxes. Fixed by
  collapsing the two symmetric peers into a single cell.

Reach for a container only when you actually need a fan-out. Otherwise say it
in text.

### Size budget: the SVG is responsive, so natural width is display width

d2's root `<svg>` carries a `viewBox` and **no** width or height, so it scales
to whatever container holds it. GitHub's markdown column is roughly **1012px**.
That cuts both ways:

- Too wide and it scales down, shrinking the text with it. The pre-grid
  `phase-select` was 2310px, scaled to 0.44, and rendered 14px text at ~6px.
- Too narrow and it scales **up**. The pre-grid overview was 389×1495 and blew
  up to roughly 1012×3900: a wall of enormous boxes.

Aim for a natural width close to 1012px so the diagram renders near 1:1, and
keep the height under about 550px. Current widths run 734 to 1213, heights 305
to 489. Check after every edit:

```bash
for f in *-light.svg; do
  printf "%-30s " "$f"; grep -o 'viewBox="[^"]*"' "$f" | head -1
done
```

Raising the font size does not buy legibility. Box widths grow with the text,
so the ratio barely moves.

### An edge must not overstate which thing gated it

Spec and code review in `phase-ship.d2` are one cell because the gate is both
of them approving in the same iteration. An earlier version drew them as two
boxes in a container with the approval edge leaving `rv.code`, which read as
code review alone gating the merge.

When an edge represents a joint condition, source it from whatever represents
the whole condition: the merged cell, or the container if you need one.

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
dark mode. Check both. They are separate files, and a theme edit can break one
while leaving the other correct.

`inkscape` and `rsvg-convert` will *not* show you what GitHub shows;
they warn `unknown type: svg:foreignObject` and skip content. Use a browser.

## Repo conventions that apply here

- Diagram edits are documentation changes and still follow the repo release
  process: CHANGELOG entry, `.claude-plugin/plugin.json` version bump,
  conventional commit.
- A change to engine stage order or caps must update both the affected `.d2`
  **and** the committed SVGs in the same commit, or the docs ship a stale
  picture of the pipeline. `ticketmill-code-reviewer` flags this.
- The generated SVGs are intentionally committed. Contributors and CI do not
  need d2 installed to read the docs, only to change them.
