// test/board-layout.test.js
var assert = require('assert');
var harness = require('./harness');

function positionsFor(direction) {
  var ctx = harness.loadContext([]);
  var treeNodes = [
    { id: 'a', x: 0, y: 100 },
    { id: 'b', x: 150, y: 100 },
    { id: 'c', x: 75, y: 200 }
  ];
  var result = ctx.NotSoBigData.__test.computeBoardPositions(treeNodes, direction, 220, 140);
  // JSON round-trip works around a Node vm cross-realm quirk (see
  // test/discovery.test.js and test/docs.test.js's comments on the same
  // issue): a plain object built by a function running inside the
  // sandboxed vm context has a different Object prototype than one built
  // in this test file, so assert.deepStrictEqual reports "same structure
  // but not reference-equal" below even when every field matches.
  return JSON.parse(JSON.stringify(result));
}

function testComputeBoardPositionsTopBottomMatchesTodaysDefaultOrientation() {
  var result = positionsFor('top-bottom');
  assert.deepStrictEqual(result.positions, {
    a: { left: 0, top: 100 },
    b: { left: 150, top: 100 },
    c: { left: 75, top: 200 }
  });
  assert.deepStrictEqual(result.bounds, { width: 370, height: 340 });
  assert.deepStrictEqual(result.anchor, { from: 'bottom', to: 'top' });
}

function testComputeBoardPositionsBottomTopReversesDepthOnly() {
  var result = positionsFor('bottom-top');
  assert.deepStrictEqual(result.positions, {
    a: { left: 0, top: 100 },
    b: { left: 150, top: 100 },
    c: { left: 75, top: 0 }
  });
  assert.deepStrictEqual(result.bounds, { width: 370, height: 240 });
  assert.deepStrictEqual(result.anchor, { from: 'top', to: 'bottom' });
}

function testComputeBoardPositionsLeftRightSwapsSpreadAndDepthOntoTopAndLeft() {
  var result = positionsFor('left-right');
  assert.deepStrictEqual(result.positions, {
    a: { left: 100, top: 0 },
    b: { left: 100, top: 150 },
    c: { left: 200, top: 75 }
  });
  assert.deepStrictEqual(result.bounds, { width: 420, height: 290 });
  assert.deepStrictEqual(result.anchor, { from: 'right', to: 'left' });
}

function testComputeBoardPositionsRightLeftSwapsAndReverses() {
  var result = positionsFor('right-left');
  assert.deepStrictEqual(result.positions, {
    a: { left: 100, top: 0 },
    b: { left: 100, top: 150 },
    c: { left: 0, top: 75 }
  });
  assert.deepStrictEqual(result.bounds, { width: 320, height: 290 });
  assert.deepStrictEqual(result.anchor, { from: 'left', to: 'right' });
}

module.exports = {
  testComputeBoardPositionsTopBottomMatchesTodaysDefaultOrientation: testComputeBoardPositionsTopBottomMatchesTodaysDefaultOrientation,
  testComputeBoardPositionsBottomTopReversesDepthOnly: testComputeBoardPositionsBottomTopReversesDepthOnly,
  testComputeBoardPositionsLeftRightSwapsSpreadAndDepthOntoTopAndLeft: testComputeBoardPositionsLeftRightSwapsSpreadAndDepthOntoTopAndLeft,
  testComputeBoardPositionsRightLeftSwapsAndReverses: testComputeBoardPositionsRightLeftSwapsAndReverses
};
