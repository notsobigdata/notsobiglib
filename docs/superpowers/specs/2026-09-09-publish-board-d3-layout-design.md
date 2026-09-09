# `publish`'s board layout — rework onto `d3-hierarchy`/`d3-zoom`

Reworks the *implementation* of the board layout feature shipped in
`docs/superpowers/specs/2026-09-07-publish-board-layout-design.md`
(schema, validation, and every non-layout/non-pan-zoom behavior from
that spec are unchanged and not repeated here). That spec's own "Known
ceiling"/"New, smaller ceiling" note on `computeBoardLayout` (§4) —
a greedy contour merge, not full Buchheim/Walker apportionment — and
`BOARD_CLIENT_JS`'s hand-rolled mouse/touch/wheel pan+zoom are the two
pieces this spec replaces.

## 1. Why now, and why D3

`publish()` already loads D3 (`cdnjs`, pinned `7.9.0`, SRI-pinned) for
`charts[]` rendering — see `src/publish.md`'s "Why D3 over Chart.js/
p5.js/a declarative grammar". The full D3 bundle already includes
`d3-hierarchy` (`d3.stratify()`, `d3.tree()` — a real, non-approximate
Reingold-Tilford/Buchheim-Walker implementation) and `d3-zoom`
(`d3.zoom()` — pointer/touch/wheel pan+zoom with pinch support). Using
them for the board resolves `computeBoardLayout`'s documented
approximation ceiling and `BOARD_CLIENT_JS`'s missing pinch-zoom, at
zero new dependency cost — no new CDN URL, no new SRI hash, nothing
`build.sh`'s `MODULES` manifest needs to know about.

**The constraint this ran into, and why it settles where it does:**
`notsobiglib` ships as one `eval()`'d file with no npm/bundler
(`CLAUDE.md`'s "One file to install, three files to author") — so
`d3-hierarchy` cannot be `require()`'d into `src/publish.js` and run
inside the GAS runtime the way `computeBoardLayout` runs today. D3
only ever exists client-side, loaded into the *generated report's*
browser. Two options were weighed: vendor `d3-hierarchy`'s tree
algorithm as ported/copied source into `src/` (keeps positions baked
server-side, preserves the report's current no-JS-still-shows-layout
property, but turns a well-maintained upstream algorithm into
hand-copied code this repo alone maintains); or move positioning
entirely client-side, mirroring how `charts[]` already splits
"`buildChartPayload` prepares data server-side, `CHART_CLIENT_JS`
draws it client-side via D3." The second was chosen: no vendoring, a
real reuse of the dependency already paid for, and it follows an
established precedent in this same file rather than inventing a second
one. The trade-off — a board no longer shows positioned nodes with
JavaScript disabled — was checked against this spec's own predecessor
and found to be an implementation accident, not a stated requirement;
a board's pan/zoom already requires JS today, and any board containing
a chart already requires JS to draw that chart, so a no-JS board view
was already a degraded experience before this change.

Non-goals (unchanged from the predecessor spec, restated for
clarity): draggable/persisted node positions, a general-purpose graph
layout algorithm beyond a tree, and any change to `relatesTo`'s schema
or validation rules.

## 2. Payload — `relatesTo` now travels to the client

`buildReportPayload` (`src/publish.js:713`) attaches `relatesTo` to
every chart/table entry it builds:

```ts
charts: { /* ...existing fields... */ relatesTo: string | null }[];
tables: { /* ...existing fields... */ relatesTo: string | null }[];
```

Same posture `withDetail` already has for attaching per-block extra
data to a payload entry — a plain field copy, `block.relatesTo ||
null`, added in the same two `.map()` loops that already build
`charts`/`tables`. Unconditional (not gated on `isBoardLayout`, mirroring
how `detail` is attached unconditionally per-block already) — cheap,
and keeps `buildReportPayload` from needing to know the report's
layout mode.

## 3. Generation-time rendering — `renderBoardCanvas` stops computing positions

`renderBoardCanvas` (`src/publish.js:1617`) changes from "compute
positions, bake them into `style="left;top"`" to "wrap each block's
existing markup, unpositioned":

- Each block's already-rendered section markup (`chartSectionsList[i]`/
  `tableSectionsList[i]` — unchanged, same as today) is wrapped in
  `<div class="board-node" data-block-id="...">...</div>`, no inline
  `style`.
- `<svg class="board-edges" id="board-edges">` is emitted empty (no
  `width`/`height` attrs, no `<path>` children) — populated by the new
  client script once real positions exist.
- `computeBoardLayout`, `layoutSubtree`, `shiftPastSiblingContour`, and
  `mergeContour` are deleted from `src/publish.js` entirely — nothing
  server-side computes tree positions anymore.
- `BOARD_BOX_WIDTH`/`BOARD_BOX_HEIGHT`/`BOARD_H_GAP`/`BOARD_V_GAP`
  (`src/publish.js:751-754`) are **kept**, but repurposed: `REPORT_CSS`
  gets `.board-node { width: <BOARD_BOX_WIDTH>px; height:
  <BOARD_BOX_HEIGHT>px; }` (interpolated the same way other computed
  values already join `REPORT_CSS`'s string array), replacing today's
  per-node inline `width`/`height`. The same four numbers are also
  serialized into the new client script (next section) as the spacing
  `d3.tree().nodeSize()` needs — one source of truth in the server-side
  JS file, read by both CSS generation and the emitted client script,
  same way other constants already cross that boundary in this file.
- `validateBoardRelations` (config-time validation of `relatesTo`) is
  unchanged — it's a schema concern independent of who computes final
  pixel positions, and keeps running at `publish()`-config-validation
  time exactly as before.

## 4. New client-side layout script

A new script constant (name: `BOARD_LAYOUT_CLIENT_JS`), emitted
whenever `isBoardLayout` is true, runs on `DOMContentLoaded`:

1. Reads `window.__PUBLISH_PAYLOAD__.charts`/`.tables`, projects each
   to `{ id, relatesTo }`.
2. Prepends one synthetic root (`{ id: '__board_root__', relatesTo:
   null }`) and rewrites every real root (`relatesTo === null`) to
   point at it — `d3.stratify()` requires exactly one root; a board's
   `relatesTo` graph is a forest (§3's predecessor spec: "no new
   restriction on root count"), so the synthetic root is what lets one
   `d3.stratify()`/`d3.tree()` call lay out every independent tree in
   one pass, side by side, for free — this is exactly the "full
   apportionment" upgrade the predecessor spec's ceiling note flagged
   as not worth a hand-written second pass.
3. `d3.stratify().id(d => d.id).parentId(d => d.relatesTo)` builds the
   hierarchy; `d3.tree().nodeSize([BOARD_BOX_WIDTH + BOARD_H_GAP,
   BOARD_BOX_HEIGHT + BOARD_V_GAP])` computes `x`/`y` per node using
   D3's default `.separation()` (adjacent siblings under the same
   parent get `1` unit apart, siblings under different parents get `2`
   — matches the predecessor's "no overlap, minimal extra gap between
   unrelated subtrees" intent without a custom function).
4. `d3.tree()` centers the root at `x = 0` and spreads children on both
   sides, so real nodes can land at negative `x` (unlike the deleted
   contour algorithm, which always started at `0`). Before writing any
   position, the script finds `minX` across every real (non-synthetic)
   node and shifts every node's `x` by `-minX` — same idea as a
   `viewBox` normalization, done once so no node ever gets a negative
   `style.left`. Then it walks the (now-shifted) node list, skips the
   synthetic root, and sets each real `[data-block-id="..."]` element's
   `style.left`/`style.top` from the shifted `x`/`y`.
5. Edges are **not** taken from `d3.tree()`'s own link objects — they're
   built directly from `relatesTo` (`payload.charts.concat(payload.tables)
   .filter(b => b.relatesTo).map(b => ({from: b.relatesTo, to: b.id}))`),
   the same shape `computeBoardLayout`'s `edges` array already had, then
   drawn as the same straight `M x1 y1 L x2 y2` `<path>` per edge
   (midpoint of the parent's bottom edge to the midpoint of the child's
   top edge) `renderBoardCanvas` used to draw server-side — visual
   output is unchanged, only which side computes the coordinates moved.
   `#board-edges`'s `width`/`height` are set from the computed layout's
   bounding box (`max(x + BOARD_BOX_WIDTH)`, `max(y + BOARD_BOX_HEIGHT)`
   across real nodes), same formula `renderBoardCanvas` used, just run
   client-side now.

This script has zero GAS-only API references (same rule
`FILTER_REUSED_FUNCTIONS_JS`'s nine reused functions already follow,
per `src/publish.md`) — it only ever runs in a browser, so that rule is
automatically satisfied here, not something to verify separately.

## 5. Pan/zoom — `d3.zoom()` replaces `BOARD_CLIENT_JS`'s manual handlers

`BOARD_CLIENT_JS` (`src/publish.js:1532`) is rewritten to:

```js
var zoom = d3.zoom().scaleExtent([0.25, 2]).on('zoom', function (event) {
  canvas.style.transform = event.transform.toString();
});
d3.select(viewport).call(zoom);
```

- Same target element (`.board-canvas`, via `.style.transform`), same
  `.board-viewport`/`.board-panning` CSS classes — `d3.zoom()`'s default
  events include a `start`/`end` pair usable to toggle
  `.board-panning` the same way `startDrag`/`endDrag` do today, so the
  CSS is untouched.
- `scaleExtent([0.25, 2])` preserves today's clamp range exactly.
- Deleted entirely: the hand-rolled `mousedown`/`mousemove`/`mouseup`,
  `touchstart`/`touchmove`/`touchend`, and `wheel` listeners, and the
  manual `panX`/`panY`/`zoom` bookkeeping — `d3.zoom()` owns all of
  this internally and exposes only the resulting transform.
- Accepted, unrequested-but-free UX changes from switching to
  `d3.zoom()`'s defaults: real two-finger pinch-zoom on touch (today's
  touch handlers only pan, never pinch), and double-click-to-zoom-in.
  Neither is disabled — they're strict upgrades over today's behavior,
  not a compatibility risk.
- `BOARD_LAYOUT_CLIENT_JS` (§4) and this zoom setup share one
  `DOMContentLoaded` listener (same file, same posture `BOARD_CLIENT_JS`
  already has as "its own listener, independent of `TABLE_CLIENT_JS`/
  `CHART_CLIENT_JS`") — layout runs first (so `#board-edges`'s
  `width`/`height` are set before anything is visible), then zoom is
  wired up against the now-correctly-sized canvas.

## 6. `d3Script` inclusion condition

`renderReportHtml`'s `d3Script` line (`src/publish.js:1687`) changes
from:

```js
payload.charts.length ? '<script src="' + D3_CDN_URL + '" ...' : ''
```

to:

```js
(payload.charts.length || isBoardLayout) ? '<script src="' + D3_CDN_URL + '" ...' : ''
```

A board report with only `tables[]` (no `charts[]`) previously loaded
no D3 at all — harmless before this change (positions were baked
server-side, pan/zoom was hand-rolled), but would silently break both
layout and pan/zoom now that both depend on D3 being present.

## 7. Testing

**Layer 1 (Node) — narrows, doesn't disappear:**

- `validatePublishConfig`/`validateBoardRelations` fixtures (typo
  `relatesTo`, self-reference, cycles, multiple valid roots) are
  **unchanged** — still pure config validation, still tested exactly as
  the predecessor spec's §6 describes.
- New: `buildReportPayload` fixture asserting `relatesTo` round-trips
  from `config.charts[i].relatesTo`/`config.tables[i].relatesTo` into
  `payload.charts[i].relatesTo`/`payload.tables[i].relatesTo`
  (`null` when absent) — a plain data-shape test, same spirit as the
  existing `detail`/`source` payload tests.
- New: `renderReportHtml` board-mode fixture asserting the emitted HTML
  contains one unpositioned `.board-node[data-block-id]` per
  chart/table, an empty `#board-edges`, and that `linear`-mode output
  stays byte-for-byte unaffected (same regression guard the predecessor
  spec's §6 already has).
- **Removed:** `computeBoardLayout`'s own pure-function position-math
  tests (single root/2 children, 3-level chain, independent roots,
  leaf-only forest) — that logic no longer exists server-side to unit
  test. This is a real reduction in headless coverage for the tree
  geometry itself, called out explicitly rather than glossed over.

**Layer 2 (`notsobigtests`, human-run) — same fixture, re-verify by
hand:** the predecessor spec's Layer 2 fixture (a 3-node tree across
charts and tables, one node with `linkTo`) is reused, not replaced.
Human verifies: tree renders in the right shape with no overlapping
nodes, edges connect the right parent/child pairs, pan (drag) and zoom
(wheel) work, pinch-zoom works on a touch device, double-click zooms
in, the `linkTo` node still navigates correctly, and a filter/detail-
drilldown block positioned mid-tree still recomputes/opens correctly.
This is the same "visual correctness verified by a human, not Node"
posture the predecessor spec already accepted for pan/zoom feel — it
now also covers tree geometry, mirroring how chart pixel-accuracy is
already human-verified rather than Node-tested.

## 8. Docs impact

- `docs/publish.md`'s "Board layout (`layout: 'board'`)" subsection
  (added by the predecessor spec) — update the pan/zoom description
  (pinch-zoom, double-click-to-zoom) and drop any wording implying
  positions are visible without JavaScript, if present.
- `src/publish.md` — replace the dev note on `computeBoardLayout`'s
  contour-merge algorithm and its ceiling with a note on
  `d3.stratify()`/`d3.tree()`'s synthetic-root trick (§4 above) and the
  removed Layer 1 coverage (§7 above), so whoever touches this next
  knows both why the algorithm changed and what stopped being
  Node-testable.

## What this doesn't change

Schema (`relatesTo` shape, `layout: {type: 'board'}`), validation
(`validateBoardRelations`), the KPI strip, filters/`reactsTo`, `detail`
drill-down, `linkKey`/`seriesLinkKey` highlighting, `linkTo`, per-block
`source` override, CSV export, and `layout: 'linear'` are all
unmodified by this rework — every one of those features already works
on a block "wherever it sits on the canvas" per the predecessor spec's
§5, and nothing here changes where blocks sit except *how* that
position is computed and *when* (client-side, at load, instead of
server-side, at generation).
