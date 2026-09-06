// test/publish.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function runOne(name) {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  return ctx.NotSoBigData.cli('run --select ' + name).nodes[0];
}

function testPublishNodeDiscoverableByKind() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var report = ctx.NotSoBigData.cli('list --select publish');
  var names = report.nodes.map(function (node) { return node.name; });
  assert.ok(names.indexOf('validPublish') !== -1, 'expected validPublish to be discoverable by kind "publish", got: ' + names.join(', '));
}

function testPublishSourceRefMustBeInDependsOn() {
  var result = runOne('missingDependsOnPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/missing from dependsOn/.test(result.error), 'expected a dependsOn error, got: ' + result.error);
}

function testPublishKpiRequiresFieldUnlessCount() {
  var result = runOne('badKpiPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/requires "field"/.test(result.error), 'expected a kpi field error, got: ' + result.error);
}

function testPublishRefMustResolveToBigQueryLocation() {
  var result = runOne('nonBigQueryRefPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/does not match a declared model or a move node with a bigquery target/.test(result.error), 'expected a ref-resolution error, got: ' + result.error);
}

function testPublishValidRefProceedsPastValidation() {
  var result = runOne('validPublish');
  // BigQuery isn't shimmed in test/harness.js (see its own comment) - a
  // valid publish node is expected to get all the way past config
  // validation and ref resolution, then fail on the live BigQuery call
  // this Node test never provides. Failing here with a BigQuery-shaped
  // error, not a config/ref error, is exactly what proves validation and
  // resolution both succeeded.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation+ref-resolution to pass and fail only at the BigQuery call, got: ' + result.error);
}

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

function testPublishLayoutTypeOtherThanLinearRejected() {
  var result = runOne('badLayoutPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/only "linear" is supported/.test(result.error), 'expected a layout-type error, got: ' + result.error);
}

// Shims BigQuery.Tables.get/Tabledata.list and DriveApp.getFolderById
// directly on the harness's vm sandbox (harness.loadContext returns the
// actual global object for that vm context, so adding properties to it
// before calling cli() is exactly like declaring them as globals in Apps
// Script - no harness.js changes needed) so a real cli('run --select
// ...') can be driven all the way through fetchTableRows ->
// buildReportPayload -> renderReportHtml -> writeDriveText without
// touching live BigQuery/Drive. fieldNames/rowValues describe the table
// Tabledata.list should appear to return (one array of cell values per
// row, in fieldNames order); the returned function reads back whatever
// HTML DriveApp.createFile most recently received.
function shimBigQueryAndDrive(ctx, fieldNames, rowValues) {
  var capturedHtml = null;
  ctx.MimeType = { HTML: 'text/html' };
  ctx.BigQuery = {
    Tables: {
      get: function () {
        return { schema: { fields: fieldNames.map(function (name) { return { name: name }; }) } };
      }
    },
    Tabledata: {
      list: function () {
        return {
          rows: rowValues.map(function (values) {
            return { f: values.map(function (value) { return { v: value }; }) };
          })
        };
      }
    }
  };
  ctx.DriveApp = {
    getFolderById: function () {
      return {
        createFile: function (name, content) {
          capturedHtml = content;
          return { getId: function () { return 'fake-file-id'; } };
        }
      };
    }
  };
  return function () { return capturedHtml; };
}

// Regression test for a stored-XSS finding: renderReportHtml embeds
// JSON.stringify(payload) straight into a <script> tag, and
// JSON.stringify doesn't escape "<" - a chart groupValue containing the
// literal substring "</script>" (live BigQuery data, never sanitized for
// HTML-safety) could close the script element early and let the rest of
// the payload be parsed as markup. This exercises fetchTableRows ->
// buildReportPayload -> renderReportHtml exactly as a real run would.
function testPublishEscapesScriptCloseInEmbeddedPayload() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [
    ['</script><script>alert(1)</script>', '10']
  ]);

  var result = ctx.NotSoBigData.cli('run --select xssPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(html, 'expected renderReportHtml\'s output to reach DriveApp.createFile');

  // xssPublish has a chart, so Task 3 now also emits a second, legitimate
  // <script src="..."> (the D3 CDN tag) alongside the inline payload
  // script - two real closing tags is the correct baseline here, not a
  // regression; the XSS-relevant assertion is that it's not more than that.
  var scriptCloseCount = html.split('</script').length - 1;
  assert.strictEqual(scriptCloseCount, 2, 'expected exactly two </script closing tags (the D3 CDN tag + the template\'s own inline script), found ' + scriptCloseCount + ' in: ' + html);
}

// Spec-mandated Layer-1 coverage for buildReportPayload's actual math
// (sum/avg/count/count_distinct, groupBy aggregation, format application)
// and renderReportHtml's markup (the computed values show up, correctly
// formatted, in the written HTML) - see docs/superpowers/specs/
// 2026-09-05-publish-kind-design.md's §7. Three rows: two share
// order_id 'o1' (to make count_distinct differ from count), split across
// two categories (to make the chart's groupBy produce two groups with
// different totals).
function testPublishAggregatesKpisAndChartsCorrectly() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [
    ['A', '10', 'o1'],
    ['A', '20', 'o1'],
    ['B', '5', 'o2']
  ]);

  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  // sum(revenue) = 10 + 20 + 5 = 35, format: currency
  assert.ok(html.indexOf('$35.00') !== -1, 'expected the currency-formatted sum in: ' + html);
  // count() = 3 rows, format: integer
  assert.ok(html.indexOf('>3<') !== -1, 'expected the row count in: ' + html);
  // count_distinct(order_id) = 2 ('o1', 'o2'), format: integer
  assert.ok(html.indexOf('>2<') !== -1, 'expected the distinct-order count in: ' + html);
  // avg(revenue) = 35 / 3 = 11.666... , format: decimal (2dp)
  assert.ok(html.indexOf('11.67') !== -1, 'expected the decimal-formatted average in: ' + html);
  // groupBy category, sum(revenue): A = 30, B = 5 - charts render
  // client-side now (Task 3), so the totals only exist in the embedded
  // payload, not as literal SVG text.
  var chartPayload = extractPayload(html).charts.filter(function (c) { return c.id === 'by_category'; })[0];
  var totalsByGroup = {};
  chartPayload.data.forEach(function (d) { totalsByGroup[d.groupValue] = d.total; });
  assert.strictEqual(totalsByGroup.A, 30, 'expected category A total 30 in the chart payload, got: ' + JSON.stringify(chartPayload.data));
  assert.strictEqual(totalsByGroup.B, 5, 'expected category B total 5 in the chart payload, got: ' + JSON.stringify(chartPayload.data));
}

// Companion to finding #1 in the whole-branch review: connectorTuplesForNode
// special-cased 'model' but fell through to treating a publish node's
// config.source.type ('ref') as a connector, which isn't in DEBUG_PROBES -
// so cli('debug') hard-errored on any project with a publish node. A
// publish node should only ever probe its drive target - source.ref names
// another node, not a connector, so there's nothing to probe there.
// probeDrive's own DriveApp.getFolderById call needs shimming here since
// there's no live Drive in Node (see shimBigQueryAndDrive's own comment
// on why adding globals straight to the harness sandbox works).
function testPublishDebugOnlyProbesDriveTarget() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  ctx.DriveApp = {
    getFolderById: function (folderId) { return { id: folderId }; }
  };

  var report = ctx.NotSoBigData.cli('debug --select validPublish');
  assert.strictEqual(report.checks.length, 1, 'expected exactly one debug check for a publish node, got: ' + JSON.stringify(report.checks));
  assert.strictEqual(report.checks[0].type, 'drive', 'expected the one check to probe the drive target, got: ' + JSON.stringify(report.checks[0]));
  assert.strictEqual(report.checks[0].status, 'ok', 'expected the shimmed drive probe to succeed, got: ' + JSON.stringify(report.checks[0]));
  assert.strictEqual(report.ok, true, 'expected cli(\'debug\') to report a correctly-configured publish node as ok, got: ' + JSON.stringify(report));
}

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

// Whole-branch review finding #1: two tables[] entries sharing an id
// render fine on the static first page (each section keeps its own
// server-rendered rows) but silently swap datasets the moment the
// client-side pager's `payload.tables.filter(t => t.id === tableId)[0]`
// resolves the wrong (first-match) table on "Next"/"Previous". Both
// entries here are otherwise individually valid 'raw' tables, so this
// also proves the duplicate-id check fires before any other per-table
// check could mask it.
function testPublishDuplicateTableIdRejected() {
  var result = runOne('duplicateTableIdPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/duplicate table id "dup"/.test(result.error), 'expected a duplicate-table-id error, got: ' + result.error);
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

// Regression test for a rendering defect found in review: SVG/CSS gives a
// stylesheet's `fill` property priority over a presentation attribute set
// via .attr("fill", ...) - REPORT_CSS's ".chart-bar { fill: var(--teal); }"
// would silently override any per-item fill set with .attr("fill", ...),
// so pie slices, stacked/grouped bar segments, and the line chart's path
// would all render filled instead of respecting the intended fill. Three
// of the four call sites below are color-scaled (pie slices, stacked bar
// segments, grouped bar segments - each picks a per-item color via
// color(...)); the fourth (the line chart's path) isn't color-scaled at
// all, it just needs fill suppressed to "none" so the stroke alone
// renders - same underlying CSS-vs-attr priority bug, caught a second
// time later in the same review pass. .style("fill", ...) sets an inline
// style, which does win over the stylesheet, for both cases. This can't
// be rendered/checked in a browser here, so it's a plain string-presence
// check on the emitted script, same ceiling CHART_CLIENT_JS's other
// regex-based tests accept. The plain (non-series) bar path is
// untouched - it never sets a per-item fill and keeps relying on
// .chart-bar's CSS fill.
function testPublishChartClientJsUsesStyleForColorScaledFills() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'day', 'channel', 'revenue'], [['A', '1', 'online', '10']]);

  var result = ctx.NotSoBigData.cli('run --select chartsV2Publish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  var styleFillCount = (html.match(/\.style\("fill"/g) || []).length;
  assert.strictEqual(styleFillCount, 4, 'expected .style("fill" on all 4 call sites (pie slices, stacked bars, grouped bars, and the line chart\'s fill:none path), got ' + styleFillCount + ' in: ' + html);
  assert.ok(!/\.attr\("fill", function \(d\) \{ return color\(/.test(html), 'expected no remaining .attr("fill", ...color(...)) calls (should be .style now), got: ' + html);
  assert.ok(!/\.attr\("fill", "none"\)/.test(html), 'expected no remaining .attr("fill", "none") call on the line chart path (should be .style now), got: ' + html);
}

// Whole-branch review finding #3: the D3 CDN script tag had no
// Subresource Integrity - a pinned version number pins a path, not the
// bytes served at it, and this library gets eval()'d with live OAuth
// access into a page that also embeds the user's full BigQuery result
// set. SRI pins the exact bytes the browser will accept.
function testPublishD3ScriptHasSubresourceIntegrity() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);

  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  var scriptTagMatch = html.match(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/d3\/[^"]+"[^>]*><\/script>/);
  assert.ok(scriptTagMatch, 'expected a D3 CDN <script> tag in: ' + html);
  var scriptTag = scriptTagMatch[0];
  assert.ok(scriptTag.indexOf('integrity="sha512-') !== -1, 'expected an integrity="sha512-..." attribute on the D3 script tag, got: ' + scriptTag);
  assert.ok(scriptTag.indexOf('crossorigin="anonymous"') !== -1, 'expected a crossorigin="anonymous" attribute on the D3 script tag, got: ' + scriptTag);
}

// Whole-branch review finding #4: tables[] already rejects a duplicate
// id before any other per-table check could mask it (see
// testPublishDuplicateTableIdRejected above); charts[] had no equivalent
// guard, even though CHART_CLIENT_JS's DOMContentLoaded handler resolves
// a chart the exact same way tables do
// (`payload.charts.filter(c => c.id === chartId)[0]`), so a duplicate
// chart id would silently mis-bind a mount point rather than throwing at
// config time.
function testPublishDuplicateChartIdRejected() {
  var result = runOne('duplicateChartIdPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/duplicate chart id "dup"/.test(result.error), 'expected a duplicate-chart-id error, got: ' + result.error);
}

// Whole-branch review finding #13: `var chartType = chart.type || 'bar';`
// (the default-to-bar fallback for an omitted chart.type) had zero test
// coverage. Proves both that validation accepts a chart with no "type"
// key at all, and that buildChartPayload produces the plain
// {groupValue, total} shape (not the series {groupValue, values} matrix)
// for it, exactly like an explicit type: 'bar' would.
function testPublishChartTypeOmittedDefaultsToBar() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10'], ['B', '20']]);

  var result = ctx.NotSoBigData.cli('run --select chartTypeOmittedPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var chart = extractPayload(getHtml()).charts[0];

  assert.strictEqual(chart.type, 'bar', 'expected an omitted chart.type to default to "bar" in the payload, got: ' + JSON.stringify(chart));
  assert.strictEqual(chart.seriesKeys, undefined, 'expected no seriesKeys on a default-type chart, got: ' + JSON.stringify(chart));
  var totalsByGroup = {};
  chart.data.forEach(function (d) { totalsByGroup[d.groupValue] = d.total; });
  assert.strictEqual(totalsByGroup.A, 10, 'expected plain {groupValue, total} shape for A, got: ' + JSON.stringify(chart.data));
  assert.strictEqual(totalsByGroup.B, 20, 'expected plain {groupValue, total} shape for B, got: ' + JSON.stringify(chart.data));
}

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

  // drawLineChart and drawPieChart each gate their click wiring on a
  // standalone "if (chart.linkKey) {" block (they have no seriesLinkKey
  // concept at all) - anchored to end-of-line so this doesn't also match
  // chartSelectionFor's/selectionMatches' one-line "if (chart.linkKey) {
  // ... }" conditionals, which have trailing code after "{" on the same
  // line and are a different thing entirely.
  var lineOrPieGateCount = (html.match(/^\s*if \(chart\.linkKey\) \{$/gm) || []).length;
  assert.strictEqual(lineOrPieGateCount, 2, 'expected exactly 2 standalone "if (chart.linkKey) {" gate blocks (drawLineChart + drawPieChart), got ' + lineOrPieGateCount + ' in: ' + html);
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

function testPublishNoPaginationScriptWithoutTables() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [['A', '10', 'o1']]);

  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  // aggregationPublish has a chart (Task 3), so CHART_CLIENT_JS's own
  // DOMContentLoaded listener is expected here - checking for that literal
  // string would no longer isolate TABLE_PAGINATION_JS. Check instead for
  // TABLE_PAGINATION_JS's own table-block query, which only it emits.
  assert.ok(html.indexOf('querySelectorAll(".table-block")') === -1, 'expected no pagination script when config.tables is empty, got: ' + html);
}

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

function testPublishSeriesChartHandlesSpacesWithoutCollision() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['location', 'channel_type', 'revenue'], [
    ['New York', 'Paid Search', '100'],
    ['New', 'York Paid Search', '50'],  // Different combination, same concat result
    ['New York', 'Organic', '25']
    // Tests: 'New York' + 'Paid Search' and 'New' + 'York Paid Search'
    // would both hash to 'New York Paid Search' with string key;
    // nested maps keep them separate.
  ]);

  var result = ctx.NotSoBigData.cli('run --select seriesChartWithSpacesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());
  var chart = payload.charts.filter(function (c) { return c.id === 'by_location_channel'; })[0];

  assert.deepStrictEqual(chart.seriesKeys, ['Paid Search', 'York Paid Search', 'Organic'],
    'expected seriesKeys in first-seen order, got: ' + JSON.stringify(chart.seriesKeys));
  var groupNewYork = chart.data.filter(function (d) { return d.groupValue === 'New York'; })[0];
  var groupNew = chart.data.filter(function (d) { return d.groupValue === 'New'; })[0];

  // New York should have: Paid Search=100, York Paid Search=0 (zero-filled), Organic=25
  assert.strictEqual(groupNewYork.values['Paid Search'], 100,
    'expected New York / Paid Search = 100, got: ' + JSON.stringify(groupNewYork));
  assert.strictEqual(groupNewYork.values['York Paid Search'], 0,
    'expected New York / York Paid Search zero-filled to 0, got: ' + JSON.stringify(groupNewYork));
  assert.strictEqual(groupNewYork.values.Organic, 25,
    'expected New York / Organic = 25, got: ' + JSON.stringify(groupNewYork));

  // New should have: Paid Search=0 (zero-filled), York Paid Search=50, Organic=0 (zero-filled)
  assert.strictEqual(groupNew.values['Paid Search'], 0,
    'expected New / Paid Search zero-filled to 0, got: ' + JSON.stringify(groupNew));
  assert.strictEqual(groupNew.values['York Paid Search'], 50,
    'expected New / York Paid Search = 50, got: ' + JSON.stringify(groupNew));
  assert.strictEqual(groupNew.values.Organic, 0,
    'expected New / Organic zero-filled to 0, got: ' + JSON.stringify(groupNew));
}

module.exports = {
  testPublishNodeDiscoverableByKind: testPublishNodeDiscoverableByKind,
  testPublishSourceRefMustBeInDependsOn: testPublishSourceRefMustBeInDependsOn,
  testPublishKpiRequiresFieldUnlessCount: testPublishKpiRequiresFieldUnlessCount,
  testPublishRefMustResolveToBigQueryLocation: testPublishRefMustResolveToBigQueryLocation,
  testPublishValidRefProceedsPastValidation: testPublishValidRefProceedsPastValidation,
  testPublishUnknownChartTypeRejected: testPublishUnknownChartTypeRejected,
  testPublishChartSeriesOnNonBarRejected: testPublishChartSeriesOnNonBarRejected,
  testPublishChartDonutOnNonPieRejected: testPublishChartDonutOnNonPieRejected,
  testPublishChartBadStackingRejected: testPublishChartBadStackingRejected,
  testPublishV2ChartTypesProceedPastValidation: testPublishV2ChartTypesProceedPastValidation,
  testPublishLayoutTypeOtherThanLinearRejected: testPublishLayoutTypeOtherThanLinearRejected,
  testPublishEscapesScriptCloseInEmbeddedPayload: testPublishEscapesScriptCloseInEmbeddedPayload,
  testPublishAggregatesKpisAndChartsCorrectly: testPublishAggregatesKpisAndChartsCorrectly,
  testPublishDebugOnlyProbesDriveTarget: testPublishDebugOnlyProbesDriveTarget,
  testPublishTableModeMustBeRawOrAggregated: testPublishTableModeMustBeRawOrAggregated,
  testPublishRawTableRequiresColumns: testPublishRawTableRequiresColumns,
  testPublishRawTableColumnRequiresField: testPublishRawTableColumnRequiresField,
  testPublishAggregatedTableRequiresGroupBy: testPublishAggregatedTableRequiresGroupBy,
  testPublishAggregatedTableRequiresMetrics: testPublishAggregatedTableRequiresMetrics,
  testPublishAggregatedMetricRequiresFieldUnlessCount: testPublishAggregatedMetricRequiresFieldUnlessCount,
  testPublishTableFormatMustBeKnownEnum: testPublishTableFormatMustBeKnownEnum,
  testPublishDuplicateTableIdRejected: testPublishDuplicateTableIdRejected,
  testPublishValidTablesProceedPastValidation: testPublishValidTablesProceedPastValidation,
  testPublishBuildsRawAndAggregatedTablePayloads: testPublishBuildsRawAndAggregatedTablePayloads,
  testPublishRawTableRendersFirstPageAndEmbedsFullData: testPublishRawTableRendersFirstPageAndEmbedsFullData,
  testPublishNoPaginationScriptWithoutTables: testPublishNoPaginationScriptWithoutTables,
  testPublishLineChartSortsGroupsByNumericValue: testPublishLineChartSortsGroupsByNumericValue,
  testPublishLineChartSortsGroupsByDateString: testPublishLineChartSortsGroupsByDateString,
  testPublishSeriesChartBuildsDenseZeroFilledMatrix: testPublishSeriesChartBuildsDenseZeroFilledMatrix,
  testPublishSeriesChartHandlesSpacesWithoutCollision: testPublishSeriesChartHandlesSpacesWithoutCollision,
  testPublishChartRendersMountPointAndD3Script: testPublishChartRendersMountPointAndD3Script,
  testPublishNoD3ScriptWithoutCharts: testPublishNoD3ScriptWithoutCharts,
  testPublishChartClientJsDispatchesByType: testPublishChartClientJsDispatchesByType,
  testPublishChartClientJsUsesStyleForColorScaledFills: testPublishChartClientJsUsesStyleForColorScaledFills,
  testPublishAggregationFixtureStillHasNoStacking: testPublishAggregationFixtureStillHasNoStacking,
  testPublishD3ScriptHasSubresourceIntegrity: testPublishD3ScriptHasSubresourceIntegrity,
  testPublishDuplicateChartIdRejected: testPublishDuplicateChartIdRejected,
  testPublishChartTypeOmittedDefaultsToBar: testPublishChartTypeOmittedDefaultsToBar,
  testPublishChartSeriesLinkKeyWithoutSeriesRejected: testPublishChartSeriesLinkKeyWithoutSeriesRejected,
  testPublishLinkKeyChartsProceedPastValidation: testPublishLinkKeyChartsProceedPastValidation,
  testPublishChartPayloadPassesThroughLinkKeys: testPublishChartPayloadPassesThroughLinkKeys,
  testPublishChartClientJsIncludesSelectionModule: testPublishChartClientJsIncludesSelectionModule,
  testPublishChartClientJsCallsApplyHighlightOnceOnLoad: testPublishChartClientJsCallsApplyHighlightOnceOnLoad,
  testPublishChartClientJsWiresBarClickOnlyWhenInteractive: testPublishChartClientJsWiresBarClickOnlyWhenInteractive,
  testPublishChartClientJsWiresLineAndPieClickOnLinkKey: testPublishChartClientJsWiresLineAndPieClickOnLinkKey
};
