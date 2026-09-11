# `cli('docs')` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `cli('docs')`, a new `cli()` command that writes one self-contained `.html` file describing the whole discovered project (every node's kind, `dependsOn`, and whatever each kind already exposes) to Drive — a dbt-`docs`-style project doc site, reusing `publish.js`'s design system (CSS, dark mode, the d3-hierarchy board) for the visual DAG.

**Architecture:** A new `src/docs.js` module builds a pure, synchronous payload from the already-discovered node list (`buildDocsPayload`), renders it to HTML by calling straight into `publish.js`'s existing CSS/board-script constants (`renderDocsHtml`), then writes it via `move.js`'s existing Drive-write helpers (`runDocsCommand`). `src/cli.js` gains the `docs` command (in `COMMANDS`, `parseCommand`, and the main `cli()` dispatch) and one flag, `--folder-id`. `publish.js`'s board-layout client script gets two additive, backward-compatible lines so it can position/draw a general DAG (multiple `dependsOn` per node), not just the single-parent `relatesTo` tree `publish` uses today.

**Tech Stack:** Plain ES5 (GAS-compatible), no new dependency — reuses the D3 bundle `publish.js` already loads. Node `vm`-based Layer 1 tests (`test/harness.js`), same pattern as every other module.

**Spec:** `docs/superpowers/specs/2026-09-11-docs-command-design.md`

## Global Constraints

- No new node `kind` — `EXECUTORS` is untouched. `docs` is a whole-project command, not a per-node one.
- No new declarative config fields on `move`/`model`/`publish` — every value `docs` reports already exists on a discovered node's `config`.
- `docs` never touches BigQuery/Sheets; its only live-resource touch is the final Drive write.
- Output filename is fixed: `'notsobigdata-docs.html'`, written with `upsertByName: true` (overwrites the same file every run).
- Any change to `src/*.js` requires `./build.sh` before `node test/run.js` — the Node harness loads the committed `src.js`, not the `src/` modules directly.
- Commit messages: Conventional Commits (`type: description`), each ending with:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  ```
- Work happens on `feat/docs-command` (already created off `release/16`) — never commit to `main`/`release/16` directly.

---

## Task 1: Rename `resolveManifestFolderId` → `resolveDefaultDriveFolderId`

Pure rename, no behavior change — `resolveManifestFolderId` (`src/cli.js:783`) resolves "given folderId, use it; otherwise use the script's own parent Drive folder, or Drive root," which is no longer manifest-specific once `docs` calls it too (Task 5). Renaming now, isolated from the new feature's own diff, keeps later tasks' diffs about `docs` only.

**Files:**
- Modify: `src/cli.js:783` (function name), `src/cli.js:897` and `src/cli.js:899` (its two call sites inside `writeManifestFile`)

**Interfaces:**
- Produces: `resolveDefaultDriveFolderId(folderId)` — same signature and behavior `resolveManifestFolderId` had, callable by any module sharing the build closure (Task 5 calls it from `runDocsCommand`).

- [ ] **Step 1: Rename the function declaration**

In `src/cli.js:783`:

```js
// was: function resolveManifestFolderId(folderId) {
function resolveDefaultDriveFolderId(folderId) {
  if (folderId) {
    return folderId;
  }
  var scriptFile = DriveApp.getFileById(ScriptApp.getScriptId());
  var parents = scriptFile.getParents();
  return parents.hasNext() ? parents.next().getId() : DriveApp.getRootFolder().getId();
}
```

- [ ] **Step 2: Update both call sites in `writeManifestFile`**

In `src/cli.js:897` and `src/cli.js:899` (inside `writeManifestFile`), replace both:

```js
var folderId = resolveManifestFolderId(config.folderId);
// ...
var otherFolderId = resolveManifestFolderId(otherConfig.folderId);
```

with:

```js
var folderId = resolveDefaultDriveFolderId(config.folderId);
// ...
var otherFolderId = resolveDefaultDriveFolderId(otherConfig.folderId);
```

- [ ] **Step 3: Rebuild and run the full existing suite to confirm zero regressions**

```bash
./build.sh
node test/run.js
```

Expected: same pass count as before this change (a pure rename touches no test assertions — `src/cli.md`'s own text at line 157 mentions the old name in prose only, not code, so it's untouched here).

- [ ] **Step 4: Commit**

```bash
git add src/cli.js src.js
git commit -m "$(cat <<'EOF'
refactor: rename resolveManifestFolderId to resolveDefaultDriveFolderId

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `buildDocsPayload`/`buildDocsDetail` — the pure data model

New `src/docs.js`. Turns an already-discovered node list into a plain-object payload, reading only fields each kind's config already carries. No Drive/BigQuery/DOM — this is Layer-1-testable exactly like `compileModel`.

**Files:**
- Create: `src/docs.js`
- Create: `test/fixtures/docs-nodes.js`, `test/fixtures/docs-orders.html`, `test/fixtures/docs-broken-model.html`
- Create: `test/docs.test.js`
- Modify: `build.sh:23` (`MODULES` manifest)

**Interfaces:**
- Produces: `buildDocsPayload(nodes)` → `{ name, kind, dependsOn, detail }[]`; `buildDocsDetail(node)` → a kind-shaped plain object (used directly by Task 4's `renderDocsHtml`).
- Consumes: `node.name`/`node.kind`/`node.dependsOn`/`node.config` (the shape `discoverNodes()` already produces, see `src/cli.js:243`); `compileModel(config)` from `model.js:2101` (returns a compiled SQL string, throws on invalid SQL/refs).

- [ ] **Step 1: Add the module to `build.sh`'s manifest**

In `build.sh:23`, kind modules first then the cli layer — `docs.js` sits with the cli layer, right before `cli.js` (it's a whole-project command, not a node kind):

```bash
MODULES="move.js model.js publish.js docs.js cli.js"
```

- [ ] **Step 2: Write the fixture nodes**

Model SQL lives in its own `.html` file, one `<script type="text/sql">` tag per model — this is how every existing model fixture works (`test/fixtures/model-registry.js`'s `stg_orders: { sqlFile: 'stg_orders.html' }`, read via `test/harness.js`'s `HtmlService.createHtmlOutputFromFile` shim), **not** an inline `sql` string on the registry entry. `resolveModelConfig` (`src/model.js:605`) merges every field of a registry entry straight into that model's `config` (`Object.keys(entry).forEach(function (key) { config[key] = entry[key]; })`, `src/model.js:623`), so `materialized`/`tests` go directly on the entry.

`test/fixtures/docs-nodes.js` — a small multi-parent DAG on purpose (`orders` depends on both `rawOrders` and `rawCustomers`), a model with a deliberately broken `{{ ref() }}` (to exercise the discovery-error path — see Step 3 below), and one `publish` node:

```js
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
```

Two companion `.html` fixtures, same format as `test/fixtures/stg_orders.html`:

`test/fixtures/docs-orders.html`:

```html
<!-- test/fixtures/docs-orders.html -->
<script type="text/sql">
select * from {{ ref("rawOrders") }} join {{ ref("rawCustomers") }} using (customer_id)
</script>
```

`test/fixtures/docs-broken-model.html`:

```html
<!-- test/fixtures/docs-broken-model.html -->
<script type="text/sql">
select * from {{ ref("doesNotExist") }}
</script>
```

`orders`'s `dependsOn` comes from its two `{{ ref() }}` calls (via `model.js`'s `extractRefDependencies`), not a hand-written array — this is what proves `buildDocsPayload` sees a real multi-parent edge, not one this fixture declared by hand.

- [ ] **Step 3: Write the failing payload tests**

`test/docs.test.js`:

```js
// test/docs.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function loadPayload() {
  var ctx = harness.loadContext([fixture('docs-nodes.js')]);
  return ctx.NotSoBigData.__test.buildDocsPayload(ctx.NotSoBigData.__test.discoverNodesForTest());
}

function testDocsPayloadCarriesMoveConnectorTypes() {
  var payload = loadPayload();
  var rawOrders = payload.filter(function (n) { return n.name === 'rawOrders'; })[0];
  assert.ok(rawOrders, 'expected a rawOrders entry in the payload');
  assert.strictEqual(rawOrders.kind, 'move');
  assert.deepStrictEqual(rawOrders.detail, { sourceType: 'sheets', targetType: 'bigquery' });
}

function testDocsPayloadCompilesModelSqlAndCapturesMultipleDependsOn() {
  var payload = loadPayload();
  var orders = payload.filter(function (n) { return n.name === 'orders'; })[0];
  assert.ok(orders, 'expected an orders entry in the payload');
  assert.deepStrictEqual(orders.dependsOn.slice().sort(), ['rawCustomers', 'rawOrders']);
  assert.strictEqual(orders.detail.materialized, 'table');
  assert.ok(/join/.test(orders.detail.compiledSql), 'expected the compiled SQL to contain the join, got: ' + orders.detail.compiledSql);
  assert.deepStrictEqual(orders.detail.tests, [{ check: 'not_null', column: 'customer_id' }]);
}

// brokenModel's {{ ref("doesNotExist") }} fails at *discovery* time
// (model.js's expandModelNodes() already validates every ref() name -
// see src/cli.js:568's node.discoveryError check, and model.js:1881
// where expandModelNodes sets it), before docs ever sees a real config -
// the node's config is still the discovery-time placeholder { name: name },
// not something buildDocsDetail's model branch could safely read
// materialized/projectId/dataset/tests off. buildDocsPayload must check
// node.discoveryError first and short-circuit past the kind-specific
// branches entirely for that node.
function testDocsPayloadSurfacesDiscoveryErrorWithoutCrashing() {
  var payload = loadPayload();
  var broken = payload.filter(function (n) { return n.name === 'brokenModel'; })[0];
  assert.ok(broken, 'expected a brokenModel entry in the payload');
  assert.ok(/doesNotExist/.test(broken.detail.discoveryError), 'expected the ref-resolution discoveryError, got: ' + JSON.stringify(broken.detail));
  assert.ok(!broken.detail.compiledSql, 'expected no compiledSql for a node that never reached compileModel');
}

function testDocsPayloadCarriesPublishStructureOnly() {
  var payload = loadPayload();
  var dashboard = payload.filter(function (n) { return n.name === 'salesDashboard'; })[0];
  assert.ok(dashboard, 'expected a salesDashboard entry in the payload');
  assert.deepStrictEqual(dashboard.detail.charts, [{ id: 'by_month', title: 'Revenue by month', type: 'bar' }]);
  assert.deepStrictEqual(dashboard.detail.tables, []);
}

module.exports = {
  testDocsPayloadCarriesMoveConnectorTypes: testDocsPayloadCarriesMoveConnectorTypes,
  testDocsPayloadCompilesModelSqlAndCapturesMultipleDependsOn: testDocsPayloadCompilesModelSqlAndCapturesMultipleDependsOn,
  testDocsPayloadSurfacesDiscoveryErrorWithoutCrashing: testDocsPayloadSurfacesDiscoveryErrorWithoutCrashing,
  testDocsPayloadCarriesPublishStructureOnly: testDocsPayloadCarriesPublishStructureOnly
};
```

This test calls two not-yet-real helpers, `ctx.NotSoBigData.__test.buildDocsPayload` and `ctx.NotSoBigData.__test.discoverNodesForTest` — `cli()`'s public surface is only `{ cli: cli }` (`build.sh`'s footer), so a Layer 1 test needs a narrow, explicit back door to reach a pure internal function directly. Step 5 adds exactly that back door, scoped to test-only use (never called by `cli()` itself).

- [ ] **Step 4: Run the tests to verify they fail**

```bash
./build.sh
node test/run.js
```

Expected: `FAIL test/docs.test.js - testDocsPayloadCarriesMoveConnectorTypes - Cannot read properties of undefined (reading 'buildDocsPayload')` (and the same shape for the other three) — `src/docs.js` doesn't exist yet.

- [ ] **Step 5: Implement `buildDocsPayload`/`buildDocsDetail`, and the test-only back door**

`src/docs.js`:

```js
// src/docs.js
//
// Turns an already-discovered node list into a plain-object payload
// describing the whole project - v1 documents only what cli() can
// already see (no new description/column-doc fields), see
// docs/superpowers/specs/2026-09-11-docs-command-design.md.
function buildDocsPayload(nodes) {
  return nodes.map(function (node) {
    // A node.discoveryError (set by model.js's expandModelNodes() when a
    // {{ ref() }}/{{ var() }} name can't be resolved, src/model.js:1881)
    // means node.config is still the discovery-time placeholder
    // { name: name } - src/cli.js:568 already special-cases this before
    // ever calling an EXECUTORS entry, and buildDocsDetail's kind
    // branches must never read materialized/projectId/source/target off
    // that placeholder. Short-circuit here, before dispatching by kind.
    var detail = node.discoveryError ? { discoveryError: node.discoveryError } : buildDocsDetail(node);
    return { name: node.name, kind: node.kind, dependsOn: node.dependsOn || [], detail: detail };
  });
}

// Kind-specific detail, reading only fields the node's own config
// already carries. Wrapped per-kind rather than one generic dump so each
// kind's detail stays small and reviewable - see the design spec's §3.
// Only ever called for a node with no discoveryError (see buildDocsPayload).
function buildDocsDetail(node) {
  if (node.kind === 'move') {
    return {
      sourceType: node.config.source && node.config.source.type,
      targetType: node.config.target && node.config.target.type
    };
  }
  if (node.kind === 'model') {
    var detail = {
      materialized: node.config.materialized || 'view',
      projectId: node.config.projectId,
      dataset: node.config.dataset,
      tests: (node.config.tests || []).map(function (test) {
        return test.check ? { check: test.check, column: test.column } : { custom: true };
      })
    };
    // compileModel() is the exact function cli('compile') already calls
    // (src/model.js:2101) - never reimplement {{ ref() }}/macro
    // resolution here. A bad ref()/var() name is already caught earlier,
    // at discovery (see buildDocsPayload's discoveryError check above) -
    // this try/catch is defense-in-depth for the rarer case compileModel
    // itself still throws on a node that passed discovery (the same
    // "compileModelSql() re-validates at run time too" posture
    // CLAUDE.md/model.md already describe), not something with its own
    // dedicated failing fixture here.
    try {
      detail.compiledSql = compileModel(node.config);
    } catch (error) {
      detail.compiledSqlError = error.message;
    }
    return detail;
  }
  if (node.kind === 'publish') {
    return {
      layoutType: (node.config.layout && node.config.layout.type) || 'linear',
      charts: (node.config.charts || []).map(function (chart) {
        return { id: chart.id, title: chart.title, type: chart.type };
      }),
      tables: (node.config.tables || []).map(function (table) {
        return { id: table.id, title: table.title, mode: table.mode };
      })
    };
  }
  return {};
}
```

The test-only back door goes in `src/cli.js`'s footer area — find where `build.sh` writes `return { cli: cli };` and change it to also expose `__test`, gated so it never becomes part of the real public surface described in `CLAUDE.md`'s "One public entrypoint: cli()":

```js
// was: return { cli: cli };
return {
  cli: cli,
  __test: { buildDocsPayload: buildDocsPayload, discoverNodesForTest: function () { return discoverNodes().nodes; } }
};
```

(`build.sh`'s footer-writing code itself, not `src/cli.js`, actually emits this line — see `build.sh`'s `build()` function's `echo "  return {"`/`echo "    cli: cli"`/`echo "  };"` block. Update those three `echo` lines to emit the block above instead.)

- [ ] **Step 6: Run the tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: all four new tests `PASS`, everything else still passes.

- [ ] **Step 7: Commit**

```bash
git add src/docs.js src/cli.js build.sh test/docs.test.js test/fixtures/docs-nodes.js test/fixtures/docs-orders.html test/fixtures/docs-broken-model.html src.js
git commit -m "$(cat <<'EOF'
feat: add buildDocsPayload/buildDocsDetail, the docs command's pure data model

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `publish.js`'s board script learns to draw a general DAG

Two additive, backward-compatible one-line changes to `BOARD_LAYOUT_CLIENT_JS` (`src/publish.js:1439`) plus one additive line in `renderReportHtml` (`src/publish.js:1622`), so the same client script can position a general `dependsOn` DAG (Task 4's `docs`), not just `publish`'s single-parent `relatesTo` tree — with zero behavior change to `publish`'s own shipped board output.

**Files:**
- Modify: `src/publish.js:1441-1442`, `src/publish.js:1462`, `src/publish.js:1648-1651`
- Test: `test/publish.test.js` (new tests, appended)

**Interfaces:**
- Produces: two new client-side globals a board-mode report's script sets, `window.__BOARD_NODES__` (`{id, relatesTo}[]`, used for `d3.stratify()` positioning) and an optional `window.__BOARD_EDGES__` (`{from, to}[]`, used for edge-drawing when present). Task 4's `renderDocsHtml` sets both explicitly.

- [ ] **Step 1: Write the failing regression + presence tests**

Append to `test/publish.test.js` (reuses `fixture`/`shimBigQueryAndDrive`/`extractPayload` already defined earlier in that file):

```js
// Task 3 (docs command): BOARD_LAYOUT_CLIENT_JS now reads window.__BOARD_NODES__
// instead of deriving blocks from window.__PUBLISH_PAYLOAD__ inline, and
// falls back to relatesTo-derived edges only when window.__BOARD_EDGES__
// isn't set - additive changes that must leave publish's own board output
// unchanged. See docs/superpowers/specs/2026-09-11-docs-command-design.md §4.
function testPublishBoardEmitsBoardNodesGlobalAndKeepsRelatesToEdgesByDefault() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed board run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/window\.__BOARD_NODES__ = window\.__PUBLISH_PAYLOAD__\.charts\.concat\(window\.__PUBLISH_PAYLOAD__\.tables\)\.map\(/.test(html), 'expected the new __BOARD_NODES__ global to be derived from the existing payload, got: ' + html);
  assert.ok(/var blocks = window\.__BOARD_NODES__;/.test(html), 'expected the layout script to read window.__BOARD_NODES__, got: ' + html);
  assert.ok(/var edges = window\.__BOARD_EDGES__ \|\| blocks\.filter\(function \(b\) \{ return b\.relatesTo; \}\)/.test(html), 'expected the relatesTo-derived edge fallback to remain byte-identical, got: ' + html);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
./build.sh
node test/run.js
```

Expected: `FAIL test/publish.test.js - testPublishBoardEmitsBoardNodesGlobalAndKeepsRelatesToEdgesByDefault - ...` (the `__BOARD_NODES__`/`window.__BOARD_EDGES__ ||` strings don't exist yet).

- [ ] **Step 3: Make the two additive changes**

In `src/publish.js:1441-1442`, inside `BOARD_LAYOUT_CLIENT_JS`:

```js
// was:
'  var payload = window.__PUBLISH_PAYLOAD__;',
'  var blocks = payload.charts.concat(payload.tables);',
// becomes:
'  var blocks = window.__BOARD_NODES__;',
```

In `src/publish.js:1462`:

```js
// was:
'  var edges = blocks.filter(function (b) { return b.relatesTo; }).map(function (b) { return { from: b.relatesTo, to: b.id }; });',
// becomes:
'  var edges = window.__BOARD_EDGES__ || blocks.filter(function (b) { return b.relatesTo; }).map(function (b) { return { from: b.relatesTo, to: b.id }; });',
```

In `src/publish.js:1648-1651`, inside `renderReportHtml`, add the new derived global right before appending the layout script:

```js
// was:
if (isBoardLayout) {
  script += BOARD_LAYOUT_CLIENT_JS;
  script += BOARD_CLIENT_JS;
}
// becomes:
if (isBoardLayout) {
  script += 'window.__BOARD_NODES__ = window.__PUBLISH_PAYLOAD__.charts.concat(window.__PUBLISH_PAYLOAD__.tables).map(function (b) { return { id: b.id, relatesTo: b.relatesTo }; });';
  script += BOARD_LAYOUT_CLIENT_JS;
  script += BOARD_CLIENT_JS;
}
```

- [ ] **Step 4: Run the full suite to verify the new tests pass and nothing regressed**

```bash
./build.sh
node test/run.js
```

Expected: the new test passes; every pre-existing `publish.test.js` board test (`testPublishBoardLayoutClientJsEmittedWithCorrectNodeSize`, `testPublishBoardExposesBoundsAndRedrawsEdgesOnResize`, etc.) still passes unchanged — they assert on `d3.stratify()`, `__board_root__`, `redrawEdges`, `ResizeObserver`, none of which this change touches.

- [ ] **Step 5: Commit**

```bash
git add src/publish.js test/publish.test.js src.js
git commit -m "$(cat <<'EOF'
feat: let publish's board layout script draw a general DAG via optional window.__BOARD_EDGES__

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `renderDocsHtml` — the doc-site template

Builds on Task 2's payload and Task 3's board-script hooks to produce the full `.html` string, reusing `publish.js`'s CSS/theme-toggle/D3-script/board-canvas constants directly (same build closure, no export).

**Files:**
- Modify: `src/docs.js` (add `renderDocsHtml`, `renderDocsNodeSection`, `renderDocsDetailHtml`, `DOCS_CSS`)
- Modify: `build.sh` (the `build()` function's footer `echo` lines — extends the `__test` back door Task 2 added with `renderDocsHtml`)
- Modify: `test/docs.test.js` (append)

**Interfaces:**
- Consumes: `buildDocsPayload`'s output shape (Task 2); `REPORT_CSS`, `BOARD_CSS`, `THEME_TOGGLE_HTML`, `THEME_TOGGLE_JS`, `THEME_INIT_JS`, `BOARD_LAYOUT_CLIENT_JS`, `BOARD_CLIENT_JS`, `D3_CDN_URL`, `D3_CDN_INTEGRITY`, `escapeHtml` — all from `src/publish.js`, unqualified (same closure).
- Produces: `renderDocsHtml(payload)` → a complete `<!doctype html>...` string, used by Task 5's `runDocsCommand`.

- [ ] **Step 1: Write the failing rendering tests**

Append to `test/docs.test.js`:

```js
function renderDocsHtmlFor(nodeNames) {
  var ctx = harness.loadContext([fixture('docs-nodes.js')]);
  var nodes = ctx.NotSoBigData.__test.discoverNodesForTest().filter(function (n) {
    return !nodeNames || nodeNames.indexOf(n.name) !== -1;
  });
  var payload = ctx.NotSoBigData.__test.buildDocsPayload(nodes);
  return ctx.NotSoBigData.__test.renderDocsHtml(payload);
}

function testDocsHtmlRendersOneBoardNodePerDiscoveredNode() {
  var html = renderDocsHtmlFor(['rawOrders', 'rawCustomers', 'orders']);
  ['rawOrders', 'rawCustomers', 'orders'].forEach(function (name) {
    assert.ok(html.indexOf('<div class="board-node" data-block-id="' + name + '">') !== -1, 'expected a board-node for "' + name + '", got: ' + html);
  });
}

function testDocsHtmlBoardEdgesCoverEveryRealDependsOnPair() {
  var html = renderDocsHtmlFor(['rawOrders', 'rawCustomers', 'orders']);
  var match = html.match(/window\.__BOARD_EDGES__ = (.+?);/);
  assert.ok(match, 'expected an embedded __BOARD_EDGES__, got: ' + html);
  var edges = JSON.parse(match[1]);
  assert.strictEqual(edges.length, 2, 'expected both of orders\' real dependsOn edges, got: ' + JSON.stringify(edges));
  var froms = edges.map(function (e) { return e.from; }).sort();
  assert.deepStrictEqual(froms, ['rawCustomers', 'rawOrders']);
  edges.forEach(function (e) { assert.strictEqual(e.to, 'orders'); });
}

function testDocsHtmlShowsCompiledSqlAndConnectorTypes() {
  var html = renderDocsHtmlFor(['rawOrders', 'orders']);
  assert.ok(/sheets/.test(html), 'expected rawOrders\' source type in the detail markup, got: ' + html);
  assert.ok(/join/.test(html), 'expected orders\' compiled SQL in the detail markup, got: ' + html);
}

function testDocsHtmlLoadsD3AndThemeToggle() {
  var html = renderDocsHtmlFor(['rawOrders']);
  assert.ok(html.indexOf('https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js') !== -1, 'expected the pinned D3 CDN script tag, got: ' + html);
  assert.ok(/id="theme-toggle"/.test(html), 'expected the theme toggle button, got: ' + html);
}
```

Add these four to the existing `module.exports` block in `test/docs.test.js`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
./build.sh
node test/run.js
```

Expected: `FAIL ... reading 'renderDocsHtml'` for all four (not implemented yet, and not yet on the `__test` back door).

- [ ] **Step 3: Implement `renderDocsHtml` and its helpers**

Append to `src/docs.js`:

```js
// Minimal styling for the docs-specific bits publish.js's REPORT_CSS/
// BOARD_CSS don't already cover (a kind badge, a compile-error callout).
// Everything else - colors, dark mode, .board-node/.board-edge - is
// reused as-is from publish.js.
var DOCS_CSS = '.docs-kind-badge { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 1px 6px; margin-left: 6px; }'
  + '.docs-error { color: var(--coral); font-family: var(--mono); font-size: 12px; }'
  + 'pre { white-space: pre-wrap; font-family: var(--mono); font-size: 12px; }';

function renderDocsDetailHtml(kind, detail) {
  // A discoveryError (see buildDocsPayload) can happen to any kind in
  // principle (src/cli.js:568's check is kind-agnostic), even though only
  // model.js's expandModelNodes() sets one today - render it the same way
  // regardless of kind, before any kind-specific branch below.
  if (detail.discoveryError) {
    return '<div class="docs-error">discovery error: ' + escapeHtml(detail.discoveryError) + '</div>';
  }
  if (kind === 'model') {
    var html = '<div>materialized: ' + escapeHtml(detail.materialized) + '</div>'
      + '<div>' + escapeHtml(detail.projectId + '.' + detail.dataset) + '</div>';
    if (detail.compiledSqlError) {
      html += '<div class="docs-error">compile error: ' + escapeHtml(detail.compiledSqlError) + '</div>';
    } else {
      html += '<pre>' + escapeHtml(detail.compiledSql) + '</pre>';
    }
    return html;
  }
  if (kind === 'move') {
    return '<div>' + escapeHtml(detail.sourceType) + ' &rarr; ' + escapeHtml(detail.targetType) + '</div>';
  }
  if (kind === 'publish') {
    var parts = detail.charts.map(function (c) { return c.title + ' (' + c.type + ')'; })
      .concat(detail.tables.map(function (t) { return t.title + ' (' + t.mode + ')'; }));
    return '<div>' + escapeHtml(parts.join(', ')) + '</div>';
  }
  return '';
}

function renderDocsNodeSection(node) {
  return '<div class="board-node" data-block-id="' + escapeHtml(node.name) + '">'
    + '<h2>' + escapeHtml(node.name) + '<span class="docs-kind-badge">' + escapeHtml(node.kind) + '</span></h2>'
    + renderDocsDetailHtml(node.kind, node.detail)
    + '</div>';
}

function renderDocsHtml(payload) {
  var boardNodes = payload.map(function (node) {
    return { id: node.name, relatesTo: node.dependsOn[0] || null };
  });
  var boardEdges = [];
  payload.forEach(function (node) {
    node.dependsOn.forEach(function (dep) { boardEdges.push({ from: dep, to: node.name }); });
  });
  var nodesHtml = payload.map(renderDocsNodeSection).join('');
  var blocks = '<div class="board-viewport"><div class="board-canvas" id="board-canvas">'
    + '<svg class="board-edges" id="board-edges"></svg>'
    + nodesHtml
    + '</div></div>';
  var script = 'window.__BOARD_NODES__ = ' + JSON.stringify(boardNodes).replace(/</g, '\\u003c') + ';'
    + 'window.__BOARD_EDGES__ = ' + JSON.stringify(boardEdges).replace(/</g, '\\u003c') + ';'
    + THEME_TOGGLE_JS + BOARD_LAYOUT_CLIENT_JS + BOARD_CLIENT_JS;
  var d3Script = '<script src="' + D3_CDN_URL + '" integrity="' + D3_CDN_INTEGRITY + '" crossorigin="anonymous"></script>';
  var themeInitScript = '<script>' + THEME_INIT_JS + '</script>';
  var css = REPORT_CSS + BOARD_CSS + DOCS_CSS;
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>notsobigdata docs</title>'
    + '<style>' + css + '</style>' + themeInitScript + d3Script + '</head><body>'
    + THEME_TOGGLE_HTML
    + '<main>' + blocks + '</main>'
    + '<script>' + script + '</script>'
    + '</body></html>';
}
```

Add `renderDocsHtml` to the `__test` back door added in Task 2 (`src/cli.js`'s footer, via `build.sh`'s `build()` function):

```js
return {
  cli: cli,
  __test: { buildDocsPayload: buildDocsPayload, discoverNodesForTest: function () { return discoverNodes().nodes; }, renderDocsHtml: renderDocsHtml }
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: all four new tests `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/docs.js build.sh test/docs.test.js src.js
git commit -m "$(cat <<'EOF'
feat: add renderDocsHtml, the docs command's board-based HTML template

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `cli('docs')` end to end

Adds the command to `COMMANDS`/`parseCommand`/`usage()`, the `docs` divergence in `cli()`'s dispatch, and `runDocsCommand` (the Drive-writing glue). This is the task that finally makes `cli('docs')` callable.

**Files:**
- Modify: `src/cli.js:125` (`COMMANDS`), `src/cli.js:160-224` (`parseCommand`), `src/cli.js:127-152` (`usage()`), `src/cli.js:1453-1526` (`cli()` dispatch)
- Modify: `src/docs.js` (add `runDocsCommand`)
- Modify: `test/docs.test.js` (append)

**Interfaces:**
- Consumes: `buildDocsPayload`/`renderDocsHtml` (Tasks 2/4); `resolveDriveWriteTarget`/`writeDriveText` (`src/move.js:824`/`:837`); `resolveDefaultDriveFolderId` (Task 1).
- Produces: `runDocsCommand(nodes, folderId)` → `{ ok: true, command: 'docs', fileId, nodes }`, called from `cli()`.

- [ ] **Step 1: Write the failing end-to-end tests**

Append to `test/docs.test.js` — mirrors `publish.test.js`'s `shimBigQueryAndDrive` pattern (shim Drive/ScriptApp directly on the harness sandbox, then drive `cli()` for real):

```js
// Shims exactly what cli('docs') touches on Drive: getFolderById(...).
// createFile(...) (create path) and .getFilesByName(...) (upsertByName's
// find-by-name check, always "not found" here so every test exercises
// the create path), plus ScriptApp.getScriptId()/DriveApp.getFileById(...)
// .getParents() (the default-folder path, see resolveDefaultDriveFolderId).
function shimDriveForDocs(ctx) {
  var createdFiles = [];
  ctx.MimeType = { HTML: 'text/html' };
  ctx.ScriptApp = { getScriptId: function () { return 'script-1'; } };
  ctx.DriveApp = {
    getFileById: function (id) {
      return { getParents: function () { return { hasNext: function () { return true; }, next: function () { return { getId: function () { return 'parent-folder-1'; } }; } }; } };
    },
    getFolderById: function (folderId) {
      return {
        getFilesByName: function () { return { hasNext: function () { return false; } }; },
        createFile: function (name, content, mimeType) {
          createdFiles.push({ folderId: folderId, name: name, content: content, mimeType: mimeType });
          return { getId: function () { return 'docs-file-' + createdFiles.length; } };
        }
      };
    }
  };
  return function () { return createdFiles; };
}

function testDocsCommandWritesToScriptsParentFolderByDefault() {
  var ctx = harness.loadContext([fixture('docs-nodes.js')]);
  var getCreatedFiles = shimDriveForDocs(ctx);
  var report = ctx.NotSoBigData.cli('docs');
  assert.strictEqual(report.ok, true, 'expected cli("docs") to report ok, got: ' + JSON.stringify(report));
  assert.strictEqual(report.command, 'docs');
  var files = getCreatedFiles();
  assert.strictEqual(files.length, 1, 'expected exactly one file written, got: ' + JSON.stringify(files));
  assert.strictEqual(files[0].folderId, 'parent-folder-1', 'expected the default folder (the script\'s own parent) to be used, got: ' + JSON.stringify(files[0]));
  assert.strictEqual(files[0].name, 'notsobigdata-docs.html');
  assert.ok(/board-node/.test(files[0].content), 'expected the written content to be the rendered docs HTML, got: ' + files[0].content);
}

function testDocsCommandFolderIdFlagOverridesDefault() {
  var ctx = harness.loadContext([fixture('docs-nodes.js')]);
  var getCreatedFiles = shimDriveForDocs(ctx);
  var report = ctx.NotSoBigData.cli('docs --folder-id explicit-folder');
  assert.strictEqual(report.ok, true, 'expected cli("docs --folder-id ...") to report ok, got: ' + JSON.stringify(report));
  var files = getCreatedFiles();
  assert.strictEqual(files[0].folderId, 'explicit-folder', 'expected --folder-id to override the default, got: ' + JSON.stringify(files[0]));
}

function testDocsCommandFolderIdRejectedOnOtherCommands() {
  var ctx = harness.loadContext([fixture('docs-nodes.js')]);
  assert.throws(function () { ctx.NotSoBigData.cli('list --folder-id x'); }, /--folder-id.*only valid for "docs"|unknown option/, 'expected --folder-id to be rejected on a non-docs command');
}
```

Add these three to `test/docs.test.js`'s `module.exports`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
./build.sh
node test/run.js
```

Expected: `FAIL ... cli(): unknown command "docs"` for the first two, and the third fails because `--folder-id` doesn't exist to reject yet (no throw at all, or a different error).

- [ ] **Step 3: Add `docs` to `COMMANDS` and `usage()`**

`src/cli.js:125`:

```js
var COMMANDS = ['run', 'list', 'compile', 'debug', 'sources', 'docs', 'hello', 'help'];
```

`src/cli.js:127-152`, inside `usage()`, add one line after the `sources` lines and update the flag-summary sentence:

```js
'  cli("sources --select stripe")     ... just one source ("stripe.payments" selects one table)',
'  cli("docs")                    write a project doc site (DAG + per-node detail) to Drive',
'  cli("docs --folder-id x")          ... into a specific Drive folder instead of the script\'s own parent folder',
'  cli("hello")                   check the library loaded and see which nodes it can find',
```

- [ ] **Step 4: Extend `parseCommand` with `--folder-id`**

`src/cli.js:175`, add `folderId: null` to the initial `parsed` object:

```js
var parsed = { command: command, select: [], exclude: [], target: null, fullRefresh: false, folderId: null };
```

`src/cli.js:185`, add `--folder-id` to the flag whitelist:

```js
if (flag !== '--select' && flag !== '--exclude' && flag !== '--target' && flag !== '--full-refresh' && flag !== '--folder-id') {
  throw new Error('cli(): unknown option "' + flag + '". Expected "--select", "--exclude", "--target", "--full-refresh", or "--folder-id".\n\n' + usage());
}
```

`src/cli.js:200-221`, the flag-value dispatch — add a `--folder-id` branch alongside the existing `--target` one, restricted to `docs` the same way `--full-refresh` is restricted to `run`/`compile`:

```js
if (flag !== '--full-refresh') {
  if (flag === '--target') {
    if (!value) {
      throw new Error('cli(): "--target" needs a value, e.g. --target prod.');
    }
    if (parsed.target !== null) {
      throw new Error('cli(): "--target" can only be specified once.');
    }
    parsed.target = value;
  } else if (flag === '--folder-id') {
    if (!value) {
      throw new Error('cli(): "--folder-id" needs a value, e.g. --folder-id 1AbCdEf...');
    }
    if (command !== 'docs') {
      throw new Error('cli(): "--folder-id" is only valid for "docs", not for "' + command + '".');
    }
    if (parsed.folderId !== null) {
      throw new Error('cli(): "--folder-id" can only be specified once.');
    }
    parsed.folderId = value;
  } else {
    var list = value.split(',')
      .map(function (item) { return item.trim(); })
      .filter(function (item) { return !!item; });
    if (!list.length) {
      throw new Error('cli(): "' + flag + '" needs a comma-separated value, e.g. ' + flag + ' orders,customers.');
    }
    var key = flag.slice(2);
    parsed[key] = parsed[key].concat(list);
  }
}
```

(One nuance: `--folder-id` needs a raw value, not a comma-split list — same shape `--target` already gets via its own `else if` branch above, which is why it's handled as its own branch rather than falling into the generic comma-split `else`.)

- [ ] **Step 5: Add `runDocsCommand` to `src/docs.js`**

```js
// Drive-writing glue: reuses move.js's resolveDriveWriteTarget/writeDriveText
// (the same primitive writeManifestFile already crosses the move/cli
// module boundary for) rather than a second Drive-write implementation.
// Fixed fileName, upsertByName: true - every cli('docs') overwrites the
// same file, the same "regenerate in place" behavior dbt docs generate
// has for its index.html.
function runDocsCommand(nodes, folderId) {
  var payload = buildDocsPayload(nodes);
  var html = renderDocsHtml(payload);
  var target = { folderId: folderId || resolveDefaultDriveFolderId(null), fileName: 'notsobigdata-docs.html', upsertByName: true };
  var fileId = resolveDriveWriteTarget(target);
  fileId = writeDriveText(fileId, target, html, MimeType.HTML);
  Logger.log('cli("docs") written to ' + fileId);
  return { ok: true, command: 'docs', fileId: fileId, nodes: payload };
}
```

- [ ] **Step 6: Wire the divergence into `cli()`'s dispatch**

`src/cli.js`, inside `cli()` (around line 1470, right after the existing `assertDependenciesExist(discovered.nodes);` line and before `applyTargetOverlay`):

```js
var discovered = discoverNodes();
if (!discovered.nodes.length) {
  throw new Error('cli(): found no declared nodes. ...');
}
assertDependenciesExist(discovered.nodes);
if (parsed.command === 'docs') {
  var docsReport = runDocsCommand(discovered.nodes, parsed.folderId);
  Logger.log('DONE  cli("' + input + '") - docs written to ' + docsReport.fileId);
  return docsReport;
}
applyTargetOverlay(discovered.nodes, parsed.target);
```

`docs` diverges here rather than after selection/ordering because it has no `--select` and describes the whole project regardless of `--target` — the same reasoning `debug`'s own comment gives for diverging where it does, just one step earlier since `docs` doesn't need selection at all.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: all three new tests `PASS`, and the full suite (Tasks 1-4's tests included) stays green.

- [ ] **Step 8: Commit**

```bash
git add src/cli.js src/docs.js test/docs.test.js src.js
git commit -m "$(cat <<'EOF'
feat: wire cli('docs') end to end (COMMANDS, --folder-id, dispatch)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Docs impact + final verification

No code changes to `src/` beyond what Tasks 1-5 already made — this task is the documentation `CLAUDE.md`'s "About documentation" section requires alongside the code, plus the mechanical pre-PR checks.

**Files:**
- Modify: `docs/cli.md` (new `### cli('docs')` section, listed in the "Commands" summary near the top)
- Modify: `README.md` (one new line in the `cli()` command list, `## cli()` section)
- Create: `src/docs.md` (dev notes, same tier as `src/publish.md`/`src/move.md`)
- Modify: `src/publish.md` (short note on `window.__BOARD_NODES__`/`window.__BOARD_EDGES__`)

- [ ] **Step 1: Add the `docs/cli.md` section**

Add a `### cli('docs') — a project doc site` section (placed after the existing `### cli('sources')` section, matching `usage()`'s ordering from Task 5): explains the DAG + per-kind detail it shows (mirroring this plan's Task 2 list: connector types for `move`, materialized/tests/compiled SQL for `model`, chart/table titles for `publish`), the fixed output filename and `upsertByName` overwrite behavior, and the `--folder-id` flag with its default (the script's own parent Drive folder, via `resolveDefaultDriveFolderId`). Also add one line to the "Commands" summary list near the top of the file (`docs/cli.md:10`).

- [ ] **Step 2: Add the README.md line**

In `README.md`'s `## cli()` command list (around line 137, right after the `cli('sources')` line):

```
NotSoBigData.cli('docs')                    // write a project doc site (DAG + per-node detail) to Drive
```

- [ ] **Step 3: Write `src/docs.md`**

Same tier as `src/publish.md`/`src/move.md`/`src/cli.md` (`CLAUDE.md`'s "About documentation": tracked, code-internals notes, not user documentation). Cover: why `docs` is its own module rather than folded into `cli.js` (one file, one responsibility — turning a node list into a docs HTML string, mirroring how `publish.js` is its own module); the positioning-vs-real-edges split from Task 3 (`window.__BOARD_NODES__` for `d3.stratify()`/`d3.tree()` positioning only, `window.__BOARD_EDGES__` for the real, possibly-multi-parent edges) and why that's safe for `publish`'s own board (the `||` fallback keeps its output byte-identical); the `__test` back door added in Tasks 2/4 and why it exists only for Layer 1 (a pure function with no `cli()`-level surface still needs a way in from Node tests).

- [ ] **Step 4: Add the `src/publish.md` note**

A short paragraph noting `window.__BOARD_NODES__`/`window.__BOARD_EDGES__` (added by Task 3) as a second, generic entry point into `BOARD_LAYOUT_CLIENT_JS` — so a future change to that script doesn't assume `publish`'s `renderReportHtml` is its only caller. Cross-reference `src/docs.md`.

- [ ] **Step 5: Final verification**

```bash
./build.sh --check
node test/run.js
```

Expected: `build.sh: src.js is up to date.` and every test passes (the full suite, not just `docs.test.js`/`publish.test.js`).

- [ ] **Step 6: Commit**

```bash
git add docs/cli.md README.md src/docs.md src/publish.md
git commit -m "$(cat <<'EOF'
docs: document cli('docs') in docs/cli.md, README, and src/docs.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## What Layer 2 (`notsobigtests`, human-run) still needs, per the spec

Not part of this plan (a separate companion PR in `notsobigtests`, per `CLAUDE.md`'s feature-branch workflow): a fixture project with the same kind of multi-parent DAG this plan's `docs-nodes.js` fixture has, running `cli('docs')` for real and a human verifying the file lands in Drive, dark-mode toggle works, pan/zoom works, and — the one thing no Node test here can see — the multi-parent edges render correctly on screen even though only one of them drove the tree's positioning.
