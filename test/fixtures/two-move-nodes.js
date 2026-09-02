// test/fixtures/two-move-nodes.js
var moveA = {
  kind: 'move',
  source: { type: 'custom', fn: function () { return []; } },
  target: { type: 'custom', fn: function () {} }
};

var moveB = {
  kind: 'move',
  source: { type: 'custom', fn: function () { return []; } },
  target: { type: 'custom', fn: function () {} }
};
