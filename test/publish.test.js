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

module.exports = {
  testPublishNodeDiscoverableByKind: testPublishNodeDiscoverableByKind,
  testPublishSourceRefMustBeInDependsOn: testPublishSourceRefMustBeInDependsOn,
  testPublishKpiRequiresFieldUnlessCount: testPublishKpiRequiresFieldUnlessCount,
  testPublishRefMustResolveToBigQueryLocation: testPublishRefMustResolveToBigQueryLocation,
  testPublishValidRefProceedsPastValidation: testPublishValidRefProceedsPastValidation
};
