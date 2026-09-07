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
