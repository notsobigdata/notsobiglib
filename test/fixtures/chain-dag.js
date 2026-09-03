// A → B → C: three levels, one node per level
var chainA = { kind: 'move', name: 'chainA', dependsOn: [] };
var chainB = { kind: 'move', name: 'chainB', dependsOn: ['chainA'] };
var chainC = { kind: 'move', name: 'chainC', dependsOn: ['chainB'] };
