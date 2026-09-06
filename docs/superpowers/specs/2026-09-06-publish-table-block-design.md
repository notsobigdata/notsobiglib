# `publish` — `table` block design

First of publish's deferred v1 features to get its own pass (see
`2026-09-05-publish-kind-design.md`'s "Future direction"). Adds a
`tables[]` block alongside the existing `kpis[]`/`charts[]`, in both a
"raw" mode (a subset of the source's own columns, row per source row)
and an "aggregated" mode (`groupBy` + per-column metrics, same
aggregation `charts` already does, rendered as a table instead of a
bar). Everything else deferred past v1 (`filters`, `expandable`/
`detail`, per-block `source` override, `linkTo`, `layout: 'board'`, CSV
export) stays out of scope here — this spec only adds one block kind.

## 1. Purpose and non-goals

A KPI answers "what's the total"; a chart answers "how does it break
down by one dimension, visually". Neither answers "let me see the
actual rows" — that's what `table` is for: either the source's own
columns verbatim (a look at the granular data behind the aggregates),
or the same `groupBy` aggregation as `charts`, just tabular instead of
a bar (better for many groups or multiple metrics per group at once,
where a bar chart gets unreadable).

Non-goal for this pass: column-header sort (client-side, confirmed out
of scope during brainstorming — a separate small addition later,
possibly informed by how `filters` ends up shaping the same client-side
JS), server-side filtering/search, and anything from `filters`/
`expandable`/`linkTo`. A `raw`-mode table still never runs its own SQL
or query job — same `Tabledata.list`-only posture as the rest of
`publish()` — it only selects a subset of columns from rows already
fetched.

## 2. Schema addition

```ts
type TableBlock = {
  id: string;
  title: string;
  mode: 'raw' | 'aggregated';
  pageSize?: number;              // default 25

  // mode: 'raw'
  columns?: {
    field: string;
    label?: string;               // defaults to field
    format?: 'string' | 'currency' | 'integer' | 'decimal'; // default 'string'
  }[];

  // mode: 'aggregated'
  groupBy?: string;
  metrics?: {
    label: string;
    agg: 'sum' | 'avg' | 'count' | 'count_distinct';
    field?: string;                // required unless agg === 'count'
    format?: 'string' | 'currency' | 'integer' | 'decimal'; // default 'string'
  }[];
};
```

Added to the v1 schema as `config.tables?: TableBlock[]`, sibling to
`kpis`/`charts`. `mode` is required and explicit (not inferred from
which of `columns`/`groupBy` is present) — same reasoning `layout.type`
already uses: an explicit discriminator reads clearly at the config
site and gives a precise validation error ("mode 'raw' requires
columns") instead of a guess from shape.

Worked example, both modes:

```javascript
var salesPublish = {
  kind: 'publish',
  dependsOn: ['dailyRevenueModel'],
  source: { type: 'ref', ref: 'dailyRevenueModel' },
  target: { type: 'drive', folderId: props.REPORTS_FOLDER, fileName: 'sales.html' },
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
};
```

## 3. Validation

Extends `validatePublishConfig` (`src/publish.js`) with one
`(config.tables || []).forEach(...)` block, following the exact shape
`kpis`/`charts` validation already has:

- `id`, `title`, and `mode` are required; `mode` must be `'raw'` or
  `'aggregated'`.
- `mode: 'raw'` requires a non-empty `columns[]`; each entry needs
  `field`.
- `mode: 'aggregated'` requires `groupBy` and a non-empty `metrics[]`;
  each metric needs `label`/`agg`, and `field` unless `agg === 'count'`
  — the same rule `kpis[]` validation already enforces, reused verbatim
  rather than re-derived.
- Any `format` present (on a `raw` column or an `aggregated` metric)
  must be one of `string`/`currency`/`integer`/`decimal` — the existing
  `kpis[]` format check widened by one value (`string`, the new
  default) rather than a second enum living elsewhere.

Same lazy-validation posture as the rest of `publish()`: this runs
inside the executor at `run` time, not at discovery — `cli('list')`
still doesn't catch a bad `tables[]` entry, matching `kpis`/`charts`
today.

## 4. Data flow — `buildReportPayload`

One new step alongside the existing `kpis`/`charts` mapping, producing
`payload.tables`, an array of:

```ts
{ id: string; title: string; pageSize: number;
  columns: { key: string; label: string }[];
  rows: string[][]; }               // every cell already formatted
```

- `raw`: maps `rows` (already fetched by `fetchTableRows`, unchanged)
  directly through `config.columns` — one output row per source row,
  each cell run through `formatValue`-equivalent logic keyed by that
  column's `format` (default `'string'`, i.e. `String(value)`, no
  numeric coercion attempted — a `RECORD`/`REPEATED` source value under
  `format: 'string'` stringifies same as today's existing "assumes flat
  scalar columns" limit, not a new failure mode).
- `aggregated`: reuses the exact grouping `charts` already does — group
  `rows` by `groupBy`, then run `computeAggregate` once per metric per
  group (metrics `sum`/`avg`/`count`/`count_distinct`, the identical
  four `charts`/`kpis` already support, no new agg type). Output row =
  `[groupValue].concat(metrics.map(formatted value))`.

Both modes converge on the same `{columns, rows}` shape specifically so
step 5 needs exactly one render/pagination code path, not two —
`format` handling reuses `formatValue` (`src/publish.js`) for
`currency`/`integer`/`decimal`, extended with a `'string'` branch
(`String(value)`, no `toLocaleString`) since raw columns are frequently
non-numeric (ids, dates, free text) where `kpis`/`charts` values are
always numeric today.

This step stays pure — no GAS globals, same testability boundary
`buildReportPayload` already has (§7 of the v1 spec).

## 5. Render — static first page + client-side pagination

Chosen over full client-side paging-from-scratch or an unbounded
render, per the row-count risk `docs/publish.md` already flags
("no row-count cap on the source table... can hit an Apps Script
execution timeout"): a `raw` table can still be large even after
column narrowing, so a table block must not embed an unbounded
`<tr>` per row.

`renderReportHtml` renders, per table:

- A static `<table>` with a `<thead>` from `columns` and a `<tbody>`
  holding only the **first `pageSize` rows** — readable with no JS at
  all, same "still works if JS never runs" property the rest of the
  file already has for the KPI cards and the SVG chart.
- "Previous"/"Next" buttons and a "Page 1 of N" label — inert without
  JS (no `<form>` fallback; a static file that can't paginate further
  without JS is an acceptable degradation, matching that the SVG chart
  also has no interactive fallback).

The full `payload.tables` (every row, every table) is embedded once in
the existing `window.__PUBLISH_PAYLOAD__` script tag — no separate
embed mechanism. **One** generic pagination function is added to the
inline `<script>`, emitted **only if `config.tables` is non-empty**
(mirrors the "only pay for what you configured" posture; a report with
just `kpis`/`charts` gets zero added JS). At `DOMContentLoaded`, for
each table it: reads that table's `columns`/`rows`/`pageSize` off the
payload by `id`, and on "Next"/"Previous" rebuilds the `<tbody>` by
slicing `rows` and creating cells via `textContent` — never
`innerHTML`/string concatenation — so no new HTML-escaping surface is
introduced (the payload script tag already escapes `<` for the
script-breakout case `be7a960` fixed; `textContent` on top of that is
belt-and-suspenders, not a second fix for the same bug).

No sort, no search/filter box, no CSV export button — all explicitly
out of scope (§1).

## 6. CSS

One addition to `REPORT_CSS`'s fixed token set (`src/publish.js`):
table/row/cell rules and a `.table-pager` rule for the
prev/next/page-label row, following the existing hairline-separator,
`--mono` tabular-numeric convention already used for KPI values and
chart labels — no new design tokens, no per-report override.

## 7. Testing

**Layer 1 (Node)** — `test/publish.test.js` gets:

- Validation cases: missing `mode`, `mode: 'raw'` with empty/missing
  `columns`, `mode: 'aggregated'` with missing `groupBy`/`metrics`, a
  metric missing `field` when `agg !== 'count'`, and an invalid
  `format` value — same fixture-driven red/green pattern the existing
  `kpis`/`charts` validation tests use.
- `buildReportPayload` cases for both modes: `raw` column selection
  and ordering matches `columns[]`, `format: 'string'` passes non-
  numeric values through unchanged, `aggregated` grouping/metric math
  matches the equivalent `charts` case already tested.
- `renderReportHtml` asserts the static first page's rows appear in
  the markup, row count in the initial `<tbody>` is capped at
  `pageSize`, and the full row set (beyond `pageSize`) is present in
  the embedded payload for the client-side pagination to read.

**Layer 2 (`notsobigtests`)** — new fixture (written before the
`src/publish.js` change, per this repo's existing connector-facing
convention) exercising one `raw` and one `aggregated` table against a
real BigQuery table with more rows than one `pageSize`, confirming the
generated `.html`'s first page renders correctly and that clicking
"Next" in a real browser shows the next slice (a human-run check —
Apps Script/Drive file behavior isn't fakeable headless, same
constraint every other Layer 2 case already has).

## 8. Docs impact

- `docs/publish.md` gets a new `### tables[]` section (both modes,
  worked example, the `pageSize`/pagination behavior, the `format`
  enum widened by `'string'`), and its "What's not here yet" list drops
  `table` block from the still-pending list.
- `src/publish.md` gets a short dev note: why `raw`/`aggregated` share
  one `{columns, rows}` payload shape and one render/pagination path
  instead of two.
- No README change needed — `docs/publish.md` is already linked from
  there; this is a new section in an existing linked doc, not a new
  doc.

## Explicitly not designed here

Column-header sort, search/filter, CSV export, and everything else
still deferred (`filters`, `expandable`/`detail`, per-block `source`
override, `linkTo`, `layout: 'board'`) — each gets its own brainstorm
per the v1 spec's "Future direction", in the build order already
agreed: `table` (this spec) → per-block `source` override → `filters`
→ `expandable`/`detail` → `linkTo` → CSV export → `layout: 'board'`.
