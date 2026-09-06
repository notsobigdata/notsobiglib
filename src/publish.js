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
