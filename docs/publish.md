# `publish`

`publish` turns a table another node already materialized in BigQuery
(a `move` node with a `bigquery` target, or a `model`) into a self-
contained `.html` dashboard file in Drive: KPI numbers, D3-rendered
charts (bar, line, pie), and paginated tables, computed in JS at
generation time and embedded inline. KPIs and tables have no external
dependency and work fully offline once downloaded; **any report with a
non-empty `charts[]` needs internet access at the moment a human opens
the file**, since chart rendering loads D3 from a CDN in the viewer's
browser. Generating the report (`cli('run')`, including unattended
scheduled runs) is unaffected — only viewing a chart requires network.

`publish` never runs its own SQL or query job. It reads the referenced
table's stored data directly via BigQuery's `Tabledata.list` (a storage
read, not a query — no query cost), so any join, filter, or pre-
aggregation the dashboard needs must already be done by the `move`/
`model` node it references.

Every report also ships a built-in light/dark toggle (a small button in
the top-right corner) — no config option, because there isn't one to
document: it defaults to the viewer's OS color-scheme preference and
remembers the last explicit choice via `localStorage`, the same fixed,
non-configurable design every other visual detail of a report follows.

## Config

```javascript
var salesPublish = {
  kind: 'publish',
  dependsOn: ['dailyRevenueModel'],           // must include source.ref
  source: { type: 'ref', ref: 'dailyRevenueModel' },
  target: { type: 'drive', folderId: props.REPORTS_FOLDER, fileName: 'sales.html', upsertByName: true },
  kpis: [
    { label: 'Total revenue', agg: 'sum', field: 'revenue', format: 'currency' },
    { label: 'Orders', agg: 'count_distinct', field: 'order_id', format: 'integer' }
  ],
  charts: [
    { id: 'by_category', type: 'bar', title: 'Revenue by category',
      groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'trend', type: 'line', title: 'Revenue by day',
      groupBy: 'order_date', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'share', type: 'pie', title: 'Share by category', donut: true,
      groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'by_category_channel', type: 'bar', title: 'By category and channel',
      groupBy: 'category_name', series: 'channel', stacking: 'stacked',
      metric: { agg: 'sum', field: 'revenue' } }
  ]
};
```

- `source.ref` — the name of a `move` node (with a `bigquery` target) or
  a `model` node. `dependsOn` must list it explicitly; `publish()`
  validates this and fails loudly if it doesn't.
- `kpis[]` — `agg` is `sum`/`avg`/`count`/`count_distinct`; `field` is
  required unless `agg` is `count`. `format` is `string`/`currency`/
  `integer`/`decimal` (fixed `en-US`/`$` formatting in this version).
- `target` — a Drive file, same shape as `move`'s drive target
  (`folderId` + `fileName`). Without `upsertByName: true` (or an explicit
  `fileId`), every `cli('run')` creates a brand-new file — fine for a
  one-off, but a dashboard regenerated on a schedule needs
  `upsertByName: true` (see [docs/move.md](move.md)'s `target.upsertByName`)
  or it will pile up duplicate files in the folder on every run.

### Per-block `source` override

Any single `kpi`/`chart`/`table` entry can pull from a different table
than the report's own `source.ref`, by declaring its own `source` in the
same shape:

```javascript
kpis: [
  { label: 'Total revenue', agg: 'sum', field: 'revenue', format: 'currency' },
  { label: 'Refunds', agg: 'sum', field: 'amount', format: 'currency',
    source: { type: 'ref', ref: 'refundsModel' } }   // a different table
]
```

- `block.source.ref` must be listed in `dependsOn`, exactly like the
  report's own `source.ref`, and must resolve to a `move`-with-`bigquery`-
  target or `model` node — the same rule, just per block.
- Mutually exclusive with that block's own `reactsTo`: filter recompute
  runs entirely against the report's default row set, so a block reading
  from elsewhere has nothing there for a filter change to recompute
  against. A block with its own `source` simply never reacts to filters.
- Every block sharing the same overridden `ref` fetches it once, not once
  per block.

### `charts[]`

```javascript
charts: [
  { id: 'by_category', type: 'bar', title: 'Revenue by category',
    groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' } },
  { id: 'trend', type: 'line', title: 'Revenue by day',
    groupBy: 'order_date', metric: { agg: 'sum', field: 'revenue' } },
  { id: 'share', type: 'pie', title: 'Share by category', donut: true,
    groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' } },
  { id: 'by_category_channel', type: 'bar', title: 'By category and channel',
    groupBy: 'category_name', series: 'channel', stacking: 'stacked',
    metric: { agg: 'sum', field: 'revenue' } }
]
```

- `type` is `bar` (default), `line`, or `pie`. All three aggregate the
  same way (`groupBy` + `metric`) — `line` additionally sorts its
  result ascending by `groupValue` (numeric if it parses as a number,
  otherwise as a string, which also sorts ISO-format dates correctly);
  `bar`/`pie` keep first-seen order.
- `series` (bar only) adds a second grouping dimension, rendering as
  grouped or stacked bars per `stacking` (`'grouped'` default, or
  `'stacked'`). Grouped/stacked bars have no legend or color key in
  this phase — the series' colors are visible in the chart but which
  color maps to which series value isn't labeled anywhere on the page.
- `donut` (pie only) sets an inner radius on the same `groupBy`/`metric`
  aggregation — it doesn't change the computed data.
- Charts render via D3, loaded from a pinned-version CDN URL in the
  browser — see "Charts require internet to view" below.

#### Charts require internet to view

`publish` no longer works fully offline once `charts[]` is non-empty:
the generated `.html` loads D3 from a CDN the moment a human opens it
in a browser. If that request fails (no internet, or a corporate
network blocking the CDN domain), each chart falls back to a plain
list of its computed values instead of a blank area — the numbers
stay readable, the visual chart does not render. KPIs and `tables[]`
are unaffected either way; they have no external dependency.

#### Linking charts together (`linkKey`/`seriesLinkKey`)

```javascript
charts: [
  { id: 'by_category', type: 'bar', title: 'Revenue by category',
    groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' },
    linkKey: 'category' },
  { id: 'share', type: 'pie', title: 'Share by category', donut: true,
    groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' },
    linkKey: 'category' },
  { id: 'by_category_channel', type: 'bar', title: 'By category and channel',
    groupBy: 'category_name', series: 'channel', stacking: 'stacked',
    metric: { agg: 'sum', field: 'revenue' },
    linkKey: 'category', seriesLinkKey: 'channel' },
  { id: 'trend', type: 'line', title: 'Revenue by day',
    groupBy: 'order_date', metric: { agg: 'sum', field: 'revenue' } }
  // no linkKey - "trend" never highlights, and is never highlighted
]
```

- `linkKey` (any chart type) is an opt-in string naming the "logical
  dimension" this chart's `groupBy` represents. Clicking a bar/slice/point
  in a chart that declares `linkKey` dims every element, in every *other*
  chart that declares the **same** `linkKey` string, that doesn't match the
  clicked value. Clicking the same value again clears the selection —
  even from a different chart, since the selection is keyed by value,
  not by which element was clicked.
- `seriesLinkKey` (bar + `series` only) does the same for the `series`
  dimension of a grouped/stacked bar. Clicking a segment selects **both**
  its `groupBy` and `series` values together — another chart only lights
  up on the exact combination if it declares both keys, or on just the
  `groupBy` value alone if it only declares `linkKey`.
- A chart with neither field set never highlights and is never
  highlighted — this is opt-in, not automatic. Two charts grouping by the
  same underlying field name do **not** auto-link; they must declare the
  same `linkKey` string explicitly.
- This is purely visual (dimmed vs. full opacity). KPIs, other charts'
  totals, and `tables[]` never recompute or filter — clicking never
  changes any number on the page, only which elements are dimmed.
- `linkKey`/`seriesLinkKey` are compared only as plain strings. If two
  unrelated charts are accidentally given the same `linkKey`, they will
  highlight each other on any coincidentally-matching value — the library
  has no way to detect that this wasn't intended.

#### Navigating to another report (`linkTo`)

```javascript
// categoryOverviewPublish
charts: [
  { id: 'by_category', type: 'bar', title: 'Revenue by category',
    groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'categoryDetailPublish', field: 'category_name', newTab: true } }
]

// categoryDetailPublish
target: { type: 'drive', folderId: props.REPORTS_FOLDER, fileName: 'category-detail.html' },
filters: [{ field: 'category_name', label: 'Category' }]
```

- `linkTo` (any chart type, in place of `linkKey`/`seriesLinkKey` — a
  chart can't declare both) turns a click into cross-file navigation
  instead of same-page highlighting: `node` names another declared
  `publish` node, `field` is the row field to send (same as `groupBy`),
  and `newTab` (default `true`) picks a new browser tab vs. navigating
  the current one.
- The link is the destination node's own `target.fileName`, as a plain
  relative link — not a Drive URL. This library's reports are meant to
  be downloaded (or synced via Drive for Desktop) into one local folder
  and opened straight in a browser, not viewed through Drive's own web
  preview, which doesn't render an arbitrary `.html` file's live script.
  Both files need to end up **in the same folder** for the link to
  resolve — there's nothing in the config that enforces this, the same
  posture `charts[]`' `groupBy` already has for a field that doesn't
  exist.
- The destination must also declare a `filters[]` entry for the same
  `field`; `publish()` rejects a `linkTo` that doesn't match one, the
  same typo guard `reactsTo` already applies within one report. Nothing
  about `linkTo` reads or writes Drive at generation time, and there's no
  "the destination must already exist" ordering requirement — either
  report can be generated first.
- On the destination side, nothing extra is configured: opening the link
  reads the `field=value` query string on load, and if it matches one of
  that report's own filter options, pre-selects the dropdown and
  recomputes exactly as if a human had chosen it — the same
  `reactsTo`-opted-in blocks react, the same way a `<select>` change
  already triggers. An unmatched or unrelated query string is ignored,
  not forced onto a filter that doesn't have that value.

### `tables[]`

Either a **raw** table (a chosen subset of the source's own columns, one
row per source row) or an **aggregated** table (`groupBy` + per-column
metrics — the same aggregation `charts[]` already does, just rendered
as a table instead of a bar). The generated `.html` renders only the
first `pageSize` rows (default 25) as static markup — readable with no
JS at all — plus "Previous"/"Next" buttons that page through the rest
of the (fully embedded) row set client-side. A report with no
`tables[]` gets zero added JS for this.

```javascript
tables: [
  {
    id: 'recent_orders', title: 'Recent orders', mode: 'raw',
    columns: [
      { field: 'order_id', label: 'Order' },
      { field: 'order_date', label: 'Date' },
      { field: 'revenue', label: 'Revenue', format: 'currency' }
    ],
    pageSize: 25
  },
  {
    id: 'by_category', title: 'Revenue by category', mode: 'aggregated',
    groupBy: 'category_name',
    metrics: [
      { label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' },
      { label: 'Orders', agg: 'count_distinct', field: 'order_id', format: 'integer' }
    ]
  }
]
```

- `mode: 'raw'` requires `columns[]` (each with `field`; `label`
  defaults to `field`). `mode: 'aggregated'` requires `groupBy` and a
  non-empty `metrics[]` (same `agg`/`field`-unless-count rule
  `kpis[]` already has).
- `format` on a `raw` column or an `aggregated` metric is
  `string` (default — no numeric coercion, safe for ids/dates/free
  text), `currency`, `integer`, or `decimal`.
- `pageSize` (default 25) caps the static first page; the full row set
  still reaches the browser (in the same embedded
  `window.__PUBLISH_PAYLOAD__` `kpis`/`charts` already use) for the
  "Next" button to page through.
- Every table also gets a search box and sortable column headers, both
  client-side, no extra config:
  - Typing in the search box keeps only rows where **any** column's
    formatted cell contains the text (case-insensitive substring).
  - Clicking a header cycles that column ascending → descending →
    unsorted (back to the source row order); clicking a different
    column restarts the cycle at ascending. Sorting compares the
    underlying number for `currency`/`integer`/`decimal` columns (so
    `$5.00` sorts before `$20.00`), and the text otherwise.
  - Both apply before pagination — "Page 1 of N" reflects the filtered/
    sorted row count, not the table's full row count.
- The "Export CSV" button downloads whatever the search box currently
  matches (the **full** matching set, not just the current page) as
  `<table id>.csv`, built client-side from the same embedded,
  already-formatted cells the pager uses — no extra config, no server
  round trip. With no search text, that's every row, same as before
  this existed.

The generated `.html` also embeds the full computed payload as
`window.__PUBLISH_PAYLOAD__`, a plain JS object separate from the
rendered KPI cards/chart/table markup — useful for reading or
exporting the computed data programmatically, e.g. from the browser
console, without re-parsing the visible page. KPI and chart values keep
both their raw number and a separate `.formatted` string; `tables[]`
rows are different — each cell is embedded already formatted (the exact
string the table renders), since that's also what the client-side
pager needs to page through without re-formatting anything.

### Board layout (`layout: 'board'`)

```javascript
layout: { type: 'board' },
charts: [
  { id: 'overview', type: 'bar', title: 'Orders by region',
    groupBy: 'region', metric: { agg: 'count_distinct', field: 'order_id' } },
  { id: 'by_channel', type: 'bar', title: 'Orders by channel',
    groupBy: 'channel', metric: { agg: 'count_distinct', field: 'order_id' },
    relatesTo: 'overview' }
],
tables: [
  { id: 'flagged_orders', title: 'Flagged orders', mode: 'raw',
    columns: [{ field: 'order_id', label: 'Order' }],
    relatesTo: 'by_channel' }
]
```

- `layout: { type: 'board' }` (in place of the default `'linear'`)
  renders `charts[]`/`tables[]` as a tree on a pan/zoomable infinite
  canvas instead of one stacked column. `kpis[]` are unaffected — they
  keep rendering as a fixed summary strip above the canvas, since KPIs
  have no `id` and can't participate in a tree.
- `relatesTo` (new on `charts[]`/`tables[]` entries) names another
  chart/table `id` in the same report — that block becomes this one's
  parent in the tree. No `relatesTo` means "root". `relatesTo` ids share
  one namespace across `charts[]` and `tables[]` combined, so a chart and
  a table cannot share an `id` in a board-layout report even though
  that's otherwise allowed.
- `relatesTo` is a config error unless `layout.type` is `'board'`
  (dead-config guard), if it names an id that doesn't exist, if it
  points at itself, or if it forms a cycle with other blocks'
  `relatesTo`.
- Multiple root blocks (no `relatesTo`) are all valid — each becomes its
  own tree, laid out side by side on the same canvas.
- Each block still renders exactly like it would in `linear` mode (same
  chart/table markup, same `reactsTo`/`detail`/`linkKey`/`linkTo`
  behavior) — `relatesTo` only changes where it sits on the page, never
  what it computes or how it reacts.
- Pan (click-drag or touch-drag) and zoom (mouse wheel, clamped
  roughly 0.25×–2×) are built in, vanilla JS/CSS — no extra config, no
  external library.
- **Known ceiling:** the layout centers each parent over its children
  but doesn't do full collision-avoiding tree layout, so a very lopsided
  tree (a long chain next to a wide shallow one) can look uneven rather
  than tightly packed. Fine for the box counts a dashboard realistically
  has.

### Detail drill-down

Any `chart` (bar/line/pie) or `mode: 'aggregated'` table can declare
`detail`, letting a click (chart) or an expand toggle (table row) open a
modal with the raw rows behind that group:

```javascript
tables: [{
  id: 'by_category', title: 'Revenue by category', mode: 'aggregated',
  groupBy: 'category_name',
  metrics: [{ label: 'Revenue', agg: 'sum', field: 'revenue' }],
  detail: { columns: [
    { field: 'order_id', label: 'Order' },
    { field: 'revenue', label: 'Revenue', format: 'currency' }
  ] }
}],
charts: [{
  id: 'by_category', type: 'bar', title: 'Revenue by category',
  groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' },
  detail: { columns: [
    { field: 'order_id', label: 'Order' },
    { field: 'revenue', label: 'Revenue', format: 'currency' }
  ] }
}]
```

- `detail.columns` uses the same shape as a raw-mode table's own
  `columns` (`field`/`label`/`format`).
- Not valid on `kpis[]` or on a `mode: 'raw'` table (there's no group to
  drill into).
- On a chart, mutually exclusive with `linkKey`/`seriesLinkKey`/`linkTo` -
  a chart has at most one click behavior.
- Compatible with a block's own `reactsTo`: the modal always reflects
  whichever filter is currently active, not a snapshot from when the
  report was generated.
- Only `detail.columns`' fields (plus `groupBy`/the chart's `series`, when
  set) are embedded for a block's raw rows — not the rest of each row.
  There's no cap or pagination on how many rows that is, though: declaring
  `detail` on a block reading a very large source table embeds one
  (trimmed) row per source row into the generated `.html` file, the same
  "no row-count cap" caveat this file's own "Limits worth knowing" section
  already states for the report in general.

## Filters

```javascript
filters: [
  { field: 'category_name', label: 'Category' },
  { field: 'channel', label: 'Channel' }
],
kpis: [
  { label: 'Total revenue', agg: 'sum', field: 'revenue', format: 'currency',
    reactsTo: ['category_name', 'channel'] },
  { label: 'Orders', agg: 'count_distinct', field: 'order_id', format: 'integer' }
  // no reactsTo - this KPI never moves, whatever the filters are set to
],
charts: [
  { id: 'trend', type: 'line', title: 'Revenue by day',
    groupBy: 'order_date', metric: { agg: 'sum', field: 'revenue' },
    reactsTo: ['category_name'] }   // ignores the "channel" filter
],
tables: [
  { id: 'orders', title: 'Orders', mode: 'raw', columns: [ /* ... */ ],
    reactsTo: ['category_name', 'channel'] }
]
```

- `filters[]` — each entry is one dropdown: `field` (a column in the
  source table) and `label` (what the dropdown says). Its options are
  **not** configured — they're the field's own distinct values, sorted
  alphabetically, computed at generation time.
- `reactsTo` — opt-in on any `kpi`/`chart`/`table` entry, naming which
  `filters[].field`s that block honors. A block with no `reactsTo` never
  recomputes, no matter what any filter is set to. A `reactsTo` entry
  that doesn't match a declared `filters[].field` is rejected at config
  time (a typo guard).
- Changing a dropdown recomputes only the opted-in blocks, entirely in
  the browser, against the report's underlying rows filtered by every
  currently-active (non-"All") filter, ANDed together — no reload, no
  new BigQuery call. A block always recomputes against the rows matching
  its own `reactsTo`'s intersection with the currently-active filters;
  when that intersection is empty (no `reactsTo` field is currently
  active), that means all rows, i.e. the block's original unfiltered
  value — so resetting the one filter a block cares about back to "All"
  correctly brings it back to its unfiltered value too.
- If the report also uses cross-chart click-to-highlight
  (`linkKey`/`seriesLinkKey`), changing a filter clears the current
  highlight selection, since the previously-selected value's rows may no
  longer exist post-filter.
- Known limits: every filter is a single-select, exact-match dropdown —
  no numeric/date range, no multi-select. A filter selection lives only
  in the open page's JS state; reloading the file, or a fresh download,
  resets every filter to "All". A field with many distinct values
  produces a long dropdown — `publish()` doesn't guard against choosing
  a bad `field` for this, the same posture `charts[]`' `groupBy` already
  has. With `filters[]` configured, the full source table (every column,
  every row) is embedded in the generated `.html` file to support
  client-side recomputation — size and share the file accordingly; a
  table with columns the report never displays still has them embedded.

## Limits worth knowing

- `fetchTableRows` assumes flat scalar BigQuery columns — a `RECORD`/
  `REPEATED` column comes back as an object/array value, which won't
  format sensibly through `kpis`/`charts`, or through a `tables[]` raw
  column (`format: 'string'` just stringifies it — same underlying
  limit, not a new failure mode).
- There's no row-count cap on the source table — a very large table can
  hit an Apps Script execution timeout before `publish()` finishes
  reading it.

