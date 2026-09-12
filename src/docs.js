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

// Minimal styling for the docs-specific bits publish.js's REPORT_CSS/
// BOARD_CSS don't already cover (per-kind coloring, the sidebar, the
// detail drawer). Everything else - colors, dark mode, .board-node/
// .board-edge/.board-metric-card - is reused as-is from publish.js.
var DOCS_KIND_TOKEN = { move: '--move', model: '--model', publish: '--publish' };

var DOCS_CSS = [
  '.docs-shell { display: grid; grid-template-columns: 240px 1fr; gap: 16px; align-items: start; }',
  '@media (max-width: 760px) { .docs-shell { grid-template-columns: 1fr; } }',
  '.docs-sidebar { background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); padding: 14px; position: sticky; top: 16px; }',
  '.docs-search { display: flex; align-items: center; gap: 6px; background: var(--paper); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 7px 10px; margin-bottom: 14px; }',
  '.docs-search input { border: none; background: none; outline: none; width: 100%; font-size: 12.5px; color: var(--ink); }',
  '.docs-kind-group { margin-bottom: 14px; }',
  '.docs-kind-group-head { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-soft); margin-bottom: 6px; }',
  '.docs-kind-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }',
  '.docs-node-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; font-size: 12.5px; cursor: pointer; color: var(--ink-soft); }',
  '.docs-node-row:hover { background: var(--paper); color: var(--ink); }',
  '.docs-node-row.docs-node-row-selected { background: var(--accent-soft); color: var(--accent); font-weight: 500; }',
  '.docs-node-row .docs-node-row-error { margin-left: auto; color: var(--bad); font-size: 11px; }',
  '.board-node[data-kind] .board-node-kind-bar { height: 4px; }',
  '.docs-kind-badge { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 1px 6px; margin-left: 6px; }',
  '.docs-error { color: var(--bad); font-family: var(--mono); font-size: 12px; }',
  '.docs-drawer { position: fixed; top: 0; right: 0; height: 100%; width: 340px; max-width: 90vw; background: var(--surface); border-left: 1px solid var(--paper-line); box-shadow: var(--shadow); transform: translateX(100%); transition: transform .18s ease; display: flex; flex-direction: column; z-index: 900; }',
  '.docs-drawer.docs-drawer-open { transform: translateX(0); }',
  '.docs-drawer-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--paper-line); }',
  '.docs-drawer-head h3 { margin: 0; font-size: 13.5px; flex: 1; }',
  '.docs-drawer-close { border: none; background: none; color: var(--ink-soft); cursor: pointer; font-size: 15px; }',
  '.docs-drawer-body { padding: 14px 16px; overflow: auto; flex: 1; }',
  'pre { white-space: pre-wrap; font-family: var(--mono); font-size: 12px; }'
].join('\n');

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
  var kindToken = DOCS_KIND_TOKEN[node.kind] || '--ink-soft';
  return '<div class="board-node" data-block-id="' + escapeHtml(node.name) + '" data-kind="' + escapeHtml(node.kind) + '">'
    + '<div class="board-node-kind-bar" style="background: var(' + kindToken + ')"></div>'
    + '<div class="board-metric-card"><div class="board-metric-label">' + escapeHtml(node.name) + '<span class="docs-kind-badge">' + escapeHtml(node.kind) + '</span></div></div>'
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
  var kinds = ['move', 'model', 'publish'];
  var sidebarHtml = '<div class="docs-search"><input type="text" id="docs-filter" placeholder="Filter nodes..."></div>'
    + kinds.map(function (kind) {
      var items = payload.filter(function (n) { return n.kind === kind; });
      if (!items.length) { return ''; }
      var kindToken = DOCS_KIND_TOKEN[kind];
      var rows = items.map(function (n) {
        return '<div class="docs-node-row" data-docs-row="' + escapeHtml(n.name) + '"><span class="docs-kind-dot" style="background: var(' + kindToken + ')"></span>' + escapeHtml(n.name)
          + (n.detail.discoveryError ? '<span class="docs-node-row-error">&#9888;</span>' : '') + '</div>';
      }).join('');
      return '<div class="docs-kind-group"><div class="docs-kind-group-head"><span class="docs-kind-dot" style="background: var(' + kindToken + ')"></span>' + kind + '<span>(' + items.length + ')</span></div>' + rows + '</div>';
    }).join('');
  var blocks = '<div class="docs-shell">'
    + '<aside class="docs-sidebar">' + sidebarHtml + '</aside>'
    + '<div class="board-viewport"><div class="board-canvas" id="board-canvas">'
    + '<svg class="board-edges" id="board-edges"></svg>'
    + nodesHtml
    + '</div><div class="board-toolbar">'
    + '<button type="button" data-board-action="direction" title="Change layout direction">&#8635;</button>'
    + '<button type="button" data-board-action="reset" title="Reset to auto layout">&#8634;</button>'
    + '<div class="board-toolbar-divider"></div>'
    + '<button type="button" data-board-action="fit" title="Fit to screen">&#10021;</button>'
    + '</div></div>'
    + '<div class="docs-drawer" id="docs-drawer"><div class="docs-drawer-head"><h3 id="docs-drawer-title"></h3><button type="button" class="docs-drawer-close" id="docs-drawer-close">&#10005;</button></div><div class="docs-drawer-body" id="docs-drawer-body"></div></div>'
    + '</div>';
  var docsDetailByName = {};
  payload.forEach(function (node) { docsDetailByName[node.name] = { kind: node.kind, html: renderDocsDetailHtml(node.kind, node.detail) }; });
  var script = 'window.__BOARD_NODES__ = ' + JSON.stringify(boardNodes).replace(/</g, '\\u003c') + ';'
    + 'window.__BOARD_EDGES__ = ' + JSON.stringify(boardEdges).replace(/</g, '\\u003c') + ';'
    + 'window.__DOCS_DETAIL_BY_NAME__ = ' + JSON.stringify(docsDetailByName).replace(/</g, '\\u003c') + ';'
    + THEME_TOGGLE_JS + BOARD_LAYOUT_CLIENT_JS + BOARD_CLIENT_JS + DOCS_DRAWER_CLIENT_JS;
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

// Sidebar search/click + the detail drawer. window.__notsobigBoardApi__
// (BOARD_LAYOUT_CLIENT_JS, src/publish.js) already exists by the time
// this runs (registered inside the same DOMContentLoaded pass, and this
// script is appended right after it - see renderDocsHtml's script
// assembly), so hovering a sidebar row can reuse its setHighlight exactly
// the way hovering a board node itself already does.
//
// The node click listener below checks/clears node.dataset.justDragged
// first, before anything else - the same guard BOARD_LAYOUT_CLIENT_JS's
// own endDrag() (src/publish.js) already requires of MINI_CHART_CLIENT_JS's
// .board-node click listener on the publish board: a drag-then-release
// still fires a native click on most browsers, so without this guard
// ending a drag on a docs node would also pop the drawer open.
var DOCS_DRAWER_CLIENT_JS = [
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var drawer = document.getElementById("docs-drawer");',
  '  var titleEl = document.getElementById("docs-drawer-title");',
  '  var bodyEl = document.getElementById("docs-drawer-body");',
  '  function openDrawer(name) {',
  '    var detail = window.__DOCS_DETAIL_BY_NAME__[name];',
  '    if (!detail) { return; }',
  '    titleEl.textContent = name;',
  '    bodyEl.innerHTML = detail.html;',
  '    drawer.classList.add("docs-drawer-open");',
  '    Array.prototype.forEach.call(document.querySelectorAll(".docs-node-row"), function (row) {',
  '      row.classList.toggle("docs-node-row-selected", row.getAttribute("data-docs-row") === name);',
  '    });',
  '  }',
  '  document.getElementById("docs-drawer-close").addEventListener("click", function () {',
  '    drawer.classList.remove("docs-drawer-open");',
  '  });',
  '  Array.prototype.forEach.call(document.querySelectorAll(".board-node[data-kind]"), function (node) {',
  '    node.addEventListener("click", function () {',
  '      if (node.dataset.justDragged) { delete node.dataset.justDragged; return; }',
  '      openDrawer(node.getAttribute("data-block-id"));',
  '    });',
  '  });',
  '  Array.prototype.forEach.call(document.querySelectorAll(".docs-node-row"), function (row) {',
  '    var name = row.getAttribute("data-docs-row");',
  '    row.addEventListener("click", function () { openDrawer(name); });',
  '    row.addEventListener("mouseenter", function () { if (window.__notsobigBoardApi__) { window.__notsobigBoardApi__.setHighlight(name); } });',
  '    row.addEventListener("mouseleave", function () { if (window.__notsobigBoardApi__) { window.__notsobigBoardApi__.setHighlight(null); } });',
  '  });',
  '  var filterInput = document.getElementById("docs-filter");',
  '  filterInput.addEventListener("input", function () {',
  '    var needle = filterInput.value.toLowerCase();',
  '    Array.prototype.forEach.call(document.querySelectorAll(".docs-node-row"), function (row) {',
  '      row.style.display = row.getAttribute("data-docs-row").toLowerCase().indexOf(needle) === -1 ? "none" : "";',
  '    });',
  '    Array.prototype.forEach.call(document.querySelectorAll(".board-node[data-kind]"), function (node) {',
  '      var match = !needle || node.getAttribute("data-block-id").toLowerCase().indexOf(needle) !== -1;',
  '      node.style.opacity = match ? "1" : ".25";',
  '    });',
  '  });',
  '});'
].join('\n');

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
