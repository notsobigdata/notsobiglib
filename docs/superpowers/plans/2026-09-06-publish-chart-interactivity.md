# Publish Chart Cross-Chart Interactivity (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in `linkKey`/`seriesLinkKey` fields to `publish`'s `charts[]` config so that clicking a bar/slice/point in one chart visually dims every non-matching element in every other chart on the same report that declares a matching key — purely client-side, no recomputation of KPIs/tables/chart totals.

**Architecture:** `validatePublishConfig` gains one new throw case (`seriesLinkKey` misused); `buildChartPayload` passes `linkKey`/`seriesLinkKey` straight through into each chart's payload object (no new aggregation — payload computation stays pure); `CHART_CLIENT_JS` gains a small shared selection module (`currentSelection`, `handleChartClick`, `applyHighlight`) plus per-draw-function wiring (`data-group-value`/`data-series-value` attributes, `cursor: pointer`, a `.on("click", ...)` handler) gated on whether a chart declares either key.

**Tech Stack:** Plain ES5-style JS (this file's existing convention — no `const`/`let`/arrow functions anywhere in `src/publish.js` or its emitted client script), D3 v7 (already loaded, no new library).

**Spec:** `docs/superpowers/specs/2026-09-06-publish-chart-interactivity-design.md`

## Global Constraints

- No recomputation: KPI values, chart totals, and table rows never change on selection — only element opacity (spec §1).
- KPIs and `tables[]` are never touched by this feature — no new markup, no new JS reads their sections (spec §1, §4).
- Opt-in only: a chart with neither `linkKey` nor `seriesLinkKey` gets zero added listeners/attributes and is never highlighted by another chart's selection (spec §1, §2).
- `seriesLinkKey` valid only on `type: 'bar'` charts with `series` set — else throw at validation time (spec §5). Exact message: `publish(): chart "<id>" has "seriesLinkKey", which only "bar" charts with "series" support.`
- A segment click on a grouped/stacked bar produces one combined selection carrying both `linkKey` and `seriesLinkKey` values (AND semantics) — never two independent selections (spec §3).
- Matching considers only the keys the reacting chart itself declares that are also present in the current selection — a chart with none of its keys present in the selection is untouched (spec §3).
- Single global selection: clicking the already-selected element again clears it (`currentSelection = null`); clicking a different element replaces it (spec §3).
- Dimming uses `.style("opacity", ...)` (inline style) on already-drawn elements — no re-render, no new D3 data-join (spec §3). Per `src/publish.md`'s existing fill-priority note, any new `.style(...)` call follows the same "inline style, not `.attr(...)`, wins over `REPORT_CSS`" rule already established for `fill`.
- No new file added to `build.sh`'s `MODULES` manifest — everything stays inside the existing `src/publish.js` (spec §7).
- `linkKey`/`seriesLinkKey` are opaque strings compared only for equality — the library does not (and per spec §6, cannot) validate that two charts sharing a `linkKey` represent the same real-world dimension.

---

### Task 0: Worktree setup — branch off `release/16`, merge in the spec

**Files:** none (repo/branch setup only).

**Interfaces:** none — this task produces the workspace every later task runs in.

- [ ] **Step 1: Verify the base commit and existing branches**

```bash
cd /home/moschi/projetos/notsobig_org/notsobiglib
git fetch origin
git rev-parse release/16          # expect 6af3b908eb0e05309f05972a78b4557c74e62510
git log --oneline -1 docs/publish-chart-interactivity-design   # expect 90e09fb ...
```

- [ ] **Step 2: Create the isolated worktree for the feature branch, off `release/16`**

```bash
git worktree add .worktrees/feat-publish-chart-interactivity release/16 -b feat/publish-chart-interactivity
cd .worktrees/feat-publish-chart-interactivity
```

- [ ] **Step 3: Cherry-pick the spec-only commit from the docs branch onto the new feature branch**

```bash
git cherry-pick 90e09fb
git log --oneline -3
```

Expected: the top commit is now `docs: add design spec for publish's cross-chart interactivity (Phase 2)`, with `release/16`'s merge commit (`6af3b90 Merge pull request #84 ...`) directly below it.

- [ ] **Step 4: Verify a clean baseline**

```bash
./build.sh --check
node test/run.js
```

Expected: `build.sh --check` exits 0 (no diff between `src/` and the committed `src.js`), and every existing test in `node test/run.js` passes (this branch adds no code yet — only the cherry-picked doc).

---

### Task 1: Validate and pass through `linkKey`/`seriesLinkKey`

**Files:**
- Modify: `src/publish.js` (`validatePublishConfig` around line 86-88; `buildChartPayload` around lines 348 and 357)
- Modify: `test/fixtures/publish-nodes.js` (append two new fixtures)
- Modify: `test/publish.test.js` (append three new tests + register them)

**Interfaces:**
- Consumes: `CHART_TYPES`, `validatePublishConfig(config)`, `buildChartPayload(chart, rows)` — all exist today in `src/publish.js`, unchanged signatures.
- Produces: `buildChartPayload`'s return objects gain two new optional keys, `linkKey` and `seriesLinkKey` (both `string | undefined`), read by Task 2's client-side code as `chart.linkKey`/`chart.seriesLinkKey` off `window.__PUBLISH_PAYLOAD__.charts[i]`.

- [ ] **Step 1: Write the failing validation test**

Open `test/fixtures/publish-nodes.js` and add these two fixtures at the end of the file (after `chartTypeOmittedPublish`):

```javascript
// seriesLinkKey requires both type: 'bar' AND series to be set - a plain
// bar chart (no series) with seriesLinkKey declared is the representative
// misuse case, same "one representative fixture, not one per possible
// misuse" precedent chartSeriesOnNonBarPublish already set.
var chartSeriesLinkKeyWithoutSeriesPublish = {
  kind: 'publish',
  name: 'chartSeriesLinkKeyWithoutSeriesPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'chart-series-link-key-without-series.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, seriesLinkKey: 'channel' }]
};

// Four charts matching the design spec's §2 worked example: three linked
// on 'category' (plain bar, pie, and a stacked bar also linking its
// series on 'channel'), one ('trend') left deliberately unlinked as the
// "never reacts, never triggers" control. Proves the widened schema
// passes validation (fails only at the un-shimmed BigQuery call, same
// proof pattern as chartsV2Publish) and backs Task 1's payload-passthrough
// test plus Task 2/3's render tests.
var linkKeyChartsPublish = {
  kind: 'publish',
  name: 'linkKeyChartsPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-key-charts.html' },
  charts: [
    { id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, linkKey: 'category' },
    { id: 'share', type: 'pie', title: 'Share', groupBy: 'category', donut: true, metric: { agg: 'sum', field: 'revenue' }, linkKey: 'category' },
    { id: 'by_category_channel', type: 'bar', title: 'By category/channel', groupBy: 'category', series: 'channel', stacking: 'stacked', metric: { agg: 'sum', field: 'revenue' }, linkKey: 'category', seriesLinkKey: 'channel' },
    { id: 'trend', type: 'line', title: 'Trend', groupBy: 'day', metric: { agg: 'sum', field: 'revenue' } }
  ]
};
```

Open `test/publish.test.js` and add these three tests right after `testPublishChartTypeOmittedDefaultsToBar` (before `testPublishAggregationFixtureStillHasNoStacking`):

```javascript
function testPublishChartSeriesLinkKeyWithoutSeriesRejected() {
  var result = runOne('chartSeriesLinkKeyWithoutSeriesPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"seriesLinkKey", which only "bar" charts with "series" support/.test(result.error), 'expected a seriesLinkKey-without-series error, got: ' + result.error);
}

function testPublishLinkKeyChartsProceedPastValidation() {
  var result = runOne('linkKeyChartsPublish');
  // Same proof pattern as testPublishV2ChartTypesProceedPastValidation: no
  // BigQuery shim in this test, so a config that gets all the way past
  // validation fails next at the un-shimmed BigQuery call, not at
  // validation.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation to pass and fail only at the BigQuery call, got: ' + result.error);
}

function testPublishChartPayloadPassesThroughLinkKeys() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'day', 'revenue'], [
    ['A', 'online', '1', '10']
  ]);

  var result = ctx.NotSoBigData.cli('run --select linkKeyChartsPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  var byCategory = payload.charts.filter(function (c) { return c.id === 'by_category'; })[0];
  assert.strictEqual(byCategory.linkKey, 'category', 'expected linkKey passed through, got: ' + JSON.stringify(byCategory));
  assert.strictEqual(byCategory.seriesLinkKey, undefined, 'expected no seriesLinkKey on a non-series chart, got: ' + JSON.stringify(byCategory));

  var byCategoryChannel = payload.charts.filter(function (c) { return c.id === 'by_category_channel'; })[0];
  assert.strictEqual(byCategoryChannel.linkKey, 'category', 'expected linkKey passed through on the series chart, got: ' + JSON.stringify(byCategoryChannel));
  assert.strictEqual(byCategoryChannel.seriesLinkKey, 'channel', 'expected seriesLinkKey passed through, got: ' + JSON.stringify(byCategoryChannel));

  var trend = payload.charts.filter(function (c) { return c.id === 'trend'; })[0];
  assert.strictEqual(trend.linkKey, undefined, 'expected no linkKey on an unlinked chart, got: ' + JSON.stringify(trend));
  assert.ok(!Object.prototype.hasOwnProperty.call(trend, 'linkKey'), 'expected linkKey to be genuinely absent after the JSON round-trip, got: ' + JSON.stringify(trend));
}
```

Then add all three to the `module.exports` object at the bottom of `test/publish.test.js` (after `testPublishChartTypeOmittedDefaultsToBar: testPublishChartTypeOmittedDefaultsToBar`):

```javascript
  testPublishChartSeriesLinkKeyWithoutSeriesRejected: testPublishChartSeriesLinkKeyWithoutSeriesRejected,
  testPublishLinkKeyChartsProceedPastValidation: testPublishLinkKeyChartsProceedPastValidation,
  testPublishChartPayloadPassesThroughLinkKeys: testPublishChartPayloadPassesThroughLinkKeys
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node test/run.js
```

Expected: all three new tests FAIL — `testPublishChartSeriesLinkKeyWithoutSeriesRejected` because `validatePublishConfig` doesn't yet throw on `seriesLinkKey`; the other two because `chart.id` lookups against the fixture succeed but the run either doesn't fail with a BigQuery-shaped error yet in an unexpected way, or `linkKey`/`seriesLinkKey` are simply absent from the payload (assertion `byCategory.linkKey === 'category'` fails since it's `undefined`).

- [ ] **Step 3: Implement `validatePublishConfig`'s new check**

In `src/publish.js`, inside `validatePublishConfig`'s `(config.charts || []).forEach(...)` loop, immediately after the existing `donut` check (currently the last check in that loop, right before the loop's closing `});`):

```javascript
    if (chart.donut !== undefined && chartType !== 'pie') {
      throw new Error('publish(): chart "' + chart.id + '" has "donut", which only "pie" charts support.');
    }
    if (chart.seriesLinkKey && !(chartType === 'bar' && chart.series)) {
      throw new Error('publish(): chart "' + chart.id + '" has "seriesLinkKey", which only "bar" charts with "series" support.');
    }
```

- [ ] **Step 4: Implement `buildChartPayload`'s passthrough**

In `src/publish.js`, `buildChartPayload` has two `return` statements. Change the series-branch return (currently):

```javascript
    return { id: chart.id, title: chart.title, type: chartType, series: chart.series, stacking: chart.stacking || 'grouped', seriesKeys: seriesKeys, data: data };
```

to:

```javascript
    return { id: chart.id, title: chart.title, type: chartType, series: chart.series, stacking: chart.stacking || 'grouped', seriesKeys: seriesKeys, data: data, linkKey: chart.linkKey, seriesLinkKey: chart.seriesLinkKey };
```

And change the plain-branch return (currently):

```javascript
  return { id: chart.id, title: chart.title, type: chartType, donut: !!chart.donut, data: data };
```

to:

```javascript
  return { id: chart.id, title: chart.title, type: chartType, donut: !!chart.donut, data: data, linkKey: chart.linkKey };
```

(No `seriesLinkKey` on the plain-branch return — `seriesLinkKey` is only ever meaningful on a series chart, which always takes the first branch, per Step 3's validation.)

`chart.linkKey`/`chart.seriesLinkKey` are `undefined` when not configured; `JSON.stringify` (already used by `renderReportHtml` to embed the payload) drops `undefined`-valued object keys entirely, so an unlinked chart's payload object genuinely has no `linkKey`/`seriesLinkKey` key once it reaches the browser — no conditional/mutation code needed here.

- [ ] **Step 5: Rebuild and run tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: all tests pass, including the three new ones.

- [ ] **Step 6: Commit**

```bash
git add src/publish.js src.js test/fixtures/publish-nodes.js test/publish.test.js
git commit -m "feat: validate and pass through publish chart linkKey/seriesLinkKey"
```

---

### Task 2: Client-side click-to-highlight in `CHART_CLIENT_JS`

**Files:**
- Modify: `src/publish.js` (`CHART_CLIENT_JS`, lines 485-588 in the pre-Task-1 file — insert a new selection module and wire click handlers into `drawBarChart`, `drawLineChart`, `drawPieChart`, and the `DOMContentLoaded` dispatcher)
- Modify: `test/publish.test.js` (append four new tests + register them)

**Interfaces:**
- Consumes: `chart.linkKey`/`chart.seriesLinkKey` (Task 1's new payload fields), the existing `chart.data`/`chart.seriesKeys`/`chart.stacking` shapes `drawBarChart`/`drawLineChart`/`drawPieChart` already read.
- Produces: no new exported names (everything here is client-side JS embedded in the generated report, not a `src/publish.js` function other tasks call) — Task 4 (docs) references the mechanism by name (`currentSelection`, `applyHighlight`) for its dev-notes section.

- [ ] **Step 1: Write the failing tests**

Add these four tests to `test/publish.test.js`, right after `testPublishChartPayloadPassesThroughLinkKeys` (Task 1's last test):

```javascript
function testPublishChartClientJsIncludesSelectionModule() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'day', 'revenue'], [['A', 'online', '1', '10']]);

  var result = ctx.NotSoBigData.cli('run --select linkKeyChartsPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/function chartSelectionFor/.test(html), 'expected chartSelectionFor in the emitted script, got: ' + html);
  assert.ok(/function selectionsEqual/.test(html), 'expected selectionsEqual in the emitted script, got: ' + html);
  assert.ok(/function selectionMatches/.test(html), 'expected selectionMatches in the emitted script, got: ' + html);
  assert.ok(/function handleChartClick/.test(html), 'expected handleChartClick in the emitted script, got: ' + html);
  assert.ok(/function applyHighlight/.test(html), 'expected applyHighlight in the emitted script, got: ' + html);
  assert.ok(/var currentSelection = null;/.test(html), 'expected the module-level currentSelection state, got: ' + html);
}

function testPublishChartClientJsCallsApplyHighlightOnceOnLoad() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'day', 'revenue'], [['A', 'online', '1', '10']]);

  var result = ctx.NotSoBigData.cli('run --select linkKeyChartsPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  // Two call sites total: applyHighlight()'s own definition never calls
  // itself, so this counts (a) the DOMContentLoaded dispatcher's one call
  // after drawing every chart and (b) handleChartClick's one call after
  // updating currentSelection.
  var callCount = (html.match(/applyHighlight\(\);/g) || []).length;
  assert.strictEqual(callCount, 2, 'expected exactly 2 applyHighlight() call sites (DOMContentLoaded + handleChartClick), got ' + callCount + ' in: ' + html);
}

function testPublishChartClientJsWiresBarClickOnlyWhenInteractive() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'day', 'revenue'], [['A', 'online', '1', '10']]);

  var result = ctx.NotSoBigData.cli('run --select linkKeyChartsPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/var interactive = !!\(chart\.linkKey \|\| chart\.seriesLinkKey\);/.test(html), 'expected drawBarChart\'s interactive flag, got: ' + html);
  assert.ok(/data-group-value/.test(html), 'expected data-group-value attribute wiring in the emitted script, got: ' + html);
  assert.ok(/data-series-value/.test(html), 'expected data-series-value attribute wiring for stacked/grouped bars, got: ' + html);
}

function testPublishChartClientJsWiresLineAndPieClickOnLinkKey() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'day', 'revenue'], [['A', 'online', '1', '10']]);

  var result = ctx.NotSoBigData.cli('run --select linkKeyChartsPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  // drawLineChart and drawPieChart each gate their click wiring on a bare
  // "if (chart.linkKey)" (they have no seriesLinkKey concept at all) -
  // two occurrences expected, one per function.
  var lineOrPieGateCount = (html.match(/if \(chart\.linkKey\) \{/g) || []).length;
  assert.strictEqual(lineOrPieGateCount, 2, 'expected exactly 2 "if (chart.linkKey)" gates (drawLineChart + drawPieChart), got ' + lineOrPieGateCount + ' in: ' + html);
}
```

These four functions go right before the file's existing `module.exports = {` block — do not add a second `module.exports` block. Add the four new test names as new entries inside that existing block, after `testPublishChartPayloadPassesThroughLinkKeys: testPublishChartPayloadPassesThroughLinkKeys` (added in Task 1):

```javascript
  testPublishChartClientJsIncludesSelectionModule: testPublishChartClientJsIncludesSelectionModule,
  testPublishChartClientJsCallsApplyHighlightOnceOnLoad: testPublishChartClientJsCallsApplyHighlightOnceOnLoad,
  testPublishChartClientJsWiresBarClickOnlyWhenInteractive: testPublishChartClientJsWiresBarClickOnlyWhenInteractive,
  testPublishChartClientJsWiresLineAndPieClickOnLinkKey: testPublishChartClientJsWiresLineAndPieClickOnLinkKey
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node test/run.js
```

Expected: all four new tests FAIL (none of the new function names, `data-group-value`/`data-series-value` attributes, or `if (chart.linkKey) {` gates exist yet).

- [ ] **Step 3: Implement the shared selection module**

In `src/publish.js`, inside the `CHART_CLIENT_JS` array, insert the following new lines immediately after the line `'  container.appendChild(list);',` and its closing `'}',` (the end of `renderChartFallback`), and before the line `'function drawBarChart(containerId, chart) {',`:

```javascript
  'var currentSelection = null;',
  'function chartSelectionFor(chart, groupValue, seriesValue) {',
  '  var selection = {};',
  '  if (chart.linkKey) { selection[chart.linkKey] = groupValue; }',
  '  if (chart.seriesLinkKey && seriesValue !== undefined) { selection[chart.seriesLinkKey] = seriesValue; }',
  '  return selection;',
  '}',
  'function selectionsEqual(a, b) {',
  '  var aKeys = Object.keys(a);',
  '  var bKeys = Object.keys(b);',
  '  if (aKeys.length !== bKeys.length) { return false; }',
  '  return aKeys.every(function (key) { return Object.prototype.hasOwnProperty.call(b, key) && b[key] === a[key]; });',
  '}',
  'function selectionMatches(chart, groupValue, seriesValue) {',
  '  if (!currentSelection) { return true; }',
  '  var ownKeys = [];',
  '  if (chart.linkKey) { ownKeys.push(chart.linkKey); }',
  '  if (chart.seriesLinkKey) { ownKeys.push(chart.seriesLinkKey); }',
  '  var relevant = ownKeys.filter(function (key) { return Object.prototype.hasOwnProperty.call(currentSelection, key); });',
  '  if (!relevant.length) { return true; }',
  '  var elementSelection = chartSelectionFor(chart, groupValue, seriesValue);',
  '  return relevant.every(function (key) { return elementSelection[key] === currentSelection[key]; });',
  '}',
  'function handleChartClick(chart, groupValue, seriesValue) {',
  '  var clicked = chartSelectionFor(chart, groupValue, seriesValue);',
  '  currentSelection = (currentSelection && selectionsEqual(currentSelection, clicked)) ? null : clicked;',
  '  applyHighlight();',
  '}',
  'function applyHighlight() {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  Array.prototype.forEach.call(document.querySelectorAll(".chart-canvas"), function (container) {',
  '    var chartId = container.id.replace(/^chart-/, "");',
  '    var chart = payload.charts.filter(function (c) { return c.id === chartId; })[0];',
  '    if (!chart || !(chart.linkKey || chart.seriesLinkKey)) { return; }',
  '    Array.prototype.forEach.call(container.querySelectorAll("[data-group-value]"), function (node) {',
  '      var groupValue = node.getAttribute("data-group-value");',
  '      var seriesValue = node.getAttribute("data-series-value");',
  '      var isMatch = selectionMatches(chart, groupValue, seriesValue === null ? undefined : seriesValue);',
  '      node.style.opacity = isMatch ? 1 : 0.25;',
  '    });',
  '  });',
  '}',
```

- [ ] **Step 4: Wire click handlers into `drawBarChart`**

Replace the entire existing `drawBarChart` function inside `CHART_CLIENT_JS` (from `'function drawBarChart(containerId, chart) {',` through its closing `'}',` right before `'function drawLineChart(containerId, chart) {',`) with:

```javascript
  'function drawBarChart(containerId, chart) {',
  '  var width = 480, height = Math.max(240, chart.data.length * 36), margin = { top: 10, right: 40, bottom: 10, left: 160 };',
  '  var svg = d3.select(document.getElementById(containerId)).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title);',
  '  var groupValues = chart.data.map(function (d) { return d.groupValue; });',
  '  var y = d3.scaleBand().domain(groupValues).range([margin.top, height - margin.bottom]).padding(0.2);',
  '  var color = d3.scaleOrdinal().range(["var(--teal)", "var(--coral)", "var(--ink-soft)", "var(--teal-soft)"]);',
  '  var interactive = !!(chart.linkKey || chart.seriesLinkKey);',
  '  if (chart.seriesKeys && chart.seriesKeys.length) {',
  '    color.domain(chart.seriesKeys);',
  '    if (chart.stacking === "stacked") {',
  '      var stackRows = chart.data.map(function (d) { var row = { groupValue: d.groupValue }; chart.seriesKeys.forEach(function (k) { row[k] = d.values[k]; }); return row; });',
  '      var stacked = d3.stack().keys(chart.seriesKeys)(stackRows);',
  '      var maxTotal = d3.max(stackRows, function (row) { return chart.seriesKeys.reduce(function (sum, k) { return sum + row[k]; }, 0); }) || 1;',
  '      var x = d3.scaleLinear().domain([0, maxTotal]).range([margin.left, width - margin.right]);',
  '      var segments = svg.append("g").selectAll("g").data(stacked).join("g")',
  '        .attr("class", "chart-bar").style("fill", function (d) { return color(d.key); })',
  '        .selectAll("rect").data(function (d) { return d; }).join("rect")',
  '        .attr("y", function (d) { return y(d.data.groupValue); }).attr("x", function (d) { return x(d[0]); })',
  '        .attr("width", function (d) { return x(d[1]) - x(d[0]); }).attr("height", y.bandwidth());',
  '      if (interactive) {',
  '        segments.attr("data-group-value", function (d) { return d.data.groupValue; }).style("cursor", "pointer");',
  '        if (chart.seriesLinkKey) {',
  '          segments.attr("data-series-value", function (d) { return d3.select(this.parentNode).datum().key; });',
  '        }',
  '        segments.on("click", function (event, d) {',
  '          var seriesKey = d3.select(this.parentNode).datum().key;',
  '          handleChartClick(chart, d.data.groupValue, chart.seriesLinkKey ? seriesKey : undefined);',
  '        });',
  '      }',
  '    } else {',
  '      var maxValue = d3.max(chart.data, function (d) { return d3.max(chart.seriesKeys, function (k) { return d.values[k]; }); }) || 1;',
  '      var x = d3.scaleLinear().domain([0, maxValue]).range([margin.left, width - margin.right]);',
  '      var y1 = d3.scaleBand().domain(chart.seriesKeys).range([0, y.bandwidth()]).padding(0.05);',
  '      var segments = svg.append("g").selectAll("g").data(chart.data).join("g")',
  '        .attr("transform", function (d) { return "translate(0," + y(d.groupValue) + ")"; })',
  '        .selectAll("rect").data(function (d) { return chart.seriesKeys.map(function (k) { return { key: k, value: d.values[k] }; }); }).join("rect")',
  '        .attr("class", "chart-bar").style("fill", function (d) { return color(d.key); })',
  '        .attr("y", function (d) { return y1(d.key); }).attr("x", margin.left)',
  '        .attr("width", function (d) { return x(d.value) - margin.left; }).attr("height", y1.bandwidth());',
  '      if (interactive) {',
  '        segments.attr("data-group-value", function (d) { return d3.select(this.parentNode).datum().groupValue; }).style("cursor", "pointer");',
  '        if (chart.seriesLinkKey) {',
  '          segments.attr("data-series-value", function (d) { return d.key; });',
  '        }',
  '        segments.on("click", function (event, d) {',
  '          var groupValue = d3.select(this.parentNode).datum().groupValue;',
  '          handleChartClick(chart, groupValue, chart.seriesLinkKey ? d.key : undefined);',
  '        });',
  '      }',
  '    }',
  '  } else {',
  '    var maxTotal = d3.max(chart.data, function (d) { return d.total; }) || 1;',
  '    var x = d3.scaleLinear().domain([0, maxTotal]).range([margin.left, width - margin.right]);',
  '    var bars = svg.append("g").selectAll("rect").data(chart.data).join("rect")',
  '      .attr("class", "chart-bar").attr("y", function (d) { return y(d.groupValue); }).attr("x", margin.left)',
  '      .attr("width", function (d) { return Math.max(0, x(d.total) - margin.left); }).attr("height", y.bandwidth());',
  '    if (interactive) {',
  '      bars.attr("data-group-value", function (d) { return d.groupValue; }).style("cursor", "pointer")',
  '        .on("click", function (event, d) { handleChartClick(chart, d.groupValue, undefined); });',
  '    }',
  '    svg.append("g").selectAll("text").data(chart.data).join("text")',
  '      .attr("class", "chart-value").attr("x", function (d) { return x(d.total) + 6; })',
  '      .attr("y", function (d) { return y(d.groupValue) + y.bandwidth() / 2 + 4; }).text(function (d) { return d.total.toLocaleString("en-US"); });',
  '  }',
  '  svg.append("g").selectAll("text.chart-label").data(groupValues).join("text")',
  '    .attr("class", "chart-label").attr("x", 0).attr("y", function (d) { return y(d) + y.bandwidth() / 2 + 4; }).text(function (d) { return d; });',
  '}',
```

- [ ] **Step 5: Wire click handlers into `drawLineChart`**

Replace the entire existing `drawLineChart` function with:

```javascript
  'function drawLineChart(containerId, chart) {',
  '  var width = 480, height = 240, margin = { top: 10, right: 20, bottom: 30, left: 50 };',
  '  var svg = d3.select(document.getElementById(containerId)).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title);',
  '  var x = d3.scalePoint().domain(chart.data.map(function (d) { return d.groupValue; })).range([margin.left, width - margin.right]);',
  '  var maxTotal = d3.max(chart.data, function (d) { return d.total; }) || 1;',
  '  var y = d3.scaleLinear().domain([0, maxTotal]).range([height - margin.bottom, margin.top]);',
  '  var line = d3.line().x(function (d) { return x(d.groupValue); }).y(function (d) { return y(d.total); });',
  '  svg.append("path").datum(chart.data).attr("class", "chart-bar").style("fill", "none").attr("stroke", "#3F6659").attr("stroke-width", 2).attr("d", line);',
  '  var points = svg.append("g").selectAll("circle").data(chart.data).join("circle")',
  '    .attr("class", "chart-bar").attr("cx", function (d) { return x(d.groupValue); }).attr("cy", function (d) { return y(d.total); }).attr("r", 3);',
  '  if (chart.linkKey) {',
  '    points.attr("data-group-value", function (d) { return d.groupValue; }).style("cursor", "pointer")',
  '      .on("click", function (event, d) { handleChartClick(chart, d.groupValue, undefined); });',
  '  }',
  '  svg.append("g").selectAll("text").data(chart.data).join("text")',
  '    .attr("class", "chart-label").attr("x", function (d) { return x(d.groupValue); }).attr("y", height - 8).attr("text-anchor", "middle").text(function (d) { return d.groupValue; });',
  '}',
```

- [ ] **Step 6: Wire click handlers into `drawPieChart`**

Replace the entire existing `drawPieChart` function with:

```javascript
  'function drawPieChart(containerId, chart) {',
  '  var width = 320, height = 320, radius = Math.min(width, height) / 2 - 20;',
  '  var svg = d3.select(document.getElementById(containerId)).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title)',
  '    .append("g").attr("transform", "translate(" + width / 2 + "," + height / 2 + ")");',
  '  var color = d3.scaleOrdinal().range(["var(--teal)", "var(--coral)", "var(--ink-soft)", "var(--teal-soft)"]);',
  '  var pieGen = d3.pie().value(function (d) { return d.total; });',
  '  var arcGen = d3.arc().innerRadius(chart.donut ? radius * 0.55 : 0).outerRadius(radius);',
  '  var pieData = pieGen(chart.data);',
  '  var slices = svg.selectAll("path").data(pieData).join("path")',
  '    .attr("class", "chart-bar").style("fill", function (d) { return color(d.data.groupValue); }).attr("d", arcGen);',
  '  if (chart.linkKey) {',
  '    slices.attr("data-group-value", function (d) { return d.data.groupValue; }).style("cursor", "pointer")',
  '      .on("click", function (event, d) { handleChartClick(chart, d.data.groupValue, undefined); });',
  '  }',
  '  svg.selectAll("text").data(pieData).join("text")',
  '    .attr("class", "chart-label").attr("transform", function (d) { return "translate(" + arcGen.centroid(d) + ")"; })',
  '    .attr("text-anchor", "middle").text(function (d) { return d.data.groupValue; });',
  '}',
```

- [ ] **Step 7: Call `applyHighlight()` once after the initial draw pass**

The `DOMContentLoaded` dispatcher at the end of `CHART_CLIENT_JS` is currently:

```javascript
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
```

Change the final two lines to add one call to `applyHighlight()` after the loop, before the closing of the `DOMContentLoaded` handler:

```javascript
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
  '  applyHighlight();',
  '});'
```

- [ ] **Step 8: Rebuild and run tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: all tests pass, including the four new ones from Step 1. Every pre-existing `CHART_CLIENT_JS` test (`testPublishChartClientJsDispatchesByType`, `testPublishChartClientJsUsesStyleForColorScaledFills`, etc.) must still pass unchanged — this task only adds new lines/wiring, it never removes or renames anything those tests already check for (the `.style("fill", ...)` call sites, the `typeof d3 === "undefined"` guard, and the three `drawXxxChart` function names are all untouched).

- [ ] **Step 9: Commit**

```bash
git add src/publish.js src.js test/publish.test.js
git commit -m "feat: add client-side click-to-highlight across linked publish charts"
```

---

### Task 3: Documentation

**Files:**
- Modify: `docs/publish.md` (`### charts[]` section, "What's not here yet" section)
- Modify: `src/publish.md` (append a dev-notes section)

**Interfaces:** none — this task changes only prose, no code.

- [ ] **Step 1: Update `docs/publish.md`'s `charts[]` section**

Open `docs/publish.md`. Immediately after the existing `#### Charts require internet to view` subsection (right before the `### tables[]` heading), insert a new subsection:

```markdown
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
  clicked value. Clicking the same element again clears the selection.
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
```

Then find the `## What's not here yet` section near the end of the file and replace the sentence:

```markdown
Cross-chart interactivity (one chart reacting to another's click/selection within the same file) is planned as a
follow-up to the D3 chart engine — see
`docs/superpowers/specs/2026-09-06-publish-d3-charts-design.md`.
Column-header sort and search for the `tables[]` block, and `filters`/
`linkTo` generally, are deliberately deferred until that follow-up is
designed, since they overlap with it — see that spec's "Relationship
to filters/linkTo" section.
```

with:

```markdown
Cross-chart click-to-highlight is implemented (`linkKey`/`seriesLinkKey`,
see `charts[]` above) — see
`docs/superpowers/specs/2026-09-06-publish-chart-interactivity-design.md`
for the full design. A `filters[]` dropdown that recomputes KPIs/charts/
tables against the underlying rows, and `linkTo` cross-file navigation,
remain future work, each still needing its own brainstorming pass — see
that spec's "Future direction" section. Column-header sort and search for
the `tables[]` block are also still deferred.
```

- [ ] **Step 2: Add dev-notes to `src/publish.md`**

Open `src/publish.md` and append this new section at the end of the file, after the existing "Set a per-item chart color with `.style('fill', ...)`" note:

```markdown
## Cross-chart highlighting is one shared client-side module, not per-chart state

`CHART_CLIENT_JS` gained a small selection module for Phase 2
(`docs/superpowers/specs/2026-09-06-publish-chart-interactivity-design.md`):
one module-level `currentSelection` (`null`, or a plain object mapping a
`linkKey`/`seriesLinkKey` name to the selected value), `handleChartClick()`
to update it on a click, and `applyHighlight()` to re-derive every
interactive element's opacity from it. `applyHighlight()` is generic across
all three chart shapes on purpose: rather than re-deriving each drawn
element's own `(groupValue, seriesValue)` from D3's per-shape datum layout
a second time, every interactive element gets `data-group-value`/
`data-series-value` DOM attributes at draw time, and `applyHighlight()`
reads those back uniformly. Click handlers themselves *do* read the D3
datum directly (cheaper, and the shape is known at the call site) — the
DOM attributes exist specifically so the later, shape-agnostic highlight
pass doesn't need to know a stacked bar's parent-datum trick versus a
plain bar's flat datum.

Matching is deliberately "only the keys the reacting chart itself
declares, intersected with the current selection's keys" — never
`Object.keys(currentSelection).length === Object.keys(ownKeys).length`
strict equality. A chart declaring only `linkKey` must still react to a
selection that also carries a `seriesLinkKey` entry from a different
chart's stacked-segment click, by matching on the one dimension it
understands and ignoring the rest. Getting this backwards (requiring an
exact key-set match) is the most likely way a future change to this
module quietly breaks cross-chart highlighting between charts of
different shapes — see `selectionMatches` for the actual implementation.

No new `.attr("fill", ...)`-vs-`.style("fill", ...)` traps were introduced
here — none of this task's new code sets `fill`.
```

- [ ] **Step 3: Verify the docs build/check step still passes**

```bash
./build.sh --check
node test/run.js
```

Expected: both pass unchanged (this task touches no `src/*.js` file, only `.md` docs).

- [ ] **Step 4: Commit**

```bash
git add docs/publish.md src/publish.md
git commit -m "docs: document publish's cross-chart click-to-highlight (linkKey/seriesLinkKey)"
```

---

### Task 4: `notsobigtests` Layer 2 fixture

**Files (in the sibling repo `/home/moschi/projetos/notsobig_org/notsobigtests`):**
- Modify: `js/08-fixtures-publish-targets.js` (append one new fixture)
- Modify: `js/28-tests-publish.js` (append one new test + register it)
- Modify: `js/90-test-registry.js` (register the new test in the `publish` category; set `SRC_REF` to `feat/publish-chart-interactivity`)

**Interfaces:**
- Consumes: `loadPublishOrders` (existing fixture, already seeds the shared 6-row sample — see `js/08-fixtures-publish-targets.js`'s own comment), `extractPublishPayload(html)` (existing helper in `js/28-tests-publish.js`).
- Produces: a `testLog`-documented manual verification step for the human running this branch's Layer 2 tests.

- [ ] **Step 1: Add the fixture**

Open `js/08-fixtures-publish-targets.js` in the `notsobigtests` repo and add this new fixture at the end of the file, after `chartTypesPublish`:

```javascript
// Cross-chart interactivity (notsobiglib feat/publish-chart-interactivity):
// three charts linked on 'category' (plain bar, pie, and a stacked bar
// also linking its series on 'order_id'), one ('by_order', a plain line
// chart) left deliberately unlinked - the same shape as the design spec's
// worked example, reusing loadPublishOrders' already-proven 6-row sample
// rather than a fresh scratch table.
var chartInteractivityPublish = {
  kind: 'publish',
  name: 'chartInteractivityPublish',
  dependsOn: ['loadPublishOrders'],
  source: { type: 'ref', ref: 'loadPublishOrders' },
  target: { type: 'drive', folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'publish-chart-interactivity.html', upsertByName: true },
  charts: [
    { id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, linkKey: 'category' },
    { id: 'share', type: 'pie', title: 'Share by category', donut: true, groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, linkKey: 'category' },
    { id: 'by_category_order', type: 'bar', title: 'By category and order', groupBy: 'category', series: 'order_id', stacking: 'stacked', metric: { agg: 'sum', field: 'revenue' }, linkKey: 'category', seriesLinkKey: 'order_id' },
    { id: 'by_order', type: 'line', title: 'Revenue by order', groupBy: 'order_id', metric: { agg: 'sum', field: 'revenue' } }
  ]
};
```

- [ ] **Step 2: Add the test**

Open `js/28-tests-publish.js` and add this new test after `testPublishChartTypesRenderMountPointsAndPayload`:

```javascript
// Cross-chart click-to-highlight (notsobiglib feat/publish-chart-interactivity):
// a GAS test can't click anything or read computed opacity, so this only
// proves the pipeline reaches Drive with linkKey/seriesLinkKey correctly
// present/absent in the payload - same ceiling notsobiglib's own Layer 1
// tests already accept. The actual click/highlight behavior is left to a
// human via testLog below.
function testPublishChartInteractivityLinksPropagateToPayload() {
  var result = runOne('chartInteractivityPublish');
  var html = DriveApp.getFileById(result.driveFileId).getBlob().getDataAsString();
  var payload = extractPublishPayload(html);

  var byCategory = payload.charts.filter(function (c) { return c.id === 'by_category'; })[0];
  check('by_category has linkKey "category"', byCategory.linkKey === 'category', JSON.stringify(byCategory));

  var byCategoryOrder = payload.charts.filter(function (c) { return c.id === 'by_category_order'; })[0];
  check('by_category_order has both linkKey and seriesLinkKey', byCategoryOrder.linkKey === 'category' && byCategoryOrder.seriesLinkKey === 'order_id', JSON.stringify(byCategoryOrder));

  var byOrder = payload.charts.filter(function (c) { return c.id === 'by_order'; })[0];
  check('by_order (unlinked) has no linkKey', byOrder.linkKey === undefined, JSON.stringify(byOrder));

  testLog('Chart-interactivity report file id: ' + result.driveFileId + ' - open it in a browser and: '
    + '(1) click a bar/slice on "By category" or "Share by category" and confirm the other category-linked '
    + 'charts dim to the matching category while "Revenue by order" (unlinked) is unaffected; '
    + '(2) click a segment on "By category and order" and confirm only the exact (category, order) pair '
    + 'lights up elsewhere, not the whole category; '
    + '(3) click the same element again and confirm everything returns to full opacity.');
}
```

- [ ] **Step 3: Register the test and point `SRC_REF` at the feature branch**

Open `js/90-test-registry.js`. Add `'testPublishChartInteractivityLinksPropagateToPayload'` to the `publish` category's test array (alongside the existing `testPublishChartTypesRenderMountPointsAndPayload` entry). Then set:

```javascript
SRC_REF: 'feat/publish-chart-interactivity'
```

(replacing whatever branch name is currently set there — this is the per-run human step `notsobiglib`'s `CLAUDE.md` documents under "Pointing `notsobigtests` at the branch under test is a Script Property, not a code edit"; setting it in this file only affects the *default* baked into `setupScriptProperties()`, the actual Script Property in the Apps Script editor still needs setting by hand before running).

- [ ] **Step 4: Deploy and report readiness**

```bash
cd /home/moschi/projetos/notsobig_org/notsobigtests
clasp push -f
```

Report to the user that the fixture is deployed and ready for a human to run `runAllTests('publish')` (or `runAllTests('testPublishChartInteractivityLinksPropagateToPayload')` directly) in the Apps Script editor, with `SRC_REF` set to `feat/publish-chart-interactivity` in that project's Script Properties.

- [ ] **Step 5: Commit**

```bash
git add js/08-fixtures-publish-targets.js js/28-tests-publish.js js/90-test-registry.js
git commit -m "test: add cross-chart interactivity fixture for publish's linkKey/seriesLinkKey"
```

---

## After Task 4

This plan's code and docs are complete. Do **not** open PRs, push branches, or merge anything as part of executing this plan — per `notsobiglib`'s `CLAUDE.md` workflow (step 4, "Open the PR — stop before merge"), a human confirms the Apps Script Layer 2 test results before any PR is opened, exactly like Phase 1. Report the final state (branch name, commits, test status in both repos) and wait for the user's next instruction.
