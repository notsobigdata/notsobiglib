# `publish` — `detail` drill-down — design

Delivery #4 of the `publish` roadmap left open by
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
direction": `filters`, per-block `source` override, `linkTo`, a `table`
block, and CSV export are all shipped now. This spec covers the
remaining `expandable`/`detail` drill-down item — letting an aggregated
`tables[]` row or a `charts[]` group open a modal listing the raw rows
behind it, without leaving the report or firing a query.

`layout: 'board'` remains the one item still deferred past this spec.

## 1. Purpose and non-goals

Today, an aggregated `tables[]` row or a `charts[]` bar/slice/point shows
only the aggregate (a sum, a count) — there is no way to see which raw
rows produced it without opening the underlying BigQuery table directly.
This spec adds an opt-in `detail` block that, on click, shows exactly
those raw rows in a modal, formatted the same way a raw-mode `tables[]`
block already formats its columns.

Non-goals: pagination inside the modal (a group's raw rows render in
full, same posture as the rest of `publish`'s "no query cost, everything
already fetched" model), editing/exporting from the modal (CSV export
stays a `tables[]`-block-level feature), and any change to how
`linkKey`/`seriesLinkKey`/`linkTo` behave when `detail` isn't present.

## 2. Config shape and where `detail` applies

```javascript
tables: [{
  id: 'sales_by_region', mode: 'aggregated', groupBy: 'region',
  metrics: [{ label: 'Total', agg: 'sum', field: 'amount' }],
  detail: { columns: [
    { field: 'order_id', label: 'Order' },
    { field: 'amount', label: 'Amount', format: 'currency' }
  ] }
}],
charts: [{
  id: 'sales_chart', type: 'bar', groupBy: 'region',
  metric: { agg: 'sum', field: 'amount' },
  detail: { columns: [
    { field: 'order_id', label: 'Order' },
    { field: 'amount', label: 'Amount', format: 'currency' }
  ] }
}]
```

`detail.columns` reuses the exact shape of a raw-mode `table.columns`
entry (`{field, label, format}` — `label` defaults to `field`, `format`
defaults to `'string'`, same `PUBLISH_VALUE_FORMATS` enum). This is
deliberate: the modal's sub-table is rendered by calling
`buildRawTablePayload({columns: detail.columns}, groupRows)` — the exact
function that already renders a raw-mode `tables[]` block, given a
synthetic single-purpose "table config". No new formatting logic.

- Valid on `charts[]` (`bar`, `line`, `pie`) and on `tables[]` entries
  with `mode: 'aggregated'` only. A `detail` on a `mode: 'raw'` table is
  a validation error — a raw table already shows one row per line, there
  is nothing to drill into.
- On a chart, `detail` is mutually exclusive with `linkKey`,
  `seriesLinkKey`, and `linkTo` — see §4.
- `detail` does not conflict with a block's own `source` override or
  `reactsTo` — it is orthogonal to where a block's rows come from, only
  to what happens on click.

## 3. Data flow

`payload.rows` (the report's full raw row set) is today only embedded
when `config.filters.length` — otherwise only the pre-aggregated
kpis/charts/tables data reaches the browser, keeping the file small.
`detail` needs the raw rows behind a specific group, which the server
already partitions via `groupRowsBy` during aggregation but never
retains past computing the aggregate.

Rather than a blanket "always embed all rows" (unconditionally growing
every report's file size) or a static per-group precomputed structure
(which would go stale the moment `reactsTo` recomputes the block against
a filtered subset), each block that declares `detail` gets its **own**
raw rows embedded in its own payload entry — `table.rows` /
`chart.rows`, alongside the block's existing aggregated `rows`/`data`.
These are exactly the rows `rowsForBlock` already resolved for that
block (respecting a `source` override, same rows the aggregation itself
ran against) — no new fetch, no new resolution path.

Grouping and formatting both need to run again client-side, once, at
click time — and both already do, for a different reason: `groupRowsBy`
and `buildRawTablePayload` are already serialized into every report's
`<script>` via `FILTER_REUSED_FUNCTIONS_JS` (`reactsTo`'s client-side
recompute already needs them). Opening a modal is therefore just:

1. Take the clicked block's `rows`.
2. Filter to `row[groupBy] === groupValue` (and, when a chart has
   `series` and the click was on a specific segment, additionally
   `row[series] === seriesValue` — the same specificity
   `seriesLinkKey` already uses for its own selection).
3. `buildRawTablePayload({columns: detail.columns}, matchingRows)`.
4. Render the result into the modal.

No new aggregation or formatting code — only a click handler and the
modal itself. A side effect worth calling out: because step 1 always
reads the block's *current* `rows` (not a value snapshotted at generation
time), a `reactsTo` block's modal automatically reflects whatever filter
is currently active, with no extra wiring.

## 4. Validation and mutual exclusion

A new `validateDetail(blockType, blockId, block)` helper, following the
existing `validateReactsTo`/`validateBlockSource` convention (one focused
function per optional feature, called from each of the three
`validatePublishConfig` loops that applies to):

- `block.detail`, when present, must be `{ columns: [...] }` with a
  non-empty `columns` array; each entry needs `field` (`label`/`format`
  optional, `format` must be one of `PUBLISH_VALUE_FORMATS` if given —
  identical checks to a raw table's own column validation).
- `tables[]` only: `detail` on a `mode: 'raw'` table throws.
- `charts[]` only: `detail` together with `linkKey`, `seriesLinkKey`, or
  `linkTo` throws. This extends the existing three-way check at
  `src/publish.js`'s chart validation (today: `linkTo` vs.
  `linkKey`/`seriesLinkKey`) into a four-way check — a chart declares at
  most one of `{linkKey/seriesLinkKey, linkTo, detail}`, never two. No
  change to how `linkKey`/`seriesLinkKey`/`linkTo` behave when `detail`
  isn't present.

## 5. UI and interaction

- One generic `openDetailModal(title, columns, rows)` in a new
  `DETAIL_CLIENT_JS` client-script block, shared by both entry points
  below. The modal is a single DOM node created on first use, closed via
  an "×" button, the Escape key, or a click on the backdrop.
- **Aggregated table**: each row gains a leading cell with a "▸" button,
  only when `table.detail` is set (`renderTableSection` already builds
  one `<tr>` per row — this adds one conditional cell). Clicking it opens
  the modal titled with that row's group value.
- **Chart**: reuses the existing `handleChartClick` dispatch, which
  today branches between highlighting (`linkKey`/`seriesLinkKey`) and
  navigating (`linkTo`). A third branch, `chart.detail`, calls
  `openDetailModal` instead. `interactive` (today
  `!!(chart.linkKey || chart.seriesLinkKey || chart.linkTo)`, controls
  cursor/pointer-events) gains `|| chart.detail`.
- No new dependency — the modal is plain HTML/CSS/JS, matching the rest
  of `publish`'s zero-CDN-except-D3 posture.

## 6. Testing

**Layer 1** (`test/publish.test.js`, Node/headless) covers everything
pure: `validateDetail` rejecting `detail` on a raw table, rejecting
`detail` combined with each of `linkKey`/`seriesLinkKey`/`linkTo` on a
chart, accepting `detail` alone on an aggregated table and on a chart,
and the built payload carrying a block's raw `rows` when (and only when)
that block declares `detail` — every other block's payload stays exactly
as small as before. The generated HTML/`<script>` gets regex-based
assertions (the "▸" button markup, `chart.detail` reaching
`CHART_CLIENT_JS`'s output) plus one test that runs the real emitted
script in a `vm` context — same pattern `filters[]`'s reset-to-All
regression test already uses — to catch a real click producing the
right modal contents, not just the right markup shape.

**Layer 2** (`notsobigtests`, human-run) gets a fixture with one
aggregated table and one chart, both declaring `detail`, confirmed by
hand in the browser: expanding a table row and clicking a chart group
each open a modal with the right columns and the right underlying rows,
and (if the block also declares `reactsTo`) the modal reflects the
currently active filter rather than the full unfiltered group.

## Future direction (not designed here)

`layout: 'board'` — a `relatesTo`-driven tree auto-layout — remains the
only item left from the original "Future direction" list, and is exactly
the kind of decision better made after seeing this delivery's actual
output than speculated now.
