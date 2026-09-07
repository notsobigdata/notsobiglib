# `publish`'s board layout (`layout: 'board'`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `layout: { type: 'board' }` to `publish` — the same chart/table
blocks `layout: 'linear'` already renders, positioned as a pannable/
zoomable tree (an infinite-canvas org chart) via a new opt-in `relatesTo`
field on `charts[]`/`tables[]` entries, instead of one stacked column.

**Architecture:** A pure layout function (`computeBoardLayout`) turns each
block's `relatesTo` into pixel positions and parent→child edges via a
simple tidy-tree walk. `renderReportHtml` gets one new conditional branch
that reuses the exact same per-chart/per-table markup `linear` already
produces, just wraps each piece in an absolutely-positioned `.board-node`
inside a pan/zoomable `.board-canvas`, with an SVG layer drawing the
edges. All new client-side interaction (pan, zoom) is vanilla JS/CSS
transforms, no library. `linear` mode's code path is untouched.

**Tech Stack:** Plain JS (GAS-compatible, ES5-style, `var`/function
declarations), Node `vm`-based Layer 1 tests (`test/publish.test.js`),
human-run Apps Script Layer 2 (`notsobigtests`).

**Spec:** `docs/superpowers/specs/2026-09-07-publish-board-layout-design.md`

## Global Constraints

- ES5-style JS throughout `src/publish.js` (`var`, `function`, no arrow
  functions/`let`/`const`/template literals) — the whole file, including
  every `*_CLIENT_JS`/`*_CSS` string array, follows this already.
- No new dependency, no CDN beyond the existing pinned D3 URL — pan/zoom
  is CSS `transform` + native pointer/wheel events only.
- `layout: 'linear'` (the default, and every existing report) must render
  byte-for-byte the same after this change — verified by the full existing
  `test/publish.test.js` suite staying green, not a new snapshot test.
- Every new validation error follows the existing `'publish(): ...'`
  message convention (see `validatePublishConfig`'s existing throws).
- `./build.sh` must run (regenerating `src.js`) before `node test/run.js`
  after every `src/publish.js` change — the test harness loads the
  committed `src.js`, not `src/` directly.

---

### Task 1: accept `layout: 'board'` + validate `relatesTo`

**Files:**
- Modify: `src/publish.js:13-18` (add `LAYOUT_TYPES` near the existing
  `PUBLISH_VALUE_FORMATS`/`CHART_TYPES` constants)
- Modify: `src/publish.js:105-243` (`validatePublishConfig` — swap the
  layout check, add the `validateBoardRelations` call at the end)
- Modify: `test/fixtures/publish-nodes.js:177-185` (`badLayoutPublish`
  currently uses `layout: { type: 'board' }` to prove board is rejected —
  board is valid after this task, so it must use a genuinely invalid
  type instead)
- Modify: `test/fixtures/publish-nodes.js` (add 6 new fixtures, appended
  after `badLayoutPublish`)
- Modify: `test/publish.test.js:87-91`
  (`testPublishLayoutTypeOtherThanLinearRejected` — update the expected
  message)
- Modify: `test/publish.test.js` (add 6 new test functions + register
  them in the `module.exports` object at the bottom)

**Interfaces:**
- Produces: `LAYOUT_TYPES` (`['linear', 'board']`, top-level array
  constant) and `validateBoardRelations(config)` (throws on any
  `relatesTo` problem, returns nothing on success) — both consumed by
  `validatePublishConfig`, and `validateBoardRelations` is reused
  unchanged by Task 2 (`computeBoardLayout` trusts its checks already
  ran).

- [ ] **Step 1: Add `LAYOUT_TYPES` and swap the layout check**

In `src/publish.js`, right after the existing `CHART_TYPES` declaration
(line 18):

```javascript
// layout.type accepted values - see the design spec's §2. 'linear'
// (default) stacks every block in one column; 'board' positions charts/
// tables as a relatesTo-driven tree on a pan/zoomable canvas.
var LAYOUT_TYPES = ['linear', 'board'];
```

Then replace the existing layout check inside `validatePublishConfig`
(currently `src/publish.js:115-117`):

```javascript
  if (config.layout && config.layout.type !== 'linear') {
    throw new Error('publish(): layout.type "' + config.layout.type + '" - only "linear" is supported.');
  }
```

with:

```javascript
  var layoutType = (config.layout && config.layout.type) || 'linear';
  if (LAYOUT_TYPES.indexOf(layoutType) === -1) {
    throw new Error('publish(): layout.type "' + layoutType + '" - expected one of ' + LAYOUT_TYPES.join(', ') + '.');
  }
```

- [ ] **Step 2: Add `validateBoardRelations` and call it**

Add this new function right after `validateDetail` (before
`validatePublishConfig`, `src/publish.js:98`, matching the file's
existing pattern of small validators declared above the function that
calls them):

```javascript
// relatesTo (charts[]/tables[] only) declares one block's parent in a
// layout:'board' tree - undefined/absent means "root". Runs once, after
// every per-block loop in validatePublishConfig has already confirmed
// ids are present and duplicate-free *within* charts[] and *within*
// tables[] separately; this function additionally requires ids to be
// unique *across* charts[] and tables[] combined, since relatesTo shares
// one namespace over both arrays - no other publish() feature needs that
// today (linkTo/detail/reactsTo never cross-reference a chart id against
// a table id), so this is a new rule, not a relaxation of an old one.
function validateBoardRelations(config) {
  var charts = config.charts || [];
  var tables = config.tables || [];
  var relatesToUsed = charts.concat(tables).some(function (block) { return block.relatesTo; });
  if (!relatesToUsed) {
    return;
  }
  var layoutType = (config.layout && config.layout.type) || 'linear';
  if (layoutType !== 'board') {
    throw new Error('publish(): "relatesTo" is set on a chart or table, which requires layout.type "board".');
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
```

Then, at the very end of `validatePublishConfig` (after the closing
`});` of the `(config.tables || []).forEach(...)` loop, currently
`src/publish.js:242`, still inside the function body before its own
closing `}`):

```javascript
  validateBoardRelations(config);
```

- [ ] **Step 3: Update the now-wrong fixture and its test**

In `test/fixtures/publish-nodes.js`, `badLayoutPublish` currently sets
`layout: { type: 'board' }` to prove an unsupported layout is rejected —
that's no longer true after Step 1. Change its `layout` line to:

```javascript
  layout: { type: 'grid' },
```

In `test/publish.test.js`, update
`testPublishLayoutTypeOtherThanLinearRejected` (currently asserting
`/only "linear" is supported/`):

```javascript
function testPublishLayoutTypeOtherThanLinearRejected() {
  var result = runOne('badLayoutPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/expected one of linear, board/.test(result.error), 'expected a layout-type error, got: ' + result.error);
}
```

- [ ] **Step 4: Add new fixtures**

In `test/fixtures/publish-nodes.js`, append after `badLayoutPublish`:

```javascript
var boardRelatesToWithoutBoardLayoutPublish = {
  kind: 'publish',
  name: 'boardRelatesToWithoutBoardLayoutPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'board-no-layout.html' },
  charts: [
    { id: 'a', type: 'bar', title: 'A', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'b', type: 'bar', title: 'B', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, relatesTo: 'a' }
  ]
};

var boardRelatesToUnknownIdPublish = {
  kind: 'publish',
  name: 'boardRelatesToUnknownIdPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'board-unknown-id.html' },
  layout: { type: 'board' },
  charts: [
    { id: 'a', type: 'bar', title: 'A', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, relatesTo: 'does_not_exist' }
  ]
};

var boardRelatesToSelfPublish = {
  kind: 'publish',
  name: 'boardRelatesToSelfPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'board-self.html' },
  layout: { type: 'board' },
  charts: [
    { id: 'a', type: 'bar', title: 'A', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, relatesTo: 'a' }
  ]
};

var boardRelatesToCyclePublish = {
  kind: 'publish',
  name: 'boardRelatesToCyclePublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'board-cycle.html' },
  layout: { type: 'board' },
  charts: [
    { id: 'a', type: 'bar', title: 'A', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, relatesTo: 'b' },
    { id: 'b', type: 'bar', title: 'B', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, relatesTo: 'a' }
  ]
};

var boardDuplicateCrossTypeIdPublish = {
  kind: 'publish',
  name: 'boardDuplicateCrossTypeIdPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'board-dup-cross-type.html' },
  layout: { type: 'board' },
  charts: [
    { id: 'shared', type: 'bar', title: 'Chart', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }
  ],
  tables: [
    { id: 'shared', title: 'Table', mode: 'raw', columns: [{ field: 'category' }], relatesTo: 'shared' }
  ]
};

// A root chart with two children (one a chart, one a table) - proceeds
// past validation; used by Task 2/3's rendering tests too (reused rather
// than duplicated, same "one fixture per concern" precedent tablesPublish's
// own comment already sets).
var boardValidPublish = {
  kind: 'publish',
  name: 'boardValidPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'board-valid.html' },
  layout: { type: 'board' },
  charts: [
    { id: 'r', type: 'bar', title: 'Root', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'c1', type: 'bar', title: 'Child 1', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, relatesTo: 'r' }
  ],
  tables: [
    { id: 'c2', title: 'Child 2', mode: 'raw', columns: [{ field: 'category' }], relatesTo: 'r' }
  ]
};
```

- [ ] **Step 5: Add new test functions**

In `test/publish.test.js`, append after
`testPublishLayoutTypeOtherThanLinearRejected` (which Step 3 already
updated):

```javascript
function testPublishBoardRelatesToWithoutBoardLayoutRejected() {
  var result = runOne('boardRelatesToWithoutBoardLayoutPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/requires layout\.type "board"/.test(result.error), 'expected a relatesTo-requires-board error, got: ' + result.error);
}

function testPublishBoardRelatesToUnknownIdRejected() {
  var result = runOne('boardRelatesToUnknownIdPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/doesn't match any declared chart\/table id/.test(result.error), 'expected an unknown-relatesTo-id error, got: ' + result.error);
}

function testPublishBoardRelatesToSelfRejected() {
  var result = runOne('boardRelatesToSelfPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/pointing at itself/.test(result.error), 'expected a self-relatesTo error, got: ' + result.error);
}

function testPublishBoardRelatesToCycleRejected() {
  var result = runOne('boardRelatesToCyclePublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/forms a cycle/.test(result.error), 'expected a relatesTo-cycle error, got: ' + result.error);
}

function testPublishBoardDuplicateCrossTypeIdRejected() {
  var result = runOne('boardDuplicateCrossTypeIdPublish');
  assert.strictEqual(result.status, 'failed');
  assert.ok(/used as both a chart id and a table id/.test(result.error), 'expected a cross-type duplicate-id error, got: ' + result.error);
}

function testPublishBoardValidRelationsProceedPastValidation() {
  var result = runOne('boardValidPublish');
  // Same proof pattern as testPublishValidRefProceedsPastValidation: no
  // BigQuery shim in this test, so a config that gets all the way past
  // validation fails next at the un-shimmed BigQuery call, not at
  // validation.
  assert.strictEqual(result.status, 'failed');
  assert.ok(/BigQuery/.test(result.error), 'expected validation to pass and fail only at the BigQuery call, got: ' + result.error);
}
```

Add all six to the `module.exports` object at the bottom of the file
(same `name: name` shape every other entry uses).

- [ ] **Step 6: Rebuild and run the tests**

```bash
./build.sh
node test/run.js
```

Expected: every existing test still passes, plus the 7 new/updated ones
(6 new + `testPublishLayoutTypeOtherThanLinearRejected` updated) pass.

- [ ] **Step 7: Commit**

```bash
git add src/publish.js test/publish.test.js test/fixtures/publish-nodes.js
git commit -m "feat: accept layout:'board' and validate relatesTo"
```

---

### Task 2: `computeBoardLayout` + board markup/CSS

**Files:**
- Modify: `src/publish.js:679-682` area (new `BOARD_BOX_WIDTH`/
  `BOARD_BOX_HEIGHT`/`BOARD_H_GAP`/`BOARD_V_GAP` constants, right before
  `REPORT_CSS`)
- Modify: `src/publish.js:717-718` (append `BOARD_CSS` right after
  `REPORT_CSS`'s closing `].join('\n');`, alongside the existing
  `TABLE_DETAIL_CSS`)
- Modify: `src/publish.js:1294-1334` (`renderReportHtml` — branch on
  board layout; new `renderBoardCanvas` + `computeBoardLayout` functions
  added just above it)
- Modify: `test/fixtures/publish-nodes.js` (2 more fixtures: a 3-level
  chain and a 2-root forest — position math needs a fixture per shape)
- Modify: `test/publish.test.js` (3 new rendering tests + registration)

**Interfaces:**
- Consumes: `emptyMap`/`has` (`move.js`, already in scope), `escapeHtml`
  (`src/publish.js`, existing).
- Produces: `computeBoardLayout(charts, tables)` → `{ positions: [{id,
  x, y}], edges: [{from, to}] }`, and `renderBoardCanvas(config,
  chartSectionsList, tableSectionsList)` → HTML string — both consumed
  only by `renderReportHtml` in this task, not exposed further.

- [ ] **Step 1: Write the failing tests first**

In `test/fixtures/publish-nodes.js`, append after `boardValidPublish`:

```javascript
// Straight 3-level chain: g -> p -> c. Every box is BOARD_BOX_WIDTH=260 +
// BOARD_H_GAP=40 = 300px wide-with-gap, BOARD_BOX_HEIGHT=140 +
// BOARD_V_GAP=60 = 200px tall-with-gap - a single-child chain has no
// siblings to center over, so every node lands at x=0, y=depth*200.
var boardChainPublish = {
  kind: 'publish',
  name: 'boardChainPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'board-chain.html' },
  layout: { type: 'board' },
  charts: [
    { id: 'g', type: 'bar', title: 'G', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'p', type: 'bar', title: 'P', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' }, relatesTo: 'g' }
  ],
  tables: [
    { id: 'c', title: 'C', mode: 'raw', columns: [{ field: 'category' }], relatesTo: 'p' }
  ]
};

// Two independent roots, each a single leaf with no relatesTo - proves
// multiple trees land side by side (x=0 and x=300) rather than
// overlapping at x=0.
var boardMultiRootPublish = {
  kind: 'publish',
  name: 'boardMultiRootPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'board-multi-root.html' },
  layout: { type: 'board' },
  charts: [
    { id: 'a', type: 'bar', title: 'A', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'b', type: 'bar', title: 'B', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }
  ]
};
```

In `test/publish.test.js`, append after
`testPublishBoardValidRelationsProceedPastValidation`:

```javascript
// boardValidPublish: root "r" with two children "c1" (chart) and "c2"
// (table). Hand-computed with BOARD_BOX_WIDTH=260, BOARD_BOX_HEIGHT=140,
// BOARD_H_GAP=40, BOARD_V_GAP=60: leaves land at x=0 and x=300 (0 and 1
// slots * 300px-with-gap), y=200 (depth 1 * 200px-with-gap); the root
// centers over its children at x=(0+300)/2=150, y=0.
function testPublishBoardLayoutPositionsSingleRootTwoChildren() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(html.indexOf('left:150px;top:0px') !== -1, 'expected the root positioned at (150,0), got: ' + html);
  assert.ok(html.indexOf('left:0px;top:200px') !== -1, 'expected the first child positioned at (0,200), got: ' + html);
  assert.ok(html.indexOf('left:300px;top:200px') !== -1, 'expected the second child positioned at (300,200), got: ' + html);
  var edgeCount = (html.match(/class="board-edge"/g) || []).length;
  assert.strictEqual(edgeCount, 2, 'expected 2 edges (r->c1, r->c2), got ' + edgeCount + ' in: ' + html);
}

function testPublishBoardLayoutPositionsThreeLevelChainInAStraightLine() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select boardChainPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(html.indexOf('left:0px;top:0px') !== -1, 'expected "g" at (0,0), got: ' + html);
  assert.ok(html.indexOf('left:0px;top:200px') !== -1, 'expected "p" at (0,200), got: ' + html);
  assert.ok(html.indexOf('left:0px;top:400px') !== -1, 'expected "c" at (0,400), got: ' + html);
  var edgeCount = (html.match(/class="board-edge"/g) || []).length;
  assert.strictEqual(edgeCount, 2, 'expected 2 edges (g->p, p->c), got ' + edgeCount + ' in: ' + html);
}

function testPublishBoardLayoutPlacesMultipleRootsSideBySide() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select boardMultiRootPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(html.indexOf('left:0px;top:0px') !== -1, 'expected root "a" at (0,0), got: ' + html);
  assert.ok(html.indexOf('left:300px;top:0px') !== -1, 'expected root "b" at (300,0), got: ' + html);
  var edgeCount = (html.match(/class="board-edge"/g) || []).length;
  assert.strictEqual(edgeCount, 0, 'expected 0 edges (two unrelated roots), got ' + edgeCount + ' in: ' + html);
}
```

Add the three new function names to `module.exports`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node test/run.js
```

Expected: FAIL — `boardValidPublish` etc. currently fail at
`renderReportHtml` because it still renders `linear`-style markup with
no `left:`/`top:` positioning and no `.board-edge` elements (the layout
is accepted per Task 1, but nothing renders it yet).

- [ ] **Step 3: Add the board layout constants and `computeBoardLayout`**

In `src/publish.js`, right before `REPORT_CSS` (currently line 683):

```javascript
// Fixed box/gap sizing for layout:'board' - no per-report customization
// in v1, same posture the REPORT_CSS design tokens already have.
var BOARD_BOX_WIDTH = 260;
var BOARD_BOX_HEIGHT = 140;
var BOARD_H_GAP = 40;
var BOARD_V_GAP = 60;

// Simple tidy-tree layout for layout:'board' - see the design spec's §4
// "Known ceiling" for why this isn't a full Reingold-Tilford walk: each
// parent centers over its children's span, but there's no contour-based
// collision avoidance for a lopsided tree. blocks with no relatesTo are
// roots; a shared `nextSlot` leaf counter across every root's DFS walk
// is what makes multiple roots land side by side automatically, with no
// separate "offset past the previous tree's width" step needed.
// Trusts validateBoardRelations already ran (acyclic, every id/relatesTo
// resolves) - does no error-checking of its own.
function computeBoardLayout(charts, tables) {
  var blocks = (charts || []).concat(tables || []);
  var children = emptyMap();
  var roots = [];
  blocks.forEach(function (block) {
    if (block.relatesTo) {
      children[block.relatesTo] = children[block.relatesTo] || [];
      children[block.relatesTo].push(block.id);
    } else {
      roots.push(block.id);
    }
  });

  var positions = [];
  var edges = [];
  var positionById = emptyMap();
  var nextSlot = 0;

  function place(id, depth) {
    var kids = children[id] || [];
    var y = depth * (BOARD_BOX_HEIGHT + BOARD_V_GAP);
    var x;
    if (!kids.length) {
      x = nextSlot * (BOARD_BOX_WIDTH + BOARD_H_GAP);
      nextSlot += 1;
    } else {
      kids.forEach(function (childId) {
        edges.push({ from: id, to: childId });
        place(childId, depth + 1);
      });
      var childXs = kids.map(function (childId) { return positionById[childId]; });
      x = (Math.min.apply(null, childXs) + Math.max.apply(null, childXs)) / 2;
    }
    positionById[id] = x;
    positions.push({ id: id, x: x, y: y });
  }

  roots.forEach(function (rootId) { place(rootId, 0); });

  return { positions: positions, edges: edges };
}
```

- [ ] **Step 4: Add `BOARD_CSS`**

Right after `REPORT_CSS`'s closing `].join('\n');` (currently line 718),
alongside the existing `TABLE_DETAIL_CSS` (line 722):

```javascript
// CSS for layout:'board', only emitted when config.layout.type is
// 'board' (see renderReportHtml's isBoardLayout branch below).
var BOARD_CSS = [
  '.board-viewport { position: relative; width: 100%; height: 80vh; overflow: hidden; border: 1px solid var(--paper-line); }',
  '.board-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; cursor: grab; }',
  '.board-canvas.board-panning { cursor: grabbing; }',
  '.board-node { position: absolute; background: var(--paper); border: 1px solid var(--paper-line); padding: 12px; box-sizing: border-box; overflow: auto; }',
  '.board-node .chart, .board-node .table-block { border-top: none; margin-top: 0; padding-top: 0; }',
  '.board-edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }',
  '.board-edge { fill: none; stroke: var(--paper-line); stroke-width: 2; }'
].join('\n');
```

- [ ] **Step 5: Add `renderBoardCanvas` and wire it into `renderReportHtml`**

Add `renderBoardCanvas` right before `renderReportHtml` (currently line
1294):

```javascript
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
```

Now modify `renderReportHtml` itself (currently `src/publish.js:1294-1334`).
Replace:

```javascript
function renderReportHtml(payload, config) {
  var filtersSection = (payload.filters && payload.filters.length) ? renderFiltersSection(payload.filters) : '';
  var kpiCards = payload.kpis.map(function (kpi) {
    return '<div class="kpi"><div class="kpi-label">' + escapeHtml(kpi.label) + '</div>'
      + '<div class="kpi-value">' + escapeHtml(kpi.formatted) + '</div></div>';
  }).join('');
  var chartSections = payload.charts.map(function (chart) {
    return '<section class="chart" data-chart-id="' + escapeHtml(chart.id) + '"><h2>' + escapeHtml(chart.title) + '</h2>'
      + '<div class="chart-canvas" id="chart-' + escapeHtml(chart.id) + '"></div></section>';
  }).join('');
  var tableSections = payload.tables.map(renderTableSection).join('');
```

with:

```javascript
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
  var chartSections = chartSectionsList.join('');
  var tableSections = tableSectionsList.join('');
```

Then, further down in the same function, replace the CSS line
(`var css = REPORT_CSS + (hasDetail ? TABLE_DETAIL_CSS : '');`) with:

```javascript
  var css = REPORT_CSS + (hasDetail ? TABLE_DETAIL_CSS : '') + (isBoardLayout ? BOARD_CSS : '');
```

And replace the final `return` statement:

```javascript
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>' + escapeHtml(config.target.fileName) + '</title>'
    + '<style>' + css + '</style>' + d3Script + '</head><body>'
    + '<main>' + filtersSection + '<div class="kpis">' + kpiCards + '</div>' + chartSections + tableSections + '</main>'
    + '<script>' + script + '</script>'
    + '</body></html>';
}
```

with:

```javascript
  var body = isBoardLayout
    ? filtersSection + '<div class="kpis">' + kpiCards + '</div>' + renderBoardCanvas(config, chartSectionsList, tableSectionsList)
    : filtersSection + '<div class="kpis">' + kpiCards + '</div>' + chartSections + tableSections;
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>' + escapeHtml(config.target.fileName) + '</title>'
    + '<style>' + css + '</style>' + d3Script + '</head><body>'
    + '<main>' + body + '</main>'
    + '<script>' + script + '</script>'
    + '</body></html>';
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: every test passes, including the 3 new ones and the full
pre-existing suite (regression guard for `linear` mode).

- [ ] **Step 7: Commit**

```bash
git add src/publish.js test/publish.test.js test/fixtures/publish-nodes.js
git commit -m "feat: render layout:'board' as a positioned tree with edge lines"
```

---

### Task 3: pan/zoom client JS

**Files:**
- Modify: `src/publish.js` (new `BOARD_CLIENT_JS` constant, placed after
  `CHART_CLIENT_JS`; wired into `renderReportHtml`'s script assembly)
- Modify: `test/publish.test.js` (2 new tests + registration)

**Interfaces:** none new — `BOARD_CLIENT_JS` is self-contained, consumed
only by `renderReportHtml`'s existing script-assembly `if` chain.

- [ ] **Step 1: Write the failing tests first**

In `test/publish.test.js`, append after
`testPublishBoardLayoutPlacesMultipleRootsSideBySide`:

```javascript
function testPublishBoardClientJsEmittedOnlyForBoardLayout() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);

  var boardResult = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(boardResult.status, 'success', 'expected the shimmed board run to succeed, got: ' + boardResult.error);
  var boardHtml = getHtml();
  assert.ok(/viewport\.addEventListener\("wheel"/.test(boardHtml), 'expected the board wheel-zoom listener, got: ' + boardHtml);
  assert.ok(/viewport\.addEventListener\("mousedown"/.test(boardHtml), 'expected the board pan listener, got: ' + boardHtml);

  var linearResult = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(linearResult.status, 'success', 'expected the shimmed linear run to succeed, got: ' + linearResult.error);
  var linearHtml = getHtml();
  assert.ok(!/board-viewport/.test(linearHtml), 'expected no board markup on a layout:"linear" report, got: ' + linearHtml);
  assert.ok(!/viewport\.addEventListener\("wheel"/.test(linearHtml), 'expected no board client JS on a layout:"linear" report, got: ' + linearHtml);
}

function testPublishBoardClientJsClampsZoomAndAppliesTransform() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/Math\.min\(2, Math\.max\(0\.25, zoom \+ delta\)\)/.test(html), 'expected zoom clamped to [0.25, 2], got: ' + html);
  assert.ok(/canvas\.style\.transform = "translate\("/.test(html), 'expected the pan\/zoom transform application, got: ' + html);
}
```

Add both names to `module.exports`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node test/run.js
```

Expected: FAIL — `boardValidPublish`'s output has no
`viewport.addEventListener` calls yet.

- [ ] **Step 3: Add `BOARD_CLIENT_JS`**

In `src/publish.js`, right after the `CHART_CLIENT_JS` array's own
closing `].join('\n');` line (that constant starts at line 1099 today;
Task 2's earlier edits shift it down slightly, but its content and
relative position — right before `renderReportHtml`'s render helpers —
don't change):

```javascript
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
  '  function startDrag(x, y) { dragging = true; lastX = x; lastY = y; canvas.classList.add("board-panning"); }',
  '  function moveDrag(x, y) {',
  '    if (!dragging) { return; }',
  '    panX += x - lastX; panY += y - lastY; lastX = x; lastY = y;',
  '    applyTransform();',
  '  }',
  '  function endDrag() { dragging = false; canvas.classList.remove("board-panning"); }',
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
```

- [ ] **Step 4: Wire it into the script assembly**

In `renderReportHtml`, find the existing block:

```javascript
  if (payload.charts.length) {
    script += CHART_CLIENT_JS;
  }
```

Add right after it:

```javascript
  if (isBoardLayout) {
    script += BOARD_CLIENT_JS;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
./build.sh
node test/run.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/publish.js test/publish.test.js
git commit -m "feat: add pan/zoom client JS for layout:'board'"
```

---

### Task 4: docs

**Files:**
- Modify: `docs/publish.md` (new `### Board layout` subsection; remove
  the now-stale `## What's not here yet` section)
- Modify: `src/publish.md` (dev notes)

**Interfaces:** none — docs only.

- [ ] **Step 1: `docs/publish.md`**

Add a new subsection right after the existing `### \`tables[]\`` section
(ends around what is currently line 282, right before `### Detail
drill-down`) — board layout is a report-level rendering choice like
`tables[]`, not a per-block feature, so it belongs at that level rather
than nested under detail drill-down or filters:

```markdown
### Board layout (`layout: 'board'`)

```javascript
layout: { type: 'board' },
charts: [
  { id: 'overview', type: 'bar', title: 'Orders by region',
    groupBy: 'region', metric: { agg: 'count_distinct', field: 'order_id' } },
  { id: 'by_channel', type: 'bar', title: 'Orders by channel',
    groupBy: 'channel', metric: { agg: 'count_distinct', field: 'order_id' },
    relatesTo: 'overview' }
],
tables: [
  { id: 'flagged_orders', title: 'Flagged orders', mode: 'raw',
    columns: [{ field: 'order_id', label: 'Order' }],
    relatesTo: 'by_channel' }
]
```

- `layout: { type: 'board' }` (in place of the default `'linear'`)
  renders `charts[]`/`tables[]` as a tree on a pan/zoomable infinite
  canvas instead of one stacked column. `kpis[]` are unaffected — they
  keep rendering as a fixed summary strip above the canvas, since KPIs
  have no `id` and can't participate in a tree.
- `relatesTo` (new on `charts[]`/`tables[]` entries) names another
  chart/table `id` in the same report — that block becomes this one's
  parent in the tree. No `relatesTo` means "root". `relatesTo` ids share
  one namespace across `charts[]` and `tables[]` combined, so a chart and
  a table cannot share an `id` in a board-layout report even though
  that's otherwise allowed.
- `relatesTo` is a config error unless `layout.type` is `'board'`
  (dead-config guard), if it names an id that doesn't exist, if it
  points at itself, or if it forms a cycle with other blocks'
  `relatesTo`.
- Multiple root blocks (no `relatesTo`) are all valid — each becomes its
  own tree, laid out side by side on the same canvas.
- Each block still renders exactly like it would in `linear` mode (same
  chart/table markup, same `reactsTo`/`detail`/`linkKey`/`linkTo`
  behavior) — `relatesTo` only changes where it sits on the page, never
  what it computes or how it reacts.
- Pan (click-drag or touch-drag) and zoom (mouse wheel, clamped
  roughly 0.25×–2×) are built in, vanilla JS/CSS — no extra config, no
  external library.
- **Known ceiling:** the layout centers each parent over its children
  but doesn't do full collision-avoiding tree layout, so a very lopsided
  tree (a long chain next to a wide shallow one) can look uneven rather
  than tightly packed. Fine for the box counts a dashboard realistically
  has.
```

Then delete the entire `## What's not here yet` section at the end of
the file (this was its last item).

- [ ] **Step 2: `src/publish.md`**

Append to the end of the file:

```markdown

## Board layout (`layout: 'board'`)

`computeBoardLayout(charts, tables)` is a simple tidy-tree walk, not a
full Reingold-Tilford implementation: each parent centers over its
children's already-computed x positions, and a shared `nextSlot` counter
(incremented once per leaf, across every root's DFS walk) is what makes
multiple independent roots land side by side automatically - no separate
"offset this root past the previous tree's total width" step was needed,
which is simpler than the design spec originally sketched (per-root
subtree-width bookkeeping) once the shared-counter trick was in hand.

`relatesTo` deliberately shares one id namespace across `charts[]` and
`tables[]` (`validateBoardRelations`'s `registerBlock` check) - every
other publish() feature keeps chart ids and table ids in separate
namespaces (duplicate-id checks run independently in
`validatePublishConfig`'s two per-block loops), but a `relatesTo` value
has no way to say which array it's pointing into, so this feature alone
needed the combined-namespace rule. It's a new restriction, scoped to
reports that actually use `relatesTo` - a `linear`-layout report (or a
`board`-layout report with no `relatesTo` at all) can still reuse the
same id for a chart and a table exactly as before.

`renderBoardCanvas` reuses `chartSectionsList`/`tableSectionsList` -
`renderReportHtml`'s per-block markup, computed once, unconditionally,
regardless of layout - rather than re-deriving chart/table HTML a second
time for board mode. Both layout modes read from the same two arrays;
only how they're assembled into the page differs.
```

- [ ] **Step 3: Commit**

```bash
git add docs/publish.md src/publish.md
git commit -m "docs: document publish's board layout"
```

---

### Task 5: full regression, security review, PR

**Files:** none new — verification only.

- [ ] **Step 1: Full rebuild and test run**

```bash
./build.sh --check && node test/run.js
```

Expected: `build.sh --check` reports `src.js` matches `src/`; every test
passes.

- [ ] **Step 2: Security review**

Run `security-review` against `git diff release/16...feat/publish-board-layout`
(per this repo's CLAUDE.md step 3). Pay particular attention to: the new
`.board-node` markup still only ever embeds already-`escapeHtml`'d chart/
table section strings (no new raw-data interpolation path was added —
`renderBoardCanvas` only rearranges existing section strings, it
generates none of its own from row data), and that `BOARD_CLIENT_JS`
introduces no new read of `window.__PUBLISH_PAYLOAD__` (pan/zoom state
is purely local `panX`/`panY`/`zoom` variables, never serialized or
reflected back into the DOM as markup).

- [ ] **Step 3: Push and open the PR — ask first**

Ask the user for permission before pushing `feat/publish-board-layout`
and opening a PR against `release/16` (`gh pr create --base release/16`).
The PR description needs both a standard summary/test plan and the
didactic walkthrough this repo's PRs always include (see CLAUDE.md step
4) — this is a good one to lean on the "Figma/whiteboard-style canvas"
analogy for, since that's a shape a data/analytics-background reader
already has intuition for.

---

### Task 6: companion Layer 2 fixture (`notsobigtests`)

**Files (in the sibling `notsobigtests` repo, own branch/PR):**
- Modify: `js/08-fixtures-publish-targets.js` (new publish node reusing
  `loadPublishOrders`)
- Modify: `js/28-tests-publish.js` (new test function)
- Modify: `js/90-test-registry.js` (register the new test in the
  `publish` category)

**Interfaces:** none — this is Layer 2, human-run, no automated
interface contract with `notsobiglib`.

- [ ] **Step 1: Create a feature branch in `notsobigtests`**

```bash
cd ~/projetos/notsobig_org/notsobigtests
git checkout -b test/publish-board-layout-fixture
```

- [ ] **Step 2: Add the fixture**

In `js/08-fixtures-publish-targets.js`, add after `detailDrilldownPublish`
(reuses `loadPublishOrders`'s existing 6-row sample: Beverages
10+20+30=60 across order_id 1/2/6, Snacks 5+15+25=45 across order_id
3/4/5 — see that fixture's own comment):

```javascript
// Board layout (notsobiglib feat/publish-board-layout): "overview" is
// the tree's root, "order_detail" is its child via relatesTo - proves
// the tree renders, pans/zooms, and the child's own raw-row table still
// works normally positioned inside a board node.
var boardLayoutPublish = {
  kind: 'publish',
  name: 'boardLayoutPublish',
  dependsOn: ['loadPublishOrders'],
  source: { type: 'ref', ref: 'loadPublishOrders' },
  target: { type: 'drive', folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'publish-board-layout.html', upsertByName: true },
  layout: { type: 'board' },
  charts: [
    { id: 'overview', type: 'bar', title: 'Revenue by category', groupBy: 'category', metric: { agg: 'sum', field: 'revenue' } }
  ],
  tables: [
    { id: 'order_detail', title: 'Order detail', mode: 'raw', relatesTo: 'overview',
      columns: [{ field: 'order_id', label: 'Order' }, { field: 'category', label: 'Category' }, { field: 'revenue', label: 'Revenue', format: 'currency' }] }
  ]
};
```

- [ ] **Step 3: Add the test function**

In `js/28-tests-publish.js`, add after
`testPublishDetailDrilldownPayloadCarriesGroupRows`:

```javascript
// Automated part: the written report's markup carries board-mode
// structure (a positioned node per block, one edge). Human part (do by
// hand after this passes): open the written Drive file in a browser,
// confirm "overview" and "order_detail" render as two connected boxes,
// drag to pan the canvas, and scroll to zoom in/out.
function testPublishBoardLayoutRendersPositionedTreeWithOneEdge() {
  runOne('loadPublishOrders');
  var result = runOne('boardLayoutPublish');
  var html = DriveApp.getFileById(result.driveFileId).getBlob().getDataAsString();

  check('board-viewport markup present', html.indexOf('board-viewport') !== -1, html);
  var nodeCount = (html.match(/class="board-node"/g) || []).length;
  check('exactly 2 board nodes rendered', nodeCount === 2, 'got ' + nodeCount);
  var edgeCount = (html.match(/class="board-edge"/g) || []).length;
  check('exactly 1 edge rendered (overview -> order_detail)', edgeCount === 1, 'got ' + edgeCount);
}
```

- [ ] **Step 4: Register the test**

In `js/90-test-registry.js`, add
`testPublishBoardLayoutRendersPositionedTreeWithOneEdge` to the end of
the `publish:` array.

- [ ] **Step 5: Point `SRC_REF` at the feature branch and deploy**

In the Apps Script editor, set the `SRC_REF` Script Property to
`feat/publish-board-layout`. Then:

```bash
clasp push -f
```

(Do this without asking — see this repo's CLAUDE.md: it only touches the
human's own personal test project.)

- [ ] **Step 6: Run the automated check**

In the Apps Script editor:
`runAllTests('testPublishBoardLayoutRendersPositionedTreeWithOneEdge')`.
Confirm it reports pass.

- [ ] **Step 7: Human confirms the actual UI**

Open the written Drive file (`publish-board-layout.html`) in a browser.
Confirm: "Revenue by category" and "Order detail" render as two
separate boxes connected by a line; click-and-drag anywhere on the
canvas pans it; the mouse wheel zooms in and out (clamped, doesn't zoom
away entirely or blow up unreasonably large); the "Order detail" table's
search/sort/pagination/CSV export inside its box still work exactly like
a `linear`-layout table would.

- [ ] **Step 8: Reset `SRC_REF`, commit, open the PR — ask first**

Set `SRC_REF` back to `main` (or whatever the active `notsobiglib`
release is) in the Apps Script editor.

```bash
git add js/08-fixtures-publish-targets.js js/28-tests-publish.js js/90-test-registry.js
git commit -m "test: add fixture for publish's board layout"
git push origin test/publish-board-layout-fixture
```

Ask the user for permission before pushing and opening the PR
(`gh pr create`), same "ask first" rule as `notsobiglib`. Cross-link this
PR and the `notsobiglib` PR from Task 5 in both descriptions, per
CLAUDE.md's "Open the PR — stop before merge" step.
