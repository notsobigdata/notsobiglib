// src/publish.js
//
// The `publish` kind: reads a table another node (move-with-bigquery-
// target, or model) already materialized, and writes a self-contained
// .html dashboard to Drive. See
// docs/superpowers/specs/2026-09-05-publish-kind-design.md for the full
// design.

// Shared enum for every publish() value that gets formatted for display -
// kpis[] (always required), and tables[]'s raw columns/aggregated metrics
// (optional, default 'string') - one array, not a second enum living
// elsewhere, per the design spec's §3.
var PUBLISH_VALUE_FORMATS = ['string', 'currency', 'integer', 'decimal'];

// The chart types charts[] accepts - see the design spec's §2. 'bar' also
// accepts an optional series/stacking pair for grouped/stacked bars; that
// isn't a separate type, just an optional second dimension on 'bar'.
var CHART_TYPES = ['bar', 'line', 'pie'];

// Pinned exact version, never a floating tag - see CLAUDE.md's
// "Downstream consumers pinned to a release" for the same reasoning
// applied to a different kind of pin: a file reopened a year from now
// must load the exact D3 build it loaded the day it was generated.
var D3_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';

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
  });
  (config.charts || []).forEach(function (chart) {
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
      var record = emptyMap();
      row.f.forEach(function (cell, index) {
        record[fieldNames[index]] = cell.v;
      });
      rows.push(record);
    });
    pageToken = response.pageToken;
  } while (pageToken);
  return rows;
}

// Groups rows by the value of `field`, preserving first-seen key order -
// shared by charts[] and tables[]'s aggregated mode so the grouping logic
// exists once.
function groupRowsBy(rows, field) {
  var groups = emptyMap();
  var order = [];
  rows.forEach(function (row) {
    var key = row[field];
    if (!has(groups, key)) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(row);
  });
  return { groups: groups, order: order };
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
  if (format === 'string') {
    return String(value);
  }
  if (format === 'integer') {
    return Math.round(value).toLocaleString('en-US');
  }
  if (format === 'currency') {
    return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// mode: 'raw' - one output row per source row, column order/labels exactly
// as configured. Non-'string' formats coerce through Number() first (row
// values from fetchTableRows are always strings, same as
// computeAggregate's own "Number(row[field]) || 0" coercion for
// kpis/charts) - 'string' format is left raw so ids/dates/free text pass
// through unchanged rather than becoming NaN/0.
function buildRawTablePayload(table, rows) {
  var columns = table.columns.map(function (column) {
    return { key: column.field, label: column.label || column.field };
  });
  var tableRows = rows.map(function (row) {
    return table.columns.map(function (column) {
      var format = column.format || 'string';
      var raw = row[column.field];
      return formatValue(format === 'string' ? raw : (Number(raw) || 0), format);
    });
  });
  return { id: table.id, title: table.title, pageSize: table.pageSize || 25, columns: columns, rows: tableRows };
}

// mode: 'aggregated' - identical grouping to charts' own groupBy handling
// above; the groupBy value itself is left as the raw string BigQuery
// returned (not run through formatValue), matching how charts already
// render chart.data[].groupValue directly with no formatting step.
function buildAggregatedTablePayload(table, rows) {
  var grouped = groupRowsBy(rows, table.groupBy);
  var groups = grouped.groups;
  var order = grouped.order;
  var columns = [{ key: table.groupBy, label: table.groupBy }].concat(table.metrics.map(function (metric) {
    return { key: metric.label, label: metric.label };
  }));
  var tableRows = order.map(function (key) {
    var groupRows = groups[key];
    var cells = table.metrics.map(function (metric) {
      var value = computeAggregate(groupRows, metric.agg, metric.field);
      return formatValue(value, metric.format || 'string');
    });
    return [key].concat(cells);
  });
  return { id: table.id, title: table.title, pageSize: table.pageSize || 25, columns: columns, rows: tableRows };
}

// Numeric-aware ascending compare for line charts' groupValue ordering -
// numeric if both sides parse as numbers (covers plain numbers and
// ISO-format date strings' *year* component alone would sort wrong
// numerically, which is exactly why non-numeric strings fall through to
// plain string compare: 'YYYY-MM-DD' sorts correctly as a string already).
function compareGroupValues(a, b) {
  var numA = Number(a);
  var numB = Number(b);
  if (!isNaN(numA) && !isNaN(numB) && a !== '' && b !== '') {
    return numA - numB;
  }
  return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
}

// One chart's payload - either the plain {groupValue, total} shape every
// chart type has used since v1 (bar/pie, and line which additionally
// sorts it), or, when chart.series is set, a dense {groupValue, values}
// matrix: every seriesKeys entry present in every group's `values`, zero
// where the source rows had no matching combination. Dense on purpose -
// Task 3's client-side d3.stack() code never has to special-case a
// missing combination.
function buildChartPayload(chart, rows) {
  var chartType = chart.type || 'bar';
  if (chart.series) {
    var seriesSeen = emptyMap();
    var seriesKeys = [];
    var groupSeen = emptyMap();
    var groupKeys = [];
    var cellRows = emptyMap();
    rows.forEach(function (row) {
      var groupKey = row[chart.groupBy];
      var seriesKey = row[chart.series];
      if (!has(groupSeen, groupKey)) {
        groupSeen[groupKey] = true;
        groupKeys.push(groupKey);
      }
      if (!has(seriesSeen, seriesKey)) {
        seriesSeen[seriesKey] = true;
        seriesKeys.push(seriesKey);
      }
      if (!cellRows[groupKey]) {
        cellRows[groupKey] = emptyMap();
      }
      if (!cellRows[groupKey][seriesKey]) {
        cellRows[groupKey][seriesKey] = [];
      }
      cellRows[groupKey][seriesKey].push(row);
    });
    var data = groupKeys.map(function (groupKey) {
      var values = emptyMap();
      seriesKeys.forEach(function (seriesKey) {
        values[seriesKey] = computeAggregate((cellRows[groupKey] && cellRows[groupKey][seriesKey]) || [], chart.metric.agg, chart.metric.field);
      });
      return { groupValue: groupKey, values: values };
    });
    return { id: chart.id, title: chart.title, type: chartType, series: chart.series, stacking: chart.stacking || 'grouped', seriesKeys: seriesKeys, data: data };
  }
  var grouped = groupRowsBy(rows, chart.groupBy);
  var data = grouped.order.map(function (key) {
    return { groupValue: key, total: computeAggregate(grouped.groups[key], chart.metric.agg, chart.metric.field) };
  });
  if (chartType === 'line') {
    data.sort(function (a, b) { return compareGroupValues(a.groupValue, b.groupValue); });
  }
  return { id: chart.id, title: chart.title, type: chartType, donut: !!chart.donut, data: data };
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
  return { kpis: kpis, charts: charts, tables: tables };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  '.chart-bar { fill: var(--teal); }',
  '.table-block { border-top: 1px solid var(--paper-line); padding-top: 16px; margin-top: 16px; }',
  '.table-block h2 { font-size: 14px; }',
  '.table-block table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }',
  '.table-block th, .table-block td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--paper-line); font-variant-numeric: tabular-nums; }',
  '.table-pager { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-family: var(--mono); font-size: 12px; }',
  '.table-pager button { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); padding: 2px 8px; cursor: pointer; }',
  '.table-pager button:disabled { color: var(--ink-soft); cursor: default; }'
].join('\n');

// Static first page (readable with zero JS, same as the KPI cards/SVG
// chart above) plus inert-without-JS pager controls. table.rows already
// holds every row, pre-formatted (see buildRawTablePayload/
// buildAggregatedTablePayload) - only the first pageSize rows render here;
// the rest reaches the browser via the existing __PUBLISH_PAYLOAD__ embed,
// for TABLE_PAGINATION_JS below to page through.
function renderTableSection(table) {
  var firstPageRows = table.rows.slice(0, table.pageSize);
  var pageCount = Math.max(1, Math.ceil(table.rows.length / table.pageSize));
  var headerCells = table.columns.map(function (column) {
    return '<th>' + escapeHtml(column.label) + '</th>';
  }).join('');
  var bodyRows = firstPageRows.map(function (row) {
    return '<tr>' + row.map(function (cell) { return '<td>' + escapeHtml(cell) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<section class="table-block" data-table-id="' + escapeHtml(table.id) + '">'
    + '<h2>' + escapeHtml(table.title) + '</h2>'
    + '<table><thead><tr>' + headerCells + '</tr></thead><tbody>' + bodyRows + '</tbody></table>'
    + '<div class="table-pager">'
    + '<button type="button" class="table-prev" disabled>Previous</button>'
    + '<span class="table-page-label">Page 1 of ' + pageCount + '</span>'
    + '<button type="button" class="table-next"' + (pageCount <= 1 ? ' disabled' : '') + '>Next</button>'
    + '</div></section>';
}

// One generic paginator for every table.table-block on the page - reads
// columns/rows/pageSize back off window.__PUBLISH_PAYLOAD__ by
// data-table-id, never re-computes or re-formats a value (everything's
// already a formatted string in the payload). Builds <tr>/<td> via
// createElement + textContent only, per this repo's rule against
// innerHTML/string-concatenated markup on payload-sourced data - see the
// design spec's Render section.
var TABLE_PAGINATION_JS = [
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  Array.prototype.forEach.call(document.querySelectorAll(".table-block"), function (section) {',
  '    var tableId = section.getAttribute("data-table-id");',
  '    var table = payload.tables.filter(function (t) { return t.id === tableId; })[0];',
  '    if (!table) { return; }',
  '    var page = 0;',
  '    var pageCount = Math.max(1, Math.ceil(table.rows.length / table.pageSize));',
  '    var tbody = section.querySelector("tbody");',
  '    var prevBtn = section.querySelector(".table-prev");',
  '    var nextBtn = section.querySelector(".table-next");',
  '    var pageLabel = section.querySelector(".table-page-label");',
  '    function render() {',
  '      while (tbody.firstChild) { tbody.removeChild(tbody.firstChild); }',
  '      var start = page * table.pageSize;',
  '      table.rows.slice(start, start + table.pageSize).forEach(function (row) {',
  '        var tr = document.createElement("tr");',
  '        row.forEach(function (cell) {',
  '          var td = document.createElement("td");',
  '          td.textContent = cell;',
  '          tr.appendChild(td);',
  '        });',
  '        tbody.appendChild(tr);',
  '      });',
  '      pageLabel.textContent = "Page " + (page + 1) + " of " + pageCount;',
  '      prevBtn.disabled = page === 0;',
  '      nextBtn.disabled = page >= pageCount - 1;',
  '    }',
  '    prevBtn.addEventListener("click", function () { if (page > 0) { page -= 1; render(); } });',
  '    nextBtn.addEventListener("click", function () { if (page < pageCount - 1) { page += 1; render(); } });',
  '  });',
  '});'
].join('\n');

// Client-side chart draw dispatch, mirroring TABLE_PAGINATION_JS's
// authoring pattern (an array of literal JS-source lines, joined once).
// buildReportPayload (Task 2) already computed every number; this only
// draws it. Reuses REPORT_CSS's existing .chart-bar/.chart-label/
// .chart-value class names on the elements D3 creates, so the fixed
// design tokens apply without any CSS change - see the design spec §5.
var CHART_CLIENT_JS = [
  'function renderChartFallback(containerId, chart) {',
  '  var container = document.getElementById(containerId);',
  '  var list = document.createElement("ul");',
  '  (chart.data || []).forEach(function (d) {',
  '    var li = document.createElement("li");',
  '    var value = d.total !== undefined ? d.total : Object.keys(d.values || {}).reduce(function (sum, k) { return sum + d.values[k]; }, 0);',
  '    li.textContent = d.groupValue + ": " + value.toLocaleString("en-US");',
  '    list.appendChild(li);',
  '  });',
  '  container.appendChild(list);',
  '}',
  'function drawBarChart(containerId, chart) {',
  '  var width = 480, height = 240, margin = { top: 10, right: 40, bottom: 10, left: 160 };',
  '  var svg = d3.select("#" + containerId).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title);',
  '  var groupValues = chart.data.map(function (d) { return d.groupValue; });',
  '  var y = d3.scaleBand().domain(groupValues).range([margin.top, height - margin.bottom]).padding(0.2);',
  '  var color = d3.scaleOrdinal().range(["#3F6659", "#B65A3C", "#6B6A61", "#DCE6E1"]);',
  '  if (chart.seriesKeys && chart.seriesKeys.length) {',
  '    color.domain(chart.seriesKeys);',
  '    if (chart.stacking === "stacked") {',
  '      var stackRows = chart.data.map(function (d) { var row = { groupValue: d.groupValue }; chart.seriesKeys.forEach(function (k) { row[k] = d.values[k]; }); return row; });',
  '      var stacked = d3.stack().keys(chart.seriesKeys)(stackRows);',
  '      var maxTotal = d3.max(stackRows, function (row) { return chart.seriesKeys.reduce(function (sum, k) { return sum + row[k]; }, 0); }) || 1;',
  '      var x = d3.scaleLinear().domain([0, maxTotal]).range([margin.left, width - margin.right]);',
  '      svg.append("g").selectAll("g").data(stacked).join("g")',
  '        .attr("class", "chart-bar").style("fill", function (d) { return color(d.key); })',
  '        .selectAll("rect").data(function (d) { return d; }).join("rect")',
  '        .attr("y", function (d) { return y(d.data.groupValue); }).attr("x", function (d) { return x(d[0]); })',
  '        .attr("width", function (d) { return x(d[1]) - x(d[0]); }).attr("height", y.bandwidth());',
  '    } else {',
  '      var maxValue = d3.max(chart.data, function (d) { return d3.max(chart.seriesKeys, function (k) { return d.values[k]; }); }) || 1;',
  '      var x = d3.scaleLinear().domain([0, maxValue]).range([margin.left, width - margin.right]);',
  '      var y1 = d3.scaleBand().domain(chart.seriesKeys).range([0, y.bandwidth()]).padding(0.05);',
  '      svg.append("g").selectAll("g").data(chart.data).join("g")',
  '        .attr("transform", function (d) { return "translate(0," + y(d.groupValue) + ")"; })',
  '        .selectAll("rect").data(function (d) { return chart.seriesKeys.map(function (k) { return { key: k, value: d.values[k] }; }); }).join("rect")',
  '        .attr("class", "chart-bar").style("fill", function (d) { return color(d.key); })',
  '        .attr("y", function (d) { return y1(d.key); }).attr("x", margin.left)',
  '        .attr("width", function (d) { return x(d.value) - margin.left; }).attr("height", y1.bandwidth());',
  '    }',
  '  } else {',
  '    var maxTotal = d3.max(chart.data, function (d) { return d.total; }) || 1;',
  '    var x = d3.scaleLinear().domain([0, maxTotal]).range([margin.left, width - margin.right]);',
  '    svg.append("g").selectAll("rect").data(chart.data).join("rect")',
  '      .attr("class", "chart-bar").attr("y", function (d) { return y(d.groupValue); }).attr("x", margin.left)',
  '      .attr("width", function (d) { return x(d.total) - margin.left; }).attr("height", y.bandwidth());',
  '    svg.append("g").selectAll("text").data(chart.data).join("text")',
  '      .attr("class", "chart-value").attr("x", function (d) { return x(d.total) + 6; })',
  '      .attr("y", function (d) { return y(d.groupValue) + y.bandwidth() / 2 + 4; }).text(function (d) { return d.total.toLocaleString("en-US"); });',
  '  }',
  '  svg.append("g").selectAll("text.chart-label").data(groupValues).join("text")',
  '    .attr("class", "chart-label").attr("x", 0).attr("y", function (d) { return y(d) + y.bandwidth() / 2 + 4; }).text(function (d) { return d; });',
  '}',
  'function drawLineChart(containerId, chart) {',
  '  var width = 480, height = 240, margin = { top: 10, right: 20, bottom: 30, left: 50 };',
  '  var svg = d3.select("#" + containerId).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title);',
  '  var x = d3.scalePoint().domain(chart.data.map(function (d) { return d.groupValue; })).range([margin.left, width - margin.right]);',
  '  var maxTotal = d3.max(chart.data, function (d) { return d.total; }) || 1;',
  '  var y = d3.scaleLinear().domain([0, maxTotal]).range([height - margin.bottom, margin.top]);',
  '  var line = d3.line().x(function (d) { return x(d.groupValue); }).y(function (d) { return y(d.total); });',
  '  svg.append("path").datum(chart.data).attr("class", "chart-bar").attr("fill", "none").attr("stroke", "#3F6659").attr("stroke-width", 2).attr("d", line);',
  '  svg.append("g").selectAll("circle").data(chart.data).join("circle")',
  '    .attr("class", "chart-bar").attr("cx", function (d) { return x(d.groupValue); }).attr("cy", function (d) { return y(d.total); }).attr("r", 3);',
  '  svg.append("g").selectAll("text").data(chart.data).join("text")',
  '    .attr("class", "chart-label").attr("x", function (d) { return x(d.groupValue); }).attr("y", height - 8).attr("text-anchor", "middle").text(function (d) { return d.groupValue; });',
  '}',
  'function drawPieChart(containerId, chart) {',
  '  var width = 320, height = 320, radius = Math.min(width, height) / 2 - 20;',
  '  var svg = d3.select("#" + containerId).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title)',
  '    .append("g").attr("transform", "translate(" + width / 2 + "," + height / 2 + ")");',
  '  var color = d3.scaleOrdinal().range(["#3F6659", "#B65A3C", "#6B6A61", "#DCE6E1"]);',
  '  var pieGen = d3.pie().value(function (d) { return d.total; });',
  '  var arcGen = d3.arc().innerRadius(chart.donut ? radius * 0.55 : 0).outerRadius(radius);',
  '  svg.selectAll("path").data(pieGen(chart.data)).join("path")',
  '    .attr("class", "chart-bar").style("fill", function (d) { return color(d.data.groupValue); }).attr("d", arcGen);',
  '  svg.selectAll("text").data(pieGen(chart.data)).join("text")',
  '    .attr("class", "chart-label").attr("transform", function (d) { return "translate(" + arcGen.centroid(d) + ")"; })',
  '    .attr("text-anchor", "middle").text(function (d) { return d.data.groupValue; });',
  '}',
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  Array.prototype.forEach.call(document.querySelectorAll(".chart"), function (section) {',
  '    var chartId = section.getAttribute("data-chart-id");',
  '    var chart = payload.charts.filter(function (c) { return c.id === chartId; })[0];',
  '    if (!chart) { return; }',
  '    var containerId = "chart-" + chartId;',
  '    if (typeof d3 === "undefined") {',
  '      renderChartFallback(containerId, chart);',
  '      return;',
  '    }',
  '    if (chart.type === "line") { drawLineChart(containerId, chart); }',
  '    else if (chart.type === "pie") { drawPieChart(containerId, chart); }',
  '    else { drawBarChart(containerId, chart); }',
  '  });',
  '});'
].join('\n');

function renderReportHtml(payload, config) {
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
    script += TABLE_PAGINATION_JS;
  }
  if (payload.charts.length) {
    script += CHART_CLIENT_JS;
  }
  var d3Script = payload.charts.length ? '<script src="' + D3_CDN_URL + '"></script>' : '';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>' + escapeHtml(config.target.fileName) + '</title>'
    + '<style>' + REPORT_CSS + '</style>' + d3Script + '</head><body>'
    + '<main><div class="kpis">' + kpiCards + '</div>' + chartSections + tableSections + '</main>'
    + '<script>' + script + '</script>'
    + '</body></html>';
}
