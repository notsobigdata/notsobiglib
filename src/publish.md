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
deliberate: `renderTableSection()` and `TABLE_PAGINATION_JS` don't know
or care which mode produced a given table, so a third mode later needs
only its own `buildXTablePayload` function producing this same shape,
never a second render/pagination path. See
`docs/superpowers/specs/2026-09-06-publish-table-block-design.md`'s §4
for the fuller rationale.

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
aggregation happens in the browser. Cross-chart interactivity (Phase
2, not designed yet) is the point where the browser will need to
re-aggregate against a shared filter/selection state; this phase
deliberately doesn't build that machinery early.
