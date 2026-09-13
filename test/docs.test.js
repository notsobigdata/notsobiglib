// test/docs.test.js
var assert = require('assert');
var path = require('path');
var harness = require('./harness');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function loadPayload() {
  var ctx = harness.loadContext([fixture('docs-nodes.js')]);
  var payload = ctx.NotSoBigData.__test.buildDocsPayload(ctx.NotSoBigData.__test.discoverNodesForTest());
  // JSON round-trip works around a Node vm cross-realm quirk (see
  // test/discovery.test.js's own comment on the same issue): a plain
  // object/array built by a function running inside the sandboxed vm
  // context has a different Object/Array prototype than one built in
  // this test file, so assert.deepStrictEqual reports "same structure
  // but not reference-equal" below even when every field matches.
  return JSON.parse(JSON.stringify(payload));
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
    assert.ok(html.indexOf('<div class="board-node" data-block-id="' + name + '" data-kind="') !== -1, 'expected a board-node for "' + name + '", got: ' + html);
  });
}

// Regression: DOCS_KIND_TOKEN's kind->CSS-var mapping (--move/--model/
// --publish) had zero test coverage - this pins that a model-kind node's
// board-node markup carries its data-kind="model" attribute right next to
// a var(--model) color reference (the kind-bar), not just any kind's color.
function testDocsHtmlColorsBoardNodeByKind() {
  var html = renderDocsHtmlFor(['orders']);
  var match = /<div class="board-node" data-block-id="orders" data-kind="model">.*?var\(--model\)/.exec(html);
  assert.ok(match, 'expected the "orders" model node to be colored var(--model), got: ' + html);
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

function testDocsHtmlRendersSidebarGroupedByKindWithSearchInput() {
  var payload = loadPayload();
  var ctx = harness.loadContext([fixture('docs-nodes.js')]);
  var html = ctx.NotSoBigData.__test.renderDocsHtml(payload);
  assert.ok(html.indexOf('class="docs-sidebar"') !== -1, 'expected a docs sidebar, got: ' + html);
  assert.ok(html.indexOf('id="docs-filter"') !== -1, 'expected a filter input, got: ' + html);
  assert.ok(/class="docs-kind-group-head">[^<]*<span class="docs-kind-dot"[^>]*><\/span>move<span>\(2\)<\/span>/.test(html) || html.indexOf('>move<span>(2)</span>') !== -1, 'expected a "move" group with a count of 2, got: ' + html);
  assert.ok(html.indexOf('id="docs-drawer"') !== -1, 'expected the detail drawer container, got: ' + html);
  assert.ok(html.indexOf('__DOCS_DETAIL_BY_NAME__') !== -1, 'expected per-node detail to be embedded for the drawer, got: ' + html);
}

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

module.exports = {
  testDocsPayloadCarriesMoveConnectorTypes: testDocsPayloadCarriesMoveConnectorTypes,
  testDocsPayloadCompilesModelSqlAndCapturesMultipleDependsOn: testDocsPayloadCompilesModelSqlAndCapturesMultipleDependsOn,
  testDocsPayloadSurfacesDiscoveryErrorWithoutCrashing: testDocsPayloadSurfacesDiscoveryErrorWithoutCrashing,
  testDocsPayloadCarriesPublishStructureOnly: testDocsPayloadCarriesPublishStructureOnly,
  testDocsHtmlRendersOneBoardNodePerDiscoveredNode: testDocsHtmlRendersOneBoardNodePerDiscoveredNode,
  testDocsHtmlColorsBoardNodeByKind: testDocsHtmlColorsBoardNodeByKind,
  testDocsHtmlBoardEdgesCoverEveryRealDependsOnPair: testDocsHtmlBoardEdgesCoverEveryRealDependsOnPair,
  testDocsHtmlShowsCompiledSqlAndConnectorTypes: testDocsHtmlShowsCompiledSqlAndConnectorTypes,
  testDocsHtmlLoadsD3AndThemeToggle: testDocsHtmlLoadsD3AndThemeToggle,
  testDocsHtmlRendersSidebarGroupedByKindWithSearchInput: testDocsHtmlRendersSidebarGroupedByKindWithSearchInput,
  testDocsCommandWritesToScriptsParentFolderByDefault: testDocsCommandWritesToScriptsParentFolderByDefault,
  testDocsCommandFolderIdFlagOverridesDefault: testDocsCommandFolderIdFlagOverridesDefault,
  testDocsCommandFolderIdRejectedOnOtherCommands: testDocsCommandFolderIdRejectedOnOtherCommands
};
