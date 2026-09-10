# `publish` board layout → d3-hierarchy/d3-zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `publish()`'s `layout: 'board'` rendering so node positions are computed client-side via `d3-hierarchy` (`d3.stratify()`/`d3.tree()`) and pan/zoom via `d3-zoom` (`d3.zoom()`), replacing the hand-rolled server-side contour-tree algorithm and hand-rolled mouse/touch/wheel listeners — reusing the D3 bundle already loaded via CDN for `charts[]`, no new dependency.

**Architecture:** `buildReportPayload` starts attaching each chart/table's `relatesTo` to its payload entry. `renderBoardCanvas` stops computing positions — it just wraps each block's existing markup in an unpositioned `<div class="board-node" data-block-id="...">` and an empty `<svg id="board-edges">`. A new client-side script (`BOARD_LAYOUT_CLIENT_JS`) runs on page load, rebuilds the `relatesTo` graph from `window.__PUBLISH_PAYLOAD__`, wraps it in a synthetic root (`d3.stratify()` needs exactly one), runs `d3.tree()`, shifts the result so no node lands at negative `x`, and writes `style.left`/`style.top` + draws edge `<path>`s itself. `BOARD_CLIENT_JS` (pan/zoom) is rewritten to `d3.zoom()`. The `d3Script` `<script src>` inclusion condition grows an `|| isBoardLayout` so a board with only `tables[]` still loads D3.

**Tech Stack:** Vanilla JS/GAS (`src/publish.js`), D3 v7 (`d3-hierarchy`, `d3-zoom` — already bundled in the CDN `d3.min.js` this file already loads), Node `assert`-based tests (`test/publish.test.js`) via the existing `vm`-context harness (`test/harness.js`).

**Spec:** `docs/superpowers/specs/2026-09-09-publish-board-d3-layout-design.md`

## Global Constraints

- `./build.sh` must be run (and its committed `src.js` diff included in the commit) any time `src/publish.js` changes — `test/harness.js` loads the committed `src.js`, not `src/` directly. `./build.sh --check` must pass before any task is considered done.
- `node test/run.js` must pass (full suite, not just the new tests) before any task is considered done.
- No new CDN URL, no new SRI hash, no change to `build.sh`'s `MODULES` manifest — `d3-hierarchy`/`d3-zoom` are already part of the `d3.min.js` build already pinned at `D3_CDN_URL`/`D3_CDN_INTEGRITY` (`src/publish.js:29-39`).
- Schema and validation (`validateBoardRelations`, `relatesTo`'s config-error rules) are **unchanged** — do not touch them.
- Client-side script constants in this file use ES5 function syntax (`function () {}`, `var`), matching `CHART_CLIENT_JS`/the existing `BOARD_CLIENT_JS` — no arrow functions, no `let`/`const`, for consistency with the rest of the file.
- This is a feature branch (`feat/publish-board-d3-layout`, off `release/16`). The plan stops at opening the PR — merging requires a human to run the Layer 2 (`notsobigtests`, Apps Script, real browser) fixture by hand; do not plan or claim that step.

---

## Task 1: Payload carries `relatesTo` per block

**Files:**
- Modify: `src/publish.js:713-738` (`buildReportPayload`)
- Test: `test/publish.test.js`

**Interfaces:**
- Consumes: nothing new — reads `chart.relatesTo`/`table.relatesTo`, already present on `config.charts[]`/`config.tables[]` entries per the existing `layout:'board'` schema.
- Produces: `payload.charts[i].relatesTo` and `payload.tables[i].relatesTo` — `string | null`. Task 3's client script reads exactly this field.

- [ ] **Step 1: Write the failing test**

Add to `test/publish.test.js`, near the other board tests (after `testPublishTableModeMustBeRawOrAggregated`, around line 378):

```javascript
// Task 1: buildReportPayload now attaches relatesTo to every chart/table
// payload entry (null when not declared) - the client-side layout script
// (Task 3) needs this to rebuild the relatesTo graph in the browser,
// since positioning no longer happens server-side. Attached
// unconditionally (not gated on layout:'board'), same posture "detail"
// already has - so a plain layout:'linear' report gets relatesTo: null
// on every block too, asserted below via aggregationPublish.
function testPublishPayloadCarriesRelatesToPerBlock() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);

  var boardResult = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(boardResult.status, 'success', 'expected the shimmed board run to succeed, got: ' + boardResult.error);
  var boardPayload = extractPayload(getHtml());
  var root = boardPayload.charts.filter(function (c) { return c.id === 'r'; })[0];
  var childChart = boardPayload.charts.filter(function (c) { return c.id === 'c1'; })[0];
  var childTable = boardPayload.tables.filter(function (t) { return t.id === 'c2'; })[0];
  assert.strictEqual(root.relatesTo, null, 'expected the root chart\'s relatesTo to be null, got: ' + JSON.stringify(root));
  assert.strictEqual(childChart.relatesTo, 'r', 'expected the child chart\'s relatesTo to round-trip into the payload, got: ' + JSON.stringify(childChart));
  assert.strictEqual(childTable.relatesTo, 'r', 'expected the child table\'s relatesTo to round-trip into the payload, got: ' + JSON.stringify(childTable));

  var chainResult = ctx.NotSoBigData.cli('run --select boardChainPublish').nodes[0];
  assert.strictEqual(chainResult.status, 'success', 'expected the shimmed chain run to succeed, got: ' + chainResult.error);
  var chainPayload = extractPayload(getHtml());
  var g = chainPayload.charts.filter(function (c) { return c.id === 'g'; })[0];
  var p = chainPayload.charts.filter(function (c) { return c.id === 'p'; })[0];
  var c = chainPayload.tables.filter(function (t) { return t.id === 'c'; })[0];
  assert.strictEqual(g.relatesTo, null, 'expected chain root "g" relatesTo null, got: ' + JSON.stringify(g));
  assert.strictEqual(p.relatesTo, 'g', 'expected chain middle "p" relatesTo "g", got: ' + JSON.stringify(p));
  assert.strictEqual(c.relatesTo, 'p', 'expected chain leaf "c" relatesTo "p", got: ' + JSON.stringify(c));

  var multiRootResult = ctx.NotSoBigData.cli('run --select boardMultiRootPublish').nodes[0];
  assert.strictEqual(multiRootResult.status, 'success', 'expected the shimmed multi-root run to succeed, got: ' + multiRootResult.error);
  var multiRootPayload = extractPayload(getHtml());
  multiRootPayload.charts.forEach(function (chart) {
    assert.strictEqual(chart.relatesTo, null, 'expected every multi-root chart to have relatesTo null, got: ' + JSON.stringify(chart));
  });

  var linearResult = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(linearResult.status, 'success', 'expected the shimmed linear run to succeed, got: ' + linearResult.error);
  var linearPayload = extractPayload(getHtml());
  assert.strictEqual(linearPayload.charts[0].relatesTo, null, 'expected a layout:"linear" chart with no relatesTo declared to default to null, got: ' + JSON.stringify(linearPayload.charts[0]));
}
```

Register it in the `module.exports` block (find `testPublishTableModeMustBeRawOrAggregated:` and add a line right after it):

```javascript
  testPublishPayloadCarriesRelatesToPerBlock: testPublishPayloadCarriesRelatesToPerBlock,
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/run.js`
Expected: FAIL on `testPublishPayloadCarriesRelatesToPerBlock` — `assert.strictEqual(root.relatesTo, null, ...)` fails because `root.relatesTo` is `undefined` (the field doesn't exist on the payload yet).

- [ ] **Step 3: Implement the payload passthrough**

In `src/publish.js`, replace the `charts`/`tables` `.map()` loops inside `buildReportPayload` (currently lines 720-728):

```javascript
  var charts = (config.charts || []).map(function (chart) {
    var chartRows = rowsForBlock(chart, rows, blockRowsByRef);
    return withDetail(buildChartPayload(chart, chartRows), chart, chartRows);
  });
  var tables = (config.tables || []).map(function (table) {
    var tableRows = rowsForBlock(table, rows, blockRowsByRef);
    var built = table.mode === 'raw' ? buildRawTablePayload(table, tableRows) : buildAggregatedTablePayload(table, tableRows);
    return withDetail(built, table, tableRows);
  });
```

with:

```javascript
  var charts = (config.charts || []).map(function (chart) {
    var chartRows = rowsForBlock(chart, rows, blockRowsByRef);
    var built = withDetail(buildChartPayload(chart, chartRows), chart, chartRows);
    built.relatesTo = chart.relatesTo || null;
    return built;
  });
  var tables = (config.tables || []).map(function (table) {
    var tableRows = rowsForBlock(table, rows, blockRowsByRef);
    var built = table.mode === 'raw' ? buildRawTablePayload(table, tableRows) : buildAggregatedTablePayload(table, tableRows);
    built = withDetail(built, table, tableRows);
    built.relatesTo = table.relatesTo || null;
    return built;
  });
```

- [ ] **Step 4: Rebuild and run the test to verify it passes**

Run: `./build.sh && node test/run.js`
Expected: PASS (full suite, not just the new test).

- [ ] **Step 5: Commit**

```bash
git add src/publish.js src.js test/publish.test.js
git commit -m "$(cat <<'EOF'
feat: attach relatesTo to publish() board payload entries

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Generation stops computing positions — `renderBoardCanvas` emits unpositioned nodes

**Files:**
- Modify: `src/publish.js:756-871` (delete `layoutSubtree`/`shiftPastSiblingContour`/`mergeContour`/`computeBoardLayout`, keep the four `BOARD_BOX_*`/`BOARD_*_GAP` constants at lines 751-754)
- Modify: `src/publish.js:951` (`BOARD_CSS`'s `.board-node` rule — bake in fixed width/height)
- Modify: `src/publish.js:1610-1648` (`renderBoardCanvas`)
- Modify: `test/publish.test.js` (delete 4 now-obsolete geometry tests + their exports + the fixture only they used; add 1 new markup test)
- Modify: `test/fixtures/publish-nodes.js` (delete `boardLopsidedPublish`, now unused)

**Interfaces:**
- Consumes: `config.charts`/`config.tables` (each `{id, relatesTo, ...}`), `chartSectionsList`/`tableSectionsList` (unchanged, built by `renderReportHtml` before calling `renderBoardCanvas`).
- Produces: `renderBoardCanvas(config, chartSectionsList, tableSectionsList) -> string` — HTML with one `<div class="board-node" data-block-id="...">` per block (no inline `style`), and an empty `<svg class="board-edges" id="board-edges">` (no `width`/`height`, no `<path>` children). Task 3's client script queries `[data-block-id="..."]` and `#board-edges` by these exact selectors.

- [ ] **Step 1: Write the failing test**

Add to `test/publish.test.js`, right after `testPublishBoardNodesAreNativelyResizable` (around line 232):

```javascript
// Task 2: renderBoardCanvas no longer computes positions - it wraps each
// block's markup in an unpositioned .board-node (data-block-id is the
// only thing Task 3's client script needs to find it), and #board-edges
// starts empty. The fixed box size moves from a per-node inline style
// into .board-node's own CSS rule instead - one declaration instead of
// N identical inline ones.
function testPublishBoardCanvasEmitsUnpositionedNodesForClientSideLayout() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();

  ['r', 'c1', 'c2'].forEach(function (id) {
    var needle = '<div class="board-node" data-block-id="' + id + '">';
    assert.ok(html.indexOf(needle) !== -1, 'expected an unpositioned board-node for "' + id + '", got: ' + html);
  });
  assert.ok(!/board-node[^>]*style=/.test(html), 'expected no inline style on any board-node (positioning moved client-side), got: ' + html);
  assert.ok(html.indexOf('<svg class="board-edges" id="board-edges"></svg>') !== -1, 'expected an empty board-edges svg with no width/height/paths baked in, got: ' + html);
  assert.strictEqual((html.match(/class="board-edge"/g) || []).length, 0, 'expected zero server-rendered edges (drawn client-side now), got: ' + html);

  var boardNodeRule = html.match(/\.board-node\s*\{[^}]*\}/);
  assert.ok(boardNodeRule, 'expected a .board-node CSS rule, got: ' + html);
  assert.ok(/width:\s*520px/.test(boardNodeRule[0]) && /height:\s*340px/.test(boardNodeRule[0]), 'expected the fixed box size baked into .board-node CSS instead of per-node inline style, got: ' + boardNodeRule[0]);
}
```

Register it: `testPublishBoardCanvasEmitsUnpositionedNodesForClientSideLayout: testPublishBoardCanvasEmitsUnpositionedNodesForClientSideLayout,` in `module.exports`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — today's `renderBoardCanvas` emits `style="left:...px;top:...px;width:520px;height:340px"` on every `.board-node` and 2 `class="board-edge"` paths, so both the "no inline style" and "zero edges" assertions fail.

- [ ] **Step 3: Delete the server-side layout algorithm**

In `src/publish.js`, delete lines 756-871 (everything between the `BOARD_V_GAP` constant and the blank line before `REPORT_CSS`'s own comment) — i.e. delete this entire block, keeping the four `var BOARD_BOX_WIDTH = 520;` ... `var BOARD_V_GAP = 60;` lines immediately above it untouched:

```javascript
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
```

(delete the whole block above — nothing replaces it in this file).

- [ ] **Step 4: Bake the fixed box size into `.board-node`'s CSS rule**

In `src/publish.js`'s `BOARD_CSS` array, replace the `.board-node` line:

```javascript
  '.board-node { position: absolute; background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 12px; box-sizing: border-box; overflow: auto; resize: both; min-width: 160px; min-height: 100px; }',
```

with:

```javascript
  '.board-node { position: absolute; width: ' + BOARD_BOX_WIDTH + 'px; height: ' + BOARD_BOX_HEIGHT + 'px; background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 12px; box-sizing: border-box; overflow: auto; resize: both; min-width: 160px; min-height: 100px; }',
```

- [ ] **Step 5: Rewrite `renderBoardCanvas`**

Replace the whole function (currently lines 1610-1648, from the `// Wraps the exact same per-block markup...` comment through the closing `}`):

```javascript
// Wraps each block's already-rendered markup (chartSectionsList[i]/
// tableSectionsList[i], unchanged) into an unpositioned .board-node div -
// actual x/y positioning now happens client-side, via d3-hierarchy, once
// the page has loaded (BOARD_LAYOUT_CLIENT_JS, below). The emitted
// #board-edges svg starts empty for the same reason: edges are drawn
// client-side too, once real positions exist. See docs/superpowers/specs/
// 2026-09-09-publish-board-d3-layout-design.md §3.
function renderBoardCanvas(config, chartSectionsList, tableSectionsList) {
  var charts = config.charts || [];
  var tables = config.tables || [];
  var sectionById = emptyMap();
  charts.forEach(function (chart, index) { sectionById[chart.id] = chartSectionsList[index]; });
  tables.forEach(function (table, index) { sectionById[table.id] = tableSectionsList[index]; });

  var nodesHtml = charts.concat(tables).map(function (block) {
    return '<div class="board-node" data-block-id="' + escapeHtml(block.id) + '">' + sectionById[block.id] + '</div>';
  }).join('');

  return '<div class="board-viewport"><div class="board-canvas" id="board-canvas">'
    + '<svg class="board-edges" id="board-edges"></svg>'
    + nodesHtml
    + '</div></div>';
}
```

- [ ] **Step 6: Run the new test to verify it passes, and the old geometry tests to verify they now fail**

Run: `./build.sh && node test/run.js`
Expected: `testPublishBoardCanvasEmitsUnpositionedNodesForClientSideLayout` PASSes. `testPublishBoardLayoutPositionsSingleRootTwoChildren`, `testPublishBoardLayoutPositionsThreeLevelChainInAStraightLine`, `testPublishBoardLayoutPlacesMultipleRootsSideBySide`, and `testPublishBoardLayoutPacksLopsidedTreeByRealPerDepthWidth` now FAIL — they assert exact `left:Npx;top:Npx` strings that no longer exist. This is expected: they test the removed server-side geometry (per the spec's §7, this Node-level position coverage is intentionally not replaced 1:1 — Layer 2 covers tree correctness visually now).

- [ ] **Step 7: Delete the four obsolete tests and their exports**

In `test/publish.test.js`, delete these four function definitions in full (each including its leading comment block): `testPublishBoardLayoutPositionsSingleRootTwoChildren` (with its `// boardValidPublish: root "r" with two children...` comment above it), `testPublishBoardLayoutPositionsThreeLevelChainInAStraightLine`, `testPublishBoardLayoutPlacesMultipleRootsSideBySide`, and `testPublishBoardLayoutPacksLopsidedTreeByRealPerDepthWidth` (with its `// computeBoardLayout task: the naive placement...` and `// Fixture "boardLopsidedPublish"...` comments above it).

Delete their corresponding `module.exports` lines. First, between
`testPublishBoardValidRelationsProceedPastValidation: testPublishBoardValidRelationsProceedPastValidation,`
and
`testPublishBoardClientJsEmittedOnlyForBoardLayout: testPublishBoardClientJsEmittedOnlyForBoardLayout,`,
delete these 3 lines:
```javascript
  testPublishBoardLayoutPositionsSingleRootTwoChildren: testPublishBoardLayoutPositionsSingleRootTwoChildren,
  testPublishBoardLayoutPositionsThreeLevelChainInAStraightLine: testPublishBoardLayoutPositionsThreeLevelChainInAStraightLine,
  testPublishBoardLayoutPlacesMultipleRootsSideBySide: testPublishBoardLayoutPlacesMultipleRootsSideBySide,
```

Second, at the very end of the exports object, replace:
```javascript
  testPublishButtonsAndSelectsInheritThemedTextColor: testPublishButtonsAndSelectsInheritThemedTextColor,
  testPublishBoardLayoutPacksLopsidedTreeByRealPerDepthWidth: testPublishBoardLayoutPacksLopsidedTreeByRealPerDepthWidth
};
```
with:
```javascript
  testPublishButtonsAndSelectsInheritThemedTextColor: testPublishButtonsAndSelectsInheritThemedTextColor
};
```
(the now-last entry loses its trailing comma).

- [ ] **Step 8: Delete the now-unused `boardLopsidedPublish` fixture**

In `test/fixtures/publish-nodes.js`, delete the `boardLopsidedPublish` variable declaration and its leading comment block (`// A lopsided tree: r -> {bushy, narrow}...`). Confirm nothing else references it: `grep -n boardLopsidedPublish test/publish.test.js test/fixtures/publish-nodes.js` should return nothing after this step.

- [ ] **Step 9: Run the full suite to verify it passes**

Run: `./build.sh && node test/run.js`
Expected: PASS (full suite).

- [ ] **Step 10: Commit**

```bash
git add src/publish.js src.js test/publish.test.js test/fixtures/publish-nodes.js
git commit -m "$(cat <<'EOF'
refactor: stop computing publish() board positions server-side

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Client-side layout via `d3.stratify()`/`d3.tree()`

**Files:**
- Modify: `src/publish.js` (new `BOARD_LAYOUT_CLIENT_JS` constant, placed right before `BOARD_CLIENT_JS`, i.e. before line 1527; wire it into `renderReportHtml`'s script assembly)
- Test: `test/publish.test.js`

**Interfaces:**
- Consumes: `window.__PUBLISH_PAYLOAD__.charts`/`.tables` (each `{id, relatesTo, ...}` — Task 1's output), the DOM elements `renderBoardCanvas` emits (`[data-block-id="..."]`, `#board-edges` — Task 2's output).
- Produces: positioned `.board-node` elements (`style.left`/`style.top` in px) and populated `#board-edges` (`width`/`height` attrs + one `<path class="board-edge">` per `relatesTo` pair) by the time `BOARD_CLIENT_JS` (Task 4) wires up pan/zoom on the same `DOMContentLoaded` pass.

- [ ] **Step 1: Write the failing test**

Add to `test/publish.test.js`, right after `testPublishBoardCanvasEmitsUnpositionedNodesForClientSideLayout` (from Task 2):

```javascript
// Task 3: BOARD_LAYOUT_CLIENT_JS computes positions in the browser via
// d3.stratify()/d3.tree() - can't be exercised end-to-end in Node (no
// DOM/d3 in the harness, same reason CHART_CLIENT_JS's actual D3 drawing
// is Layer-2-only, see src/publish.md), so this only asserts the script
// is emitted with the right shape: the synthetic-root sentinel (needed
// because relatesTo is a forest and d3.stratify() requires exactly one
// root), and nodeSize computed from BOARD_BOX_WIDTH/HEIGHT/H_GAP/V_GAP
// (520+40=560, 340+60=400).
function testPublishBoardLayoutClientJsEmittedWithCorrectNodeSize() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);

  var boardResult = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(boardResult.status, 'success', 'expected the shimmed board run to succeed, got: ' + boardResult.error);
  var boardHtml = getHtml();
  assert.ok(/d3\.stratify\(\)/.test(boardHtml), 'expected d3.stratify() in the board client script, got: ' + boardHtml);
  assert.ok(/__board_root__/.test(boardHtml), 'expected the synthetic-root sentinel id, got: ' + boardHtml);
  assert.ok(/d3\.tree\(\)\.nodeSize\(\[560, 400\]\)/.test(boardHtml), 'expected nodeSize([BOARD_BOX_WIDTH+BOARD_H_GAP, BOARD_BOX_HEIGHT+BOARD_V_GAP]) = [560, 400], got: ' + boardHtml);

  var linearResult = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(linearResult.status, 'success', 'expected the shimmed linear run to succeed, got: ' + linearResult.error);
  var linearHtml = getHtml();
  assert.ok(!/d3\.stratify\(\)/.test(linearHtml), 'expected no board layout client JS on a layout:"linear" report, got: ' + linearHtml);
}
```

Register it: `testPublishBoardLayoutClientJsEmittedWithCorrectNodeSize: testPublishBoardLayoutClientJsEmittedWithCorrectNodeSize,` in `module.exports`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — `d3.stratify()` doesn't appear anywhere in the emitted HTML yet.

- [ ] **Step 3: Add `BOARD_LAYOUT_CLIENT_JS`**

In `src/publish.js`, immediately before the `// Pan (mouse/touch drag) + zoom (wheel), vanilla JS/CSS transform, no` comment that introduces `BOARD_CLIENT_JS` (currently line 1527), insert:

```javascript
// Client-side board layout via d3-hierarchy - runs on DOMContentLoaded,
// before BOARD_CLIENT_JS's pan/zoom setup (registered right after it in
// the same script, so it always executes first - see renderReportHtml).
// Rebuilds the relatesTo graph from window.__PUBLISH_PAYLOAD__ (server
// no longer computes positions, see renderBoardCanvas), wraps it in one
// synthetic root (d3.stratify() requires exactly one; relatesTo is a
// forest - zero or more independent roots), runs d3.tree(), then shifts
// every x by -minX so no real node lands at a negative style.left (d3.tree()
// centers the root at x=0 and spreads children on both sides, unlike the
// deleted contour algorithm which always started at 0). See
// docs/superpowers/specs/2026-09-09-publish-board-d3-layout-design.md §4.
var BOARD_LAYOUT_CLIENT_JS = [
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  var blocks = payload.charts.concat(payload.tables);',
  '  var rootId = "__board_root__";',
  '  var nodesData = blocks.map(function (b) { return { id: b.id, relatesTo: b.relatesTo }; });',
  '  nodesData.push({ id: rootId, relatesTo: null });',
  '  nodesData.forEach(function (n) { if (n.id !== rootId && !n.relatesTo) { n.relatesTo = rootId; } });',
  '  var stratify = d3.stratify().id(function (n) { return n.id; }).parentId(function (n) { return n.relatesTo; });',
  '  var root = stratify(nodesData);',
  '  var treeLayout = d3.tree().nodeSize([' + (BOARD_BOX_WIDTH + BOARD_H_GAP) + ', ' + (BOARD_BOX_HEIGHT + BOARD_V_GAP) + ']);',
  '  treeLayout(root);',
  '  var realNodes = root.descendants().filter(function (n) { return n.id !== rootId; });',
  '  if (!realNodes.length) { return; }',
  '  var minX = Math.min.apply(null, realNodes.map(function (n) { return n.x; }));',
  '  var positionById = {};',
  '  realNodes.forEach(function (n) {',
  '    var x = n.x - minX;',
  '    positionById[n.id] = { x: x, y: n.y };',
  '    var el = document.querySelector("[data-block-id=\\"" + n.id + "\\"]");',
  '    if (el) { el.style.left = x + "px"; el.style.top = n.y + "px"; }',
  '  });',
  '  var edges = blocks.filter(function (b) { return b.relatesTo; }).map(function (b) { return { from: b.relatesTo, to: b.id }; });',
  '  var maxX = 0, maxY = 0;',
  '  realNodes.forEach(function (n) {',
  '    var p = positionById[n.id];',
  '    maxX = Math.max(maxX, p.x + ' + BOARD_BOX_WIDTH + ');',
  '    maxY = Math.max(maxY, p.y + ' + BOARD_BOX_HEIGHT + ');',
  '  });',
  '  var svg = document.getElementById("board-edges");',
  '  svg.setAttribute("width", maxX);',
  '  svg.setAttribute("height", maxY);',
  '  var edgePaths = edges.map(function (e) {',
  '    var from = positionById[e.from], to = positionById[e.to];',
  '    var x1 = from.x + ' + (BOARD_BOX_WIDTH / 2) + ', y1 = from.y + ' + BOARD_BOX_HEIGHT + ';',
  '    var x2 = to.x + ' + (BOARD_BOX_WIDTH / 2) + ', y2 = to.y;',
  '    return "<path class=\\"board-edge\\" d=\\"M" + x1 + " " + y1 + " L" + x2 + " " + y2 + "\\"></path>";',
  '  });',
  '  svg.innerHTML = edgePaths.join("");',
  '});'
].join('\n');
```

- [ ] **Step 4: Wire it into `renderReportHtml`'s script assembly**

In `src/publish.js`, `renderReportHtml`'s `if (isBoardLayout) { script += BOARD_CLIENT_JS; }` (currently lines 1676-1678):

```javascript
  if (isBoardLayout) {
    script += BOARD_CLIENT_JS;
  }
```

replace with:

```javascript
  if (isBoardLayout) {
    script += BOARD_LAYOUT_CLIENT_JS;
    script += BOARD_CLIENT_JS;
  }
```

(layout script registered first, so its `DOMContentLoaded` listener runs before `BOARD_CLIENT_JS`'s).

- [ ] **Step 5: Run the test to verify it passes**

Run: `./build.sh && node test/run.js`
Expected: PASS (full suite).

- [ ] **Step 6: Commit**

```bash
git add src/publish.js src.js test/publish.test.js
git commit -m "$(cat <<'EOF'
feat: compute publish() board node positions client-side via d3-hierarchy

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Pan/zoom via `d3.zoom()`

**Files:**
- Modify: `src/publish.js:1527-1562` (`BOARD_CLIENT_JS`)
- Modify: `test/publish.test.js` (rewrite `testPublishBoardClientJsEmittedOnlyForBoardLayout` and `testPublishBoardClientJsClampsZoomAndAppliesTransform`)

**Interfaces:**
- Consumes: `.board-viewport`/`#board-canvas` DOM elements (`renderBoardCanvas`, unchanged), runs after `BOARD_LAYOUT_CLIENT_JS` (Task 3) in the same script so `#board-canvas` already holds positioned content when zoom is attached.
- Produces: same CSS contract as before — `canvas.style.transform` set to a `translate(...) scale(...)` string, `.board-viewport.board-panning` toggled during a drag. No other code depends on `BOARD_CLIENT_JS`'s internals.

- [ ] **Step 1: Write the failing test (rewrite both existing tests)**

In `test/publish.test.js`, replace `testPublishBoardClientJsEmittedOnlyForBoardLayout` (currently lines 189-204):

```javascript
function testPublishBoardClientJsEmittedOnlyForBoardLayout() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);

  var boardResult = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(boardResult.status, 'success', 'expected the shimmed board run to succeed, got: ' + boardResult.error);
  var boardHtml = getHtml();
  assert.ok(/d3\.zoom\(\)\.scaleExtent\(\[0\.25, 2\]\)/.test(boardHtml), 'expected the d3.zoom() pan/zoom setup, got: ' + boardHtml);
  assert.ok(/d3\.select\(viewport\)\.call\(zoom\)/.test(boardHtml), 'expected the zoom behavior attached to the viewport, got: ' + boardHtml);

  var linearResult = ctx.NotSoBigData.cli('run --select aggregationPublish').nodes[0];
  assert.strictEqual(linearResult.status, 'success', 'expected the shimmed linear run to succeed, got: ' + linearResult.error);
  var linearHtml = getHtml();
  assert.ok(!/board-viewport/.test(linearHtml), 'expected no board markup on a layout:"linear" report, got: ' + linearHtml);
  assert.ok(!/d3\.zoom\(\)/.test(linearHtml), 'expected no board pan/zoom client JS on a layout:"linear" report, got: ' + linearHtml);
}
```

and replace `testPublishBoardClientJsClampsZoomAndAppliesTransform` (currently lines 206-214):

```javascript
function testPublishBoardClientJsClampsZoomAndAppliesTransform() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/scaleExtent\(\[0\.25, 2\]\)/.test(html), 'expected zoom clamped to [0.25, 2] via d3.zoom().scaleExtent, got: ' + html);
  assert.ok(/canvas\.style\.transform = event\.transform\.toString\(\)/.test(html), 'expected the pan\/zoom transform application via d3-zoom\'s event.transform, got: ' + html);
}
```

(the `module.exports` entries for both already exist from before — no export changes needed here).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run.js`
Expected: FAIL — today's `BOARD_CLIENT_JS` has no `d3.zoom()` call at all, so every new assertion in both tests fails.

- [ ] **Step 3: Rewrite `BOARD_CLIENT_JS`**

Replace the whole constant (currently lines 1527-1562, from the `// Pan (mouse/touch drag) + zoom (wheel), vanilla JS/CSS transform, no` comment through the closing `].join('\n');`):

```javascript
// Pan (drag) + zoom (wheel/pinch/double-click) via d3-zoom - reuses the
// D3 bundle already loaded for charts[]/BOARD_LAYOUT_CLIENT_JS, see
// docs/superpowers/specs/2026-09-09-publish-board-d3-layout-design.md §5.
// Registered right after BOARD_LAYOUT_CLIENT_JS in the same script (see
// renderReportHtml), so #board-canvas already holds positioned content
// by the time this runs. Self-contained: its own DOMContentLoaded
// listener, independent of TABLE_CLIENT_JS/CHART_CLIENT_JS's own
// listeners, only emitted when layout:'board' is used (see
// renderReportHtml's isBoardLayout branch).
var BOARD_CLIENT_JS = [
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var viewport = document.querySelector(".board-viewport");',
  '  var canvas = document.getElementById("board-canvas");',
  '  if (!viewport || !canvas) { return; }',
  '  var zoom = d3.zoom().scaleExtent([0.25, 2])',
  '    .on("start", function () { viewport.classList.add("board-panning"); })',
  '    .on("end", function () { viewport.classList.remove("board-panning"); })',
  '    .on("zoom", function (event) { canvas.style.transform = event.transform.toString(); });',
  '  d3.select(viewport).call(zoom);',
  '});'
].join('\n');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./build.sh && node test/run.js`
Expected: PASS (full suite — including `testPublishBoardNodesAreNativelyResizable`, unaffected by this task, and `testPublishBoardCanvasEmitsUnpositionedNodesForClientSideLayout`/`testPublishBoardLayoutClientJsEmittedWithCorrectNodeSize` from Tasks 2-3, also unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/publish.js src.js test/publish.test.js
git commit -m "$(cat <<'EOF'
feat: replace publish() board's hand-rolled pan/zoom with d3-zoom

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Load D3 for a chart-less board layout

**Files:**
- Modify: `src/publish.js:1687` (`d3Script` inclusion condition)
- Modify: `test/fixtures/publish-nodes.js` (new `boardTablesOnlyPublish` fixture)
- Test: `test/publish.test.js`

**Interfaces:**
- Consumes: `isBoardLayout` (already computed at the top of `renderReportHtml`, line 1651), `payload.charts.length`.
- Produces: no interface change for other code — this only changes when the `<script src="...d3.min.js">` tag is present in the output.

- [ ] **Step 1: Add the fixture**

In `test/fixtures/publish-nodes.js`, add near the other board fixtures (after `boardMultiRootPublish`, before `tablesPublish`):

```javascript
// Board layout with zero charts[] - exercises the d3Script inclusion
// fix (Task 5): layout:'board' must load D3 even when payload.charts.length
// is 0, since both positioning (Task 3) and pan/zoom (Task 4) need it now.
var boardTablesOnlyPublish = {
  kind: 'publish',
  name: 'boardTablesOnlyPublish',
  dependsOn: ['moveWithBigQueryTarget'],
  source: { type: 'ref', ref: 'moveWithBigQueryTarget' },
  target: { type: 'drive', folderId: 'folder-id', fileName: 'board-tables-only.html' },
  layout: { type: 'board' },
  tables: [
    { id: 'parent', title: 'Parent', mode: 'raw', columns: [{ field: 'category' }] },
    { id: 'child', title: 'Child', mode: 'raw', columns: [{ field: 'category' }], relatesTo: 'parent' }
  ]
};
```

- [ ] **Step 2: Write the failing test**

Add to `test/publish.test.js`, right after `testPublishBoardClientJsClampsZoomAndAppliesTransform` (from Task 4):

```javascript
function testPublishBoardLoadsD3EvenWithoutCharts() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category'], [['A']]);
  var result = ctx.NotSoBigData.cli('run --select boardTablesOnlyPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/d3\//.test(html), 'expected the D3 CDN script tag on a chart-less board layout report, got: ' + html);
}
```

Register it: `testPublishBoardLoadsD3EvenWithoutCharts: testPublishBoardLoadsD3EvenWithoutCharts,` in `module.exports`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — `payload.charts.length` is `0` for `boardTablesOnlyPublish`, so today's condition emits no `<script src>` tag at all.

- [ ] **Step 4: Fix the condition**

In `src/publish.js`, replace:

```javascript
  var d3Script = payload.charts.length ? '<script src="' + D3_CDN_URL + '" integrity="' + D3_CDN_INTEGRITY + '" crossorigin="anonymous"></script>' : '';
```

with:

```javascript
  var d3Script = (payload.charts.length || isBoardLayout) ? '<script src="' + D3_CDN_URL + '" integrity="' + D3_CDN_INTEGRITY + '" crossorigin="anonymous"></script>' : '';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `./build.sh && node test/run.js`
Expected: PASS (full suite).

- [ ] **Step 6: Commit**

```bash
git add src/publish.js src.js test/publish.test.js test/fixtures/publish-nodes.js
git commit -m "$(cat <<'EOF'
fix: load D3 for a board-layout publish() report with no charts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Docs, final verification, and PR

**Files:**
- Modify: `docs/publish.md:290-337` ("Board layout" section)
- Modify: `src/publish.md:393-425` ("Board layout" dev note)
- No test changes — this task verifies, documents, and ships what Tasks 1-5 already built and tested.

- [ ] **Step 1: Update `docs/publish.md`'s user-facing Board layout section**

Replace the two bullets in `docs/publish.md` (currently within lines 290-337) that describe the pan/zoom mechanism and the "known ceiling":

```markdown
- Pan (click-drag or touch-drag) and zoom (mouse wheel, clamped
  roughly 0.25×–2×) are built in, vanilla JS/CSS — no extra config, no
  external library.
- **Known ceiling:** the layout centers each parent over its children
  but doesn't do full collision-avoiding tree layout, so a very lopsided
  tree (a long chain next to a wide shallow one) can look uneven rather
  than tightly packed. Fine for the box counts a dashboard realistically
  has.
```

with:

```markdown
- Pan (click-drag or touch-drag), zoom (mouse wheel, clamped roughly
  0.25×–2×), pinch-zoom (touch), and double-click-to-zoom-in are built
  in via [d3-zoom](https://d3js.org/d3-zoom) — the same D3 bundle
  `charts[]` already loads, no extra config, no new dependency.
- Node positions are computed in the reader's browser (via
  [d3-hierarchy](https://d3js.org/d3-hierarchy)'s tree layout), not at
  generation time — a real, non-approximate tree layout, and no more
  "known ceiling" on lopsided trees. This does mean a board needs
  JavaScript enabled to show any layout at all (it already needed
  JavaScript for pan/zoom, and for any chart drawn on it).
```

- [ ] **Step 2: Replace `src/publish.md`'s Board layout dev note**

Replace the entire `## Board layout (\`layout: 'board'\`)` section in `src/publish.md` (currently lines 393-425, from that heading through the paragraph ending "...only how they're assembled into the page differs.") with:

```markdown
## Board layout (`layout: 'board'`)

Position computation moved from server-side (a hand-rolled contour-tree
walk, `computeBoardLayout`/`layoutSubtree`/`shiftPastSiblingContour`/
`mergeContour` — now deleted) to client-side, via D3's own
`d3.stratify()`/`d3.tree()` (`BOARD_LAYOUT_CLIENT_JS`) — see
`docs/superpowers/specs/2026-09-09-publish-board-d3-layout-design.md`
for the full rationale (the driving constraint: this library ships as
one `eval()`'d file with no npm/bundler, so `d3-hierarchy` can only ever
run where D3 already runs — the reader's browser, not the GAS runtime
`renderBoardCanvas` executes in). `relatesTo` is a forest (zero or more
independent roots), but `d3.stratify()` requires exactly one root, so
`BOARD_LAYOUT_CLIENT_JS` prepends a synthetic `__board_root__` node and
points every real root at it before calling `stratify()` — this also
gets every independent tree positioned side by side in one `d3.tree()`
call, for free, which is the actual "full apportionment" upgrade the
old contour algorithm's ceiling comment used to say wasn't worth a
second hand-written pass.

`d3.tree()` centers its root at `x = 0` and spreads children on both
sides, so real nodes can land at negative `x` — unlike the deleted
contour algorithm, which always started at `0`. `BOARD_LAYOUT_CLIENT_JS`
shifts every node's `x` by `-minX` (the minimum `x` across all real,
non-synthetic nodes) before writing any `style.left`, so nothing ever
gets a negative position.

Edges are **not** taken from `d3.tree()`'s own link objects — they're
built directly from each block's `relatesTo` field (now attached to
every payload entry by `buildReportPayload`, unconditionally — same
"attach per-block, not gated on layout mode" posture `detail` already
has), the same `{from, to}` shape the deleted `computeBoardLayout`'s
`edges` array used to produce server-side. The `<path>` drawing itself
(straight line, parent-bottom-midpoint to child-top-midpoint) is
unchanged — only which side computes the coordinates moved.

`BOARD_BOX_WIDTH`/`BOARD_BOX_HEIGHT`/`BOARD_H_GAP`/`BOARD_V_GAP` survive
the rewrite, repurposed: `BOARD_CSS`'s `.board-node` rule now bakes
`BOARD_BOX_WIDTH`/`BOARD_BOX_HEIGHT` in directly (replacing the old
per-node inline `style="width:...;height:..."`), and the same four
numbers are serialized as literal numbers into `BOARD_LAYOUT_CLIENT_JS`'s
`d3.tree().nodeSize([...])` call — one source of truth in this
server-side file, read by both CSS generation and the emitted client
script.

`BOARD_CLIENT_JS` (pan/zoom) is now a thin `d3.zoom()` setup instead of
hand-rolled `mousedown`/`touchstart`/`wheel` listeners — same
`.board-viewport`/`.board-canvas`/`.board-panning` CSS contract as
before (`canvas.style.transform`, `.board-panning` toggled on
drag-start/end), same `scaleExtent([0.25, 2])` clamp range, but gains
real pinch-zoom and double-click-to-zoom for free from `d3.zoom()`'s
own defaults. It's registered right after `BOARD_LAYOUT_CLIENT_JS` in
`renderReportHtml`'s script assembly, so positions and edges already
exist by the time pan/zoom is wired up.

**Testing tradeoff:** `computeBoardLayout`'s own pure-function position
tests (single root/2 children, 3-level chain, independent roots, a
lopsided tree's per-depth contour clearance) no longer exist — that
logic isn't server-side anymore, so it isn't Node-testable anymore.
Layer 1 now only checks that `relatesTo` round-trips into the payload
correctly and that the emitted markup/client-script shape is right
(unpositioned `.board-node`s, empty `#board-edges`, the right
`nodeSize()` numbers present in the emitted script). Actual tree
geometry (no overlap, edges connecting the right boxes) is Layer2
(`notsobigtests`, human-run) territory now — the same posture chart
pixel-accuracy already has.

`relatesTo` deliberately shares one id namespace across `charts[]` and
`tables[]` (`validateBoardRelations`'s `registerBlock` check) - every
other `publish()` feature keeps chart ids and table ids in separate
namespaces (duplicate-id checks run independently in
`validatePublishConfig`'s two per-block loops), but a `relatesTo` value
has no way to say which array it's pointing into, so this feature alone
needed the combined-namespace rule. This part is unchanged by the
rework — `validateBoardRelations` was never touched.

`renderBoardCanvas` reuses `chartSectionsList`/`tableSectionsList` -
`renderReportHtml`'s per-block markup, computed once, unconditionally,
regardless of layout - rather than re-deriving chart/table HTML a
second time for board mode. Both layout modes read from the same two
arrays; only how they're assembled into the page (and, now, how
positions are computed) differs.
```

- [ ] **Step 3: Run the full verification gate**

Run: `./build.sh --check && node test/run.js`
Expected: `build.sh --check` reports `src.js` matches `src/` (no diff); `node test/run.js` PASSes in full.

- [ ] **Step 4: Commit the docs**

```bash
git add docs/publish.md src/publish.md
git commit -m "$(cat <<'EOF'
docs: describe publish() board layout's d3-hierarchy/d3-zoom rework

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Push and open the PR — then stop**

```bash
git push -u origin feat/publish-board-d3-layout
gh pr create --base release/16 --title "Rework publish() board layout onto d3-hierarchy/d3-zoom" --body "$(cat <<'EOF'
## Summary
- Board layout (`layout: 'board'`) node positions now compute client-side via `d3.stratify()`/`d3.tree()` instead of a hand-rolled server-side contour-tree walk — resolves the algorithm's documented approximation ceiling for free.
- Pan/zoom now uses `d3.zoom()` instead of hand-rolled mouse/touch/wheel listeners — gains real pinch-zoom and double-click-to-zoom.
- Both reuse the D3 bundle already loaded via CDN for `charts[]` — no new dependency, no new CDN URL/SRI hash.
- Schema and validation (`relatesTo`, `validateBoardRelations`) are unchanged.

Design spec: `docs/superpowers/specs/2026-09-09-publish-board-d3-layout-design.md`

## Test plan
- [x] `node test/run.js` passes (Layer 1 — see the spec's §7 for what's newly covered vs. no longer Node-testable)
- [x] `./build.sh --check` passes
- [ ] **Layer 2 (human, required before merge):** in `notsobigtests`, point `SRC_REF` at `feat/publish-board-d3-layout`, run the existing board-layout fixture, and verify in a real browser: tree renders with no overlapping nodes, edges connect the right parent/child pairs, pan (drag) and zoom (wheel) work, pinch-zoom works on a touch device, double-click zooms in, `linkTo` still navigates, and a filter/detail-drilldown block positioned mid-tree still recomputes/opens correctly. Reset `SRC_REF` back to `main`/the active release afterward.
EOF
)"
```

**Stop here.** This PR does not merge until a human runs the Layer 2 fixture above by hand in `notsobigtests` and confirms it passes — per this repo's own `CLAUDE.md` workflow, that verification cannot be automated or claimed by an agent.
