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

// Has a chart (validPublish doesn't) so a shimmed BigQuery row can carry a
// malicious groupValue through buildReportPayload into renderReportHtml's
// embedded JSON payload - see publish.test.js's script-close escaping test.
var xssPublish = {
  kind: 'publish',
  name: 'xssPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'xss.html' },
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }],
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }]
};

// One kpi per agg/format combination plus a multi-group chart, exercising
// buildReportPayload's real math - see publish.test.js's
// testPublishAggregatesKpisAndChartsCorrectly.
var aggregationPublish = {
  kind: 'publish',
  name: 'aggregationPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'aggregation.html' },
  kpis: [
    { label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' },
    { label: 'Rows', agg: 'count', format: 'integer' },
    { label: 'Distinct orders', agg: 'count_distinct', field: 'order_id', format: 'integer' },
    { label: 'Avg revenue', agg: 'avg', field: 'revenue', format: 'decimal' }
  ],
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }]
};

var badChartTypePublish = {
  kind: 'publish',
  name: 'badChartTypePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-chart-type.html' },
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }],
  charts: [{ id: 'by_category', type: 'line', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }]
};

var badLayoutPublish = {
  kind: 'publish',
  name: 'badLayoutPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-layout.html' },
  layout: { type: 'board' },
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }]
};
