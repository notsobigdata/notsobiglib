// test/metric-card.test.js
var assert = require('assert');
var harness = require('./harness');

function api() {
  return harness.loadContext([]).NotSoBigData.__test;
}

// JSON round-trip works around a Node vm cross-realm quirk (see
// test/board-layout.test.js and test/discovery.test.js's comments on the
// same issue): the object computeMetricCardData returns is built inside
// the sandboxed vm context, so assert.deepStrictEqual reports "same
// structure but not reference-equal" against a host-realm literal like
// `[]` even when every field matches.
function computeMetricCardData(blockType, block) {
  return JSON.parse(JSON.stringify(api().computeMetricCardData(blockType, block)));
}

function testMetricCardChartWithoutSeriesSumsGroupTotals() {
  var chart = { id: 'by_category', type: 'bar', data: [
    { groupValue: 'A', total: 40 },
    { groupValue: 'B', total: 60 }
  ] };
  var result = computeMetricCardData('chart', chart);
  assert.strictEqual(result.headline, 100);
  assert.deepStrictEqual(result.points, [40, 60]);
}

function testMetricCardChartWithSeriesSumsAcrossSeriesKeys() {
  var chart = { id: 'by_cat_channel', type: 'bar', series: 'channel', seriesKeys: ['online', 'retail'], data: [
    { groupValue: 'A', values: { online: 30, retail: 20 } },
    { groupValue: 'B', values: { online: 10, retail: 40 } }
  ] };
  var result = computeMetricCardData('chart', chart);
  assert.strictEqual(result.headline, 100);
  assert.deepStrictEqual(result.points, [50, 50]);
}

function testMetricCardAggregatedTableSumsFirstMetricColumn() {
  var table = { id: 'by_category_table', mode: 'aggregated', columns: [
    { key: 'category_name', label: 'category_name', format: 'string' },
    { key: 'Revenue', label: 'Revenue', format: 'currency' },
    { key: 'Orders', label: 'Orders', format: 'integer' }
  ], rows: [
    ['A', '$40.00', '4'],
    ['B', '$60.00', '6']
  ] };
  var result = computeMetricCardData('table', table);
  assert.strictEqual(result.headline, 100);
  assert.deepStrictEqual(result.points, [40, 60]);
}

function testMetricCardRawTableCountsRows() {
  var table = { id: 'recent_orders', mode: 'raw', columns: [{ key: 'order_id', label: 'order_id', format: 'string' }], rows: [
    ['ORD-1'], ['ORD-2'], ['ORD-3']
  ] };
  var result = computeMetricCardData('table', table);
  assert.strictEqual(result.headline, 3);
  assert.deepStrictEqual(result.points, []);
}

module.exports = {
  testMetricCardChartWithoutSeriesSumsGroupTotals: testMetricCardChartWithoutSeriesSumsGroupTotals,
  testMetricCardChartWithSeriesSumsAcrossSeriesKeys: testMetricCardChartWithSeriesSumsAcrossSeriesKeys,
  testMetricCardAggregatedTableSumsFirstMetricColumn: testMetricCardAggregatedTableSumsFirstMetricColumn,
  testMetricCardRawTableCountsRows: testMetricCardRawTableCountsRows
};
