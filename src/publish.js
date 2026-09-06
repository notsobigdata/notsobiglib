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
