# `publish` — client-side `filters[]` — design

This is the `filters[]` work the D3/interactivity specs (`docs/superpowers/
specs/2026-09-05-publish-kind-design.md`, `docs/superpowers/specs/
2026-09-06-publish-chart-interactivity-design.md`) both deferred as "still
needs its own brainstorming pass". Where the interactivity phase built a
purely visual, no-recomputation click-to-highlight between charts, this
phase adds real recomputation: a dropdown per declared filter field that
recomputes any KPI/chart/table that opts into it, entirely client-side, no
new BigQuery call, no page reload.

`linkTo` (cross-file navigation with query-string filter propagation),
`scatter`/other new chart types, `expandable`/`detail` drill-down,
per-block `source` override, and `layout: 'board'` remain separate future
work, untouched by this spec.

## 1. Purpose and non-goals

Today, `buildReportPayload` computes KPI values, chart data, and table
rows once, server-side, at generation time; the embedded
`window.__PUBLISH_PAYLOAD__` carries only those already-aggregated
results (plus, for a `raw`-mode table, that table's own full row set,
pre-formatted). Nothing lets a viewer change which rows a KPI/chart/table
is computed from without a fresh `cli('run')`.

This phase adds:
- A `filters[]` config array: each entry is one dropdown (`field` +
  `label`), rendered above the KPI cards.
- A `reactsTo: string[]` key on any `kpi`/`chart`/`table` entry, naming
  which declared filter fields that block honors.
- Changing a filter's dropdown recomputes every block whose `reactsTo`
  intersects the filters currently set to a non-"All" value, against the
  underlying rows filtered by those fields (AND across fields), and
  re-renders just that block — no reload, no other block affected unless
  it also opted in.

Non-goals for this phase:
- **No range/multi-select filters.** Every filter is a single-select,
  exact-match dropdown over the field's distinct values. A numeric range
  or multi-value filter is future work if a real report needs one.
- **No filter state in the URL / no `linkTo`.** A filter selection lives
  only in page JS state; refreshing the page resets every filter to
  "All". Query-string persistence is `linkTo`'s territory, not this
  phase's.
- **No cross-report / cross-file behavior.** Everything here is confined
  to one generated `.html` file, same as every other `publish` feature so
  far.
- **No implicit/default `reactsTo`.** A block with no `reactsTo` (or an
  empty array) never recomputes — same opt-in-only posture
  `linkKey`/`seriesLinkKey` already established, for the same reason: a
  report author should never be surprised by a block moving that they
  didn't ask to move.
- **No dedup between `payload.rows` and a `raw`-mode table's own
  `table.rows`.** When both a `filters[]` config and a raw table are
  present, the same row data ends up embedded twice (once raw for
  filtering, once pre-formatted for that table's initial paint). This is
  a known, accepted size cost — see §9.

## 2. Schema

```ts
filters?: {
  field: string;    // a column name in the source table
  label: string;    // dropdown label
}[];

kpis?: { /* ...existing fields... */ reactsTo?: string[] }[];
charts?: { /* ...existing fields... */ reactsTo?: string[] }[];
tables?: { /* ...existing fields... */ reactsTo?: string[] }[];
```

Worked example:

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
  { id: 'orders', title: 'Orders', mode: 'raw', columns: [...],
    reactsTo: ['category_name', 'channel'] }
]
```

- `filters[].field`/`.label` are both required strings; `field` must be
  unique across `filters[]` (same "duplicate id" convention `charts[]`/
  `tables[]` already enforce for their own `id`).
- `reactsTo` entries must each match a declared `filters[].field` —
  validation throws on a typo rather than silently no-opping (see §6).
- A filter's dropdown options are **not** configured — they're derived
  from the source table's actual distinct values for that field (see
  §3), the same "the data drives it, not the config" posture `charts[]`'
  `groupBy` values already have.

## 3. Payload additions

`buildReportPayload` gains two new top-level payload keys, **both
present only when `config.filters.length > 0`** — zero cost, zero new
markup, zero new client script for any report that doesn't declare
`filters[]`:

- `payload.rows` — the full row set exactly as `fetchTableRows` returned
  it (raw string-typed BigQuery values, same shape `computeAggregate`
  already coerces via `Number(row[field]) || 0`). This is the "underlying
  rows" every filterable block re-aggregates from.
- `payload.filters` — one entry per `config.filters[]`, each
  `{ field, label, options: string[] }`, `options` being that field's
  distinct values across all rows, sorted alphabetically (`Array.sort()`
  on the stringified values — plain ascending string sort is enough for
  a dropdown; no numeric-aware sort like `compareGroupValues` needed
  here, since this list is for picking a value, not plotting one).

`payload.kpis`/`payload.charts`/`payload.tables` gain no new fields for
this phase — each already-computed entry there is unchanged, still the
unfiltered ("All") state, used for the report's first paint. What's new
is that `renderReportHtml` also embeds each filterable block's **original
declared config** (not its computed payload) under a new
`payload.filterableConfig = { kpis, charts, tables }`, restricted to only
the entries that declared a non-empty `reactsTo` — the client needs the
original `kpi`/`chart`/`table` config object (its `agg`/`field`/`format`,
`groupBy`/`metric`/`type`/`series`/`stacking`, `mode`/`columns`/`groupBy`/
`metrics`/`pageSize`) to re-call the same build functions against
filtered rows; a block that never opted in needs none of this and is
omitted, keeping this new payload section as small as the feature's
actual footprint.

## 4. Client-side aggregation reuse — `Function.prototype.toString()`

`computeAggregate`, `groupRowsBy`, `compareGroupValues`, `formatValue`,
`buildChartPayload`, `buildRawTablePayload`, `buildAggregatedTablePayload`,
and the two small helpers they call (`emptyMap`, `has`) are already plain
JS with zero GAS-only API calls (`BigQuery.*`, `DriveApp.*`, etc.) —
nothing about them is Apps-Script-specific.

Rather than hand-port a second copy into a client JS string (this file's
existing `CHART_CLIENT_JS`/`TABLE_CLIENT_JS` convention, but a second
copy is a second place to fix the same bug — exactly the class of drift
this repo's own "fix it once, where all callers route through" principle
warns about), `renderReportHtml` serializes these functions' own source
text — `[computeAggregate, groupRowsBy, compareGroupValues, formatValue,
buildChartPayload, buildRawTablePayload, buildAggregatedTablePayload,
emptyMap, has].map(function (fn) { return fn.toString(); }).join('\n')`
— and injects it verbatim into a new client script block, only when
`config.filters.length > 0`. A named function declaration's `.toString()`
output is itself valid top-level source (`function foo() {...}`), so this
requires no wrapping — the emitted text drops straight into the
`<script>` tag as a set of ordinary function declarations, hoisted and
callable exactly like every other function `CHART_CLIENT_JS`/
`TABLE_CLIENT_JS` already define. Any future change to any of these nine
functions (a new `agg`, a formatting fix, a new table mode) is
automatically correct on both sides forever — there is no second
implementation to remember to update.

**Constraint on future edits to these nine functions:** because they're
now shipped to the browser, they must stay free of GAS-only globals
(`BigQuery`, `DriveApp`, `Utilities`, etc.) forever, not just today — a
future change that adds one to any of these nine functions breaks
`filters[]` in the browser at report-view time, not at `cli('run')` time,
so it wouldn't be caught by this library's own Node tests. This is called
out explicitly in `src/publish.md` as the one rule to check before
touching any of these nine functions.

## 5. Client filter UI, composition, and re-render

**Markup.** `renderReportHtml` renders one `<div class="filters">`
section, right above `.kpis`, only when `payload.filters.length > 0` —
one `<label>` + `<select>` pair per filter, a leading `<option>` for
"All", then one `<option>` per that filter's `options`.

**State.** A new client module (added to the same script block as §4's
reused functions, only when filters are present): module-level
`activeFilters`, a plain object mapping `field -> value` for every filter
currently NOT set to "All" (a filter set back to "All" is deleted from
the object, not stored as `null` — keeps the "intersect declared keys
with active filter keys" check in §5 a plain `Object.keys` check, mirroring
`applyHighlight`'s existing `currentSelection` intersection logic from the
chart-interactivity phase).

**On any filter `<select>`'s `change` event**, `applyFilters()` runs:
1. Update `activeFilters` from the changed select's value.
2. For each block listed in `payload.filterableConfig` (kpis, charts,
   tables — each already restricted to `reactsTo`-bearing entries, §3):
   compute `relevant = block.reactsTo.filter(function (f) { return
   has(activeFilters, f); })`. If `relevant.length === 0`, leave that
   block exactly as currently rendered (no-op — this is what makes a
   block with `reactsTo: ['channel']` correctly ignore a `category`-only
   filter change, and what makes a filter reset to "All" fall back to
   every row once no field it's known for is active).
3. Otherwise, filter `payload.rows` to only rows matching every entry in
   `relevant` (`rows.filter(function (row) { return relevant.every(
   function (f) { return row[f] === activeFilters[f]; }); })`), then
   recompute that one block with the reused functions from §4:
   - **kpi:** `computeAggregate(filteredRows, kpi.agg, kpi.field)` +
     `formatValue(...)`, written into that KPI card's `.kpi-value`
     `textContent`.
   - **chart:** `buildChartPayload(chart, filteredRows)`, then the
     container `#chart-<id>` is cleared (`while (firstChild)
     removeChild(firstChild)`, the same pattern `TABLE_CLIENT_JS`'s pager
     already uses to clear `<tbody>` — no `innerHTML`) and re-drawn via
     the existing `drawBarChart`/`drawLineChart`/`drawPieChart` (already
     plain functions taking `containerId, chart` — no signature change
     needed, they just get called again instead of once).
   - **table:** `buildRawTablePayload`/`buildAggregatedTablePayload`
     (mode-dispatched, same as server-side `buildReportPayload` does)
     produces a fresh `{columns, rows}`; `TABLE_CLIENT_JS`'s existing
     per-section closure is extended with one exposed function,
     `replaceTableData(newTable)`, that swaps its closed-over `table`
     variable, resets `page = 0`, and calls its existing `render()` — no
     new pagination logic, this phase only adds the one entry point that
     feeds it new data.
4. `currentSelection` (chart-interactivity's click-highlight state, if
   the report also uses `linkKey`/`seriesLinkKey`) is reset to `null` and
   `applyHighlight()` re-runs, since a filter change can remove the
   currently-selected value's rows entirely — stale highlighting on data
   that may no longer exist is worse than clearing it.

**Not touched by a filter change:** any block with no `reactsTo`, the
`renderChartFallback` no-D3 path (stays static — filters require the
already-loaded aggregation functions and D3 redraw, neither available
when `typeof d3 === 'undefined'`), and any `raw`-mode table's own CSV
export (still exports whatever is currently loaded into that table's
`rows`, filtered or not — consistent with "export what's currently
shown/loaded", not a new "export unfiltered" mode).

## 6. Validation

`validatePublishConfig` gains, following the existing per-block-loop
convention:

- A `filters` loop: every entry needs `field` and `label`
  (`publish(): every filter needs "field" and "label".`); duplicate
  `field` throws (`publish(): duplicate filter field "<field>".`).
- Inside the existing `kpis`/`charts`/`tables` loops: if `reactsTo` is
  present, it must be a non-empty array, and every entry must match a
  `field` from `config.filters` (`publish(): "<block>" has "reactsTo:
  [...]", but "<name>" is not a declared filter field.` — validated
  against the filter list collected earlier in the same
  `validatePublishConfig` call, so `filters[]` must be declared before
  this check runs, which it is: the `filters` loop above runs first).

## 7. Docs and build impact

- `docs/publish.md`: new `## Filters` section (schema from §2, worked
  example, the "distinct values, not configured" note from §2, the
  `reactsTo` opt-in convention, and the known no-URL-persistence /
  no-range-filter limitations from §1). "What's not here yet" updates to
  drop `filters[]` from the remaining list and keep `linkTo` and the rest.
- `src/publish.md`: dev-notes addition covering the `toString()` reuse
  mechanism (§4) and its constraint (no GAS-only globals in those nine
  functions, ever), plus the `activeFilters`/`reactsTo`-intersection
  model (§5), written the same way the chart-interactivity phase's dev
  notes flagged its own "most likely to be gotten backwards" detail.
- No `README.md` change — this doesn't change the offline/CDN story
  Phase 1's D3 spec already documented there.
- No new file in `build.sh`'s `MODULES` manifest — stays inside the
  existing `src/publish.js`.

## 8. Testing

**Layer 1 (Node):**
- `validatePublishConfig`: new fixtures/tests for each new throw case in
  §6 (missing `field`/`label`, duplicate filter field, `reactsTo`
  referencing an undeclared field).
- `buildReportPayload`: a config with `filters[]` produces
  `payload.rows` and `payload.filters[].options` (sorted, distinct); a
  config with `filters: []` (or omitted) produces neither key at all —
  not present, not an empty array, matching this spec's "zero cost when
  unused" requirement from §3.
- `filterableConfig` passthrough: only `reactsTo`-bearing kpis/charts/
  tables appear under `payload.filterableConfig`; a block without
  `reactsTo` is absent from it even when `filters[]` is otherwise
  configured.
- `renderReportHtml`: regex-checked that the nine reused functions'
  source text (§4) and the new filter `<select>`/`applyFilters` client
  module appear in the emitted script exactly when `config.filters.length
  > 0`, and are fully absent otherwise. The actual guarantee is narrower
  than byte-for-byte identical output: a config with no `filters[]` gets
  no filters markup (`<div class="filters">`), no
  `FILTER_REUSED_FUNCTIONS_JS`/`FILTER_CLIENT_JS`, and no
  `payload.rows`/`.filters`/`.filterableConfig` keys — but `REPORT_CSS`'s
  small `.filters`/`.filter` rule additions and `TABLE_CLIENT_JS`'s
  always-on `__PUBLISH_TABLE_REPLACERS__` registration (present whenever
  any `tables[]` exist, regardless of `filters[]`) are unconditional,
  same "small always-on scaffolding" pattern `CHART_CLIENT_JS`'s
  selection module already established. This phase must not change the
  *filters-relevant* output for existing reports; it is not a claim that
  every byte of the report is untouched.

**Layer 2 (`notsobigtests`, human-run):** a fixture report with two
`filters[]` entries and at least one KPI, one chart, and one table each
declaring `reactsTo` for only one of the two filters (to exercise the
"ignores the filter it didn't opt into" path). `testLog` asks a human, in
a real browser: change the opted-into filter and confirm the KPI/chart/
table each recompute correctly against a manually-verified expected
value; confirm the block that didn't opt into that filter is unaffected;
change the other filter and confirm the reverse; set both filters back to
"All" and confirm every block returns to its original, page-load value;
if the report also has `linkKey`/`seriesLinkKey` charts, click a highlight
after setting a filter and confirm the highlight is still relative to the
now-filtered data (or cleared, per §5 step 4, if the previously-selected
value no longer has any matching rows).

## 9. Known limitations (documented, not solved here)

- **`payload.rows` duplicates a `raw`-mode table's own embedded rows.**
  When a report has both `filters[]` and a `raw` table, the same
  underlying data is embedded twice in the generated HTML (once as
  `payload.rows` for filtering, once pre-formatted inside that table's
  own `table.rows`). No dedup is attempted — this phase's scope is
  correctness and a working feature, not payload-size optimization; a
  future change could special-case this if a real report's file size
  becomes a problem.
- **No filter-state persistence.** Reloading the page, or opening the
  file fresh from Drive, always starts every filter at "All". `linkTo`
  (future work, §"Future direction") is where cross-file /
  cross-page-load state would need to live.
- **Exact-match dropdowns only.** No numeric range, no date range, no
  multi-select/"any of" filter. A field with many distinct values (e.g.
  a free-text column) produces a long, unwieldy dropdown — this phase
  doesn't guard against that; a report author choosing a bad `field` for
  `filters[]` is a config-authoring mistake, not something the library
  validates against, the same posture `groupBy` already has for charts.

## Future direction (not designed here)

`linkTo` (cross-file navigation with query-string filter propagation,
presumably seeded from this phase's `activeFilters` shape) remains
future work, still needing its own brainstorming pass. Range/multi-select
filters, filter-state persistence, per-block `source` override, and
`layout: 'board'` all remain out of scope, per the same convention every
prior `publish` spec has applied to each of these.
