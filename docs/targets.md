# Targets

A target is an environment name (like `prod` or `dev`) that lets you run the same pipeline configuration against different resources. This is useful for separating production and development infrastructure: the same models might write to `prod_dataset` in production and `dev_dataset` in development, with a single `--target` flag switching between them.

## Declaring targets

### For models

Model entries in `notsobigdataModels.models` can declare a `targets` object at the model level:

```javascript
var notsobigdataModels = {
  projectId: 'my-project',
  dataset: 'prod_dataset',           // default when no target is specified
  models: {
    orders: {
      sqlFile: 'orders.html',
      targets: {
        dev: { dataset: 'dev_dataset' },
        prod: { dataset: 'prod_dataset' }
      }
    }
  }
};
```

When you run `cli('run --target dev')`, the `orders` model's config is overlaid with `targets.dev`, so it uses `dev_dataset` instead. When you run `cli('run --target prod')` (or no `--target` at all), it uses the registry-wide default `prod_dataset`.

A model's targets overlay only the keys you explicitly set—everything else keeps its resolved value. If a model declares `targets.prod = { materialized: 'table' }` but no `dataset` inside it, the model still uses the registry's project-wide or model-level `dataset` value.

### For moves

Move nodes can also declare targets, the same way:

```javascript
var loadOrders = {
  kind: 'move',
  source: { type: 'bigquery', projectId: 'source-project', dataset: 'prod_data', table: 'orders' },
  target: { type: 'drive', folderId: 'prod-folder', fileName: 'orders.csv' },
  targets: {
    dev: { target: { type: 'drive', folderId: 'dev-folder', fileName: 'orders.csv' } },
    prod: { target: { type: 'drive', folderId: 'prod-folder', fileName: 'orders.csv' } }
  }
};
```

When you run `cli('run --target dev')`, the `loadOrders` move's config is overlaid with `targets.dev`, so it writes to the dev folder instead.

## Using targets

Pass `--target <name>` to any cli() command:

```javascript
NotSoBigData.cli('run --target dev')           // Run with dev targets
NotSoBigData.cli('list --target prod')         // List what would run with prod targets
NotSoBigData.cli('compile --target dev')       // Compile models with dev targets
```

The target is resolved once at the start of execution, before discovery, selection, ordering, or running—so it applies consistently across all nodes for the entire command.

## Edge cases

- **Unknown target:** If a move or model declares targets but you pass a target name that doesn't exist in its `targets` object, cli() throws an error listing the known targets. Fix it by passing a target that the node actually declares.

- **No target:** Omitting `--target` uses every node's default config (registry-wide defaults, plus any model-level or move-level defaults). Targets are opt-in—nodes that don't declare them are unaffected.

- **Duplicate targets:** `cli('run --target dev --target prod')` is an error. Only one target per command.

## Example

```javascript
// Same pipeline structure, different datasets per target
var notsobigdataModels = {
  projectId: 'my-company',
  dataset: 'analytics_prod',
  models: {
    stg_customers: { sqlFile: 'stg_customers.html', targets: { dev: { dataset: 'analytics_dev' } } },
    customers: { sqlFile: 'customers.html', targets: { dev: { dataset: 'analytics_dev' } } }
  }
};

// Command: run stg_customers and customers against dev_dataset
NotSoBigData.cli('run --target dev');

// Command: run stg_customers and customers against prod_dataset (the default)
NotSoBigData.cli('run --target prod');
```
