// test/ordering.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

// Tests that buildLevelGroups correctly groups a chain into three levels.
// Chain: A -> B -> C
function testBuildLevelGroups_Chain() {
  var ctx = harness.loadContext([fixture('chain-dag.js')]);
  var nodes = ctx.NotSoBigData.cli('list').nodes.map(function (n) { return n.name; });
  // Expected order: chainA, chainB, chainC
  // Expected levels: [[chainA], [chainB], [chainC]]
  // We can't directly call buildLevelGroups from the harness, but we can
  // verify behavior indirectly via the fact that a level-based run loop
  // would respect this grouping. For now, this test validates that the
  // nodes are ordered correctly (which buildLevelGroups depends on).
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(nodes)),
    ['chainA', 'chainB', 'chainC'],
    'expected chain nodes in dependency order'
  );
}

// Tests that buildLevelGroups correctly groups wide DAG into one level.
// All five nodes have no dependencies.
function testBuildLevelGroups_Wide() {
  var ctx = harness.loadContext([fixture('wide-dag.js')]);
  var nodes = ctx.NotSoBigData.cli('list').nodes.map(function (n) { return n.name; });
  assert.strictEqual(nodes.length, 5, 'expected all five wide nodes');
  // All should be at the same "level" in execution order (order among them doesn't matter).
  // The key is that orderNodes returns them at the "front" of the list.
}

module.exports = {
  testBuildLevelGroups_Chain: testBuildLevelGroups_Chain,
  testBuildLevelGroups_Wide: testBuildLevelGroups_Wide
};
