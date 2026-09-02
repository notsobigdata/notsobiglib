// test/fixtures/chained-nodes.js
var upstream = {
  kind: 'move',
  source: { type: 'custom', fn: function () { return []; } },
  target: { type: 'custom', fn: function () {} }
};

var downstream = {
  kind: 'move',
  dependsOn: ['upstream'],
  source: { type: 'custom', fn: function () { return []; } },
  target: { type: 'custom', fn: function () {} }
};
