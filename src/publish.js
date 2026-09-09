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

// layout.type accepted values - see the design spec's §2. 'linear'
// (default) stacks every block in one column; 'board' positions charts/
// tables as a relatesTo-driven tree on a pan/zoomable canvas.
var LAYOUT_TYPES = ['linear', 'board'];

// Pinned exact version, never a floating tag - see CLAUDE.md's
// "Downstream consumers pinned to a release" for the same reasoning
// applied to a different kind of pin: a file reopened a year from now
// must load the exact D3 build it loaded the day it was generated.
var D3_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';

// Subresource Integrity for the exact D3_CDN_URL build above - pulled live
// from api.cdnjs.com/libraries/d3/7.9.0?fields=sri. A pinned version number
// pins a path, not the bytes served at it; this pins the bytes. Generated
// reports embed the user's full BigQuery result set in
// window.__PUBLISH_PAYLOAD__ on the same page this script loads into, and
// this library itself gets eval()'d with live OAuth access, so a swapped
// CDN response is worth defending against even though cdnjs is generally
// trusted.
var D3_CDN_INTEGRITY = 'sha512-vc58qvvBdrDR4etbxMdlTt4GBQk1qjvyORR2nrsPsFPyrs+/u5c3+1Ct6upOgdZoIl7eq6k3a1UPDSNAQi/32A==';

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

// A kpi/chart/table's own "source" override - same shape and same
// dependsOn requirement as config.source at the top of the file, just
// scoped to one block instead of the whole report. Mutually exclusive
// with that block's own reactsTo: reactsTo's client-side recompute
// (FILTER_CLIENT_JS's filteredRowsFor) only ever slices the report's one
// default row set, so a block fetching its own rows from elsewhere has
// nothing for a filter change to recompute against.
function validateBlockSource(blockType, blockId, block, dependsOn) {
  if (block.source === undefined) {
    return;
  }
  if (block.source.type !== 'ref' || !block.source.ref) {
    throw new Error('publish(): ' + blockType + ' "' + blockId + '" has "source", which must be { type: "ref", ref: "<nodeName>" }.');
  }
  if (dependsOn.indexOf(block.source.ref) === -1) {
    throw new Error('publish(): "' + block.source.ref + '" is used as ' + blockType + ' "' + blockId + '"\'s source.ref but is missing from dependsOn.');
  }
  if (block.reactsTo) {
    throw new Error('publish(): ' + blockType + ' "' + blockId + '" has both "source" and "reactsTo" - these are mutually exclusive.');
  }
}

// A kpi/chart/table's own "detail" drill-down config - { columns: [...] },
// same column shape as a raw table's own columns (field/label/format).
// Shape-only check; the "which block types may have detail at all" rule
// (charts always, aggregated tables only, never kpis) is enforced at
// each call site below since the restriction differs per block type.
function validateDetail(blockType, blockId, detail) {
  if (detail === undefined) {
    return;
  }
  if (!Array.isArray(detail.columns) || !detail.columns.length) {
    throw new Error('publish(): ' + blockType + ' "' + blockId + '" has "detail", which must be { columns: [...] } with a non-empty "columns" array.');
  }
  detail.columns.forEach(function (column) {
    if (!column.field) {
      throw new Error('publish(): ' + blockType + ' "' + blockId + '" has a detail column missing "field".');
    }
    if (column.format && PUBLISH_VALUE_FORMATS.indexOf(column.format) === -1) {
      throw new Error('publish(): ' + blockType + ' "' + blockId + '" detail column "' + column.field + '" has format "' + column.format + '" - expected one of ' + PUBLISH_VALUE_FORMATS.join(', ') + '.');
    }
  });
}

// relatesTo (charts[]/tables[] only) declares one block's parent in a
// layout:'board' tree - undefined/absent means "root". Runs once, after
// every per-block loop in validatePublishConfig has already confirmed
// ids are present and duplicate-free *within* charts[] and *within*
// tables[] separately; this function additionally requires ids to be
// unique *across* charts[] and tables[] combined, since computeBoardLayout/
// renderBoardCanvas key a single positionById/sectionById map by id across
// both arrays unconditionally whenever layout.type is 'board' - not only
// when a block happens to declare relatesTo. So the cross-array check
// below (and the self-ref/unknown-id/cycle checks that build on the same
// parentOf map) run for every board-layout report; only the "relatesTo
// requires layout.type board" throw is actually gated on relatesToUsed -
// no other publish() feature needs a combined namespace today (linkTo/
// detail/reactsTo never cross-reference a chart id against a table id),
// so this is a new rule, not a relaxation of an old one.
function validateBoardRelations(config) {
  var charts = config.charts || [];
  var tables = config.tables || [];
  var layoutType = (config.layout && config.layout.type) || 'linear';
  var relatesToUsed = charts.concat(tables).some(function (block) { return block.relatesTo; });

  if (relatesToUsed && layoutType !== 'board') {
    throw new Error('publish(): "relatesTo" is set on a chart or table, which requires layout.type "board".');
  }
  if (layoutType !== 'board') {
    return;
  }

  var parentOf = emptyMap();
  function registerBlock(id) {
    if (has(parentOf, id)) {
      throw new Error('publish(): "' + id + '" is used as both a chart id and a table id - "relatesTo" ids must be unique across charts[] and tables[].');
    }
  }
  charts.forEach(function (chart) { registerBlock(chart.id); parentOf[chart.id] = chart.relatesTo || null; });
  tables.forEach(function (table) { registerBlock(table.id); parentOf[table.id] = table.relatesTo || null; });

  Object.keys(parentOf).forEach(function (id) {
    var relatesTo = parentOf[id];
    if (relatesTo === null) {
      return;
    }
    if (relatesTo === id) {
      throw new Error('publish(): "' + id + '" has "relatesTo" pointing at itself.');
    }
    if (!has(parentOf, relatesTo)) {
      throw new Error('publish(): "' + id + '" has "relatesTo: ' + relatesTo + '", which doesn\'t match any declared chart/table id.');
    }
  });

  Object.keys(parentOf).forEach(function (id) {
    var seen = emptyMap();
    var current = id;
    while (parentOf[current]) {
      if (has(seen, current)) {
        throw new Error('publish(): "relatesTo" forms a cycle at "' + current + '".');
      }
      seen[current] = true;
      current = parentOf[current];
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
  var layoutType = (config.layout && config.layout.type) || 'linear';
  if (LAYOUT_TYPES.indexOf(layoutType) === -1) {
    throw new Error('publish(): layout.type "' + layoutType + '" - expected one of ' + LAYOUT_TYPES.join(', ') + '.');
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
    validateBlockSource('kpi', kpi.label, kpi, config.dependsOn);
    if (kpi.detail) {
      throw new Error('publish(): kpi "' + kpi.label + '" has "detail", which only "chart" and "table" support.');
    }
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
    if (chart.linkTo) {
      if (!chart.linkTo.node || !chart.linkTo.field) {
        throw new Error('publish(): chart "' + chart.id + '" has "linkTo", which requires "node" and "field".');
      }
      if (chart.linkTo.newTab !== undefined && typeof chart.linkTo.newTab !== 'boolean') {
        throw new Error('publish(): chart "' + chart.id + '" has linkTo.newTab "' + chart.linkTo.newTab + '", which must be a boolean.');
      }
      if (chart.linkKey || chart.seriesLinkKey) {
        throw new Error('publish(): chart "' + chart.id + '" has both "linkTo" and "linkKey"/"seriesLinkKey" - these are mutually exclusive.');
      }
    }
    if (chart.detail) {
      if (chart.linkKey || chart.seriesLinkKey) {
        throw new Error('publish(): chart "' + chart.id + '" has both "detail" and "linkKey"/"seriesLinkKey" - these are mutually exclusive.');
      }
      if (chart.linkTo) {
        throw new Error('publish(): chart "' + chart.id + '" has both "detail" and "linkTo" - these are mutually exclusive.');
      }
    }
    validateDetail('chart', chart.id, chart.detail);
    validateReactsTo('chart', chart.id, chart.reactsTo, seenFilterFields);
    validateBlockSource('chart', chart.id, chart, config.dependsOn);
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
    validateBlockSource('table', table.id, table, config.dependsOn);
    if (table.detail && table.mode !== 'aggregated') {
      throw new Error('publish(): table "' + table.id + '" has "detail", which only "aggregated" tables support.');
    }
    validateDetail('table', table.id, table.detail);
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
  validateBoardRelations(config);
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

// linkTo's whole cross-node resolution, and it's pure - no Drive/BigQuery
// call anywhere in it. The reports this library generates are meant to be
// downloaded (or synced via Drive for Desktop) into one local folder and
// opened straight in a browser, not viewed through Drive's own web
// preview - so "the destination's URL" is just its own declared
// target.fileName, a plain relative link the browser resolves against
// wherever the *current* file happens to be sitting, exactly like two
// spreadsheet tabs cross-referencing each other by name. This also means
// there's no "the destination must have been published first" ordering
// requirement the way an earlier version of this feature (resolving a
// live Drive file id) had - a relative filename is valid the moment both
// configs exist, regardless of which one has actually run.
//
// Confirms chart.linkTo.node names a declared publish node whose
// filters[] can actually receive the field this chart will send on click
// (the same typo-guard reasoning validateReactsTo already applies to
// reactsTo, just across two nodes instead of one).
function validateLinkToTarget(chart, allNodes) {
  var targetNode = (allNodes || []).filter(function (node) { return node.name === chart.linkTo.node; })[0];
  if (!targetNode) {
    throw new Error('publish(): chart "' + chart.id + '" has linkTo.node "' + chart.linkTo.node + '", which doesn\'t match any declared node.');
  }
  if (targetNode.kind !== 'publish') {
    throw new Error('publish(): chart "' + chart.id + '" has linkTo.node "' + chart.linkTo.node + '", which is a "' + targetNode.kind + '" node, not "publish".');
  }
  var targetConfig = targetNode.config;
  var hasMatchingFilter = (targetConfig.filters || []).some(function (filter) { return filter.field === chart.linkTo.field; });
  if (!hasMatchingFilter) {
    throw new Error('publish(): chart "' + chart.id + '" links to "' + chart.linkTo.node + '" on field "' + chart.linkTo.field + '", but that node has no filters[] entry for that field.');
  }
  return targetConfig;
}

// Produces a copy of config with every chart's linkTo swapped from
// {node, field, newTab} (declared) to {url, field, newTab} (resolved,
// url being the destination's own target.fileName) -
// buildChartPayload/buildFilterableConfig downstream (including the
// client-side re-invocation of buildChartPayload via
// FILTER_REUSED_FUNCTIONS_JS) never need to know about node names, only
// the already-resolved relative url. A no-op copy when no chart declares
// linkTo, so a report with none pays no cost.
function resolveConfigLinkTargets(config, allNodes) {
  if (!(config.charts || []).some(function (chart) { return chart.linkTo; })) {
    return config;
  }
  var charts = (config.charts || []).map(function (chart) {
    if (!chart.linkTo) { return chart; }
    var targetConfig = validateLinkToTarget(chart, allNodes);
    var resolvedChart = {};
    Object.keys(chart).forEach(function (key) { resolvedChart[key] = chart[key]; });
    resolvedChart.linkTo = { url: encodeURIComponent(targetConfig.target.fileName), field: chart.linkTo.field, newTab: chart.linkTo.newTab !== false };
    return resolvedChart;
  });
  var resolvedConfig = {};
  Object.keys(config).forEach(function (key) { resolvedConfig[key] = config[key]; });
  resolvedConfig.charts = charts;
  return resolvedConfig;
}

// Fetches one row set per distinct source.ref used by any kpi/chart/table
// (validateBlockSource already confirmed each one resolves and is listed
// in dependsOn) - once per ref, not once per block, so three blocks
// overriding to the same node don't triple-fetch the same table. Blocks
// with no override aren't in the returned map at all; buildReportPayload
// falls back to the report's own default rows for those.
function fetchBlockSourceRows(config, allNodes) {
  var refs = emptyMap();
  function collectRef(block) {
    if (block.source) {
      refs[block.source.ref] = true;
    }
  }
  (config.kpis || []).forEach(collectRef);
  (config.charts || []).forEach(collectRef);
  (config.tables || []).forEach(collectRef);
  var rowsByRef = emptyMap();
  Object.keys(refs).forEach(function (ref) {
    var location = resolvePublishSource(ref, allNodes);
    rowsByRef[ref] = fetchTableRows(location.projectId, location.dataset, location.table);
  });
  return rowsByRef;
}

// The EXECUTORS.publish entry. allNodes is optional and only used to
// resolve source.ref and any chart's linkTo.node - move()/model() ignore
// the same argument today (see cli.js's widened runNodes()), so this is
// the only kind that reads it so far.
function publish(config, allNodes) {
  validatePublishConfig(config);
  var location = resolvePublishSource(config.source.ref, allNodes);
  var resolvedConfig = resolveConfigLinkTargets(config, allNodes);
  var blockRowsByRef = fetchBlockSourceRows(resolvedConfig, allNodes);
  var rows = fetchTableRows(location.projectId, location.dataset, location.table);
  var payload = buildReportPayload(resolvedConfig, rows, blockRowsByRef);
  var html = renderReportHtml(payload, resolvedConfig);
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
    return { key: column.field, label: column.label || column.field, format: column.format || 'string' };
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
  var columns = [{ key: table.groupBy, label: table.groupBy, format: 'string' }].concat(table.metrics.map(function (metric) {
    return { key: metric.label, label: metric.label, format: metric.format || 'string' };
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
    return { id: chart.id, title: chart.title, type: chartType, series: chart.series, stacking: chart.stacking || 'grouped', seriesKeys: seriesKeys, data: data, linkKey: chart.linkKey, seriesLinkKey: chart.seriesLinkKey, linkTo: chart.linkTo };
  }
  var grouped = groupRowsBy(rows, chart.groupBy);
  var data = grouped.order.map(function (key) {
    return { groupValue: key, total: computeAggregate(grouped.groups[key], chart.metric.agg, chart.metric.field) };
  });
  if (chartType === 'line') {
    data.sort(function (a, b) { return compareGroupValues(a.groupValue, b.groupValue); });
  }
  return { id: chart.id, title: chart.title, type: chartType, donut: !!chart.donut, data: data, linkKey: chart.linkKey, linkTo: chart.linkTo };
}

// Distinct values for one filters[] field, sorted ascending as plain
// strings - a dropdown's option list, not a plotted axis, so no need for
// compareGroupValues' numeric-aware sort (that sort exists for chart
// axes, this is for picking a value).
function computeFilterOptions(rows, field) {
  var seen = emptyMap();
  var options = [];
  rows.forEach(function (row) {
    var value = row[field];
    if (value === null || value === undefined) { return; }
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

// Picks a block's own source-override rows (fetchBlockSourceRows's
// result, keyed by ref) over the report's default rows when it declared
// one - validateBlockSource already guarantees the two aren't both
// present alongside reactsTo, so this is the only branch point
// buildReportPayload's three block loops need.
function rowsForBlock(block, defaultRows, blockRowsByRef) {
  return block.source ? blockRowsByRef[block.source.ref] : defaultRows;
}

// Attaches a block's own "detail" drill-down data to its already-built
// payload object - {groupBy, series, columns, rows}, where `rows` is
// rowsForBlock's result (the block's own resolved row set) trimmed down
// to only the fields the client ever reads off a detail row: each
// declared detail.columns[i].field (rendered in the modal), plus
// groupBy/series (used to filter rows by the clicked group/segment) -
// never the row's full source-table shape, so a column outside those
// three never reaches the embedded __PUBLISH_PAYLOAD__ even though the
// aggregate/chart itself was computed from every column. `series` is
// undefined for a table or a non-series chart - harmless, the client
// only reads it when a chart's own series field is also present. No-op
// (returns `built` unchanged) when the block didn't declare "detail" -
// kept in the same FILTER_REUSED_FUNCTIONS_JS list buildChartPayload/
// buildRawTablePayload/buildAggregatedTablePayload already live in,
// since a reactsTo block's client-side recompute (applyFilterToChart/
// applyFilterToTable below) needs to re-run this too, not just the
// server-side build.
function withDetail(built, block, rows) {
  if (block.detail) {
    var fields = block.detail.columns.map(function (column) { return column.field; });
    if (block.groupBy) { fields.push(block.groupBy); }
    if (block.series) { fields.push(block.series); }
    var trimmedRows = rows.map(function (row) {
      var trimmed = emptyMap();
      fields.forEach(function (field) { trimmed[field] = row[field]; });
      return trimmed;
    });
    built.detail = { groupBy: block.groupBy, series: block.series, columns: block.detail.columns, rows: trimmedRows };
  }
  return built;
}

function buildReportPayload(config, rows, blockRowsByRef) {
  blockRowsByRef = blockRowsByRef || emptyMap();
  var kpis = (config.kpis || []).map(function (kpi) {
    var kpiRows = rowsForBlock(kpi, rows, blockRowsByRef);
    var value = computeAggregate(kpiRows, kpi.agg, kpi.field);
    return { label: kpi.label, value: value, formatted: formatValue(value, kpi.format) };
  });
  var charts = (config.charts || []).map(function (chart) {
    var chartRows = rowsForBlock(chart, rows, blockRowsByRef);
    return withDetail(buildChartPayload(chart, chartRows), chart, chartRows);
  });
  var tables = (config.tables || []).map(function (table) {
    var tableRows = rowsForBlock(table, rows, blockRowsByRef);
    var built = table.mode === 'raw' ? buildRawTablePayload(table, tableRows) : buildAggregatedTablePayload(table, tableRows);
    return withDetail(built, table, tableRows);
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Fixed box/gap sizing for layout:'board' - no per-report customization
// in v1, same posture the REPORT_CSS design tokens already have.
var BOARD_BOX_WIDTH = 520;
var BOARD_BOX_HEIGHT = 340;
var BOARD_H_GAP = 40;
var BOARD_V_GAP = 60;

// Contour-based tidy-tree layout for layout:'board' (a simplified
// Reingold-Tilford/Walker walk, not the full Buchheim O(n) apportionment
// pass - see the ponytail note on shiftPastSiblingContour below for why
// that's the right stopping point). blocks with no relatesTo are roots,
// treated as siblings of an implicit super-root so multiple trees land
// side by side through the exact same clearance mechanism as any other
// sibling group - no separate "offset past the previous tree" special
// case. Trusts validateBoardRelations already ran (acyclic, every
// id/relatesTo resolves) - does no error-checking of its own.
//
// layoutSubtree(id) returns the subtree rooted at `id` laid out in its
// own *local* coordinates (its own root at relative x=0): `positions`
// (id/x/depth-from-this-root, depth 0 = the root itself), and
// `leftContour`/`rightContour` (index d = the min/max x reached by any
// node at depth d within this subtree, in these same local coordinates).
// A subtree with no children is the base case: itself, alone, at x=0.
function layoutSubtree(id, children) {
  var kids = children[id] || [];
  if (!kids.length) {
    return { x: 0, positions: [{ id: id, x: 0, depth: 0 }], leftContour: [0], rightContour: [BOARD_BOX_WIDTH] };
  }

  var combinedLeft = [];
  var combinedRight = [];
  var offsets = kids.map(function (childId, i) {
    var child = layoutSubtree(childId, children);
    var offset = i === 0 ? 0 : shiftPastSiblingContour(child, combinedLeft, combinedRight);
    mergeContour(combinedLeft, combinedRight, child, offset);
    return { child: child, offset: offset };
  });

  var positions = [];
  var childXs = [];
  offsets.forEach(function (o) {
    o.child.positions.forEach(function (p) {
      positions.push({ id: p.id, x: p.x + o.offset, depth: p.depth + 1 });
    });
    childXs.push(o.child.x + o.offset);
  });
  var myX = (Math.min.apply(null, childXs) + Math.max.apply(null, childXs)) / 2;
  positions.push({ id: id, x: myX, depth: 0 });

  return {
    x: myX,
    positions: positions,
    leftContour: [myX].concat(combinedLeft),
    rightContour: [myX + BOARD_BOX_WIDTH].concat(combinedRight)
  };
}

// Minimum rightward shift so `child`'s own left contour clears
// `siblingLeft`/`siblingRight` (the contour merged from every sibling
// already placed) by at least BOARD_H_GAP at every depth both reach -
// this is the actual fix over the old nextSlot counter: clearance is
// checked against siblings' real per-depth shape, not a fixed leaf-slot
// width, so a subtree that's narrow at a shallow depth but wide deeper
// down only pushes its neighbor as far as its worst *single* depth
// requires, not its total leaf count.
//
// ponytail: this is a greedy left-to-right contour merge, not a full
// Buchheim/Walker apportionment pass - it never shifts an *earlier*
// sibling back left to tighten the result once a later one turns out
// narrower than it. That means a very bushy, uneven board can end up
// slightly wider than the true minimum. The design spec already notes
// board box counts are small in realistic dashboards, so exact-minimum
// packing isn't worth the extra pass; upgrade to full apportionment if a
// real board ever has enough boxes for the slack to visibly matter.
function shiftPastSiblingContour(child, siblingLeft, siblingRight) {
  var shift = 0;
  for (var d = 0; d < child.leftContour.length && d < siblingRight.length; d++) {
    var need = siblingRight[d] + BOARD_H_GAP - child.leftContour[d];
    if (need > shift) { shift = need; }
  }
  return shift;
}

// Folds `child`'s contour (shifted by `offset`) into the running
// `combinedLeft`/`combinedRight` arrays, in place.
function mergeContour(combinedLeft, combinedRight, child, offset) {
  for (var d = 0; d < child.leftContour.length; d++) {
    var l = child.leftContour[d] + offset;
    var r = child.rightContour[d] + offset;
    combinedLeft[d] = (combinedLeft[d] === undefined) ? l : Math.min(combinedLeft[d], l);
    combinedRight[d] = (combinedRight[d] === undefined) ? r : Math.max(combinedRight[d], r);
  }
}

function computeBoardLayout(charts, tables) {
  var blocks = (charts || []).concat(tables || []);
  var children = emptyMap();
  var roots = [];
  var edges = [];
  blocks.forEach(function (block) {
    if (block.relatesTo) {
      children[block.relatesTo] = children[block.relatesTo] || [];
      children[block.relatesTo].push(block.id);
      edges.push({ from: block.relatesTo, to: block.id });
    } else {
      roots.push(block.id);
    }
  });

  var positions = [];
  var combinedLeft = [];
  var combinedRight = [];
  roots.forEach(function (rootId, i) {
    var root = layoutSubtree(rootId, children);
    var offset = i === 0 ? 0 : shiftPastSiblingContour(root, combinedLeft, combinedRight);
    root.positions.forEach(function (p) {
      positions.push({ id: p.id, x: p.x + offset, y: p.depth * (BOARD_BOX_HEIGHT + BOARD_V_GAP) });
    });
    mergeContour(combinedLeft, combinedRight, root, offset);
  });

  return { positions: positions, edges: edges };
}

// Fixed design tokens - see the design spec's "Design tokens" section.
// No per-report customization in v1: every published dashboard looks the
// same on purpose, the same way every model's compiled SQL follows one
// convention rather than a per-model style knob. This now means exactly
// two fixed token sets (light default + dark), switched by the
// report-agnostic toggle in THEME_TOGGLE_HTML/THEME_INIT_JS/
// THEME_TOGGLE_JS below - still nothing a report author can configure.
// Colors follow Google's own Material palette (Workspace/Cloud Console
// grays, the rgba(60,64,67,...) elevation-shadow tint, Google's actual
// light/dark accent blues and reds) rather than an invented brand.
var DARK_TOKENS_CSS = '--paper: #202124; --surface: #292A2D; --paper-line: #3C4043; --ink: #E8EAED; --ink-soft: #9AA0A6; --teal: #8AB4F8; --teal-soft: #29344A; --coral: #F28B82; --shadow-sm: 0 1px 2px 0 rgba(0,0,0,.45), 0 2px 6px 2px rgba(0,0,0,.3); --shadow: 0 1px 3px 0 rgba(0,0,0,.5), 0 4px 8px 3px rgba(0,0,0,.35);';
var REPORT_CSS = [
  ':root {',
  '  --paper: #F8F9FA; --surface: #FFFFFF; --paper-line: #DADCE0; --ink: #202124; --ink-soft: #5F6368;',
  '  --teal: #1A73E8; --teal-soft: #E8F0FE; --coral: #EA4335;',
  '  --shadow-sm: 0 1px 2px 0 rgba(60,64,67,.30), 0 2px 6px 2px rgba(60,64,67,.15);',
  '  --shadow: 0 1px 3px 0 rgba(60,64,67,.30), 0 4px 8px 3px rgba(60,64,67,.15);',
  '  --radius: 8px; --radius-sm: 4px;',
  '  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;',
  '  --sans: Roboto, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;',
  '}',
  '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ' + DARK_TOKENS_CSS + ' } }',
  ':root[data-theme="dark"] { ' + DARK_TOKENS_CSS + ' }',
  'body { background: var(--paper); color: var(--ink); font-family: var(--sans); margin: 0; padding: 24px; }',
  '.kpis { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }',
  '.kpi { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 12px 16px; transition: box-shadow .15s ease, transform .15s ease; }',
  '.kpi:hover { box-shadow: var(--shadow); transform: translateY(-1px); }',
  '.kpi-label { font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; color: var(--ink-soft); }',
  '.kpi-value { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 24px; }',
  '.chart { background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 20px; margin-top: 16px; }',
  '.chart h2 { font-size: 14px; margin-top: 0; }',
  '.chart-label, .chart-value { font-family: var(--mono); font-size: 12px; fill: var(--ink); }',
  '.chart-bar { fill: var(--teal); }',
  '.table-block { background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 20px; margin-top: 16px; }',
  '.table-block h2 { font-size: 14px; margin-top: 0; }',
  '.table-block table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }',
  '.table-block th, .table-block td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--paper-line); font-variant-numeric: tabular-nums; }',
  '.table-block th.table-sortable { cursor: pointer; user-select: none; }',
  '.table-block tbody tr:hover { background: var(--teal-soft); }',
  '.table-search { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 2px 6px; margin-bottom: 8px; display: block; transition: border-color .15s ease; }',
  '.table-search:hover, .table-search:focus-visible { border-color: var(--teal); }',
  '.table-pager { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-family: var(--mono); font-size: 12px; }',
  '.table-pager button { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 2px 8px; cursor: pointer; transition: border-color .15s ease; }',
  '.table-pager button:hover:not(:disabled) { border-color: var(--teal); }',
  '.table-pager button:disabled { color: var(--ink-soft); cursor: default; }',
  '.filters { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }',
  '.filter { font-family: var(--mono); font-size: 12px; display: flex; flex-direction: column; gap: 4px; }',
  '.filter select { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 2px 6px; transition: border-color .15s ease; }',
  '.filter select:hover, .filter select:focus-visible { border-color: var(--teal); }',
  '.detail-modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; z-index: 1000; }',
  '.detail-modal { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px; max-width: 90vw; max-height: 80vh; overflow: auto; }',
  '.detail-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }',
  '.detail-modal-header h3 { margin: 0; font-size: 14px; }',
  '.detail-modal-close { font-family: var(--mono); font-size: 16px; background: none; border: none; cursor: pointer; }',
  '.detail-modal table { border-collapse: collapse; font-family: var(--mono); font-size: 12px; }',
  '.detail-modal th, .detail-modal td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--paper-line); }',
  '.theme-toggle { position: fixed; top: 12px; right: 12px; z-index: 1100; width: 32px; height: 32px; border-radius: 999px; border: 1px solid var(--paper-line); background: var(--surface); color: var(--ink-soft); display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: var(--shadow-sm); transition: background-color .15s ease, border-color .15s ease, color .15s ease; }',
  '.theme-toggle:hover { color: var(--teal); border-color: var(--teal); }',
  '.theme-toggle-icon-moon { display: none; }',
  '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .theme-toggle-icon-sun { display: none; } :root:not([data-theme="light"]) .theme-toggle-icon-moon { display: block; } }',
  ':root[data-theme="dark"] .theme-toggle-icon-sun { display: none; }',
  ':root[data-theme="dark"] .theme-toggle-icon-moon { display: block; }'
].join('\n');

// CSS for table detail toggle button, only emitted when detail is configured
// on at least one table or chart.
var TABLE_DETAIL_CSS = '.table-detail-toggle { font-family: var(--mono); font-size: 12px; background: none; border: none; cursor: pointer; padding: 0 4px; }';

// CSS for layout:'board', only emitted when config.layout.type is
// 'board' (see renderReportHtml's isBoardLayout branch below).
var BOARD_CSS = [
  '.board-viewport { position: relative; width: 100%; height: 80vh; overflow: hidden; border: 1px solid var(--paper-line); border-radius: var(--radius); cursor: grab; }',
  '.board-viewport.board-panning { cursor: grabbing; }',
  '.board-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }',
  '.board-node { position: absolute; background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 12px; box-sizing: border-box; overflow: auto; }',
  '.board-node .chart, .board-node .table-block { border: none; box-shadow: none; margin-top: 0; padding: 0; }',
  '.board-edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }',
  '.board-edge { fill: none; stroke: var(--paper-line); stroke-width: 2; }'
].join('\n');

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

// The exact functions filters[] needs to re-run client-side, serialized
// once at module load (these are static function references, so this
// only runs once no matter how many reports get generated in one run) -
// reused verbatim rather than hand-ported, so any future change to any
// of them is automatically correct in the browser too. See the design
// spec's §4 for the "why toString()" rationale and its one constraint:
// none of these ten functions may ever reference a GAS-only global
// (BigQuery, DriveApp, Utilities, etc.) - doing so would silently break
// filters[] only in the browser, not caught by any Node test. A named
// function declaration's .toString() output is itself valid top-level
// source, so no wrapping is needed - it drops straight into the
// generated <script> as ordinary, hoisted function declarations.
var FILTER_REUSED_FUNCTIONS_JS = [
  emptyMap, has, computeAggregate, groupRowsBy, compareGroupValues,
  formatValue, buildChartPayload, buildRawTablePayload, buildAggregatedTablePayload, withDetail
].map(function (fn) { return fn.toString(); }).join('\n');

// The filter dropdowns' own wiring: composes every currently-active
// (non-"All") filter with AND semantics, recomputes only the
// kpis/charts/tables that opted in via reactsTo (payload.filterableConfig,
// see buildFilterableConfig), and leaves everything else exactly as
// currently rendered. Reuses FILTER_REUSED_FUNCTIONS_JS's functions and
// CHART_CLIENT_JS/TABLE_CLIENT_JS's existing draw/pagination machinery -
// this module never re-implements drawing or pagination itself.
var FILTER_CLIENT_JS = [
  'var activeFilters = emptyMap();',
  'function filteredRowsFor(reactsTo) {',
  '  var relevant = reactsTo.filter(function (f) { return has(activeFilters, f); });',
  '  var rows = window.__PUBLISH_PAYLOAD__.rows;',
  '  if (!relevant.length) { return rows; }',
  '  return rows.filter(function (row) { return relevant.every(function (f) { return row[f] === activeFilters[f]; }); });',
  '}',
  'function applyFilterToKpi(entry) {',
  '  var filteredRows = filteredRowsFor(entry.config.reactsTo);',
  '  var value = computeAggregate(filteredRows, entry.config.agg, entry.config.field);',
  '  var card = document.querySelectorAll(".kpi")[entry.index];',
  '  if (card) { card.querySelector(".kpi-value").textContent = formatValue(value, entry.config.format); }',
  '}',
  'function applyFilterToChart(chartConfig) {',
  '  var filteredRows = filteredRowsFor(chartConfig.reactsTo);',
  '  var newChart = withDetail(buildChartPayload(chartConfig, filteredRows), chartConfig, filteredRows);',
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
  '  var newTable = withDetail(tableConfig.mode === "raw" ? buildRawTablePayload(tableConfig, filteredRows) : buildAggregatedTablePayload(tableConfig, filteredRows), tableConfig, filteredRows);',
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
  // linkTo's destination-side counterpart to handleChartClick's
  // navigation: a query-string field matching one of this report's own
  // filters[] pre-selects that dropdown and recomputes on load, exactly
  // as if a human had picked it - no separate config needed on this side,
  // since matching field names is the only contract the two ends share.
  // A value with no matching option (typo, or the source row's value
  // isn't one of this report\'s own distinct values) is ignored rather
  // than forced, so an unrelated/stale query string never leaves the page
  // stuck on a dead filter selection.
  'function applyFiltersFromQueryString() {',
  '  var params = new URLSearchParams(window.location.search);',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  var applied = false;',
  '  Array.prototype.forEach.call(document.querySelectorAll("[data-filter-field]"), function (select) {',
  '    var field = select.getAttribute("data-filter-field");',
  '    if (!params.has(field)) { return; }',
  '    var value = params.get(field);',
  '    var filter = payload.filters.filter(function (f) { return f.field === field; })[0];',
  '    if (!filter || filter.options.indexOf(value) === -1) { return; }',
  '    activeFilters[field] = value;',
  '    select.value = value;',
  '    applied = true;',
  '  });',
  '  if (applied) { applyFilters(); }',
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
  '  applyFiltersFromQueryString();',
  '});'
].join('\n');

// The subset of FILTER_REUSED_FUNCTIONS_JS's functions the detail modal
// itself needs (buildRawTablePayload, and formatValue it calls) - shipped
// only when a report has "detail" but no filters[] at all, since
// FILTER_REUSED_FUNCTIONS_JS already ships a superset otherwise and
// declaring the same function twice in one <script> would be redundant
// (see renderReportHtml's hasFilters/hasDetail branch below).
var DETAIL_REUSED_FUNCTIONS_JS = [formatValue, buildRawTablePayload].map(function (fn) { return fn.toString(); }).join('\n');

// One generic modal, shared by the table-detail toggle (TABLE_CLIENT_JS)
// and the chart-detail click branch (CHART_CLIENT_JS's handleChartClick) -
// both already have their own {columns, rows} (buildRawTablePayload's
// output shape) by the time they call this, so this only ever renders,
// never computes. Built via createElement/textContent only, same rule as
// TABLE_CLIENT_JS's own row rendering.
var DETAIL_CLIENT_JS = [
  'function closeDetailModal() {',
  '  var modal = document.getElementById("publish-detail-modal");',
  '  if (modal) { modal.parentNode.removeChild(modal); }',
  '}',
  'function openDetailModal(title, columns, rows) {',
  '  closeDetailModal();',
  '  var backdrop = document.createElement("div");',
  '  backdrop.id = "publish-detail-modal";',
  '  backdrop.className = "detail-modal-backdrop";',
  '  backdrop.addEventListener("click", function (event) { if (event.target === backdrop) { closeDetailModal(); } });',
  '  var box = document.createElement("div");',
  '  box.className = "detail-modal";',
  '  var header = document.createElement("div");',
  '  header.className = "detail-modal-header";',
  '  var heading = document.createElement("h3");',
  '  heading.textContent = title;',
  '  var closeBtn = document.createElement("button");',
  '  closeBtn.type = "button";',
  '  closeBtn.className = "detail-modal-close";',
  '  closeBtn.textContent = "\\u00d7";',
  '  closeBtn.addEventListener("click", closeDetailModal);',
  '  header.appendChild(heading);',
  '  header.appendChild(closeBtn);',
  '  var table = document.createElement("table");',
  '  var thead = document.createElement("thead");',
  '  var headRow = document.createElement("tr");',
  '  columns.forEach(function (column) {',
  '    var th = document.createElement("th");',
  '    th.textContent = column.label;',
  '    headRow.appendChild(th);',
  '  });',
  '  thead.appendChild(headRow);',
  '  var tbody = document.createElement("tbody");',
  '  rows.forEach(function (row) {',
  '    var tr = document.createElement("tr");',
  '    row.forEach(function (cell) {',
  '      var td = document.createElement("td");',
  '      td.textContent = cell;',
  '      tr.appendChild(td);',
  '    });',
  '    tbody.appendChild(tr);',
  '  });',
  '  table.appendChild(thead);',
  '  table.appendChild(tbody);',
  '  box.appendChild(header);',
  '  box.appendChild(table);',
  '  backdrop.appendChild(box);',
  '  document.body.appendChild(backdrop);',
  '}',
  'document.addEventListener("keydown", function (event) { if (event.key === "Escape") { closeDetailModal(); } });'
].join('\n');

var TABLE_DETAIL_TOGGLE_HANDLER_JS = [
  '    section.addEventListener("click", function (event) {',
  '      var toggle = event.target.closest && event.target.closest(".table-detail-toggle");',
  '      if (!toggle || !table.detail) { return; }',
  '      var groupValue = toggle.getAttribute("data-group-value");',
  '      var matching = table.detail.rows.filter(function (row) { return row[table.detail.groupBy] === groupValue; });',
  '      var built = buildRawTablePayload({ columns: table.detail.columns }, matching);',
  '      openDetailModal(table.title + ": " + groupValue, built.columns, built.rows);',
  '    });'
].join('\n');

// Static first page (readable with zero JS, same as the KPI cards/SVG
// chart above) plus inert-without-JS pager controls. table.rows already
// holds every row, pre-formatted (see buildRawTablePayload/
// buildAggregatedTablePayload) - only the first pageSize rows render here;
// the rest reaches the browser via the existing __PUBLISH_PAYLOAD__ embed,
// for TABLE_CLIENT_JS below to page through (and export as CSV).
function renderTableSection(table) {
  var firstPageRows = table.rows.slice(0, table.pageSize);
  var pageCount = Math.max(1, Math.ceil(table.rows.length / table.pageSize));
  var headerCells = table.columns.map(function (column, index) {
    return '<th class="table-sortable" data-col-index="' + index + '">' + escapeHtml(column.label) + '</th>';
  }).join('');
  var detailHeaderCell = table.detail ? '<th></th>' : '';
  var bodyRows = firstPageRows.map(function (row) {
    var detailCell = table.detail ? '<td><button type="button" class="table-detail-toggle" data-group-value="' + escapeHtml(row[0]) + '">▸</button></td>' : '';
    return '<tr>' + detailCell + row.map(function (cell) { return '<td>' + escapeHtml(cell) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<section class="table-block" data-table-id="' + escapeHtml(table.id) + '">'
    + '<h2>' + escapeHtml(table.title) + '</h2>'
    + '<input type="text" class="table-search" placeholder="Search...">'
    + '<table><thead><tr>' + detailHeaderCell + headerCells + '</tr></thead><tbody>' + bodyRows + '</tbody></table>'
    + '<div class="table-pager">'
    + '<button type="button" class="table-prev" disabled>Previous</button>'
    + '<span class="table-page-label">Page 1 of ' + pageCount + '</span>'
    + '<button type="button" class="table-next"' + (pageCount <= 1 ? ' disabled' : '') + '>Next</button>'
    + '<button type="button" class="table-csv-export">Export CSV</button>'
    + '</div></section>';
}

// One generic client-side handler for every table.table-block on the page -
// pagination plus CSV export, both reading columns/rows/pageSize back off
// window.__PUBLISH_PAYLOAD__ by data-table-id, never re-computing or
// re-formatting a value (everything's already a formatted string in the
// payload). Pagination builds <tr>/<td> via createElement + textContent
// only, per this repo's rule against innerHTML/string-concatenated markup
// on payload-sourced data - see the design spec's Render section. CSV
// export always exports the full row set, not just the current page - it's
// already embedded for pagination, so there's no reason to limit it.
var TABLE_CLIENT_JS = [
  'function csvField(value) {',
  '  var str = String(value);',
  '  if (/^[=+@-]/.test(str)) { str = "\'" + str; }',
  '  if (/["\\r\\n,]/.test(str)) { return "\\"" + str.replace(/"/g, "\\"\\"") + "\\""; }',
  '  return str;',
  '}',
  // Numeric-aware only for non-"string" columns - a currency/integer/decimal
  // cell is already the formatted display string ("$1,234.56"), so sorting
  // it as text would put "$20.00" before "$5.00". Stripping everything but
  // digits/dot/minus recovers the underlying number; "string" columns (and
  // the aggregated groupBy column, which is always "string") sort
  // case-insensitively as text instead.
  'function sortableValue(cell, format) {',
  '  if (format === "string") { return String(cell).toLowerCase(); }',
  '  var num = Number(String(cell).replace(/[^0-9.-]/g, ""));',
  '  return isNaN(num) ? String(cell).toLowerCase() : num;',
  '}',
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  Array.prototype.forEach.call(document.querySelectorAll(".table-block"), function (section) {',
  '    var tableId = section.getAttribute("data-table-id");',
  '    var table = payload.tables.filter(function (t) { return t.id === tableId; })[0];',
  '    if (!table) { return; }',
  '    var page = 0;',
  '    var pageCount = Math.max(1, Math.ceil(table.rows.length / table.pageSize));',
  '    var sortColumn = null;',
  '    var sortDir = "asc";',
  '    var searchQuery = "";',
  '    var tbody = section.querySelector("tbody");',
  '    var prevBtn = section.querySelector(".table-prev");',
  '    var nextBtn = section.querySelector(".table-next");',
  '    var pageLabel = section.querySelector(".table-page-label");',
  '    var csvBtn = section.querySelector(".table-csv-export");',
  '    var searchInput = section.querySelector(".table-search");',
  '    var headerCells = Array.prototype.slice.call(section.querySelectorAll(".table-sortable"));',
  // Search first, then sort - order doesn't affect the result (search
  // filters by value regardless of position, sort reorders what's left),
  // but filtering first keeps the sort comparator's input smaller.
  '    function visibleRows() {',
  '      var rows = table.rows;',
  '      if (searchQuery) {',
  '        var needle = searchQuery.toLowerCase();',
  '        rows = rows.filter(function (row) {',
  '          return row.some(function (cell) { return String(cell).toLowerCase().indexOf(needle) !== -1; });',
  '        });',
  '      }',
  '      if (sortColumn !== null) {',
  '        var format = table.columns[sortColumn].format;',
  '        var dir = sortDir === "desc" ? -1 : 1;',
  '        rows = rows.slice().sort(function (a, b) {',
  '          var av = sortableValue(a[sortColumn], format);',
  '          var bv = sortableValue(b[sortColumn], format);',
  '          if (av < bv) { return -1 * dir; }',
  '          if (av > bv) { return 1 * dir; }',
  '          return 0;',
  '        });',
  '      }',
  '      return rows;',
  '    }',
  '    function render() {',
  '      var visible = visibleRows();',
  '      pageCount = Math.max(1, Math.ceil(visible.length / table.pageSize));',
  '      if (page >= pageCount) { page = pageCount - 1; }',
  '      while (tbody.firstChild) { tbody.removeChild(tbody.firstChild); }',
  '      var start = page * table.pageSize;',
  '      visible.slice(start, start + table.pageSize).forEach(function (row) {',
  '        var tr = document.createElement("tr");',
  '        if (table.detail) {',
  '          var detailTd = document.createElement("td");',
  '          var toggle = document.createElement("button");',
  '          toggle.type = "button";',
  '          toggle.className = "table-detail-toggle";',
  '          toggle.textContent = "\\u25B8";',
  '          toggle.setAttribute("data-group-value", row[0]);',
  '          detailTd.appendChild(toggle);',
  '          tr.appendChild(detailTd);',
  '        }',
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
  '    window.__PUBLISH_TABLE_REPLACERS__ = window.__PUBLISH_TABLE_REPLACERS__ || {};',
  '    window.__PUBLISH_TABLE_REPLACERS__[tableId] = function (newTable) {',
  '      table = newTable;',
  '      page = 0;',
  '      render();',
  '    };',
  '    prevBtn.addEventListener("click", function () { if (page > 0) { page -= 1; render(); } });',
  '    nextBtn.addEventListener("click", function () { if (page < pageCount - 1) { page += 1; render(); } });',
  // Click cycles asc -> desc -> unsorted (back to the table's original
  // order) on that column; clicking a different column always restarts
  // the cycle at asc.
  '    headerCells.forEach(function (th) {',
  '      th.addEventListener("click", function () {',
  '        var colIndex = Number(th.getAttribute("data-col-index"));',
  '        if (sortColumn !== colIndex) {',
  '          sortColumn = colIndex;',
  '          sortDir = "asc";',
  '        } else if (sortDir === "asc") {',
  '          sortDir = "desc";',
  '        } else {',
  '          sortColumn = null;',
  '        }',
  '        page = 0;',
  '        render();',
  '      });',
  '    });',
  '    searchInput.addEventListener("input", function () {',
  '      searchQuery = searchInput.value;',
  '      page = 0;',
  '      render();',
  '    });',
  '    csvBtn.addEventListener("click", function () {',
  '      var exportRows = visibleRows();',
  '      var headerRow = table.columns.map(function (c) { return csvField(c.label); }).join(",");',
  '      var lines = exportRows.map(function (row) { return row.map(csvField).join(","); });',
  '      var csv = [headerRow].concat(lines).join("\\r\\n");',
  '      var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });',
  '      var url = URL.createObjectURL(blob);',
  '      var a = document.createElement("a");',
  '      a.href = url;',
  '      a.download = tableId + ".csv";',
  '      document.body.appendChild(a);',
  '      a.click();',
  '      document.body.removeChild(a);',
  '      URL.revokeObjectURL(url);',
  '    });'
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
  'var currentSelection = null;',
  'function chartSelectionFor(chart, groupValue, seriesValue) {',
  '  var selection = {};',
  '  if (chart.linkKey) { selection[chart.linkKey] = String(groupValue); }',
  '  if (chart.seriesLinkKey && seriesValue !== undefined) { selection[chart.seriesLinkKey] = String(seriesValue); }',
  '  return selection;',
  '}',
  'function selectionsEqual(a, b) {',
  '  var aKeys = Object.keys(a);',
  '  var bKeys = Object.keys(b);',
  '  if (aKeys.length !== bKeys.length) { return false; }',
  '  return aKeys.every(function (key) { return Object.prototype.hasOwnProperty.call(b, key) && b[key] === a[key]; });',
  '}',
  'function selectionMatches(chart, groupValue, seriesValue) {',
  '  if (!currentSelection) { return true; }',
  '  var ownKeys = [];',
  '  if (chart.linkKey) { ownKeys.push(chart.linkKey); }',
  '  if (chart.seriesLinkKey) { ownKeys.push(chart.seriesLinkKey); }',
  '  var relevant = ownKeys.filter(function (key) { return Object.prototype.hasOwnProperty.call(currentSelection, key); });',
  '  if (!relevant.length) { return true; }',
  '  var elementSelection = chartSelectionFor(chart, groupValue, seriesValue);',
  '  return relevant.every(function (key) { return elementSelection[key] === currentSelection[key]; });',
  '}',
  'function handleChartClick(chart, groupValue, seriesValue) {',
  '  if (chart.linkTo) {',
  '    var url = chart.linkTo.url + "?" + encodeURIComponent(chart.linkTo.field) + "=" + encodeURIComponent(groupValue);',
  '    if (chart.linkTo.newTab) { window.open(url, "_blank"); } else { window.location.href = url; }',
  '    return;',
  '  }',
  '  if (chart.detail) {',
  '    var matching = chart.detail.rows.filter(function (row) {',
  '      var groupMatch = row[chart.detail.groupBy] === groupValue;',
  '      return seriesValue === undefined ? groupMatch : groupMatch && row[chart.detail.series] === seriesValue;',
  '    });',
  '    var built = buildRawTablePayload({ columns: chart.detail.columns }, matching);',
  '    openDetailModal(chart.title + ": " + groupValue, built.columns, built.rows);',
  '    return;',
  '  }',
  '  var clicked = chartSelectionFor(chart, groupValue, seriesValue);',
  '  currentSelection = (currentSelection && selectionsEqual(currentSelection, clicked)) ? null : clicked;',
  '  applyHighlight();',
  '}',
  'function applyHighlight() {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  Array.prototype.forEach.call(document.querySelectorAll(".chart-canvas"), function (container) {',
  '    var chartId = container.id.replace(/^chart-/, "");',
  '    var chart = payload.charts.filter(function (c) { return c.id === chartId; })[0];',
  '    if (!chart || !(chart.linkKey || chart.seriesLinkKey)) { return; }',
  '    Array.prototype.forEach.call(container.querySelectorAll("[data-group-value]"), function (node) {',
  '      var groupValue = node.getAttribute("data-group-value");',
  '      var seriesValue = node.getAttribute("data-series-value");',
  '      var isMatch = selectionMatches(chart, groupValue, seriesValue === null ? undefined : seriesValue);',
  '      node.style.opacity = isMatch ? 1 : 0.25;',
  '    });',
  '  });',
  '}',
  'function drawBarChart(containerId, chart) {',
  '  var width = 480, height = Math.max(240, chart.data.length * 36), margin = { top: 10, right: 40, bottom: 10, left: 160 };',
  '  var svg = d3.select(document.getElementById(containerId)).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title);',
  '  var groupValues = chart.data.map(function (d) { return d.groupValue; });',
  '  var y = d3.scaleBand().domain(groupValues).range([margin.top, height - margin.bottom]).padding(0.2);',
  '  var color = d3.scaleOrdinal().range(["var(--teal)", "var(--coral)", "var(--ink-soft)", "var(--teal-soft)"]);',
  '  var interactive = !!(chart.linkKey || chart.seriesLinkKey || chart.linkTo || chart.detail);',
  '  if (chart.seriesKeys && chart.seriesKeys.length) {',
  '    color.domain(chart.seriesKeys);',
  '    if (chart.stacking === "stacked") {',
  '      var stackRows = chart.data.map(function (d) { var row = { groupValue: d.groupValue }; chart.seriesKeys.forEach(function (k) { row[k] = d.values[k]; }); return row; });',
  '      var stacked = d3.stack().keys(chart.seriesKeys)(stackRows);',
  '      var maxTotal = d3.max(stackRows, function (row) { return chart.seriesKeys.reduce(function (sum, k) { return sum + row[k]; }, 0); }) || 1;',
  '      var x = d3.scaleLinear().domain([0, maxTotal]).range([margin.left, width - margin.right]);',
  '      var segments = svg.append("g").selectAll("g").data(stacked).join("g")',
  '        .attr("class", "chart-bar").style("fill", function (d) { return color(d.key); })',
  '        .selectAll("rect").data(function (d) { return d; }).join("rect")',
  '        .attr("y", function (d) { return y(d.data.groupValue); }).attr("x", function (d) { return x(d[0]); })',
  '        .attr("width", function (d) { return x(d[1]) - x(d[0]); }).attr("height", y.bandwidth());',
  '      if (interactive) {',
  '        segments.attr("data-group-value", function (d) { return String(d.data.groupValue); }).style("cursor", "pointer");',
  '        if (chart.seriesLinkKey) {',
  '          segments.attr("data-series-value", function (d) { return String(d3.select(this.parentNode).datum().key); });',
  '        }',
  '        segments.on("click", function (event, d) {',
  '          var seriesKey = d3.select(this.parentNode).datum().key;',
  '          handleChartClick(chart, d.data.groupValue, chart.seriesLinkKey || chart.detail ? seriesKey : undefined);',
  '        });',
  '      }',
  '    } else {',
  '      var maxValue = d3.max(chart.data, function (d) { return d3.max(chart.seriesKeys, function (k) { return d.values[k]; }); }) || 1;',
  '      var x = d3.scaleLinear().domain([0, maxValue]).range([margin.left, width - margin.right]);',
  '      var y1 = d3.scaleBand().domain(chart.seriesKeys).range([0, y.bandwidth()]).padding(0.05);',
  '      var segments = svg.append("g").selectAll("g").data(chart.data).join("g")',
  '        .attr("transform", function (d) { return "translate(0," + y(d.groupValue) + ")"; })',
  '        .selectAll("rect").data(function (d) { return chart.seriesKeys.map(function (k) { return { key: k, value: d.values[k] }; }); }).join("rect")',
  '        .attr("class", "chart-bar").style("fill", function (d) { return color(d.key); })',
  '        .attr("y", function (d) { return y1(d.key); }).attr("x", margin.left)',
  '        .attr("width", function (d) { return x(d.value) - margin.left; }).attr("height", y1.bandwidth());',
  '      if (interactive) {',
  '        segments.attr("data-group-value", function (d) { return String(d3.select(this.parentNode).datum().groupValue); }).style("cursor", "pointer");',
  '        if (chart.seriesLinkKey) {',
  '          segments.attr("data-series-value", function (d) { return String(d.key); });',
  '        }',
  '        segments.on("click", function (event, d) {',
  '          var groupValue = d3.select(this.parentNode).datum().groupValue;',
  '          handleChartClick(chart, groupValue, chart.seriesLinkKey || chart.detail ? d.key : undefined);',
  '        });',
  '      }',
  '    }',
  '  } else {',
  '    var maxTotal = d3.max(chart.data, function (d) { return d.total; }) || 1;',
  '    var x = d3.scaleLinear().domain([0, maxTotal]).range([margin.left, width - margin.right]);',
  '    var bars = svg.append("g").selectAll("rect").data(chart.data).join("rect")',
  '      .attr("class", "chart-bar").attr("y", function (d) { return y(d.groupValue); }).attr("x", margin.left)',
  '      .attr("width", function (d) { return Math.max(0, x(d.total) - margin.left); }).attr("height", y.bandwidth());',
  '    if (interactive) {',
  '      bars.attr("data-group-value", function (d) { return String(d.groupValue); }).style("cursor", "pointer")',
  '        .on("click", function (event, d) { handleChartClick(chart, d.groupValue, undefined); });',
  '    }',
  '    svg.append("g").selectAll("text").data(chart.data).join("text")',
  '      .attr("class", "chart-value").attr("x", function (d) { return x(d.total) + 6; })',
  '      .attr("y", function (d) { return y(d.groupValue) + y.bandwidth() / 2 + 4; }).text(function (d) { return d.total.toLocaleString("en-US"); });',
  '  }',
  '  svg.append("g").selectAll("text.chart-label").data(groupValues).join("text")',
  '    .attr("class", "chart-label").attr("x", 0).attr("y", function (d) { return y(d) + y.bandwidth() / 2 + 4; }).text(function (d) { return d; });',
  '}',
  'function drawLineChart(containerId, chart) {',
  '  var width = 480, height = 240, margin = { top: 10, right: 20, bottom: 30, left: 50 };',
  '  var svg = d3.select(document.getElementById(containerId)).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title);',
  '  var x = d3.scalePoint().domain(chart.data.map(function (d) { return d.groupValue; })).range([margin.left, width - margin.right]);',
  '  var maxTotal = d3.max(chart.data, function (d) { return d.total; }) || 1;',
  '  var y = d3.scaleLinear().domain([0, maxTotal]).range([height - margin.bottom, margin.top]);',
  '  var line = d3.line().x(function (d) { return x(d.groupValue); }).y(function (d) { return y(d.total); });',
  '  svg.append("path").datum(chart.data).attr("class", "chart-bar").style("fill", "none").style("stroke", "var(--teal)").attr("stroke-width", 2).attr("d", line);',
  '  var points = svg.append("g").selectAll("circle").data(chart.data).join("circle")',
  '    .attr("class", "chart-bar").attr("cx", function (d) { return x(d.groupValue); }).attr("cy", function (d) { return y(d.total); }).attr("r", 3);',
  '  if (chart.linkKey || chart.linkTo || chart.detail) {',
  '    points.attr("data-group-value", function (d) { return String(d.groupValue); }).style("cursor", "pointer")',
  '      .on("click", function (event, d) { handleChartClick(chart, d.groupValue, undefined); });',
  '  }',
  '  svg.append("g").selectAll("text").data(chart.data).join("text")',
  '    .attr("class", "chart-label").attr("x", function (d) { return x(d.groupValue); }).attr("y", height - 8).attr("text-anchor", "middle").text(function (d) { return d.groupValue; });',
  '}',
  'function drawPieChart(containerId, chart) {',
  '  var width = 320, height = 320, radius = Math.min(width, height) / 2 - 20;',
  '  var svg = d3.select(document.getElementById(containerId)).append("svg")',
  '    .attr("viewBox", "0 0 " + width + " " + height).attr("width", "100%").attr("height", height)',
  '    .attr("role", "img").attr("aria-label", chart.title)',
  '    .append("g").attr("transform", "translate(" + width / 2 + "," + height / 2 + ")");',
  '  var color = d3.scaleOrdinal().range(["var(--teal)", "var(--coral)", "var(--ink-soft)", "var(--teal-soft)"]);',
  '  var pieGen = d3.pie().value(function (d) { return d.total; });',
  '  var arcGen = d3.arc().innerRadius(chart.donut ? radius * 0.55 : 0).outerRadius(radius);',
  '  var pieData = pieGen(chart.data);',
  '  var slices = svg.selectAll("path").data(pieData).join("path")',
  '    .attr("class", "chart-bar").style("fill", function (d) { return color(d.data.groupValue); }).attr("d", arcGen);',
  '  if (chart.linkKey || chart.linkTo || chart.detail) {',
  '    slices.attr("data-group-value", function (d) { return String(d.data.groupValue); }).style("cursor", "pointer")',
  '      .on("click", function (event, d) { handleChartClick(chart, d.data.groupValue, undefined); });',
  '  }',
  '  svg.selectAll("text").data(pieData).join("text")',
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
  '  applyHighlight();',
  '});'
].join('\n');

// Pan (mouse/touch drag) + zoom (wheel), vanilla JS/CSS transform, no
// library - see the design spec's §5. Self-contained: its own
// DOMContentLoaded listener, independent of TABLE_CLIENT_JS/
// CHART_CLIENT_JS's own listeners, only emitted when layout:'board' is
// used (see renderReportHtml's isBoardLayout branch).
var BOARD_CLIENT_JS = [
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var viewport = document.querySelector(".board-viewport");',
  '  var canvas = document.getElementById("board-canvas");',
  '  if (!viewport || !canvas) { return; }',
  '  var panX = 0, panY = 0, zoom = 1;',
  '  var dragging = false, lastX = 0, lastY = 0;',
  '  function applyTransform() {',
  '    canvas.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + zoom + ")";',
  '  }',
  '  function startDrag(x, y) { dragging = true; lastX = x; lastY = y; viewport.classList.add("board-panning"); }',
  '  function moveDrag(x, y) {',
  '    if (!dragging) { return; }',
  '    panX += x - lastX; panY += y - lastY; lastX = x; lastY = y;',
  '    applyTransform();',
  '  }',
  '  function endDrag() { dragging = false; viewport.classList.remove("board-panning"); }',
  '  viewport.addEventListener("mousedown", function (e) { startDrag(e.clientX, e.clientY); });',
  '  window.addEventListener("mousemove", function (e) { moveDrag(e.clientX, e.clientY); });',
  '  window.addEventListener("mouseup", endDrag);',
  '  viewport.addEventListener("touchstart", function (e) { var t = e.touches[0]; startDrag(t.clientX, t.clientY); });',
  '  viewport.addEventListener("touchmove", function (e) { var t = e.touches[0]; moveDrag(t.clientX, t.clientY); e.preventDefault(); }, { passive: false });',
  '  viewport.addEventListener("touchend", endDrag);',
  '  viewport.addEventListener("wheel", function (e) {',
  '    e.preventDefault();',
  '    var delta = e.deltaY > 0 ? -0.1 : 0.1;',
  '    zoom = Math.min(2, Math.max(0.25, zoom + delta));',
  '    applyTransform();',
  '  }, { passive: false });',
  '});'
].join('\n');

// Runs in <head>, before <body> - must resolve any stored explicit
// choice ahead of first paint, or a reload with a stored preference
// flashes the wrong theme for one frame. If nothing is stored, the
// @media(prefers-color-scheme) rules in REPORT_CSS already resolve the
// OS-default case with zero JS, so doing nothing here is correct.
var THEME_INIT_JS = [
  '(function () {',
  '  try {',
  '    var stored = localStorage.getItem("publish-theme");',
  '    if (stored === "light" || stored === "dark") { document.documentElement.dataset.theme = stored; }',
  '  } catch (e) {}',
  '})();'
].join('\n');

// Joins the normal end-of-body script bundle like every other *_CLIENT_JS
// constant. localStorage calls are wrapped in try/catch since a file://
// origin (this report's normal delivery method - see publish.md) can
// throw or behave inconsistently across browsers.
var THEME_TOGGLE_JS = [
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var toggle = document.getElementById("theme-toggle");',
  '  if (!toggle) { return; }',
  '  function currentTheme() {',
  '    var explicit = document.documentElement.dataset.theme;',
  '    if (explicit === "light" || explicit === "dark") { return explicit; }',
  '    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";',
  '  }',
  '  toggle.addEventListener("click", function () {',
  '    var next = currentTheme() === "dark" ? "light" : "dark";',
  '    document.documentElement.dataset.theme = next;',
  '    try { localStorage.setItem("publish-theme", next); } catch (e) {}',
  '  });',
  '});'
].join('\n');

// Discreet fixed corner control, unconditional on every report (see
// REPORT_CSS's .theme-toggle* rules). Inline SVG sun/moon icons - no
// icon font, no CDN; stroke="currentColor" follows .theme-toggle's own
// color so hover/theme changes recolor them for free. Which icon shows
// is driven purely by the same CSS selectors gating the color tokens, no
// JS bookkeeping needed to keep the icon in sync with the active theme.
var THEME_TOGGLE_HTML = '<button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">'
  + '<svg class="theme-toggle-icon theme-toggle-icon-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>'
  + '<svg class="theme-toggle-icon theme-toggle-icon-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"></path></svg>'
  + '</button>';

// Wraps the exact same per-block markup renderReportHtml's linear
// branch already produces (chartSectionsList[i]/tableSectionsList[i],
// unchanged) into positioned .board-node divs, plus an SVG layer
// drawing one <path> per computeBoardLayout edge. sectionById maps a
// block's id to its already-rendered markup - charts and tables are
// zipped by array index since chartSectionsList/tableSectionsList are
// built with .map() over config.charts/config.tables in the same order.
function renderBoardCanvas(config, chartSectionsList, tableSectionsList) {
  var charts = config.charts || [];
  var tables = config.tables || [];
  var layout = computeBoardLayout(charts, tables);
  var positionById = emptyMap();
  layout.positions.forEach(function (p) { positionById[p.id] = p; });
  var sectionById = emptyMap();
  charts.forEach(function (chart, index) { sectionById[chart.id] = chartSectionsList[index]; });
  tables.forEach(function (table, index) { sectionById[table.id] = tableSectionsList[index]; });

  var nodesHtml = layout.positions.map(function (p) {
    return '<div class="board-node" style="left:' + p.x + 'px;top:' + p.y + 'px;width:' + BOARD_BOX_WIDTH + 'px;height:' + BOARD_BOX_HEIGHT + 'px">' + sectionById[p.id] + '</div>';
  }).join('');

  var maxX = layout.positions.reduce(function (m, p) { return Math.max(m, p.x + BOARD_BOX_WIDTH); }, 0);
  var maxY = layout.positions.reduce(function (m, p) { return Math.max(m, p.y + BOARD_BOX_HEIGHT); }, 0);

  var edgesHtml = layout.edges.map(function (edge) {
    var from = positionById[edge.from];
    var to = positionById[edge.to];
    var x1 = from.x + BOARD_BOX_WIDTH / 2;
    var y1 = from.y + BOARD_BOX_HEIGHT;
    var x2 = to.x + BOARD_BOX_WIDTH / 2;
    var y2 = to.y;
    return '<path class="board-edge" d="M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2 + '"></path>';
  }).join('');

  return '<div class="board-viewport"><div class="board-canvas" id="board-canvas">'
    + '<svg class="board-edges" width="' + maxX + '" height="' + maxY + '">' + edgesHtml + '</svg>'
    + nodesHtml
    + '</div></div>';
}

function renderReportHtml(payload, config) {
  var isBoardLayout = !!(config.layout && config.layout.type === 'board');
  var filtersSection = (payload.filters && payload.filters.length) ? renderFiltersSection(payload.filters) : '';
  var kpiCards = payload.kpis.map(function (kpi) {
    return '<div class="kpi"><div class="kpi-label">' + escapeHtml(kpi.label) + '</div>'
      + '<div class="kpi-value">' + escapeHtml(kpi.formatted) + '</div></div>';
  }).join('');
  var chartSectionsList = payload.charts.map(function (chart) {
    return '<section class="chart" data-chart-id="' + escapeHtml(chart.id) + '"><h2>' + escapeHtml(chart.title) + '</h2>'
      + '<div class="chart-canvas" id="chart-' + escapeHtml(chart.id) + '"></div></section>';
  });
  var tableSectionsList = payload.tables.map(renderTableSection);
  var hasDetail = payload.tables.some(function (t) { return t.detail; }) || payload.charts.some(function (c) { return c.detail; });
  var hasFilters = !!(payload.filters && payload.filters.length);
  var script = 'window.__PUBLISH_PAYLOAD__ = ' + JSON.stringify(payload).replace(/</g, '\\u003c') + ';';
  script += THEME_TOGGLE_JS;
  if (payload.tables.length) {
    script += TABLE_CLIENT_JS;
    if (hasDetail) {
      script += TABLE_DETAIL_TOGGLE_HANDLER_JS;
    }
    script += '\n  });\n});';
  }
  if (payload.charts.length) {
    script += CHART_CLIENT_JS;
  }
  if (isBoardLayout) {
    script += BOARD_CLIENT_JS;
  }
  if (hasFilters) {
    script += FILTER_REUSED_FUNCTIONS_JS + FILTER_CLIENT_JS;
  } else if (hasDetail) {
    script += DETAIL_REUSED_FUNCTIONS_JS;
  }
  if (hasDetail) {
    script += DETAIL_CLIENT_JS;
  }
  var d3Script = payload.charts.length ? '<script src="' + D3_CDN_URL + '" integrity="' + D3_CDN_INTEGRITY + '" crossorigin="anonymous"></script>' : '';
  var themeInitScript = '<script>' + THEME_INIT_JS + '</script>';
  var css = REPORT_CSS + (hasDetail ? TABLE_DETAIL_CSS : '') + (isBoardLayout ? BOARD_CSS : '');
  var blocks = isBoardLayout
    ? renderBoardCanvas(config, chartSectionsList, tableSectionsList)
    : chartSectionsList.join('') + tableSectionsList.join('');
  var body = filtersSection + '<div class="kpis">' + kpiCards + '</div>' + blocks;
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>' + escapeHtml(config.target.fileName) + '</title>'
    + '<style>' + css + '</style>' + themeInitScript + d3Script + '</head><body>'
    + THEME_TOGGLE_HTML
    + '<main>' + body + '</main>'
    + '<script>' + script + '</script>'
    + '</body></html>';
}
