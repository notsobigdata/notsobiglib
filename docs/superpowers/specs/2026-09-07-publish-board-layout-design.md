# `publish`'s board layout (`layout: 'board'`) — design

Last remaining item from the original `publish` kind design's "Future
direction" list (`docs/superpowers/specs/2026-09-05-publish-kind-design.md`)
and `docs/publish.md`'s "What's not here yet". Every other deferred item
(filters, detail drill-down, `table` block, per-block `source` override,
`linkTo` cross-file navigation, CSV export) has since shipped.

## 1. Purpose and non-goals

Today `layout: { type: 'linear' }` is the only accepted value —
`charts[]`/`tables[]` render as one stacked column, top to bottom, in
declaration order. `layout: { type: 'board' }` adds a second rendering
mode: the same chart/table blocks, positioned as a tree on a pannable/
zoomable infinite canvas (a Figma/whiteboard-style board), connected by
lines from parent to child.

Motivating use case: a `publish` node reading a highly-aggregated
`model` (few rows, small payload) as the board's root-level summary,
with child blocks — and, via each block's own existing `linkTo` —
outbound links to other, more granular `publish` reports. The board
lets one page show "a lot of related information at once," while
`linkTo` still carries the reader further into a single context's
detail on a separate page. Board layout and `linkTo` are unrelated
mechanisms that happen to compose well for this use case; this spec
doesn't change `linkTo` at all.

Non-goals: `relatesTo` on `kpis[]` (KPIs have no `id` today and stay a
fixed summary strip above the board, unaffected by this feature); a
general-purpose graph-layout algorithm (a simple tidy-tree is enough,
see §3); draggable/persisted node positions (positions are always
recomputed from the tree shape, never hand-placed or saved).

## 2. Schema

```ts
layout?: { type: 'linear' | 'board' }; // was: only 'linear' accepted

charts?: {
  // ...existing fields unchanged...
  relatesTo?: string; // NEW — id of another chart/table in this report
}[];

tables?: {
  // ...existing fields unchanged...
  relatesTo?: string; // NEW — id of another chart/table in this report
}[];
```

Worked example:

```javascript
var opsBoardPublish = {
  kind: 'publish',
  dependsOn: ['dailyOpsSummaryModel'],
  source: { type: 'ref', ref: 'dailyOpsSummaryModel' },
  target: { type: 'drive', folderId: props.REPORTS_FOLDER, fileName: 'ops-board.html', upsertByName: true },
  layout: { type: 'board' },
  kpis: [
    { label: 'Orders today', agg: 'count_distinct', field: 'order_id', format: 'integer' }
  ],
  charts: [
    { id: 'overview', type: 'bar', title: 'Orders by region',
      groupBy: 'region', metric: { agg: 'count_distinct', field: 'order_id' } },
    { id: 'by_channel', type: 'bar', title: 'Orders by channel',
      groupBy: 'channel', metric: { agg: 'count_distinct', field: 'order_id' },
      relatesTo: 'overview' },
    { id: 'by_category', type: 'bar', title: 'Orders by category',
      groupBy: 'category_name', metric: { agg: 'count_distinct', field: 'order_id' },
      relatesTo: 'overview',
      linkTo: { node: 'categoryDetailPublish', field: 'category_name' } }
  ],
  tables: [
    { id: 'flagged_orders', title: 'Flagged orders', mode: 'raw',
      columns: [{ field: 'order_id', label: 'Order' }, { field: 'flag_reason', label: 'Reason' }],
      relatesTo: 'by_channel' }
  ]
};
```

Renders as: `overview` at the root, `by_channel` and `by_category` as
its two children, `flagged_orders` as `by_channel`'s child — a
three-level tree, one root. `by_category` still behaves exactly like
any other `linkTo` chart: clicking a bar navigates to
`categoryDetailPublish`, unrelated to its position on the board.

## 3. Validation (`validatePublishConfig`)

New checks, alongside the existing per-block ones:

- `relatesTo` on any `chart`/`table` is a config error unless
  `config.layout.type === 'board'` — same "opt-in field requires its
  enabling config" posture `reactsTo` already has for undeclared
  `filters[]`. This catches "I added `relatesTo` but forgot
  `layout: {type:'board'}`" as a loud failure instead of a silently
  ignored field.
- `relatesTo`'s value must match a declared `chart.id` or `table.id`
  elsewhere in the same report (typo guard, same posture `linkTo.node`/
  `reactsTo` already have). Self-reference (`relatesTo === own id`) is
  rejected explicitly rather than falling through to the cycle check.
- The full `relatesTo` graph across `charts[]` + `tables[]` must be
  acyclic — walked once after every id/self-reference check passes;
  a cycle is reported naming the ids involved.
- No new restriction on root count: zero or more blocks with no
  `relatesTo` are all valid roots, each the head of its own tree,
  laid out side by side (see §4). This is deliberately permissive
  rather than adding a "must have exactly one root" rejection nobody
  asked for.

## 4. Layout algorithm — `computeBoardLayout(charts, tables)`

Pure function, no GAS/DOM: takes the already-validated block list
(each item just needs `.id` and `.relatesTo`), returns pixel positions
and the edge list to draw.

```ts
computeBoardLayout(blocks: { id: string; relatesTo?: string }[]): {
  positions: { id: string; x: number; y: number }[];
  edges: { from: string; to: string }[]; // from = parent id, to = child id
}
```

Algorithm — a simple tidy-tree, not full Reingold-Tilford:

1. Build a parent → children adjacency map from every block's
   `relatesTo`. Blocks with no `relatesTo` are roots.
2. For each node, recursively compute **subtree width** in whole-node
   units: a leaf is `1`; an internal node is the sum of its children's
   subtree widths (minimum `1` if it has children summing to less,
   which can't actually happen but keeps the formula total).
3. Depth-first assign `x`/`y` per root, left to right: a node's `y` is
   `depth * (BOX_HEIGHT + V_GAP)`; its `x` is the center of the span
   its children occupy (`(firstChildX + lastChildX) / 2`), or, for a
   leaf, the next free horizontal slot — `slotIndex * (BOX_WIDTH +
   H_GAP)`, where `slotIndex` advances left to right as leaves are
   visited in declaration order.
4. Each root's whole tree is placed after the previous root's, offset
   by the running total width so far — multiple roots become multiple
   trees side by side on one canvas, never overlapping.
5. `edges` is just every `{parentId, childId}` pair already collected
   in step 1, unpositioned — the renderer draws a line between each
   pair's final `x, y`.

Fixed constants (no per-report customization in v1, same posture the
existing design tokens have): `BOX_WIDTH`, `BOX_HEIGHT`, `H_GAP`,
`V_GAP` — sized to comfortably fit a chart/table section at its
existing rendered width.

**Known ceiling (resolved):** `computeBoardLayout` now does contour-based
placement — a simplified Reingold-Tilford/Walker walk (`layoutSubtree`/
`shiftPastSiblingContour`/`mergeContour` in `src/publish.js`), not the
original naive version, which gave every *leaf* a slot from one global
counter and could waste width on a lopsided tree (a sibling subtree got
pushed right by its neighbor's total leaf count, even when that
neighbor's leaves never actually coexisted at any single depth). Each
sibling is now shifted right only as far as its real per-depth overlap
with previously-placed siblings requires, and forest roots (blocks with
no `relatesTo`) are placed through the same mechanism as any other
sibling group, rather than a separate `nextSlot`-style special case.

**New, smaller ceiling:** this is a greedy left-to-right contour merge,
not the full Buchheim/Walker algorithm's O(n) apportionment pass — it
never shifts an already-placed sibling back left to tighten the result
once a later sibling turns out narrower than it, so a very bushy, uneven
board can still end up somewhat wider than the true minimum-width
packing (though never overlapping — that invariant holds unconditionally
by construction). Board box counts are small in realistic dashboards, so
exact-minimum packing isn't worth a second apportionment pass; upgrade
if a real board ever has enough boxes for the slack to visibly matter.

## 5. Rendering (`renderReportHtml`)

When `config.layout.type === 'board'`:

- `chartSections`/`tableSections` markup is generated exactly as
  today (same `renderTableSection`, same per-chart `<section
  class="chart" data-chart-id="...">` template) — nothing about how a
  single block renders changes.
- Each section is wrapped in `<div class="board-node" style="left:
  Npx; top: Npx">...</div>` using `computeBoardLayout`'s output
  instead of being concatenated into a stacked `<main>`.
- An `<svg class="board-edges">` layer, sized to the full canvas
  bounding box, drawn beneath the nodes, with one `<path>` per edge
  from `computeBoardLayout`'s `edges` (a simple elbow or straight line
  between each parent/child box's connecting edge midpoints).
- `.board-canvas` (nodes + edge SVG) sits inside `.board-viewport`
  (`overflow: hidden`, fixed to the visible page area), moved via
  `transform: translate(panX, panY) scale(zoom)`. New small vanilla-JS
  handlers: `mousedown`/`mousemove`/`mouseup` (+ touch equivalents)
  update `panX`/`panY`; `wheel` updates `zoom`, clamped to roughly
  `0.25`–`2`. No canvas/graph library — CSS transforms and pointer
  events are native platform features, same posture the rest of this
  file already has toward dependencies.
- The KPI strip and the filters dropdown bar render exactly as in
  `linear` mode, fixed above `.board-viewport` — filters, `reactsTo`
  recompute, `linkKey`/`seriesLinkKey` highlighting, and `detail`
  drill-down modals all keep working unmodified for a block wherever
  it sits on the canvas; none of those features know or care about
  layout.
- `layout: 'linear'` (the default) is completely unaffected — this is
  an additive rendering branch, not a rewrite of the existing one.

## 6. Testing

**Layer 1 (Node, TDD-first):**
- `validatePublishConfig` — new fixture cases: `relatesTo` without
  `layout:'board'` (rejected), unknown `relatesTo` id (rejected),
  self-reference (rejected), a cycle across 2 and 3 nodes (rejected),
  multiple valid roots (accepted).
- `computeBoardLayout` — fixture trees: single root with 2 children,
  a 3-level chain, two independent roots (asserts non-overlapping x
  ranges), a leaf-only "forest" of unconnected single blocks.
- `renderReportHtml` — asserts board-mode output contains one
  `.board-node` per chart/table with the position `computeBoardLayout`
  computed, and one `<path>` per edge; asserts `linear` mode's output
  is byte-for-byte unaffected by this change (regression guard).

**Layer 2 (`notsobigtests`, human-run):** one fixture: a `publish`
node with `layout: 'board'`, a 3-node tree across charts and tables,
one node also carrying `linkTo` to another existing report. Human
verifies in a real browser: tree renders in the right shape, pan
(drag) and zoom (wheel) work, the `linkTo` node still navigates
correctly, and a filter/detail-drilldown block positioned mid-tree
still recomputes/opens correctly.

## 7. Docs impact

- `docs/publish.md` — new `### Board layout (layout: 'board')`
  subsection (config shape, `relatesTo` rules, pan/zoom, known
  ceiling), and its "What's not here yet" section is removed (this was
  the last item on it).
- `src/publish.md` — dev notes on `computeBoardLayout`'s algorithm
  choice and why it isn't full Reingold-Tilford (see §4's "Known
  ceiling").
- `docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
  direction" section — no edit needed, it's a historical v1 doc, not a
  living status tracker.

## What this doesn't change

`linear` layout, `kpis[]`, `filters[]`, `reactsTo`, `detail`
drill-down, `linkKey`/`seriesLinkKey`, `linkTo`, per-block `source`
override, and CSV export are all unmodified by this feature. A report
that never sets `layout: {type:'board'}` is byte-for-byte unaffected.
