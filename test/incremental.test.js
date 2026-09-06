// test/incremental.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

// --full-refresh should be rejected on 'list' command
function testFullRefreshRejectedOnList() {
  var ctx = harness.loadContext([fixture('model-registry.js')]);
  assert.throws(
    function () { ctx.NotSoBigData.cli('list --full-refresh'); },
    /--full-refresh.*only valid for.*run.*and.*compile/i,
    'expected --full-refresh to be rejected on list command'
  );
}

// --full-refresh should be rejected on 'hello' command
function testFullRefreshRejectedOnHello() {
  var ctx = harness.loadContext([fixture('model-registry.js')]);
  assert.throws(
    function () { ctx.NotSoBigData.cli('hello --full-refresh'); },
    /--full-refresh.*only valid for.*run.*and.*compile/i,
    'expected --full-refresh to be rejected on hello command'
  );
}

// --full-refresh should be rejected when given a value
function testFullRefreshRejectsValue() {
  var ctx = harness.loadContext([fixture('model-registry.js')]);
  assert.throws(
    function () { ctx.NotSoBigData.cli('run --full-refresh=true'); },
    /--full-refresh.*does not take a value/i,
    'expected --full-refresh to reject value'
  );
}

// parseCommand should accept --full-refresh on compile (no BigQuery needed)
function testCompileAcceptsFullRefresh() {
  var ctx = harness.loadContext([fixture('model-registry.js')]);
  // compile is dry-run and doesn't touch BigQuery, so this should work
  var report = ctx.NotSoBigData.cli('compile --full-refresh --select stg_orders');
  assert.ok(report, 'expected compile --full-refresh to parse successfully');
}

module.exports = {
  testFullRefreshRejectedOnList: testFullRefreshRejectedOnList,
  testFullRefreshRejectedOnHello: testFullRefreshRejectedOnHello,
  testFullRefreshRejectsValue: testFullRefreshRejectsValue,
  testCompileAcceptsFullRefresh: testCompileAcceptsFullRefresh
};
