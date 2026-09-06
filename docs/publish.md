# `publish`

`publish` turns a table another node already materialized in BigQuery
(a `move` node with a `bigquery` target, or a `model`) into a self-
contained `.html` dashboard file in Drive: KPI numbers and one bar
chart, computed in JS at generation time and embedded inline. No CDN,
no build step, no server — the file works standalone once downloaded.

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
    { id: 'by_category', type: 'bar', title: 'By category',
      groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' } }
  ]
};
```

- `source.ref` — the name of a `move` node (with a `bigquery` target) or
  a `model` node. `dependsOn` must list it explicitly; `publish()`
  validates this and fails loudly if it doesn't.
- `kpis[]` — `agg` is `sum`/`avg`/`count`/`count_distinct`; `field` is
  required unless `agg` is `count`. `format` is `currency`/`integer`/
  `decimal` (fixed `en-US`/`$` formatting in this version).
- `charts[]` — one `bar` chart per entry, aggregated by `groupBy` in JS
  (never in SQL, never in the browser).
- `target` — a Drive file, same shape as `move`'s drive target
  (`folderId` + `fileName`). Without `upsertByName: true` (or an explicit
  `fileId`), every `cli('run')` creates a brand-new file — fine for a
  one-off, but a dashboard regenerated on a schedule needs
  `upsertByName: true` (see [docs/move.md](move.md)'s `target.upsertByName`)
  or it will pile up duplicate files in the folder on every run.

The generated `.html` also embeds the full computed payload (every KPI
and chart's data, before formatting) as `window.__PUBLISH_PAYLOAD__`, a
plain JS object separate from the rendered KPI cards/SVG chart markup —
useful for reading or exporting the raw computed data programmatically,
e.g. from the browser console, without re-parsing the visible page.

## Limits worth knowing

- `fetchTableRows` assumes flat scalar BigQuery columns — a `RECORD`/
  `REPEATED` column comes back as an object/array value, which won't
  format sensibly through `kpis`/`charts`.
- There's no row-count cap on the source table — a very large table can
  hit an Apps Script execution timeout before `publish()` finishes
  reading it.

## What's not here yet

Filters, drill-down, a `table` block, per-block `source` overrides,
cross-file navigation, a `board` tree layout, and CSV export are all
planned but not implemented — see
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
direction" section.
