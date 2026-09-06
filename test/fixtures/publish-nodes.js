// test/fixtures/publish-nodes.js
var moveWithBigQueryTarget = {
  kind: 'move',
  name: 'moveWithBigQueryTarget',
  source: { type: 'sheets', spreadsheetId: 'ignored', sheetName: 'Sheet1' },
  target: { type: 'bigquery', projectId: 'test-project', dataset: 'test_dataset', table: 'orders_flat' }
};

var moveWithSheetsTarget = {
  kind: 'move',
  name: 'moveWithSheetsTarget',
  source: { type: 'sheets', spreadsheetId: 'ignored', sheetName: 'Sheet1' },
  target: { type: 'sheets', spreadsheetId: 'ignored', sheetName: 'Out' }
};

var validPublish = {
  kind: 'publish',
  name: 'validPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'sales.html' },
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }]
};

var missingDependsOnPublish = {
  kind: 'publish',
  name: 'missingDependsOnPublish',
  dependsOn: [],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'sales.html' },
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }]
};

var badKpiPublish = {
  kind: 'publish',
  name: 'badKpiPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'sales.html' },
  kpis: [{ label: 'Revenue', agg: 'sum', format: 'currency' }]
};

var nonBigQueryRefPublish = {
  kind: 'publish',
  name: 'nonBigQueryRefPublish',
  dependsOn: ['moveWithSheetsTarget'],
  source: { type: 'ref', ref: 'moveWithSheetsTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'sales.html' },
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }]
};
