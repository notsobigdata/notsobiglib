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

// testSelectByKind alone can't distinguish real filtering from a selector
// that's a no-op, since both fixtures happen to be kind 'move' - a
// regressed --select that ignored its argument entirely would still
// report length 2. Selecting by node name pins that down: only one of
// the two fixtures should come back, and it must be the one named.
function testSelectByName() {
  var ctx = harness.loadContext([fixture('two-move-nodes.js')]);
  var report = ctx.NotSoBigData.cli('list --select moveA');
  assert.strictEqual(report.nodes.length, 1, 'expected --select by node name to return exactly that node');
  assert.strictEqual(report.nodes[0].name, 'moveA', 'expected the selected node to be moveA');
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
  testSelectByName: testSelectByName,
  testDependencyOrder: testDependencyOrder
};
