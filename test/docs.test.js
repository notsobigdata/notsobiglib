// test/docs.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function loadPayload() {
  var ctx = harness.loadContext([fixture('docs-nodes.js')]);
  var payload = ctx.NotSoBigData.__test.buildDocsPayload(ctx.NotSoBigData.__test.discoverNodesForTest());
  // JSON round-trip works around a Node vm cross-realm quirk (see
  // test/discovery.test.js's own comment on the same issue): a plain
  // object/array built by a function running inside the sandboxed vm
  // context has a different Object/Array prototype than one built in
  // this test file, so assert.deepStrictEqual reports "same structure
  // but not reference-equal" below even when every field matches.
  return JSON.parse(JSON.stringify(payload));
}

function testDocsPayloadCarriesMoveConnectorTypes() {
  var payload = loadPayload();
  var rawOrders = payload.filter(function (n) { return n.name === 'rawOrders'; })[0];
  assert.ok(rawOrders, 'expected a rawOrders entry in the payload');
  assert.strictEqual(rawOrders.kind, 'move');
  assert.deepStrictEqual(rawOrders.detail, { sourceType: 'sheets', targetType: 'bigquery' });
}

function testDocsPayloadCompilesModelSqlAndCapturesMultipleDependsOn() {
  var payload = loadPayload();
  var orders = payload.filter(function (n) { return n.name === 'orders'; })[0];
  assert.ok(orders, 'expected an orders entry in the payload');
  assert.deepStrictEqual(orders.dependsOn.slice().sort(), ['rawCustomers', 'rawOrders']);
  assert.strictEqual(orders.detail.materialized, 'table');
  assert.ok(/join/.test(orders.detail.compiledSql), 'expected the compiled SQL to contain the join, got: ' + orders.detail.compiledSql);
  assert.deepStrictEqual(orders.detail.tests, [{ check: 'not_null', column: 'customer_id' }]);
}

// brokenModel's {{ ref("doesNotExist") }} fails at *discovery* time
// (model.js's expandModelNodes() already validates every ref() name -
// see src/cli.js:568's node.discoveryError check, and model.js:1881
// where expandModelNodes sets it), before docs ever sees a real config -
// the node's config is still the discovery-time placeholder { name: name },
// not something buildDocsDetail's model branch could safely read
// materialized/projectId/dataset/tests off. buildDocsPayload must check
// node.discoveryError first and short-circuit past the kind-specific
// branches entirely for that node.
function testDocsPayloadSurfacesDiscoveryErrorWithoutCrashing() {
  var payload = loadPayload();
  var broken = payload.filter(function (n) { return n.name === 'brokenModel'; })[0];
  assert.ok(broken, 'expected a brokenModel entry in the payload');
  assert.ok(/doesNotExist/.test(broken.detail.discoveryError), 'expected the ref-resolution discoveryError, got: ' + JSON.stringify(broken.detail));
  assert.ok(!broken.detail.compiledSql, 'expected no compiledSql for a node that never reached compileModel');
}

function testDocsPayloadCarriesPublishStructureOnly() {
  var payload = loadPayload();
  var dashboard = payload.filter(function (n) { return n.name === 'salesDashboard'; })[0];
  assert.ok(dashboard, 'expected a salesDashboard entry in the payload');
  assert.deepStrictEqual(dashboard.detail.charts, [{ id: 'by_month', title: 'Revenue by month', type: 'bar' }]);
  assert.deepStrictEqual(dashboard.detail.tables, []);
}

module.exports = {
  testDocsPayloadCarriesMoveConnectorTypes: testDocsPayloadCarriesMoveConnectorTypes,
  testDocsPayloadCompilesModelSqlAndCapturesMultipleDependsOn: testDocsPayloadCompilesModelSqlAndCapturesMultipleDependsOn,
  testDocsPayloadSurfacesDiscoveryErrorWithoutCrashing: testDocsPayloadSurfacesDiscoveryErrorWithoutCrashing,
  testDocsPayloadCarriesPublishStructureOnly: testDocsPayloadCarriesPublishStructureOnly
};
