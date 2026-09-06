# Publish D3 Chart Engine (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap `publish`'s `charts[]` render engine from hand-rolled inline SVG to D3 (pinned-version CDN), widening the chart-type catalog from `bar`-only to `bar`/`line`/`pie`, with an optional `series`/`stacking` pair on `bar` for grouped/stacked bars.

**Architecture:** No new module, no new node kind — all changes live in the existing `src/publish.js`. `buildReportPayload`'s chart computation stays pure/server-side (no aggregation moves to the browser in this phase); only the *render* step changes, from building a finished `<svg>` string at generation time to emitting an empty mount point plus a client-side D3 script that draws into it once the browser loads the page. `validatePublishConfig` widens to the new schema fields.

**Tech Stack:** Google Apps Script (V8 runtime), plain JS (no bundler/transpiler — see `CLAUDE.md`'s "One file to install, three files to author"), D3 v7.9.0 loaded from a pinned cdnjs URL, Node's `assert`-based test harness (`test/harness.js`, `test/run.js`) for Layer 1.

**Spec:** `docs/superpowers/specs/2026-09-06-publish-d3-charts-design.md`

## Global Constraints

- D3 is loaded from exactly `https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js` (verified reachable — `curl -sI` returns `200`) — never a floating tag (`d3.v7.min.js`) or an "unpkg latest" URL. This is a **permanent, deliberate break** from `publish`'s prior "no CDN, works offline forever" promise: every report with a non-empty `charts[]` now needs internet at the moment a human opens the generated `.html`, not just ones using the new chart types. Generation (`cli('run')`, including unattended scheduled runs) is unaffected — only the viewer's browser touches the CDN, later.
- No new dependency beyond D3 — no Chart.js, no p5.js, no declarative-grammar layer (all considered and rejected during brainstorming, see spec §3).
- `buildReportPayload` stays pure (no GAS globals) — this phase adds no browser-side aggregation; the browser only draws what the server already computed.
- Every new/changed error message follows the existing `'publish(): ...'` prefix convention.
- `./build.sh` must be run (and `./build.sh --check` must pass) before any test run, since `test/harness.js` loads the committed `src.js`, not `src/*.js` directly.
- Branch: `feat/publish-d3-charts`, cut from `release/16` (the active release branch — confirm with `git branch -a --list '*release/*'` before starting; do not branch from `main`). Merge the spec-only branch `docs/publish-d3-charts-design` (already committed, holds only the design spec doc) into this branch first, so the spec commit travels with the implementation in one PR — same precedent as `docs/publish-kind-design` merging into `feat/publish-kind-v1`.

---

### Task 0: Branch setup

**Files:** none (git operations only)

- [ ] **Step 1: Confirm the active release branch**

```bash
git branch -a --list '*release/*'
```
Expected: exactly one `release/N` branch (currently `release/16`). If none exists, stop — this plan assumes one is already active.

- [ ] **Step 2: Create the feature branch off release/16**

```bash
git checkout release/16
git pull origin release/16
git checkout -b feat/publish-d3-charts
```

- [ ] **Step 3: Merge in the spec-only branch**

```bash
git merge docs/publish-d3-charts-design --no-edit
```
Expected: fast-forward or clean merge bringing in exactly one file,
`docs/superpowers/specs/2026-09-06-publish-d3-charts-design.md`.

---

### Task 1: Widen chart-type validation

**Files:**
- Modify: `src/publish.js:44-51` (the `(config.charts || []).forEach(...)` block inside `validatePublishConfig`)
- Modify: `test/fixtures/publish-nodes.js:83-91` (`badChartTypePublish` — `type: 'line'` is about to become *valid*, so this fixture needs a still-invalid type to keep testing the enum-rejection path)
- Modify: `test/fixtures/publish-nodes.js` (add 4 new fixtures after `badChartTypePublish`)
- Modify: `test/publish.test.js` (rename/update one test, add 4 new tests, update `module.exports`)

**Interfaces:**
- Produces: `CHART_TYPES` (array constant, `['bar', 'line', 'pie']`), used by Task 2/3's render dispatch and referenced in error messages.
- Consumes: nothing new — `emptyMap`/`has` (already in scope from `move.js`, same closure) are not needed here.

- [ ] **Step 1: Write the failing tests**

In `test/fixtures/publish-nodes.js`, change `badChartTypePublish`'s chart type from `'line'` (about to become valid) to `'scatter'` (still invalid — deferred per the spec's non-goals):

```javascript
var badChartTypePublish = {
  kind: 'publish',
  name: 'badChartTypePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-chart-type.html' },
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }],
  charts: [{ id: 'by_category', type: 'scatter', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }]
};
```

Immediately after it, add four new fixtures:

```javascript
var chartSeriesOnNonBarPublish = {
  kind: 'publish',
  name: 'chartSeriesOnNonBarPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'chart-series-on-non-bar.html' },
  charts: [{ id: 'trend', type: 'line', title: 'Trend', groupBy: 'day', series: 'channel', metric: { agg: 'sum', field: 'revenue' } }]
};

var chartDonutOnNonPiePublish = {
  kind: 'publish',
  name: 'chartDonutOnNonPiePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'chart-donut-on-non-pie.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', donut: true, metric: { agg: 'sum', field: 'revenue' } }]
};

var chartBadStackingPublish = {
  kind: 'publish',
  name: 'chartBadStackingPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'chart-bad-stacking.html' },
  charts: [{ id: 'by_category_channel', type: 'bar', title: 'By category/channel', groupBy: 'category', series: 'channel', stacking: 'overlapping', metric: { agg: 'sum', field: 'revenue' } }]
};

// Proves the widened enum (bar/line/pie) plus series+stacking and donut
// all pass validation - fails only at the un-shimmed BigQuery call, same
// proof pattern as testPublishValidRefProceedsPastValidation.
var chartsV2Publish = {
  kind: 'publish',
  name: 'chartsV2Publish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'charts-v2.html' },
  charts: [
    { id: 'trend', type: 'line', title: 'Trend', groupBy: 'day', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'share', type: 'pie', title: 'Share', groupBy: 'category', donut: true, metric: { agg: 'sum', field: 'revenue' } },
    { id: 'by_category_channel', type: 'bar', title: 'By category/channel', groupBy: 'category', series: 'channel', stacking: 'stacked', metric: { agg: 'sum', field: 'revenue' } }
  ]
};
```

In `test/publish.test.js`, replace the existing `testPublishChartTypeOtherThanBarRejected` function with:

```javascript
function testPublishUnknownChartTypeRejected() {
  var result = runOne('badChartTypePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/expected one of bar, line, pie/.test(result.error), 'expected a chart-type error, got: ' + result.error);
}

function testPublishChartSeriesOnNonBarRejected() {
  var result = runOne('chartSeriesOnNonBarPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"series"\/"stacking", which only "bar" charts support/.test(result.error), 'expected a series-on-non-bar error, got: ' + result.error);
}

function testPublishChartDonutOnNonPieRejected() {
  var result = runOne('chartDonutOnNonPiePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"donut", which only "pie" charts support/.test(result.error), 'expected a donut-on-non-pie error, got: ' + result.error);
}

function testPublishChartBadStackingRejected() {
  var result = runOne('chartBadStackingPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/expected "grouped" or "stacked"/.test(result.error), 'expected a stacking-enum error, got: ' + result.error);
}

function testPublishV2ChartTypesProceedPastValidation() {
  var result = runOne('chartsV2Publish');
  // Same proof pattern as testPublishValidRefProceedsPastValidation: no
  // BigQuery shim in this test, so a config that gets all the way past
  // validation fails next at the un-shimmed BigQuery call, not at
  // validation.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation to pass and fail only at the BigQuery call, got: ' + result.error);
}
```

Update `module.exports` at the bottom of `test/publish.test.js`: replace
`testPublishChartTypeOtherThanBarRejected: testPublishChartTypeOtherThanBarRejected,`
with:

```javascript
  testPublishUnknownChartTypeRejected: testPublishUnknownChartTypeRejected,
  testPublishChartSeriesOnNonBarRejected: testPublishChartSeriesOnNonBarRejected,
  testPublishChartDonutOnNonPieRejected: testPublishChartDonutOnNonPieRejected,
  testPublishChartBadStackingRejected: testPublishChartBadStackingRejected,
  testPublishV2ChartTypesProceedPastValidation: testPublishV2ChartTypesProceedPastValidation,
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
./build.sh && node test/run.js
```
Expected: `testPublishUnknownChartTypeRejected` fails (current code still says `only "bar" is supported`, not the new message), and the four new tests fail with a `TypeError`/reference error or wrong-message assertion, since `validatePublishConfig` doesn't check `series`/`donut`/`stacking` yet.

- [ ] **Step 3: Implement the validation**

In `src/publish.js`, add near the top (right after the existing `PUBLISH_VALUE_FORMATS` constant at line 13):

```javascript
// The chart types charts[] accepts - see the design spec's §2. 'bar' also
// accepts an optional series/stacking pair for grouped/stacked bars; that
// isn't a separate type, just an optional second dimension on 'bar'.
var CHART_TYPES = ['bar', 'line', 'pie'];
```

Replace the chart-validation block (currently `src/publish.js:44-51`):

```javascript
  (config.charts || []).forEach(function (chart) {
    if (!chart.id || !chart.title || !chart.groupBy || !chart.metric || !chart.metric.agg) {
      throw new Error('publish(): every chart needs "id", "title", "groupBy", and "metric.agg".');
    }
    if (chart.type && chart.type !== 'bar') {
      throw new Error('publish(): chart "' + chart.id + '" has type "' + chart.type + '" - only "bar" is supported.');
    }
  });
```

with:

```javascript
  (config.charts || []).forEach(function (chart) {
    if (!chart.id || !chart.title || !chart.groupBy || !chart.metric || !chart.metric.agg) {
      throw new Error('publish(): every chart needs "id", "title", "groupBy", and "metric.agg".');
    }
    var chartType = chart.type || 'bar';
    if (CHART_TYPES.indexOf(chartType) === -1) {
      throw new Error('publish(): chart "' + chart.id + '" has type "' + chartType + '" - expected one of ' + CHART_TYPES.join(', ') + '.');
    }
    if ((chart.series || chart.stacking) && chartType !== 'bar') {
      throw new Error('publish(): chart "' + chart.id + '" has "series"/"stacking", which only "bar" charts support.');
    }
    if (chart.stacking && ['grouped', 'stacked'].indexOf(chart.stacking) === -1) {
      throw new Error('publish(): chart "' + chart.id + '" has stacking "' + chart.stacking + '" - expected "grouped" or "stacked".');
    }
    if (chart.donut !== undefined && chartType !== 'pie') {
      throw new Error('publish(): chart "' + chart.id + '" has "donut", which only "pie" charts support.');
    }
  });
```

Note (not a step, just context for the implementer): `stacking` present without `series` on a `bar` chart is deliberately **not** validated as an error — it's harmless (Task 2/3's series-branch code only runs when `chart.series` is set, so a stray `stacking` with no `series` is simply never read). Adding a check for that combination would be validating something that can't cause a wrong result, not a real config error.

- [ ] **Step 4: Run tests to verify they pass**

```bash
./build.sh && node test/run.js
```
Expected: all `publish.test.js` tests pass, including the 5 from Step 1.

- [ ] **Step 5: Commit**

```bash
git add src/publish.js test/fixtures/publish-nodes.js test/publish.test.js
git commit -m "feat: widen publish's chart type validation to bar/line/pie"
```

---

### Task 2: Chart payload computation (sorting + grouped/stacked matrix)

**Files:**
- Modify: `src/publish.js:255-271` (`buildReportPayload`'s chart-mapping block)
- Modify: `test/fixtures/publish-nodes.js` (add 3 new fixtures)
- Modify: `test/publish.test.js` (add 3 new tests, update `module.exports`)

**Interfaces:**
- Consumes: `CHART_TYPES` (Task 1), `groupRowsBy`/`computeAggregate`/`emptyMap`/`has` (already in `src/publish.js`).
- Produces: `buildChartPayload(chart, rows)` — returns `{ id, title, type, data, donut }` for a plain chart (`data: [{groupValue, total}]`, sorted ascending by `groupValue` when `type === 'line'`, insertion order otherwise — unchanged from today's shape for `bar`/`pie`), or `{ id, title, type, series, stacking, seriesKeys, data }` when `chart.series` is set (`data: [{groupValue, values: {seriesKey: total, ...}}]`, dense — every `seriesKeys` entry present in every `values` map, zero-filled where the source has no matching rows). Called from `buildReportPayload`, which now just does `(config.charts || []).map(function (chart) { return buildChartPayload(chart, rows); })`. Task 3's render code consumes this shape.

- [ ] **Step 1: Write the failing tests**

In `test/fixtures/publish-nodes.js`, add after `chartsV2Publish`:

```javascript
var lineChartPublish = {
  kind: 'publish',
  name: 'lineChartPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'line-chart.html' },
  charts: [{ id: 'trend', type: 'line', title: 'Trend', groupBy: 'day', metric: { agg: 'sum', field: 'revenue' } }]
};

var lineChartDatePublish = {
  kind: 'publish',
  name: 'lineChartDatePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'line-chart-date.html' },
  charts: [{ id: 'trend', type: 'line', title: 'Trend', groupBy: 'order_date', metric: { agg: 'sum', field: 'revenue' } }]
};

var seriesChartPublish = {
  kind: 'publish',
  name: 'seriesChartPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'series-chart.html' },
  charts: [{ id: 'by_category_channel', type: 'bar', title: 'By category/channel', groupBy: 'category', series: 'channel', stacking: 'stacked', metric: { agg: 'sum', field: 'revenue' } }]
};
```

In `test/publish.test.js`, add (near `testPublishBuildsRawAndAggregatedTablePayloads`, which already establishes the `shimBigQueryAndDrive`/`extractPayload` pattern this reuses):

```javascript
function testPublishLineChartSortsGroupsByNumericValue() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['day', 'revenue'], [
    ['3', '30'],
    ['1', '10'],
    ['2', '20']
  ]);

  var result = ctx.NotSoBigData.cli('run --select lineChartPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());
  var chart = payload.charts.filter(function (c) { return c.id === 'trend'; })[0];
  assert.deepStrictEqual(chart.data.map(function (d) { return d.groupValue; }), ['1', '2', '3'],
    'expected line chart groups sorted ascending numerically, got: ' + JSON.stringify(chart.data));
}

function testPublishLineChartSortsGroupsByDateString() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['order_date', 'revenue'], [
    ['2026-01-03', '30'],
    ['2026-01-01', '10'],
    ['2026-01-02', '20']
  ]);

  var result = ctx.NotSoBigData.cli('run --select lineChartDatePublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());
  var chart = payload.charts.filter(function (c) { return c.id === 'trend'; })[0];
  assert.deepStrictEqual(chart.data.map(function (d) { return d.groupValue; }), ['2026-01-01', '2026-01-02', '2026-01-03'],
    'expected line chart groups sorted ascending by ISO date string, got: ' + JSON.stringify(chart.data));
}

function testPublishSeriesChartBuildsDenseZeroFilledMatrix() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue'], [
    ['A', 'online', '10'],
    ['A', 'store', '5'],
    ['B', 'online', '20']
    // B/store deliberately missing - proves zero-fill.
  ]);

  var result = ctx.NotSoBigData.cli('run --select seriesChartPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());
  var chart = payload.charts.filter(function (c) { return c.id === 'by_category_channel'; })[0];

  assert.deepStrictEqual(chart.seriesKeys, ['online', 'store'], 'expected seriesKeys in first-seen order, got: ' + JSON.stringify(chart.seriesKeys));
  var groupA = chart.data.filter(function (d) { return d.groupValue === 'A'; })[0];
  var groupB = chart.data.filter(function (d) { return d.groupValue === 'B'; })[0];
  assert.strictEqual(groupA.values.online, 10, 'expected A/online = 10, got: ' + JSON.stringify(groupA));
  assert.strictEqual(groupA.values.store, 5, 'expected A/store = 5, got: ' + JSON.stringify(groupA));
  assert.strictEqual(groupB.values.online, 20, 'expected B/online = 20, got: ' + JSON.stringify(groupB));
  assert.strictEqual(groupB.values.store, 0, 'expected B/store zero-filled to 0, got: ' + JSON.stringify(groupB));
}
```

Add to `module.exports`:

```javascript
  testPublishLineChartSortsGroupsByNumericValue: testPublishLineChartSortsGroupsByNumericValue,
  testPublishLineChartSortsGroupsByDateString: testPublishLineChartSortsGroupsByDateString,
  testPublishSeriesChartBuildsDenseZeroFilledMatrix: testPublishSeriesChartBuildsDenseZeroFilledMatrix,
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
./build.sh && node test/run.js
```
Expected: all three new tests fail (`buildReportPayload` doesn't sort or build a series matrix yet — `chart.seriesKeys`/sorted order won't exist).

- [ ] **Step 3: Implement `buildChartPayload`**

In `src/publish.js`, add this new function right before `buildReportPayload` (currently at line 255):

```javascript
// Numeric-aware ascending compare for line charts' groupValue ordering -
// numeric if both sides parse as numbers (covers plain numbers and
// ISO-format date strings' *year* component alone would sort wrong
// numerically, which is exactly why non-numeric strings fall through to
// plain string compare: 'YYYY-MM-DD' sorts correctly as a string already).
function compareGroupValues(a, b) {
  var numA = Number(a);
  var numB = Number(b);
  if (!isNaN(numA) && !isNaN(numB) && a !== '' && b !== '') {
    return numA - numB;
  }
  return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
}

// One chart's payload - either the plain {groupValue, total} shape every
// chart type has used since v1 (bar/pie, and line which additionally
// sorts it), or, when chart.series is set, a dense {groupValue, values}
// matrix: every seriesKeys entry present in every group's `values`, zero
// where the source rows had no matching combination. Dense on purpose -
// Task 3's client-side d3.stack() code never has to special-case a
// missing combination.
function buildChartPayload(chart, rows) {
  var chartType = chart.type || 'bar';
  if (chart.series) {
    var seriesSeen = emptyMap();
    var seriesKeys = [];
    var groupSeen = emptyMap();
    var groupKeys = [];
    var cellRows = emptyMap();
    rows.forEach(function (row) {
      var groupKey = row[chart.groupBy];
      var seriesKey = row[chart.series];
      if (!has(groupSeen, groupKey)) {
        groupSeen[groupKey] = true;
        groupKeys.push(groupKey);
      }
      if (!has(seriesSeen, seriesKey)) {
        seriesSeen[seriesKey] = true;
        seriesKeys.push(seriesKey);
      }
      var cellKey = groupKey + ' ' + seriesKey;
      if (!has(cellRows, cellKey)) {
        cellRows[cellKey] = [];
      }
      cellRows[cellKey].push(row);
    });
    var data = groupKeys.map(function (groupKey) {
      var values = emptyMap();
      seriesKeys.forEach(function (seriesKey) {
        var cellKey = groupKey + ' ' + seriesKey;
        values[seriesKey] = computeAggregate(cellRows[cellKey] || [], chart.metric.agg, chart.metric.field);
      });
      return { groupValue: groupKey, values: values };
    });
    return { id: chart.id, title: chart.title, type: chartType, series: chart.series, stacking: chart.stacking || 'grouped', seriesKeys: seriesKeys, data: data };
  }
  var grouped = groupRowsBy(rows, chart.groupBy);
  var data = grouped.order.map(function (key) {
    return { groupValue: key, total: computeAggregate(grouped.groups[key], chart.metric.agg, chart.metric.field) };
  });
  if (chartType === 'line') {
    data.sort(function (a, b) { return compareGroupValues(a.groupValue, b.groupValue); });
  }
  return { id: chart.id, title: chart.title, type: chartType, donut: !!chart.donut, data: data };
}
```

Replace `buildReportPayload`'s chart-mapping block (currently `src/publish.js:260-266`):

```javascript
  var charts = (config.charts || []).map(function (chart) {
    var grouped = groupRowsBy(rows, chart.groupBy);
    var data = grouped.order.map(function (key) {
      return { groupValue: key, total: computeAggregate(grouped.groups[key], chart.metric.agg, chart.metric.field) };
    });
    return { id: chart.id, title: chart.title, data: data };
  });
```

with:

```javascript
  var charts = (config.charts || []).map(function (chart) {
    return buildChartPayload(chart, rows);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
./build.sh && node test/run.js
```
Expected: all `publish.test.js` tests pass, including the 3 from Step 1. Also re-check `testPublishAggregatesKpisAndChartsCorrectly` and `testPublishBuildsRawAndAggregatedTablePayloads` still pass unchanged — plain `bar`/`pie` charts keep the exact same `{groupValue, total}` shape, so this should be a no-op for them.

- [ ] **Step 5: Commit**

```bash
git add src/publish.js test/fixtures/publish-nodes.js test/publish.test.js
git commit -m "feat: compute publish's line-chart ordering and grouped/stacked chart matrix"
```

---

### Task 3: D3 render engine (markup, CDN script, client-side draw dispatch)

**Files:**
- Modify: `src/publish.js:44` region unaffected; actual changes at `src/publish.js:282-300` (delete `renderBarChartSvg`), `:363-417` (rename `TABLE_PAGINATION_JS` region is untouched — this task only adds a new `CHART_CLIENT_JS` constant and changes `renderReportHtml`)
- Modify: `test/publish.test.js` (fix 2 assertions in `testPublishAggregatesKpisAndChartsCorrectly` that depended on the old inline-SVG text; add 4 new tests; update `module.exports`)

**Interfaces:**
- Consumes: `buildChartPayload`'s output shape (Task 2) — `{id, title, type, data, donut}` or `{id, title, type, series, stacking, seriesKeys, data}`.
- Produces: `D3_CDN_URL` (string constant), `CHART_CLIENT_JS` (string constant, same authoring pattern as the existing `TABLE_PAGINATION_JS`), both consumed by `renderReportHtml`. Nothing outside `renderReportHtml` calls these.

- [ ] **Step 1: Write the failing tests**

In `test/publish.test.js`, fix `testPublishAggregatesKpisAndChartsCorrectly`'s last two assertions (currently checking chart totals as literal SVG text, which no longer exists once charts render client-side). Replace:

```javascript
  // groupBy category, sum(revenue): A = 30, B = 5
  assert.ok(html.indexOf('>A<') !== -1 && html.indexOf('>30<') !== -1, 'expected category A\'s total (30) in: ' + html);
  assert.ok(html.indexOf('>B<') !== -1 && html.indexOf('>5<') !== -1, 'expected category B\'s total (5) in: ' + html);
```

with:

```javascript
  // groupBy category, sum(revenue): A = 30, B = 5 - charts render
  // client-side now (Task 3), so the totals only exist in the embedded
  // payload, not as literal SVG text.
  var chartPayload = extractPayload(html).charts.filter(function (c) { return c.id === 'by_category'; })[0];
  var totalsByGroup = {};
  chartPayload.data.forEach(function (d) { totalsByGroup[d.groupValue] = d.total; });
  assert.strictEqual(totalsByGroup.A, 30, 'expected category A total 30 in the chart payload, got: ' + JSON.stringify(chartPayload.data));
  assert.strictEqual(totalsByGroup.B, 5, 'expected category B total 5 in the chart payload, got: ' + JSON.stringify(chartPayload.data));
```

Then add these new tests (near `testPublishRawTableRendersFirstPageAndEmbedsFullData`, which already establishes the "regex-check the generated markup" pattern this reuses):

```javascript
function testPublishChartRendersMountPointAndD3Script() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);

  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/<section class="chart" data-chart-id="by_category">/.test(html), 'expected a chart section with data-chart-id, got: ' + html);
  assert.ok(/<div class="chart-canvas" id="chart-by_category"><\/div>/.test(html), 'expected an empty chart-canvas mount point, got: ' + html);
  assert.ok(html.indexOf('https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js') !== -1, 'expected the pinned D3 CDN script tag, got: ' + html);
  assert.ok(!/<svg/.test(html), 'expected no server-rendered <svg> now that charts draw client-side, got: ' + html);
}

function testPublishNoD3ScriptWithoutCharts() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['order_id', 'revenue'], [['o1', '10']]);

  var result = ctx.NotSoBigData.cli('run --select validPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(html.indexOf('d3.min.js') === -1, 'expected no D3 script tag when config.charts is empty, got: ' + html);
}

function testPublishChartClientJsDispatchesByType() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'day', 'channel', 'revenue'], [['A', '1', 'online', '10']]);

  var result = ctx.NotSoBigData.cli('run --select chartsV2Publish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/function drawBarChart/.test(html), 'expected drawBarChart in the emitted script, got: ' + html);
  assert.ok(/function drawLineChart/.test(html), 'expected drawLineChart in the emitted script, got: ' + html);
  assert.ok(/function drawPieChart/.test(html), 'expected drawPieChart in the emitted script, got: ' + html);
  assert.ok(/typeof d3 === "undefined"/.test(html), 'expected a d3-unavailable fallback guard, got: ' + html);
}

function testPublishAggregationFixtureStillHasNoStacking() {
  // Sanity check that the plain (non-series) chart path still produces
  // {groupValue, total} data, not the series {groupValue, values} shape -
  // guards against Task 2/3 accidentally cross-wiring the two branches.
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var chart = extractPayload(getHtml()).charts[0];
  assert.strictEqual(chart.data[0].total, 10, 'expected plain total shape, got: ' + JSON.stringify(chart.data));
  assert.strictEqual(chart.seriesKeys, undefined, 'expected no seriesKeys on a non-series chart, got: ' + JSON.stringify(chart));
}
```

Add to `module.exports`:

```javascript
  testPublishChartRendersMountPointAndD3Script: testPublishChartRendersMountPointAndD3Script,
  testPublishNoD3ScriptWithoutCharts: testPublishNoD3ScriptWithoutCharts,
  testPublishChartClientJsDispatchesByType: testPublishChartClientJsDispatchesByType,
  testPublishAggregationFixtureStillHasNoStacking: testPublishAggregationFixtureStillHasNoStacking,
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
./build.sh && node test/run.js
```
Expected: `testPublishAggregatesKpisAndChartsCorrectly` still passes (payload shape didn't change), but the 4 new tests fail — no `chart-canvas`/D3 script/`drawBarChart` exist yet, and `<svg` is still present (old `renderBarChartSvg` still runs).

- [ ] **Step 3: Implement the render engine**

Delete `renderBarChartSvg` entirely (currently `src/publish.js:282-300`, right before the `REPORT_CSS` constant) — nothing calls it once this step is done.

Add a new constant near the top of the file, right after `CHART_TYPES` (added in Task 1):

```javascript
// Pinned exact version, never a floating tag - see CLAUDE.md's
// "Downstream consumers pinned to a release" for the same reasoning
// applied to a different kind of pin: a file reopened a year from now
// must load the exact D3 build it loaded the day it was generated.
var D3_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';
```

Add `CHART_CLIENT_JS` right after `TABLE_PAGINATION_JS` (after line 396, before `function renderReportHtml`):

```javascript
// Client-side chart draw dispatch, mirroring TABLE_PAGINATION_JS's
// authoring pattern (an array of literal JS-source lines, joined once).
// buildReportPayload (Task 2) already computed every number; this only
// draws it. Reuses REPORT_CSS's existing .chart-bar/.chart-label/
// .chart-value class names on the elements D3 creates, so the fixed
// design tokens apply without any CSS change - see the design spec §5.
var CHART_CLIENT_JS = [
  'function renderChartFallback(containerId, chart) {',
  '  var container = document.getElementById(containerId);',
  '  var list = document.createElement("ul");',
  '  (chart.data || []).forEach(function (d) {',
  '    var li = document.createElement("li");',
  '    var value = d.total !== undefined ? d.total : Object.keys(d.values || {}).reduce(function (sum, k) { return sum + d.values[k]; }, 0);',
  '    li.textContent = d.groupValue + ": " + value.toLocaleString("en-US");',
  '    list.appendChild(li);',
  '  });',
  '  container.appendChild(list);',
  '}',
  'function drawBarChart(containerId, chart) {',
  '  var width = 480, height = 240, margin = { top: 10, right: 40, bottom: 10, left: 160 };',
  '  var svg = d3.select("#" + containerId).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title);',
  '  var groupValues = chart.data.map(function (d) { return d.groupValue; });',
  '  var y = d3.scaleBand().domain(groupValues).range([margin.top, height - margin.bottom]).padding(0.2);',
  '  var color = d3.scaleOrdinal().range(["#3F6659", "#B65A3C", "#6B6A61", "#DCE6E1"]);',
  '  if (chart.seriesKeys && chart.seriesKeys.length) {',
  '    color.domain(chart.seriesKeys);',
  '    if (chart.stacking === "stacked") {',
  '      var stackRows = chart.data.map(function (d) { var row = { groupValue: d.groupValue }; chart.seriesKeys.forEach(function (k) { row[k] = d.values[k]; }); return row; });',
  '      var stacked = d3.stack().keys(chart.seriesKeys)(stackRows);',
  '      var maxTotal = d3.max(stackRows, function (row) { return chart.seriesKeys.reduce(function (sum, k) { return sum + row[k]; }, 0); }) || 1;',
  '      var x = d3.scaleLinear().domain([0, maxTotal]).range([margin.left, width - margin.right]);',
  '      svg.append("g").selectAll("g").data(stacked).join("g")',
  '        .attr("class", "chart-bar").attr("fill", function (d) { return color(d.key); })',
  '        .selectAll("rect").data(function (d) { return d; }).join("rect")',
  '        .attr("y", function (d) { return y(d.data.groupValue); }).attr("x", function (d) { return x(d[0]); })',
  '        .attr("width", function (d) { return x(d[1]) - x(d[0]); }).attr("height", y.bandwidth());',
  '    } else {',
  '      var maxValue = d3.max(chart.data, function (d) { return d3.max(chart.seriesKeys, function (k) { return d.values[k]; }); }) || 1;',
  '      var x = d3.scaleLinear().domain([0, maxValue]).range([margin.left, width - margin.right]);',
  '      var y1 = d3.scaleBand().domain(chart.seriesKeys).range([0, y.bandwidth()]).padding(0.05);',
  '      svg.append("g").selectAll("g").data(chart.data).join("g")',
  '        .attr("transform", function (d) { return "translate(0," + y(d.groupValue) + ")"; })',
  '        .selectAll("rect").data(function (d) { return chart.seriesKeys.map(function (k) { return { key: k, value: d.values[k] }; }); }).join("rect")',
  '        .attr("class", "chart-bar").attr("fill", function (d) { return color(d.key); })',
  '        .attr("y", function (d) { return y1(d.key); }).attr("x", margin.left)',
  '        .attr("width", function (d) { return x(d.value) - margin.left; }).attr("height", y1.bandwidth());',
  '    }',
  '  } else {',
  '    var maxTotal = d3.max(chart.data, function (d) { return d.total; }) || 1;',
  '    var x = d3.scaleLinear().domain([0, maxTotal]).range([margin.left, width - margin.right]);',
  '    svg.append("g").selectAll("rect").data(chart.data).join("rect")',
  '      .attr("class", "chart-bar").attr("y", function (d) { return y(d.groupValue); }).attr("x", margin.left)',
  '      .attr("width", function (d) { return x(d.total) - margin.left; }).attr("height", y.bandwidth());',
  '    svg.append("g").selectAll("text").data(chart.data).join("text")',
  '      .attr("class", "chart-value").attr("x", function (d) { return x(d.total) + 6; })',
  '      .attr("y", function (d) { return y(d.groupValue) + y.bandwidth() / 2 + 4; }).text(function (d) { return d.total.toLocaleString("en-US"); });',
  '  }',
  '  svg.append("g").selectAll("text.chart-label").data(groupValues).join("text")',
  '    .attr("class", "chart-label").attr("x", 0).attr("y", function (d) { return y(d) + y.bandwidth() / 2 + 4; }).text(function (d) { return d; });',
  '}',
  'function drawLineChart(containerId, chart) {',
  '  var width = 480, height = 240, margin = { top: 10, right: 20, bottom: 30, left: 50 };',
  '  var svg = d3.select("#" + containerId).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title);',
  '  var x = d3.scalePoint().domain(chart.data.map(function (d) { return d.groupValue; })).range([margin.left, width - margin.right]);',
  '  var maxTotal = d3.max(chart.data, function (d) { return d.total; }) || 1;',
  '  var y = d3.scaleLinear().domain([0, maxTotal]).range([height - margin.bottom, margin.top]);',
  '  var line = d3.line().x(function (d) { return x(d.groupValue); }).y(function (d) { return y(d.total); });',
  '  svg.append("path").datum(chart.data).attr("class", "chart-bar").attr("fill", "none").attr("stroke", "#3F6659").attr("stroke-width", 2).attr("d", line);',
  '  svg.append("g").selectAll("circle").data(chart.data).join("circle")',
  '    .attr("class", "chart-bar").attr("cx", function (d) { return x(d.groupValue); }).attr("cy", function (d) { return y(d.total); }).attr("r", 3);',
  '  svg.append("g").selectAll("text").data(chart.data).join("text")',
  '    .attr("class", "chart-label").attr("x", function (d) { return x(d.groupValue); }).attr("y", height - 8).attr("text-anchor", "middle").text(function (d) { return d.groupValue; });',
  '}',
  'function drawPieChart(containerId, chart) {',
  '  var width = 320, height = 320, radius = Math.min(width, height) / 2 - 20;',
  '  var svg = d3.select("#" + containerId).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title)',
  '    .append("g").attr("transform", "translate(" + width / 2 + "," + height / 2 + ")");',
  '  var color = d3.scaleOrdinal().range(["#3F6659", "#B65A3C", "#6B6A61", "#DCE6E1"]);',
  '  var pieGen = d3.pie().value(function (d) { return d.total; });',
  '  var arcGen = d3.arc().innerRadius(chart.donut ? radius * 0.55 : 0).outerRadius(radius);',
  '  svg.selectAll("path").data(pieGen(chart.data)).join("path")',
  '    .attr("class", "chart-bar").attr("fill", function (d) { return color(d.data.groupValue); }).attr("d", arcGen);',
  '  svg.selectAll("text").data(pieGen(chart.data)).join("text")',
  '    .attr("class", "chart-label").attr("transform", function (d) { return "translate(" + arcGen.centroid(d) + ")"; })',
  '    .attr("text-anchor", "middle").text(function (d) { return d.data.groupValue; });',
  '}',
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  Array.prototype.forEach.call(document.querySelectorAll(".chart"), function (section) {',
  '    var chartId = section.getAttribute("data-chart-id");',
  '    var chart = payload.charts.filter(function (c) { return c.id === chartId; })[0];',
  '    if (!chart) { return; }',
  '    var containerId = "chart-" + chartId;',
  '    if (typeof d3 === "undefined") {',
  '      renderChartFallback(containerId, chart);',
  '      return;',
  '    }',
  '    if (chart.type === "line") { drawLineChart(containerId, chart); }',
  '    else if (chart.type === "pie") { drawPieChart(containerId, chart); }',
  '    else { drawBarChart(containerId, chart); }',
  '  });',
  '});'
].join('\n');
```

Finally, change `renderReportHtml` (currently `src/publish.js:398-417`). Replace the `chartSections` line:

```javascript
  var chartSections = payload.charts.map(function (chart) {
    return '<section class="chart"><h2>' + escapeHtml(chart.title) + '</h2>' + renderBarChartSvg(chart) + '</section>';
  }).join('');
```

with:

```javascript
  var chartSections = payload.charts.map(function (chart) {
    return '<section class="chart" data-chart-id="' + escapeHtml(chart.id) + '"><h2>' + escapeHtml(chart.title) + '</h2>'
      + '<div class="chart-canvas" id="chart-' + escapeHtml(chart.id) + '"></div></section>';
  }).join('');
```

and change the script-assembly + head-building tail of the function:

```javascript
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
```

to:

```javascript
  var script = 'window.__PUBLISH_PAYLOAD__ = ' + JSON.stringify(payload).replace(/</g, '\\u003c') + ';';
  if (payload.tables.length) {
    script += TABLE_PAGINATION_JS;
  }
  if (payload.charts.length) {
    script += CHART_CLIENT_JS;
  }
  var d3Script = payload.charts.length ? '<script src="' + D3_CDN_URL + '"></script>' : '';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>' + escapeHtml(config.target.fileName) + '</title>'
    + '<style>' + REPORT_CSS + '</style>' + d3Script + '</head><body>'
    + '<main><div class="kpis">' + kpiCards + '</div>' + chartSections + tableSections + '</main>'
    + '<script>' + script + '</script>'
    + '</body></html>';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
./build.sh && node test/run.js
```
Expected: every test in `publish.test.js` passes, including the fixed `testPublishAggregatesKpisAndChartsCorrectly` and the 4 new tests from Step 1.

- [ ] **Step 5: Run the full suite and check the build**

```bash
./build.sh --check && node test/run.js
```
Expected: `src.js is up to date`, `N passed, 0 failed` (no regressions anywhere else in the suite).

- [ ] **Step 6: Commit**

```bash
git add src/publish.js test/publish.test.js
git commit -m "feat: render publish's charts with D3 (bar/line/pie, grouped/stacked bar)"
```

---

### Task 4: Docs

**Files:**
- Modify: `docs/publish.md`
- Modify: `README.md`
- Modify: `src/publish.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `docs/publish.md`**

Rewrite the file's opening paragraph (currently: *"`publish` turns a table another node already materialized in BigQuery ... into a self-contained `.html` dashboard file in Drive: KPI numbers, one bar chart, and paginated tables ... No CDN, no build step, no server — the file works standalone once downloaded."*) to remove the now-inaccurate "no CDN"/"works standalone" claims **for charts specifically**:

```markdown
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
```

Replace the `charts[]` bullet in the "Config" section (currently *"`charts[]` — one `bar` chart per entry, aggregated by `groupBy` in JS (never in SQL, never in the browser)."*) and the worked example's `charts` block with the widened schema. Add a new `### charts[]` subsection (matching `### tables[]`'s existing structure) right before `### tables[]`:

```markdown
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
  `'stacked'`).
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
```

Update "What's not here yet" — remove the "Column-header sort and search... deferred until `filters`" framing's chart-adjacent context isn't touched, but add a pointer to the new spec:

```markdown
## What's not here yet

Filters, drill-down, per-block `source` overrides, cross-file
navigation, and a `board` tree layout are all planned but not
implemented — see `docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s
"Future direction" section (CSV export from that list now ships, see
`tables[]` above). Cross-chart interactivity (one chart reacting to
another's click/selection within the same file) is planned as a
follow-up to the D3 chart engine — see
`docs/superpowers/specs/2026-09-06-publish-d3-charts-design.md`.
Column-header sort and search for the `tables[]` block, and `filters`/
`linkTo` generally, are deliberately deferred until that follow-up is
designed, since they overlap with it — see that spec's "Relationship
to filters/linkTo" section.
```

- [ ] **Step 2: Update `README.md`**

Find the `publish` bullet under "The three kinds" (added when `publish` shipped) and correct its "no CDN, no build step" phrasing:

```markdown
- **`publish`** — turns a table a `move`/`model` node already
  materialized in BigQuery into a self-contained `.html` dashboard in
  Drive: KPIs and D3-rendered charts (bar/line/pie), computed in JS.
  Reads via `Tabledata.list` (no query job, no query cost) — never runs
  its own SQL. Charts need internet to view (D3 loads from a CDN in the
  browser); KPIs/tables stay fully offline. Full config →
  **[docs/publish.md](docs/publish.md)**.
```

- [ ] **Step 3: Update `src/publish.md`**

Add a new section at the end of the file:

```markdown
## Why D3 over Chart.js/p5.js/a declarative grammar

Considered and rejected during brainstorming (see
`docs/superpowers/specs/2026-09-06-publish-d3-charts-design.md`'s §3
for the full rationale): Chart.js renders to `<canvas>`, which would
mean re-implementing `REPORT_CSS`'s existing styling as JS config per
chart instead of reusing the `.chart-bar`/`.chart-label`/`.chart-value`
classes that already exist; p5.js has no chart primitives (scales,
axes, `pie()`/`stack()`) at all, so it would mean building those from
scratch, more work than D3 for no benefit; a declarative grammar
library (e.g. Observable Plot) was speculative for a fixed set of 4
chart types and had shakier native pie/donut support than D3's own
`d3-shape` module. D3 also renders actual SVG/DOM elements, so
`CHART_CLIENT_JS`'s draw functions apply the same class names
`renderBarChartSvg` used to hand-write, and `REPORT_CSS` needed no
changes.

`buildChartPayload` stays pure and server-side in this phase — no
aggregation happens in the browser. Cross-chart interactivity (Phase
2, not designed yet) is the point where the browser will need to
re-aggregate against a shared filter/selection state; this phase
deliberately doesn't build that machinery early.
```

- [ ] **Step 4: Commit**

```bash
git add docs/publish.md README.md src/publish.md
git commit -m "docs: document publish's D3 chart engine and the offline-promise change"
```

---

### Task 5: `notsobigtests` Layer 2 fixture

This task is in the **sibling repo** `notsobigtests`, not `notsobiglib` — see `notsobiglib`'s `CLAUDE.md`, "Feature branch workflow: Layer 1 + Layer 2". Branch there too (`feat/publish-d3-charts-fixture` off `main`, that repo has no `release/*` tier).

**Files:**
- Modify: `js/08-fixtures-publish-targets.js` (add a fixture with one chart of each new type)
- Modify: `js/28-tests-publish.js` (fix `testPublishGeneratesReportWithCorrectAggregates`'s two now-broken assertions, add one new test)
- Modify: `js/90-test-registry.js` (register the new test, point `SRC_REF` at `feat/publish-d3-charts`)

- [ ] **Step 1: Fix the now-broken assertions in `testPublishGeneratesReportWithCorrectAggregates`**

In `js/28-tests-publish.js`, add a small helper near the top of the file (mirrors `test/publish.test.js`'s `extractPayload` in `notsobiglib`, which this repo has no equivalent of yet):

```javascript
function extractPublishPayload(html) {
  var match = html.match(/window\.__PUBLISH_PAYLOAD__ = (.+?);/);
  if (!match) {
    throw new Error('expected an embedded __PUBLISH_PAYLOAD__ in the generated HTML');
  }
  return JSON.parse(match[1]);
}
```

Replace the chart assertions in `testPublishGeneratesReportWithCorrectAggregates` (currently checking `html.indexOf('Beverages') !== -1 && html.indexOf('>60<') !== -1`, which relied on the old inline-SVG text):

```javascript
  check('chart shows the Beverages group and its total', html.indexOf('Beverages') !== -1 && html.indexOf('>60<') !== -1,
    'expected a Beverages group with total 60');
  check('chart shows the Snacks group and its total', html.indexOf('Snacks') !== -1 && html.indexOf('>45<') !== -1,
    'expected a Snacks group with total 45');
```

with:

```javascript
  var chartPayload = extractPublishPayload(html).charts.filter(function (c) { return c.id === 'by_category'; })[0];
  var chartTotals = {};
  chartPayload.data.forEach(function (d) { chartTotals[d.groupValue] = d.total; });
  check('chart shows the Beverages group and its total', chartTotals.Beverages === 60, 'expected Beverages total 60, got: ' + JSON.stringify(chartPayload.data));
  check('chart shows the Snacks group and its total', chartTotals.Snacks === 45, 'expected Snacks total 45, got: ' + JSON.stringify(chartPayload.data));
```

- [ ] **Step 2: Add a fixture exercising line/pie/stacked-bar**

In `js/08-fixtures-publish-targets.js`, add after `salesPublish`:

```javascript
// D3 chart engine (notsobiglib feat/publish-d3-charts): one chart of
// each new type against the same 6-row sample loadPublishOrders already
// seeds - reuses that data rather than a fresh scratch table, since this
// isn't testing a different dataset, just different chart types over the
// one already-proven-correct dataset.
var chartTypesPublish = {
  kind: 'publish',
  name: 'chartTypesPublish',
  dependsOn: ['loadPublishOrders'],
  source: { type: 'ref', ref: 'loadPublishOrders' },
  target: { type: 'drive', folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'publish-chart-types.html', upsertByName: true },
  charts: [
    { id: 'by_order', type: 'line', title: 'Revenue by order', groupBy: 'order_id', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'share', type: 'pie', title: 'Share by category', donut: true, groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'by_category_stub', type: 'bar', title: 'By category (single-series)', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }
  ]
};
```

- [ ] **Step 3: Add the test**

In `js/28-tests-publish.js`, add after `testPublishTableBlockRendersRawAndAggregatedTables`:

```javascript
// D3 chart engine (notsobiglib feat/publish-d3-charts): a GAS test can't
// execute D3 or open a browser, so this only proves the pipeline reaches
// Drive with the right containers/payload for each new type - same
// ceiling notsobiglib's own Layer 1 tests already accept. The actual
// visual check is left to a human via testLog below.
function testPublishChartTypesRenderMountPointsAndPayload() {
  var result = runOne('chartTypesPublish');
  var html = DriveApp.getFileById(result.driveFileId).getBlob().getDataAsString();

  check('line chart mount point is present', html.indexOf('<div class="chart-canvas" id="chart-by_order">') !== -1, html);
  check('pie chart mount point is present', html.indexOf('<div class="chart-canvas" id="chart-share">') !== -1, html);
  check('bar chart mount point is present', html.indexOf('<div class="chart-canvas" id="chart-by_category_stub">') !== -1, html);
  check('pinned D3 CDN script tag is present', html.indexOf('cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js') !== -1, html);

  var payload = extractPublishPayload(html);
  var pieChart = payload.charts.filter(function (c) { return c.id === 'share'; })[0];
  check('pie chart payload has donut: true', pieChart.donut === true, JSON.stringify(pieChart));

  testLog('Chart-types report file id: ' + result.driveFileId + ' - open it in a browser and confirm '
    + 'all three charts actually render: a line chart (by order), a donut chart (by category), and a '
    + 'plain bar chart (by category) - client-side D3 drawing can\'t be verified from this Apps Script test.');
}
```

- [ ] **Step 4: Register the test and point `SRC_REF` at the feature branch**

In `js/90-test-registry.js`, add `testPublishChartTypesRenderMountPointsAndPayload` to the `publish` array in `TEST_CATEGORIES` (after `testPublishTableBlockRendersRawAndAggregatedTables` or wherever the branch's current tip has it), and set:

```javascript
SRC_REF: 'feat/publish-d3-charts',
```

- [ ] **Step 5: Deploy and run**

```bash
clasp push -f
```

Then in the Apps Script editor: run `setupScriptProperties()` once (SRC_REF changed), then `runAllTests('publish')`. Confirm all tests pass, then open the two report files (`publish-smoke-test.html` and `publish-chart-types.html`) in a real browser and visually confirm: the existing bar chart still renders correctly, and the new line/donut/bar-by-category charts in `chartTypesPublish` all draw correctly. Also worth one manual check with the D3 CDN URL blocked (browser dev tools' request-blocking) to confirm the fallback list appears instead of a blank chart area.

- [ ] **Step 6: Reset and commit**

After confirming, reset `SRC_REF` back to `main` (or the active release) and re-run `setupScriptProperties()`.

```bash
git add js/08-fixtures-publish-targets.js js/28-tests-publish.js js/90-test-registry.js
git commit -m "test: add Layer 2 fixture for publish's D3 chart engine (line/pie/stacked bar)"
```

---

## Self-review notes (for whoever executes this plan)

- **Spec coverage:** §2 (schema) → Task 1. §3 (D3 loading) → Task 3 (CDN URL) + Global Constraints. §4 (payload) → Task 2. §5 (render architecture, including the `typeof d3 === 'undefined'` fallback) → Task 3. §6 (validation) → Task 1. §7 (docs) → Task 4. §8 (testing) → Tasks 1-3 (Layer 1) + Task 5 (Layer 2).
- Task 3's Step 1 deliberately fixes `testPublishAggregatesKpisAndChartsCorrectly` (a Task-1/2-adjacent test broken by Task 3's own change, not by Task 1 or 2) — the break only happens once the static SVG text disappears, which is exactly Task 3's change, so the fix belongs there, in the same task/commit that causes it.
- After Task 3, `renderBarChartSvg` no longer exists — confirmed no other file in the repo calls it (`grep -rn "renderBarChartSvg" src/ test/` before Task 3's Step 3 as a sanity check is a cheap extra confirmation, not a formal step).
