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
