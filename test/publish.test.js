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

function testPublishChartTypeOtherThanBarRejected() {
  var result = runOne('badChartTypePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/only "bar" is supported/.test(result.error), 'expected a chart-type error, got: ' + result.error);
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

module.exports = {
  testPublishNodeDiscoverableByKind: testPublishNodeDiscoverableByKind,
  testPublishSourceRefMustBeInDependsOn: testPublishSourceRefMustBeInDependsOn,
  testPublishKpiRequiresFieldUnlessCount: testPublishKpiRequiresFieldUnlessCount,
  testPublishRefMustResolveToBigQueryLocation: testPublishRefMustResolveToBigQueryLocation,
  testPublishValidRefProceedsPastValidation: testPublishValidRefProceedsPastValidation,
  testPublishChartTypeOtherThanBarRejected: testPublishChartTypeOtherThanBarRejected,
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
  testPublishValidTablesProceedPastValidation: testPublishValidTablesProceedPastValidation
};
