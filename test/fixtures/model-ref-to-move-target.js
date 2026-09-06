// test/fixtures/model-ref-to-move-target.js
var ordersRaw = {
  kind: 'move',
  name: 'ordersRaw',
  source: { type: 'sheets', spreadsheetId: 'ignored', sheetName: 'Sheet1' },
  target: { type: 'bigquery', projectId: 'test-project', dataset: 'test_dataset', table: 'orders_raw' }
};

var notsobigdataModels = {
  projectId: 'test-project',
  dataset: 'test_dataset',
  materialized: 'view',
  models: {
    orders_summary: {}
  }
};
