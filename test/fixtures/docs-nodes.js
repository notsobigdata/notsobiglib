// test/fixtures/docs-nodes.js
var rawOrders = {
  kind: 'move',
  source: { type: 'sheets', spreadsheetId: 'sheet-1', sheetName: 'orders' },
  target: { type: 'bigquery', projectId: 'proj', dataset: 'raw', table: 'orders' }
};

var rawCustomers = {
  kind: 'move',
  source: { type: 'drive', fileId: 'file-1' },
  target: { type: 'bigquery', projectId: 'proj', dataset: 'raw', table: 'customers' }
};

var notsobigdataModels = {
  projectId: 'proj',
  dataset: 'analytics',
  models: {
    orders: {
      sqlFile: 'docs-orders.html',
      materialized: 'table',
      tests: [{ check: 'not_null', column: 'customer_id' }]
    },
    brokenModel: {
      sqlFile: 'docs-broken-model.html'
    }
  }
};

var salesDashboard = {
  kind: 'publish',
  dependsOn: ['orders'],
  source: { type: 'ref', ref: 'orders' },
  target: { type: 'drive', folderId: 'folder-1', fileName: 'sales.html' },
  charts: [{ id: 'by_month', title: 'Revenue by month', type: 'bar', groupBy: 'month', metric: { agg: 'sum', field: 'revenue' } }],
  tables: []
};
