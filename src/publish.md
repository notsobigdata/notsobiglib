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
columns: [{key,label}], rows: [[cell,...]]}` shape before
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
`addEventListener` call, not new lookup logic. It always exports the
full `table.rows` set (not just the visible page), since that data is
already embedded for the pager and slicing it down for export would be
a step backward. `csvField()` is a plain top-level function in the same
JS string, not folded into the `forEach`, since it's pure and doesn't
need per-section scope.

`csvField()` also guards against CSV formula injection (CWE-1236):
`table.rows` cells come from a live BigQuery table `publish()` never
validates for injection safety (same untrusted-data posture as the
`<`-escaping fix for the embedded JSON payload, see `be7a960`) — a cell
starting with `=`/`+`/`-`/`@` would otherwise be parsed as a formula by
Excel/Sheets the moment a human opens the exported file, so a leading
`'` is prefixed before the existing quote/comma/newline escaping runs.

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

`buildChartPayload` stays pure and server-side in this phase — no
aggregation happens in the browser. Cross-chart interactivity (Phase 2,
shipped — see below) deliberately doesn't re-aggregate either, only
dims already-rendered elements; a future `filters[]` dropdown is where
client-side re-aggregation would actually need to happen.

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
