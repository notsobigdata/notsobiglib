// test/compile.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function testSetMacroSubstitutesIntoCompiledSql() {
  var ctx = harness.loadContext([fixture('model-registry.js')]);
  var report = ctx.NotSoBigData.cli('compile');
  var node = report.nodes[0];
  assert.strictEqual(node.status, 'planned', 'expected a compile-mode node to report status "planned"');
  assert.ok(
    node.compiledSql.indexOf('select * from `orders`') !== -1,
    'expected {% set %} substitution in compiled SQL, got: ' + node.compiledSql
  );
}

module.exports = {
  testSetMacroSubstitutesIntoCompiledSql: testSetMacroSubstitutesIntoCompiledSql
};
