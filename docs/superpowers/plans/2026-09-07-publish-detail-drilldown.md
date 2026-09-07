# `publish` detail drill-down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an aggregated `tables[]` row or a `charts[]` group open a modal listing the raw rows behind it, via an opt-in `detail: { columns: [...] }` config.

**Architecture:** Author-facing `detail` config is validated like `reactsTo`/`source` (a small pure `validateDetail` helper called from each block loop). At payload-build time, a new `withDetail(built, block, rows)` helper attaches `{groupBy, series, columns, rows}` to any block that declared `detail`, reusing the block's own already-resolved rows (respecting `source` override and, on recompute, the currently active `reactsTo` filter). Client-side, a new `DETAIL_CLIENT_JS` block provides one generic `openDetailModal`, wired from two places: a "▸" toggle button added to aggregated table rows (`TABLE_CLIENT_JS`), and a third branch in the existing `handleChartClick` dispatch (`CHART_CLIENT_JS`), both filtering the block's own embedded raw rows by `groupValue`/`seriesValue` and re-running the already-shipped `buildRawTablePayload` to format the modal's contents.

**Tech Stack:** Plain JS (GAS-compatible, ES5-style, `var`/function declarations), Node `vm`-based Layer 1 tests (`test/publish.test.js`), human-run Apps Script Layer 2 (`notsobigtests`).

**Spec:** `docs/superpowers/specs/2026-09-07-publish-detail-drilldown-design.md`

## Global Constraints

- Every new validation error follows the exact convention already in `validatePublishConfig`: `throw new Error('publish(): ' + ...)`.
- `detail` is valid only on `charts[]` (any type) and `tables[]` with `mode: 'aggregated'`; a `kpi` or a raw-mode table declaring `detail` is a validation error.
- On a chart, `detail` is mutually exclusive with `linkKey`, `seriesLinkKey`, and `linkTo` — a chart declares at most one click behavior.
- No new dependency, no CDN beyond the existing pinned D3 script. The modal is plain DOM (`document.createElement`/`textContent`), never `innerHTML`, matching this file's existing rule for payload-sourced markup.
- Every client-side function referenced from generated HTML must be GAS-safe when it runs in Node too (no `BigQuery`/`DriveApp`/`Utilities` reference) since it reaches the browser via `.toString()`.
- Run `./build.sh` after every `src/publish.js` change before running Node tests — `test/harness.js` loads the committed `src.js`, not `src/` directly.
- `git commit` after each task, on branch `feat/publish-detail-drilldown` (already created off `release/16`, spec already committed at `24649c7`).

---

### Task 1: `validateDetail` + validation wiring

**Files:**
- Modify: `src/publish.js` (add `validateDetail` near `validateBlockSource`, wire into all three `validatePublishConfig` loops)
- Modify: `test/fixtures/publish-nodes.js` (new fixtures)
- Modify: `test/publish.test.js` (new tests + `module.exports`)

**Interfaces:**
- Produces: `function validateDetail(blockType, blockId, detail)` — throws if `detail` is malformed; no-op if `detail === undefined`. Later tasks (payload augmentation) read the *original* `block.detail` shape (`{columns: [{field, label, format}]}`), unchanged by this task.

- [ ] **Step 1: Write the failing validation tests**

Add to `test/publish.test.js`, right after `testPublishBlockSourceOverrideFetchesFromItsOwnRef` (before `testPublishFilterRequiresFieldAndLabel`, around line 881):

```javascript
function testPublishKpiDetailRejected() {
  var result = runOne('kpiWithDetailPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/kpi "Total revenue" has "detail", which only "chart" and "table" support/.test(result.error), 'expected a kpi-detail-unsupported error, got: ' + result.error);
}

function testPublishDetailRequiresNonEmptyColumns() {
  var result = runOne('detailEmptyColumnsPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"detail", which must be \{ columns: \[\.\.\.\] \} with a non-empty "columns" array/.test(result.error), 'expected a detail-columns error, got: ' + result.error);
}

function testPublishDetailColumnRequiresField() {
  var result = runOne('detailColumnMissingFieldPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/has a detail column missing "field"/.test(result.error), 'expected a detail-column-field error, got: ' + result.error);
}

function testPublishDetailColumnFormatMustBeKnownEnum() {
  var result = runOne('detailColumnBadFormatPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/detail column "amount" has format "percent" - expected one of string, currency, integer, decimal/.test(result.error), 'expected a detail-column-format error, got: ' + result.error);
}

function testPublishDetailOnRawTableRejected() {
  var result = runOne('detailOnRawTablePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/table "raw_with_detail" has "detail", which only "aggregated" tables support/.test(result.error), 'expected a detail-on-raw-table error, got: ' + result.error);
}

function testPublishChartDetailCannotCombineWithLinkKey() {
  var result = runOne('chartDetailWithLinkKeyPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/both "detail" and "linkKey"\/"seriesLinkKey" - these are mutually exclusive/.test(result.error), 'expected a detail/linkKey mutual-exclusion error, got: ' + result.error);
}

function testPublishChartDetailCannotCombineWithLinkTo() {
  var result = runOne('chartDetailWithLinkToPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/both "detail" and "linkTo" - these are mutually exclusive/.test(result.error), 'expected a detail/linkTo mutual-exclusion error, got: ' + result.error);
}

function testPublishValidDetailProceedsPastValidation() {
  var result = runOne('detailPublish');
  // Same proof pattern as testPublishValidRefProceedsPastValidation: no
  // BigQuery shim in this test, so a config that gets all the way past
  // validation fails next at the un-shimmed BigQuery call, not at
  // validation.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation to pass and fail only at the BigQuery call, got: ' + result.error);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/run.js`
Expected: FAIL — the 8 new tests fail with something like "cli(): node 'kpiWithDetailPublish' - unknown node" (fixtures don't exist yet) or assertion mismatches once fixtures are added but validation isn't.

- [ ] **Step 3: Add the fixtures**

Add to `test/fixtures/publish-nodes.js`, after `blockSourceWithReactsToPublish` (end of file):

```javascript
var kpiWithDetailPublish = {
  kind: 'publish',
  name: 'kpiWithDetailPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'kpi-detail.html' },
  kpis: [{ label: 'Total revenue', agg: 'sum', field: 'revenue', format: 'currency', detail: { columns: [{ field: 'order_id' }] } }]
};

var detailEmptyColumnsPublish = {
  kind: 'publish',
  name: 'detailEmptyColumnsPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-empty-columns.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, detail: { columns: [] } }]
};

var detailColumnMissingFieldPublish = {
  kind: 'publish',
  name: 'detailColumnMissingFieldPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-column-missing-field.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, detail: { columns: [{ label: 'No field' }] } }]
};

var detailColumnBadFormatPublish = {
  kind: 'publish',
  name: 'detailColumnBadFormatPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-column-bad-format.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, detail: { columns: [{ field: 'amount', format: 'percent' }] } }]
};

var detailOnRawTablePublish = {
  kind: 'publish',
  name: 'detailOnRawTablePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-on-raw.html' },
  tables: [{ id: 'raw_with_detail', title: 'Raw', mode: 'raw', columns: [{ field: 'revenue' }], detail: { columns: [{ field: 'revenue' }] } }]
};

var chartDetailWithLinkKeyPublish = {
  kind: 'publish',
  name: 'chartDetailWithLinkKeyPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-with-linkkey.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkKey: 'category', detail: { columns: [{ field: 'order_id' }] } }]
};

var chartDetailWithLinkToPublish = {
  kind: 'publish',
  name: 'chartDetailWithLinkToPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-with-linkto.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'linkToTargetPublish', field: 'category' }, detail: { columns: [{ field: 'order_id' }] } }]
};

// Valid: one aggregated table and one chart, each with a well-formed
// detail. Used by both testPublishValidDetailProceedsPastValidation
// (no shim - proves validation passes) and Task 2's payload tests (with
// a shim, to inspect the built .detail objects).
var detailPublish = {
  kind: 'publish',
  name: 'detailPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    detail: { columns: [{ field: 'order_id', label: 'Order' }, { field: 'revenue', label: 'Revenue', format: 'currency' }] } }],
  tables: [{ id: 'by_category_table', title: 'By category', mode: 'aggregated', groupBy: 'category',
    metrics: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }],
    detail: { columns: [{ field: 'order_id', label: 'Order' }, { field: 'revenue', label: 'Revenue', format: 'currency' }] } }]
};
```

- [ ] **Step 4: Add `validateDetail` and wire it into `validatePublishConfig`**

In `src/publish.js`, add right after `validateBlockSource` (after line 76, before the `validatePublishConfig` comment):

```javascript
// A kpi/chart/table's own "detail" drill-down config - { columns: [...] },
// same column shape as a raw table's own columns (field/label/format).
// Shape-only check; the "which block types may have detail at all" rule
// (charts always, aggregated tables only, never kpis) is enforced at
// each call site below since the restriction differs per block type.
function validateDetail(blockType, blockId, detail) {
  if (detail === undefined) {
    return;
  }
  if (!Array.isArray(detail.columns) || !detail.columns.length) {
    throw new Error('publish(): ' + blockType + ' "' + blockId + '" has "detail", which must be { columns: [...] } with a non-empty "columns" array.');
  }
  detail.columns.forEach(function (column) {
    if (!column.field) {
      throw new Error('publish(): ' + blockType + ' "' + blockId + '" has a detail column missing "field".');
    }
    if (column.format && PUBLISH_VALUE_FORMATS.indexOf(column.format) === -1) {
      throw new Error('publish(): ' + blockType + ' "' + blockId + '" detail column "' + column.field + '" has format "' + column.format + '" - expected one of ' + PUBLISH_VALUE_FORMATS.join(', ') + '.');
    }
  });
}
```

In the kpis loop, right after the existing `validateBlockSource('kpi', kpi.label, kpi, config.dependsOn);` (line 117):

```javascript
    if (kpi.detail) {
      throw new Error('publish(): kpi "' + kpi.label + '" has "detail", which only "chart" and "table" support.');
    }
```

In the charts loop, right after the existing `linkTo` block closes (after line 156, before `validateReactsTo('chart', ...)` on line 157):

```javascript
    if (chart.detail) {
      if (chart.linkKey || chart.seriesLinkKey) {
        throw new Error('publish(): chart "' + chart.id + '" has both "detail" and "linkKey"/"seriesLinkKey" - these are mutually exclusive.');
      }
      if (chart.linkTo) {
        throw new Error('publish(): chart "' + chart.id + '" has both "detail" and "linkTo" - these are mutually exclusive.');
      }
    }
    validateDetail('chart', chart.id, chart.detail);
```

In the tables loop, right after the existing `validateBlockSource('table', table.id, table, config.dependsOn);` (line 172), before `if (table.mode === 'raw') {`:

```javascript
    if (table.detail && table.mode !== 'aggregated') {
      throw new Error('publish(): table "' + table.id + '" has "detail", which only "aggregated" tables support.');
    }
    validateDetail('table', table.id, table.detail);
```

- [ ] **Step 5: Rebuild and run tests**

Run: `./build.sh && node test/run.js`
Expected: the 8 new tests pass; all previously-passing tests still pass (this step only adds new checks gated on a field, `detail`, no existing fixture sets).

- [ ] **Step 6: Add the 8 new tests to `module.exports`**

In `test/publish.test.js`, add all 8 new function names to `module.exports` (alphabetically near the other `testPublishBlockSource*`/`testPublishChart*` entries is fine — this file doesn't enforce an export order).

- [ ] **Step 7: Commit**

```bash
git add src/publish.js src.js test/fixtures/publish-nodes.js test/publish.test.js
git commit -m "feat: validate publish's detail drill-down config"
```

---

### Task 2: payload augmentation (`withDetail`)

**Files:**
- Modify: `src/publish.js` (`withDetail` helper, wire into `buildReportPayload` and `FILTER_CLIENT_JS`'s `applyFilterToChart`/`applyFilterToTable`, add to `FILTER_REUSED_FUNCTIONS_JS`)
- Modify: `test/publish.test.js` (payload-shape tests)

**Interfaces:**
- Consumes: `rowsForBlock(block, defaultRows, blockRowsByRef)` (existing, `src/publish.js:569`), `buildRawTablePayload`/`buildAggregatedTablePayload`/`buildChartPayload` (existing).
- Produces: `function withDetail(built, block, rows)` — mutates and returns `built`, adding `built.detail = { groupBy: block.groupBy, series: block.series, columns: block.detail.columns, rows: rows }` when `block.detail` is set; no-op otherwise. Task 3/4/5 read `block.detail.groupBy`/`.series`/`.columns`/`.rows` off the *rendered payload* (not the author config) via this exact shape.

- [ ] **Step 1: Write the failing payload tests**

Add to `test/publish.test.js`, right after `testPublishChartPayloadPassesThroughLinkKeys` (a good neighbor — same "payload carries block config through" theme):

```javascript
function testPublishDetailAttachedToChartAndTablePayloadsWhenConfigured() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'order_id', 'revenue'], [
    ['A', 'o1', '10'],
    ['A', 'o2', '20'],
    ['B', 'o3', '5']
  ]);
  var result = ctx.NotSoBigData.cli('run --select detailPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  var chart = payload.charts.filter(function (c) { return c.id === 'by_category'; })[0];
  assert.deepStrictEqual(chart.detail.groupBy, 'category');
  assert.strictEqual(chart.detail.series, undefined, 'expected no series field on a non-series chart');
  assert.deepStrictEqual(chart.detail.columns, [{ field: 'order_id', label: 'Order' }, { field: 'revenue', label: 'Revenue', format: 'currency' }]);
  assert.strictEqual(chart.detail.rows.length, 3, 'expected the chart\'s own resolved rows (all 3), got: ' + JSON.stringify(chart.detail.rows));

  var table = payload.tables.filter(function (t) { return t.id === 'by_category_table'; })[0];
  assert.deepStrictEqual(table.detail.groupBy, 'category');
  assert.strictEqual(table.detail.rows.length, 3, 'expected the table\'s own resolved rows (all 3), got: ' + JSON.stringify(table.detail.rows));
}

function testPublishNoDetailFieldOnPayloadWithoutDetailConfigured() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [['A', '10', 'o1']]);
  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  payload.tables.forEach(function (table) {
    assert.strictEqual(table.detail, undefined, 'expected no .detail on a table without "detail" configured, got: ' + JSON.stringify(table));
  });
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/run.js`
Expected: FAIL — `chart.detail`/`table.detail` are `undefined` (nothing attaches them yet).

- [ ] **Step 3: Add `withDetail` and wire it into `buildReportPayload`**

In `src/publish.js`, add right after `rowsForBlock` (after line 571, before `function buildReportPayload`):

```javascript
// Attaches a block's own "detail" drill-down data to its already-built
// payload object - {groupBy, series, columns, rows}, where `rows` is
// exactly the same resolved row set (rowsForBlock's result) the block's
// own aggregate/chart was computed from, so a group's detail always
// matches what's currently on screen. `series` is undefined for a table
// or a non-series chart - harmless, the client only reads it when a
// chart's own series field is also present. No-op (returns `built`
// unchanged) when the block didn't declare "detail" - kept in the same
// FILTER_REUSED_FUNCTIONS_JS list buildChartPayload/buildRawTablePayload/
// buildAggregatedTablePayload already live in, since a reactsTo block's
// client-side recompute (applyFilterToChart/applyFilterToTable below)
// needs to re-run this too, not just the server-side build.
function withDetail(built, block, rows) {
  if (block.detail) {
    built.detail = { groupBy: block.groupBy, series: block.series, columns: block.detail.columns, rows: rows };
  }
  return built;
}
```

Modify `buildReportPayload`'s `charts`/`tables` mapping (lines 580-586):

```javascript
  var charts = (config.charts || []).map(function (chart) {
    var chartRows = rowsForBlock(chart, rows, blockRowsByRef);
    return withDetail(buildChartPayload(chart, chartRows), chart, chartRows);
  });
  var tables = (config.tables || []).map(function (table) {
    var tableRows = rowsForBlock(table, rows, blockRowsByRef);
    var built = table.mode === 'raw' ? buildRawTablePayload(table, tableRows) : buildAggregatedTablePayload(table, tableRows);
    return withDetail(built, table, tableRows);
  });
```

- [ ] **Step 4: Rebuild and run tests**

Run: `./build.sh && node test/run.js`
Expected: both new tests pass; every previously-passing test still passes (`withDetail` is additive and only fires when `block.detail` is set - the fixtures used by every pre-existing test don't set it).

- [ ] **Step 5: Wire `withDetail` into the client-side recompute path**

This keeps a `reactsTo`+`detail` block's modal reflecting whatever filter is currently active, not a stale snapshot from generation time. Modify `FILTER_REUSED_FUNCTIONS_JS`'s array (line 668-671) to include `withDetail`:

```javascript
var FILTER_REUSED_FUNCTIONS_JS = [
  emptyMap, has, computeAggregate, groupRowsBy, compareGroupValues,
  formatValue, buildChartPayload, buildRawTablePayload, buildAggregatedTablePayload, withDetail
].map(function (fn) { return fn.toString(); }).join('\n');
```

Modify `applyFilterToChart` (lines 694-704) and `applyFilterToTable` (lines 705-710):

```javascript
  'function applyFilterToChart(chartConfig) {',
  '  var filteredRows = filteredRowsFor(chartConfig.reactsTo);',
  '  var newChart = withDetail(buildChartPayload(chartConfig, filteredRows), chartConfig, filteredRows);',
  '  var container = document.getElementById("chart-" + chartConfig.id);',
  '  if (!container) { return; }',
  '  while (container.firstChild) { container.removeChild(container.firstChild); }',
  '  if (typeof d3 === "undefined") { renderChartFallback(container.id, newChart); return; }',
  '  if (newChart.type === "line") { drawLineChart(container.id, newChart); }',
  '  else if (newChart.type === "pie") { drawPieChart(container.id, newChart); }',
  '  else { drawBarChart(container.id, newChart); }',
  '}',
  'function applyFilterToTable(tableConfig) {',
  '  var filteredRows = filteredRowsFor(tableConfig.reactsTo);',
  '  var newTable = withDetail(tableConfig.mode === "raw" ? buildRawTablePayload(tableConfig, filteredRows) : buildAggregatedTablePayload(tableConfig, filteredRows), tableConfig, filteredRows);',
  '  var replace = window.__PUBLISH_TABLE_REPLACERS__ && window.__PUBLISH_TABLE_REPLACERS__[tableConfig.id];',
  '  if (replace) { replace(newTable); }',
  '}',
```

(Only the `var newChart = ...` and `var newTable = ...` lines change; every other line in these two functions is unchanged.)

- [ ] **Step 6: Rebuild and run the full suite**

Run: `./build.sh && node test/run.js`
Expected: all tests still pass, including `testPublishFilterClientJsIncludesReusedAggregationFunctionsVerbatim` (it only asserts named functions are *present*, not an exhaustive list, so adding `withDetail` doesn't break it).

- [ ] **Step 7: Add the 2 new tests to `module.exports`, commit**

```bash
git add src/publish.js src.js test/publish.test.js
git commit -m "feat: attach detail drill-down rows to chart/table payloads"
```

---

### Task 3: modal client JS + conditional script assembly

**Files:**
- Modify: `src/publish.js` (`DETAIL_REUSED_FUNCTIONS_JS`, `DETAIL_CLIENT_JS`, `REPORT_CSS` additions, `renderReportHtml`'s script-assembly logic)
- Modify: `test/publish.test.js` (script-emission tests)

**Interfaces:**
- Produces: `DETAIL_CLIENT_JS` (string) defining `openDetailModal(title, columns, rows)` and `closeDetailModal()` in the browser. Task 4/5 call `openDetailModal` from their own click handlers - it must already be present in the emitted `<script>` whenever any block has `.detail`.
- Produces: `DETAIL_REUSED_FUNCTIONS_JS` (string) - `formatValue`+`buildRawTablePayload` serialized, for a report with `detail` but no `filters[]` (which would otherwise already ship a superset via `FILTER_REUSED_FUNCTIONS_JS`).

- [ ] **Step 1: Write the failing script-emission tests**

Add to `test/publish.test.js`, after `testPublishNoFiltersMarkupOrClientJsWithoutFilters`:

```javascript
function testPublishNoDetailScriptWithoutAnyDetailConfigured() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [['A', '10', 'o1']]);
  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(!/function openDetailModal/.test(html), 'expected no detail modal script without any detail configured, got: ' + html);
}

function testPublishDetailScriptEmittedWithoutFilters() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'order_id', 'revenue'], [['A', 'o1', '10']]);
  var result = ctx.NotSoBigData.cli('run --select detailPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  // detailPublish has no filters[] - proves DETAIL_REUSED_FUNCTIONS_JS
  // (not FILTER_REUSED_FUNCTIONS_JS) supplies buildRawTablePayload here.
  assert.ok(/function openDetailModal/.test(html), 'expected the detail modal script, got: ' + html);
  assert.ok(/function buildRawTablePayload/.test(html), 'expected buildRawTablePayload reused for the modal, got: ' + html);
  assert.ok(!/function applyFilters\(/.test(html), 'expected no filters[] client JS on a report with no filters[], got: ' + html);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/run.js`
Expected: `testPublishNoDetailScriptWithoutAnyDetailConfigured` already passes (nothing emits `openDetailModal` yet at all); `testPublishDetailScriptEmittedWithoutFilters` fails (no `openDetailModal`/no modal `buildRawTablePayload`).

- [ ] **Step 3: Add `DETAIL_REUSED_FUNCTIONS_JS` and `DETAIL_CLIENT_JS`**

In `src/publish.js`, add right after `FILTER_CLIENT_JS`'s closing `].join('\n');` (after line 755, before the `renderTableSection` comment):

```javascript
// The subset of FILTER_REUSED_FUNCTIONS_JS's functions the detail modal
// itself needs (buildRawTablePayload, and formatValue it calls) - shipped
// only when a report has "detail" but no filters[] at all, since
// FILTER_REUSED_FUNCTIONS_JS already ships a superset otherwise and
// declaring the same function twice in one <script> would be redundant
// (see renderReportHtml's hasFilters/hasDetail branch below).
var DETAIL_REUSED_FUNCTIONS_JS = [formatValue, buildRawTablePayload].map(function (fn) { return fn.toString(); }).join('\n');

// One generic modal, shared by the table-detail toggle (TABLE_CLIENT_JS)
// and the chart-detail click branch (CHART_CLIENT_JS's handleChartClick) -
// both already have their own {columns, rows} (buildRawTablePayload's
// output shape) by the time they call this, so this only ever renders,
// never computes. Built via createElement/textContent only, same rule as
// TABLE_CLIENT_JS's own row rendering.
var DETAIL_CLIENT_JS = [
  'function closeDetailModal() {',
  '  var modal = document.getElementById("publish-detail-modal");',
  '  if (modal) { modal.parentNode.removeChild(modal); }',
  '}',
  'function openDetailModal(title, columns, rows) {',
  '  closeDetailModal();',
  '  var backdrop = document.createElement("div");',
  '  backdrop.id = "publish-detail-modal";',
  '  backdrop.className = "detail-modal-backdrop";',
  '  backdrop.addEventListener("click", function (event) { if (event.target === backdrop) { closeDetailModal(); } });',
  '  var box = document.createElement("div");',
  '  box.className = "detail-modal";',
  '  var header = document.createElement("div");',
  '  header.className = "detail-modal-header";',
  '  var heading = document.createElement("h3");',
  '  heading.textContent = title;',
  '  var closeBtn = document.createElement("button");',
  '  closeBtn.type = "button";',
  '  closeBtn.className = "detail-modal-close";',
  '  closeBtn.textContent = "\\u00d7";',
  '  closeBtn.addEventListener("click", closeDetailModal);',
  '  header.appendChild(heading);',
  '  header.appendChild(closeBtn);',
  '  var table = document.createElement("table");',
  '  var thead = document.createElement("thead");',
  '  var headRow = document.createElement("tr");',
  '  columns.forEach(function (column) {',
  '    var th = document.createElement("th");',
  '    th.textContent = column.label;',
  '    headRow.appendChild(th);',
  '  });',
  '  thead.appendChild(headRow);',
  '  var tbody = document.createElement("tbody");',
  '  rows.forEach(function (row) {',
  '    var tr = document.createElement("tr");',
  '    row.forEach(function (cell) {',
  '      var td = document.createElement("td");',
  '      td.textContent = cell;',
  '      tr.appendChild(td);',
  '    });',
  '    tbody.appendChild(tr);',
  '  });',
  '  table.appendChild(thead);',
  '  table.appendChild(tbody);',
  '  box.appendChild(header);',
  '  box.appendChild(table);',
  '  backdrop.appendChild(box);',
  '  document.body.appendChild(backdrop);',
  '}',
  'document.addEventListener("keydown", function (event) { if (event.key === "Escape") { closeDetailModal(); } });'
].join('\n');
```

- [ ] **Step 4: Add modal/toggle CSS to `REPORT_CSS`**

In `src/publish.js`, add to the `REPORT_CSS` array (line 611-639), right before the closing `].join('\n');`:

```javascript
  '.table-detail-toggle { font-family: var(--mono); font-size: 12px; background: none; border: none; cursor: pointer; padding: 0 4px; }',
  '.detail-modal-backdrop { position: fixed; inset: 0; background: rgba(31, 36, 33, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }',
  '.detail-modal { background: var(--paper); border: 1px solid var(--paper-line); padding: 16px; max-width: 90vw; max-height: 80vh; overflow: auto; }',
  '.detail-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }',
  '.detail-modal-header h3 { margin: 0; font-size: 14px; }',
  '.detail-modal-close { font-family: var(--mono); font-size: 16px; background: none; border: none; cursor: pointer; }',
  '.detail-modal table { border-collapse: collapse; font-family: var(--mono); font-size: 12px; }',
  '.detail-modal th, .detail-modal td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--paper-line); }'
```

- [ ] **Step 5: Wire the conditional script assembly in `renderReportHtml`**

Modify `renderReportHtml` (lines 1114-1135). Replace:

```javascript
  var script = 'window.__PUBLISH_PAYLOAD__ = ' + JSON.stringify(payload).replace(/</g, '\\u003c') + ';';
  if (payload.tables.length) {
    script += TABLE_CLIENT_JS;
  }
  if (payload.charts.length) {
    script += CHART_CLIENT_JS;
  }
  if (payload.filters && payload.filters.length) {
    script += FILTER_REUSED_FUNCTIONS_JS + FILTER_CLIENT_JS;
  }
```

with:

```javascript
  var hasDetail = payload.tables.some(function (t) { return t.detail; }) || payload.charts.some(function (c) { return c.detail; });
  var hasFilters = !!(payload.filters && payload.filters.length);
  var script = 'window.__PUBLISH_PAYLOAD__ = ' + JSON.stringify(payload).replace(/</g, '\\u003c') + ';';
  if (payload.tables.length) {
    script += TABLE_CLIENT_JS;
  }
  if (payload.charts.length) {
    script += CHART_CLIENT_JS;
  }
  if (hasFilters) {
    script += FILTER_REUSED_FUNCTIONS_JS + FILTER_CLIENT_JS;
  } else if (hasDetail) {
    script += DETAIL_REUSED_FUNCTIONS_JS;
  }
  if (hasDetail) {
    script += DETAIL_CLIENT_JS;
  }
```

(`FILTER_REUSED_FUNCTIONS_JS` already includes `buildRawTablePayload`/`formatValue`, a superset of `DETAIL_REUSED_FUNCTIONS_JS` — the `else if` avoids declaring either function twice in one `<script>` when a report has both `filters[]` and `detail`.)

- [ ] **Step 6: Rebuild and run tests**

Run: `./build.sh && node test/run.js`
Expected: both new tests pass; every previous test still passes (`hasDetail`/`hasFilters` are additive local variables, and the `if (hasFilters) {...} else if (hasDetail) {...}` branch behaves exactly like the old `if (payload.filters...)` branch when `hasDetail` is false).

- [ ] **Step 7: Add the 2 new tests to `module.exports`, commit**

```bash
git add src/publish.js src.js test/publish.test.js
git commit -m "feat: add publish's detail drill-down modal client script"
```

---

### Task 4: table UI — detail toggle button

**Files:**
- Modify: `src/publish.js` (`renderTableSection`, `TABLE_CLIENT_JS`'s `render()` function and per-section listener wiring)
- Modify: `test/publish.test.js` (markup + script tests)

**Interfaces:**
- Consumes: `table.detail` (from Task 2's `withDetail`, shape `{groupBy, series, columns, rows}`), `openDetailModal` (Task 3).
- Produces: a `.table-detail-toggle` button per row (static and paginated), reading `data-group-value` off `row[0]` (the aggregated table's own groupBy value - already the raw, unformatted string per `buildAggregatedTablePayload`'s existing behavior).

- [ ] **Step 1: Write the failing tests**

Add to `test/publish.test.js`, after `testPublishTableHeadersSortableAndSearchInputRendered`:

```javascript
function testPublishTableDetailToggleRenderedOnlyWhenConfigured() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'order_id', 'revenue'], [['A', 'o1', '10'], ['B', 'o2', '5']]);
  var result = ctx.NotSoBigData.cli('run --select detailPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  var sectionMatch = html.match(/<section class="table-block" data-table-id="by_category_table">[\s\S]*?<\/section>/);
  assert.ok(sectionMatch, 'expected the by_category_table section in: ' + html);
  var section = sectionMatch[0];
  assert.ok(/class="table-detail-toggle"/.test(section), 'expected a detail toggle button, got: ' + section);
  assert.ok(/data-group-value="A"/.test(section), 'expected the toggle to carry the row\'s raw groupBy value, got: ' + section);
}

function testPublishNoTableDetailToggleWithoutDetailConfigured() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [['A', '10', 'o1']]);
  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(!/table-detail-toggle/.test(html), 'expected no detail toggle without detail configured, got: ' + html);
}

function testPublishTableClientJsOpensDetailModalOnToggleClick() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'order_id', 'revenue'], [['A', 'o1', '10']]);
  var result = ctx.NotSoBigData.cli('run --select detailPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/table\.detail/.test(html), 'expected TABLE_CLIENT_JS to reference table.detail, got: ' + html);
  assert.ok(/openDetailModal\(table\.title/.test(html), 'expected the toggle handler to call openDetailModal, got: ' + html);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/run.js`
Expected: `testPublishNoTableDetailToggleWithoutDetailConfigured` already passes; the other two fail (no toggle markup, no `table.detail`/`openDetailModal` reference in `TABLE_CLIENT_JS` yet).

- [ ] **Step 3: Add the toggle to `renderTableSection`**

Modify `renderTableSection` (lines 763-782):

```javascript
function renderTableSection(table) {
  var firstPageRows = table.rows.slice(0, table.pageSize);
  var pageCount = Math.max(1, Math.ceil(table.rows.length / table.pageSize));
  var headerCells = table.columns.map(function (column, index) {
    return '<th class="table-sortable" data-col-index="' + index + '">' + escapeHtml(column.label) + '</th>';
  }).join('');
  var detailHeaderCell = table.detail ? '<th></th>' : '';
  var bodyRows = firstPageRows.map(function (row) {
    var detailCell = table.detail ? '<td><button type="button" class="table-detail-toggle" data-group-value="' + escapeHtml(row[0]) + '">▸</button></td>' : '';
    return '<tr>' + detailCell + row.map(function (cell) { return '<td>' + escapeHtml(cell) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<section class="table-block" data-table-id="' + escapeHtml(table.id) + '">'
    + '<h2>' + escapeHtml(table.title) + '</h2>'
    + '<input type="text" class="table-search" placeholder="Search...">'
    + '<table><thead><tr>' + detailHeaderCell + headerCells + '</tr></thead><tbody>' + bodyRows + '</tbody></table>'
    + '<div class="table-pager">'
    + '<button type="button" class="table-prev" disabled>Previous</button>'
    + '<span class="table-page-label">Page 1 of ' + pageCount + '</span>'
    + '<button type="button" class="table-next"' + (pageCount <= 1 ? ' disabled' : '') + '>Next</button>'
    + '<button type="button" class="table-csv-export">Export CSV</button>'
    + '</div></section>';
}
```

(Only the two new lines — `detailHeaderCell`, and `detailCell` prepended inside the `bodyRows` map — plus using both in the returned markup. `data-col-index` values inside `headerCells` are untouched, since they still index into `table.columns`/`row`, not into the DOM.)

- [ ] **Step 4: Add the toggle to `TABLE_CLIENT_JS`'s `render()` and wire its click**

Modify the `render()` function's row-building loop (lines 858-867):

```javascript
  '      visible.slice(start, start + table.pageSize).forEach(function (row) {',
  '        var tr = document.createElement("tr");',
  '        if (table.detail) {',
  '          var detailTd = document.createElement("td");',
  '          var toggle = document.createElement("button");',
  '          toggle.type = "button";',
  '          toggle.className = "table-detail-toggle";',
  '          toggle.textContent = "\\u25B8";',
  '          toggle.setAttribute("data-group-value", row[0]);',
  '          detailTd.appendChild(toggle);',
  '          tr.appendChild(detailTd);',
  '        }',
  '        row.forEach(function (cell) {',
  '          var td = document.createElement("td");',
  '          td.textContent = cell;',
  '          tr.appendChild(td);',
  '        });',
  '        tbody.appendChild(tr);',
  '      });',
```

Add a click listener inside the same per-section `forEach` block, right after the existing `csvBtn.addEventListener(...)` block (after line 917, before the closing `'  });'` at line 918):

```javascript
  '    section.addEventListener("click", function (event) {',
  '      var toggle = event.target.closest && event.target.closest(".table-detail-toggle");',
  '      if (!toggle || !table.detail) { return; }',
  '      var groupValue = toggle.getAttribute("data-group-value");',
  '      var matching = table.detail.rows.filter(function (row) { return row[table.detail.groupBy] === groupValue; });',
  '      var built = buildRawTablePayload({ columns: table.detail.columns }, matching);',
  '      openDetailModal(table.title + ": " + groupValue, built.columns, built.rows);',
  '    });',
```

This reads the per-section closure's own `table` variable (kept current by the existing `__PUBLISH_TABLE_REPLACERS__` replacer after a `reactsTo` recompute — see Task 2's `withDetail` wiring), so no separate staleness fix is needed here.

- [ ] **Step 5: Rebuild and run tests**

Run: `./build.sh && node test/run.js`
Expected: all 3 new tests pass; every previous test still passes (`table.detail` is falsy for every pre-existing fixture, so the new branches never execute for them).

- [ ] **Step 6: Add the 3 new tests to `module.exports`, commit**

```bash
git add src/publish.js src.js test/publish.test.js
git commit -m "feat: add a detail toggle to aggregated table rows"
```

---

### Task 5: chart UI — third `handleChartClick` branch

**Files:**
- Modify: `src/publish.js` (`CHART_CLIENT_JS`: `interactive`, line/pie click gates, series click passthrough, `handleChartClick`)
- Modify: `test/publish.test.js` (2 existing tests updated for the widened conditions + new tests)

**Interfaces:**
- Consumes: `chart.detail` (Task 2's `withDetail` shape), `openDetailModal`/`buildRawTablePayload` (Task 3).

- [ ] **Step 1: Update the 2 existing tests whose asserted regex text changes**

In `test/publish.test.js`, `testPublishChartClientJsWiresBarClickOnlyWhenInteractive` (around line 667):

```javascript
  assert.ok(/var interactive = !!\(chart\.linkKey \|\| chart\.seriesLinkKey \|\| chart\.linkTo \|\| chart\.detail\);/.test(html), 'expected drawBarChart\'s interactive flag (widened for detail), got: ' + html);
```

`testPublishChartClientJsWiresLineAndPieClickOnLinkKey` (around lines 686-687):

```javascript
  var lineOrPieGateCount = (html.match(/^\s*if \(chart\.linkKey \|\| chart\.linkTo \|\| chart\.detail\) \{$/gm) || []).length;
  assert.strictEqual(lineOrPieGateCount, 2, 'expected exactly 2 standalone "if (chart.linkKey || chart.linkTo || chart.detail) {" gate blocks (drawLineChart + drawPieChart), got ' + lineOrPieGateCount + ' in: ' + html);
```

- [ ] **Step 2: Write the failing new tests**

Add to `test/publish.test.js`, after `testPublishChartClientJsHandlesLinkToClickNavigation`:

```javascript
function testPublishChartClientJsHandlesDetailClick() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'order_id', 'revenue'], [['A', 'o1', '10']]);
  var result = ctx.NotSoBigData.cli('run --select detailPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/if \(chart\.detail\) \{/.test(html), 'expected handleChartClick\'s detail branch in the emitted script, got: ' + html);
  assert.ok(/openDetailModal\(chart\.title \+ ": " \+ groupValue/.test(html), 'expected the detail branch to open the modal, got: ' + html);
}

function testPublishSeriesChartPassesSeriesValueThroughToDetailClick() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue'], [['A', 'online', '10']]);
  var result = ctx.NotSoBigData.cli('run --select seriesChartWithDetailPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  // Both the stacked and grouped series-bar click handlers must pass the
  // clicked series' value through when the chart has "detail" (not just
  // when it has seriesLinkKey, which detail is mutually exclusive with).
  var passthroughCount = (html.match(/chart\.seriesLinkKey \|\| chart\.detail \? seriesKey : undefined/g) || []).length
    + (html.match(/chart\.seriesLinkKey \|\| chart\.detail \? d\.key : undefined/g) || []).length;
  assert.strictEqual(passthroughCount, 2, 'expected both series-bar click handlers to widen their seriesValue passthrough for chart.detail, got ' + passthroughCount + ' in: ' + html);
}
```

- [ ] **Step 3: Add the `seriesChartWithDetailPublish` fixture**

Add to `test/fixtures/publish-nodes.js`, after `detailPublish`:

```javascript
var seriesChartWithDetailPublish = {
  kind: 'publish',
  name: 'seriesChartWithDetailPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'series-detail.html' },
  charts: [{ id: 'by_category_channel', type: 'bar', title: 'By category and channel', groupBy: 'category', series: 'channel',
    metric: { agg: 'sum', field: 'revenue' }, detail: { columns: [{ field: 'revenue', format: 'currency' }] } }]
};
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node test/run.js`
Expected: FAIL — no `chart.detail` branch in `handleChartClick` yet, no widened series passthrough.

- [ ] **Step 5: Widen `interactive` and the line/pie click gates**

In `CHART_CLIENT_JS` (line 995):

```javascript
  '  var interactive = !!(chart.linkKey || chart.seriesLinkKey || chart.linkTo || chart.detail);',
```

Line chart click gate (line 1068):

```javascript
  '  if (chart.linkKey || chart.linkTo || chart.detail) {',
```

Pie chart click gate (line 1087):

```javascript
  '  if (chart.linkKey || chart.linkTo || chart.detail) {',
```

- [ ] **Step 6: Widen the series-bar click handlers' seriesValue passthrough**

Stacked-series branch (line 1013-1016):

```javascript
  '        segments.on("click", function (event, d) {',
  '          var seriesKey = d3.select(this.parentNode).datum().key;',
  '          handleChartClick(chart, d.data.groupValue, chart.seriesLinkKey || chart.detail ? seriesKey : undefined);',
  '        });',
```

Grouped-series branch (line 1033-1036):

```javascript
  '        segments.on("click", function (event, d) {',
  '          var groupValue = d3.select(this.parentNode).datum().groupValue;',
  '          handleChartClick(chart, groupValue, chart.seriesLinkKey || chart.detail ? d.key : undefined);',
  '        });',
```

- [ ] **Step 7: Add the `chart.detail` branch to `handleChartClick`**

Modify `handleChartClick` (lines 963-972):

```javascript
  'function handleChartClick(chart, groupValue, seriesValue) {',
  '  if (chart.linkTo) {',
  '    var url = chart.linkTo.url + "?" + encodeURIComponent(chart.linkTo.field) + "=" + encodeURIComponent(groupValue);',
  '    if (chart.linkTo.newTab) { window.open(url, "_blank"); } else { window.location.href = url; }',
  '    return;',
  '  }',
  '  if (chart.detail) {',
  '    var matching = chart.detail.rows.filter(function (row) {',
  '      var groupMatch = row[chart.detail.groupBy] === groupValue;',
  '      return seriesValue === undefined ? groupMatch : groupMatch && row[chart.detail.series] === seriesValue;',
  '    });',
  '    var built = buildRawTablePayload({ columns: chart.detail.columns }, matching);',
  '    openDetailModal(chart.title + ": " + groupValue, built.columns, built.rows);',
  '    return;',
  '  }',
  '  var clicked = chartSelectionFor(chart, groupValue, seriesValue);',
  '  currentSelection = (currentSelection && selectionsEqual(currentSelection, clicked)) ? null : clicked;',
  '  applyHighlight();',
  '}',
```

- [ ] **Step 8: Rebuild and run the full suite**

Run: `./build.sh && node test/run.js`
Expected: all tests pass, including the 2 updated pre-existing tests and the 2 new ones.

- [ ] **Step 9: Add the 2 new tests to `module.exports`, commit**

```bash
git add src/publish.js src.js test/fixtures/publish-nodes.js test/publish.test.js
git commit -m "feat: add publish chart detail drill-down click handling"
```

---

### Task 6: docs

**Files:**
- Modify: `docs/publish.md` (user-facing reference)
- Modify: `src/publish.md` (dev-notes)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add a "Detail drill-down" section to `docs/publish.md`**

Insert a new `### Detail drill-down` section right after the `### \`tables[]\`` section ends (before `## Filters`, i.e. right before line 284's `## Filters`):

```markdown
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
```

- [ ] **Step 2: Update "What's not here yet"**

Change the closing section (near the end of the file) from:

```markdown
## What's not here yet

`expandable`/`detail` drill-down and a `board` tree layout are planned
but not implemented — see
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
direction" section.
```

to:

```markdown
## What's not here yet

A `board` tree layout (`layout: 'board'`) is planned but not
implemented — see `docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s
"Future direction" section.
```

- [ ] **Step 3: Add dev notes to `src/publish.md`**

Append a `## Detail drill-down` section to `src/publish.md` explaining: `withDetail`'s reuse across server-side `buildReportPayload` and the client-side `reactsTo` recompute path (so a filtered block's modal never goes stale), why `DETAIL_REUSED_FUNCTIONS_JS` exists separately from `FILTER_REUSED_FUNCTIONS_JS` (avoiding a duplicate function declaration when a report has both features), and why the table-detail click listener lives inside `TABLE_CLIENT_JS`'s own per-section closure rather than a global delegated listener (it needs the closure's current `table` variable, which the existing `__PUBLISH_TABLE_REPLACERS__` mechanism already keeps in sync after a filter recompute — a global lookup via `window.__PUBLISH_PAYLOAD__.tables` would see a stale copy instead).

- [ ] **Step 4: Commit**

```bash
git add docs/publish.md src/publish.md
git commit -m "docs: document publish's detail drill-down"
```

---

### Task 7: full regression + security review

**Files:** none new — verification only.

- [ ] **Step 1: Full rebuild and test run**

Run: `./build.sh --check && node test/run.js`
Expected: `build.sh --check` reports `src.js` matches `src/`; every test passes (should be 109 pre-existing + ~17 new from this plan).

- [ ] **Step 2: Security review**

Run `security-review` against `git diff release/16...feat/publish-detail-drilldown` (per this repo's CLAUDE.md step 3 — every feature PR gets this before opening the PR). Pay particular attention to: `openDetailModal`'s DOM construction (must stay `createElement`/`textContent` only, never `innerHTML`, since `rows`/`columns` ultimately come from live BigQuery data), and that `withDetail`'s `rows` never leak data the block wasn't already going to render (it's exactly `rowsForBlock`'s existing resolved set, no new fetch).

- [ ] **Step 3: Push and open the PR — ask first**

Ask the user for permission before pushing `feat/publish-detail-drilldown` and opening a PR against `release/16` (`gh pr create --base release/16`), per this repo's "stop before merge" rule. The PR description needs both a standard summary/test plan and the didactic walkthrough this repo's PRs always include (see CLAUDE.md step 4).

---

### Task 8: companion Layer 2 fixture (`notsobigtests`)

**Files (in the sibling `notsobigtests` repo, own branch/PR):**
- Modify: `js/08-fixtures-publish-targets.js` (new publish node reusing `loadPublishOrders`)
- Modify: `js/28-tests-publish.js` (new test function)
- Modify: `js/90-test-registry.js` (register the new test in the `publish` category)

**Interfaces:** none — this is Layer 2, human-run, no automated interface contract with `notsobiglib`.

- [ ] **Step 1: Create a feature branch in `notsobigtests`**

```bash
cd ~/projetos/notsobig_org/notsobigtests
git checkout -b test/publish-detail-drilldown-fixture
```

- [ ] **Step 2: Add the fixture**

In `js/08-fixtures-publish-targets.js`, add after `blockSourceOverridePublish` (reuses `loadPublishOrders`'s existing 6-row sample: Beverages 10+20+30=60, Snacks 5+15+25=45 — see that fixture's own comment):

```javascript
// Detail drill-down (notsobiglib feat/publish-detail-drilldown): both the
// aggregated table and the chart drill into loadPublishOrders' own rows
// by category - clicking/expanding "Beverages" should surface exactly
// its 3 underlying rows (order_id 1, 2, 6), summing to 60.
var detailDrilldownPublish = {
  kind: 'publish',
  name: 'detailDrilldownPublish',
  dependsOn: ['loadPublishOrders'],
  source: { type: 'ref', ref: 'loadPublishOrders' },
  target: { type: 'drive', folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'publish-detail-drilldown.html', upsertByName: true },
  charts: [
    { id: 'by_category', type: 'bar', title: 'Revenue by category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
      detail: { columns: [{ field: 'order_id', label: 'Order' }, { field: 'revenue', label: 'Revenue', format: 'currency' }] } }
  ],
  tables: [
    { id: 'by_category_table', title: 'Revenue by category', mode: 'aggregated', groupBy: 'category',
      metrics: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }],
      detail: { columns: [{ field: 'order_id', label: 'Order' }, { field: 'revenue', label: 'Revenue', format: 'currency' }] } }
  ]
};
```

- [ ] **Step 3: Add the test function**

In `js/28-tests-publish.js`, add after `testPublishBlockSourceOverrideReadsFromItsOwnRef`:

```javascript
// Automated part: the written report's payload carries the right
// .detail data (groupBy/rows) for both the chart and the table. Human
// part (do by hand after this passes): open the written Drive file in a
// browser, expand the "Beverages" row's "▸" toggle and click the
// "Beverages" bar in the chart - both should open a modal listing
// exactly order_id 1, 2, 6 with revenues 10/20/30.
function testPublishDetailDrilldownPayloadCarriesGroupRows() {
  runOne('loadPublishOrders');
  var result = runOne('detailDrilldownPublish');
  var html = DriveApp.getFileById(result.driveFileId).getBlob().getDataAsString();
  var payload = extractPublishPayload(html);

  var chart = payload.charts.filter(function (c) { return c.id === 'by_category'; })[0];
  check('chart.detail.groupBy is "category"', chart.detail.groupBy === 'category', JSON.stringify(chart.detail));
  var beverageRows = chart.detail.rows.filter(function (r) { return r.category === 'Beverages'; });
  check('chart.detail.rows holds exactly the 3 Beverages rows', beverageRows.length === 3, JSON.stringify(beverageRows));

  var table = payload.tables.filter(function (t) { return t.id === 'by_category_table'; })[0];
  check('table.detail.groupBy is "category"', table.detail.groupBy === 'category', JSON.stringify(table.detail));
  check('table.detail.rows holds all 6 loadPublishOrders rows (ungrouped)', table.detail.rows.length === 6, JSON.stringify(table.detail.rows));
}
```

- [ ] **Step 4: Register the test**

In `js/90-test-registry.js`, add `testPublishDetailDrilldownPayloadCarriesGroupRows` to the end of the `publish:` array (after `testPublishBlockSourceOverrideReadsFromItsOwnRef`).

- [ ] **Step 5: Point `SRC_REF` at the feature branch and deploy**

In the Apps Script editor, set the `SRC_REF` Script Property to `feat/publish-detail-drilldown`. Then:

```bash
clasp push -f
```

(Do this without asking — see this repo's CLAUDE.md: it only touches the human's own personal test project.)

- [ ] **Step 6: Run the automated check**

In the Apps Script editor: `runAllTests('testPublishDetailDrilldownPayloadCarriesGroupRows')`. Confirm it reports pass.

- [ ] **Step 7: Human confirms the actual UI**

Open the written Drive file (`publish-detail-drilldown.html`) in a browser. Click the "Beverages" bar in the chart, and separately click the "▸" toggle on the "Beverages" row in the table. Both must open a modal listing exactly 3 rows (order_id 1/2/6, revenue 10/20/30), and the modal must close via the "×" button, the Escape key, and a click outside it.

- [ ] **Step 8: Reset `SRC_REF`, commit, open the PR — ask first**

Set `SRC_REF` back to `main` (or whatever the active `notsobiglib` release is) in the Apps Script editor.

```bash
git add js/08-fixtures-publish-targets.js js/28-tests-publish.js js/90-test-registry.js
git commit -m "test: add fixture for publish's detail drill-down"
git push origin test/publish-detail-drilldown-fixture
```

Ask the user for permission before opening the PR (`gh pr create --base main`), cross-linked with the `notsobiglib` PR from Task 7. Report to the user whether the Google Apps Script tests passed (Step 6 + Step 7) before either PR is merged — the standing rule for this workspace, asked fresh every time.
