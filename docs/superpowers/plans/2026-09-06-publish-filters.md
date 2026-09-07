# Publish Client-Side Filters (filters[]) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `filters[]` config array to `publish` plus an opt-in `reactsTo: string[]` key on `kpis`/`charts`/`tables` entries, so that changing a dropdown recomputes every opted-in block entirely client-side (no reload, no new BigQuery call) against the report's underlying rows.

**Architecture:** `validatePublishConfig` gains a `filters[]` validation loop plus a shared `validateReactsTo` check called from the existing `kpis`/`charts`/`tables` loops. `buildReportPayload` conditionally embeds `payload.rows` (raw rows), `payload.filters` (field/label/sorted-distinct-options), and `payload.filterableConfig` (the original declared config for every `reactsTo`-bearing block) — only when `config.filters.length > 0`. `renderReportHtml` renders a `<div class="filters">` control bar and, when filters are configured, serializes the library's own already-pure aggregation functions (`computeAggregate`, `groupRowsBy`, `compareGroupValues`, `formatValue`, `buildChartPayload`, `buildRawTablePayload`, `buildAggregatedTablePayload`, `emptyMap`, `has`) via `Function.prototype.toString()` into the client script, so the browser re-runs the *exact same* aggregation code rather than a hand-ported duplicate. A new `FILTER_CLIENT_JS` client module wires the dropdowns, and `TABLE_CLIENT_JS` gains one small always-on hook (`window.__PUBLISH_TABLE_REPLACERS__`) so a table's pager can be handed freshly-filtered data without a second, desynced closure.

**Tech Stack:** Plain ES5-style JS (this file's existing convention — no `const`/`let`/arrow functions anywhere in `src/publish.js` or its emitted client script), D3 v7 (already loaded when charts exist, no new library).

**Spec:** `docs/superpowers/specs/2026-09-06-publish-filters-design.md`

## Global Constraints

- ES5 style throughout: `var`/`function`, string concatenation with `+`, no `const`/`let`/arrow functions (matches every existing line in `src/publish.js`).
- Every thrown error starts with `'publish(): '` (spec §2, §6).
- Zero new external dependencies, zero new CDN script (spec's non-goals).
- `filters[]` must be validated (and `seenFilterFields` collected) **before** the `kpis`/`charts`/`tables` loops run, since each loop's `reactsTo` check needs the full filter-field set to validate against (spec §6).
- `reactsTo` is opt-in only — a block with no `reactsTo` (or an empty array, which is itself rejected as invalid rather than silently ignored) never recomputes on a filter change (spec §1, §2).
- `payload.rows`, `payload.filters`, and `payload.filterableConfig` exist **only when** `config.filters.length > 0` — never present, not present-but-empty, for a report with no `filters[]` (spec §3).
- `payload.filters[].options` are that field's distinct values, sorted with a plain ascending string sort (`Array.prototype.sort()`) — not `compareGroupValues`' numeric-aware sort, which is for plotting, not for a dropdown's option order (spec §3).
- The nine functions listed in the Architecture section above are reused **verbatim** via `Function.prototype.toString()`, never hand-ported into a second, separately-maintained copy (spec §4). Corollary constraint for all future edits to any of these nine: they must never reference a GAS-only global (`BigQuery`, `DriveApp`, `Utilities`, etc.) — doing so would silently break `filters[]` in the browser, uncaught by any Node test (spec §4).
- Filter composition is AND across every currently-active (non-"All") filter; a block only recomputes when its own `reactsTo` intersects the currently-active filter fields — an empty intersection leaves that block exactly as currently rendered (spec §5).
- A filter change resets any chart-interactivity `currentSelection` (from `docs/superpowers/specs/2026-09-06-publish-chart-interactivity-design.md`, if the report also uses `linkKey`/`seriesLinkKey`) to `null` and re-runs `applyHighlight()`, guarded with `typeof` checks since `CHART_CLIENT_JS` (and therefore `currentSelection`/`applyHighlight`) is only emitted when `payload.charts.length > 0` (spec §5).
- No new file added to `build.sh`'s `MODULES` manifest — everything stays inside the existing `src/publish.js`.
- `./build.sh --check` and `node test/run.js` must both pass before any task is considered done.

---

### Task 0: Worktree setup — branch off `release/16`, bring in the spec

**Files:** none (repo/branch setup only).

**Interfaces:** none — this task produces the workspace every later task runs in.

- [ ] **Step 1: Verify the base commit and the spec commit**

```bash
cd /home/moschi/projetos/notsobig_org/notsobiglib
git fetch origin
git rev-parse release/16          # expect f60e01d7d1ca1e9b74b71e26634085fdd0d3fc5d
git log --oneline -1 docs/publish-filters-design   # expect 96b4752 docs: add design spec for publish's client-side filters[]
```

- [ ] **Step 2: Create the isolated worktree for the feature branch, off `release/16`**

```bash
git worktree add .worktrees/feat-publish-filters release/16 -b feat/publish-filters
cd .worktrees/feat-publish-filters
```

- [ ] **Step 3: Cherry-pick the spec-only commit from the docs branch onto the new feature branch**

```bash
git cherry-pick 96b4752
git log --oneline -3
```

Expected: the top commit is `docs: add design spec for publish's client-side filters[]`, with `release/16`'s merge commit (`f60e01d Merge pull request #87 ...`) directly below it.

- [ ] **Step 4: Verify a clean baseline**

```bash
./build.sh --check
node test/run.js
```

Expected: `build.sh --check` exits 0, and every existing test passes (this branch adds no code yet — only the cherry-picked doc).

---

### Task 1: Validate `filters[]` and `reactsTo`

**Files:**
- Modify: `src/publish.js` (`validatePublishConfig` — full-function replace)
- Modify: `test/fixtures/publish-nodes.js` (append five new fixtures)
- Modify: `test/publish.test.js` (append five new tests + register them)

**Interfaces:**
- Consumes: `emptyMap()`, `has(map, key)` (`src/cli.js`, unchanged), `PUBLISH_VALUE_FORMATS`, `CHART_TYPES` (`src/publish.js`, unchanged).
- Produces: `function validateReactsTo(blockType, blockId, reactsTo, filterFields)` — new top-level function in `src/publish.js`, called from `validatePublishConfig`'s `kpis`/`charts`/`tables` loops. `validatePublishConfig` itself gains a `filters[]` loop but no signature change. Task 2's `buildReportPayload` (and its own new `computeFilterOptions`/`buildFilterableConfig` helpers) rely on `config.filters`/`.reactsTo` having already passed this validation — they do no further shape-checking themselves.

- [ ] **Step 1: Write the failing validation tests**

Open `test/fixtures/publish-nodes.js` and append these five fixtures at the end of the file (after `linkKeyChartsPublish`):

```javascript
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
```

Open `test/publish.test.js` and append these five tests right after `testPublishChartClientJsWiresLineAndPieClickOnLinkKey` (before `testPublishAggregationFixtureStillHasNoStacking`):

```javascript
function testPublishFilterRequiresFieldAndLabel() {
  var result = runOne('badFilterMissingLabelPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/every filter needs "field" and "label"/.test(result.error), 'expected a filter field/label error, got: ' + result.error);
}

function testPublishDuplicateFilterFieldRejected() {
  var result = runOne('duplicateFilterFieldPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/duplicate filter field "category"/.test(result.error), 'expected a duplicate-filter-field error, got: ' + result.error);
}

function testPublishReactsToMustBeNonEmptyArray() {
  var result = runOne('emptyReactsToPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"reactsTo", which must be a non-empty array/.test(result.error), 'expected a reactsTo-empty-array error, got: ' + result.error);
}

function testPublishReactsToMustReferenceDeclaredFilter() {
  var result = runOne('reactsToUndeclaredFilterPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/"channel" is not a declared filter field/.test(result.error), 'expected a reactsTo-undeclared-field error, got: ' + result.error);
}

function testPublishFiltersProceedPastValidation() {
  var result = runOne('filtersPublish');
  // Same proof pattern as testPublishV2ChartTypesProceedPastValidation: no
  // BigQuery shim in this test, so a config that gets all the way past
  // validation fails next at the un-shimmed BigQuery call, not at
  // validation.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation to pass and fail only at the BigQuery call, got: ' + result.error);
}
```

Add all five to the `module.exports` object at the bottom of `test/publish.test.js` (after `testPublishChartClientJsWiresLineAndPieClickOnLinkKey: testPublishChartClientJsWiresLineAndPieClickOnLinkKey`):

```javascript
  testPublishFilterRequiresFieldAndLabel: testPublishFilterRequiresFieldAndLabel,
  testPublishDuplicateFilterFieldRejected: testPublishDuplicateFilterFieldRejected,
  testPublishReactsToMustBeNonEmptyArray: testPublishReactsToMustBeNonEmptyArray,
  testPublishReactsToMustReferenceDeclaredFilter: testPublishReactsToMustReferenceDeclaredFilter,
  testPublishFiltersProceedPastValidation: testPublishFiltersProceedPastValidation
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node test/run.js
```

Expected: all five new tests FAIL — `filters`/`reactsTo` aren't validated at all yet, so `badFilterMissingLabelPublish` etc. either succeed validation (and fail somewhere else, or not at all in ways these assertions don't expect) or throw a different error than the one each test's regex expects.

- [ ] **Step 3: Replace `validatePublishConfig`**

In `src/publish.js`, replace the entire existing `validatePublishConfig` function (from `function validatePublishConfig(config) {` through its closing `}`, immediately before `// Resolves config.source.ref against every other declared node -`) with:

```javascript
// Shared by the kpis/charts/tables validation loops below - reactsTo,
// when present, must be a non-empty array of field names each matching a
// declared filters[] entry. Typo protection: publish() has no other way
// to know a report author meant to reference a filter that doesn't
// exist, so an undeclared field throws here rather than silently never
// reacting to anything at report-view time.
function validateReactsTo(blockType, blockId, reactsTo, filterFields) {
  if (reactsTo === undefined) {
    return;
  }
  if (!Array.isArray(reactsTo) || !reactsTo.length) {
    throw new Error('publish(): ' + blockType + ' "' + blockId + '" has "reactsTo", which must be a non-empty array.');
  }
  reactsTo.forEach(function (field) {
    if (!has(filterFields, field)) {
      throw new Error('publish(): ' + blockType + ' "' + blockId + '" has "reactsTo: [' + field + ']", but "' + field + '" is not a declared filter field.');
    }
  });
}

// Every check a publish node's config must pass before anything is
// fetched or written - same "throw new Error('publish(): ...')"
// convention move()/model() already use. Field-by-field, not a schema
// library: the checks are few enough that hand-writing them is shorter
// and clearer than a schema for the sake of one small object shape.
function validatePublishConfig(config) {
  if (!config || !config.source || config.source.type !== 'ref' || !config.source.ref) {
    throw new Error('publish(): config.source must be { type: "ref", ref: "<nodeName>" }.');
  }
  if (!Array.isArray(config.dependsOn) || config.dependsOn.indexOf(config.source.ref) === -1) {
    throw new Error('publish(): "' + config.source.ref + '" is used as source.ref but is missing from dependsOn.');
  }
  if (!config.target || config.target.type !== 'drive' || !config.target.folderId || !config.target.fileName) {
    throw new Error('publish(): config.target must be { type: "drive", folderId: "...", fileName: "..." }.');
  }
  if (config.layout && config.layout.type !== 'linear') {
    throw new Error('publish(): layout.type "' + config.layout.type + '" - only "linear" is supported.');
  }
  var seenFilterFields = emptyMap();
  (config.filters || []).forEach(function (filter) {
    if (!filter.field || !filter.label) {
      throw new Error('publish(): every filter needs "field" and "label".');
    }
    if (has(seenFilterFields, filter.field)) {
      throw new Error('publish(): duplicate filter field "' + filter.field + '".');
    }
    seenFilterFields[filter.field] = true;
  });
  (config.kpis || []).forEach(function (kpi) {
    if (!kpi.label || !kpi.agg) {
      throw new Error('publish(): every kpi needs "label" and "agg".');
    }
    if (kpi.agg !== 'count' && !kpi.field) {
      throw new Error('publish(): kpi "' + kpi.label + '" has agg "' + kpi.agg + '", which requires "field".');
    }
    if (PUBLISH_VALUE_FORMATS.indexOf(kpi.format) === -1) {
      throw new Error('publish(): kpi "' + kpi.label + '" has format "' + kpi.format + '" - expected one of ' + PUBLISH_VALUE_FORMATS.join(', ') + '.');
    }
    validateReactsTo('kpi', kpi.label, kpi.reactsTo, seenFilterFields);
  });
  var seenChartIds = emptyMap();
  (config.charts || []).forEach(function (chart) {
    if (chart.id && has(seenChartIds, chart.id)) {
      throw new Error('publish(): duplicate chart id "' + chart.id + '".');
    }
    if (chart.id) {
      seenChartIds[chart.id] = true;
    }
    if (!chart.id || !chart.title || !chart.groupBy || !chart.metric || !chart.metric.agg) {
      throw new Error('publish(): every chart needs "id", "title", "groupBy", and "metric.agg".');
    }
    var chartType = chart.type || 'bar';
    if (CHART_TYPES.indexOf(chartType) === -1) {
      throw new Error('publish(): chart "' + chart.id + '" has type "' + chartType + '" - expected one of ' + CHART_TYPES.join(', ') + '.');
    }
    if ((chart.series || chart.stacking) && chartType !== 'bar') {
      throw new Error('publish(): chart "' + chart.id + '" has "series"/"stacking", which only "bar" charts support.');
    }
    if (chart.stacking && ['grouped', 'stacked'].indexOf(chart.stacking) === -1) {
      throw new Error('publish(): chart "' + chart.id + '" has stacking "' + chart.stacking + '" - expected "grouped" or "stacked".');
    }
    if (chart.donut !== undefined && chartType !== 'pie') {
      throw new Error('publish(): chart "' + chart.id + '" has "donut", which only "pie" charts support.');
    }
    if (chart.seriesLinkKey && !(chartType === 'bar' && chart.series)) {
      throw new Error('publish(): chart "' + chart.id + '" has "seriesLinkKey", which only "bar" charts with "series" support.');
    }
    validateReactsTo('chart', chart.id, chart.reactsTo, seenFilterFields);
  });
  var seenTableIds = emptyMap();
  (config.tables || []).forEach(function (table) {
    if (table.id && has(seenTableIds, table.id)) {
      throw new Error('publish(): duplicate table id "' + table.id + '".');
    }
    if (table.id) {
      seenTableIds[table.id] = true;
    }
    if (!table.id || !table.title || ['raw', 'aggregated'].indexOf(table.mode) === -1) {
      throw new Error('publish(): every table needs "id", "title", and mode "raw" or "aggregated".');
    }
    validateReactsTo('table', table.id, table.reactsTo, seenFilterFields);
    if (table.mode === 'raw') {
      if (!Array.isArray(table.columns) || !table.columns.length) {
        throw new Error('publish(): table "' + table.id + '" has mode "raw", which requires a non-empty "columns" array.');
      }
      table.columns.forEach(function (column) {
        if (!column.field) {
          throw new Error('publish(): table "' + table.id + '" has a column missing "field".');
        }
        if (column.format && PUBLISH_VALUE_FORMATS.indexOf(column.format) === -1) {
          throw new Error('publish(): table "' + table.id + '" column "' + column.field + '" has format "' + column.format + '" - expected one of ' + PUBLISH_VALUE_FORMATS.join(', ') + '.');
        }
      });
    } else {
      if (!table.groupBy) {
        throw new Error('publish(): table "' + table.id + '" has mode "aggregated", which requires "groupBy".');
      }
      if (!Array.isArray(table.metrics) || !table.metrics.length) {
        throw new Error('publish(): table "' + table.id + '" has mode "aggregated", which requires a non-empty "metrics" array.');
      }
      table.metrics.forEach(function (metric) {
        if (!metric.label || !metric.agg) {
          throw new Error('publish(): table "' + table.id + '" has a metric missing "label" or "agg".');
        }
        if (metric.agg !== 'count' && !metric.field) {
          throw new Error('publish(): table "' + table.id + '" metric "' + metric.label + '" has agg "' + metric.agg + '", which requires "field".');
        }
        if (metric.format && PUBLISH_VALUE_FORMATS.indexOf(metric.format) === -1) {
          throw new Error('publish(): table "' + table.id + '" metric "' + metric.label + '" has format "' + metric.format + '" - expected one of ' + PUBLISH_VALUE_FORMATS.join(', ') + '.');
        }
      });
    }
  });
}
```

- [ ] **Step 4: Rebuild and run tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: all tests pass, including the five new ones. Every pre-existing `test/publish.test.js` test must still pass unchanged (this task only adds a new loop and one new call per existing loop — no existing check's message or ordering changes).

- [ ] **Step 5: Commit**

```bash
git add src/publish.js src.js test/fixtures/publish-nodes.js test/publish.test.js
git commit -m "feat: validate publish's filters[] and reactsTo config"
```

---

### Task 2: Payload additions — `rows`, `filters`, `filterableConfig`

**Files:**
- Modify: `src/publish.js` (add `computeFilterOptions`, `buildFilterableConfig`; modify `buildReportPayload`)
- Modify: `test/publish.test.js` (append four new tests + register them)

**Interfaces:**
- Consumes: `groupRowsBy`, `has`, `emptyMap` (all existing, unchanged); `config.filters`/`.reactsTo` (Task 1, already validated by the time `buildReportPayload` runs).
- Produces: `computeFilterOptions(rows, field)` → `string[]` (sorted, distinct). `buildFilterableConfig(config)` → `{ kpis: {index:number, config:object}[], charts: object[], tables: object[] }`. `buildReportPayload(config, rows)`'s return value gains `rows`/`filters`/`filterableConfig` keys, present only when `config.filters && config.filters.length`. Task 3's `renderReportHtml` and its new client-side code read all three by these exact names/shapes.

- [ ] **Step 1: Write the failing tests**

Add these four tests to `test/publish.test.js`, right after `testPublishFiltersProceedPastValidation` (Task 1's last test):

```javascript
function testPublishFilterPayloadAbsentWithoutFilters() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'rows'), 'expected no payload.rows without filters[], got keys: ' + Object.keys(payload).join(', '));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'filters'), 'expected no payload.filters without filters[], got keys: ' + Object.keys(payload).join(', '));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'filterableConfig'), 'expected no payload.filterableConfig without filters[], got keys: ' + Object.keys(payload).join(', '));
}

function testPublishFilterPayloadIncludesRowsAndSortedDistinctOptions() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [
    ['B', 'online', '10', '1'],
    ['A', 'store', '20', '2'],
    ['A', 'online', '5', '3']
  ]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  assert.strictEqual(payload.rows.length, 3, 'expected all 3 raw rows embedded, got: ' + JSON.stringify(payload.rows));

  var categoryFilter = payload.filters.filter(function (f) { return f.field === 'category'; })[0];
  assert.deepStrictEqual(categoryFilter.options, ['A', 'B'], 'expected sorted distinct category options, got: ' + JSON.stringify(categoryFilter));
  var channelFilter = payload.filters.filter(function (f) { return f.field === 'channel'; })[0];
  assert.deepStrictEqual(channelFilter.options, ['online', 'store'], 'expected sorted distinct channel options, got: ' + JSON.stringify(channelFilter));
}

function testPublishFilterableConfigOnlyIncludesReactsToBlocks() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());

  // filtersPublish's "Rows" kpi has no reactsTo - only "Revenue" (index 0
  // in config.kpis) should appear.
  assert.strictEqual(payload.filterableConfig.kpis.length, 1, 'expected only the reactsTo-bearing kpi, got: ' + JSON.stringify(payload.filterableConfig.kpis));
  assert.strictEqual(payload.filterableConfig.kpis[0].index, 0, 'expected the Revenue kpi at its original config.kpis index 0, got: ' + JSON.stringify(payload.filterableConfig.kpis[0]));
  assert.deepStrictEqual(payload.filterableConfig.kpis[0].config.reactsTo, ['category', 'channel']);

  assert.strictEqual(payload.filterableConfig.charts.length, 1);
  assert.strictEqual(payload.filterableConfig.charts[0].id, 'trend');
  assert.deepStrictEqual(payload.filterableConfig.charts[0].reactsTo, ['category']);

  assert.strictEqual(payload.filterableConfig.tables.length, 1);
  assert.strictEqual(payload.filterableConfig.tables[0].id, 'orders');
  assert.deepStrictEqual(payload.filterableConfig.tables[0].reactsTo, ['category', 'channel']);
}

function testPublishFilterableConfigExcludesNonReactiveKpiEvenWithFiltersConfigured() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var payload = extractPayload(getHtml());
  var kpiIndexes = payload.filterableConfig.kpis.map(function (entry) { return entry.index; });
  assert.strictEqual(kpiIndexes.indexOf(1), -1, 'expected the "Rows" kpi (config.kpis index 1, no reactsTo) to be absent from filterableConfig.kpis, got indexes: ' + JSON.stringify(kpiIndexes));
}
```

Add all four to the `module.exports` object, after `testPublishFiltersProceedPastValidation: testPublishFiltersProceedPastValidation`:

```javascript
  testPublishFilterPayloadAbsentWithoutFilters: testPublishFilterPayloadAbsentWithoutFilters,
  testPublishFilterPayloadIncludesRowsAndSortedDistinctOptions: testPublishFilterPayloadIncludesRowsAndSortedDistinctOptions,
  testPublishFilterableConfigOnlyIncludesReactsToBlocks: testPublishFilterableConfigOnlyIncludesReactsToBlocks,
  testPublishFilterableConfigExcludesNonReactiveKpiEvenWithFiltersConfigured: testPublishFilterableConfigExcludesNonReactiveKpiEvenWithFiltersConfigured
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node test/run.js
```

Expected: all four new tests FAIL (`payload.rows`/`.filters`/`.filterableConfig` don't exist yet on any payload).

- [ ] **Step 3: Implement `computeFilterOptions`, `buildFilterableConfig`, and widen `buildReportPayload`**

In `src/publish.js`, replace the existing `buildReportPayload` function (currently the last function before `escapeHtml`) with:

```javascript
// Distinct values for one filters[] field, sorted ascending as plain
// strings - a dropdown's option list, not a plotted axis, so no need for
// compareGroupValues' numeric-aware sort (that sort exists for chart
// axes, this is for picking a value).
function computeFilterOptions(rows, field) {
  var seen = emptyMap();
  var options = [];
  rows.forEach(function (row) {
    var value = row[field];
    if (!has(seen, value)) {
      seen[value] = true;
      options.push(value);
    }
  });
  options.sort();
  return options;
}

// The original declared config for every kpi/chart/table that opted into
// at least one filter via reactsTo - the client needs each block's own
// config object (agg/field/format, groupBy/metric/type/series/stacking,
// mode/columns/groupBy/metrics/pageSize) to re-call the same build
// functions client-side against filtered rows. A block that never opted
// in is omitted entirely, keeping this payload section exactly as large
// as the feature's actual footprint. kpis carry their own index into
// config.kpis (charts/tables don't need this - they already have a
// unique .id the DOM is keyed by) since KPI cards render with no id/data
// attribute of their own, and DOM order is otherwise the only way to
// find "the third KPI card" back again from the client.
function buildFilterableConfig(config) {
  function reactive(block) {
    return Array.isArray(block.reactsTo) && block.reactsTo.length > 0;
  }
  var kpis = [];
  (config.kpis || []).forEach(function (kpi, index) {
    if (reactive(kpi)) {
      kpis.push({ index: index, config: kpi });
    }
  });
  return {
    kpis: kpis,
    charts: (config.charts || []).filter(reactive),
    tables: (config.tables || []).filter(reactive)
  };
}

function buildReportPayload(config, rows) {
  var kpis = (config.kpis || []).map(function (kpi) {
    var value = computeAggregate(rows, kpi.agg, kpi.field);
    return { label: kpi.label, value: value, formatted: formatValue(value, kpi.format) };
  });
  var charts = (config.charts || []).map(function (chart) {
    return buildChartPayload(chart, rows);
  });
  var tables = (config.tables || []).map(function (table) {
    return table.mode === 'raw' ? buildRawTablePayload(table, rows) : buildAggregatedTablePayload(table, rows);
  });
  var payload = { kpis: kpis, charts: charts, tables: tables };
  if (config.filters && config.filters.length) {
    payload.rows = rows;
    payload.filters = config.filters.map(function (filter) {
      return { field: filter.field, label: filter.label, options: computeFilterOptions(rows, filter.field) };
    });
    payload.filterableConfig = buildFilterableConfig(config);
  }
  return payload;
}
```

- [ ] **Step 4: Rebuild and run tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: all tests pass, including the four new ones. Every existing `buildReportPayload`-touching test (`testPublishAggregatesKpisAndChartsCorrectly`, `testPublishBuildsRawAndAggregatedTablePayloads`, etc.) must still pass unchanged — this task only adds new, conditionally-present keys, never changes `kpis`/`charts`/`tables`' existing shape.

- [ ] **Step 5: Commit**

```bash
git add src/publish.js src.js test/publish.test.js
git commit -m "feat: embed rows/filters/filterableConfig in publish's payload when filters[] is configured"
```

---

### Task 3: Client-side filtering engine

**Files:**
- Modify: `src/publish.js` (`REPORT_CSS`; new `renderFiltersSection`; new `FILTER_REUSED_FUNCTIONS_JS`; new `FILTER_CLIENT_JS`; `TABLE_CLIENT_JS`'s `render()`-adjacent lines; `renderReportHtml`)
- Modify: `test/publish.test.js` (append six new tests + register them)

**Interfaces:**
- Consumes: `payload.filters`/`.filterableConfig`/`.rows` (Task 2), `computeAggregate`/`groupRowsBy`/`compareGroupValues`/`formatValue`/`buildChartPayload`/`buildRawTablePayload`/`buildAggregatedTablePayload`/`emptyMap`/`has` (all existing, reused by reference for `.toString()`), `drawBarChart`/`drawLineChart`/`drawPieChart`/`renderChartFallback`/`currentSelection`/`applyHighlight` (existing `CHART_CLIENT_JS`, referenced only from client-side JS text, guarded by `typeof` where they may not exist).
- Produces: `renderFiltersSection(filters)` → HTML string. `FILTER_REUSED_FUNCTIONS_JS` → string constant (the nine functions' serialized source). `FILTER_CLIENT_JS` → string constant (new client module: `activeFilters`, `filteredRowsFor`, `applyFilterToKpi`/`Chart`/`Table`, `applyFilters`, the filter-select wiring). `window.__PUBLISH_TABLE_REPLACERS__[tableId]` — a client-side hook exposed by `TABLE_CLIENT_JS`'s existing per-section closure, called by `applyFilterToTable`. No further consumers beyond this task — this completes the feature's visible behavior.

- [ ] **Step 1: Write the failing tests**

Add these six tests to `test/publish.test.js`, right after `testPublishFilterableConfigExcludesNonReactiveKpiEvenWithFiltersConfigured` (Task 2's last test):

```javascript
function testPublishFiltersMarkupRenderedWhenConfigured() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [
    ['B', 'online', '10', '1'],
    ['A', 'store', '20', '2']
  ]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/<div class="filters">/.test(html), 'expected a filters bar, got: ' + html);
  assert.ok(/data-filter-field="category"/.test(html), 'expected a category filter select, got: ' + html);
  assert.ok(/data-filter-field="channel"/.test(html), 'expected a channel filter select, got: ' + html);
  assert.ok(/<option value="">All<\/option>/.test(html), 'expected an "All" default option, got: ' + html);
  assert.ok(/<option value="A">A<\/option>/.test(html), 'expected a distinct-value option, got: ' + html);
}

function testPublishNoFiltersMarkupOrClientJsWithoutFilters() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(!/class="filters"/.test(html), 'expected no filters markup, got: ' + html);
  assert.ok(!/function applyFilters/.test(html), 'expected no FILTER_CLIENT_JS, got: ' + html);
  assert.ok(!/function filteredRowsFor/.test(html), 'expected no filter-engine wiring, got: ' + html);
}

function testPublishFilterClientJsIncludesReusedAggregationFunctionsVerbatim() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  ['computeAggregate', 'groupRowsBy', 'compareGroupValues', 'formatValue', 'buildChartPayload', 'buildRawTablePayload', 'buildAggregatedTablePayload', 'emptyMap', 'has'].forEach(function (name) {
    assert.ok(new RegExp('function ' + name + '\\(').test(html), 'expected the reused function "' + name + '" verbatim in the emitted script, got: ' + html);
  });
}

function testPublishFilterClientJsResetsHighlightSelectionOnApply() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/if \(typeof currentSelection !== "undefined"\) \{ currentSelection = null; \}/.test(html), 'expected applyFilters to reset any chart-highlight selection, got: ' + html);
  assert.ok(/if \(typeof applyHighlight === "function"\) \{ applyHighlight\(\); \}/.test(html), 'expected applyFilters to re-run applyHighlight, got: ' + html);
}

function testPublishFilterClientJsWiresSelectChangeEvents() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'channel', 'revenue', 'day'], [['A', 'online', '10', '1']]);
  var result = ctx.NotSoBigData.cli('run --select filtersPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  assert.ok(/querySelectorAll\("\[data-filter-field\]"\)/.test(html), 'expected the filter-select wiring query, got: ' + html);
  assert.ok(/select\.addEventListener\("change"/.test(html), 'expected a change listener on each filter select, got: ' + html);
}

function testPublishTableClientJsAlwaysExposesReplacerHook() {
  // Whether or not filters[] is configured - see this plan's Task 3 note
  // on why this is unconditional, matching CHART_CLIENT_JS's own
  // "always-on scaffolding, opt-in behavior" precedent from the chart-
  // interactivity phase (docs/superpowers/specs/2026-09-06-publish-chart-
  // interactivity-design.md).
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue', 'order_id'], [['A', '10', 'o1']]);
  var result = ctx.NotSoBigData.cli('run --select tablesPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/__PUBLISH_TABLE_REPLACERS__/.test(html), 'expected the table replacer hook regardless of filters[], got: ' + html);
}
```

Add all six to the `module.exports` object, after `testPublishFilterableConfigExcludesNonReactiveKpiEvenWithFiltersConfigured: testPublishFilterableConfigExcludesNonReactiveKpiEvenWithFiltersConfigured`:

```javascript
  testPublishFiltersMarkupRenderedWhenConfigured: testPublishFiltersMarkupRenderedWhenConfigured,
  testPublishNoFiltersMarkupOrClientJsWithoutFilters: testPublishNoFiltersMarkupOrClientJsWithoutFilters,
  testPublishFilterClientJsIncludesReusedAggregationFunctionsVerbatim: testPublishFilterClientJsIncludesReusedAggregationFunctionsVerbatim,
  testPublishFilterClientJsResetsHighlightSelectionOnApply: testPublishFilterClientJsResetsHighlightSelectionOnApply,
  testPublishFilterClientJsWiresSelectChangeEvents: testPublishFilterClientJsWiresSelectChangeEvents,
  testPublishTableClientJsAlwaysExposesReplacerHook: testPublishTableClientJsAlwaysExposesReplacerHook
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node test/run.js
```

Expected: all six new tests FAIL (none of `renderFiltersSection`/`FILTER_REUSED_FUNCTIONS_JS`/`FILTER_CLIENT_JS`/the replacer hook exist yet).

- [ ] **Step 3: Add `.filters` styling to `REPORT_CSS`**

In `src/publish.js`, `REPORT_CSS` currently ends:

```javascript
  '.table-pager button:disabled { color: var(--ink-soft); cursor: default; }'
].join('\n');
```

Change it to:

```javascript
  '.table-pager button:disabled { color: var(--ink-soft); cursor: default; }',
  '.filters { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }',
  '.filter { font-family: var(--mono); font-size: 12px; display: flex; flex-direction: column; gap: 4px; }',
  '.filter select { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); padding: 2px 6px; }'
].join('\n');
```

- [ ] **Step 4: Add `renderFiltersSection`**

In `src/publish.js`, immediately before `function renderTableSection(table) {`, add:

```javascript
// One <select> per filters[] entry: an "All" option plus every distinct
// value already computed server-side in payload.filters[].options (see
// computeFilterOptions). data-filter-field is what FILTER_CLIENT_JS reads
// back to know which row field a given <select>'s change event affects.
function renderFiltersSection(filters) {
  var controls = filters.map(function (filter) {
    var optionTags = filter.options.map(function (value) {
      return '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>';
    }).join('');
    return '<label class="filter">' + escapeHtml(filter.label)
      + '<select data-filter-field="' + escapeHtml(filter.field) + '"><option value="">All</option>' + optionTags + '</select></label>';
  }).join('');
  return '<div class="filters">' + controls + '</div>';
}
```

- [ ] **Step 5: Add `FILTER_REUSED_FUNCTIONS_JS`**

In `src/publish.js`, immediately after `renderFiltersSection`'s closing `}` and before `function renderTableSection(table) {`, add:

```javascript
// The exact functions filters[] needs to re-run client-side, serialized
// once at module load (these are static function references, so this
// only runs once no matter how many reports get generated in one run) -
// reused verbatim rather than hand-ported, so any future change to any
// of them is automatically correct in the browser too. See the design
// spec's §4 for the "why toString()" rationale and its one constraint:
// none of these nine functions may ever reference a GAS-only global
// (BigQuery, DriveApp, Utilities, etc.) - doing so would silently break
// filters[] only in the browser, not caught by any Node test. A named
// function declaration's .toString() output is itself valid top-level
// source, so no wrapping is needed - it drops straight into the
// generated <script> as ordinary, hoisted function declarations.
var FILTER_REUSED_FUNCTIONS_JS = [
  emptyMap, has, computeAggregate, groupRowsBy, compareGroupValues,
  formatValue, buildChartPayload, buildRawTablePayload, buildAggregatedTablePayload
].map(function (fn) { return fn.toString(); }).join('\n');
```

- [ ] **Step 6: Add `FILTER_CLIENT_JS`**

In `src/publish.js`, immediately after `FILTER_REUSED_FUNCTIONS_JS` and before `function renderTableSection(table) {`, add:

```javascript
// The filter dropdowns' own wiring: composes every currently-active
// (non-"All") filter with AND semantics, recomputes only the
// kpis/charts/tables that opted in via reactsTo (payload.filterableConfig,
// see buildFilterableConfig), and leaves everything else exactly as
// currently rendered. Reuses FILTER_REUSED_FUNCTIONS_JS's functions and
// CHART_CLIENT_JS/TABLE_CLIENT_JS's existing draw/pagination machinery -
// this module never re-implements drawing or pagination itself.
var FILTER_CLIENT_JS = [
  'var activeFilters = {};',
  'function filteredRowsFor(reactsTo) {',
  '  var relevant = reactsTo.filter(function (f) { return has(activeFilters, f); });',
  '  if (!relevant.length) { return null; }',
  '  var rows = window.__PUBLISH_PAYLOAD__.rows;',
  '  return rows.filter(function (row) { return relevant.every(function (f) { return row[f] === activeFilters[f]; }); });',
  '}',
  'function applyFilterToKpi(entry) {',
  '  var filteredRows = filteredRowsFor(entry.config.reactsTo);',
  '  if (!filteredRows) { return; }',
  '  var value = computeAggregate(filteredRows, entry.config.agg, entry.config.field);',
  '  var card = document.querySelectorAll(".kpi")[entry.index];',
  '  if (card) { card.querySelector(".kpi-value").textContent = formatValue(value, entry.config.format); }',
  '}',
  'function applyFilterToChart(chartConfig) {',
  '  var filteredRows = filteredRowsFor(chartConfig.reactsTo);',
  '  if (!filteredRows) { return; }',
  '  var newChart = buildChartPayload(chartConfig, filteredRows);',
  '  var container = document.getElementById("chart-" + chartConfig.id);',
  '  if (!container) { return; }',
  '  while (container.firstChild) { container.removeChild(container.firstChild); }',
  '  if (typeof d3 === "undefined") { renderChartFallback(container.id, newChart); return; }',
  '  if (newChart.type === "line") { drawLineChart(container.id, newChart); }',
  '  else if (newChart.type === "pie") { drawPieChart(container.id, newChart); }',
  '  else { drawBarChart(container.id, newChart); }',
  '}',
  'function applyFilterToTable(tableConfig) {',
  '  var filteredRows = filteredRowsFor(tableConfig.reactsTo);',
  '  if (!filteredRows) { return; }',
  '  var newTable = tableConfig.mode === "raw" ? buildRawTablePayload(tableConfig, filteredRows) : buildAggregatedTablePayload(tableConfig, filteredRows);',
  '  var replace = window.__PUBLISH_TABLE_REPLACERS__ && window.__PUBLISH_TABLE_REPLACERS__[tableConfig.id];',
  '  if (replace) { replace(newTable); }',
  '}',
  'function applyFilters() {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  payload.filterableConfig.kpis.forEach(applyFilterToKpi);',
  '  payload.filterableConfig.charts.forEach(applyFilterToChart);',
  '  payload.filterableConfig.tables.forEach(applyFilterToTable);',
  '  if (typeof currentSelection !== "undefined") { currentSelection = null; }',
  '  if (typeof applyHighlight === "function") { applyHighlight(); }',
  '}',
  'document.addEventListener("DOMContentLoaded", function () {',
  '  Array.prototype.forEach.call(document.querySelectorAll("[data-filter-field]"), function (select) {',
  '    select.addEventListener("change", function () {',
  '      var field = select.getAttribute("data-filter-field");',
  '      if (select.value === "") { delete activeFilters[field]; }',
  '      else { activeFilters[field] = select.value; }',
  '      applyFilters();',
  '    });',
  '  });',
  '});'
].join('\n');
```

- [ ] **Step 7: Expose the table replacer hook in `TABLE_CLIENT_JS`**

In `src/publish.js`, `TABLE_CLIENT_JS`'s per-section `render()` function currently ends, immediately followed by the pager buttons' listeners:

```javascript
  '      pageLabel.textContent = "Page " + (page + 1) + " of " + pageCount;',
  '      prevBtn.disabled = page === 0;',
  '      nextBtn.disabled = page >= pageCount - 1;',
  '    }',
  '    prevBtn.addEventListener("click", function () { if (page > 0) { page -= 1; render(); } });',
```

Insert four new lines between `'    }',` (the end of `render()`) and `'    prevBtn.addEventListener...'`:

```javascript
  '      pageLabel.textContent = "Page " + (page + 1) + " of " + pageCount;',
  '      prevBtn.disabled = page === 0;',
  '      nextBtn.disabled = page >= pageCount - 1;',
  '    }',
  '    window.__PUBLISH_TABLE_REPLACERS__ = window.__PUBLISH_TABLE_REPLACERS__ || {};',
  '    window.__PUBLISH_TABLE_REPLACERS__[tableId] = function (newTable) {',
  '      table = newTable;',
  '      page = 0;',
  '      pageCount = Math.max(1, Math.ceil(table.rows.length / table.pageSize));',
  '      render();',
  '    };',
  '    prevBtn.addEventListener("click", function () { if (page > 0) { page -= 1; render(); } });',
```

This hook is unconditional — present whenever `payload.tables.length > 0`, whether or not `filters[]` is configured, the same "small always-on scaffolding, opt-in behavior" shape `CHART_CLIENT_JS`'s own selection module already established for chart-interactivity (that module is likewise emitted whenever any chart exists, regardless of whether any individual chart declares `linkKey`). `table`/`page`/`pageCount` are the same `var`-declared closure variables `render()`/the pager buttons already read and write — reassigning them here and calling the existing `render()` is the entire mechanism; no second pagination implementation.

- [ ] **Step 8: Wire filters into `renderReportHtml`**

In `src/publish.js`, replace the entire `renderReportHtml` function with:

```javascript
function renderReportHtml(payload, config) {
  var filtersSection = (payload.filters && payload.filters.length) ? renderFiltersSection(payload.filters) : '';
  var kpiCards = payload.kpis.map(function (kpi) {
    return '<div class="kpi"><div class="kpi-label">' + escapeHtml(kpi.label) + '</div>'
      + '<div class="kpi-value">' + escapeHtml(kpi.formatted) + '</div></div>';
  }).join('');
  var chartSections = payload.charts.map(function (chart) {
    return '<section class="chart" data-chart-id="' + escapeHtml(chart.id) + '"><h2>' + escapeHtml(chart.title) + '</h2>'
      + '<div class="chart-canvas" id="chart-' + escapeHtml(chart.id) + '"></div></section>';
  }).join('');
  var tableSections = payload.tables.map(renderTableSection).join('');
  var script = 'window.__PUBLISH_PAYLOAD__ = ' + JSON.stringify(payload).replace(/</g, '\\u003c') + ';';
  if (payload.tables.length) {
    script += TABLE_CLIENT_JS;
  }
  if (payload.charts.length) {
    script += CHART_CLIENT_JS;
  }
  if (payload.filters && payload.filters.length) {
    script += FILTER_REUSED_FUNCTIONS_JS + FILTER_CLIENT_JS;
  }
  var d3Script = payload.charts.length ? '<script src="' + D3_CDN_URL + '" integrity="' + D3_CDN_INTEGRITY + '" crossorigin="anonymous"></script>' : '';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>' + escapeHtml(config.target.fileName) + '</title>'
    + '<style>' + REPORT_CSS + '</style>' + d3Script + '</head><body>'
    + '<main>' + filtersSection + '<div class="kpis">' + kpiCards + '</div>' + chartSections + tableSections + '</main>'
    + '<script>' + script + '</script>'
    + '</body></html>';
}
```

(The only changes from the current function: the new `filtersSection` line, the new `if (payload.filters ...)` script branch, and `filtersSection` spliced into the returned markup right before `<div class="kpis">`.)

- [ ] **Step 9: Rebuild and run tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: all tests pass, including the six new ones. Every pre-existing test must still pass unchanged — in particular `testPublishChartClientJsCallsApplyHighlightOnceOnLoad` (still exactly 2 `applyHighlight();` call sites) and `testPublishChartClientJsWiresLineAndPieClickOnLinkKey` (still exactly 2 standalone `if (chart.linkKey) {` blocks), both counted against `linkKeyChartsPublish`. That fixture has no `filters[]` configured, so `renderReportHtml`'s `if (payload.filters && payload.filters.length)` branch never fires for it and `FILTER_CLIENT_JS` (which does contain its own `applyHighlight();` call, inside the `typeof applyHighlight === "function"` guard) is never emitted into that specific test's HTML at all — these two counts are protected by conditional emission, not by `FILTER_CLIENT_JS` avoiding the literal text. (`FILTER_CLIENT_JS` does, separately, never write a standalone `if (chart.linkKey) {` block — it has no reason to, since it never touches `linkKey` at all.)

- [ ] **Step 10: Commit**

```bash
git add src/publish.js src.js test/publish.test.js
git commit -m "feat: add publish's client-side filters[] engine (dropdowns, reused aggregation, table replacer hook)"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/publish.md` (new `## Filters` section; `## What's not here yet` update)
- Modify: `src/publish.md` (append a dev-notes section)

**Interfaces:** none — this task changes only prose, no code.

- [ ] **Step 1: Add a `## Filters` section to `docs/publish.md`**

Open `docs/publish.md`. Immediately after the `### tables[]` section's closing paragraph (the one ending `"...since that's also what the client-side pager needs to page through without re-formatting anything."`, right before the `## Limits worth knowing` heading), insert:

```markdown
## Filters

```javascript
filters: [
  { field: 'category_name', label: 'Category' },
  { field: 'channel', label: 'Channel' }
],
kpis: [
  { label: 'Total revenue', agg: 'sum', field: 'revenue', format: 'currency',
    reactsTo: ['category_name', 'channel'] },
  { label: 'Orders', agg: 'count_distinct', field: 'order_id', format: 'integer' }
  // no reactsTo - this KPI never moves, whatever the filters are set to
],
charts: [
  { id: 'trend', type: 'line', title: 'Revenue by day',
    groupBy: 'order_date', metric: { agg: 'sum', field: 'revenue' },
    reactsTo: ['category_name'] }   // ignores the "channel" filter
],
tables: [
  { id: 'orders', title: 'Orders', mode: 'raw', columns: [ /* ... */ ],
    reactsTo: ['category_name', 'channel'] }
]
```

- `filters[]` — each entry is one dropdown: `field` (a column in the
  source table) and `label` (what the dropdown says). Its options are
  **not** configured — they're the field's own distinct values, sorted
  alphabetically, computed at generation time.
- `reactsTo` — opt-in on any `kpi`/`chart`/`table` entry, naming which
  `filters[].field`s that block honors. A block with no `reactsTo` never
  recomputes, no matter what any filter is set to. A `reactsTo` entry
  that doesn't match a declared `filters[].field` is rejected at config
  time (a typo guard).
- Changing a dropdown recomputes only the opted-in blocks, entirely in
  the browser, against the report's underlying rows filtered by every
  currently-active (non-"All") filter, ANDed together — no reload, no
  new BigQuery call. A block whose `reactsTo` doesn't intersect the
  currently-active filters is left exactly as currently rendered.
- If the report also uses cross-chart click-to-highlight
  (`linkKey`/`seriesLinkKey`), changing a filter clears the current
  highlight selection, since the previously-selected value's rows may no
  longer exist post-filter.
- Known limits: every filter is a single-select, exact-match dropdown —
  no numeric/date range, no multi-select. A filter selection lives only
  in the open page's JS state; reloading the file, or a fresh download,
  resets every filter to "All". A field with many distinct values
  produces a long dropdown — `publish()` doesn't guard against choosing
  a bad `field` for this, the same posture `charts[]`' `groupBy` already
  has.
```

Then find the `## What's not here yet` section and replace its entire contents with:

```markdown
## What's not here yet

`linkTo` cross-file navigation (with query-string filter propagation),
`expandable`/`detail` drill-down, per-block `source` overrides, and a
`board` tree layout are all planned but not implemented — see
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
direction" section. Column-header sort and search for the `tables[]`
block are also not implemented yet.
```

- [ ] **Step 2: Add dev-notes to `src/publish.md`**

Open `src/publish.md` and append this new section at the end of the file, after the existing "Cross-chart highlighting is one shared client-side module, not per-chart state" section's closing paragraph ("No new `.attr("fill", ...)`-vs-`.style("fill", ...)` traps were introduced here — none of this task's new code sets `fill`."):

```markdown
## `filters[]` reuses its own server-side functions client-side, via `Function.prototype.toString()`

`computeAggregate`, `groupRowsBy`, `compareGroupValues`, `formatValue`,
`buildChartPayload`, `buildRawTablePayload`, `buildAggregatedTablePayload`,
`emptyMap`, and `has` were already plain JS with zero GAS-only API calls
before this feature existed — nothing about them was ever
Apps-Script-specific. `FILTER_REUSED_FUNCTIONS_JS` takes advantage of
that by serializing these nine functions' own source text
(`fn.toString()`) straight into the generated report's client script,
rather than hand-porting a second copy into `FILTER_CLIENT_JS` the way
`CHART_CLIENT_JS`/`TABLE_CLIENT_JS` reimplement their own draw/pagination
logic from scratch. This means a future change to any of these nine
functions — a new `agg`, a formatting fix, a new table mode — is
automatically correct in the browser too, with nothing to remember to
keep in sync. The one obligation this creates going forward: none of
these nine functions may ever grow a reference to a GAS-only global
(`BigQuery`, `DriveApp`, `Utilities`, etc.) — doing so would compile fine
and pass every Node test, then throw a `ReferenceError` only in the
browser, only on a report that uses `filters[]`, the first time a human
opens one. There is no automated check for this; it's a rule to remember
when touching any of these nine, not something `node test/run.js` can
catch.

## `reactsTo` intersects with the active filters, mirroring `applyHighlight`'s own matching rule

`FILTER_CLIENT_JS`'s `filteredRowsFor(reactsTo)` filters `reactsTo` down
to whichever of its own entries are currently active
(`has(activeFilters, f)`) and only touches the underlying rows on that
intersection — a block with none of its declared fields currently active
is left completely alone, not recomputed against the full unfiltered
set. This is the same "only the keys the block itself declares,
intersected with what's currently active" shape
`docs/superpowers/specs/2026-09-06-publish-chart-interactivity-design.md`'s
`selectionMatches` already established for cross-chart highlighting — see
`src/publish.md`'s note on that function for why getting this backwards
(recomputing whenever *any* filter changes, regardless of whether the
block declared that field) is the most likely way a future change here
quietly breaks a report where different blocks opt into different filter
subsets.

## The table replacer hook is small, always-on scaffolding — same shape as `CHART_CLIENT_JS`'s selection module

`TABLE_CLIENT_JS`'s per-section closure now always exposes
`window.__PUBLISH_TABLE_REPLACERS__[tableId]`, whether or not the report
declares `filters[]` at all — mirroring `CHART_CLIENT_JS`'s own selection
module (`currentSelection`/`applyHighlight`), which is likewise emitted
whenever any chart exists, regardless of whether any individual chart
opts into `linkKey`. The alternative (gating this hook's presence on
`config.filters.length`, so a filter-less report's `TABLE_CLIENT_JS`
stays byte-identical to before this feature) was rejected: pagination
state (`table`/`page`/`pageCount`) lives inside this one closure per
table section, and there is no way for `FILTER_CLIENT_JS` to hand it
freshly-filtered rows and have "Next"/"Previous" keep working correctly
afterward without either this hook or a second, independent closure
walking the same DOM a second time — and a second closure would hold its
own separate `page`/`table` state, silently desyncing from the first the
moment a filter changes (clicking "Next" would then page through stale,
pre-filter data). One shared closure, one small always-on hook, is the
only version of this that can't drift out of sync with itself.
```

- [ ] **Step 3: Verify the docs build/check step still passes**

```bash
./build.sh --check
node test/run.js
```

Expected: both pass unchanged (this task touches no `src/*.js` file, only `.md` docs).

- [ ] **Step 4: Commit**

```bash
git add docs/publish.md src/publish.md
git commit -m "docs: document publish's client-side filters[]"
```

---

### Task 5: `notsobigtests` Layer 2 fixture

**Files (in the sibling repo `/home/moschi/projetos/notsobig_org/notsobigtests`):**
- Modify: `js/08-fixtures-publish-targets.js` (append one new fixture)
- Modify: `js/28-tests-publish.js` (append one new test)
- Modify: `js/90-test-registry.js` (register the new test in the `publish` category; set `SRC_REF` to `feat/publish-filters`)

**Interfaces:**
- Consumes: `loadPublishOrders` (existing fixture — the same 6-row, two-category sample every other `publish` Layer 2 fixture already reuses), `extractPublishPayload(html)`, `runOne(name)`, `check(label, condition, evidence)`, `testLog(message)` (all existing helpers in this repo).
- Produces: a `testLog`-documented manual verification step for the human running this branch's Layer 2 tests.

- [ ] **Step 1: Add the fixture**

Open `js/08-fixtures-publish-targets.js` in the `notsobigtests` repo and add this new fixture at the end of the file, after `chartInteractivityPublish`:

```javascript
// filters[] (notsobiglib feat/publish-filters): one filter (category) on
// loadPublishOrders' already-proven 6-row sample (Beverages 60 total,
// Snacks 45 total - see loadPublishOrders' own comment). "Total revenue"
// and the bar chart and the raw table all opt in via reactsTo; "Orders"
// (a plain count) deliberately doesn't, so a human can visually confirm
// the opt-in boundary: it must stay at 6 no matter what the Category
// filter is set to, while everything else narrows to just that category.
var filtersPublish = {
  kind: 'publish',
  name: 'filtersPublish',
  dependsOn: ['loadPublishOrders'],
  source: { type: 'ref', ref: 'loadPublishOrders' },
  target: { type: 'drive', folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'publish-filters.html', upsertByName: true },
  filters: [{ field: 'category', label: 'Category' }],
  kpis: [
    { label: 'Total revenue', agg: 'sum', field: 'revenue', format: 'currency', reactsTo: ['category'] },
    { label: 'Orders', agg: 'count', format: 'integer' }
  ],
  charts: [
    { id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, reactsTo: ['category'] }
  ],
  tables: [
    {
      id: 'recent_orders', title: 'Recent orders', mode: 'raw', pageSize: 3,
      columns: [
        { field: 'order_id', label: 'Order' },
        { field: 'category', label: 'Category' },
        { field: 'revenue', label: 'Revenue', format: 'currency' }
      ],
      reactsTo: ['category']
    }
  ]
};
```

- [ ] **Step 2: Add the test**

Open `js/28-tests-publish.js` and add this new test after `testPublishChartInteractivityLinksPropagateToPayload`:

```javascript
// filters[] (notsobiglib feat/publish-filters): a GAS test can't change a
// dropdown or read a recomputed DOM value, so this only proves the
// pipeline reaches Drive with the filters bar, the raw rows, and the
// opt-in/opt-out filterableConfig split all correctly present - same
// ceiling notsobiglib's own Layer 1 tests already accept. The actual
// filter-change/recompute behavior is left to a human via testLog below.
function testPublishFiltersRenderAndPayloadReflectReactsToOptIn() {
  var result = runOne('filtersPublish');
  var html = DriveApp.getFileById(result.driveFileId).getBlob().getDataAsString();

  check('filters bar is present with a category select', html.indexOf('data-filter-field="category"') !== -1, html);
  check('category options include Beverages and Snacks', html.indexOf('<option value="Beverages">Beverages</option>') !== -1 && html.indexOf('<option value="Snacks">Snacks</option>') !== -1, html);

  var payload = extractPublishPayload(html);
  check('payload.rows carries all 6 raw rows for client-side filtering', payload.rows && payload.rows.length === 6, JSON.stringify(payload.rows));
  check('filterableConfig includes the reactsTo kpi/chart/table, and excludes the opted-out Orders kpi',
    payload.filterableConfig.kpis.length === 1 && payload.filterableConfig.charts.length === 1 && payload.filterableConfig.tables.length === 1,
    JSON.stringify(payload.filterableConfig));

  testLog('Filters report file id: ' + result.driveFileId + ' - open it in a browser and: '
    + '(1) set the Category filter to "Beverages" and confirm "Total revenue" updates to $60.00, the "By category" bar chart shows only Beverages, and "Recent orders" shows only Beverages rows, while "Orders" (no reactsTo) stays at 6; '
    + '(2) set it to "Snacks" and confirm the equivalent $45.00/Snacks-only behavior; '
    + '(3) set it back to "All" and confirm every block returns to its original page-load value.');
}
```

- [ ] **Step 3: Register the test and point `SRC_REF` at the feature branch**

Open `js/90-test-registry.js`. Add `testPublishFiltersRenderAndPayloadReflectReactsToOptIn` to the `publish` category's array (after `testPublishChartInteractivityLinksPropagateToPayload`):

```javascript
  publish: [
    testPublishGeneratesReportWithCorrectAggregates,
    testPublishRerunOverwritesSameFile,
    testPublishRefToNonBigQueryMoveTargetFails,
    testPublishTableBlockRendersRawAndAggregatedTables,
    testPublishCsvExportOffersDownloadAndGuardsFormulaInjection,
    testPublishChartTypesRenderMountPointsAndPayload,
    testPublishChartInteractivityLinksPropagateToPayload,
    testPublishFiltersRenderAndPayloadReflectReactsToOptIn
  ],
```

Then set:

```javascript
SRC_REF: 'feat/publish-filters',
```

(replacing the current `'feat/publish-table-csv-export'` — this is the per-run human step `notsobiglib`'s `CLAUDE.md` documents under "Pointing `notsobigtests` at the branch under test is a Script Property, not a code edit"; setting it in this file only affects the *default* baked into `setupScriptProperties()`, the actual Script Property in the Apps Script editor still needs setting by hand before running.)

- [ ] **Step 4: Deploy and report readiness**

```bash
cd /home/moschi/projetos/notsobig_org/notsobigtests
clasp push -f
```

Report to the user that the fixture is deployed and ready for a human to run `runAllTests('publish')` (or `runAllTests('testPublishFiltersRenderAndPayloadReflectReactsToOptIn')` directly) in the Apps Script editor, with `SRC_REF` set to `feat/publish-filters` in that project's Script Properties.

- [ ] **Step 5: Commit**

```bash
git add js/08-fixtures-publish-targets.js js/28-tests-publish.js js/90-test-registry.js
git commit -m "test: add publish filters[] fixture (notsobiglib feat/publish-filters)"
```

---

## After Task 5

This plan's code and docs are complete. Do **not** open PRs, push branches, or merge anything as part of executing this plan — per `notsobiglib`'s `CLAUDE.md` workflow (step 4, "Open the PR — stop before merge"), a human confirms the Apps Script Layer 2 test results before any PR is opened, exactly like every prior `publish` phase. Report the final state (branch name, commits, test status in both repos) and wait for the user's next instruction.
