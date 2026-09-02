// test/discovery.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function testSelectByKind() {
  var ctx = harness.loadContext([fixture('two-move-nodes.js')]);
  var report = ctx.NotSoBigData.cli('list --select move');
  assert.strictEqual(report.nodes.length, 2, 'expected both move fixtures selected by kind');
}

function testDependencyOrder() {
  var ctx = harness.loadContext([fixture('chained-nodes.js')]);
  var report = ctx.NotSoBigData.cli('list');
  var names = report.nodes.map(function (node) { return node.name; });
  // report.nodes is an Array from the vm sandbox's own realm, not the
  // host's - deepStrictEqual treats same-shaped cross-realm arrays as
  // unequal, so round-trip through JSON to compare plain host values
  // instead of comparing the foreign-realm array directly.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(names)), ['upstream', 'downstream'], 'expected upstream before downstream');
}

module.exports = {
  testSelectByKind: testSelectByKind,
  testDependencyOrder: testDependencyOrder
};
