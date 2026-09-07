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
  charts: [{ id: 'by_category', type: 'scatter', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }]
};

var chartSeriesOnNonBarPublish = {
  kind: 'publish',
  name: 'chartSeriesOnNonBarPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'chart-series-on-non-bar.html' },
  charts: [{ id: 'trend', type: 'line', title: 'Trend', groupBy: 'day', series: 'channel', metric: { agg: 'sum', field: 'revenue' } }]
};

var chartDonutOnNonPiePublish = {
  kind: 'publish',
  name: 'chartDonutOnNonPiePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'chart-donut-on-non-pie.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', donut: true, metric: { agg: 'sum', field: 'revenue' } }]
};

var chartBadStackingPublish = {
  kind: 'publish',
  name: 'chartBadStackingPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'chart-bad-stacking.html' },
  charts: [{ id: 'by_category_channel', type: 'bar', title: 'By category/channel', groupBy: 'category', series: 'channel', stacking: 'overlapping', metric: { agg: 'sum', field: 'revenue' } }]
};

// Proves the widened enum (bar/line/pie) plus series+stacking and donut
// all pass validation - fails only at the un-shimmed BigQuery call, same
// proof pattern as testPublishValidRefProceedsPastValidation.
var chartsV2Publish = {
  kind: 'publish',
  name: 'chartsV2Publish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'charts-v2.html' },
  charts: [
    { id: 'trend', type: 'line', title: 'Trend', groupBy: 'day', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'share', type: 'pie', title: 'Share', groupBy: 'category', donut: true, metric: { agg: 'sum', field: 'revenue' } },
    { id: 'by_category_channel', type: 'bar', title: 'By category/channel', groupBy: 'category', series: 'channel', stacking: 'stacked', metric: { agg: 'sum', field: 'revenue' } }
  ]
};

var lineChartPublish = {
  kind: 'publish',
  name: 'lineChartPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'line-chart.html' },
  charts: [{ id: 'trend', type: 'line', title: 'Trend', groupBy: 'day', metric: { agg: 'sum', field: 'revenue' } }]
};

var lineChartDatePublish = {
  kind: 'publish',
  name: 'lineChartDatePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'line-chart-date.html' },
  charts: [{ id: 'trend', type: 'line', title: 'Trend', groupBy: 'order_date', metric: { agg: 'sum', field: 'revenue' } }]
};

var seriesChartPublish = {
  kind: 'publish',
  name: 'seriesChartPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'series-chart.html' },
  charts: [{ id: 'by_category_channel', type: 'bar', title: 'By category/channel', groupBy: 'category', series: 'channel', stacking: 'stacked', metric: { agg: 'sum', field: 'revenue' } }]
};

// Regression test for cell-key collision: values with spaces must not
// cross-contaminate. E.g. groupKey='New York', seriesKey='Paid Search'
// vs groupKey='New', seriesKey='York Paid Search' would both produce
// cellKey='New York Paid Search' with string concatenation - a silent
// data corruption. Nested maps prevent collision.
var seriesChartWithSpacesPublish = {
  kind: 'publish',
  name: 'seriesChartWithSpacesPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'series-chart-spaces.html' },
  charts: [{ id: 'by_location_channel', type: 'bar', title: 'By location/channel', groupBy: 'location', series: 'channel_type', stacking: 'grouped', metric: { agg: 'sum', field: 'revenue' } }]
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

// One raw table (columns: order_id, revenue) and one aggregated table
// (groupBy: category, metrics: revenue sum + distinct orders), pageSize 2
// on the raw table so Task 3's pagination tests have >1 page to work
// with. Reused across Task 1 (validation pass-through), Task 2 (payload
// correctness), and Task 3 (render/pagination) - one fixture per concern
// this feature actually needs, not a fresh one per test.
var tablesPublish = {
  kind: 'publish',
  name: 'tablesPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'tables.html' },
  tables: [
    {
      id: 'recent_orders', title: 'Recent orders', mode: 'raw', pageSize: 2,
      columns: [
        { field: 'order_id', label: 'Order' },
        { field: 'revenue', label: 'Revenue', format: 'currency' }
      ]
    },
    {
      id: 'by_category', title: 'Revenue by category', mode: 'aggregated',
      groupBy: 'category',
      metrics: [
        { label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' },
        { label: 'Orders', agg: 'count_distinct', field: 'order_id', format: 'integer' }
      ]
    }
  ]
};

var badTableModePublish = {
  kind: 'publish',
  name: 'badTableModePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-mode.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'pivot', columns: [{ field: 'revenue' }] }]
};

var badTableRawColumnsPublish = {
  kind: 'publish',
  name: 'badTableRawColumnsPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-raw-columns.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'raw', columns: [] }]
};

var badTableRawColumnFieldPublish = {
  kind: 'publish',
  name: 'badTableRawColumnFieldPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-raw-column-field.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'raw', columns: [{ label: 'No field' }] }]
};

var badTableAggregatedGroupByPublish = {
  kind: 'publish',
  name: 'badTableAggregatedGroupByPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-groupby.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'aggregated', metrics: [{ label: 'Revenue', agg: 'sum', field: 'revenue' }] }]
};

var badTableAggregatedMetricsPublish = {
  kind: 'publish',
  name: 'badTableAggregatedMetricsPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-metrics.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'aggregated', groupBy: 'category', metrics: [] }]
};

var badTableMetricFieldPublish = {
  kind: 'publish',
  name: 'badTableMetricFieldPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-metric-field.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'aggregated', groupBy: 'category', metrics: [{ label: 'Revenue', agg: 'sum' }] }]
};

var badTableFormatPublish = {
  kind: 'publish',
  name: 'badTableFormatPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-format.html' },
  tables: [{ id: 'bad', title: 'Bad', mode: 'raw', columns: [{ field: 'revenue', format: 'percent' }] }]
};

// Two tables sharing an id, each otherwise a valid 'raw' table - proves
// the duplicate-id check fires before any other per-table validation
// would mask it (see publish.test.js's
// testPublishDuplicateTableIdRejected and the whole-branch review
// finding it fixes: the client-side pager resolves a table by
// `payload.tables.filter(t => t.id === tableId)[0]`, so a duplicate id
// silently mis-binds pagination with no error, rather than throwing at
// config time).
var duplicateTableIdPublish = {
  kind: 'publish',
  name: 'duplicateTableIdPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'dup-table-id.html' },
  tables: [
    { id: 'dup', title: 'First', mode: 'raw', columns: [{ field: 'revenue' }] },
    { id: 'dup', title: 'Second', mode: 'raw', columns: [{ field: 'category' }] }
  ]
};

// Two charts sharing an id - same rationale as duplicateTableIdPublish
// above: CHART_CLIENT_JS's DOMContentLoaded handler resolves a chart by
// `payload.charts.filter(c => c.id === chartId)[0]`, so a duplicate chart
// id would silently mis-bind a mount point to the wrong chart's data with
// no error, rather than throwing at config time. Both entries here are
// otherwise individually valid bar charts.
var duplicateChartIdPublish = {
  kind: 'publish',
  name: 'duplicateChartIdPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'dup-chart-id.html' },
  charts: [
    { id: 'dup', type: 'bar', title: 'First', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'dup', type: 'bar', title: 'Second', groupBy: 'channel', metric: { agg: 'sum', field: 'revenue' } }
  ]
};

// No "type" key at all - proves chart.type's default-to-'bar' fallback
// (`var chartType = chart.type || 'bar';`) both passes validation and
// produces the plain {groupValue, total} payload shape, not the series
// {groupValue, values} shape - this default path had zero test coverage
// before the whole-branch review caught it.
var chartTypeOmittedPublish = {
  kind: 'publish',
  name: 'chartTypeOmittedPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'chart-type-omitted.html' },
  charts: [{ id: 'by_category', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }]
};

// seriesLinkKey requires both type: 'bar' AND series to be set - a plain
// bar chart (no series) with seriesLinkKey declared is the representative
// misuse case, same "one representative fixture, not one per possible
// misuse" precedent chartSeriesOnNonBarPublish already set.
var chartSeriesLinkKeyWithoutSeriesPublish = {
  kind: 'publish',
  name: 'chartSeriesLinkKeyWithoutSeriesPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'chart-series-link-key-without-series.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, seriesLinkKey: 'channel' }]
};

// Four charts matching the design spec's §2 worked example: three linked
// on 'category' (plain bar, pie, and a stacked bar also linking its
// series on 'channel'), one ('trend') left deliberately unlinked as the
// "never reacts, never triggers" control. Proves the widened schema
// passes validation (fails only at the un-shimmed BigQuery call, same
// proof pattern as chartsV2Publish) and backs Task 1's payload-passthrough
// test plus Task 2/3's render tests.
var linkKeyChartsPublish = {
  kind: 'publish',
  name: 'linkKeyChartsPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-key-charts.html' },
  charts: [
    { id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, linkKey: 'category' },
    { id: 'share', type: 'pie', title: 'Share', groupBy: 'category', donut: true, metric: { agg: 'sum', field: 'revenue' }, linkKey: 'category' },
    { id: 'by_category_channel', type: 'bar', title: 'By category/channel', groupBy: 'category', series: 'channel', stacking: 'stacked', metric: { agg: 'sum', field: 'revenue' }, linkKey: 'category', seriesLinkKey: 'channel' },
    { id: 'trend', type: 'line', title: 'Trend', groupBy: 'day', metric: { agg: 'sum', field: 'revenue' } }
  ]
};

var badFilterMissingLabelPublish = {
  kind: 'publish',
  name: 'badFilterMissingLabelPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'bad-filter-missing-label.html' },
  filters: [{ field: 'category' }]
};

var duplicateFilterFieldPublish = {
  kind: 'publish',
  name: 'duplicateFilterFieldPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'dup-filter-field.html' },
  filters: [
    { field: 'category', label: 'Category' },
    { field: 'category', label: 'Category again' }
  ]
};

var reactsToUndeclaredFilterPublish = {
  kind: 'publish',
  name: 'reactsToUndeclaredFilterPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'reacts-to-undeclared.html' },
  filters: [{ field: 'category', label: 'Category' }],
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency', reactsTo: ['channel'] }]
};

var emptyReactsToPublish = {
  kind: 'publish',
  name: 'emptyReactsToPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'empty-reacts-to.html' },
  filters: [{ field: 'category', label: 'Category' }],
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency', reactsTo: [] }]
};

// filters[] with two fields; a kpi, a chart, and a table each opting into
// a different subset via reactsTo. "Rows" (a plain count kpi) deliberately
// has no reactsTo at all, to prove an opted-out block is simply absent
// from payload.filterableConfig (Task 2) and never touched by a filter
// change (Task 3). Reused across Task 1 (validation), Task 2 (payload
// shape), and Task 3 (markup/client-JS) - one fixture per concern this
// feature actually needs, matching tablesPublish's own precedent.
var filtersPublish = {
  kind: 'publish',
  name: 'filtersPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'filters.html' },
  filters: [
    { field: 'category', label: 'Category' },
    { field: 'channel', label: 'Channel' }
  ],
  kpis: [
    { label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency', reactsTo: ['category', 'channel'] },
    { label: 'Rows', agg: 'count', format: 'integer' }
  ],
  charts: [
    { id: 'trend', type: 'line', title: 'Trend', groupBy: 'day', metric: { agg: 'sum', field: 'revenue' }, reactsTo: ['category'] }
  ],
  tables: [
    { id: 'orders', title: 'Orders', mode: 'raw', columns: [{ field: 'revenue' }], reactsTo: ['category', 'channel'] }
  ]
};

// linkTo's destination side: a filters[] entry matching what
// linkToSourcePublish below sends on click - the one requirement
// validateLinkToTarget checks. No upsertByName here on purpose: linkTo
// resolves to this node's plain target.fileName, not a live Drive lookup,
// so nothing about the destination's Drive-write behavior matters to it.
var linkToTargetPublish = {
  kind: 'publish',
  name: 'linkToTargetPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'category-detail.html' },
  filters: [{ field: 'category', label: 'Category' }],
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }]
};

var linkToSourcePublish = {
  kind: 'publish',
  name: 'linkToSourcePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'category-overview.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'linkToTargetPublish', field: 'category' } }]
};

var linkToSourceNewTabFalsePublish = {
  kind: 'publish',
  name: 'linkToSourceNewTabFalsePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'category-overview-same-tab.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'linkToTargetPublish', field: 'category', newTab: false } }]
};

var linkToMissingNodePublish = {
  kind: 'publish',
  name: 'linkToMissingNodePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-to-missing-node.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { field: 'category' } }]
};

var linkToMissingFieldPublish = {
  kind: 'publish',
  name: 'linkToMissingFieldPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-to-missing-field.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'linkToTargetPublish' } }]
};

var linkToBadNewTabPublish = {
  kind: 'publish',
  name: 'linkToBadNewTabPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-to-bad-new-tab.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'linkToTargetPublish', field: 'category', newTab: 'yes' } }]
};

var linkToWithLinkKeyPublish = {
  kind: 'publish',
  name: 'linkToWithLinkKeyPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-to-with-link-key.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkKey: 'category', linkTo: { node: 'linkToTargetPublish', field: 'category' } }]
};

var linkToWithSeriesLinkKeyPublish = {
  kind: 'publish',
  name: 'linkToWithSeriesLinkKeyPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-to-with-series-link-key.html' },
  charts: [{ id: 'by_category_channel', type: 'bar', title: 'By category/channel', groupBy: 'category', series: 'channel', stacking: 'stacked', metric: { agg: 'sum', field: 'revenue' },
    seriesLinkKey: 'channel', linkTo: { node: 'linkToTargetPublish', field: 'category' } }]
};

var linkToUnknownNodePublish = {
  kind: 'publish',
  name: 'linkToUnknownNodePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-to-unknown-node.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'nonExistentNodeXYZ', field: 'category' } }]
};

// References moveWithBigQueryTarget, a real declared node but kind
// "move", not "publish" - proves validateLinkToTarget checks the kind,
// not just presence.
var linkToNonPublishNodePublish = {
  kind: 'publish',
  name: 'linkToNonPublishNodePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-to-non-publish-node.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'moveWithBigQueryTarget', field: 'category' } }]
};

var linkToTargetNoMatchingFilterPublish = {
  kind: 'publish',
  name: 'linkToTargetNoMatchingFilterPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-to-target-no-matching-filter.html', upsertByName: true },
  filters: [{ field: 'channel', label: 'Channel' }],
  kpis: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }]
};

var linkToSourceNoMatchingFilterPublish = {
  kind: 'publish',
  name: 'linkToSourceNoMatchingFilterPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'link-to-source-no-matching-filter.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'linkToTargetNoMatchingFilterPublish', field: 'category' } }]
};

// Second bigquery-target move node, distinct table name from
// moveWithBigQueryTarget - lets a block-source-override test's shim
// return different rows per table and prove the override actually
// reached that block, not just that validation let it through.
var moveWithBigQuerySecondTarget = {
  kind: 'move',
  name: 'moveWithBigQuerySecondTarget',
  source: { type: 'sheets', spreadsheetId: 'ignored', sheetName: 'Sheet1' },
  target: { type: 'bigquery', projectId: 'test-project', dataset: 'test_dataset', table: 'orders_secondary' }
};

var blockSourceOverridePublish = {
  kind: 'publish',
  name: 'blockSourceOverridePublish',
  dependsOn: ['moveWithBigQueryTarget', 'moveWithBigQuerySecondTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'block-source-override.html' },
  kpis: [
    { label: 'Default revenue', agg: 'sum', field: 'revenue', format: 'currency' },
    { label: 'Secondary revenue', agg: 'sum', field: 'revenue', format: 'currency', source: { type: 'ref', ref: 'moveWithBigQuerySecondTarget' } }
  ],
  charts: [
    { id: 'by_category_secondary', type: 'bar', title: 'By category (secondary)', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
      source: { type: 'ref', ref: 'moveWithBigQuerySecondTarget' } }
  ],
  tables: [
    { id: 'secondary_raw', title: 'Secondary rows', mode: 'raw', columns: [{ field: 'category' }, { field: 'revenue', format: 'currency' }],
      source: { type: 'ref', ref: 'moveWithBigQuerySecondTarget' } }
  ]
};

var blockSourceMissingDependsOnPublish = {
  kind: 'publish',
  name: 'blockSourceMissingDependsOnPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'block-source-missing-dependson.html' },
  kpis: [{ label: 'Secondary revenue', agg: 'sum', field: 'revenue', format: 'currency', source: { type: 'ref', ref: 'moveWithBigQuerySecondTarget' } }]
};

var blockSourceUnknownRefPublish = {
  kind: 'publish',
  name: 'blockSourceUnknownRefPublish',
  dependsOn: ['moveWithBigQueryTarget', 'moveWithSheetsTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'block-source-unknown-ref.html' },
  kpis: [{ label: 'Secondary revenue', agg: 'sum', field: 'revenue', format: 'currency', source: { type: 'ref', ref: 'moveWithSheetsTarget' } }]
};

var blockSourceWithReactsToPublish = {
  kind: 'publish',
  name: 'blockSourceWithReactsToPublish',
  dependsOn: ['moveWithBigQueryTarget', 'moveWithBigQuerySecondTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'block-source-with-reacts-to.html' },
  filters: [{ field: 'channel', label: 'Channel' }],
  kpis: [{ label: 'Secondary revenue', agg: 'sum', field: 'revenue', format: 'currency', reactsTo: ['channel'],
    source: { type: 'ref', ref: 'moveWithBigQuerySecondTarget' } }]
};

var kpiWithDetailPublish = {
  kind: 'publish',
  name: 'kpiWithDetailPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'kpi-detail.html' },
  kpis: [{ label: 'Total revenue', agg: 'sum', field: 'revenue', format: 'currency', detail: { columns: [{ field: 'order_id' }] } }]
};

var detailEmptyColumnsPublish = {
  kind: 'publish',
  name: 'detailEmptyColumnsPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-empty-columns.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, detail: { columns: [] } }]
};

var detailColumnMissingFieldPublish = {
  kind: 'publish',
  name: 'detailColumnMissingFieldPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-column-missing-field.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, detail: { columns: [{ label: 'No field' }] } }]
};

var detailColumnBadFormatPublish = {
  kind: 'publish',
  name: 'detailColumnBadFormatPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-column-bad-format.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, detail: { columns: [{ field: 'amount', format: 'percent' }] } }]
};

var detailOnRawTablePublish = {
  kind: 'publish',
  name: 'detailOnRawTablePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-on-raw.html' },
  tables: [{ id: 'raw_with_detail', title: 'Raw', mode: 'raw', columns: [{ field: 'revenue' }], detail: { columns: [{ field: 'revenue' }] } }]
};

var chartDetailWithLinkKeyPublish = {
  kind: 'publish',
  name: 'chartDetailWithLinkKeyPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-with-linkkey.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkKey: 'category', detail: { columns: [{ field: 'order_id' }] } }]
};

var chartDetailWithLinkToPublish = {
  kind: 'publish',
  name: 'chartDetailWithLinkToPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail-with-linkto.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkTo: { node: 'linkToTargetPublish', field: 'category' }, detail: { columns: [{ field: 'order_id' }] } }]
};

// Valid: one aggregated table and one chart, each with a well-formed
// detail. Used by both testPublishValidDetailProceedsPastValidation
// (no shim - proves validation passes) and Task 2's payload tests (with
// a shim, to inspect the built .detail objects).
var detailPublish = {
  kind: 'publish',
  name: 'detailPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'detail.html' },
  charts: [{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    detail: { columns: [{ field: 'order_id', label: 'Order' }, { field: 'revenue', label: 'Revenue', format: 'currency' }] } }],
  tables: [{ id: 'by_category_table', title: 'By category', mode: 'aggregated', groupBy: 'category',
    metrics: [{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }],
    detail: { columns: [{ field: 'order_id', label: 'Order' }, { field: 'revenue', label: 'Revenue', format: 'currency' }] } }]
};

var seriesChartWithDetailPublish = {
  kind: 'publish',
  name: 'seriesChartWithDetailPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'series-detail.html' },
  charts: [{ id: 'by_category_channel', type: 'bar', title: 'By category and channel', groupBy: 'category', series: 'channel',
    metric: { agg: 'sum', field: 'revenue' }, detail: { columns: [{ field: 'revenue', format: 'currency' }] } }]
};
