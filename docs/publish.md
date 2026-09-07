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
- Every table also gets an "Export CSV" button that downloads the
  **full** row set (not just the current page) as `<table id>.csv`,
  built client-side from the same embedded, already-formatted cells the
  pager uses — no extra config, no server round trip.
- No column-header sort or search yet — see "What's not here yet"
  below.

The generated `.html` also embeds the full computed payload as
`window.__PUBLISH_PAYLOAD__`, a plain JS object separate from the
rendered KPI cards/chart/table markup — useful for reading or
exporting the computed data programmatically, e.g. from the browser
console, without re-parsing the visible page. KPI and chart values keep
both their raw number and a separate `.formatted` string; `tables[]`
rows are different — each cell is embedded already formatted (the exact
string the table renders), since that's also what the client-side
pager needs to page through without re-formatting anything.

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

## What's not here yet

`linkTo` cross-file navigation (with query-string filter propagation),
`expandable`/`detail` drill-down, per-block `source` overrides, and a
`board` tree layout are all planned but not implemented — see
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
direction" section. Column-header sort and search for the `tables[]`
block are also not implemented yet.
