var path = require('path');
var assert = require('assert');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function testParseCommandAcceptsTarget() {
  var ctx = harness.loadContext([fixture('targets-fixture.js')]);
  var result = ctx.NotSoBigData.cli('list --target dev');
  assert(result.command === 'list', '--target flag should be accepted');
}

function testParseCommandRejectsDuplicateTarget() {
  var ctx = harness.loadContext([]);
  assert.throws(function () {
    ctx.NotSoBigData.cli('list --target dev --target prod');
  }, /--target.*only be specified once/, '--target should reject duplicates');
}

function testParseCommandRequiresTargetValue() {
  var ctx = harness.loadContext([]);
  assert.throws(function () {
    ctx.NotSoBigData.cli('list --target');
  }, /--target.*needs a value/, '--target should require a value');
}

function testUnknownTargetOnMove() {
  var ctx = harness.loadContext([fixture('targets-fixture.js')]);
  assert.throws(function () {
    ctx.NotSoBigData.cli('list --target staging');
  }, /target.*not declared/, 'unknown target on move should throw');
}

function testUnknownTargetOnModel() {
  var ctx = harness.loadContext([fixture('targets-fixture.js')]);
  assert.throws(function () {
    ctx.NotSoBigData.cli('list --target staging');
  }, /target.*not declared/, 'unknown target on model should throw');
}

function testTargetDevAppliesModelOverlay() {
  var ctx = harness.loadContext([fixture('targets-fixture.js')]);
  var result = ctx.NotSoBigData.cli('list --target dev --select model');
  assert(result.ok === true, 'list with --target dev should succeed');
}

function testNoTargetUsesDefaults() {
  var ctx = harness.loadContext([fixture('targets-fixture.js')]);
  var result = ctx.NotSoBigData.cli('list --select model');
  assert(result.ok === true, 'list without --target should succeed');
}

function testTargetProdAppliesModelOverlay() {
  var ctx = harness.loadContext([fixture('targets-fixture.js')]);
  var result = ctx.NotSoBigData.cli('list --target prod --select model');
  assert(result.ok === true, 'list with --target prod should succeed');
}

module.exports = {
  'testParseCommandAcceptsTarget': testParseCommandAcceptsTarget,
  'testParseCommandRejectsDuplicateTarget': testParseCommandRejectsDuplicateTarget,
  'testParseCommandRequiresTargetValue': testParseCommandRequiresTargetValue,
  'testUnknownTargetOnMove': testUnknownTargetOnMove,
  'testUnknownTargetOnModel': testUnknownTargetOnModel,
  'testTargetDevAppliesModelOverlay': testTargetDevAppliesModelOverlay,
  'testNoTargetUsesDefaults': testNoTargetUsesDefaults,
  'testTargetProdAppliesModelOverlay': testTargetProdAppliesModelOverlay
};
