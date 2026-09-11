# publish.js dev notes

Companion to `docs/publish.md` (user-facing config reference) — this
file is for whoever changes this module next, not a user-facing doc.

## Ref resolution reuses model.js's primitive, not a fresh scan

`resolvePublishSource()` calls `model.js`'s `readModelsRegistry()`,
`indexMoveBigQueryTargets()`, and `resolveRefLocation()` directly (same
build closure, no import needed — see `CLAUDE.md`'s "One file to
install, three files to author"). `resolveRefLocation()` was extracted
out of `model.js`'s own `buildRefResolver()` specifically so this module
wouldn't duplicate the "declared model, or a bigquery-target move node,
or neither" lookup a second time — see `src/model.md`'s
"`resolveRefLocation()` is the same lookup" note for the other side of
this.

## `allNodes` — the one EXECUTORS signature change this kind needed

Every other kind's executor only ever needed its own `config`.
`publish()` is the first that needs to look up *other* declared nodes
(to resolve `source.ref`), so `cli.js`'s `runNodes()` now calls
`EXECUTORS[node.kind](node.config, allNodes)` — `allNodes` is
`discoverNodes()`'s full flat node list, from before selection/ordering
narrowed it down, since a ref can name a node outside this run's
`--select`. `move`/`model` ignore the extra argument; no behavior change
for either.

## Why validation happens inside `publish()`, not at discovery time

Unlike `model`, a `publish` node's `dependsOn` is hand-written by its
author, not derived (same as `move`) — nothing about building the
dependency graph needs to know a `publish` node's config is valid before
ordering runs. So config validation (`validatePublishConfig`) happens
lazily, inside the executor, the same way `move()`'s own
`if (!config || !config.source) throw` only fires at `run` time, not at
`list`. This is why `cli('list --select publish')` doesn't itself catch
a bad `publish` config — only `cli('run ...')` does, exactly like
`move`.

## Testing split

Config validation and ref resolution are pure/cheap enough to test in
Node via `cli('run --select ...')` on a fixture designed to fail before
reaching a live call (see `test/publish.test.js` and
`test/incremental.test.js:34`'s precedent for this pattern). The actual
BigQuery read, aggregation-against-real-rows, and Drive write are Layer
2 only — see `docs/superpowers/plans/2026-09-05-publish-kind-v1.md`'s
Task 3 for the fixture-first `notsobigtests` companion this needs.

## Why raw and aggregated tables share one render path

`buildRawTablePayload`/`buildAggregatedTablePayload` (both in
`src/publish.js`) converge on the exact same `{id, title, pageSize,
columns: [{key,label,format}], rows: [[cell,...]]}` shape before
`renderReportHtml` ever sees them — every cell already formatted to a
string, the same way `kpi.formatted` already is. That convergence is
deliberate: `renderTableSection()` and `TABLE_CLIENT_JS` don't know
or care which mode produced a given table, so a third mode later needs
only its own `buildXTablePayload` function producing this same shape,
never a second render/pagination/export path. See
`docs/superpowers/specs/2026-09-06-publish-table-block-design.md`'s §4
for the fuller rationale.

## CSV export reuses the pager's per-table scope, not a second listener

The "Export CSV" button's click handler lives inside `TABLE_CLIENT_JS`'s
existing per-`.table-block` `forEach` (renamed from
`TABLE_PAGINATION_JS` once it grew a second responsibility), not a
separate `DOMContentLoaded` listener — it already has `table`/`tableId`
in scope from the pager setup, so wiring the button there is one more
`addEventListener` call, not new lookup logic. It exports whatever the
search box currently matches (`visibleRows()`, not just the visible
page — see "Sort/search compare on the formatted cell" below), since
that data is already embedded for the pager and slicing it down for
export would be a step backward; with no search text that's every row,
same as before sort/search existed. `csvField()` is a plain top-level
function in the same JS string, not folded into the `forEach`, since
it's pure and doesn't need per-section scope.

`csvField()` also guards against CSV formula injection (CWE-1236):
`table.rows` cells come from a live BigQuery table `publish()` never
validates for injection safety (same untrusted-data posture as the
`<`-escaping fix for the embedded JSON payload, see `be7a960`) — a cell
starting with `=`/`+`/`-`/`@` would otherwise be parsed as a formula by
Excel/Sheets the moment a human opens the exported file, so a leading
`'` is prefixed before the existing quote/comma/newline escaping runs.

## Sort/search compare on the formatted cell, not a re-fetched raw value

`table.rows` cells are already formatted display strings (`"$1,234.56"`,
not `1234.56`) — deliberately, per the section above, since the pager
and CSV export both need exactly that string. Sorting a `currency`/
`integer`/`decimal` column against those strings as text would put
`"$20.00"` before `"$5.00"`, so `sortableValue()` strips everything but
digits/dot/minus and compares the resulting number instead; `"string"`
columns (and the aggregated groupBy column, which is always `"string"`)
compare as lowercased text. This is why `columns[]` now carries
`format` alongside `key`/`label` — the client-side sort has no other
way to know which comparison a given column needs. The alternative
(embedding both a raw and a formatted value per cell, mirroring
`kpi`/`chart`'s `{value, formatted}` shape) was rejected: it would
double every cell's payload size for a benefit only sort needs, when
stripping the formatting back out is a one-line regex.

Search and sort both read from `table.rows`/`table.columns` — the
config object holding the *currently active* dataset, which
`window.__PUBLISH_TABLE_REPLACERS__` already swaps wholesale on a
`filters[]` change (see below). `sortColumn`/`sortDir`/`searchQuery`
live one level up, outside that swap, so a search/sort a viewer already
has active survives a filter dropdown change instead of silently
resetting.

## Why D3 over Chart.js/p5.js/a declarative grammar

Considered and rejected during brainstorming (see
`docs/superpowers/specs/2026-09-06-publish-d3-charts-design.md`'s §3
for the full rationale): Chart.js renders to `<canvas>`, which would
mean re-implementing `REPORT_CSS`'s existing styling as JS config per
chart instead of reusing the `.chart-bar`/`.chart-label`/`.chart-value`
classes that already exist; p5.js has no chart primitives (scales,
axes, `pie()`/`stack()`) at all, so it would mean building those from
scratch, more work than D3 for no benefit; a declarative grammar
library (e.g. Observable Plot) was speculative for a fixed set of 4
chart types and had shakier native pie/donut support than D3's own
`d3-shape` module. D3 also renders actual SVG/DOM elements, so
`CHART_CLIENT_JS`'s draw functions apply the same class names
`renderBarChartSvg` used to hand-write, and `REPORT_CSS` needed no
changes.

`buildChartPayload` stays pure — a plain function of `(chartConfig, rows)`,
called both server-side at generation time and client-side when `filters[]`
recomputes. This purity is what enables the reuse-via-`Function.prototype.toString()`
pattern that filters[] relies on. Cross-chart interactivity (Phase 2, shipped — see
below) deliberately doesn't re-aggregate either, only dims already-rendered elements.

**Set a per-item chart color with `.style('fill', ...)`, never
`.attr('fill', ...)`.** `REPORT_CSS`'s `.chart-bar { fill: var(--teal); }`
class rule always wins over a presentation attribute set via
`.attr("fill", ...)` regardless of specificity, because a stylesheet rule
beats a presentation attribute outright in SVG/CSS — only an inline style
(`.style(...)`) outranks a stylesheet rule. This exact bug was caught
twice during this branch's review: once on the pie/stacked/grouped-bar
color scales, then again on the plain line chart's `fill: none`. Any new
call site that sets `fill` (or any other CSS property `.chart-bar`/
`.chart-label`/`.chart-value` also declares) on a D3-created element must
use `.style(...)`, not `.attr(...)`.

## Cross-chart highlighting is one shared client-side module, not per-chart state

`CHART_CLIENT_JS` gained a small selection module for Phase 2
(`docs/superpowers/specs/2026-09-06-publish-chart-interactivity-design.md`):
one module-level `currentSelection` (`null`, or a plain object mapping a
`linkKey`/`seriesLinkKey` name to the selected value), `handleChartClick()`
to update it on a click, and `applyHighlight()` to re-derive every
interactive element's opacity from it. `applyHighlight()` is generic across
all three chart shapes on purpose: rather than re-deriving each drawn
element's own `(groupValue, seriesValue)` from D3's per-shape datum layout
a second time, every interactive element gets `data-group-value`/
`data-series-value` DOM attributes at draw time, and `applyHighlight()`
reads those back uniformly. Click handlers themselves *do* read the D3
datum directly (cheaper, and the shape is known at the call site) — the
DOM attributes exist specifically so the later, shape-agnostic highlight
pass doesn't need to know a stacked bar's parent-datum trick versus a
plain bar's flat datum.

Matching is deliberately "only the keys the reacting chart itself
declares, intersected with the current selection's keys" — never
`Object.keys(currentSelection).length === Object.keys(ownKeys).length`
strict equality. A chart declaring only `linkKey` must still react to a
selection that also carries a `seriesLinkKey` entry from a different
chart's stacked-segment click, by matching on the one dimension it
understands and ignoring the rest. Getting this backwards (requiring an
exact key-set match) is the most likely way a future change to this
module quietly breaks cross-chart highlighting between charts of
different shapes — see `selectionMatches` for the actual implementation.

No new `.attr("fill", ...)`-vs-`.style("fill", ...)` traps were introduced
here — none of this task's new code sets `fill`.

## `filters[]` reuses its own server-side functions client-side, via `Function.prototype.toString()`

`computeAggregate`, `groupRowsBy`, `compareGroupValues`, `formatValue`,
`buildChartPayload`, `buildRawTablePayload`, `buildAggregatedTablePayload`,
`emptyMap`, and `has` were already plain JS with zero GAS-only API calls
before this feature existed — nothing about them was ever
Apps-Script-specific. `FILTER_REUSED_FUNCTIONS_JS` takes advantage of
that by serializing these nine functions' own source text
(`fn.toString()`) straight into the generated report's client script,
rather than hand-porting a second copy into `FILTER_CLIENT_JS` the way
`CHART_CLIENT_JS`/`TABLE_CLIENT_JS` reimplement their own draw/pagination
logic from scratch. This means a future change to any of these nine
functions — a new `agg`, a formatting fix, a new table mode — is
automatically correct in the browser too, with nothing to remember to
keep in sync. The one obligation this creates going forward: none of
these nine functions may ever grow a reference to a GAS-only global
(`BigQuery`, `DriveApp`, `Utilities`, etc.) — doing so would compile fine
and pass every Node test, then throw a `ReferenceError` only in the
browser, only on a report that uses `filters[]`, the first time a human
opens one. There is no automated check for this; it's a rule to remember
when touching any of these nine, not something `node test/run.js` can
catch.

## `reactsTo` intersects with the active filters, mirroring `applyHighlight`'s own matching rule

`FILTER_CLIENT_JS`'s `filteredRowsFor(reactsTo)` filters `reactsTo` down
to whichever of its own entries are currently active
(`has(activeFilters, f)`) and filters the underlying rows on that
intersection — a block always recomputes against the rows matching its
own `reactsTo`'s intersection with the currently-active filters; when
that intersection is empty (no `reactsTo` field is currently active,
whether because none ever was or because the user just reset the one it
cared about back to "All"), `filteredRowsFor` returns every row
unfiltered, i.e. the block's original unfiltered value. This is the same
"only the keys the block itself declares, intersected with what's
currently active" shape
`docs/superpowers/specs/2026-09-06-publish-chart-interactivity-design.md`'s
`selectionMatches` already established for cross-chart highlighting — see
`src/publish.md`'s note on that function for why getting this backwards
(recomputing whenever *any* filter changes, regardless of whether the
block declared that field) is the most likely way a future change here
quietly breaks a report where different blocks opt into different filter
subsets.

## The table replacer hook is small, always-on scaffolding — same shape as `CHART_CLIENT_JS`'s selection module

`TABLE_CLIENT_JS`'s per-section closure now always exposes
`window.__PUBLISH_TABLE_REPLACERS__[tableId]`, whether or not the report
declares `filters[]` at all — mirroring `CHART_CLIENT_JS`'s own selection
module (`currentSelection`/`applyHighlight`), which is likewise emitted
whenever any chart exists, regardless of whether any individual chart
opts into `linkKey`. The alternative (gating this hook's presence on
`config.filters.length`, so a filter-less report's `TABLE_CLIENT_JS`
stays byte-identical to before this feature) was rejected: pagination
state (`table`/`page`/`pageCount`) lives inside this one closure per
table section, and there is no way for `FILTER_CLIENT_JS` to hand it
freshly-filtered rows and have "Next"/"Previous" keep working correctly
afterward without either this hook or a second, independent closure
walking the same DOM a second time — and a second closure would hold its
own separate `page`/`table` state, silently desyncing from the first the
moment a filter changes (clicking "Next" would then page through stale,
pre-filter data). One shared closure, one small always-on hook, is the
only version of this that can't drift out of sync with itself.

## `linkTo` resolves at generation time, and it's pure - no Drive call at all

An earlier version of this feature resolved `linkTo` to a live Drive
web-view URL (`https://drive.google.com/file/d/<id>/view`, looked up via
`move.js`'s `resolveDriveTargetFileId`) - reasonable-looking, but wrong
for how these reports actually get viewed: downloaded or synced (Drive
for Desktop) into one local folder and opened straight in a browser, not
opened through Drive's own web preview, which doesn't execute an
arbitrary `.html` file's inline script at all (it renders a static
preview, or offers a download) - so the generated link simply didn't
render anything. The fix is also a simplification: `linkTo`'s destination
is just the other node's own declared `target.fileName`, a plain relative
link a browser resolves against wherever the *current* file happens to be
sitting - exactly like two spreadsheet tabs cross-referencing each other
by name, and exactly what the "put both files in the same folder" mental
model actually needs.

This means `validateLinkToTarget(chart, allNodes)` (node exists, is
`kind: 'publish'`, has a matching `filters[]` field) is the *entire*
resolution - no split needed between a pure half and a live-I/O half,
unlike `resolvePublishSource`/`fetchTableRows`. There's also no more
"the destination must have been published at least once already"
ordering requirement the live-lookup version had - a relative filename is
valid the moment both configs exist, regardless of which one has
actually run. `resolveConfigLinkTargets` is called early in `publish()`,
right after `resolvePublishSource`, with nothing forcing it to wait for
`fetchTableRows` the way the old Drive-lookup version did.

The resolved shape (`{url, field, newTab}`) replaces the declared shape
(`{node, field, newTab}`) on a *copy* of `config.charts`, never the
original — `buildChartPayload` (reused verbatim client-side via
`FILTER_REUSED_FUNCTIONS_JS`, see above) must never gain a reference to
`DriveApp`, so all node-name resolution happens once, server-side, before
that function ever sees the chart config. A report with no `linkTo`
anywhere pays for none of this: `resolveConfigLinkTargets` returns the
original `config` object unchanged.

`linkTo` and `linkKey`/`seriesLinkKey` are mutually exclusive on one
chart by validation, not by runtime precedence — a click either
highlights same-page elements or navigates away, and letting a chart
declare both would mean picking a silent winner between two config keys
that both fired. `handleChartClick`'s `linkTo` branch returns early,
before `chartSelectionFor`/`applyHighlight` ever run, so this couldn't
silently do both even if validation were ever removed.

On the destination side, `applyFiltersFromQueryString()` deliberately
reuses `activeFilters`/`applyFilters()` — the exact state a `<select>`
change already mutates — rather than a separate "initial filter" code
path. A query-string value that doesn't match one of that filter's own
computed `options` is silently skipped (not forced into `activeFilters`),
so a stale or unrelated link never leaves a report stuck filtered to a
value that matches zero rows.

## Per-block `source` override

`block.source` reuses `config.source`'s exact shape and validation
(`validateBlockSource` mirrors the checks `validatePublishConfig`
already runs on the top-level `source`, just parameterized by
`blockType`/`blockId`/`dependsOn`), rather than inventing a second
schema for "a ref plus a dependsOn requirement". `fetchBlockSourceRows`
collects the *distinct* refs used across `kpis`/`charts`/`tables` before
fetching anything, so three blocks overriding to the same node still
issue one `Tabledata.list` call, not three - the same "don't refetch
what you already have" instinct `resolveConfigLinkTargets`'s no-`linkTo`
early return has, just for a different resource.

`fetchBlockSourceRows` runs *before* the report's own default
`fetchTableRows` call in `publish()`, not after - deliberately, so an
invalid block `source.ref` (wrong node, wrong kind, not a bigquery
location) fails at `resolvePublishSource`'s own throw, a pure/no-I/O
check, rather than only surfacing after the default source's live
BigQuery call already ran. Ordering the two fetches the other way would
still be *correct*, just slower to fail on a bad block ref in a report
whose default source is itself expensive to read.

Mutually exclusive with `reactsTo` on the same block, enforced in
`validateBlockSource`: `FILTER_CLIENT_JS`'s `filteredRowsFor` only ever
slices the report's one default row set (`payload.rows`), so a block
reading from a different table has nothing there for a filter change to
recompute against - rather than teach the client-side filter engine
about multiple row sets for a niche combination, the two are just
declared incompatible up front. `buildReportPayload`'s three block loops
each pick a block's own rows over the default via one `rowsForBlock`
helper; nothing below that point (`buildChartPayload`,
`buildRawTablePayload`, `buildAggregatedTablePayload`) needed to change,
since they already took `rows` as a parameter rather than reaching for
a shared closure variable.

## Detail drill-down

`withDetail` does **not** compute which raw rows belong to a clicked group —
that filtering happens client-side, at click time, in
`TABLE_DETAIL_TOGGLE_HANDLER_JS` and `handleChartClick`'s `chart.detail`
branch (`rows.filter(function (row) { return row[groupBy] === groupValue;
})`). What `withDetail` actually does is attach a block's own already-
resolved row set (`rowsForBlock`'s result — respecting a block-level
`source` override, the same rows the aggregate/chart was computed from) to
`built.detail.rows`, **projected down** to only the fields the modal can
ever need: each `detail.columns[i].field`, plus `groupBy` and `series`
(used to re-filter by group/segment at click time) — never the row's full
source-table shape. This projection is the fix landed in commit `29b5a69`:
before it, `withDetail` attached the entire row (every column the source
table had), so a column never configured for display anywhere in the
report — e.g. a `customer_email` field sitting unused on the source table —
would still be serialized into `__PUBLISH_PAYLOAD__` and shipped in the
generated `.html` the moment any block on the same rows declared `detail`.
`withDetail` lives as a plain JS function in both the server-side
`buildReportPayload` step and the client-side recompute path, mirroring
`buildChartPayload`'s own twin lives in `FILTER_REUSED_FUNCTIONS_JS`. A
filtered report's modal always shows the raw rows *behind the
currently-active filter state*, not a snapshot from generation time — if a
human clicks a group while a filter is active, the modal's "show 5 matching
orders" count reflects that filter, and if they change the filter
afterward, the modal updates too. This requires `withDetail` to be
reserialized into the client script just like `buildChartPayload` is, so
both functions stay pure (zero GAS-only APIs) and a future change to the
filtering logic automatically propagates to both paths with nothing to
remember to keep in sync.

`DETAIL_REUSED_FUNCTIONS_JS` (`formatValue` and `buildRawTablePayload`) is
not independent from `FILTER_REUSED_FUNCTIONS_JS` — both of its functions
already live inside `FILTER_REUSED_FUNCTIONS_JS`'s own list (which also
unconditionally includes `withDetail`, whether or not the report has
`detail` at all), making `DETAIL_REUSED_FUNCTIONS_JS` a strict subset, not
a sibling set. `DETAIL_REUSED_FUNCTIONS_JS` exists only to cover the one
case `FILTER_REUSED_FUNCTIONS_JS` doesn't: a report with `detail` but no
`filters[]` still needs `formatValue`/`buildRawTablePayload` declared
somewhere, since `openDetailModal`'s callers (`TABLE_DETAIL_TOGGLE_HANDLER_JS`,
`handleChartClick`) call `buildRawTablePayload` directly. `renderReportHtml`
picks exactly one of the two with `if (hasFilters) { ... } else if
(hasDetail) { ... }` rather than two independent `if`s, precisely because
one is a subset of the other — declaring both in the same `<script>` would
redeclare `formatValue`/`buildRawTablePayload` a second time for nothing.

The table-detail click listener (the expand-row toggle) lives inside
`TABLE_CLIENT_JS`'s existing per-section `forEach` closure, not in a
separate global delegated listener, for the same reason the "Export CSV"
button does: it already has `table`/`tableId`/`detail` in scope, and it
reuses the pagination state closure without risking desyncs if a filter
recomputes mid-view. When `FILTER_CLIENT_JS` runs `__PUBLISH_TABLE_REPLACERS__[tableId](...)`
to swap in a newly-filtered table, the closure's `table` variable updates
automatically. If the detail modal were listening globally via
`document.addEventListener('click', ...)`, it would have to look up the
table's current config from `window.__PUBLISH_PAYLOAD__.tables` — but that
would show a stale copy if a filter just ran and swapped `payload.tables`
with newly-filtered rows. One shared closure, one click handler holding the
live reference, is the only version that stays in sync.

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

`BOARD_LAYOUT_CLIENT_JS` also reads two globals as a second, generic
entry point, not just from `renderReportHtml`'s own `__BOARD_NODES__`
assembly line (`charts.concat(tables).map(...)`, above):
`window.__BOARD_NODES__` (`{id, relatesTo}[]`, position-only, fed
straight to `d3.stratify()`/`d3.tree()`) and `window.__BOARD_EDGES__`
(`{from, to}[]`, the real edges drawn - `blocks.filter(...).map(...)`'s
`relatesTo`-only computation is only a fallback for when this global is
absent). `cli('docs')` (`src/docs.js`) is that second caller: a node's
real `dependsOn` can be a multi-parent DAG, which `relatesTo`'s
single-parent shape can't express, so `docs.js` sets `__BOARD_NODES__`
from a synthetic single-parent link (`dependsOn[0]`) for positioning
only, and `__BOARD_EDGES__` from every real `dependsOn` pair for what's
actually drawn. This is safe for `publish()`'s own board output because
`publish()` never sets `__BOARD_EDGES__` itself, so its generated HTML
still falls through to the original `relatesTo`-only edge computation,
byte-identical to before. See `src/docs.md` for the fuller rationale on
the `docs` side of this split. Whoever next changes
`BOARD_LAYOUT_CLIENT_JS` should assume `renderReportHtml` is not its
only caller.
