// test/fixtures/on-schema-change-incremental.js
var notsobigdataModels = {
  projectId: 'test-project',
  dataset: 'test_dataset',
  models: {
    orders_incremental: {
      materialized: 'incremental',
      incrementalStrategy: 'merge',
      uniqueKey: 'id',
      on_schema_change: 'fail',
      sqlFile: 'stg_orders.html'
    }
  }
};
