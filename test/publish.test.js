// test/publish.test.js
var assert = require('assert');
var path = require('path');
var vm = require('vm');
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
  assert.ok(/expected one of linear, board/.test(result.error), 'expected a layout-type error, got: ' + result.error);
}

function testPublishBoardRelatesToWithoutBoardLayoutRejected() {
  var result = runOne('boardRelatesToWithoutBoardLayoutPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/requires layout\.type "board"/.test(result.error), 'expected a relatesTo-requires-board error, got: ' + result.error);
}

function testPublishBoardRelatesToUnknownIdRejected() {
  var result = runOne('boardRelatesToUnknownIdPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/doesn't match any declared chart\/table id/.test(result.error), 'expected an unknown-relatesTo-id error, got: ' + result.error);
}

function testPublishBoardRelatesToSelfRejected() {
  var result = runOne('boardRelatesToSelfPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/pointing at itself/.test(result.error), 'expected a self-relatesTo error, got: ' + result.error);
}

function testPublishBoardRelatesToCycleRejected() {
  var result = runOne('boardRelatesToCyclePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/forms a cycle/.test(result.error), 'expected a relatesTo-cycle error, got: ' + result.error);
}

function testPublishBoardDuplicateCrossTypeIdRejected() {
  var result = runOne('boardDuplicateCrossTypeIdPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/used as both a chart id and a table id/.test(result.error), 'expected a cross-type duplicate-id error, got: ' + result.error);
}

function testPublishBoardValidRelationsProceedPastValidation() {
  var result = runOne('boardValidPublish');
  // Same proof pattern as testPublishValidRefProceedsPastValidation: no
  // BigQuery shim in this test, so a config that gets all the way past
  // validation fails next at the un-shimmed BigQuery call, not at
  // validation.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation to pass and fail only at the BigQuery call, got: ' + result.error);
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
// tableOverrides is optional: { [table]: { fieldNames, rowValues } },
// keyed by the bigquery table name a fetchTableRows call resolves to -
// lets a block-source-override test give a second table its own distinct
// rows while every other table keeps using the fieldNames/rowValues
// passed positionally, unchanged from every pre-existing call site.
function shimBigQueryAndDrive(ctx, fieldNames, rowValues, tableOverrides) {
  var capturedHtml = null;
  ctx.MimeType = { HTML: 'text/html' };
  function dataFor(table) {
    if (tableOverrides && tableOverrides[table]) {
      return tableOverrides[table];
    }
    return { fieldNames: fieldNames, rowValues: rowValues };
  }
  ctx.BigQuery = {
    Tables: {
      get: function (projectId, dataset, table) {
        return { schema: { fields: dataFor(table).fieldNames.map(function (name) { return { name: name }; }) } };
      }
    },
    Tabledata: {
      list: function (projectId, dataset, table) {
        return {
          rows: dataFor(table).rowValues.map(function (values) {
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
  // columns carry their format now (not just key/label) - the client-side
  // sort engine needs it to compare currency/integer/decimal columns
  // numerically instead of as formatted strings (see
  // testPublishTableClientJsSortsCurrencyColumnNumerically).
  assert.deepStrictEqual(rawTable.columns, [
    { key: 'order_id', label: 'Order', format: 'string' },
    { key: 'revenue', label: 'Revenue', format: 'currency' }
  ]);
  assert.strictEqual(rawTable.pageSize, 2);
  assert.deepStrictEqual(rawTable.rows, [
    ['o1', '$10.00'], ['o1', '$20.00'], ['o3', '$5.00'], ['o2', '$5.00']
  ]);

  var aggTable = payload.tables.filter(function (t) { return t.id === 'by_category'; })[0];
  assert.ok(aggTable, 'expected a by_category table in payload.tables');
  assert.deepStrictEqual(aggTable.columns, [
    { key: 'category', label: 'category', format: 'string' },
    { key: 'Revenue', label: 'Revenue', format: 'currency' },
    { key: 'Orders', label: 'Orders', format: 'integer' }
  ]);
  // A: sum(revenue) 10+20+5=35, count_distinct(order_id) over ['o1','o1','o3']=2
  // B: sum(revenue) 5, count_distinct(order_id) over ['o2']=1
  assert.deepStrictEqual(aggTable.rows, [
    ['A', '$35.00', '2'],
    ['B', '$5.00', '1']
  ]);
}

function testPublishTableHeadersSortableAndSearchInputRendered() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [
    ['A', '10', 'o1']
  ]);

  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  var sectionMatch = html.match(/<section class="table-block" data-table-id="recent_orders">[\s\S]*?<\/section>/);
  assert.ok(sectionMatch, 'expected the recent_orders table section in: ' + html);
  var section = sectionMatch[0];

  assert.ok(/class="table-search"/.test(section), 'expected a search input in: ' + section);
  assert.ok(/<th class="table-sortable" data-col-index="0">Order<\/th>/.test(section), 'expected a sortable "Order" header in: ' + section);
  assert.ok(/<th class="table-sortable" data-col-index="1">Revenue<\/th>/.test(section), 'expected a sortable "Revenue" header in: ' + section);
}

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
  assert.ok(!/<button[^>]*class="table-detail-toggle"/.test(html), 'expected no detail toggle button markup without detail configured, got: ' + html);
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

function testPublishCsvExportButtonAndScriptEmitted() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [
    ['A', '10', 'o1'],
    ['A', '20', 'o1']
  ]);

  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  var sectionMatch = html.match(/<section class="table-block" data-table-id="recent_orders">[\s\S]*?<\/section>/);
  assert.ok(sectionMatch, 'expected the recent_orders table section in: ' + html);
  assert.ok(/class="table-csv-export"/.test(sectionMatch[0]), 'expected an Export CSV button in: ' + sectionMatch[0]);

  assert.ok(/table-csv-export/.test(html) && /Blob/.test(html) && /text\/csv/.test(html), 'expected CSV export wiring in the emitted script, got: ' + html);
}

// CSV formula injection (CWE-1236): a cell sourced from live, unvalidated
// BigQuery data starting with =/+/-/@ would otherwise be parsed as a
// formula by Excel/Sheets on export - assert csvField()'s neutralizing
// prefix is actually present in the emitted script, not just that CSV
// export exists at all.
function testPublishCsvExportNeutralizesFormulaInjection() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [
    ['A', '10', 'o1']
  ]);

  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/\/\^\[=\+@-\]\//.test(html), 'expected csvField to guard against a leading =/+/-/@ formula-trigger character, got: ' + html);
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

// Security regression: the source table can carry columns the block never
// declared in detail.columns/groupBy/series (e.g. an internal-only field
// like margin) - withDetail must trim each embedded row down to exactly
// the fields the client-side modal/filter code reads, never ship the rest
// of the source row into __PUBLISH_PAYLOAD__.
function testPublishDetailRowsExcludeFieldsOutsideColumnsGroupByAndSeries() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'order_id', 'revenue', 'internal_margin'], [
    ['A', 'o1', '10', '4'],
    ['A', 'o2', '20', '8'],
    ['B', 'o3', '5', '1']
  ]);
  var result = ctx.NotSoBigData.cli('run --select detailPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  var chart = payload.charts.filter(function (c) { return c.id === 'by_category'; })[0];
  chart.detail.rows.forEach(function (row) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['category', 'order_id', 'revenue'], 'expected only groupBy + detail.columns fields, got: ' + JSON.stringify(row));
    assert.strictEqual(row.internal_margin, undefined, 'expected internal_margin to never reach the embedded payload, got: ' + JSON.stringify(row));
  });

  var table = payload.tables.filter(function (t) { return t.id === 'by_category_table'; })[0];
  table.detail.rows.forEach(function (row) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['category', 'order_id', 'revenue'], 'expected only groupBy + detail.columns fields, got: ' + JSON.stringify(row));
    assert.strictEqual(row.internal_margin, undefined, 'expected internal_margin to never reach the embedded payload, got: ' + JSON.stringify(row));
  });
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

// Whole-branch review finding: a NULL groupValue/seriesValue must not
// silently drop out of highlighting. D3's .attr(name, null) removes the
// attribute rather than setting it, so every group/series-value accessor
// must coerce through String(...) to keep null/undefined attribute-matchable.
function testPublishChartClientJsCoercesGroupAndSeriesValuesToString() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'day', 'revenue'], [['A', 'online', '1', '10']]);

  var result = ctx.NotSoBigData.cli('run --select linkKeyChartsPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  var groupValueStringCount = (html.match(/data-group-value", function \(d\) \{ return String\(/g) || []).length;
  assert.strictEqual(groupValueStringCount, 5, 'expected all 5 data-group-value accessors to coerce via String(...), got ' + groupValueStringCount + ' in: ' + html);
  var seriesValueStringCount = (html.match(/data-series-value", function \(d\) \{ return String\(/g) || []).length;
  assert.strictEqual(seriesValueStringCount, 2, 'expected both data-series-value accessors to coerce via String(...), got ' + seriesValueStringCount + ' in: ' + html);
  assert.ok(/selection\[chart\.linkKey\] = String\(groupValue\);/.test(html), 'expected chartSelectionFor to coerce groupValue via String(...), got: ' + html);
  assert.ok(/selection\[chart\.seriesLinkKey\] = String\(seriesValue\);/.test(html), 'expected chartSelectionFor to coerce seriesValue via String(...), got: ' + html);
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

  assert.ok(/var interactive = !!\(chart\.linkKey \|\| chart\.seriesLinkKey \|\| chart\.linkTo \|\| chart\.detail\);/.test(html), 'expected drawBarChart\'s interactive flag (widened for detail), got: ' + html);
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
  // standalone "if (chart.linkKey || chart.linkTo) {" block (they have no
  // seriesLinkKey concept at all) - anchored to end-of-line so this
  // doesn't also match chartSelectionFor's/selectionMatches' one-line "if
  // (chart.linkKey) { ... }" conditionals, which have trailing code after
  // "{" on the same line and are a different thing entirely.
  var lineOrPieGateCount = (html.match(/^\s*if \(chart\.linkKey \|\| chart\.linkTo \|\| chart\.detail\) \{$/gm) || []).length;
  assert.strictEqual(lineOrPieGateCount, 2, 'expected exactly 2 standalone "if (chart.linkKey || chart.linkTo || chart.detail) {" gate blocks (drawLineChart + drawPieChart), got ' + lineOrPieGateCount + ' in: ' + html);
}

function testPublishChartClientJsHandlesLinkToClickNavigation() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);

  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  // handleChartClick's linkTo branch is static CHART_CLIENT_JS, emitted
  // whenever any chart exists at all - aggregationPublish has a chart but
  // no linkTo, so this proves the branch is always present, not just
  // conditionally included for reports that happen to use it.
  assert.ok(/if \(chart\.linkTo\) \{/.test(html), 'expected handleChartClick\'s linkTo branch in the emitted script, got: ' + html);
  assert.ok(/window\.open\(url, "_blank"\);/.test(html), 'expected the new-tab navigation call, got: ' + html);
  assert.ok(/window\.location\.href = url;/.test(html), 'expected the same-tab navigation fallback, got: ' + html);
  assert.ok(/encodeURIComponent\(chart\.linkTo\.field\)/.test(html), 'expected the query param to be built from linkTo.field, got: ' + html);
}

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

function testPublishLinkToRequiresNode() {
  var result = runOne('linkToMissingNodePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"linkTo", which requires "node" and "field"/.test(result.error), 'expected a linkTo node/field error, got: ' + result.error);
}

function testPublishLinkToRequiresField() {
  var result = runOne('linkToMissingFieldPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"linkTo", which requires "node" and "field"/.test(result.error), 'expected a linkTo node/field error, got: ' + result.error);
}

function testPublishLinkToNewTabMustBeBoolean() {
  var result = runOne('linkToBadNewTabPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/linkTo\.newTab "yes", which must be a boolean/.test(result.error), 'expected a linkTo.newTab type error, got: ' + result.error);
}

function testPublishLinkToCannotCombineWithLinkKey() {
  var result = runOne('linkToWithLinkKeyPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/both "linkTo" and "linkKey"\/"seriesLinkKey"/.test(result.error), 'expected a linkTo/linkKey mutual-exclusion error, got: ' + result.error);
}

function testPublishLinkToCannotCombineWithSeriesLinkKey() {
  var result = runOne('linkToWithSeriesLinkKeyPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/both "linkTo" and "linkKey"\/"seriesLinkKey"/.test(result.error), 'expected a linkTo/seriesLinkKey mutual-exclusion error, got: ' + result.error);
}

// The remaining linkTo checks (unknown node, wrong kind, missing matching
// filter) all live in resolveConfigLinkTargets/validateLinkToTarget,
// which is pure (no Drive/BigQuery call anywhere in linkTo's resolution -
// see that function's own comment) and runs before fetchTableRows, so
// these need no shim at all - same "runOne() alone is enough" pattern as
// every other pure-validation test in this file (e.g.
// testPublishRefMustResolveToBigQueryLocation).
function testPublishLinkToUnknownNodeRejected() {
  var result = runOne('linkToUnknownNodePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/linkTo\.node "nonExistentNodeXYZ", which doesn't match any declared node/.test(result.error), 'expected an unknown-linkTo-node error, got: ' + result.error);
}

function testPublishLinkToNonPublishNodeRejected() {
  var result = runOne('linkToNonPublishNodePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/which is a "move" node, not "publish"/.test(result.error), 'expected a wrong-kind linkTo error, got: ' + result.error);
}

function testPublishLinkToRequiresMatchingFilterFieldOnTarget() {
  var result = runOne('linkToSourceNoMatchingFilterPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/has no filters\[\] entry for that field/.test(result.error), 'expected a missing-matching-filter error, got: ' + result.error);
}

function testPublishLinkToValidConfigProceedsPastValidation() {
  var result = runOne('linkToSourcePublish');
  // Same proof pattern as testPublishLinkKeyChartsProceedPastValidation:
  // no shim in this test at all, so a config that gets all the way past
  // both config validation and linkTo's own (pure) cross-node checks
  // fails next at the un-shimmed BigQuery call (fetchTableRows), not
  // before it.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation to pass and fail only at the BigQuery call, got: ' + result.error);
}

function testPublishLinkToResolvesUrlAndEmbedsInChartPayload() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select linkToSourcePublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var chart = extractPayload(getHtml()).charts[0];
  // linkToTargetPublish's own target.fileName is 'category-detail.html' -
  // no Drive call anywhere in this resolution, just the destination's own
  // declared filename, ready to sit as a relative link next to this file.
  assert.deepStrictEqual(chart.linkTo, { url: 'category-detail.html', field: 'category', newTab: true },
    'expected linkTo resolved to the destination\'s own target.fileName with newTab defaulting to true, got: ' + JSON.stringify(chart.linkTo));
}

function testPublishLinkToNewTabFalseRespected() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select linkToSourceNewTabFalsePublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var chart = extractPayload(getHtml()).charts[0];
  assert.strictEqual(chart.linkTo.newTab, false, 'expected an explicit newTab: false to survive resolution, got: ' + JSON.stringify(chart.linkTo));
}

// linkTo's destination-side behavior: on load, a matching query-string
// field pre-selects that filter's dropdown and recomputes exactly like a
// human choosing it from the <select> would - the same activeFilters/
// applyFilters() plumbing the dropdowns themselves already trigger. This
// doesn't need linkTo resolved anywhere - it only depends on the
// destination report's own filters[], exactly as a human pasting the same
// URL by hand would trigger it too.
function testPublishFilterClientJsAppliesMatchingQueryStringFilterOnLoad() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [
    ['A', 'online', '10', '1'],
    ['A', 'store', '5', '2'],
    ['B', 'online', '20', '3']
  ]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  var engine = runClientEngine(extractInlineScript(html), 2, ['category', 'channel'], '?category=A');

  assert.strictEqual(engine.context.activeFilters.category, 'A', 'expected the query-string category to become the active filter, got: ' + JSON.stringify(engine.context.activeFilters));
  assert.strictEqual(engine.filterSelects.category.value, 'A', 'expected the category <select> to reflect the query-string value, got: ' + engine.filterSelects.category.value);
  assert.strictEqual(engine.kpiValueNodes[0].textContent, '$15.00', 'expected the KPI to already be recomputed against category=A on load (10 + 5), got: ' + engine.kpiValueNodes[0].textContent);
}

function testPublishFilterClientJsIgnoresQueryStringValueNotInFilterOptions() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [
    ['A', 'online', '10', '1'],
    ['B', 'online', '20', '3']
  ]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  var engine = runClientEngine(extractInlineScript(html), 2, ['category', 'channel'], '?category=NotARealCategory');

  assert.strictEqual(engine.context.activeFilters.category, undefined, 'expected an unmatched query-string value to be ignored, got: ' + JSON.stringify(engine.context.activeFilters));
  assert.strictEqual(engine.kpiValueNodes[0].textContent, '', 'expected no recompute to have run at all (stub KPI values start empty), got: ' + engine.kpiValueNodes[0].textContent);
}

function testPublishBlockSourceMustBeInDependsOn() {
  var result = runOne('blockSourceMissingDependsOnPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/missing from dependsOn/.test(result.error), 'expected a dependsOn error, got: ' + result.error);
}

function testPublishBlockSourceUnknownRefRejected() {
  var result = runOne('blockSourceUnknownRefPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/does not match a declared model or a move node with a bigquery target/.test(result.error), 'expected a ref-resolution error, got: ' + result.error);
}

function testPublishBlockSourceCannotCombineWithReactsTo() {
  var result = runOne('blockSourceWithReactsToPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"source" and "reactsTo" - these are mutually exclusive/.test(result.error), 'expected a mutual-exclusivity error, got: ' + result.error);
}

// Proves a kpi/chart/table declaring its own source.ref actually gets rows
// fetched from that other table, not the report's default source - two
// distinct bigquery tables, two distinct row sets, and the block-source
// blocks land only the second table's numbers while the default-source
// kpi keeps the first table's.
function testPublishBlockSourceOverrideFetchesFromItsOwnRef() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']], {
    orders_secondary: { fieldNames: ['category', 'revenue'], rowValues: [['B', '99'], ['C', '1']] }
  });

  var result = ctx.NotSoBigData.cli('run --select blockSourceOverridePublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  var defaultKpi = payload.kpis.filter(function (k) { return k.label === 'Default revenue'; })[0];
  var secondaryKpi = payload.kpis.filter(function (k) { return k.label === 'Secondary revenue'; })[0];
  assert.strictEqual(defaultKpi.value, 10, 'expected the default-source kpi to use the default table, got: ' + JSON.stringify(defaultKpi));
  assert.strictEqual(secondaryKpi.value, 100, 'expected the overridden kpi to use the secondary table (99 + 1), got: ' + JSON.stringify(secondaryKpi));

  var chart = payload.charts.filter(function (c) { return c.id === 'by_category_secondary'; })[0];
  var groups = chart.data.map(function (d) { return d.groupValue; }).sort();
  assert.deepStrictEqual(groups, ['B', 'C'], 'expected the overridden chart to group the secondary table\'s rows, got: ' + JSON.stringify(chart.data));

  var table = payload.tables.filter(function (t) { return t.id === 'secondary_raw'; })[0];
  assert.strictEqual(table.rows.length, 2, 'expected the overridden table to hold the secondary table\'s 2 rows, got: ' + JSON.stringify(table.rows));
}

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

function testPublishFilterRequiresFieldAndLabel() {
  var result = runOne('badFilterMissingLabelPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/every filter needs "field" and "label"/.test(result.error), 'expected a filter field/label error, got: ' + result.error);
}

function testPublishDuplicateFilterFieldRejected() {
  var result = runOne('duplicateFilterFieldPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/duplicate filter field "category"/.test(result.error), 'expected a duplicate-filter-field error, got: ' + result.error);
}

function testPublishReactsToMustBeNonEmptyArray() {
  var result = runOne('emptyReactsToPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"reactsTo", which must be a non-empty array/.test(result.error), 'expected a reactsTo-empty-array error, got: ' + result.error);
}

function testPublishReactsToMustReferenceDeclaredFilter() {
  var result = runOne('reactsToUndeclaredFilterPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"channel" is not a declared filter field/.test(result.error), 'expected a reactsTo-undeclared-field error, got: ' + result.error);
}

function testPublishFiltersProceedPastValidation() {
  var result = runOne('filtersPublish');
  // Same proof pattern as testPublishV2ChartTypesProceedPastValidation: no
  // BigQuery shim in this test, so a config that gets all the way past
  // validation fails next at the un-shimmed BigQuery call, not at
  // validation.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation to pass and fail only at the BigQuery call, got: ' + result.error);
}

function testPublishFilterPayloadAbsentWithoutFilters() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'rows'), 'expected no payload.rows without filters[], got keys: ' + Object.keys(payload).join(', '));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'filters'), 'expected no payload.filters without filters[], got keys: ' + Object.keys(payload).join(', '));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'filterableConfig'), 'expected no payload.filterableConfig without filters[], got keys: ' + Object.keys(payload).join(', '));
}

function testPublishFilterPayloadIncludesRowsAndSortedDistinctOptions() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [
    ['B', 'online', '10', '1'],
    ['A', 'store', '20', '2'],
    ['A', 'online', '5', '3']
  ]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  assert.strictEqual(payload.rows.length, 3, 'expected all 3 raw rows embedded, got: ' + JSON.stringify(payload.rows));

  var categoryFilter = payload.filters.filter(function (f) { return f.field === 'category'; })[0];
  assert.deepStrictEqual(categoryFilter.options, ['A', 'B'], 'expected sorted distinct category options, got: ' + JSON.stringify(categoryFilter));
  var channelFilter = payload.filters.filter(function (f) { return f.field === 'channel'; })[0];
  assert.deepStrictEqual(channelFilter.options, ['online', 'store'], 'expected sorted distinct channel options, got: ' + JSON.stringify(channelFilter));
}

function testPublishFilterableConfigOnlyIncludesReactsToBlocks() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  // filtersPublish's "Rows" kpi has no reactsTo - only "Revenue" (index 0
  // in config.kpis) should appear.
  assert.strictEqual(payload.filterableConfig.kpis.length, 1, 'expected only the reactsTo-bearing kpi, got: ' + JSON.stringify(payload.filterableConfig.kpis));
  assert.strictEqual(payload.filterableConfig.kpis[0].index, 0, 'expected the Revenue kpi at its original config.kpis index 0, got: ' + JSON.stringify(payload.filterableConfig.kpis[0]));
  assert.deepStrictEqual(payload.filterableConfig.kpis[0].config.reactsTo, ['category', 'channel']);

  assert.strictEqual(payload.filterableConfig.charts.length, 1);
  assert.strictEqual(payload.filterableConfig.charts[0].id, 'trend');
  assert.deepStrictEqual(payload.filterableConfig.charts[0].reactsTo, ['category']);

  assert.strictEqual(payload.filterableConfig.tables.length, 1);
  assert.strictEqual(payload.filterableConfig.tables[0].id, 'orders');
  assert.deepStrictEqual(payload.filterableConfig.tables[0].reactsTo, ['category', 'channel']);
}

function testPublishFilterableConfigExcludesNonReactiveKpiEvenWithFiltersConfigured() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());
  var kpiIndexes = payload.filterableConfig.kpis.map(function (entry) { return entry.index; });
  assert.strictEqual(kpiIndexes.indexOf(1), -1, 'expected the "Rows" kpi (config.kpis index 1, no reactsTo) to be absent from filterableConfig.kpis, got indexes: ' + JSON.stringify(kpiIndexes));
}

function testPublishFiltersMarkupRenderedWhenConfigured() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [
    ['B', 'online', '10', '1'],
    ['A', 'store', '20', '2']
  ]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/<div class="filters">/.test(html), 'expected a filters bar, got: ' + html);
  assert.ok(/data-filter-field="category"/.test(html), 'expected a category filter select, got: ' + html);
  assert.ok(/data-filter-field="channel"/.test(html), 'expected a channel filter select, got: ' + html);
  assert.ok(/<option value="">All<\/option>/.test(html), 'expected an "All" default option, got: ' + html);
  assert.ok(/<option value="A">A<\/option>/.test(html), 'expected a distinct-value option, got: ' + html);
}

function testPublishNoFiltersMarkupOrClientJsWithoutFilters() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(!/class="filters"/.test(html), 'expected no filters markup, got: ' + html);
  assert.ok(!/function applyFilters/.test(html), 'expected no FILTER_CLIENT_JS, got: ' + html);
  assert.ok(!/function filteredRowsFor/.test(html), 'expected no filter-engine wiring, got: ' + html);
}

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

function testPublishFilterClientJsIncludesReusedAggregationFunctionsVerbatim() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  ['computeAggregate', 'groupRowsBy', 'compareGroupValues', 'formatValue', 'buildChartPayload', 'buildRawTablePayload', 'buildAggregatedTablePayload', 'emptyMap', 'has'].forEach(function (name) {
    assert.ok(new RegExp('function ' + name + '\\(').test(html), 'expected the reused function "' + name + '" verbatim in the emitted script, got: ' + html);
  });
}

function testPublishFilterClientJsResetsHighlightSelectionOnApply() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/if \(typeof currentSelection !== "undefined"\) \{ currentSelection = null; \}/.test(html), 'expected applyFilters to reset any chart-highlight selection, got: ' + html);
  assert.ok(/if \(typeof applyHighlight === "function"\) \{ applyHighlight\(\); \}/.test(html), 'expected applyFilters to re-run applyHighlight, got: ' + html);
}

function testPublishFilterClientJsWiresSelectChangeEvents() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/querySelectorAll\("\[data-filter-field\]"\)/.test(html), 'expected the filter-select wiring query, got: ' + html);
  assert.ok(/select\.addEventListener\("change"/.test(html), 'expected a change listener on each filter select, got: ' + html);
}

function testPublishTableClientJsAlwaysExposesReplacerHook() {
  // Whether or not filters[] is configured - see this plan's Task 3 note
  // on why this is unconditional, matching CHART_CLIENT_JS's own
  // "always-on scaffolding, opt-in behavior" precedent from the chart-
  // interactivity phase (docs/superpowers/specs/2026-09-06-publish-chart-
  // interactivity-design.md).
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [['A', '10', 'o1']]);
  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/__PUBLISH_TABLE_REPLACERS__/.test(html), 'expected the table replacer hook regardless of filters[], got: ' + html);
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

// Pulls the report's one inline <script>...</script> (the bare-tag one -
// the D3 CDN tag always carries a "src" attribute, so this regex can't
// match that one instead) back out so it can actually be executed, not
// just regex-matched like every other filters[] test in this file.
function extractInlineScript(html) {
  var match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, 'expected a bare inline <script> in: ' + html);
  return match[1];
}

// Minimal browser stub - just enough surface for FILTER_CLIENT_JS/
// CHART_CLIENT_JS/TABLE_CLIENT_JS's actual DOMContentLoaded-time and
// applyFilters()-time DOM calls to run without throwing. Not a general
// DOM: querySelectorAll(".kpi") is the only selector that returns
// anything real (one stub node per kpi card, each holding the mutable
// ".kpi-value" textContent this test asserts on) - every other selector
// returns an empty array, and getElementById returns null so
// applyFilterToChart's "if (!container) { return; }" guard exits before
// ever touching d3 (which this stub doesn't provide at all).
// filterFields/locationSearch (both optional) back linkTo's destination-
// side behavior: applyFiltersFromQueryString() reads window.location.search
// at DOMContentLoaded time and looks up the page's own [data-filter-field]
// <select>s, so this stub actually fires DOMContentLoaded (unlike a plain
// noop) and exposes one fake <select> per named field for a test to
// inspect afterwards.
function runClientEngine(scriptText, kpiCount, filterFields, locationSearch) {
  var kpiValueNodes = [];
  var kpiCards = [];
  for (var i = 0; i < kpiCount; i += 1) {
    (function (index) {
      var valueNode = { textContent: '' };
      kpiValueNodes[index] = valueNode;
      kpiCards[index] = {
        querySelector: function (selector) { return selector === '.kpi-value' ? valueNode : null; }
      };
    })(i);
  }
  var filterSelects = {};
  (filterFields || []).forEach(function (field) {
    filterSelects[field] = {
      value: '',
      getAttribute: function (name) { return name === 'data-filter-field' ? field : null; },
      addEventListener: function () {}
    };
  });
  var noop = function () {};
  var sandbox = {
    console: console,
    URLSearchParams: URLSearchParams,
    document: {
      querySelectorAll: function (selector) {
        if (selector === '.kpi') { return kpiCards; }
        if (selector === '[data-filter-field]') { return Object.keys(filterSelects).map(function (field) { return filterSelects[field]; }); }
        return [];
      },
      querySelector: function () { return null; },
      getElementById: function () { return null; },
      addEventListener: function (event, handler) { if (event === 'DOMContentLoaded') { handler(); } },
      createElement: function () { return { setAttribute: noop, appendChild: noop, style: {} }; }
    }
  };
  sandbox.window = sandbox;
  sandbox.window.location = { search: locationSearch || '' };
  vm.createContext(sandbox);
  vm.runInContext(scriptText, sandbox, { filename: 'filter-client.js' });
  return { context: sandbox, kpiValueNodes: kpiValueNodes, filterSelects: filterSelects };
}

// A generic createElement stub good enough for openDetailModal's real DOM
// building (div/h3/button/table/thead/tbody/th/td, chained via real
// appendChild calls) - unlike the old leaf-only "{ textContent: '' }"
// stub, every node here tracks its own childNodes/parentNode so a test can
// walk the actual tree openDetailModal built, the same way a real browser
// would render it. 'tr' keeps its pre-existing "_cells" alias (just the
// same childNodes array under an older name) so TABLE_CLIENT_JS's own
// row-rendering tests (bodyRows(), below) keep working unchanged.
function makeStubElement(tag) {
  var attributes = {};
  var el = {
    tagName: tag,
    childNodes: [],
    className: '', id: '', textContent: '', type: '',
    parentNode: null,
    appendChild: function (child) { el.childNodes.push(child); child.parentNode = el; return child; },
    removeChild: function (child) { var i = el.childNodes.indexOf(child); if (i !== -1) { el.childNodes.splice(i, 1); } child.parentNode = null; },
    addEventListener: function (event, handler) { el._listeners = el._listeners || {}; el._listeners[event] = handler; },
    setAttribute: function (name, value) { attributes[name] = String(value); },
    getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; }
  };
  if (tag === 'tr') { el._cells = el.childNodes; }
  return el;
}

// Minimal DOM stub for TABLE_CLIENT_JS's own DOMContentLoaded-time setup -
// unlike runClientEngine above (which never fires DOMContentLoaded, since
// FILTER_CLIENT_JS's applyFilters() is invoked directly), TABLE_CLIENT_JS's
// sort/search/pager state lives entirely inside that listener's closure, so
// this stub's addEventListener("DOMContentLoaded", ...) actually calls the
// handler immediately. Captures just enough of one .table-block section
// (tbody rows as plain string arrays, the sortable <th>s, the search input,
// the CSV button) to drive it exactly the way a browser click/keystroke
// would. tableId defaults to 'recent_orders' (every pre-existing call site's
// fixture uses that id) - a test driving a different fixture's table passes
// its own id explicitly. document.body/getElementById track real appended
// nodes (by id) so openDetailModal/closeDetailModal - real DOM calls, not
// stubbed away - actually work; window.location/URLSearchParams are here
// too since FILTER_CLIENT_JS's DOMContentLoaded listener (present whenever
// the emitted script also has filters[]) unconditionally calls
// applyFiltersFromQueryString() on load.
function runTableClientEngine(scriptText, columnCount, tableId) {
  var headerCells = [];
  for (var i = 0; i < columnCount; i += 1) {
    (function (index) {
      var onClick = null;
      headerCells[index] = {
        getAttribute: function (name) { return name === 'data-col-index' ? String(index) : null; },
        addEventListener: function (event, handler) { if (event === 'click') { onClick = handler; } },
        click: function () { onClick(); },
        textContent: ''
      };
    })(i);
  }
  var tbodyChildren = [];
  var tbody = {
    removeChild: function (child) { var i = tbodyChildren.indexOf(child); if (i !== -1) { tbodyChildren.splice(i, 1); } },
    appendChild: function (child) { tbodyChildren.push(child); }
  };
  Object.defineProperty(tbody, 'firstChild', { get: function () { return tbodyChildren[0] || null; } });
  function stubButton() {
    var onClick = null;
    return {
      addEventListener: function (event, handler) { if (event === 'click') { onClick = handler; } },
      click: function () { onClick(); },
      disabled: false
    };
  }
  var prevBtn = stubButton();
  var nextBtn = stubButton();
  var csvBtn = stubButton();
  var pageLabel = { textContent: '' };
  var searchOnInput = null;
  var searchInput = {
    value: '',
    addEventListener: function (event, handler) { if (event === 'input') { searchOnInput = handler; } },
    type: function (value) { this.value = value; searchOnInput(); }
  };
  var sectionClickHandler = null;
  var section = {
    getAttribute: function (name) { return name === 'data-table-id' ? (tableId || 'recent_orders') : null; },
    querySelector: function (selector) {
      if (selector === 'tbody') { return tbody; }
      if (selector === '.table-prev') { return prevBtn; }
      if (selector === '.table-next') { return nextBtn; }
      if (selector === '.table-page-label') { return pageLabel; }
      if (selector === '.table-csv-export') { return csvBtn; }
      if (selector === '.table-search') { return searchInput; }
      return null;
    },
    querySelectorAll: function (selector) { return selector === '.table-sortable' ? headerCells : []; },
    addEventListener: function (event, handler) { if (event === 'click') { sectionClickHandler = handler; } }
  };
  var lastBlobParts = null;
  var bodyChildren = [];
  var body = {
    appendChild: function (child) { child.parentNode = body; bodyChildren.push(child); },
    removeChild: function (child) { var i = bodyChildren.indexOf(child); if (i !== -1) { bodyChildren.splice(i, 1); } child.parentNode = null; }
  };
  var sandbox = {
    console: console,
    Blob: function (parts) { lastBlobParts = parts; return { parts: parts }; },
    URL: { createObjectURL: function () { return 'blob://fake'; }, revokeObjectURL: function () {} },
    URLSearchParams: URLSearchParams,
    document: {
      querySelectorAll: function (selector) { return selector === '.table-block' ? [section] : []; },
      querySelector: function () { return null; },
      getElementById: function (id) { return bodyChildren.filter(function (el) { return el.id === id; })[0] || null; },
      addEventListener: function (event, handler) { if (event === 'DOMContentLoaded') { handler(); } },
      createElement: function (tag) {
        if (tag === 'a') { return { setAttribute: function () {}, click: function () {}, style: {} }; }
        return makeStubElement(tag);
      },
      body: body
    }
  };
  sandbox.window = sandbox;
  sandbox.window.location = { search: '' };
  vm.createContext(sandbox);
  vm.runInContext(scriptText, sandbox, { filename: 'table-client.js' });
  return {
    context: sandbox,
    clickHeader: function (index) { headerCells[index].click(); },
    search: function (value) { searchInput.type(value); },
    bodyRows: function () { return tbodyChildren.map(function (tr) { return tr._cells.map(function (td) { return td.textContent; }); }); },
    exportedCsv: function () { lastBlobParts = null; csvBtn.click(); return lastBlobParts[0]; },
    pageLabel: function () { return pageLabel.textContent; },
    // Drives the real click-delegation code in TABLE_DETAIL_TOGGLE_HANDLER_JS
    // (event.target.closest(".table-detail-toggle")) with a synthetic event
    // whose target is a minimal-but-real stub supporting .closest() - not a
    // shortcut that calls some inner function directly, so a break in the
    // actual delegation logic (e.g. the ".table-detail-toggle" selector
    // typo'd, or the "!table.detail" guard reversed) fails this the same
    // way it would fail in a real browser.
    clickDetailToggle: function (groupValue) {
      if (!sectionClickHandler) { throw new Error('no click handler registered on the table-block section - was "detail" configured on this table?'); }
      var toggle = { getAttribute: function (name) { return name === 'data-group-value' ? groupValue : null; } };
      var eventTarget = { closest: function (selector) { return selector === '.table-detail-toggle' ? toggle : null; } };
      sectionClickHandler({ target: eventTarget });
    },
    // Walks the real DOM tree openDetailModal built (via the createElement/
    // appendChild stub above) rather than re-deriving the modal's content
    // any other way - null if no modal is currently open.
    modalContents: function () {
      var modal = bodyChildren.filter(function (el) { return el.id === 'publish-detail-modal'; })[0];
      if (!modal) { return null; }
      var box = modal.childNodes[0];
      var header = box.childNodes[0];
      var modalTable = box.childNodes[1];
      var headRow = modalTable.childNodes[0].childNodes[0];
      var modalTbody = modalTable.childNodes[1];
      return {
        title: header.childNodes[0].textContent,
        headers: headRow.childNodes.map(function (th) { return th.textContent; }),
        rows: modalTbody.childNodes.map(function (tr) { return tr.childNodes.map(function (td) { return td.textContent; }); })
      };
    }
  };
}

// Regression-style proof that sorting compares the underlying number, not
// the formatted string - "$5.00" < "$10.00" < "$20.00" numerically, but
// "$10.00" < "$20.00" < "$5.00" alphabetically, which is exactly the bug a
// naive String-compare sort would reintroduce.
function testPublishTableClientJsSortsCurrencyColumnNumerically() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [
    ['A', '20', 'o1'],
    ['A', '5', 'o3'],
    ['A', '10', 'o2']
  ]);
  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  var engine = runTableClientEngine(extractInlineScript(html), 2);

  engine.clickHeader(1); // Revenue column, first click -> ascending
  assert.deepStrictEqual(engine.bodyRows(), [['o3', '$5.00'], ['o2', '$10.00']], 'expected the first page ascending by revenue (pageSize 2), got: ' + JSON.stringify(engine.bodyRows()));
  assert.ok(/Page 1 of 2/.test(engine.pageLabel()), 'expected the page label to reflect all 3 rows still present, got: ' + engine.pageLabel());

  engine.clickHeader(1); // second click on the same column -> descending
  assert.deepStrictEqual(engine.bodyRows(), [['o1', '$20.00'], ['o2', '$10.00']], 'expected the first page descending by revenue, got: ' + JSON.stringify(engine.bodyRows()));

  engine.clickHeader(1); // third click -> back to unsorted (original) order
  assert.deepStrictEqual(engine.bodyRows(), [['o1', '$20.00'], ['o3', '$5.00']], 'expected the original unsorted order restored, got: ' + JSON.stringify(engine.bodyRows()));
}

function testPublishTableClientJsSearchNarrowsRowsAndCsvExport() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [
    ['A', '20', 'o1'],
    ['A', '5', 'o3'],
    ['A', '10', 'o2']
  ]);
  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  var engine = runTableClientEngine(extractInlineScript(html), 2);

  engine.search('o1');
  assert.deepStrictEqual(engine.bodyRows(), [['o1', '$20.00']], 'expected only the matching row after searching "o1", got: ' + JSON.stringify(engine.bodyRows()));
  assert.ok(/Page 1 of 1/.test(engine.pageLabel()), 'expected the page count to shrink to the filtered set, got: ' + engine.pageLabel());

  var csv = engine.exportedCsv();
  assert.ok(csv.indexOf('o1') !== -1, 'expected the exported CSV to include the matching row, got: ' + csv);
  assert.ok(csv.indexOf('o3') === -1 && csv.indexOf('o2') === -1, 'expected the exported CSV to exclude rows the active search filters out, got: ' + csv);
}

// Regression test for whole-branch review finding #1: every other
// filters[] test in this file only regexes the generated HTML text and
// never actually runs the emitted client engine, which is exactly how a
// bug in filteredRowsFor's null-vs-empty-array return shipped past a
// full green test suite. This one loads the real emitted <script> into a
// vm context and drives it end to end: filter to category "A" (checking
// the KPI actually recomputes), then reset back to "All" and confirm the
// KPI returns to its original, full/unfiltered value - the reset path
// that was broken (a filtered block stayed stuck on stale data forever
// once its one active filter was cleared).
function testPublishFilterResetRecomputesKpiBackToUnfilteredValue() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [
    ['A', 'online', '10', '1'],
    ['A', 'store', '5', '2'],
    ['B', 'online', '20', '3']
  ]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  var engine = runClientEngine(extractInlineScript(html), 2);

  // The stub DOM's kpi-value nodes start empty (real page load fills them
  // from server-rendered markup, which this stub doesn't parse) - one
  // no-filters applyFilters() call reproduces the same baseline, since
  // filteredRowsFor with nothing active now returns every row (the fix
  // under test). "Revenue" is filtersPublish's config.kpis index 0,
  // format currency - full unfiltered sum: 10 + 5 + 20 = 35.
  engine.context.applyFilters();
  assert.strictEqual(engine.kpiValueNodes[0].textContent, '$35.00', 'expected the initial unfiltered KPI value, got: ' + engine.kpiValueNodes[0].textContent);

  engine.context.activeFilters.category = 'A';
  engine.context.applyFilters();
  assert.strictEqual(engine.kpiValueNodes[0].textContent, '$15.00', 'expected the KPI to recompute against category=A rows only (10 + 5), got: ' + engine.kpiValueNodes[0].textContent);

  // Reset to "All" - what the real <select> does when its value goes
  // back to "" (see FILTER_CLIENT_JS's change handler: "delete
  // activeFilters[field]").
  delete engine.context.activeFilters.category;
  engine.context.applyFilters();
  assert.strictEqual(engine.kpiValueNodes[0].textContent, '$35.00', 'expected the KPI to recompute back to the full unfiltered sum after resetting the filter to All, got: ' + engine.kpiValueNodes[0].textContent);
}

// Whole-branch review findings #1+#2: every other "detail" test in this
// file either regexes the emitted <script>'s source text or (Task 2's
// payload tests) inspects buildReportPayload's output directly - none of
// them actually click anything, and none combine "detail" with
// filters[]/reactsTo, so the feature's own headline requirement (the modal
// reflects the currently-active filter, not a stale snapshot - design
// spec §3) had zero automated proof. This drives the real emitted <script>
// end to end: click the aggregated table's detail toggle for group "A"
// (2 matching rows, no filter active yet), change the active "channel"
// filter to "store" through the real FILTER_CLIENT_JS machinery (the same
// way testPublishFilterResetRecomputesKpiBackToUnfilteredValue does),
// click the same toggle again, and confirm the modal now shows only the
// one row whose channel actually is "store" - proving withDetail's rows
// come from the block's *current* (filtered) row set, not a snapshot
// taken at generation time.
function testPublishDetailToggleReflectsActiveFilterNotStaleSnapshot() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'order_id'], [
    ['A', 'online', '10', 'o1'],
    ['A', 'store', '20', 'o2'],
    ['B', 'online', '5', 'o3']
  ]);
  var result = ctx.NotSoBigData.cli('run --select filtersWithDetailPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  var engine = runTableClientEngine(extractInlineScript(html), 2, 'by_category_table');

  assert.strictEqual(engine.modalContents(), null, 'expected no modal open before any click');

  engine.clickDetailToggle('A');
  var beforeFilter = engine.modalContents();
  assert.ok(beforeFilter, 'expected the toggle click to open a modal');
  assert.strictEqual(beforeFilter.title, 'By category: A', 'expected the modal title to name the clicked group, got: ' + JSON.stringify(beforeFilter));
  assert.deepStrictEqual(beforeFilter.headers, ['Order', 'Revenue'], 'expected the detail.columns labels as headers, got: ' + JSON.stringify(beforeFilter));
  assert.deepStrictEqual(beforeFilter.rows, [['o1', '$10.00'], ['o2', '$20.00']], 'expected both category-A rows (channel filter not yet active), got: ' + JSON.stringify(beforeFilter));

  // Same mechanism testPublishFilterResetRecomputesKpiBackToUnfilteredValue
  // drives a filter change through: mutate activeFilters directly (what a
  // real <select>'s change handler does) and call the real applyFilters(),
  // which recomputes the table via buildAggregatedTablePayload/withDetail
  // and swaps it into TABLE_CLIENT_JS's closure via
  // __PUBLISH_TABLE_REPLACERS__ - the exact "hasFilters && hasDetail"
  // code path the whole-branch review flagged as untested.
  engine.context.activeFilters.channel = 'store';
  engine.context.applyFilters();

  engine.clickDetailToggle('A');
  var afterFilter = engine.modalContents();
  assert.deepStrictEqual(afterFilter.rows, [['o2', '$20.00']], 'expected only the channel=store row for group A after filtering - a stale snapshot would still show o1, got: ' + JSON.stringify(afterFilter));
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
  testPublishBoardRelatesToWithoutBoardLayoutRejected: testPublishBoardRelatesToWithoutBoardLayoutRejected,
  testPublishBoardRelatesToUnknownIdRejected: testPublishBoardRelatesToUnknownIdRejected,
  testPublishBoardRelatesToSelfRejected: testPublishBoardRelatesToSelfRejected,
  testPublishBoardRelatesToCycleRejected: testPublishBoardRelatesToCycleRejected,
  testPublishBoardDuplicateCrossTypeIdRejected: testPublishBoardDuplicateCrossTypeIdRejected,
  testPublishBoardValidRelationsProceedPastValidation: testPublishBoardValidRelationsProceedPastValidation,
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
  testPublishCsvExportButtonAndScriptEmitted: testPublishCsvExportButtonAndScriptEmitted,
  testPublishCsvExportNeutralizesFormulaInjection: testPublishCsvExportNeutralizesFormulaInjection,
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
  testPublishDetailAttachedToChartAndTablePayloadsWhenConfigured: testPublishDetailAttachedToChartAndTablePayloadsWhenConfigured,
  testPublishDetailRowsExcludeFieldsOutsideColumnsGroupByAndSeries: testPublishDetailRowsExcludeFieldsOutsideColumnsGroupByAndSeries,
  testPublishNoDetailFieldOnPayloadWithoutDetailConfigured: testPublishNoDetailFieldOnPayloadWithoutDetailConfigured,
  testPublishChartClientJsIncludesSelectionModule: testPublishChartClientJsIncludesSelectionModule,
  testPublishChartClientJsCoercesGroupAndSeriesValuesToString: testPublishChartClientJsCoercesGroupAndSeriesValuesToString,
  testPublishChartClientJsCallsApplyHighlightOnceOnLoad: testPublishChartClientJsCallsApplyHighlightOnceOnLoad,
  testPublishChartClientJsWiresBarClickOnlyWhenInteractive: testPublishChartClientJsWiresBarClickOnlyWhenInteractive,
  testPublishChartClientJsWiresLineAndPieClickOnLinkKey: testPublishChartClientJsWiresLineAndPieClickOnLinkKey,
  testPublishChartClientJsHandlesLinkToClickNavigation: testPublishChartClientJsHandlesLinkToClickNavigation,
  testPublishChartClientJsHandlesDetailClick: testPublishChartClientJsHandlesDetailClick,
  testPublishSeriesChartPassesSeriesValueThroughToDetailClick: testPublishSeriesChartPassesSeriesValueThroughToDetailClick,
  testPublishLinkToRequiresNode: testPublishLinkToRequiresNode,
  testPublishLinkToRequiresField: testPublishLinkToRequiresField,
  testPublishLinkToNewTabMustBeBoolean: testPublishLinkToNewTabMustBeBoolean,
  testPublishLinkToCannotCombineWithLinkKey: testPublishLinkToCannotCombineWithLinkKey,
  testPublishLinkToCannotCombineWithSeriesLinkKey: testPublishLinkToCannotCombineWithSeriesLinkKey,
  testPublishLinkToUnknownNodeRejected: testPublishLinkToUnknownNodeRejected,
  testPublishLinkToNonPublishNodeRejected: testPublishLinkToNonPublishNodeRejected,
  testPublishLinkToRequiresMatchingFilterFieldOnTarget: testPublishLinkToRequiresMatchingFilterFieldOnTarget,
  testPublishLinkToValidConfigProceedsPastValidation: testPublishLinkToValidConfigProceedsPastValidation,
  testPublishLinkToResolvesUrlAndEmbedsInChartPayload: testPublishLinkToResolvesUrlAndEmbedsInChartPayload,
  testPublishLinkToNewTabFalseRespected: testPublishLinkToNewTabFalseRespected,
  testPublishFilterClientJsAppliesMatchingQueryStringFilterOnLoad: testPublishFilterClientJsAppliesMatchingQueryStringFilterOnLoad,
  testPublishFilterClientJsIgnoresQueryStringValueNotInFilterOptions: testPublishFilterClientJsIgnoresQueryStringValueNotInFilterOptions,
  testPublishBlockSourceMustBeInDependsOn: testPublishBlockSourceMustBeInDependsOn,
  testPublishBlockSourceUnknownRefRejected: testPublishBlockSourceUnknownRefRejected,
  testPublishBlockSourceCannotCombineWithReactsTo: testPublishBlockSourceCannotCombineWithReactsTo,
  testPublishBlockSourceOverrideFetchesFromItsOwnRef: testPublishBlockSourceOverrideFetchesFromItsOwnRef,
  testPublishKpiDetailRejected: testPublishKpiDetailRejected,
  testPublishDetailRequiresNonEmptyColumns: testPublishDetailRequiresNonEmptyColumns,
  testPublishDetailColumnRequiresField: testPublishDetailColumnRequiresField,
  testPublishDetailColumnFormatMustBeKnownEnum: testPublishDetailColumnFormatMustBeKnownEnum,
  testPublishDetailOnRawTableRejected: testPublishDetailOnRawTableRejected,
  testPublishChartDetailCannotCombineWithLinkKey: testPublishChartDetailCannotCombineWithLinkKey,
  testPublishChartDetailCannotCombineWithLinkTo: testPublishChartDetailCannotCombineWithLinkTo,
  testPublishValidDetailProceedsPastValidation: testPublishValidDetailProceedsPastValidation,
  testPublishFilterRequiresFieldAndLabel: testPublishFilterRequiresFieldAndLabel,
  testPublishDuplicateFilterFieldRejected: testPublishDuplicateFilterFieldRejected,
  testPublishReactsToMustBeNonEmptyArray: testPublishReactsToMustBeNonEmptyArray,
  testPublishReactsToMustReferenceDeclaredFilter: testPublishReactsToMustReferenceDeclaredFilter,
  testPublishFiltersProceedPastValidation: testPublishFiltersProceedPastValidation,
  testPublishFilterPayloadAbsentWithoutFilters: testPublishFilterPayloadAbsentWithoutFilters,
  testPublishFilterPayloadIncludesRowsAndSortedDistinctOptions: testPublishFilterPayloadIncludesRowsAndSortedDistinctOptions,
  testPublishFilterableConfigOnlyIncludesReactsToBlocks: testPublishFilterableConfigOnlyIncludesReactsToBlocks,
  testPublishFilterableConfigExcludesNonReactiveKpiEvenWithFiltersConfigured: testPublishFilterableConfigExcludesNonReactiveKpiEvenWithFiltersConfigured,
  testPublishFiltersMarkupRenderedWhenConfigured: testPublishFiltersMarkupRenderedWhenConfigured,
  testPublishNoFiltersMarkupOrClientJsWithoutFilters: testPublishNoFiltersMarkupOrClientJsWithoutFilters,
  testPublishNoDetailScriptWithoutAnyDetailConfigured: testPublishNoDetailScriptWithoutAnyDetailConfigured,
  testPublishDetailScriptEmittedWithoutFilters: testPublishDetailScriptEmittedWithoutFilters,
  testPublishFilterClientJsIncludesReusedAggregationFunctionsVerbatim: testPublishFilterClientJsIncludesReusedAggregationFunctionsVerbatim,
  testPublishFilterClientJsResetsHighlightSelectionOnApply: testPublishFilterClientJsResetsHighlightSelectionOnApply,
  testPublishFilterClientJsWiresSelectChangeEvents: testPublishFilterClientJsWiresSelectChangeEvents,
  testPublishTableClientJsAlwaysExposesReplacerHook: testPublishTableClientJsAlwaysExposesReplacerHook,
  testPublishFilterResetRecomputesKpiBackToUnfilteredValue: testPublishFilterResetRecomputesKpiBackToUnfilteredValue,
  testPublishDetailToggleReflectsActiveFilterNotStaleSnapshot: testPublishDetailToggleReflectsActiveFilterNotStaleSnapshot,
  testPublishTableHeadersSortableAndSearchInputRendered: testPublishTableHeadersSortableAndSearchInputRendered,
  testPublishTableDetailToggleRenderedOnlyWhenConfigured: testPublishTableDetailToggleRenderedOnlyWhenConfigured,
  testPublishNoTableDetailToggleWithoutDetailConfigured: testPublishNoTableDetailToggleWithoutDetailConfigured,
  testPublishTableClientJsOpensDetailModalOnToggleClick: testPublishTableClientJsOpensDetailModalOnToggleClick,
  testPublishTableClientJsSortsCurrencyColumnNumerically: testPublishTableClientJsSortsCurrencyColumnNumerically,
  testPublishTableClientJsSearchNarrowsRowsAndCsvExport: testPublishTableClientJsSearchNarrowsRowsAndCsvExport
};
