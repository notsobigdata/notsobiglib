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
