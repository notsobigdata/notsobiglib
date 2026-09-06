// test/fixtures/on-schema-change-view.js
var notsobigdataModels = {
  projectId: 'test-project',
  dataset: 'test_dataset',
  models: {
    orders_view: {
      materialized: 'view',
      on_schema_change: 'fail',
      sqlFile: 'stg_orders.html'
    }
  }
};
