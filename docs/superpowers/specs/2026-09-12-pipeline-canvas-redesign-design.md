# Pipeline Canvas Redesign — design spec

Status: draft, pending user review.

## Context

`publish.js` and `docs.js` generate self-contained `.html` files (a
dashboard report and a project doc site) whose visual language hasn't
changed since each was first built: Google-Material colors/shadows,
Roboto, and (for `layout: 'board'`) a rigid `d3.tree()` layout computed
once on load and never touched again. A throwaway visual prototype
(published as a Claude Artifact, "Pipeline Canvas Redesign") explored a
more deliberate design system and, in particular, a `board` mode that
reads like [Count.co](https://count.co)'s canvas — cards you can drag,
that show a live-looking number instead of a document outline, and that
light up their upstream/downstream relations on hover. This spec is
that prototype's ideas translated into an actual, buildable change to
`src/publish.js` and `src/docs.js`.

Nothing about the declarative config surface changes — no new fields on
`kind: 'publish'` nodes, no new `cli()` command or flag. Everything here
is either a generation-time visual change (CSS/HTML `publish.js`/`docs.js`
already produce) or new client-side behavior in the generated file's own
`<script>` (this library ships as a single `eval()`'d file with no
build step on the consumer's side, so all interactivity has always lived
in the generated HTML's own JS, never in `src/*.js` at runtime — this
doesn't change that).

## Goals

- Replace `REPORT_CSS`/`DOCS_CSS`'s current Google-Material palette and
  Roboto with a new design system, applied uniformly to `linear` and
  `board` publish reports and to `cli('docs')`'s output.
- Replace `board` mode's rigid, compute-once `d3.tree()` layout with one
  that a reader can rearrange (drag), reorient (4 directions), and reset
  — persisted per generated file via `localStorage`, matching the
  existing theme-toggle's precedent for using it.
- Hovering a board node highlights its direct upstream and downstream
  neighbors and dims the rest — in the publish board and (bidirectionally,
  from either the canvas or the sidebar list) in the docs board.
- Publish board nodes stop rendering the entire chart/table inline (today's
  520×340 resizable box) and instead show a compact metric card — a
  headline number plus a small chart drawn from the same computed data —
  with a click-to-expand into the full chart/table.
- Docs board nodes get a color per `kind`, and `cli('docs')` gains a
  sidebar (search + index grouped by kind) and a slide-in detail panel
  (compiled SQL, deps, tests) replacing the SQL dumped straight into the
  node box.
- Preserve the existing offline posture: KPIs/tables/docs-node-list stay
  usable with no network; only `charts[]`/board-mode's D3 dependency
  (already true today) requires one.

## Non-goals

- No new declarative config (no `layout.direction` field, no per-block
  opt-in for the metric card vs. full chart — board mode always uses the
  new behavior).
- No change to `move`/`model` kinds, to `cli()`'s command surface, to
  `buildDocsPayload`/`buildDocsDetail`'s data (still whatever a node's own
  config already carries), or to non-board publish reports' *data*
  (KPIs/charts/tables computation is unchanged — only presentation).
- No server-side (Apps Script) persistence of a reader's rearranged board
  — `localStorage` only, same as the theme toggle.
- No redesign of the filters/search/CSV-export/sort mechanics already in
  `TABLE_CLIENT_JS`/`FILTER_CLIENT_JS` — those keep working exactly as
  documented in `docs/publish.md`, just restyled.

## 1. Visual design system

New CSS custom-property tokens replace `REPORT_CSS`'s current
`--paper`/`--teal`/`--coral` set (both light and the existing
`prefers-color-scheme`/`data-theme` dark-mode blocks stay, just with new
values): a warm-neutral surface pair, one primary accent, and three
*named* domain colors — `--good` (revenue-like/positive), `--warn`
(cost-like/unfavorable), `--bad` (errors) — kept distinct from the accent,
plus `--move`/`--model`/`--publish` for `cli('docs')`'s per-kind coloring.
Typography drops the Google Fonts idea from the prototype: **system font
stacks only** (`ui-sans-serif, -apple-system, "Segoe UI", Roboto,
sans-serif` for body/UI, `ui-monospace, "SF Mono", Consolas, monospace`
for data/code) — no new `<link>`/`@import`, so KPIs/tables/docs stay
exactly as offline-capable as they are today; only `charts[]` and board
mode keep their existing D3-CDN network dependency.

This reskins `REPORT_CSS` and `DOCS_CSS` wholesale (KPI cards, chart/table
card chrome, filters-as-pills, table search/sort/pager, the theme toggle)
— not just the board-specific rules — so a report never looks like two
different products depending on whether it uses `layout: 'board'`.

## 2. Shared board layout module

Today, `BOARD_LAYOUT_CLIENT_JS` (in `publish.js`, reused verbatim by
`docs.js` — see `src/publish.md`'s "Board layout" note and `src/docs.md`'s
"positioning-vs-real-edges split") runs once on `DOMContentLoaded`: builds
a synthetic single-root tree from `window.__BOARD_NODES__`, runs
`d3.tree().nodeSize([BOARD_BOX_WIDTH + BOARD_H_GAP, BOARD_BOX_HEIGHT +
BOARD_V_GAP])`, and writes each node's `style.left`/`style.top` directly —
`x` is always horizontal spread, `y` is always vertical depth, root-first
(top-down). It never recomputes and nothing is draggable.

This is replaced by a small client-side module (still living in
`publish.js`, still reused verbatim by `docs.js` — same reuse contract as
today) with four responsibilities:

**a. Direction-aware position computation.** `computeBoardPositions(nodesData,
direction)` runs the same `d3.stratify()`/`d3.tree()` pass, but `direction`
(`'top-bottom'` default, matching today's only behavior — `'bottom-top'`,
`'left-right'`, `'right-left'`) decides which of `d3.tree()`'s `x`/`y`
becomes CSS `left`/`top`, whether that axis is negated (root-at-bottom or
root-at-right), and which of `BOARD_BOX_WIDTH`/`BOARD_BOX_HEIGHT` pairs
with which gap constant in `nodeSize()` (spread vs. depth swap when the
tree is rotated 90°). Edge anchor points rotate the same way (parent
bottom-center → child top-center for the two vertical directions; parent
right-center → child left-center for the two horizontal ones, mirrored for
the reverse variants).

**b. Per-node drag, persisted per file.** Each `.board-node` becomes
draggable (pointer events; a same-node click with no movement still
reaches the existing click behavior — see §3/§4 — a click that ends after
a real drag does not). A dragged node's `{x, y}` is written to
`localStorage` under a key namespaced by `location.pathname` (these are
static files identified by where they're opened from, unlike the
existing flat `"publish-theme"` key — a per-report position obviously
can't share one global key across every generated file a reader has ever
opened) plus the node's own id; on load, a stored override wins over the
computed position for that id. Both the write and the read are wrapped in
`try/catch`, matching `THEME_TOGGLE_JS`/`THEME_INIT_JS`'s existing
posture toward `localStorage` throwing under `file://` in some browsers.

**c. Toolbar: direction + reset + fit.** The existing pan/zoom
(`BOARD_CLIENT_JS`'s `d3.zoom()`) is unchanged and needs no new
conflict-avoidance work — its `.filter()` already excludes any
`mousedown`/`touchstart` whose target is inside a `.board-node` from
starting a canvas pan (this was fixed once already, see commit `3c0ab22`,
for the node's own scroll/resize interactions; per-node drag is the same
category of interaction and the existing filter already reserves it). A
small toolbar adds: a direction control (cycles the 4 orientations,
persisted separately, also per-file), "Reset layout" (clears this file's
stored drag overrides only — direction choice is untouched — and
re-runs `computeBoardPositions`), and "Fit to screen" (re-centers/rescales
`d3.zoom`'s transform to the current bounds, same math the initial
auto-fit already does on load).

**d. Hover-highlight.** `setHighlight(id | null)` (module-level, exposed
the same way `CHART_CLIENT_JS`'s `currentSelection`/`applyHighlight`
already are for cross-chart highlighting) walks `window.__BOARD_EDGES__`
for edges touching `id`, adds a `.hi` class to `id` and its direct
neighbors, `.dim` to every other node and edge. `.board-node`'s (and, in
`docs.js`, the sidebar's `.node-row`'s) own `mouseenter`/`mouseleave`
call it; `docs.js`'s sidebar rows call the same function so hovering a
name in the list highlights the matching canvas node too (see §4).

This module stays inside `publish.js` and is reused by `docs.js` exactly
as `BOARD_LAYOUT_CLIENT_JS` is today — no new file, no new cross-module
primitive beyond what already crosses this boundary.

## 3. Publish board: metric cards, not document boxes

`BOARD_BOX_WIDTH`/`BOARD_BOX_HEIGHT` (currently `520`/`340`, sized to hold
an entire chart or table with `resize: both`) shrink to a fixed compact
card size (no more `resize: both` — the card's content is now fixed-size,
not a variable-size embedded report section). `renderBoardCanvas` keeps
rendering each block's full `chartSectionsList[i]`/`tableSectionsList[i]`
markup exactly as it does today (this is why `chartSectionsList`/
`tableSectionsList` are computed unconditionally regardless of layout mode
— see `src/publish.md`'s note on this) — but now into a hidden template
slot per block, not inline in the visible `.board-node`. `CHART_CLIENT_JS`'s
existing `DOMContentLoaded` draw pass still finds `#chart-<id>` and draws
into it exactly as today; nothing about chart drawing itself changes.

Each visible `.board-node` instead gets a small, new `renderMetricCard`
pass (client-side, reading `window.__PUBLISH_PAYLOAD__` — the same data
`CHART_CLIENT_JS`/`TABLE_CLIENT_JS` already have) that computes:

- **Chart block, no `series`:** headline = sum of `chart.data[].total`;
  mini-chart = a small sparkline (line/bar type) or ring (pie/donut type)
  plotted from `chart.data[].total` in order — a simplified, purpose-built
  small drawing, not a scaled-down call into `drawBarChart`/`drawLineChart`/
  `drawPieChart` (those assume a full-size container with axes/labels).
- **Chart block with `series`:** headline = sum across every
  `data[].values[seriesKey]`; mini-chart = the same small shape, summed
  per group across series (a stacked-bar's total height, visually).
- **Aggregated table block:** headline = sum of the first metric column,
  recovered from its formatted cells via the existing `sortableValue()`
  (already used for column sort — see `src/publish.md`'s "Sort/search
  compare on the formatted cell" note — this is the same trick, not new
  logic); mini-chart = a small bar comparison across its groups.
- **Raw table block:** headline = row count; no mini-chart (there's no
  single metric to plot for an arbitrary column selection).

A click on a card (that wasn't a drag) opens a new expand overlay
(`openExpandModal(title, node)` — a sibling to `openDetailModal`, reusing
the same `.detail-modal-backdrop`/`.detail-modal` CSS for visual
consistency, Escape-to-close, click-outside-to-close, but taking a DOM
node to move into view rather than building a rows table): it moves the
block's existing, already-drawn hidden section (from `chartSectionsList`/
`tableSectionsList`) into the modal, and moves it back to its hidden slot
on close. This is why the section is drawn once, up front, regardless of
layout — expanding is free (no data recompute, no chart redraw), and any
`detail` drill-down a chart/table already declares keeps working exactly
as it does today, nested inside the now-visible full section, since
nothing about `TABLE_DETAIL_TOGGLE_HANDLER_JS`/`handleChartClick`'s
`detail` branch changes.

`isBoardLayout` now unconditionally ships `DETAIL_CLIENT_JS` (the
`openDetailModal`/`closeDetailModal` pair) plus the new expand-overlay
code, whether or not any block declares `detail` — the same "always-on,
small, shared scaffolding" shape `publish.md` already documents for
`TABLE_CLIENT_JS`'s table-replacer hook and `CHART_CLIENT_JS`'s selection
module (both ship whenever their respective block type exists, not gated
on the specific feature that needs them).

## 4. Docs board

Two additive changes to `docs.js`, independent of the shared layout
module above:

- `renderDocsNodeSection` gets a per-`kind` colored top bar (`--move`/
  `--model`/`--publish` tokens from §1) and a small kind badge, so the
  board reads at a glance instead of every node looking identical.
- `renderDocsHtml` gains a left sidebar (search input filtering the list
  by substring; nodes grouped under MOVE/MODEL/PUBLISH headers with a
  count each) and a right-side slide-in drawer. Clicking a node (canvas or
  sidebar) opens the drawer with what `renderDocsDetailHtml` renders
  today (compiled SQL, `dependsOn` as chips, test names, discovery/compile
  errors) — moved out of the inline board box into the drawer, not
  duplicated. `buildDocsPayload`/`buildDocsDetail` (the data side) are
  untouched; this is presentation-only, same as §1/§3.

## 5. Testing

Everything in §2-4 is client-side code that runs in the reader's browser
— exactly the existing split `publish.md`'s "Board layout" section
documents for the current `d3.tree()` code (moved client-side specifically
because `d3-hierarchy` can only run where D3 already runs): Layer 1 (Node)
can test the *pure* position math (`computeBoardPositions` given a fixed
`nodesData` and each of the 4 `direction` values — no DOM, no D3, so this
part can be extracted as a plain function and unit-tested like
`buildDocsPayload` already is) and that the right script/CSS constants get
emitted for board vs. non-board, detail-vs-not, exactly as today's tests
do. Real dragging, real hover, real `localStorage` persistence, and the
expand overlay's move-node-in/move-node-out behavior are Layer 2
(`notsobigtests`, human-run) — the same "known ceiling, can't be
Node-tested" posture `publish.md` already states for board geometry in
general.

## 6. Rollout

One `notsobiglib` feature branch off `release/16` touches both
`src/publish.js` (the shared layout module, §1-3) and `src/docs.js`
(§4, which only exists once §2's module is in place) — sequenced as two
tasks in the implementation plan, `publish.js` first. `docs/publish.md`
and `docs/cli.md` get updated in the same PR (new board-mode behavior:
drag/direction/reset, metric cards, expand-on-click) per this repo's
"docs land in the same pass" rule. Already-generated `.html` files are
unaffected — this only changes what a future `cli('run')`/`cli('docs')`
call produces, not files already sitting in Drive.

## Open risk

The metric-card headline/mini-chart math (§3) is new client-side logic
with several branches (series vs. not, chart type, raw vs. aggregated
table) — worth a Layer 1 test per branch (feeding a fixed payload through
the extracted pure function, same shape as `computeAggregate`'s own
tests) rather than only eyeballing it in `notsobigtests`, even though the
*drawing* itself is Layer 2 territory.
