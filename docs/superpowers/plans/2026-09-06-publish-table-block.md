# Publish Table Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tables[]` block to the `publish` kind's config, alongside the existing `kpis[]`/`charts[]` — a "raw" mode (explicit columns straight from the source rows) and an "aggregated" mode (`groupBy` + per-column metrics, same math `charts` already does, rendered as a table) — with a static first page in the generated HTML and client-side "Previous"/"Next" pagination over the full embedded row set.

**Architecture:** No new module, no new node kind — `tables[]` is a third array on the existing `PublishNode` config, validated and computed the same way `kpis[]`/`charts[]` already are. `validatePublishConfig` gains one more `forEach` block; `buildReportPayload` gains one more mapping step producing a `payload.tables[]` whose `{columns, rows}` shape is identical for both modes (raw and aggregated converge before rendering, so there's exactly one render/pagination code path, not two); `renderReportHtml` gains a static-first-page `<table>` render per block plus one generic pagination `<script>` addition, emitted only when `config.tables` is non-empty.

**Tech Stack:** Google Apps Script (V8 runtime), same `src/publish.js` module. Node (`vm` + plain `assert`) for Layer 1 tests, no new dependency. Browser-side: plain DOM APIs (`textContent`, `createElement`), no library.

**Spec:** `docs/superpowers/specs/2026-09-06-publish-table-block-design.md`

## Global Constraints

- Match existing code style exactly: `var`/`function` declarations, string concatenation with `+` (no template literals), no arrow functions, no `let`/`const` — this is ES5-style by convention throughout `src/*.js`, not a runtime limitation.
- Every thrown error message starts with `'publish(): '`, matching every existing check in `validatePublishConfig`.
- Zero new external dependencies, zero CDN, zero build step for the generated `.html` — everything stays inline (CSS, JS, JSON payload), matching the rest of `publish()`.
- Column-header sort, search/filter, CSV export, `filters`, `expandable`/`detail`, per-block `source` override, `linkTo`, and `layout: 'board'` are all out of scope — do not add hooks or config keys "for later" toward any of them.
- The client-side pagination script must never use `innerHTML` or string-concatenated markup on data read from the payload — build `<tr>`/`<td>` nodes via `document.createElement` and set text via `textContent` only (this repo already fixed one stored-XSS finding in the embedded JSON `<script>` tag; this rule keeps the table feature from reopening the same class of bug on the render side).
- `./build.sh` (regenerates the committed `src.js` from `src/*.js` — the test harness loads `src.js`, not the `src/` modules directly) then `node test/run.js` must both pass before any task is considered done. Run `./build.sh --check` on the final task.

---

### Task 1: Validate `tables[]` config (raw and aggregated modes)

Extends `validatePublishConfig` (`src/publish.js:14-46`) to accept and validate a `tables[]` array, following the exact per-entry `forEach`-and-throw shape `kpis[]`/`charts[]` already use. This is a complete, independently testable slice on its own: after this task, a `publish` node with a well-formed `tables[]` gets all the way past validation (proven the same way the existing `testPublishValidRefProceedsPastValidation` proves it — failing next at the un-shimmed `BigQuery` call, not at validation), and every malformed shape fails with a specific, exact error — all in Node, no live resource, and `buildReportPayload`/`renderReportHtml` are untouched by this task.

**Files:**
- Modify: `src/publish.js:14-46` (`validatePublishConfig`)
- Modify: `test/fixtures/publish-nodes.js` (append new fixtures)
- Modify: `test/publish.test.js` (append new tests)

**Interfaces:**
- Produces: a new top-level constant `PUBLISH_VALUE_FORMATS = ['string', 'currency', 'integer', 'decimal']` in `src/publish.js`, and `validatePublishConfig` extended to validate `config.tables[]`. `PUBLISH_VALUE_FORMATS` is also the array the existing `kpis[]` format check (`src/publish.js:34`) now reads from, per the design spec's §3 ("the existing kpis[] format check widened by one value ['string'] rather than a second enum living elsewhere") — this is an intentional, spec-approved widening of what `kpis[].format` accepts, not an accidental side effect.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing fixtures**

Append to `test/fixtures/publish-nodes.js`:

```javascript
// One raw table (columns: order_id, revenue) and one aggregated table
// (groupBy: category, metrics: revenue sum + distinct orders), pageSize 2
// on the raw table so Task 3's pagination tests have >1 page to work
// with. Reused across Task 1 (validation pass-through), Task 2 (payload
// correctness), and Task 3 (render/pagination) - one fixture per concern
// this feature actually needs, not a fresh one per test.
var tablesPublish = {
  kind: 'publish',
  name: 'tablesPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'tables.html' },
  tables: [
    {
      id: 'recent_orders', title: 'Recent orders', mode: 'raw', pageSize: 2,
      columns: [
        { field: 'order_id', label: 'Order' },
        { field: 'revenue', label: 'Revenue', format: 'currency' }
      ]
    },
    {
      id: 'by_category', title: 'Revenue by category', mode: 'aggregated',
      groupBy: 'category',
      metrics: [
        { label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' },
        { label: 'Orders', agg: 'count_distinct', field: 'order_id', format: 'integer' }
      ]
    }
  ]
};

var badTableModePublish = {
  kind: 'publish',
  name: 'badTableModePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-mode.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'pivot', columns: [{ field: 'revenue' }] }]
};

var badTableRawColumnsPublish = {
  kind: 'publish',
  name: 'badTableRawColumnsPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-raw-columns.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'raw', columns: [] }]
};

var badTableRawColumnFieldPublish = {
  kind: 'publish',
  name: 'badTableRawColumnFieldPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-raw-column-field.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'raw', columns: [{ label: 'No field' }] }]
};

var badTableAggregatedGroupByPublish = {
  kind: 'publish',
  name: 'badTableAggregatedGroupByPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-groupby.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'aggregated', metrics: [{ label: 'Revenue', agg: 'sum', field: 'revenue' }] }]
};

var badTableAggregatedMetricsPublish = {
  kind: 'publish',
  name: 'badTableAggregatedMetricsPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-metrics.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'aggregated', groupBy: 'category', metrics: [] }]
};

var badTableMetricFieldPublish = {
  kind: 'publish',
  name: 'badTableMetricFieldPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-metric-field.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'aggregated', groupBy: 'category', metrics: [{ label: 'Revenue', agg: 'sum' }] }]
};

var badTableFormatPublish = {
  kind: 'publish',
  name: 'badTableFormatPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-format.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'raw', columns: [{ field: 'revenue', format: 'percent' }] }]
};
```

- [ ] **Step 2: Write the failing tests**

Append to `test/publish.test.js` (before `module.exports`):

```javascript
function testPublishTableModeMustBeRawOrAggregated() {
  var result = runOne('badTableModePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/mode "raw" or "aggregated"/.test(result.error), 'expected a table-mode error, got: ' + result.error);
}

function testPublishRawTableRequiresColumns() {
  var result = runOne('badTableRawColumnsPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/requires a non-empty "columns"/.test(result.error), 'expected a raw-columns error, got: ' + result.error);
}

function testPublishRawTableColumnRequiresField() {
  var result = runOne('badTableRawColumnFieldPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/missing "field"/.test(result.error), 'expected a column-field error, got: ' + result.error);
}

function testPublishAggregatedTableRequiresGroupBy() {
  var result = runOne('badTableAggregatedGroupByPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/requires "groupBy"/.test(result.error), 'expected a groupBy error, got: ' + result.error);
}

function testPublishAggregatedTableRequiresMetrics() {
  var result = runOne('badTableAggregatedMetricsPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/requires a non-empty "metrics"/.test(result.error), 'expected a metrics error, got: ' + result.error);
}

function testPublishAggregatedMetricRequiresFieldUnlessCount() {
  var result = runOne('badTableMetricFieldPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/requires "field"/.test(result.error), 'expected a metric-field error, got: ' + result.error);
}

function testPublishTableFormatMustBeKnownEnum() {
  var result = runOne('badTableFormatPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/expected one of string, currency, integer, decimal/.test(result.error), 'expected a format-enum error, got: ' + result.error);
}

function testPublishValidTablesProceedPastValidation() {
  var result = runOne('tablesPublish');
  // Same proof pattern as testPublishValidRefProceedsPastValidation: no
  // BigQuery shim in this test, so a config that gets all the way past
  // validation fails next at the un-shimmed BigQuery call, not at
  // validation - that BigQuery-shaped error is what proves tables[]
  // validated cleanly.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation to pass and fail only at the BigQuery call, got: ' + result.error);
}
```

Add each new function name to `module.exports` in the same file.

- [ ] **Step 3: Run the suite to confirm the new tests fail**

Run: `./build.sh && node test/run.js`
Expected: the 8 new tests FAIL (`tables` isn't validated yet, so every "bad" fixture instead fails later at the un-shimmed `BigQuery` call — the same generic error `testPublishValidTablesProceedPastValidation` expects — and none of the specific `/mode "raw" or "aggregated"/`-style assertions match).

- [ ] **Step 4: Implement the validation**

In `src/publish.js`, immediately above `function validatePublishConfig(config) {` (currently line 14), add:

```javascript
// Shared enum for every publish() value that gets formatted for display -
// kpis[] (always required), and tables[]'s raw columns/aggregated metrics
// (optional, default 'string') - one array, not a second enum living
// elsewhere, per the design spec's §3.
var PUBLISH_VALUE_FORMATS = ['string', 'currency', 'integer', 'decimal'];
```

Change the `kpis[]` format check (currently line 34) from:

```javascript
    if (['currency', 'integer', 'decimal'].indexOf(kpi.format) === -1) {
```

to:

```javascript
    if (PUBLISH_VALUE_FORMATS.indexOf(kpi.format) === -1) {
```

Immediately after the existing `(config.charts || []).forEach(...)` block (ends at line 45, right before the closing `}` of `validatePublishConfig`), add:

```javascript
  (config.tables || []).forEach(function (table) {
    if (!table.id || !table.title || ['raw', 'aggregated'].indexOf(table.mode) === -1) {
      throw new Error('publish(): every table needs "id", "title", and mode "raw" or "aggregated".');
    }
    if (table.mode === 'raw') {
      if (!Array.isArray(table.columns) || !table.columns.length) {
        throw new Error('publish(): table "' + table.id + '" has mode "raw", which requires a non-empty "columns" array.');
      }
      table.columns.forEach(function (column) {
        if (!column.field) {
          throw new Error('publish(): table "' + table.id + '" has a column missing "field".');
        }
        if (column.format && PUBLISH_VALUE_FORMATS.indexOf(column.format) === -1) {
          throw new Error('publish(): table "' + table.id + '" column "' + column.field + '" has format "' + column.format + '" - expected one of ' + PUBLISH_VALUE_FORMATS.join(', ') + '.');
        }
      });
    } else {
      if (!table.groupBy) {
        throw new Error('publish(): table "' + table.id + '" has mode "aggregated", which requires "groupBy".');
      }
      if (!Array.isArray(table.metrics) || !table.metrics.length) {
        throw new Error('publish(): table "' + table.id + '" has mode "aggregated", which requires a non-empty "metrics" array.');
      }
      table.metrics.forEach(function (metric) {
        if (!metric.label || !metric.agg) {
          throw new Error('publish(): table "' + table.id + '" has a metric missing "label" or "agg".');
        }
        if (metric.agg !== 'count' && !metric.field) {
          throw new Error('publish(): table "' + table.id + '" metric "' + metric.label + '" has agg "' + metric.agg + '", which requires "field".');
        }
        if (metric.format && PUBLISH_VALUE_FORMATS.indexOf(metric.format) === -1) {
          throw new Error('publish(): table "' + table.id + '" metric "' + metric.label + '" has format "' + metric.format + '" - expected one of ' + PUBLISH_VALUE_FORMATS.join(', ') + '.');
        }
      });
    }
  });
```

- [ ] **Step 5: Run the suite to confirm everything passes**

Run: `./build.sh && node test/run.js`
Expected: every test passes, including all 8 new ones and every pre-existing `publish.test.js` test (the `PUBLISH_VALUE_FORMATS` change to the `kpis[]` check must not break `testPublishKpiRequiresFieldUnlessCount` or any aggregation test).

- [ ] **Step 6: Commit**

```bash
git add src/publish.js test/fixtures/publish-nodes.js test/publish.test.js
git commit -m "feat: validate publish's table block config

New tables[] array validated the same way kpis[]/charts[] already are:
mode 'raw' requires non-empty columns (each with a field), mode
'aggregated' requires groupBy plus non-empty metrics (same field-unless-
count rule kpis[] already has). Format enum widened to 'string' (the new
per-column/metric default) and shared as one constant with the existing
kpis[] check rather than duplicated."
```

---

### Task 2: Compute the table block payload (raw and aggregated)

Extends `buildReportPayload` (`src/publish.js:144-166`) to compute `payload.tables[]`, converging both modes on one `{id, title, pageSize, columns: [{key,label}], rows: [[cell,...]]}` shape so Task 3 needs exactly one render/pagination path. This is independently testable without any `renderReportHtml` change: `renderReportHtml` already does `JSON.stringify(payload)` of whatever `buildReportPayload` returns (`src/publish.js:231`), so `payload.tables` reaches the generated HTML's embedded JSON blob the moment this task lands, before any markup renders it — this task's tests read that JSON directly.

**Files:**
- Modify: `src/publish.js:134-166` (`formatValue`, `buildReportPayload`)
- Modify: `test/publish.test.js` (append new tests + a small shared helper)

**Interfaces:**
- Consumes: `computeAggregate(rows, agg, field)`, `emptyMap()`, `has(map, key)` (existing, unchanged).
- Produces: `formatValue(value, format)` extended with a `'string'` branch. Two new functions, `buildRawTablePayload(table, rows)` and `buildAggregatedTablePayload(table, rows)`, both returning `{ id, title, pageSize, columns: [{key,label}], rows: [[cell,...]] }` — every cell already formatted to a string, matching how `kpi.formatted` is already pre-formatted before render. `buildReportPayload(config, rows)`'s return value gains a third key, `tables`, alongside the existing `kpis`/`charts`. Task 3's `renderTableSection(table)` consumes exactly this `{id,title,pageSize,columns,rows}` shape.

- [ ] **Step 1: Write the failing test**

Append to `test/publish.test.js` (before `module.exports`), plus the small shared helper above it:

```javascript
// Pulls the embedded payload back out of a rendered report - non-greedy
// up to the first ";" (not ";</script>") since that's exactly where
// JSON.stringify(payload)'s own output ends, before anything else (e.g.
// Task 3's pagination script) that might follow it in the same <script>
// tag.
function extractPayload(html) {
  var match = html.match(/window\.__PUBLISH_PAYLOAD__ = (.+?);/);
  assert.ok(match, 'expected an embedded __PUBLISH_PAYLOAD__ in: ' + html);
  return JSON.parse(match[1]);
}

function testPublishBuildsRawAndAggregatedTablePayloads() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [
    ['A', '10', 'o1'],
    ['A', '20', 'o1'],
    ['A', '5', 'o3'],
    ['B', '5', 'o2']
  ]);

  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  var rawTable = payload.tables.filter(function (t) { return t.id === 'recent_orders'; })[0];
  assert.ok(rawTable, 'expected a recent_orders table in payload.tables');
  assert.deepStrictEqual(rawTable.columns, [{ key: 'order_id', label: 'Order' }, { key: 'revenue', label: 'Revenue' }]);
  assert.strictEqual(rawTable.pageSize, 2);
  assert.deepStrictEqual(rawTable.rows, [
    ['o1', '$10.00'], ['o1', '$20.00'], ['o3', '$5.00'], ['o2', '$5.00']
  ]);

  var aggTable = payload.tables.filter(function (t) { return t.id === 'by_category'; })[0];
  assert.ok(aggTable, 'expected a by_category table in payload.tables');
  assert.deepStrictEqual(aggTable.columns, [
    { key: 'category', label: 'category' },
    { key: 'Revenue', label: 'Revenue' },
    { key: 'Orders', label: 'Orders' }
  ]);
  // A: sum(revenue) 10+20+5=35, count_distinct(order_id) over ['o1','o1','o3']=2
  // B: sum(revenue) 5, count_distinct(order_id) over ['o2']=1
  assert.deepStrictEqual(aggTable.rows, [
    ['A', '$35.00', '2'],
    ['B', '$5.00', '1']
  ]);
}
```

Add `testPublishBuildsRawAndAggregatedTablePayloads` to `module.exports`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `./build.sh && node test/run.js`
Expected: `testPublishBuildsRawAndAggregatedTablePayloads` FAILS — `payload.tables` doesn't exist yet (`filter` on `undefined` throws a `TypeError`).

- [ ] **Step 3: Implement the payload computation**

In `src/publish.js`, change `formatValue` (currently lines 134-142) to add a `'string'` branch at the top:

```javascript
function formatValue(value, format) {
  if (format === 'string') {
    return String(value);
  }
  if (format === 'integer') {
    return Math.round(value).toLocaleString('en-US');
  }
  if (format === 'currency') {
    return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
```

Immediately after `formatValue`, add the two table-payload builders:

```javascript
// mode: 'raw' - one output row per source row, column order/labels exactly
// as configured. Non-'string' formats coerce through Number() first (row
// values from fetchTableRows are always strings, same as
// computeAggregate's own "Number(row[field]) || 0" coercion for
// kpis/charts) - 'string' format is left raw so ids/dates/free text pass
// through unchanged rather than becoming NaN/0.
function buildRawTablePayload(table, rows) {
  var columns = table.columns.map(function (column) {
    return { key: column.field, label: column.label || column.field };
  });
  var tableRows = rows.map(function (row) {
    return table.columns.map(function (column) {
      var format = column.format || 'string';
      var raw = row[column.field];
      return formatValue(format === 'string' ? raw : (Number(raw) || 0), format);
    });
  });
  return { id: table.id, title: table.title, pageSize: table.pageSize || 25, columns: columns, rows: tableRows };
}

// mode: 'aggregated' - identical grouping to charts' own groupBy handling
// above; the groupBy value itself is left as the raw string BigQuery
// returned (not run through formatValue), matching how charts already
// render chart.data[].groupValue directly with no formatting step.
function buildAggregatedTablePayload(table, rows) {
  var groups = emptyMap();
  var order = [];
  rows.forEach(function (row) {
    var key = row[table.groupBy];
    if (!has(groups, key)) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(row);
  });
  var columns = [{ key: table.groupBy, label: table.groupBy }].concat(table.metrics.map(function (metric) {
    return { key: metric.label, label: metric.label };
  }));
  var tableRows = order.map(function (key) {
    var groupRows = groups[key];
    var cells = table.metrics.map(function (metric) {
      var value = computeAggregate(groupRows, metric.agg, metric.field);
      return formatValue(value, metric.format || 'string');
    });
    return [key].concat(cells);
  });
  return { id: table.id, title: table.title, pageSize: table.pageSize || 25, columns: columns, rows: tableRows };
}
```

In `buildReportPayload` (currently lines 144-166), add a `tables` mapping and include it in the returned object:

```javascript
function buildReportPayload(config, rows) {
  var kpis = (config.kpis || []).map(function (kpi) {
    var value = computeAggregate(rows, kpi.agg, kpi.field);
    return { label: kpi.label, value: value, formatted: formatValue(value, kpi.format) };
  });
  var charts = (config.charts || []).map(function (chart) {
    var groups = emptyMap();
    var order = [];
    rows.forEach(function (row) {
      var key = row[chart.groupBy];
      if (!has(groups, key)) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(row);
    });
    var data = order.map(function (key) {
      return { groupValue: key, total: computeAggregate(groups[key], chart.metric.agg, chart.metric.field) };
    });
    return { id: chart.id, title: chart.title, data: data };
  });
  var tables = (config.tables || []).map(function (table) {
    return table.mode === 'raw' ? buildRawTablePayload(table, rows) : buildAggregatedTablePayload(table, rows);
  });
  return { kpis: kpis, charts: charts, tables: tables };
}
```

- [ ] **Step 4: Run the suite to confirm everything passes**

Run: `./build.sh && node test/run.js`
Expected: every test passes, including `testPublishBuildsRawAndAggregatedTablePayloads`.

- [ ] **Step 5: Commit**

```bash
git add src/publish.js test/publish.test.js
git commit -m "feat: compute publish's table block payload

buildReportPayload gains payload.tables[], converging both 'raw' (columns
straight from source rows) and 'aggregated' (groupBy + metrics, same
grouping charts[] already does) modes on one {columns, rows} shape so
rendering needs exactly one path. formatValue gains a 'string' branch,
the new default for table columns/metrics."
```

---

### Task 3: Render the table block — static first page + client-side pagination

Completes the feature: `renderReportHtml` gets a `<table>` section per configured table (header + only the first `pageSize` rows, readable with zero JS, matching the "still works if JS never runs" property the KPI cards and SVG chart already have) plus "Previous"/"Next" controls, and one generic pagination `<script>` addition — emitted only when `config.tables` is non-empty — that reads the full row set already embedded in `window.__PUBLISH_PAYLOAD__` and rebuilds the `<tbody>` via `textContent`/`createElement` on click. Docs land in this task too, per this repo's "code and docs land in the same pass" convention.

**Files:**
- Modify: `src/publish.js:197-233` (`REPORT_CSS`, `renderReportHtml`)
- Modify: `test/publish.test.js` (append new tests)
- Modify: `docs/publish.md` (new `### tables[]` section, update "What's not here yet")
- Modify: `src/publish.md` (new dev note)

**Interfaces:**
- Consumes: `payload.tables[]` (`{id, title, pageSize, columns, rows}`, Task 2), `escapeHtml(value)` (existing, unchanged).
- Produces: `renderTableSection(table)` and a `TABLE_PAGINATION_JS` string constant, both new. `renderReportHtml(payload, config)` keeps its existing signature — nothing outside this module calls it, so no other file changes. This completes the table block feature end-to-end (`cli('run --select <publishNodeWithTables>')`).

- [ ] **Step 1: Write the failing tests**

Append to `test/publish.test.js` (before `module.exports`):

```javascript
function testPublishRawTableRendersFirstPageAndEmbedsFullData() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [
    ['A', '10', 'o1'],
    ['A', '20', 'o1'],
    ['A', '5', 'o3'],
    ['B', '5', 'o2']
  ]);

  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  var sectionMatch = html.match(/<section class="table-block" data-table-id="recent_orders">[\s\S]*?<\/section>/);
  assert.ok(sectionMatch, 'expected the recent_orders table section in: ' + html);
  var section = sectionMatch[0];

  // pageSize is 2, 4 raw rows total -> exactly 2 <tr> in the static <tbody>.
  var bodyMatch = section.match(/<tbody>([\s\S]*?)<\/tbody>/);
  assert.ok(bodyMatch, 'expected a <tbody> in: ' + section);
  var rowCount = (bodyMatch[1].match(/<tr>/g) || []).length;
  assert.strictEqual(rowCount, 2, 'expected exactly pageSize (2) rows in the static first page, got ' + rowCount);
  assert.ok(/Page 1 of 2/.test(section), 'expected a "Page 1 of 2" label in: ' + section);
  assert.ok(/\$10\.00/.test(bodyMatch[1]) && /\$20\.00/.test(bodyMatch[1]), 'expected the first two formatted rows in the static page, got: ' + bodyMatch[1]);

  // Full 4-row dataset still embedded for client-side pagination to read.
  var payload = extractPayload(html);
  var rawTable = payload.tables.filter(function (t) { return t.id === 'recent_orders'; })[0];
  assert.strictEqual(rawTable.rows.length, 4, 'expected all 4 rows embedded in the payload for pagination, got ' + rawTable.rows.length);

  assert.ok(/DOMContentLoaded/.test(html), 'expected the pagination script to be emitted when tables[] is non-empty');
}

function testPublishNoPaginationScriptWithoutTables() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [['A', '10', 'o1']]);

  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(!/DOMContentLoaded/.test(html), 'expected no pagination script when config.tables is empty, got: ' + html);
}
```

Add both function names to `module.exports`.

- [ ] **Step 2: Run the suite to confirm the new tests fail**

Run: `./build.sh && node test/run.js`
Expected: `testPublishRawTableRendersFirstPageAndEmbedsFullData` FAILS (no `<section class="table-block" ...>` in the output yet). `testPublishNoPaginationScriptWithoutTables` passes already (there's no pagination script at all yet, for anything) — that's fine, it starts green and stays green; it exists to catch a regression once Step 3 lands, not to drive it.

- [ ] **Step 3: Implement the render + pagination**

In `src/publish.js`, add to the `REPORT_CSS` array (currently lines 201-217), immediately before the closing `].join('\n');` line, these entries (matching the existing hairline-separator, `--mono` tabular-numeric convention already used by `.chart`):

```javascript
  '.table-block { border-top: 1px solid var(--paper-line); padding-top: 16px; margin-top: 16px; }',
  '.table-block h2 { font-size: 14px; }',
  '.table-block table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }',
  '.table-block th, .table-block td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--paper-line); font-variant-numeric: tabular-nums; }',
  '.table-pager { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-family: var(--mono); font-size: 12px; }',
  '.table-pager button { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); padding: 2px 8px; cursor: pointer; }',
  '.table-pager button:disabled { color: var(--ink-soft); cursor: default; }'
```

Immediately before `function renderReportHtml(payload, config) {` (currently line 219), add:

```javascript
// Static first page (readable with zero JS, same as the KPI cards/SVG
// chart above) plus inert-without-JS pager controls. table.rows already
// holds every row, pre-formatted (see buildRawTablePayload/
// buildAggregatedTablePayload) - only the first pageSize rows render here;
// the rest reaches the browser via the existing __PUBLISH_PAYLOAD__ embed,
// for TABLE_PAGINATION_JS below to page through.
function renderTableSection(table) {
  var firstPageRows = table.rows.slice(0, table.pageSize);
  var pageCount = Math.max(1, Math.ceil(table.rows.length / table.pageSize));
  var headerCells = table.columns.map(function (column) {
    return '<th>' + escapeHtml(column.label) + '</th>';
  }).join('');
  var bodyRows = firstPageRows.map(function (row) {
    return '<tr>' + row.map(function (cell) { return '<td>' + escapeHtml(cell) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<section class="table-block" data-table-id="' + escapeHtml(table.id) + '">'
    + '<h2>' + escapeHtml(table.title) + '</h2>'
    + '<table><thead><tr>' + headerCells + '</tr></thead><tbody>' + bodyRows + '</tbody></table>'
    + '<div class="table-pager">'
    + '<button type="button" class="table-prev" disabled>Previous</button>'
    + '<span class="table-page-label">Page 1 of ' + pageCount + '</span>'
    + '<button type="button" class="table-next"' + (pageCount <= 1 ? ' disabled' : '') + '>Next</button>'
    + '</div></section>';
}

// One generic paginator for every table.table-block on the page - reads
// columns/rows/pageSize back off window.__PUBLISH_PAYLOAD__ by
// data-table-id, never re-computes or re-formats a value (everything's
// already a formatted string in the payload). Builds <tr>/<td> via
// createElement + textContent only, per this repo's rule against
// innerHTML/string-concatenated markup on payload-sourced data - see the
// design spec's Render section.
var TABLE_PAGINATION_JS = [
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  Array.prototype.forEach.call(document.querySelectorAll(".table-block"), function (section) {',
  '    var tableId = section.getAttribute("data-table-id");',
  '    var table = payload.tables.filter(function (t) { return t.id === tableId; })[0];',
  '    if (!table) { return; }',
  '    var page = 0;',
  '    var pageCount = Math.max(1, Math.ceil(table.rows.length / table.pageSize));',
  '    var tbody = section.querySelector("tbody");',
  '    var prevBtn = section.querySelector(".table-prev");',
  '    var nextBtn = section.querySelector(".table-next");',
  '    var pageLabel = section.querySelector(".table-page-label");',
  '    function render() {',
  '      while (tbody.firstChild) { tbody.removeChild(tbody.firstChild); }',
  '      var start = page * table.pageSize;',
  '      table.rows.slice(start, start + table.pageSize).forEach(function (row) {',
  '        var tr = document.createElement("tr");',
  '        row.forEach(function (cell) {',
  '          var td = document.createElement("td");',
  '          td.textContent = cell;',
  '          tr.appendChild(td);',
  '        });',
  '        tbody.appendChild(tr);',
  '      });',
  '      pageLabel.textContent = "Page " + (page + 1) + " of " + pageCount;',
  '      prevBtn.disabled = page === 0;',
  '      nextBtn.disabled = page >= pageCount - 1;',
  '    }',
  '    prevBtn.addEventListener("click", function () { if (page > 0) { page -= 1; render(); } });',
  '    nextBtn.addEventListener("click", function () { if (page < pageCount - 1) { page += 1; render(); } });',
  '  });',
  '});'
].join('\n');
```

Change `renderReportHtml` (currently lines 219-233) to add `tableSections` and conditionally append `TABLE_PAGINATION_JS`:

```javascript
function renderReportHtml(payload, config) {
  var kpiCards = payload.kpis.map(function (kpi) {
    return '<div class="kpi"><div class="kpi-label">' + escapeHtml(kpi.label) + '</div>'
      + '<div class="kpi-value">' + escapeHtml(kpi.formatted) + '</div></div>';
  }).join('');
  var chartSections = payload.charts.map(function (chart) {
    return '<section class="chart"><h2>' + escapeHtml(chart.title) + '</h2>' + renderBarChartSvg(chart) + '</section>';
  }).join('');
  var tableSections = payload.tables.map(renderTableSection).join('');
  var script = 'window.__PUBLISH_PAYLOAD__ = ' + JSON.stringify(payload).replace(/</g, '\\u003c') + ';';
  if (payload.tables.length) {
    script += TABLE_PAGINATION_JS;
  }
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>' + escapeHtml(config.target.fileName) + '</title>'
    + '<style>' + REPORT_CSS + '</style></head><body>'
    + '<main><div class="kpis">' + kpiCards + '</div>' + chartSections + tableSections + '</main>'
    + '<script>' + script + '</script>'
    + '</body></html>';
}
```

- [ ] **Step 4: Run the suite to confirm everything passes**

Run: `./build.sh && node test/run.js`
Expected: every test passes, including both new tests from Step 1.

- [ ] **Step 5: Update `docs/publish.md`**

In `docs/publish.md`, immediately after the existing `- \`target\` — ...` bullet (the last bullet of the `## Config` section), add:

```markdown

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
- No column-header sort, search, or CSV export yet — see "What's not
  here yet" below.
```

Change the "What's not here yet" section's opening sentence from:

```markdown
Filters, drill-down, a `table` block, per-block `source` overrides,
cross-file navigation, a `board` tree layout, and CSV export are all
planned but not implemented — see
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
direction" section.
```

to:

```markdown
Filters, drill-down, per-block `source` overrides, cross-file
navigation, a `board` tree layout, and CSV export are all planned but
not implemented — see
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
direction" section. Column-header sort, search, and CSV export for the
`tables[]` block specifically are also not implemented — see
`docs/superpowers/specs/2026-09-06-publish-table-block-design.md`'s §1.
```

- [ ] **Step 6: Add a dev note to `src/publish.md`**

Append to `src/publish.md`:

```markdown

## Why raw and aggregated tables share one render path

`buildRawTablePayload`/`buildAggregatedTablePayload` (both in
`src/publish.js`) converge on the exact same `{id, title, pageSize,
columns: [{key,label}], rows: [[cell,...]]}` shape before
`renderReportHtml` ever sees them — every cell already formatted to a
string, the same way `kpi.formatted` already is. That convergence is
deliberate: `renderTableSection()` and `TABLE_PAGINATION_JS` don't know
or care which mode produced a given table, so a third mode later needs
only its own `buildXTablePayload` function producing this same shape,
never a second render/pagination path. See
`docs/superpowers/specs/2026-09-06-publish-table-block-design.md`'s §4
for the fuller rationale.
```

- [ ] **Step 7: Final full-suite check**

Run: `./build.sh --check && node test/run.js`
Expected: `build.sh: src.js is up to date.` and every test passes.

- [ ] **Step 8: Commit**

```bash
git add src/publish.js test/publish.test.js docs/publish.md src/publish.md
git commit -m "feat: render publish's table block with client-side pagination

Static first page (readable with zero JS) plus Previous/Next controls
that page through the full embedded row set - one generic pagination
script, emitted only when config.tables is non-empty, shared by both
raw and aggregated tables since they already converge on one payload
shape. Docs updated for both audiences."
```

- [ ] **Step 9: Write the `notsobigtests` fixture description (Layer 2, no code yet)**

Real BigQuery/Drive I/O isn't fakeable headless — per this repo's "write the fixture before the `src/` change" rule for connector-facing work, describe what the companion `notsobigtests` PR needs (link it from this feature's own PR description, per `CLAUDE.md`'s "Open the PR" step):

> Fixture: reuse (or extend) the existing `publish` Layer 2 fixture's underlying BigQuery table, adding at least 3 more rows than one `pageSize` (e.g. `pageSize: 5` with 8+ source rows). A `publish` node with one `raw`-mode `tables` entry (a couple of source columns) and one `aggregated`-mode entry (`groupBy` + one `sum` metric). Expected result: `cli('run --select <name>')` reports `status: 'success'`; the written `.html`, opened in a browser, shows exactly `pageSize` rows on load for the raw table, a "Page 1 of N" label matching the row count, and clicking "Next" reveals the next slice of rows without a full page reload. Same create-mode Drive-target cleanup rule as every other Layer 2 `publish` fixture (`CLAUDE.md`'s "Drive-target tests that create a new file must clean up after themselves") — assert on `report.results[0].result.driveFileId` (or the per-node result shape this repo's `cli()` currently returns) and trash that file after.

This description is what actually gets written into the `notsobigtests` companion PR once Task 3 is merged — it is not automated in this repository, and is not part of `node test/run.js`.

---

## Self-Review

**Spec coverage:** §2 schema (`tables[]`, both modes, `pageSize` default) → Task 1 (validation) + Task 2 (payload shape) ✓. §3 validation (mode/columns/groupBy/metrics/format rules, shared `PUBLISH_VALUE_FORMATS`) → Task 1 ✓. §4 data flow (raw column mapping, aggregated grouping reusing `computeAggregate`, `formatValue`'s `'string'` branch, one converged payload shape) → Task 2 ✓. §5 render (static first page, inert-without-JS pager, one generic script gated on non-empty `tables[]`, `textContent`-only DOM writes) → Task 3 ✓. §6 CSS (hairline/mono convention, no new tokens) → Task 3 Step 3 ✓. §7 testing (Layer 1 validation/payload/render cases, Layer 2 fixture-first description) → Task 1/2/3 Steps + Task 3 Step 9 ✓. §8 docs (`docs/publish.md` new section + "What's not here yet" update, `src/publish.md` dev note, no README change needed) → Task 3 Steps 5-6 ✓.

**Placeholder scan:** no TBD/TODO; every step has runnable code or an exact, quoted doc addition.

**Type consistency:** `buildReportPayload(config, rows)` still returns `{kpis, charts, tables}` — `tables` introduced in Task 2, never renamed. `{id, title, pageSize, columns: [{key,label}], rows: [[cell,...]]}` is the exact shape both `buildRawTablePayload`/`buildAggregatedTablePayload` (Task 2) produce and `renderTableSection`/`TABLE_PAGINATION_JS` (Task 3) consume — checked field-by-field across both tasks' Interfaces blocks. `PUBLISH_VALUE_FORMATS` is defined once (Task 1) and only ever read (Task 1's `kpis[]`/`tables[]` checks); no task redefines or shadows it.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-06-publish-table-block.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
