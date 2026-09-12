# Pipeline Canvas Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `src/publish.js`'s and `src/docs.js`'s generated `.html` output to match the approved visual prototype — a new design-token system, a direction-aware/draggable/hover-highlighting board layout shared by both modules, compact metric-card board nodes for `publish` (click-to-expand into the existing full chart/table), and a sidebar+drawer for `cli('docs')`.

**Architecture:** Everything is generation-time (CSS/HTML string constants `publish.js`/`docs.js` already build) or client-side (new/rewritten JS embedded in the generated file's own `<script>`, run in the reader's browser — this library has no runtime component outside the generated file). No `cli()` command, flag, or declarative config field is added. Pure, DOM-free helpers are written once as real top-level functions and reused verbatim client-side via `.toString()` (the same pattern `FILTER_REUSED_FUNCTIONS_JS`/`DETAIL_REUSED_FUNCTIONS_JS` already use) so they stay Node-testable; DOM-touching glue (drag, `localStorage`, `d3.stratify()`/`d3.tree()`, the expand overlay) is hand-written JS text, same as every other `*_CLIENT_JS` constant in `publish.js` today, and is Layer 2 (human, `notsobigtests`) territory — it can't run in the Node test harness, which has no D3 and no real DOM.

**Tech Stack:** Plain ES5-style JS (no build step for consumers — see `CLAUDE.md`'s "One file to install, three files to author"), D3 v7 (already CDN-loaded for `charts[]`/board mode), Node's `assert` + the project's own zero-framework test runner (`test/run.js`).

**Spec:** `docs/superpowers/specs/2026-09-12-pipeline-canvas-redesign-design.md`

## Global Constraints

- No new declarative config: no `layout.direction` field, no per-block opt-in for metric cards vs. full chart. Board mode always uses the new behavior.
- No Google Fonts / no `<link>`/`@import` for typography — system font stacks only, so KPIs/tables/docs stay usable fully offline (only `charts[]`/board mode's existing D3-CDN dependency requires network, unchanged from today).
- Every pure helper that's reused client-side must never reference a GAS-only global (`BigQuery`, `DriveApp`, `Utilities`, etc.) or a free variable that isn't one of its own parameters — `.toString()` reuse ships the function's source exactly as written, with nothing auto-inlined.
- `./build.sh` must be run (and `./build.sh --check` must pass) after every `src/*.js` change, before running `node test/run.js` — the harness loads the committed `src.js`, not `src/` directly.
- Branch: `feat/pipeline-canvas-redesign`, already cut off `release/16` (current branch). Commit after every task.
- Docs (`docs/publish.md`, `docs/cli.md`) land in the same branch, not a follow-up — see Task 9.

---

### Task 1: New design tokens (palette + system fonts)

**Files:**
- Modify: `src/publish.js:770` (`DARK_TOKENS_CSS`), `src/publish.js:771-826` (`REPORT_CSS`), `src/publish.js:1294`, `src/publish.js:1365`, `src/publish.js:1381` (`CHART_CLIENT_JS`'s three `var(--teal)`/`var(--coral)` color-scale references)
- Modify: `test/publish.test.js:763` (comment), `test/publish.test.js:2015`, `test/publish.test.js:2054-2062`

**Interfaces:**
- Produces: renamed CSS custom properties every later task reads — `--accent`/`--accent-soft` (was `--teal`/`--teal-soft`), `--bad` (was `--coral`), plus new `--good`/`--good-soft`, `--warn`/`--warn-soft` (KPI/metric-card deltas, Tasks 6-7), and `--move`/`--model`/`--publish` (docs per-kind coloring, Task 8). `--paper`/`--surface`/`--paper-line`/`--ink`/`--ink-soft`/`--shadow`/`--shadow-sm`/`--radius`/`--radius-sm`/`--mono`/`--sans` keep their existing names (only values change).

- [ ] **Step 1: Run the baseline test suite and confirm it's green**

```bash
cd /home/moschi/projetos/notsobig_org/notsobiglib
./build.sh && node test/run.js
```

Expected: `... passed, 0 failed.` (confirms the starting point before any token rename.)

- [ ] **Step 2: Update the two existing tests that pin the old token values**

In `test/publish.test.js`, change line 2015 from:

```javascript
  assert.ok(html.indexOf('#202124') !== -1, 'expected the dark-mode canvas color token, got: ' + html);
```

to:

```javascript
  assert.ok(html.indexOf('#10141B') !== -1, 'expected the dark-mode canvas color token, got: ' + html);
```

And change the `testPublishLineChartUsesVarTealNotHardcodedHex` function (lines 2054-2062) from:

```javascript
function testPublishLineChartUsesVarTealNotHardcodedHex() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'day', 'revenue'], [['A', '1', '10']]);
  var result = ctx.NotSoBigData.cli('run --select lineChartPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/\.style\("stroke", "var\(--teal\)"\)/.test(html), 'expected the line chart stroke to read var(--teal), got: ' + html);
  assert.ok(html.indexOf('#3F6659') === -1, 'expected no remaining hardcoded line-chart color, got: ' + html);
}
```

to:

```javascript
function testPublishLineChartUsesVarAccentNotHardcodedHex() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'day', 'revenue'], [['A', '1', '10']]);
  var result = ctx.NotSoBigData.cli('run --select lineChartPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/\.style\("stroke", "var\(--accent\)"\)/.test(html), 'expected the line chart stroke to read var(--accent), got: ' + html);
  assert.ok(html.indexOf('#3F6659') === -1, 'expected no remaining hardcoded line-chart color, got: ' + html);
}
```

Rename the matching entry in the `module.exports` block at the bottom of the same file from `testPublishLineChartUsesVarTealNotHardcodedHex: testPublishLineChartUsesVarTealNotHardcodedHex,` to `testPublishLineChartUsesVarAccentNotHardcodedHex: testPublishLineChartUsesVarAccentNotHardcodedHex,`.

Also fix the stale comment at line 763 (`// via .attr("fill", ...) - REPORT_CSS's ".chart-bar { fill: var(--teal); }"`) to read `var(--accent)`.

- [ ] **Step 2b: Run tests to confirm these two now fail**

```bash
node test/run.js
```

Expected: `FAIL  publish.test.js - testPublishDarkModeTokensPresent - ...` and `FAIL  publish.test.js - testPublishLineChartUsesVarAccentNotHardcodedHex - ...` (both still reference the *old* token values/names, which still exist in `src/publish.js` at this point).

- [ ] **Step 3: Replace `DARK_TOKENS_CSS` and `REPORT_CSS` in `src/publish.js`**

Replace line 770 with:

```javascript
var DARK_TOKENS_CSS = '--paper: #10141B; --surface: #171C25; --paper-line: #2A313D; --ink: #E6E9EE; --ink-soft: #98A2B3; --accent: #7C97FF; --accent-soft: #223055; --bad: #F87171; --good: #4ADE80; --good-soft: #16321F; --warn: #F2B355; --warn-soft: #3A2A10; --move: #7C97FF; --model: #C09BFF; --publish: #F0A868; --shadow-sm: 0 1px 2px 0 rgba(0,0,0,.45), 0 2px 6px 2px rgba(0,0,0,.3); --shadow: 0 1px 3px 0 rgba(0,0,0,.5), 0 4px 8px 3px rgba(0,0,0,.35);';
```

Replace the `REPORT_CSS` array (lines 771-826) with:

```javascript
var REPORT_CSS = [
  ':root {',
  '  --paper: #F5F4F1; --surface: #FFFFFF; --paper-line: #E1DFD9; --ink: #1B2430; --ink-soft: #5B6472;',
  '  --accent: #2D5FE0; --accent-soft: #E7ECFE; --bad: #DC2626;',
  '  --good: #1F9D55; --good-soft: #E4F6EB; --warn: #B45309; --warn-soft: #FDF1E0;',
  '  --move: #2D5FE0; --model: #7C3AED; --publish: #C2560B;',
  '  --shadow-sm: 0 1px 2px 0 rgba(60,64,67,.30), 0 2px 6px 2px rgba(60,64,67,.15);',
  '  --shadow: 0 1px 3px 0 rgba(60,64,67,.30), 0 4px 8px 3px rgba(60,64,67,.15);',
  '  --radius: 8px; --radius-sm: 4px;',
  '  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;',
  '  --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;',
  '}',
  '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ' + DARK_TOKENS_CSS + ' } }',
  ':root[data-theme="dark"] { ' + DARK_TOKENS_CSS + ' }',
  'body { background: var(--paper); color: var(--ink); font-family: var(--sans); margin: 0; padding: 24px; }',
  'button, select, input { font: inherit; color: inherit; }',
  '.table-search::placeholder { color: var(--ink-soft); }',
  '.kpis { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }',
  '.kpi { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 12px 16px; transition: box-shadow .15s ease, transform .15s ease; }',
  '.kpi:hover { box-shadow: var(--shadow); transform: translateY(-1px); }',
  '.kpi-label { font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; color: var(--ink-soft); }',
  '.kpi-value { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 24px; }',
  '.chart { background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 20px; margin-top: 16px; }',
  '.chart h2 { font-size: 14px; margin-top: 0; }',
  '.chart-label, .chart-value { font-family: var(--mono); font-size: 12px; fill: var(--ink); }',
  '.chart-bar { fill: var(--accent); }',
  '.table-block { background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 20px; margin-top: 16px; }',
  '.table-block h2 { font-size: 14px; margin-top: 0; }',
  '.table-block table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }',
  '.table-block th, .table-block td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--paper-line); font-variant-numeric: tabular-nums; }',
  '.table-block th.table-sortable { cursor: pointer; user-select: none; }',
  '.table-block tbody tr:hover { background: var(--accent-soft); }',
  '.table-search { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 2px 6px; margin-bottom: 8px; display: block; transition: border-color .15s ease; }',
  '.table-search:hover, .table-search:focus-visible { border-color: var(--accent); }',
  '.table-pager { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-family: var(--mono); font-size: 12px; }',
  '.table-pager button { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 2px 8px; cursor: pointer; transition: border-color .15s ease; }',
  '.table-pager button:hover:not(:disabled) { border-color: var(--accent); }',
  '.table-pager button:disabled { color: var(--ink-soft); cursor: default; }',
  '.table-csv-export { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 2px 8px; margin-top: 8px; cursor: pointer; transition: border-color .15s ease; }',
  '.table-csv-export:hover { border-color: var(--accent); }',
  '.filters { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }',
  '.filter { font-family: var(--mono); font-size: 12px; display: flex; flex-direction: column; gap: 4px; }',
  '.filter select { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 2px 6px; transition: border-color .15s ease; }',
  '.filter select:hover, .filter select:focus-visible { border-color: var(--accent); }',
  '.detail-modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; z-index: 1000; }',
  '.detail-modal { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px; max-width: 90vw; max-height: 80vh; overflow: auto; }',
  '.detail-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }',
  '.detail-modal-header h3 { margin: 0; font-size: 14px; }',
  '.detail-modal-close { font-family: var(--mono); font-size: 16px; background: none; border: none; cursor: pointer; }',
  '.detail-modal table { border-collapse: collapse; font-family: var(--mono); font-size: 12px; }',
  '.detail-modal th, .detail-modal td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--paper-line); }',
  '.theme-toggle { position: fixed; top: 12px; right: 12px; z-index: 1100; width: 32px; height: 32px; border-radius: 999px; border: 1px solid var(--paper-line); background: var(--surface); color: var(--ink-soft); display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: var(--shadow-sm); transition: background-color .15s ease, border-color .15s ease, color .15s ease; }',
  '.theme-toggle:hover { color: var(--accent); border-color: var(--accent); }',
  '.theme-toggle-icon-moon { display: none; }',
  '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .theme-toggle-icon-sun { display: none; } :root:not([data-theme="light"]) .theme-toggle-icon-moon { display: block; } }',
  ':root[data-theme="dark"] .theme-toggle-icon-sun { display: none; }',
  ':root[data-theme="dark"] .theme-toggle-icon-moon { display: block; }'
].join('\n');
```

(This drops `Roboto` from the *front* of `--sans` — it was never actually loaded by any `<link>`/`@import`, so on almost every desktop browser it silently fell through to `-apple-system`/`"Segoe UI"` anyway; keeping it further down the stack preserves that fallback for the rare system that does have it installed, with no CDN added. `--mono` is unchanged — it was already system-only.)

- [ ] **Step 4: Rename the three chart color-scale references in `CHART_CLIENT_JS`**

At `src/publish.js:1294` and `src/publish.js:1381`, change:

```javascript
'  var color = d3.scaleOrdinal().range(["var(--teal)", "var(--coral)", "var(--ink-soft)", "var(--teal-soft)"]);',
```

to:

```javascript
'  var color = d3.scaleOrdinal().range(["var(--accent)", "var(--bad)", "var(--ink-soft)", "var(--accent-soft)"]);',
```

(both lines identically). At `src/publish.js:1365`, change:

```javascript
'  svg.append("path").datum(chart.data).attr("class", "chart-bar").style("fill", "none").style("stroke", "var(--teal)").attr("stroke-width", 2).attr("d", line);',
```

to:

```javascript
'  svg.append("path").datum(chart.data).attr("class", "chart-bar").style("fill", "none").style("stroke", "var(--accent)").attr("stroke-width", 2).attr("d", line);',
```

- [ ] **Step 5: Rebuild and run the full suite**

```bash
./build.sh && node test/run.js
```

Expected: `... passed, 0 failed.` — both tests touched in Step 2 pass again, and nothing else regresses (`grep -n -- "--teal\|--coral\|#1A73E8\|#202124" src.js` should now print nothing).

- [ ] **Step 6: Commit**

```bash
git add src/publish.js test/publish.test.js
git commit -m "feat: replace publish report's Google-Material palette with new design tokens

Renames --teal/--teal-soft/--coral to --accent/--accent-soft/--bad and
adds --good/--warn (KPI/metric-card deltas) and --move/--model/--publish
(docs per-kind coloring, added ahead of Task 8's actual use) to
REPORT_CSS/DARK_TOKENS_CSS. --sans drops Roboto from the front of the
stack (never actually loaded - no CDN, no behavior change) per the
pipeline-canvas-redesign spec's decision against adding a font CDN.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Extract `sortableValue` into a real, reusable top-level function

**Files:**
- Modify: `src/publish.js:514` (insert after `formatValue`), `src/publish.js` (inside `TABLE_CLIENT_JS`, currently lines 1089-1093)

**Interfaces:**
- Produces: `sortableValue(cell, format)` — a real top-level function (previously only existed as hand-written JS text inside `TABLE_CLIENT_JS`). Task 6 reuses it (via `.toString()`) to recover a numeric value from an aggregated table's already-formatted cell for a metric card's headline number.

This is a pure refactor — no behavior change. It's a prerequisite for Task 6, which needs the exact same "strip a formatted cell back to a comparable number" logic and shouldn't duplicate it a second time (this codebase already avoids that duplication everywhere else it applies — see `src/publish.md`'s notes on `FILTER_REUSED_FUNCTIONS_JS`/`DETAIL_REUSED_FUNCTIONS_JS`).

- [ ] **Step 1: Confirm the baseline is green**

```bash
node test/run.js
```

Expected: `... passed, 0 failed.` (in particular `testPublishTableClientJsSortsCurrencyColumnNumerically`, which actually executes the generated table script through a fake-DOM harness — see `test/publish.test.js`'s `runTableClientEngine` — this is the regression guard for this task, not a new test.)

- [ ] **Step 2: Add `sortableValue` as a real top-level function**

In `src/publish.js`, right after `formatValue` (after line 514, before `buildRawTablePayload`), add:

```javascript
// Extracted so TABLE_CLIENT_JS's inline script and, from Task 6 on, the
// board's metric-card headline computation can both reuse the exact
// same "recover a number from an already-formatted cell" logic via
// .toString() (see FILTER_REUSED_FUNCTIONS_JS's own reuse pattern) -
// previously this only existed as hand-written text inside
// TABLE_CLIENT_JS's own array, unreachable from anywhere else.
function sortableValue(cell, format) {
  if (format === 'string') {
    return String(cell).toLowerCase();
  }
  var num = Number(String(cell).replace(/[^0-9.-]/g, ''));
  return isNaN(num) ? String(cell).toLowerCase() : num;
}
```

- [ ] **Step 3: Reuse it inside `TABLE_CLIENT_JS` instead of the hand-written copy**

In `src/publish.js`'s `TABLE_CLIENT_JS` array, delete these 5 lines (currently 1089-1093):

```javascript
  'function sortableValue(cell, format) {',
  '  if (format === "string") { return String(cell).toLowerCase(); }',
  '  var num = Number(String(cell).replace(/[^0-9.-]/g, ""));',
  '  return isNaN(num) ? String(cell).toLowerCase() : num;',
  '}',
```

and replace them with one line:

```javascript
  sortableValue.toString(),
```

(Leave the comment immediately above this spot, currently describing why sorting is numeric-aware, in place — it still applies.)

- [ ] **Step 4: Rebuild and run the full suite**

```bash
./build.sh && node test/run.js
```

Expected: `... passed, 0 failed.` — identical result to Step 1. `sortableValue.toString()` produces the same executable behavior as the hand-written lines (a named function declaration's `.toString()` is valid top-level source on its own, same precedent `FILTER_REUSED_FUNCTIONS_JS` already relies on).

- [ ] **Step 5: Commit**

```bash
git add src/publish.js
git commit -m "refactor: promote sortableValue to a real top-level function

Prerequisite for Task 6's metric-card headline computation, which needs
the same 'recover a number from an already-formatted cell' logic
TABLE_CLIENT_JS's column sort already has - reused via .toString()
instead of duplicated a second time.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `computeBoardPositions` — pure, direction-aware position math

**Files:**
- Modify: `src/publish.js` (add new function near `BOARD_H_GAP`/`BOARD_V_GAP`, currently around line 758)
- Modify: `build.sh:91` (expose it through `__test`)
- Create: `test/board-layout.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `computeBoardPositions(treeNodes, direction, boxWidth, boxHeight)` → `{ positions: { [id]: { left, top } }, bounds: { width, height }, anchor: { from, to } }`. `treeNodes` is `[{ id, x, y }]` — the shape `d3.tree()`'s `root.descendants()` already produces (`x` = sibling-spread offset, `y` = depth offset), for the *real* nodes only (the caller filters out the synthetic `__board_root__`, exactly as today's code already does). `direction` is one of `'top-bottom'` (default), `'bottom-top'`, `'left-right'`, `'right-left'`. `anchor.from`/`anchor.to` name which side of a parent/child box an edge should connect (`'top'`/`'right'`/`'bottom'`/`'left'`) — Task 4 consumes this to draw edges. Task 4 also owns calling `d3.tree().nodeSize(...)` with the box dimensions in the right order for the chosen direction *before* calling this function — `computeBoardPositions` only remaps already-computed `x`/`y` into CSS coordinates, it never touches `d3` itself (kept D3-free specifically so it stays Node-testable, unlike the tree-building step around it).

- [ ] **Step 1: Write the failing tests**

Create `test/board-layout.test.js`:

```javascript
// test/board-layout.test.js
var assert = require('assert');
var harness = require('./harness');

function positionsFor(direction) {
  var ctx = harness.loadContext([]);
  var treeNodes = [
    { id: 'a', x: 0, y: 100 },
    { id: 'b', x: 150, y: 100 },
    { id: 'c', x: 75, y: 200 }
  ];
  return ctx.NotSoBigData.__test.computeBoardPositions(treeNodes, direction, 220, 140);
}

function testComputeBoardPositionsTopBottomMatchesTodaysDefaultOrientation() {
  var result = positionsFor('top-bottom');
  assert.deepStrictEqual(result.positions, {
    a: { left: 0, top: 100 },
    b: { left: 150, top: 100 },
    c: { left: 75, top: 200 }
  });
  assert.deepStrictEqual(result.bounds, { width: 370, height: 340 });
  assert.deepStrictEqual(result.anchor, { from: 'bottom', to: 'top' });
}

function testComputeBoardPositionsBottomTopReversesDepthOnly() {
  var result = positionsFor('bottom-top');
  assert.deepStrictEqual(result.positions, {
    a: { left: 0, top: 100 },
    b: { left: 150, top: 100 },
    c: { left: 75, top: 0 }
  });
  assert.deepStrictEqual(result.bounds, { width: 370, height: 240 });
  assert.deepStrictEqual(result.anchor, { from: 'top', to: 'bottom' });
}

function testComputeBoardPositionsLeftRightSwapsSpreadAndDepthOntoTopAndLeft() {
  var result = positionsFor('left-right');
  assert.deepStrictEqual(result.positions, {
    a: { left: 100, top: 0 },
    b: { left: 100, top: 150 },
    c: { left: 200, top: 75 }
  });
  assert.deepStrictEqual(result.bounds, { width: 420, height: 290 });
  assert.deepStrictEqual(result.anchor, { from: 'right', to: 'left' });
}

function testComputeBoardPositionsRightLeftSwapsAndReverses() {
  var result = positionsFor('right-left');
  assert.deepStrictEqual(result.positions, {
    a: { left: 100, top: 0 },
    b: { left: 100, top: 150 },
    c: { left: 0, top: 75 }
  });
  assert.deepStrictEqual(result.bounds, { width: 320, height: 290 });
  assert.deepStrictEqual(result.anchor, { from: 'left', to: 'right' });
}

module.exports = {
  testComputeBoardPositionsTopBottomMatchesTodaysDefaultOrientation: testComputeBoardPositionsTopBottomMatchesTodaysDefaultOrientation,
  testComputeBoardPositionsBottomTopReversesDepthOnly: testComputeBoardPositionsBottomTopReversesDepthOnly,
  testComputeBoardPositionsLeftRightSwapsSpreadAndDepthOntoTopAndLeft: testComputeBoardPositionsLeftRightSwapsSpreadAndDepthOntoTopAndLeft,
  testComputeBoardPositionsRightLeftSwapsAndReverses: testComputeBoardPositionsRightLeftSwapsAndReverses
};
```

- [ ] **Step 2: Run to verify all four fail**

```bash
node test/run.js
```

Expected: `FAIL  board-layout.test.js - ... - ctx.NotSoBigData.__test.computeBoardPositions is not a function` (×4).

- [ ] **Step 3: Implement `computeBoardPositions`**

In `src/publish.js`, right after `BOARD_V_GAP` (line 758), add:

```javascript
// Pure, D3-free position math for layout: 'board'. d3.stratify()/d3.tree()
// (client-only - see BOARD_LAYOUT_CLIENT_JS, Task 4) produce each real
// node's {id, x, y}: x is always the sibling-spread offset, y is always
// the depth offset, regardless of visual orientation - which is exactly
// why this function can stay D3-free and Node-testable. All this does is
// decide which of x/y becomes CSS left/top for a given `direction`, and
// whether the depth axis runs forward or reversed. The caller (Task 4)
// is responsible for calling d3.tree().nodeSize() with boxWidth/boxHeight
// swapped for the two horizontal directions *before* this ever runs -
// this function only consumes the resulting x/y, it never computes them.
function computeBoardPositions(treeNodes, direction, boxWidth, boxHeight) {
  var isHorizontal = direction === 'left-right' || direction === 'right-left';
  var isReversed = direction === 'bottom-top' || direction === 'right-left';
  var spreadValues = treeNodes.map(function (n) { return n.x; });
  var depthValues = treeNodes.map(function (n) { return n.y; });
  var minSpread = Math.min.apply(null, spreadValues);
  var maxDepth = Math.max.apply(null, depthValues);
  var positions = {};
  treeNodes.forEach(function (n) {
    var spread = n.x - minSpread;
    var depth = isReversed ? (maxDepth - n.y) : n.y;
    positions[n.id] = isHorizontal ? { left: depth, top: spread } : { left: spread, top: depth };
  });
  var maxLeft = 0, maxTop = 0;
  Object.keys(positions).forEach(function (id) {
    maxLeft = Math.max(maxLeft, positions[id].left + boxWidth);
    maxTop = Math.max(maxTop, positions[id].top + boxHeight);
  });
  var anchorByDirection = {
    'top-bottom': { from: 'bottom', to: 'top' },
    'bottom-top': { from: 'top', to: 'bottom' },
    'left-right': { from: 'right', to: 'left' },
    'right-left': { from: 'left', to: 'right' }
  };
  return { positions: positions, bounds: { width: maxLeft, height: maxTop }, anchor: anchorByDirection[direction] };
}
```

- [ ] **Step 4: Expose it through `__test`**

In `build.sh`, change line 91 from:

```bash
    echo "    __test: { buildDocsPayload: buildDocsPayload, discoverNodesForTest: function () { return discoverNodes().nodes; }, renderDocsHtml: renderDocsHtml }"
```

to:

```bash
    echo "    __test: { buildDocsPayload: buildDocsPayload, discoverNodesForTest: function () { return discoverNodes().nodes; }, renderDocsHtml: renderDocsHtml, computeBoardPositions: computeBoardPositions }"
```

- [ ] **Step 5: Rebuild and run to verify all four pass**

```bash
./build.sh && node test/run.js
```

Expected: `... passed, 0 failed.`

- [ ] **Step 6: Commit**

```bash
git add src/publish.js build.sh test/board-layout.test.js
git commit -m "feat: add computeBoardPositions, pure direction-aware board layout math

D3-free by design so it's Node-testable: takes the {id,x,y}[] shape
d3.tree() already produces and remaps it to CSS left/top for one of 4
directions (top-bottom/bottom-top/left-right/right-left), plus which
box side an edge should anchor to. Task 4 wires the actual
d3.stratify()/d3.tree() call and DOM writes around this.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Client-side board module — direction, drag, persistence, hover

**Files:**
- Modify: `src/publish.js:1439-1492` (replace `BOARD_LAYOUT_CLIENT_JS` entirely)
- Modify: `src/publish.js` (`BOARD_CSS`, currently lines 834-842 — add drag/hover/toolbar/reset styles)
- Modify: `src/publish.js:1604-1619` (`renderBoardCanvas` — add the toolbar's HTML)
- Modify: `test/publish.test.js:2107-2116` (`testPublishBoardEmitsBoardNodesGlobalAndKeepsRelatesToEdgesByDefault`)

**Interfaces:**
- Consumes: `computeBoardPositions` (Task 3, reused via `.toString()`).
- Produces: the rewritten `BOARD_LAYOUT_CLIENT_JS` (still the one `<script>` chunk `renderReportHtml` and `docs.js`'s `renderDocsHtml` both include when board mode is on — same reuse contract as today). Exposes a module-level `window.__notsobigBoardApi__` object (`{ redraw, setDirection, resetPositions }`) that Task 8 (docs.js) calls the same way, and that the new toolbar buttons (this task) call directly.

This task's actual drag/hover/persistence *behavior* can't be automated-tested here (no D3, no real DOM/pointer events in the Node harness — the same ceiling `publish.md`'s "Board layout" section already documents for tree geometry). The one thing that IS re-tested is the shape of what gets emitted into the HTML (which globals exist, that the `relatesTo`-fallback for edges is still there) — Step 5 below updates that existing test to match the new code text. Actual dragging/hovering/persisting is a Layer 2 (`notsobigtests`, human-run) checklist item — see Task 10.

- [ ] **Step 1: Read the current test this task will change, to see exactly what it pins today**

```bash
sed -n '2107,2116p' test/publish.test.js
```

(Confirms the three regexes: the `__BOARD_NODES__` assignment line, `var blocks = window.__BOARD_NODES__;`, and the `relatesTo`-fallback edge line — all three live inside `BOARD_LAYOUT_CLIENT_JS`, which this task rewrites, so this test *must* change alongside it, not stay pinned to deleted code.)

- [ ] **Step 2: Rewrite `BOARD_CSS`**

Replace `src/publish.js`'s `BOARD_CSS` array (lines 834-842) with:

```javascript
var BOARD_CSS = [
  '.board-viewport { position: relative; width: 100%; height: 80vh; overflow: hidden; border: 1px solid var(--paper-line); border-radius: var(--radius); cursor: grab; }',
  '.board-viewport.board-panning { cursor: grabbing; }',
  '.board-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }',
  '.board-node { position: absolute; background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); box-shadow: var(--shadow-sm); box-sizing: border-box; cursor: grab; touch-action: none; user-select: none; transition: box-shadow .12s ease, border-color .12s ease, opacity .12s ease; }',
  '.board-node.board-node-dragging { cursor: grabbing; box-shadow: var(--shadow); z-index: 50; }',
  '.board-node.board-node-hi { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow); }',
  '.board-node.board-node-dim { opacity: .35; }',
  '.board-node .chart, .board-node .table-block { border: none; box-shadow: none; margin-top: 0; padding: 0; }',
  '.board-edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }',
  '.board-edge { fill: none; stroke: var(--paper-line); stroke-width: 2; transition: opacity .12s ease, stroke .12s ease, stroke-width .12s ease; }',
  '.board-edge.board-edge-hi { stroke: var(--accent); stroke-width: 2.6; opacity: 1; }',
  '.board-edge.board-edge-dim { opacity: .15; }',
  '.board-toolbar { position: absolute; right: 14px; bottom: 14px; z-index: 60; display: flex; gap: 2px; background: var(--surface); border: 1px solid var(--paper-line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 4px; }',
  '.board-toolbar button { width: 28px; height: 28px; border: none; background: none; border-radius: 6px; cursor: pointer; color: var(--ink-soft); font-size: 13px; }',
  '.board-toolbar button:hover { background: var(--paper); color: var(--ink); }',
  '.board-toolbar .board-toolbar-divider { width: 1px; background: var(--paper-line); margin: 4px 2px; }'
].join('\n');
```

- [ ] **Step 3: Add the toolbar markup to `renderBoardCanvas`**

In `src/publish.js`, change `renderBoardCanvas` (lines 1604-1619) from:

```javascript
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

to:

```javascript
function renderBoardCanvas(config, chartSectionsList, tableSectionsList) {
  var charts = config.charts || [];
  var tables = config.tables || [];
  var sectionById = emptyMap();
  charts.forEach(function (chart, index) { sectionById[chart.id] = chartSectionsList[index]; });
  tables.forEach(function (table, index) { sectionById[table.id] = tableSectionsList[index]; });

  var nodesHtml = charts.concat(tables).map(function (block) {
    return '<div class="board-node" data-block-id="' + escapeHtml(block.id) + '">' + sectionById[block.id] + '</div>';
  }).join('');

  var toolbarHtml = '<div class="board-toolbar">'
    + '<button type="button" data-board-action="direction" title="Change layout direction">&#8635;</button>'
    + '<button type="button" data-board-action="reset" title="Reset to auto layout">&#8634;</button>'
    + '<div class="board-toolbar-divider"></div>'
    + '<button type="button" data-board-action="fit" title="Fit to screen">&#10021;</button>'
    + '</div>';

  return '<div class="board-viewport"><div class="board-canvas" id="board-canvas">'
    + '<svg class="board-edges" id="board-edges"></svg>'
    + nodesHtml
    + '</div>' + toolbarHtml + '</div>';
}
```

- [ ] **Step 4: Rewrite `BOARD_LAYOUT_CLIENT_JS`**

Replace `src/publish.js`'s `BOARD_LAYOUT_CLIENT_JS` array (lines 1439-1492) with:

```javascript
// Direction-aware, draggable, hover-highlighting board layout. Reuses
// computeBoardPositions (Task 3) via .toString() for the pure axis math;
// everything else here - d3.stratify()/d3.tree() itself, drag, hover,
// localStorage persistence, the toolbar - needs a real DOM/D3 and can't
// run in the Node test harness (same ceiling publish.md's "Board layout"
// section already documents for tree geometry in general). Exposes
// window.__notsobigBoardApi__ so docs.js's own sidebar (Task 8) can call
// setHighlight/resetPositions the same way this module's own toolbar does.
var BOARD_LAYOUT_CLIENT_JS = [
  computeBoardPositions.toString(),
  'document.addEventListener("DOMContentLoaded", function () {',
  '  var blocks = window.__BOARD_NODES__;',
  '  var rootId = "__board_root__";',
  '  var storageKey = "notsobigdata-board:" + location.pathname;',
  '  var direction = "top-bottom";',
  '  try {',
  '    var storedDirection = localStorage.getItem(storageKey + ":direction");',
  '    if (storedDirection) { direction = storedDirection; }',
  '  } catch (e) {}',
  '  var directions = ["top-bottom", "right-left", "bottom-top", "left-right"];',
  '  var overrides = {};',
  '  try {',
  '    var stored = localStorage.getItem(storageKey + ":positions");',
  '    if (stored) { overrides = JSON.parse(stored); }',
  '  } catch (e) {}',
  '  function persistPositions() {',
  '    try { localStorage.setItem(storageKey + ":positions", JSON.stringify(overrides)); } catch (e) {}',
  '  }',
  '  function persistDirection() {',
  '    try { localStorage.setItem(storageKey + ":direction", direction); } catch (e) {}',
  '  }',
  '  var edges = window.__BOARD_EDGES__ || blocks.filter(function (b) { return b.relatesTo; }).map(function (b) { return { from: b.relatesTo, to: b.id }; });',
  '  var svg = document.getElementById("board-edges");',
  '  var canvas = document.getElementById("board-canvas");',
  '  function nodeEl(id) { return document.querySelector("[data-block-id=\\"" + id + "\\"]"); }',
  '  function layout() {',
  '    var nodesData = blocks.map(function (b) { return { id: b.id, relatesTo: b.relatesTo }; });',
  '    nodesData.push({ id: rootId, relatesTo: null });',
  '    nodesData.forEach(function (n) { if (n.id !== rootId && !n.relatesTo) { n.relatesTo = rootId; } });',
  '    var stratify = d3.stratify().id(function (n) { return n.id; }).parentId(function (n) { return n.relatesTo; });',
  '    var root = stratify(nodesData);',
  '    var isHorizontal = direction === "left-right" || direction === "right-left";',
  '    var spreadSize = ' + (BOARD_BOX_WIDTH + BOARD_H_GAP) + ';',
  '    var depthSize = ' + (BOARD_BOX_HEIGHT + BOARD_V_GAP) + ';',
  '    var treeLayout = d3.tree().nodeSize(isHorizontal ? [' + (BOARD_BOX_HEIGHT + BOARD_V_GAP) + ', ' + (BOARD_BOX_WIDTH + BOARD_H_GAP) + '] : [spreadSize, depthSize]);',
  '    treeLayout(root);',
  '    var realNodes = root.descendants().filter(function (n) { return n.id !== rootId; });',
  '    if (!realNodes.length) { return; }',
  '    var computed = computeBoardPositions(realNodes, direction, ' + BOARD_BOX_WIDTH + ', ' + BOARD_BOX_HEIGHT + ');',
  '    realNodes.forEach(function (n) {',
  '      var pos = overrides[n.id] || computed.positions[n.id];',
  '      var el = nodeEl(n.id);',
  '      if (el) { el.style.left = pos.left + "px"; el.style.top = pos.top + "px"; }',
  '    });',
  '    var maxLeft = 0, maxTop = 0;',
  '    realNodes.forEach(function (n) {',
  '      var pos = overrides[n.id] || computed.positions[n.id];',
  '      maxLeft = Math.max(maxLeft, pos.left + ' + BOARD_BOX_WIDTH + ');',
  '      maxTop = Math.max(maxTop, pos.top + ' + BOARD_BOX_HEIGHT + ');',
  '    });',
  '    svg.setAttribute("width", maxLeft);',
  '    svg.setAttribute("height", maxTop);',
  '    window.__BOARD_BOUNDS__ = { minX: 0, minY: 0, maxX: maxLeft, maxY: maxTop };',
  '    window.__notsobigBoardAnchor__ = computed.anchor;',
  '    redrawEdges();',
  '  }',
  '  function anchorPoint(el, side) {',
  '    if (side === "top") { return { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop }; }',
  '    if (side === "bottom") { return { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight }; }',
  '    if (side === "left") { return { x: el.offsetLeft, y: el.offsetTop + el.offsetHeight / 2 }; }',
  '    return { x: el.offsetLeft + el.offsetWidth, y: el.offsetTop + el.offsetHeight / 2 };',
  '  }',
  '  function redrawEdges() {',
  '    var anchor = window.__notsobigBoardAnchor__ || { from: "bottom", to: "top" };',
  '    var edgePaths = edges.map(function (e) {',
  '      var fromEl = nodeEl(e.from), toEl = nodeEl(e.to);',
  '      if (!fromEl || !toEl) { return ""; }',
  '      var p1 = anchorPoint(fromEl, anchor.from), p2 = anchorPoint(toEl, anchor.to);',
  '      return "<path class=\\"board-edge\\" data-from=\\"" + e.from + "\\" data-to=\\"" + e.to + "\\" d=\\"M" + p1.x + " " + p1.y + " L" + p2.x + " " + p2.y + "\\"></path>";',
  '    });',
  '    svg.innerHTML = edgePaths.join("");',
  '  }',
  '  function neighborsOf(id) {',
  '    var out = edges.filter(function (e) { return e.from === id; }).map(function (e) { return e.to; });',
  '    var into = edges.filter(function (e) { return e.to === id; }).map(function (e) { return e.from; });',
  '    return out.concat(into);',
  '  }',
  '  function setHighlight(id) {',
  '    var related = id ? [id].concat(neighborsOf(id)) : null;',
  '    blocks.forEach(function (b) {',
  '      var el = nodeEl(b.id);',
  '      if (!el) { return; }',
  '      var keep = !related || related.indexOf(b.id) !== -1;',
  '      el.classList.toggle("board-node-dim", !!related && !keep);',
  '      el.classList.toggle("board-node-hi", !!related && keep && b.id !== id);',
  '    });',
  '    Array.prototype.forEach.call(svg.querySelectorAll(".board-edge"), function (p) {',
  '      var isRel = !!id && (p.getAttribute("data-from") === id || p.getAttribute("data-to") === id);',
  '      p.classList.toggle("board-edge-hi", isRel);',
  '      p.classList.toggle("board-edge-dim", !!id && !isRel);',
  '    });',
  '  }',
  '  blocks.forEach(function (b) {',
  '    var el = nodeEl(b.id);',
  '    if (!el) { return; }',
  '    var startX, startY, origLeft, origTop, dragging = false, moved = false;',
  '    el.addEventListener("pointerdown", function (event) {',
  '      dragging = true; moved = false;',
  '      startX = event.clientX; startY = event.clientY;',
  '      origLeft = el.offsetLeft; origTop = el.offsetTop;',
  '      el.setPointerCapture(event.pointerId);',
  '      el.classList.add("board-node-dragging");',
  '    });',
  '    el.addEventListener("pointermove", function (event) {',
  '      if (!dragging) { return; }',
  '      var dx = event.clientX - startX, dy = event.clientY - startY;',
  '      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { moved = true; }',
  '      if (!moved) { return; }',
  '      var left = origLeft + dx, top = origTop + dy;',
  '      el.style.left = left + "px"; el.style.top = top + "px";',
  '      overrides[b.id] = { left: left, top: top };',
  '      redrawEdges();',
  '    });',
  '    function endDrag() {',
  '      if (!dragging) { return; }',
  '      dragging = false;',
  '      el.classList.remove("board-node-dragging");',
  '      if (moved) { persistPositions(); }',
  '    }',
  '    el.addEventListener("pointerup", endDrag);',
  '    el.addEventListener("pointercancel", endDrag);',
  '    el.addEventListener("mouseenter", function () { if (!dragging) { setHighlight(b.id); } });',
  '    el.addEventListener("mouseleave", function () { if (!dragging) { setHighlight(null); } });',
  '  });',
  '  var toolbar = document.querySelector(".board-toolbar");',
  '  if (toolbar) {',
  '    toolbar.addEventListener("click", function (event) {',
  '      var action = event.target.getAttribute("data-board-action");',
  '      if (action === "direction") {',
  '        direction = directions[(directions.indexOf(direction) + 1) % directions.length];',
  '        persistDirection();',
  '        layout();',
  '      } else if (action === "reset") {',
  '        overrides = {};',
  '        try { localStorage.removeItem(storageKey + ":positions"); } catch (e) {}',
  '        layout();',
  '      } else if (action === "fit" && window.__notsobigFitBoard__) {',
  '        window.__notsobigFitBoard__();',
  '      }',
  '    });',
  '  }',
  '  layout();',
  '  if (window.ResizeObserver) {',
  '    var resizeObserver = new ResizeObserver(redrawEdges);',
  '    blocks.forEach(function (b) { var el = nodeEl(b.id); if (el) { resizeObserver.observe(el); } });',
  '  }',
  '  window.__notsobigBoardApi__ = { redraw: redrawEdges, setHighlight: setHighlight, resetPositions: function () { overrides = {}; layout(); } };',
  '});'
].join('\n');
```

(`BOARD_CLIENT_JS`, the pan/zoom module right after this one, is unchanged — its `d3.zoom().filter(...)` already excludes any `mousedown`/`touchstart` whose target is inside a `.board-node` from starting a canvas pan, fixed once already in commit `3c0ab22` for the node's own scroll/resize interactions. Per-node drag is the same category of interaction and that filter already reserves it, so no new pan-conflict handling is needed here. Wire the toolbar's "fit" button to the existing auto-fit logic by having `BOARD_CLIENT_JS` assign its already-computed `fit` transform to `window.__notsobigFitBoard__` — add one line right after `BOARD_CLIENT_JS`'s existing `d3.select(viewport).call(zoom.transform, fit);` call: `'  window.__notsobigFitBoard__ = function () { d3.select(viewport).call(zoom.transform, fit); };',`.)

- [ ] **Step 5: Update the existing regression test to match the new code**

Replace `testPublishBoardEmitsBoardNodesGlobalAndKeepsRelatesToEdgesByDefault` (`test/publish.test.js:2107-2116`) with:

```javascript
function testPublishBoardEmitsBoardNodesGlobalAndKeepsRelatesToEdgesByDefault() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed board run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/window\.__BOARD_NODES__ = window\.__PUBLISH_PAYLOAD__\.charts\.concat\(window\.__PUBLISH_PAYLOAD__\.tables\)\.map\(/.test(html), 'expected the __BOARD_NODES__ global to be derived from the existing payload, got: ' + html);
  assert.ok(/var blocks = window\.__BOARD_NODES__;/.test(html), 'expected the layout script to read window.__BOARD_NODES__, got: ' + html);
  assert.ok(/var edges = window\.__BOARD_EDGES__ \|\| blocks\.filter\(function \(b\) \{ return b\.relatesTo; \}\)/.test(html), 'expected the relatesTo-derived edge fallback to remain byte-identical, got: ' + html);
  assert.ok(/function computeBoardPositions\(treeNodes, direction, boxWidth, boxHeight\)/.test(html), 'expected computeBoardPositions to be reused verbatim in the emitted script, got: ' + html);
  assert.ok(html.indexOf('data-board-action="direction"') !== -1, 'expected the direction toolbar button, got: ' + html);
}
```

(No change needed to the `module.exports` entry — the function name is unchanged.)

- [ ] **Step 6: Rebuild and run the full suite**

```bash
./build.sh && node test/run.js
```

Expected: `... passed, 0 failed.`

- [ ] **Step 7: Commit**

```bash
git add src/publish.js test/publish.test.js
git commit -m "feat: rewrite board layout as direction-aware, draggable, hover-highlighting

Replaces the one-shot d3.tree() pass with a module that: recomputes on
a direction toggle (top-bottom/bottom-top/left-right/right-left, via
Task 3's computeBoardPositions), persists dragged node positions and
the chosen direction per file in localStorage, offers a Reset button,
and highlights a node's direct upstream/downstream relations on hover.
Exposes window.__notsobigBoardApi__ for docs.js's sidebar (Task 8) to
drive the same highlight from outside the canvas.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Shrink board nodes to card size; tag tables with their `mode`

**Files:**
- Modify: `src/publish.js:755-756` (`BOARD_BOX_WIDTH`/`BOARD_BOX_HEIGHT`)
- Modify: `src/publish.js:726-732` (`buildReportPayload`'s table loop)
- Modify: `test/publish.test.js` (any test asserting the old `520`/`340` box size or `resize: both`)

**Interfaces:**
- Produces: `BOARD_BOX_WIDTH = 240`, `BOARD_BOX_HEIGHT = 160` (compact card size, not "hold a whole report section"); every table entry in `buildReportPayload`'s output now carries `.mode` (`'raw'` or `'aggregated'`) — Task 6's `computeMetricCardData` needs this to know whether to compute a headline from a metric column or just count rows, since the built table payload shape is otherwise identical for both modes.

- [ ] **Step 1: Check whether any existing test pins the current box constants**

```bash
grep -n "520\|340\|resize: both" test/publish.test.js src/publish.js
```

If a test asserts on `520`/`340`/`resize: both` literally, note its name now — Step 4 updates it. (Based on the file as read while writing this plan, no such test exists — `BOARD_BOX_WIDTH`/`BOARD_BOX_HEIGHT` are only consumed internally by `BOARD_CSS`'s `.board-node` rule, which Task 4 already rewrote without a literal `resize: both`/dimension check anywhere in the test suite. If Step 1 finds one anyway, treat this as the authoritative instruction: update it to assert `240`/`160` instead.)

- [ ] **Step 2: Shrink the box constants**

In `src/publish.js`, change lines 755-756 from:

```javascript
var BOARD_BOX_WIDTH = 520;
var BOARD_BOX_HEIGHT = 340;
```

to:

```javascript
var BOARD_BOX_WIDTH = 240;
var BOARD_BOX_HEIGHT = 160;
```

- [ ] **Step 3: Tag every built table with its `mode`**

In `src/publish.js`'s `buildReportPayload` (around line 726-732), change:

```javascript
  var tables = (config.tables || []).map(function (table) {
    var tableRows = rowsForBlock(table, rows, blockRowsByRef);
    var built = table.mode === 'raw' ? buildRawTablePayload(table, tableRows) : buildAggregatedTablePayload(table, tableRows);
    built = withDetail(built, table, tableRows);
    built.relatesTo = table.relatesTo || null;
    return built;
  });
```

to:

```javascript
  var tables = (config.tables || []).map(function (table) {
    var tableRows = rowsForBlock(table, rows, blockRowsByRef);
    var built = table.mode === 'raw' ? buildRawTablePayload(table, tableRows) : buildAggregatedTablePayload(table, tableRows);
    built = withDetail(built, table, tableRows);
    built.relatesTo = table.relatesTo || null;
    built.mode = table.mode === 'raw' ? 'raw' : 'aggregated';
    return built;
  });
```

(`buildRawTablePayload`/`buildAggregatedTablePayload` themselves stay untouched — this one extra field is attached by the caller, same posture `relatesTo` right above it already has.)

- [ ] **Step 4: Rebuild and run the full suite**

```bash
./build.sh && node test/run.js
```

Expected: `... passed, 0 failed.` (a new `.mode` field on the embedded `window.__PUBLISH_PAYLOAD__.tables[i]` object is additive — nothing existing reads or asserts its absence).

- [ ] **Step 5: Commit**

```bash
git add src/publish.js
git commit -m "feat: shrink board node boxes to card size and tag tables with their mode

BOARD_BOX_WIDTH/HEIGHT go from 520x340 (sized to hold an entire report
section) to 240x160 (a compact metric card, Task 6). buildReportPayload
now attaches mode ('raw'/'aggregated') to every built table entry -
needed by Task 6's computeMetricCardData, which can't otherwise tell the
two apart from the built {columns,rows} shape alone.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `computeMetricCardData` — pure headline + mini-chart data

**Files:**
- Modify: `src/publish.js` (add new function near `buildChartPayload`, after line 627)
- Modify: `build.sh:91`
- Create: `test/metric-card.test.js`

**Interfaces:**
- Consumes: `sortableValue` (Task 2), a chart's `buildChartPayload` output shape, a table's `buildRawTablePayload`/`buildAggregatedTablePayload` (+`.mode`, Task 5) output shape.
- Produces: `computeMetricCardData(blockType, block)` → `{ headline: number, points: number[] }`. `blockType` is `'chart'` or `'table'`. `points` is always a plain array of numbers in display order — the *drawing* of a sparkline/mini-bars/mini-ring from `points` is Task 7's job (that part touches the DOM/SVG and isn't pure), this function only decides the numbers.

- [ ] **Step 1: Write the failing tests**

Create `test/metric-card.test.js`:

```javascript
// test/metric-card.test.js
var assert = require('assert');
var harness = require('./harness');

function api() {
  return harness.loadContext([]).NotSoBigData.__test;
}

function testMetricCardChartWithoutSeriesSumsGroupTotals() {
  var chart = { id: 'by_category', type: 'bar', data: [
    { groupValue: 'A', total: 40 },
    { groupValue: 'B', total: 60 }
  ] };
  var result = api().computeMetricCardData('chart', chart);
  assert.strictEqual(result.headline, 100);
  assert.deepStrictEqual(result.points, [40, 60]);
}

function testMetricCardChartWithSeriesSumsAcrossSeriesKeys() {
  var chart = { id: 'by_cat_channel', type: 'bar', series: 'channel', seriesKeys: ['online', 'retail'], data: [
    { groupValue: 'A', values: { online: 30, retail: 20 } },
    { groupValue: 'B', values: { online: 10, retail: 40 } }
  ] };
  var result = api().computeMetricCardData('chart', chart);
  assert.strictEqual(result.headline, 100);
  assert.deepStrictEqual(result.points, [50, 50]);
}

function testMetricCardAggregatedTableSumsFirstMetricColumn() {
  var table = { id: 'by_category_table', mode: 'aggregated', columns: [
    { key: 'category_name', label: 'category_name', format: 'string' },
    { key: 'Revenue', label: 'Revenue', format: 'currency' },
    { key: 'Orders', label: 'Orders', format: 'integer' }
  ], rows: [
    ['A', '$40.00', '4'],
    ['B', '$60.00', '6']
  ] };
  var result = api().computeMetricCardData('table', table);
  assert.strictEqual(result.headline, 100);
  assert.deepStrictEqual(result.points, [40, 60]);
}

function testMetricCardRawTableCountsRows() {
  var table = { id: 'recent_orders', mode: 'raw', columns: [{ key: 'order_id', label: 'order_id', format: 'string' }], rows: [
    ['ORD-1'], ['ORD-2'], ['ORD-3']
  ] };
  var result = api().computeMetricCardData('table', table);
  assert.strictEqual(result.headline, 3);
  assert.deepStrictEqual(result.points, []);
}

module.exports = {
  testMetricCardChartWithoutSeriesSumsGroupTotals: testMetricCardChartWithoutSeriesSumsGroupTotals,
  testMetricCardChartWithSeriesSumsAcrossSeriesKeys: testMetricCardChartWithSeriesSumsAcrossSeriesKeys,
  testMetricCardAggregatedTableSumsFirstMetricColumn: testMetricCardAggregatedTableSumsFirstMetricColumn,
  testMetricCardRawTableCountsRows: testMetricCardRawTableCountsRows
};
```

- [ ] **Step 2: Run to verify all four fail**

```bash
node test/run.js
```

Expected: `FAIL  metric-card.test.js - ... - ctx.NotSoBigData.__test.computeMetricCardData is not a function` (×4).

- [ ] **Step 3: Implement `computeMetricCardData`**

In `src/publish.js`, right after `buildChartPayload` (after line 627), add:

```javascript
// Pure summary of an already-built chart/table payload entry (the exact
// object buildChartPayload/buildRawTablePayload/buildAggregatedTablePayload
// already produced - this never re-touches raw rows) into what a board
// metric card (Task 7) shows: one headline number and an ordered list of
// points for its mini-chart. Kept separate from the drawing itself (which
// needs an SVG/DOM and isn't pure) so this stays Node-testable.
function computeMetricCardData(blockType, block) {
  if (blockType === 'chart') {
    if (block.series) {
      var points = block.data.map(function (entry) {
        return block.seriesKeys.reduce(function (sum, key) { return sum + (entry.values[key] || 0); }, 0);
      });
      return { headline: points.reduce(function (sum, v) { return sum + v; }, 0), points: points };
    }
    var totals = block.data.map(function (entry) { return entry.total; });
    return { headline: totals.reduce(function (sum, v) { return sum + v; }, 0), points: totals };
  }
  if (block.mode === 'raw') {
    return { headline: block.rows.length, points: [] };
  }
  var format = block.columns[1] ? block.columns[1].format : 'string';
  var values = block.rows.map(function (row) { return sortableValue(row[1], format); });
  return { headline: values.reduce(function (sum, v) { return sum + (typeof v === 'number' ? v : 0); }, 0), points: values };
}
```

- [ ] **Step 4: Expose it through `__test`**

In `build.sh`, change line 91 (already touched in Task 3) from:

```bash
    echo "    __test: { buildDocsPayload: buildDocsPayload, discoverNodesForTest: function () { return discoverNodes().nodes; }, renderDocsHtml: renderDocsHtml, computeBoardPositions: computeBoardPositions }"
```

to:

```bash
    echo "    __test: { buildDocsPayload: buildDocsPayload, discoverNodesForTest: function () { return discoverNodes().nodes; }, renderDocsHtml: renderDocsHtml, computeBoardPositions: computeBoardPositions, computeMetricCardData: computeMetricCardData }"
```

- [ ] **Step 5: Rebuild and run to verify all four pass**

```bash
./build.sh && node test/run.js
```

Expected: `... passed, 0 failed.`

- [ ] **Step 6: Commit**

```bash
git add src/publish.js build.sh test/metric-card.test.js
git commit -m "feat: add computeMetricCardData for board metric-card headlines

Pure function over an already-built chart/table payload entry (never
re-touches raw rows): sums a chart's group totals (or, with series[],
sums across every seriesKey per group), sums an aggregated table's first
metric column (recovered via Task 2's sortableValue), or counts rows for
a mode:'raw' table, which has no single metric to summarize.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Metric-card rendering + click-to-expand overlay

**Files:**
- Modify: `src/publish.js:1604-1619` (`renderBoardCanvas`, again — swap inline section for a compact card + hidden full section)
- Modify: `src/publish.js` (add `MINI_CHART_CLIENT_JS`, `BOARD_EXPAND_CLIENT_JS`; extend `BOARD_CSS` with card/hidden-section/overlay rules)
- Modify: `src/publish.js:1647-1651` (`renderReportHtml`'s `isBoardLayout` branch — always ship the new client JS)
- Test: `test/publish.test.js` (new assertions on the emitted markup/script — this task's DOM/click behavior itself is Layer 2, same ceiling as Task 4)

**Interfaces:**
- Consumes: `computeMetricCardData` (Task 6, reused via `.toString()`), `DETAIL_CLIENT_JS`'s `openDetailModal`/`closeDetailModal` pair (unchanged, still used by an expanded chart/table's own `detail` drill-down).
- Produces: `openExpandModal(title, contentEl)` — a sibling to `openDetailModal`, takes a DOM node instead of `(columns, rows)`.

- [ ] **Step 1: Extend `BOARD_CSS` with card/overlay styles**

Append these lines to `src/publish.js`'s `BOARD_CSS` array (from Task 4), just before the closing `].join('\n');`:

```javascript
  '.board-metric-card { padding: 11px 13px; height: 100%; box-sizing: border-box; overflow: hidden; }',
  '.board-metric-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-soft); font-weight: 600; }',
  '.board-metric-value { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 18px; font-weight: 600; margin-top: 2px; }',
  '.board-metric-mini { display: block; margin-top: 6px; }',
  '.board-node-full { display: none; }',
  '.board-expand-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; z-index: 1000; }',
  '.board-expand-box { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px; max-width: 90vw; max-height: 85vh; overflow: auto; min-width: 360px; }',
  '.board-expand-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }',
  '.board-expand-header h3 { margin: 0; font-size: 14px; }',
  '.board-expand-close { font-family: var(--mono); font-size: 16px; background: none; border: none; cursor: pointer; }'
```

- [ ] **Step 2: Rewrite `renderBoardCanvas`'s node markup**

Change `renderBoardCanvas` (touched again, after Task 4's edit) from:

```javascript
  var nodesHtml = charts.concat(tables).map(function (block) {
    return '<div class="board-node" data-block-id="' + escapeHtml(block.id) + '">' + sectionById[block.id] + '</div>';
  }).join('');
```

to:

```javascript
  var nodesHtml = charts.concat(tables).map(function (block) {
    var blockType = charts.indexOf(block) !== -1 ? 'chart' : 'table';
    return '<div class="board-node" data-block-id="' + escapeHtml(block.id) + '" data-block-type="' + blockType + '">'
      + '<div class="board-metric-card" data-metric-card="' + escapeHtml(block.id) + '"></div>'
      + '<div class="board-node-full" data-full-section="' + escapeHtml(block.id) + '">' + sectionById[block.id] + '</div>'
      + '</div>';
  }).join('');
```

- [ ] **Step 3: Add `MINI_CHART_CLIENT_JS`**

In `src/publish.js`, right after `BOARD_LAYOUT_CLIENT_JS` (Task 4), add:

```javascript
// Draws every board node's compact metric card from the already-embedded
// payload (window.__PUBLISH_PAYLOAD__) and wires the click-to-expand
// overlay. computeMetricCardData (Task 6) decides the numbers; this only
// draws them (a small hand-rolled SVG sparkline/mini-bars, not a scaled-
// down drawBarChart/drawLineChart/drawPieChart call - those assume a
// full-size container with axes/labels, see the design spec's Task 3
// rationale) and moves a node's hidden .board-node-full section into the
// expand overlay on click. Declares sortableValue.toString() alongside
// computeMetricCardData.toString() - computeMetricCardData's aggregated-
// table branch calls sortableValue, so both must ship together here
// (same "declare what a reused function itself calls, in the same list"
// rule DETAIL_REUSED_FUNCTIONS_JS's own [formatValue, buildRawTablePayload]
// pair already follows, since buildRawTablePayload calls formatValue). A
// report whose tables[] also triggers TABLE_CLIENT_JS ends up with
// sortableValue declared twice (harmless - a plain function declaration
// redeclared in the same non-strict scope is legal and both bodies are
// identical) - accepted here rather than adding another hasX branch to
// dedupe a 5-line function.
var MINI_CHART_CLIENT_JS = [
  sortableValue.toString(),
  computeMetricCardData.toString(),
  'function drawMiniChart(container, points) {',
  '  if (!points.length) { return; }',
  '  var w = 190, h = 40;',
  '  var max = Math.max.apply(null, points), min = Math.min.apply(null, points);',
  '  var span = (max - min) || 1;',
  '  var pts = points.map(function (v, i) {',
  '    var x = points.length > 1 ? (i / (points.length - 1)) * w : w / 2;',
  '    var y = h - ((v - min) / span) * (h - 6) - 3;',
  '    return x.toFixed(1) + "," + y.toFixed(1);',
  '  });',
  '  container.innerHTML = "<svg viewBox=\\"0 0 " + w + " " + h + "\\" preserveAspectRatio=\\"none\\" width=\\"100%\\" height=\\"" + h + "\\"><polyline points=\\"" + pts.join(" ") + "\\" fill=\\"none\\" stroke=\\"var(--accent)\\" stroke-width=\\"1.8\\"></polyline></svg>";',
  '}',
  'function renderMetricCards() {',
  '  var payload = window.__PUBLISH_PAYLOAD__;',
  '  Array.prototype.forEach.call(document.querySelectorAll("[data-metric-card]"), function (card) {',
  '    var id = card.getAttribute("data-metric-card");',
  '    var node = card.closest(".board-node");',
  '    var blockType = node.getAttribute("data-block-type");',
  '    var block = (blockType === "chart" ? payload.charts : payload.tables).filter(function (b) { return b.id === id; })[0];',
  '    if (!block) { return; }',
  '    var metric = computeMetricCardData(blockType, block);',
  '    card.innerHTML = "<div class=\\"board-metric-label\\">" + block.title + "</div><div class=\\"board-metric-value\\"></div><div class=\\"board-metric-mini\\"></div>";',
  '    card.querySelector(".board-metric-value").textContent = metric.headline.toLocaleString("en-US");',
  '    drawMiniChart(card.querySelector(".board-metric-mini"), metric.points);',
  '  });',
  '}',
  'function openExpandModal(title, contentEl) {',
  '  closeExpandModal();',
  '  var backdrop = document.createElement("div");',
  '  backdrop.id = "publish-expand-modal";',
  '  backdrop.className = "board-expand-backdrop";',
  '  backdrop.addEventListener("click", function (event) { if (event.target === backdrop) { closeExpandModal(); } });',
  '  var box = document.createElement("div");',
  '  box.className = "board-expand-box";',
  '  var header = document.createElement("div");',
  '  header.className = "board-expand-header";',
  '  var heading = document.createElement("h3");',
  '  heading.textContent = title;',
  '  var closeBtn = document.createElement("button");',
  '  closeBtn.type = "button";',
  '  closeBtn.className = "board-expand-close";',
  '  closeBtn.textContent = "\\u00d7";',
  '  closeBtn.addEventListener("click", closeExpandModal);',
  '  header.appendChild(heading);',
  '  header.appendChild(closeBtn);',
  '  box.appendChild(header);',
  '  box.setAttribute("data-return-target", contentEl.getAttribute("data-full-section"));',
  '  contentEl.style.display = "block";',
  '  box.appendChild(contentEl);',
  '  backdrop.appendChild(box);',
  '  document.body.appendChild(backdrop);',
  '}',
  'function closeExpandModal() {',
  '  var modal = document.getElementById("publish-expand-modal");',
  '  if (!modal) { return; }',
  '  var box = modal.querySelector(".board-expand-box");',
  '  var id = box.getAttribute("data-return-target");',
  '  var contentEl = box.querySelector("[data-full-section=\\"" + id + "\\"]");',
  '  var originalParent = document.querySelector(".board-node[data-block-id=\\"" + id + "\\"]");',
  '  if (contentEl && originalParent) { contentEl.style.display = "none"; originalParent.appendChild(contentEl); }',
  '  modal.parentNode.removeChild(modal);',
  '}',
  'document.addEventListener("DOMContentLoaded", function () {',
  '  renderMetricCards();',
  '  Array.prototype.forEach.call(document.querySelectorAll(".board-node"), function (node) {',
  '    node.addEventListener("click", function (event) {',
  '      if (event.target.closest(".board-metric-card") === null) { return; }',
  '      var id = node.getAttribute("data-block-id");',
  '      var full = node.querySelector("[data-full-section=\\"" + id + "\\"]");',
  '      if (!full) { return; }',
  '      var titleEl = full.querySelector("h2");',
  '      openExpandModal(titleEl ? titleEl.textContent : id, full);',
  '    });',
  '  });',
  '  document.addEventListener("keydown", function (event) { if (event.key === "Escape") { closeExpandModal(); } });',
  '});'
].join('\n');
```

- [ ] **Step 4: Wire it into `renderReportHtml`**

In `src/publish.js`'s `renderReportHtml`, change the `isBoardLayout` branch (around line 1647-1651) from:

```javascript
  if (isBoardLayout) {
    script += 'window.__BOARD_NODES__ = window.__PUBLISH_PAYLOAD__.charts.concat(window.__PUBLISH_PAYLOAD__.tables).map(function (b) { return { id: b.id, relatesTo: b.relatesTo }; });';
    script += BOARD_LAYOUT_CLIENT_JS;
    script += BOARD_CLIENT_JS;
  }
```

to:

```javascript
  if (isBoardLayout) {
    script += 'window.__BOARD_NODES__ = window.__PUBLISH_PAYLOAD__.charts.concat(window.__PUBLISH_PAYLOAD__.tables).map(function (b) { return { id: b.id, relatesTo: b.relatesTo }; });';
    script += BOARD_LAYOUT_CLIENT_JS;
    script += BOARD_CLIENT_JS;
    script += MINI_CHART_CLIENT_JS;
  }
```

(`openExpandModal`/`closeExpandModal`/`renderMetricCards` — everything `MINI_CHART_CLIENT_JS` itself needs — are self-contained; they never call `openDetailModal`. An *expanded* chart/table's own nested `detail` drill-down still goes through the existing, unchanged `hasDetail`-gated `DETAIL_CLIENT_JS`/`DETAIL_REUSED_FUNCTIONS_JS` further down in `renderReportHtml` — `hasDetail` (`payload.tables.some(t => t.detail) || payload.charts.some(c => c.detail)`) already correctly reflects whether *any* block needs it, board layout or not, so nothing about that gating needs to change here. Forcing it on unconditionally for board mode would double-declare `formatValue`/`buildRawTablePayload` whenever the report also has `filters[]`, since `FILTER_REUSED_FUNCTIONS_JS` already includes both as part of its own ten-function list — leave the existing `if (hasFilters) { ... } else if (hasDetail) { script += DETAIL_REUSED_FUNCTIONS_JS; }` / `if (hasDetail) { script += DETAIL_CLIENT_JS; }` exactly as they are today.)

- [ ] **Step 5: Add regression assertions**

Add to `test/publish.test.js` (new test, following the file's existing style — see `testPublishBoardEmitsBoardNodesGlobalAndKeepsRelatesToEdgesByDefault` right above it for the pattern):

```javascript
function testPublishBoardNodesRenderAsCompactMetricCardsWithHiddenFullSection() {
  var ctx = harness.loadContext([fixture('publish-nodes.js')]);
  var getHtml = shimBigQueryAndDrive(ctx, ['category', 'revenue'], [['A', '10']]);
  var result = ctx.NotSoBigData.cli('run --select boardValidPublish').nodes[0];
  assert.strictEqual(result.status, 'success', 'expected the shimmed board run to succeed, got: ' + result.error);
  var html = getHtml();
  assert.ok(/class="board-metric-card" data-metric-card="/.test(html), 'expected a compact metric card slot per node, got: ' + html);
  assert.ok(/class="board-node-full" data-full-section="/.test(html), 'expected the full chart/table section to still be emitted, hidden, got: ' + html);
  assert.ok(/function computeMetricCardData\(blockType, block\)/.test(html), 'expected computeMetricCardData to be reused verbatim in the emitted script, got: ' + html);
  assert.ok(/function sortableValue\(cell, format\)/.test(html), 'expected sortableValue to be declared alongside computeMetricCardData, which calls it, got: ' + html);
  assert.ok(/function openExpandModal\(title, contentEl\)/.test(html), 'expected the expand overlay function, got: ' + html);
}
```

Register it in `module.exports`: `testPublishBoardNodesRenderAsCompactMetricCardsWithHiddenFullSection: testPublishBoardNodesRenderAsCompactMetricCardsWithHiddenFullSection,`.

- [ ] **Step 6: Rebuild and run the full suite**

```bash
./build.sh && node test/run.js
```

Expected: `... passed, 0 failed.`

- [ ] **Step 7: Commit**

```bash
git add src/publish.js test/publish.test.js
git commit -m "feat: render board nodes as compact metric cards with click-to-expand

Each board node now shows a headline number + mini-chart
(computeMetricCardData, Task 6) instead of the full chart/table inline.
The full section still renders exactly as before, just hidden
(display:none) inside the node - clicking the card moves it into a new
overlay (openExpandModal, a sibling to openDetailModal) and moves it
back on close, so nothing about chart drawing or the existing detail
drill-down needs to change - hasDetail's existing gating for
DETAIL_CLIENT_JS is untouched, since it already covers board mode too.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Docs board — per-kind coloring, sidebar, drawer

**Files:**
- Modify: `src/docs.js` (`DOCS_CSS`, `renderDocsNodeSection`, `renderDocsHtml`)
- Modify: `test/docs.test.js` (existing board-shape assertions + new sidebar/drawer assertions)

**Interfaces:**
- Consumes: `--move`/`--model`/`--publish` tokens (Task 1), `window.__notsobigBoardApi__.setHighlight` (Task 4, for the sidebar-hover-highlights-canvas-node behavior).
- Produces: nothing new consumed elsewhere — this is the last presentation layer.

- [ ] **Step 1: Read the current tests this task will touch**

```bash
grep -n "testDocsHtmlRendersOneBoardNodePerDiscoveredNode\|testDocsHtmlShowsCompiledSqlAndConnectorTypes" -A 12 test/docs.test.js
```

(Confirms today's assertions about one `.board-node` per discovered node and the compiled SQL/connector text appearing *inside* that node — both need updating since Step 3 below moves SQL/connector detail out of the node and into a drawer.)

- [ ] **Step 2: Rewrite `DOCS_CSS` and `renderDocsNodeSection`**

In `src/docs.js`, change `DOCS_CSS` (currently lines 75-77) from:

```javascript
var DOCS_CSS = '.docs-kind-badge { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); border: 1px solid var(--paper-line); border-radius: var(--radius-sm); padding: 1px 6px; margin-left: 6px; }'
  + '.docs-error { color: var(--coral); font-family: var(--mono); font-size: 12px; }'
  + 'pre { white-space: pre-wrap; font-family: var(--mono); font-size: 12px; }';
```

to:

```javascript
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
```

Change `renderDocsNodeSection` (currently):

```javascript
function renderDocsNodeSection(node) {
  return '<div class="board-node" data-block-id="' + escapeHtml(node.name) + '">'
    + '<h2>' + escapeHtml(node.name) + '<span class="docs-kind-badge">' + escapeHtml(node.kind) + '</span></h2>'
    + renderDocsDetailHtml(node.kind, node.detail)
    + '</div>';
}
```

to:

```javascript
function renderDocsNodeSection(node) {
  var kindToken = DOCS_KIND_TOKEN[node.kind] || '--ink-soft';
  return '<div class="board-node" data-block-id="' + escapeHtml(node.name) + '" data-kind="' + escapeHtml(node.kind) + '">'
    + '<div class="board-node-kind-bar" style="background: var(' + kindToken + ')"></div>'
    + '<div class="board-metric-card"><div class="board-metric-label">' + escapeHtml(node.name) + '<span class="docs-kind-badge">' + escapeHtml(node.kind) + '</span></div></div>'
    + '</div>';
}
```

(The compiled SQL/connector detail `renderDocsDetailHtml` used to build no longer renders inline — it moves into the drawer, built client-side from `window.__DOCS_NODES__`, Step 3 below. `renderDocsDetailHtml` itself is untouched; it's simply called from a different place now.)

- [ ] **Step 3: Rewrite `renderDocsHtml`**

Replace `renderDocsHtml` with:

```javascript
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
```

- [ ] **Step 4: Add `DOCS_DRAWER_CLIENT_JS`**

In `src/docs.js`, right before `runDocsCommand`, add:

```javascript
// Sidebar search/click + the detail drawer. window.__notsobigBoardApi__
// (BOARD_LAYOUT_CLIENT_JS, src/publish.js) already exists by the time
// this runs (registered inside the same DOMContentLoaded pass, and this
// script is appended right after it - see renderDocsHtml's script
// assembly), so hovering a sidebar row can reuse its setHighlight exactly
// the way hovering a board node itself already does.
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
  '    node.addEventListener("click", function () { openDrawer(node.getAttribute("data-block-id")); });',
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
```

- [ ] **Step 5: Update the existing docs tests**

Of the four existing board-related tests, three pass unchanged against the
new `renderDocsHtml`/`renderDocsNodeSection`:

- `testDocsHtmlBoardEdgesCoverEveryRealDependsOnPair` and
  `testDocsHtmlLoadsD3AndThemeToggle` don't touch node markup at all.
- `testDocsHtmlShowsCompiledSqlAndConnectorTypes` only checks `/sheets/`
  and `/join/` appear *anywhere* in the returned HTML string
  (`test/docs.test.js:92-96`) — both still do, now inside the
  `window.__DOCS_DETAIL_BY_NAME__` JSON blob (`renderDocsDetailHtml`'s
  output is still embedded verbatim, per Step 3, just reached from the
  drawer instead of inlined per-node) rather than inside the node's own
  `<div class="board-node">`. No edit needed.

Exactly one needs an edit: `testDocsHtmlRendersOneBoardNodePerDiscoveredNode`
(`test/docs.test.js:74-79`) asserts the *exact* literal markup
`'<div class="board-node" data-block-id="' + name + '">'` — Step 2's
`renderDocsNodeSection` now also adds `data-kind="..."` before that closing
`>`, so this exact string no longer appears. Change it from:

```javascript
function testDocsHtmlRendersOneBoardNodePerDiscoveredNode() {
  var html = renderDocsHtmlFor(['rawOrders', 'rawCustomers', 'orders']);
  ['rawOrders', 'rawCustomers', 'orders'].forEach(function (name) {
    assert.ok(html.indexOf('<div class="board-node" data-block-id="' + name + '">') !== -1, 'expected a board-node for "' + name + '", got: ' + html);
  });
}
```

to:

```javascript
function testDocsHtmlRendersOneBoardNodePerDiscoveredNode() {
  var html = renderDocsHtmlFor(['rawOrders', 'rawCustomers', 'orders']);
  ['rawOrders', 'rawCustomers', 'orders'].forEach(function (name) {
    assert.ok(html.indexOf('<div class="board-node" data-block-id="' + name + '" data-kind="') !== -1, 'expected a board-node for "' + name + '", got: ' + html);
  });
}
```

Add a new test:

```javascript
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
```

Register it in `module.exports`.

- [ ] **Step 6: Rebuild and run the full suite**

```bash
./build.sh && node test/run.js
```

Expected: `... passed, 0 failed.`

- [ ] **Step 7: Commit**

```bash
git add src/docs.js test/docs.test.js
git commit -m "feat: color docs board nodes by kind, add sidebar + detail drawer

Each board node gets a colored top bar per its kind (--move/--model/
--publish, Task 1) and shrinks to the same compact-card shape publish's
board now uses (Task 7) - a name + kind badge, nothing else inline. A
new sidebar (search + index grouped by kind, with a discovery-error
flag) and slide-in drawer replace the old 'dump compiled SQL straight
into the graph box' - clicking a node (canvas or sidebar) opens the
drawer with what renderDocsDetailHtml already builds. Sidebar row hover
reuses BOARD_LAYOUT_CLIENT_JS's window.__notsobigBoardApi__.setHighlight
so a name in the list lights up its board node too.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Update user-facing docs, final verification

**Files:**
- Modify: `docs/publish.md` (`### Board layout` section)
- Modify: `docs/cli.md` (`cli('docs')` section)

**Interfaces:** None — this is documentation only.

- [ ] **Step 1: Update `docs/publish.md`'s "Board layout" section**

Add, right after the existing bullet list describing `layout: { type: 'board' }` (the bullets covering `relatesTo`, pan/zoom, "Node positions are computed in the reader's browser"), a new paragraph:

```markdown
Each block on the board renders as a compact metric card - a headline
number and a small chart, not the full chart/table - so the canvas reads
at a glance instead of like a wall of documents. Click a card to expand
it into the full chart/table (with all its own `reactsTo`/`detail`/
`linkKey`/`linkTo` behavior intact) in an overlay; close it to collapse
back to the card. A small toolbar in the bottom-right corner cycles the
tree's direction (top-to-bottom by default, plus bottom-to-top,
left-to-right, right-to-left), resets any node a reader has dragged back
to its computed position, and re-fits the canvas to the viewport.
Dragging a node, and the chosen direction, are both remembered per file
(via the browser's `localStorage`, the same mechanism the light/dark
toggle already uses) - they reset only if a fresh `cli('run')` overwrites
the file, or a reader opens it in a different browser/device.
```

- [ ] **Step 2: Update `docs/cli.md`'s `cli('docs')` section**

Add a paragraph describing the new sidebar/drawer, matching the style of nearby prose in that file (read the current section first, e.g. `sed -n '/cli(.docs.)/,/^##/p' docs/cli.md`, then add a paragraph noting: the doc site now has a left sidebar with a search box and every discovered node listed under a MOVE/MODEL/PUBLISH heading with a count; nodes are colored on the canvas by their `kind`; clicking a node (in the sidebar or on the canvas) opens a detail panel with what used to be shown inline (compiled SQL for a `model`, connector types for a `move`, chart/table titles for a `publish`, or a discovery/compile error) rather than dumping it into the graph box itself; hovering a sidebar row highlights the matching node on the canvas.

- [ ] **Step 3: Final full-suite verification**

```bash
./build.sh --check && node test/run.js
```

Expected: `build.sh: src.js is up to date.` and `... passed, 0 failed.`

- [ ] **Step 4: Commit**

```bash
git add docs/publish.md docs/cli.md
git commit -m "docs: describe the new board metric cards, direction/reset toolbar, and docs sidebar/drawer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Layer 2 verification checklist (human, `notsobigtests`)

Nothing in this task touches `notsobiglib`'s own files — it's the handoff to the project's existing "Apps Script, human-run" layer (see `CLAUDE.md`'s "About testing" § Layer 2), since dragging, hovering, `localStorage` persistence, and the expand overlay all need a real browser and can't run in the Node harness.

- [ ] **Step 1: Point a `notsobigtests` fixture at this branch**

Set the `SRC_REF` Script Property to `feat/pipeline-canvas-redesign` (per `CLAUDE.md`'s "Feature branch workflow"), then run an existing `publish`/`docs` fixture that already exercises board mode (or add one if none currently uses `layout: 'board'` — check `notsobigtests`' own fixtures first).

- [ ] **Step 2: Verify by hand, on the generated `.html` file(s), in an actual browser**

- [ ] Every board node shows a headline number + mini-chart, not the full chart/table.
- [ ] Clicking a card expands it into the full chart/table in an overlay; closing it collapses back to the card in the same spot.
- [ ] Dragging a node moves it, and reloading the file (same browser) keeps it where it was dropped.
- [ ] The direction button cycles all 4 orientations and the tree visibly reflows each time.
- [ ] The reset button snaps every node back to its computed position without changing the current direction.
- [ ] Hovering a node highlights its direct upstream/downstream neighbors and dims everything else; the same works from `cli('docs')`'s sidebar onto the canvas.
- [ ] Light/dark mode still both look correct with the new tokens (this is also covered by Layer 1's `testPublishDarkModeTokensPresent`, but confirm visually - a hex existing in the CSS doesn't guarantee contrast/legibility).
- [ ] `cli('docs')`'s sidebar search actually filters the list and dims non-matching canvas nodes.

- [ ] **Step 3: Reset `SRC_REF`**

Point it back to `main` (or the active `release/N`) once verified, per `CLAUDE.md`'s standing instruction.
