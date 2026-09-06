# Publish Kind v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third node `kind`, `publish`, that reads an already-materialized BigQuery table (via a `move`-with-bigquery-target or `model` node referenced by name) and writes a self-contained `.html` dashboard (KPIs + one bar chart, linear layout) to Drive.

**Architecture:** New module `src/publish.js`, registered in `cli.js`'s `EXECUTORS` map exactly like `move`/`model`. Publish nodes are plain top-level `var`s (no registry-expansion hook, unlike `model`). Ref resolution (`source.ref` → `{projectId, dataset, table}`) reuses a primitive extracted out of `model.js`'s existing `buildRefResolver`, rather than duplicating the "is this a model or a bigquery-target move node" lookup a second time. `cli.js`'s executor-calling convention widens by one optional argument (the full discovered node list) so `publish.js` can resolve refs against nodes it didn't declare itself — `move`/`model` ignore the new argument, no behavior change for them.

**Tech Stack:** Google Apps Script (V8 runtime), `BigQuery` Advanced Service (`Tabledata.list`/`Tables.get`), `DriveApp`. Node (`vm` + plain `assert`) for Layer 1 tests, no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-05-publish-kind-design.md`

## Global Constraints

- Match existing code style exactly: `var`/`function` declarations, string concatenation with `+` (no template literals), no arrow functions, no `let`/`const`. This is ES5-style by convention throughout `src/*.js`, not a runtime limitation of the V8 Apps Script engine.
- Every thrown error message starts with `'publish(): '` (or `'model(): '` for the one model.js edit in Task 1), matching every other kind's convention (see `move()`'s `throw new Error('move(): config.source is required.')`).
- Zero new external dependencies, zero CDN, zero build step for the generated `.html` — everything inline (CSS, JS, JSON payload).
- `run`/`debug`/`sources` stay Layer 2 (real BigQuery/Drive, human-run via `notsobigtests`) — Layer 1 (Node) tests may call `cli('run --select ...')` only where the code path under test throws before reaching a live `BigQuery`/`DriveApp` call (see `test/incremental.test.js:34`'s existing precedent for this).
- `./build.sh --check` and `node test/run.js` must both pass before any task is considered done.

---

### Task 1: Extract `resolveRefLocation` out of `model.js`'s ref resolution

`model.js`'s `buildRefResolver` already knows how to resolve a `{{ ref('name') }}` name to a BigQuery location two ways (a declared model, or a `move` node with a bigquery target), but only ever hands back a pre-formatted backtick SQL string. `publish.js` (Task 2) needs the same two-way lookup as structured `{projectId, dataset, table}`. This task extracts that lookup into its own function, reusable by both, and closes an existing test gap (`{{ ref() }}` resolving to a bigquery-target `move` node has no test today).

**Files:**
- Modify: `src/model.js:1709-1719` (`indexMoveBigQueryTargets`), `src/model.js:1932-1942` (`buildRefResolver`)
- Modify: `src/model.md` (append a note after line 673)
- Create: `test/fixtures/model-ref-to-move-target.js`
- Create: `test/fixtures/orders_summary.html`
- Create: `test/ref-resolution.test.js`

**Interfaces:**
- Produces: `resolveRefLocation(refName, registry, moveBigQueryTargets)` — a new top-level function in `src/model.js`. Returns `{ projectId: string, dataset: string, table: string }` when `refName` matches a declared model or an indexed bigquery-target move node; returns `null` when it matches neither. Throws `'model(): "<refName>" is missing "<key>" - ..."` if it resolves to a model missing `projectId`/`dataset` (same message `qualifiedRelation` already throws today). Task 2's `publish.js` calls this directly (same build closure, no import).
- Consumes (unchanged by this task): `resolveModelConfig(name, registry)`, `qualifiedTableRef(projectId, dataset, table)` (`src/move.js:307`), `has(map, key)` (`src/cli.js:55`).

- [ ] **Step 1: Write the failing regression test for `{{ ref() }}` → bigquery-target move node**

Create `test/fixtures/model-ref-to-move-target.js`:

```javascript
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
```

Create `test/fixtures/orders_summary.html`:

```html
<!-- test/fixtures/orders_summary.html -->
<script type="text/sql">
select * from {{ ref('ordersRaw') }}
</script>
```

Create `test/ref-resolution.test.js`:

```javascript
// test/ref-resolution.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function testRefResolvesToMoveBigQueryTarget() {
  var ctx = harness.loadContext([fixture('model-ref-to-move-target.js')]);
  var report = ctx.NotSoBigData.cli('compile --select orders_summary');
  var node = report.nodes[0];
  assert.strictEqual(node.status, 'planned', 'expected compile to succeed, got: ' + JSON.stringify(node));
  assert.ok(
    node.compiledSql.indexOf('select * from `test-project.test_dataset.orders_raw`') !== -1,
    'expected {{ ref() }} to a bigquery-target move node to resolve to its qualified relation, got: ' + node.compiledSql
  );
}

module.exports = {
  testRefResolvesToMoveBigQueryTarget: testRefResolvesToMoveBigQueryTarget
};
```

- [ ] **Step 2: Run it to confirm it already passes**

Run: `./build.sh && node test/run.js`
Expected: `PASS  test/ref-resolution.test.js - testRefResolvesToMoveBigQueryTarget` — this path already works today (that's the point: it's a characterization test, pinning down current behavior before the refactor touches it), so it should be green immediately, not red. If it fails, stop and re-check the fixture against `src/model.md`'s "Resolution happens once, at discovery time" section before proceeding — the refactor steps below assume this passes first.

- [ ] **Step 3: Extract `resolveRefLocation`, update `indexMoveBigQueryTargets` and `buildRefResolver`**

In `src/model.js`, change `indexMoveBigQueryTargets` (currently at lines 1709-1719) to index structured locations instead of pre-formatted strings:

```javascript
function indexMoveBigQueryTargets(otherNodes) {
  var index = emptyMap();
  (otherNodes || []).forEach(function (node) {
    var target = node.kind === 'move' && node.config ? node.config.target : null;
    if (!target || target.type !== 'bigquery' || !target.projectId || !target.dataset || !target.table) {
      return;
    }
    index[node.name] = { projectId: target.projectId, dataset: target.dataset, table: target.table };
  });
  return index;
}
```

Immediately above `buildRefResolver` (currently at line 1932), add:

```javascript
// The two-source ref() lookup (declared model, or a bigquery-target move
// node) as structured data, extracted out of buildRefResolver() below so
// publish.js can resolve a source.ref to {projectId, dataset, table}
// without formatting it into a SQL relation string first - see
// src/model.md's "resolveRefLocation" note for why this crosses the
// model.js/publish.js boundary the same way resolveDriveWriteTarget()
// already crosses move.js/cli.js. Returns null (not a throw) when refName
// matches neither source - each caller has its own, more specific error
// message to raise (buildRefResolver's mentions {{ ref() }}; publish's
// mentions source.ref).
function resolveRefLocation(refName, registry, moveBigQueryTargets) {
  if (has(registry.models, refName)) {
    var config = resolveModelConfig(refName, registry);
    ['projectId', 'dataset'].forEach(function (key) {
      if (!config[key]) {
        throw new Error('model(): "' + refName + '" is missing "' + key + '" - set it on notsobigdataModels or on this model entry.');
      }
    });
    return { projectId: config.projectId, dataset: config.dataset, table: config.name };
  }
  if (has(moveBigQueryTargets, refName)) {
    return moveBigQueryTargets[refName];
  }
  return null;
}
```

Replace `buildRefResolver` (currently lines 1932-1942) with:

```javascript
function buildRefResolver(config, registry) {
  return function (refName) {
    var location = resolveRefLocation(refName, registry, config.moveRefTargets);
    if (!location) {
      throw new Error('model(): "' + config.name + '" has {{ ref(\'' + refName + '\') }}, which does not match a declared model or a move node with a bigquery target.');
    }
    return qualifiedTableRef(location.projectId, location.dataset, location.table);
  };
}
```

- [ ] **Step 4: Run the full suite to confirm nothing broke and the new test still passes**

Run: `./build.sh && node test/run.js`
Expected: every existing test still passes (in particular `test/compile.test.js`'s `testSetMacroSubstitutesIntoCompiledSql`, which exercises `buildRefResolver` via the models-registry branch), and `testRefResolvesToMoveBigQueryTarget` still passes.

- [ ] **Step 5: Document the extraction in `src/model.md`**

In `src/model.md`, immediately after the paragraph ending `"...The only real gap was resolveRef only ever trying the models registry."` (line 673, right before the `**Edge-building needed no changes at all.**` paragraph), insert:

```markdown
**`resolveRefLocation()` is the same lookup, extracted for a second caller
outside this file.** `publish.js`'s `report` kind (see
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`) needs to
resolve a `source.ref` to a BigQuery location too, but as structured
`{projectId, dataset, table}` rather than a formatted relation string —
it calls `BigQuery.Tabledata.list()` with the three components separately,
never runs SQL. Rather than duplicate the "declared model, or a
bigquery-target move node, or neither" lookup a second time,
`resolveRefLocation(refName, registry, moveBigQueryTargets)` holds it once;
`buildRefResolver()` above is now a thin wrapper that additionally formats
the result via `qualifiedTableRef()` for SQL substitution.
`indexMoveBigQueryTargets()` changed accordingly — it now indexes
structured locations, not pre-formatted strings, since `buildRefResolver()`
is the only caller that ever needed the string form and now formats it
itself.
```

- [ ] **Step 6: Commit**

```bash
git add src/model.js src/model.md test/fixtures/model-ref-to-move-target.js test/fixtures/orders_summary.html test/ref-resolution.test.js
git commit -m "refactor: extract resolveRefLocation from model.js's buildRefResolver

Structured {projectId, dataset, table} lookup, reusable by the upcoming
publish kind without duplicating the model-or-bigquery-move-node ref
resolution. Closes an existing test gap: ref() resolving to a
bigquery-target move node had no coverage before this."
```

---

### Task 2: Register the `publish` kind — discovery, selection, config validation, ref resolution

Makes `publish` a real, discoverable, selectable kind whose executor validates its own config and resolves `source.ref` against every other declared node — but does not yet touch BigQuery or Drive (that's Task 3). This is deliberately a complete, independently testable slice: after this task, `cli('list --select publish')` finds a `publish` node, and `cli('run --select <name>')` on a misconfigured one fails with a clear, specific error — all in Node, no live resource needed.

**Files:**
- Modify: `src/cli.js:27-30` (`EXECUTORS`), `src/cli.js:593` (`runNodes` signature), `src/cli.js:681` (the `EXECUTORS[node.kind](...)` call), `src/cli.js:1488` (the `runNodes(...)` call site)
- Modify: `build.sh:24` (`MODULES`)
- Create: `src/publish.js`
- Create: `test/fixtures/publish-nodes.js`
- Create: `test/publish.test.js`

**Interfaces:**
- Consumes: `resolveRefLocation`, `readModelsRegistry()`, `indexMoveBigQueryTargets(otherNodes)` (all `src/model.js`, `readModelsRegistry` pre-existing, others from Task 1); `has(map, key)`, `emptyMap()` (`src/cli.js`).
- Produces: `function publish(config, allNodes)` in `src/publish.js` — the `EXECUTORS.publish` entry. Task 3 extends this same function's body (does not change its signature). Also produces `validatePublishConfig(config)` and `resolvePublishSource(ref, allNodes)`, both called from `publish()` and each independently reusable if Task 3 needs to call them again.

- [ ] **Step 1: Write the failing discovery test**

Create `test/fixtures/publish-nodes.js`:

```javascript
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
```

Create `test/publish.test.js`:

```javascript
// test/publish.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function runOne(name) {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  return ctx.NotSoBigData.cli('run --select ' + name).results[0];
}

function testPublishNodeDiscoverableByKind() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var report = ctx.NotSoBigData.cli('list --select publish');
  var names = report.nodes.map(function (node) { return node.name; });
  assert.ok(names.indexOf('validPublish') !== -1, 'expected validPublish to be discoverable by kind "publish", got: ' + names.join(', '));
}

function testPublishSourceRefMustBeInDependsOn() {
  var result = runOne('missingDependsOnPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/missing from dependsOn/.test(result.error), 'expected a dependsOn error, got: ' + result.error);
}

function testPublishKpiRequiresFieldUnlessCount() {
  var result = runOne('badKpiPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/requires "field"/.test(result.error), 'expected a kpi field error, got: ' + result.error);
}

function testPublishRefMustResolveToBigQueryLocation() {
  var result = runOne('nonBigQueryRefPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/does not match a declared model or a move node with a bigquery target/.test(result.error), 'expected a ref-resolution error, got: ' + result.error);
}

function testPublishValidRefProceedsPastValidation() {
  var result = runOne('validPublish');
  // BigQuery isn't shimmed in test/harness.js (see its own comment) - a
  // valid publish node is expected to get all the way past config
  // validation and ref resolution, then fail on the live BigQuery call
  // this Node test never provides. Failing here with a BigQuery-shaped
  // error, not a config/ref error, is exactly what proves validation and
  // resolution both succeeded.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation+ref-resolution to pass and fail only at the BigQuery call, got: ' + result.error);
}

module.exports = {
  testPublishNodeDiscoverableByKind: testPublishNodeDiscoverableByKind,
  testPublishSourceRefMustBeInDependsOn: testPublishSourceRefMustBeInDependsOn,
  testPublishKpiRequiresFieldUnlessCount: testPublishKpiRequiresFieldUnlessCount,
  testPublishRefMustResolveToBigQueryLocation: testPublishRefMustResolveToBigQueryLocation,
  testPublishValidRefProceedsPastValidation: testPublishValidRefProceedsPastValidation
};
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/run.js`
Expected: all five `test/publish.test.js` tests FAIL — `publish` isn't a known kind yet, so `cli('list --select publish')` and `cli('run --select ...')` on any of these fixture nodes report the node as `ignored` / throw a selector error, not the specific validation errors these tests expect.

- [ ] **Step 3: Create `src/publish.js` with validation and ref resolution (no BigQuery/Drive yet)**

```javascript
// src/publish.js
//
// The `publish` kind: reads a table another node (move-with-bigquery-
// target, or model) already materialized, and writes a self-contained
// .html dashboard to Drive. See
// docs/superpowers/specs/2026-09-05-publish-kind-design.md for the full
// design. This file starts with config validation and ref resolution
// only - fetchTableRows/buildReportPayload/renderReportHtml land in a
// later change, once this much is in place and tested.

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
  (config.kpis || []).forEach(function (kpi) {
    if (!kpi.label || !kpi.agg) {
      throw new Error('publish(): every kpi needs "label" and "agg".');
    }
    if (kpi.agg !== 'count' && !kpi.field) {
      throw new Error('publish(): kpi "' + kpi.label + '" has agg "' + kpi.agg + '", which requires "field".');
    }
    if (['currency', 'integer', 'decimal'].indexOf(kpi.format) === -1) {
      throw new Error('publish(): kpi "' + kpi.label + '" has format "' + kpi.format + '" - expected "currency", "integer", or "decimal".');
    }
  });
  (config.charts || []).forEach(function (chart) {
    if (!chart.id || !chart.title || !chart.groupBy || !chart.metric || !chart.metric.agg) {
      throw new Error('publish(): every chart needs "id", "title", "groupBy", and "metric.agg".');
    }
  });
}

// Resolves config.source.ref against every other declared node -
// allNodes is cli.js's full discovered-node list (see runNodes()'s
// widened EXECUTORS call below), not just this node's own config, since
// the ref might name a model or a bare move node this node knows
// nothing else about. Reuses model.js's own registry read and move-
// bigquery-target index rather than re-scanning anything - same
// resolveRefLocation() both this and buildRefResolver() call.
function resolvePublishSource(ref, allNodes) {
  var registry = readModelsRegistry();
  var moveBigQueryTargets = indexMoveBigQueryTargets(allNodes || []);
  var location = resolveRefLocation(ref, registry, moveBigQueryTargets);
  if (!location) {
    throw new Error('publish(): source.ref "' + ref + '" does not match a declared model or a move node with a bigquery target.');
  }
  return location;
}

// The EXECUTORS.publish entry. allNodes is optional and only used to
// resolve source.ref - move()/model() ignore the same argument today
// (see cli.js's widened runNodes()), so this is the only kind that reads
// it so far.
function publish(config, allNodes) {
  validatePublishConfig(config);
  var location = resolvePublishSource(config.source.ref, allNodes);
  var rows = fetchTableRows(location.projectId, location.dataset, location.table);
  var payload = buildReportPayload(config, rows);
  var html = renderReportHtml(payload, config);
  var fileId = resolveDriveWriteTarget(config.target);
  var writtenFileId = writeDriveText(fileId, config.target, html, MimeType.HTML);
  return { rowCount: rows.length, driveFileId: writtenFileId };
}
```

`fetchTableRows`/`buildReportPayload`/`renderReportHtml` are referenced here but defined in Task 3 — that's fine (all modules share one closure, hoisted function declarations resolve regardless of declaration order across files), but it does mean the *validation* tests below already exercise the real `publish()` body, and the *valid-config* test below is expected to fail at whichever of these three calls comes first once Task 3 exists — in this task, before Task 3, calling `fetchTableRows` on `validPublish` throws `ReferenceError: fetchTableRows is not defined`, which still satisfies `testPublishValidRefProceedsPastValidation`'s `/BigQuery/` assertion only once Task 3 exists. For this task alone, temporarily relax that one assertion (see Step 4) and tighten it back in Task 3.

- [ ] **Step 4: Temporarily relax the not-yet-implemented assertion**

In `test/publish.test.js`, change `testPublishValidRefProceedsPastValidation`'s regex for this task only:

```javascript
  assert.ok(/BigQuery|fetchTableRows/.test(result.error), 'expected validation+ref-resolution to pass and fail only past that point, got: ' + result.error);
```

(Task 3 tightens this back to `/BigQuery/` once `fetchTableRows` exists and is the thing that actually throws.)

- [ ] **Step 5: Wire `publish` into `cli.js` and `build.sh`**

In `build.sh:24`, change:

```bash
MODULES="move.js model.js cli.js"
```

to:

```bash
MODULES="move.js model.js publish.js cli.js"
```

In `src/cli.js`, change the `EXECUTORS` map (currently lines 27-30):

```javascript
var EXECUTORS = {
  move: move,
  model: model,
  publish: publish
};
```

Change `runNodes`'s signature (currently line 593) to accept the full node list:

```javascript
function runNodes(nodesOrLevels, command, allNodes) {
```

Change the executor call inside it (currently line 681) to pass it through:

```javascript
      var result = EXECUTORS[node.kind](node.config, allNodes);
```

Change the call site in `cli()` (currently line 1488) to pass `discovered.nodes` — the full list, not just the selected/ordered subset, since a `publish` node's ref can name a node that exists in the project without being part of this run's selection:

```javascript
  var results = runNodes(nodesToRun, parsed.command, discovered.nodes);
```

- [ ] **Step 6: Rebuild and run the full suite**

Run: `./build.sh && node test/run.js`
Expected: every test passes, including all five in `test/publish.test.js`.

- [ ] **Step 7: Commit**

```bash
git add src/publish.js src/cli.js build.sh test/fixtures/publish-nodes.js test/publish.test.js
git commit -m "feat: register the publish kind with config validation and ref resolution

New kind, discoverable and selectable like move/model. Validates its own
config and resolves source.ref against every declared node (model or a
bigquery-target move node) before anything is fetched or written - the
actual BigQuery read and HTML/Drive write land in a follow-up change."
```

---

### Task 3: Fetch, aggregate, render, and write the report

Completes `publish()`: reads the resolved table via `BigQuery.Tabledata.list`, computes KPIs/chart data in JS, renders a self-contained HTML dashboard, and writes it to Drive. This is Layer 2 work by nature (real `BigQuery`/`DriveApp` calls) — per this repo's own "write the fixture before the `src/` change" rule for connector-facing work, the `notsobigtests` fixture description comes first, as a step below, before the implementation. Docs land in this same task, per this repo's "code and docs land in the same pass" convention (see `CLAUDE.md`'s "Working through a change" section) — this is the task that makes `publish` a real, usable kind end-to-end.

**Files:**
- Modify: `src/publish.js` (add `fetchTableRows`, `computeAggregate`, `formatValue`, `buildReportPayload`, `escapeHtml`, `renderBarChartSvg`, `REPORT_CSS`, `renderReportHtml`)
- Modify: `test/publish.test.js` (tighten Step 4's temporary regex back)
- Create: `docs/publish.md`
- Create: `src/publish.md`
- Modify: `README.md` (`## The two kinds` → `## The three kinds`, add a `publish` bullet)

**Interfaces:**
- Consumes: `resolveDriveWriteTarget(target)`, `writeDriveText(fileId, target, content, mimeType)` (`src/move.js:824`, `:837` — unchanged, already content/mimetype-agnostic).
- Produces: nothing further consumes this — it completes the `publish` kind's public behavior (`cli('run --select <publishNode>')`).

- [ ] **Step 1: Write the `notsobigtests` fixture description (Layer 2, no code yet)**

Before touching `src/publish.js` further, write (in a scratch note, or directly as the description of the companion `notsobigtests` PR this task's own PR will link to — see `CLAUDE.md`'s "Open the PR" step) what `cli('run --select <name>')` should do against a small real BigQuery table:

> Fixture: a `move` node loading a handful of rows (e.g. 5-10 order rows with `revenue` and `category` columns) into a real BigQuery table via a `bigquery` target. A `publish` node whose `source.ref` names that move node, one `kpis` entry (`{ label: 'Revenue', agg: 'sum', field: 'revenue', format: 'currency' }`), one `charts` entry (`{ id: 'by_category', type: 'bar', title: 'By category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }`), `target: { type: 'drive', folderId: <the shared notsobigdata test folder>, fileName: 'publish-smoke-test.html' }`. Expected result: `cli('run --select <publishNodeName>')` reports `status: 'success'`; the written `.html` file, opened in a browser, shows one KPI card with the correct summed revenue and one bar per category with the correct per-category sum. This is a create-mode Drive target (no `fileId`), so per `CLAUDE.md`'s "Drive-target tests that create a new file must clean up after themselves" rule, the fixture must assert on `report.results[0].result.driveFileId` and then trash that file.

This description is what actually gets written into the `notsobigtests` companion PR once this task's implementation is done — it is not automated in this repository, and is not part of `node test/run.js`.

- [ ] **Step 2: Implement `fetchTableRows`**

Append to `src/publish.js`:

```javascript
// Reads an entire BigQuery table via Tabledata.list (storage read, no
// query job, no query cost) rather than Jobs.query - see the design
// spec's "ref() - importar, não consultar" section for why this
// distinction matters. Tabledata.list's rows come back as {f: [{v},...]}
// - positional, not named - so the table's schema (fetched once via
// Tables.get) supplies the field names to zip each row against.
function fetchTableRows(projectId, dataset, table) {
  var schema = BigQuery.Tables.get(projectId, dataset, table).schema;
  var fieldNames = schema.fields.map(function (field) { return field.name; });
  var rows = [];
  var pageToken = null;
  do {
    var response = BigQuery.Tabledata.list(projectId, dataset, table, pageToken ? { pageToken: pageToken } : {});
    (response.rows || []).forEach(function (row) {
      var record = {};
      row.f.forEach(function (cell, index) {
        record[fieldNames[index]] = cell.v;
      });
      rows.push(record);
    });
    pageToken = response.pageToken;
  } while (pageToken);
  return rows;
}
```

- [ ] **Step 3: Implement KPI/chart aggregation**

Append to `src/publish.js`:

```javascript
function computeAggregate(rows, agg, field) {
  if (agg === 'count') {
    return rows.length;
  }
  if (agg === 'count_distinct') {
    var seen = emptyMap();
    var distinct = 0;
    rows.forEach(function (row) {
      var value = row[field];
      if (!has(seen, value)) {
        seen[value] = true;
        distinct += 1;
      }
    });
    return distinct;
  }
  var values = rows.map(function (row) { return Number(row[field]) || 0; });
  if (agg === 'sum') {
    return values.reduce(function (total, value) { return total + value; }, 0);
  }
  if (agg === 'avg') {
    return values.length ? values.reduce(function (total, value) { return total + value; }, 0) / values.length : 0;
  }
  throw new Error('publish(): unsupported agg "' + agg + '".');
}

// ponytail: fixed en-US/"$" formatting, no locale/currency-code config in
// v1's schema - add a "locale"/"currencyCode" config key if a real report
// needs anything else, rather than guessing at one now.
function formatValue(value, format) {
  if (format === 'integer') {
    return Math.round(value).toLocaleString('en-US');
  }
  if (format === 'currency') {
    return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildReportPayload(config, rows) {
  var kpis = (config.kpis || []).map(function (kpi) {
    var value = computeAggregate(rows, kpi.agg, kpi.field);
    return { label: kpi.label, value: value, formatted: formatValue(value, kpi.format) };
  });
  var charts = (config.charts || []).map(function (chart) {
    var groups = emptyMap();
    var order = [];
    rows.forEach(function (row) {
      var key = row[chart.groupBy];
      if (!has(groups, key)) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(row);
    });
    var data = order.map(function (key) {
      return { groupValue: key, total: computeAggregate(groups[key], chart.metric.agg, chart.metric.field) };
    });
    return { id: chart.id, title: chart.title, data: data };
  });
  return { kpis: kpis, charts: charts };
}
```

- [ ] **Step 4: Implement HTML rendering**

Append to `src/publish.js`:

```javascript
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One bar per chart.data entry, widths scaled against the largest total
// in the chart - a template-string SVG, not <canvas> and not a charting
// library, per the design spec's "zero dependency" principle.
function renderBarChartSvg(chart) {
  var width = 480;
  var barHeight = 28;
  var gap = 8;
  var labelWidth = 160;
  var maxTotal = chart.data.reduce(function (max, d) { return Math.max(max, d.total); }, 0) || 1;
  var height = chart.data.length * (barHeight + gap);
  var bars = chart.data.map(function (d, index) {
    var y = index * (barHeight + gap);
    var barWidth = Math.round((width - labelWidth) * (d.total / maxTotal));
    return '<text x="0" y="' + (y + barHeight / 2 + 4) + '" class="chart-label">' + escapeHtml(d.groupValue) + '</text>'
      + '<rect x="' + labelWidth + '" y="' + y + '" width="' + barWidth + '" height="' + barHeight + '" class="chart-bar"></rect>'
      + '<text x="' + (labelWidth + barWidth + 6) + '" y="' + (y + barHeight / 2 + 4) + '" class="chart-value">' + d.total.toLocaleString('en-US') + '</text>';
  }).join('');
  return '<svg viewBox="0 0 ' + width + ' ' + (height || barHeight) + '" width="100%" height="' + (height || barHeight) + '" role="img" aria-label="' + escapeHtml(chart.title) + '">' + bars + '</svg>';
}

// Fixed design tokens - see the design spec's "Design tokens" section.
// No per-report customization in v1: every published dashboard looks the
// same on purpose, the same way every model's compiled SQL follows one
// convention rather than a per-model style knob.
var REPORT_CSS = [
  ':root {',
  '  --paper: #FAF8F3; --paper-line: #E4E0D4; --ink: #1F2421; --ink-soft: #6B6A61;',
  '  --teal: #3F6659; --teal-soft: #DCE6E1; --coral: #B65A3C;',
  '  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;',
  '  --sans: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
  '}',
  'body { background: var(--paper); color: var(--ink); font-family: var(--sans); margin: 0; padding: 24px; }',
  '.kpis { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }',
  '.kpi { border: 1px solid var(--paper-line); padding: 12px 16px; }',
  '.kpi-label { font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; color: var(--ink-soft); }',
  '.kpi-value { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 24px; }',
  '.chart { border-top: 1px solid var(--paper-line); padding-top: 16px; margin-top: 16px; }',
  '.chart h2 { font-size: 14px; }',
  '.chart-label, .chart-value { font-family: var(--mono); font-size: 12px; fill: var(--ink); }',
  '.chart-bar { fill: var(--teal); }'
].join('\n');

function renderReportHtml(payload, config) {
  var kpiCards = payload.kpis.map(function (kpi) {
    return '<div class="kpi"><div class="kpi-label">' + escapeHtml(kpi.label) + '</div>'
      + '<div class="kpi-value">' + escapeHtml(kpi.formatted) + '</div></div>';
  }).join('');
  var chartSections = payload.charts.map(function (chart) {
    return '<section class="chart"><h2>' + escapeHtml(chart.title) + '</h2>' + renderBarChartSvg(chart) + '</section>';
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>' + escapeHtml(config.target.fileName) + '</title>'
    + '<style>' + REPORT_CSS + '</style></head><body>'
    + '<main><div class="kpis">' + kpiCards + '</div>' + chartSections + '</main>'
    + '<script>window.__PUBLISH_PAYLOAD__ = ' + JSON.stringify(payload) + ';</script>'
    + '</body></html>';
}
```

- [ ] **Step 5: Tighten the temporarily-relaxed test assertion from Task 2**

In `test/publish.test.js`, change `testPublishValidRefProceedsPastValidation` back to:

```javascript
function testPublishValidRefProceedsPastValidation() {
  var result = runOne('validPublish');
  // BigQuery isn't shimmed in test/harness.js (see its own comment) - a
  // valid publish node is expected to get all the way past config
  // validation and ref resolution, then fail on the live BigQuery call
  // this Node test never provides. Failing here with a BigQuery-shaped
  // error, not a config/ref error, is exactly what proves validation and
  // resolution both succeeded.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation+ref-resolution to pass and fail only at the BigQuery call, got: ' + result.error);
}
```

- [ ] **Step 6: Rebuild and run the full suite**

Run: `./build.sh && node test/run.js`
Expected: every test passes.

- [ ] **Step 7: Write `docs/publish.md`**

Create `docs/publish.md` following `docs/move.md`/`docs/model.md`'s structure (intro, `##` per concern, worked example):

```markdown
# `publish`

`publish` turns a table another node already materialized in BigQuery
(a `move` node with a `bigquery` target, or a `model`) into a self-
contained `.html` dashboard file in Drive: KPI numbers and one bar
chart, computed in JS at generation time and embedded inline. No CDN,
no build step, no server — the file works standalone once downloaded.

`publish` never runs its own SQL or query job. It reads the referenced
table's stored data directly via BigQuery's `Tabledata.list` (a storage
read, not a query — no query cost), so any join, filter, or pre-
aggregation the dashboard needs must already be done by the `move`/
`model` node it references.

## Config

```javascript
var salesPublish = {
  kind: 'publish',
  dependsOn: ['dailyRevenueModel'],           // must include source.ref
  source: { type: 'ref', ref: 'dailyRevenueModel' },
  target: { type: 'drive', folderId: props.REPORTS_FOLDER, fileName: 'sales.html' },
  kpis: [
    { label: 'Total revenue', agg: 'sum', field: 'revenue', format: 'currency' },
    { label: 'Orders', agg: 'count_distinct', field: 'order_id', format: 'integer' }
  ],
  charts: [
    { id: 'by_category', type: 'bar', title: 'By category',
      groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' } }
  ]
};
```

- `source.ref` — the name of a `move` node (with a `bigquery` target) or
  a `model` node. `dependsOn` must list it explicitly; `publish()`
  validates this and fails loudly if it doesn't.
- `kpis[]` — `agg` is `sum`/`avg`/`count`/`count_distinct`; `field` is
  required unless `agg` is `count`. `format` is `currency`/`integer`/
  `decimal` (fixed `en-US`/`$` formatting in this version).
- `charts[]` — one `bar` chart per entry, aggregated by `groupBy` in JS
  (never in SQL, never in the browser).
- `target` — a Drive file, same shape as `move`'s drive target
  (`folderId` + `fileName`).

## What's not here yet

Filters, drill-down, a `table` block, per-block `source` overrides,
cross-file navigation, a `board` tree layout, and CSV export are all
planned but not implemented — see
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
direction" section.
```

- [ ] **Step 8: Write `src/publish.md`**

Create `src/publish.md`:

```markdown
# publish.js dev notes

Companion to `docs/publish.md` (user-facing config reference) — this
file is for whoever changes this module next, not a user-facing doc.

## Ref resolution reuses model.js's primitive, not a fresh scan

`resolvePublishSource()` calls `model.js`'s `readModelsRegistry()`,
`indexMoveBigQueryTargets()`, and `resolveRefLocation()` directly (same
build closure, no import needed — see `CLAUDE.md`'s "One file to
install, three files to author"). `resolveRefLocation()` was extracted
out of `model.js`'s own `buildRefResolver()` specifically so this module
wouldn't duplicate the "declared model, or a bigquery-target move node,
or neither" lookup a second time — see `src/model.md`'s
"`resolveRefLocation()` is the same lookup" note for the other side of
this.

## `allNodes` — the one EXECUTORS signature change this kind needed

Every other kind's executor only ever needed its own `config`.
`publish()` is the first that needs to look up *other* declared nodes
(to resolve `source.ref`), so `cli.js`'s `runNodes()` now calls
`EXECUTORS[node.kind](node.config, allNodes)` — `allNodes` is
`discoverNodes()`'s full flat node list, from before selection/ordering
narrowed it down, since a ref can name a node outside this run's
`--select`. `move`/`model` ignore the extra argument; no behavior change
for either.

## Why validation happens inside `publish()`, not at discovery time

Unlike `model`, a `publish` node's `dependsOn` is hand-written by its
author, not derived (same as `move`) — nothing about building the
dependency graph needs to know a `publish` node's config is valid before
ordering runs. So config validation (`validatePublishConfig`) happens
lazily, inside the executor, the same way `move()`'s own
`if (!config || !config.source) throw` only fires at `run` time, not at
`list`. This is why `cli('list --select publish')` doesn't itself catch
a bad `publish` config — only `cli('run ...')` does, exactly like
`move`.

## Testing split

Config validation and ref resolution are pure/cheap enough to test in
Node via `cli('run --select ...')` on a fixture designed to fail before
reaching a live call (see `test/publish.test.js` and
`test/incremental.test.js:34`'s precedent for this pattern). The actual
BigQuery read, aggregation-against-real-rows, and Drive write are Layer
2 only — see `docs/superpowers/plans/2026-09-05-publish-kind-v1.md`'s
Task 3 for the fixture-first `notsobigtests` companion this needs.
```

- [ ] **Step 9: Update README**

In `README.md`, change the heading at line 147 from `## The two kinds` to `## The three kinds`, and add a third bullet after the `model` bullet (currently ending at line 160):

```markdown
- **`publish`** — turns a table a `move`/`model` node already
  materialized in BigQuery into a self-contained `.html` dashboard in
  Drive: KPIs and a bar chart, computed in JS, no CDN, no build step.
  Reads via `Tabledata.list` (no query job, no query cost) — never runs
  its own SQL. Full config → **[docs/publish.md](docs/publish.md)**.
```

- [ ] **Step 10: Final full-suite check**

Run: `./build.sh --check && node test/run.js`
Expected: `build.sh: src.js is up to date.` and every test passes.

- [ ] **Step 11: Commit**

```bash
git add src/publish.js test/publish.test.js docs/publish.md src/publish.md README.md
git commit -m "feat: implement publish's BigQuery read, aggregation, and HTML render

Completes the publish kind: Tabledata.list read, JS-side KPI/chart
aggregation, self-contained HTML render (inline CSS/JS/JSON, SVG bar
chart, no CDN), written to Drive via move.js's existing
writeDriveText. Docs added for both audiences (docs/publish.md,
src/publish.md) and linked from README."
```

---

## Self-Review

**Spec coverage:** §2 schema (Task 2/3 config shape) ✓. §3 registration (Task 2 Step 5) ✓. §4 ref-resolution extraction (Task 1) ✓, including the non-BigQuery-move-target error case (Task 2's `nonBigQueryRefPublish` test) ✓. §5 validation, matching model's lax precedent (Task 2 Step 3's `validatePublishConfig`) ✓. §6 execution flow, all five steps (Task 2 Step 3's `publish()` body + Task 3) ✓, including the design tokens (Task 3 Step 4's `REPORT_CSS`) ✓. §7 testing split (Layer 1 in Task 2, Layer 2 fixture-first in Task 3 Step 1) ✓. §8 docs/build impact (Task 2 Step 5's `build.sh`, Task 3 Steps 7-9) ✓.

**Placeholder scan:** no TBD/TODO; every step has runnable code or an exact, quoted doc addition.

**Type consistency:** `publish(config, allNodes)`'s signature is introduced in Task 2 Step 3 and never changes in Task 3 (only the function body grows) — checked against Task 2's own Interfaces block. `resolveRefLocation(refName, registry, moveBigQueryTargets)`'s parameter order and return shape (`{projectId, dataset, table}` or `null`) is identical everywhere it's called (Task 1's `buildRefResolver`, Task 2's `resolvePublishSource`). `fetchTableRows(projectId, dataset, table)` is referenced in Task 2 Step 3 before it's defined in Task 3 Step 2 with the exact same parameter order and name — flagged explicitly in Task 2 Step 3's own text so an implementer isn't surprised by the temporary `ReferenceError`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-05-publish-kind-v1.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
