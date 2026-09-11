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
