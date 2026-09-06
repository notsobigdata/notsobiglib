// Fixture for testing --target flag with both moves and models

var targetMove = {
  kind: 'move',
  source: { type: 'url', url: 'https://example.com/data.json' },
  target: { type: 'drive', folderId: 'prod-folder' },
  targets: {
    dev: { target: { type: 'drive', folderId: 'dev-folder' } },
    prod: { target: { type: 'drive', folderId: 'prod-folder' } }
  }
};

var notsobigdataModels = {
  projectId: 'test-project',
  dataset: 'prod_dataset',
  models: {
    stg_orders: {
      sqlFile: 'stg_orders.html',
      targets: {
        dev: { dataset: 'dev_dataset' },
        prod: { dataset: 'prod_dataset' }
      }
    }
  }
};
