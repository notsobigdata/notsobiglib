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

  var scriptCloseCount = html.split('</script').length - 1;
  assert.strictEqual(scriptCloseCount, 1, 'expected exactly one </script closing tag (the template\'s own), found ' + scriptCloseCount + ' in: ' + html);
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
  // groupBy category, sum(revenue): A = 30, B = 5
  assert.ok(html.indexOf('>A<') !== -1 && html.indexOf('>30<') !== -1, 'expected category A\'s total (30) in: ' + html);
  assert.ok(html.indexOf('>B<') !== -1 && html.indexOf('>5<') !== -1, 'expected category B\'s total (5) in: ' + html);
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

function testPublishNoPaginationScriptWithoutTables() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [['A', '10', 'o1']]);

  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(!/DOMContentLoaded/.test(html), 'expected no pagination script when config.tables is empty, got: ' + html);
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
  testPublishSeriesChartBuildsDenseZeroFilledMatrix: testPublishSeriesChartBuildsDenseZeroFilledMatrix
};
