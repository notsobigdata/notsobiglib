// test/ref-resolution.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function testRefResolvesToMoveBigQueryTarget() {
  var ctx = harness.loadContext([fixture('model-ref-to-move-target.js')]);
  var report = ctx.NotSoBigData.cli('compile --select orders_summary');
  var node = report.nodes[0];
  assert.strictEqual(node.status, 'planned', 'expected compile to succeed, got: ' + JSON.stringify(node));
  assert.ok(
    node.compiledSql.indexOf('select * from `test-project.test_dataset.orders_raw`') !== -1,
    'expected {{ ref() }} to a bigquery-target move node to resolve to its qualified relation, got: ' + node.compiledSql
  );
}

module.exports = {
  testRefResolvesToMoveBigQueryTarget: testRefResolvesToMoveBigQueryTarget
};
