# `publish` kind — v1 design

Third node `kind` alongside `move` (EL) and `model` (T). Turns an
already-materialized BigQuery table into a self-contained static `.html`
dashboard file written to Drive. This spec covers **v1 only** — the
smallest slice that proves the kind end-to-end. Everything past v1
(filters, drill-down, a `table` block, per-block `source` override,
cross-file navigation, tree layout, CSV export) is intentionally
unspecified here — see "Future direction" at the end.

## 1. Purpose and non-goals

`publish()` never runs its own SQL. It only reads a table another node
(`move` with a BigQuery target, or `model`) already materialized, via
`BigQuery.Tabledata.list` (storage read, no query job, no query cost —
not `BigQuery.Jobs.query`), aggregates in JS, and renders one
self-contained HTML file: inline JSON payload, inline CSS/JS, no CDN,
no build step, works offline once downloaded. This mirrors `model`'s
own posture of staying a thin layer over data someone else already
shaped — `publish()` is presentation only, never transformation.

Non-goal for v1, and likely ever without a specific driver: DuckDB-Wasm,
payload compression, a live `doGet` web-app mode, a browser extension
for Drive-web navigation. None of these are needed for a MVP that reads
one small-to-medium table and renders one page.

## 2. Schema (v1)

```ts
type PublishNode = {
  kind: 'publish';
  dependsOn: string[];       // must include source.ref (see §5)

  source: { type: 'ref'; ref: string }; // one source, no per-block override yet

  target: { type: 'drive'; folderId: string; fileName: string };

  kpis?: {
    label: string;
    agg: 'sum' | 'avg' | 'count' | 'count_distinct';
    field?: string;          // required unless agg === 'count'
    format: 'currency' | 'integer' | 'decimal';
  }[];

  charts?: {
    id: string;
    type: 'bar';
    title: string;
    groupBy: string;
    metric: { agg: 'sum' | 'avg' | 'count'; field?: string };
  }[];

  layout?: { type: 'linear' }; // only value accepted in v1; field exists so a
                                // future 'board' value doesn't need a schema migration
};
```

Explicitly cut from v1 (all present in the user's original inspiration
doc, deferred, not designed here): `filters`, `expandable`/`detail`,
`linkTo`, `table`, per-block `source` override, `layout: 'board'`.

Worked example:

```javascript
var salesPublish = {
  kind: 'publish',
  dependsOn: ['dailyRevenueModel'],
  source: { type: 'ref', ref: 'dailyRevenueModel' },
  target: { type: 'drive', folderId: props.REPORTS_FOLDER, fileName: 'sales.html' },
  kpis: [
    { label: 'Receita total', agg: 'sum', field: 'revenue', format: 'currency' },
    { label: 'Pedidos', agg: 'count_distinct', field: 'order_id', format: 'integer' }
  ],
  charts: [
    { id: 'by_category', type: 'bar', title: 'Por categoria',
      groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' } }
  ],
  layout: { type: 'linear' }
};
```

## 3. Module and kind registration

New module `src/publish.js`, added to `build.sh`'s `MODULES` manifest.
`EXECUTORS.publish = publishExecutor` added in `src/cli.js` — that one
line (plus the manifest entry) is the entire registration surface;
`knownKinds()`, `usage()`, `hello()` and selector error messages all
read `EXECUTORS`'s keys already, nothing else to touch.

`publish` nodes are plain top-level `var`s, one node per `var` — the
same discovery shape `move` already uses. `discoverNodes()` needs no new
hook: it already keeps any top-level object whose `kind` is a key of
`EXECUTORS`. This is deliberately **not** `model`'s shape (one shared
registry expanded into N nodes) — that pattern exists because `model`
needed project-wide defaults shared across many SQL files; `publish`
has no equivalent shared-defaults need in v1, so the simpler `move`-like
shape is the right fit, not a generalization of `model`'s hook.

## 4. Ref resolution — extracting the shared primitive

`model.js`'s `buildRefResolver` already resolves a ref name to a
BigQuery location two ways: through the model registry
(`resolveModelConfig` → `.projectId`/`.dataset`/`.name`) or through an
index of `move` nodes with a BigQuery target
(`indexMoveBigQueryTargets`). Today that resolution is only exposed
already formatted as a backtick-quoted SQL relation string
(`qualifiedRelation`), because SQL substitution is the only consumer.

`publish()` needs the same resolution but as structured
`{projectId, dataset, table}`, not a SQL string. Rather than
re-implementing the two-source lookup a second time, extract it out of
`buildRefResolver` into its own function —
`resolveRefLocation(refName, allNodes)` — that both `model.js` (which
then formats the result into its existing backtick string) and the new
`src/publish.js` call. This is the same kind of cross-module primitive
sharing already established for `resolveDriveWriteTarget`/
`writeDriveText` (`move.js`, reused by `cli.js`'s run-manifest write):
genuinely the same primitive, not new logic living in the wrong module.

`resolveRefLocation` throws a clear error if the ref resolves to a
`move` node whose target is **not** BigQuery (e.g. a Sheets or Drive
target) — `publish()` can only read tables that actually live in
BigQuery, so pointing it at a non-BigQuery move is a config error, not
a silent no-op.

No import is needed for `publish.js` to call it: all modules share one
closure once `build.sh` concatenates them into `src.js` (see
`CLAUDE.md`'s "One file to install, three files to author"), so a
top-level function declared in `model.js` is already callable by name
from `publish.js` — the same reason `cli.js` can call `move.js`'s
`resolveDriveWriteTarget` directly today. Build-order only matters for
`MODULES` listing every module at least once, not for which module
calls which.

## 5. Validation

At discovery/early-run time, `publishExecutor` (or a small
`validatePublishConfig` it calls first) checks:

- `source.ref` is present in `dependsOn` — same *lax* precedent `model`
  already sets for its own `ref()`s (each ref used must appear in
  `dependsOn`; this is not the stricter "must be exactly the ref set,
  no extras" rule the original inspiration doc proposed — matching the
  existing precedent keeps one validation idiom across kinds instead of
  introducing a second, stricter one for just this kind).
- Each `kpis[]` entry has `field` unless `agg === 'count'`, and a
  `format` from the known enum.
- Each `charts[]` entry has `groupBy` and `metric.agg`.

Failures follow the existing per-node `discoveryError` convention (see
`move.js`/`model.js`) — one bad `publish` node doesn't block discovery
or execution of every other node in the run.

## 6. Execution flow

`publishExecutor(node, allNodes)`, called by `cli()`'s normal run loop
like any other executor:

1. `resolveRefLocation(node.config.source.ref, allNodes)` → `{projectId, dataset, table}` (§4).
2. `fetchTableRows(projectId, dataset, table)` — new, `publish.js`-only.
   `BigQuery.Tables.get` for the schema (field names — `Tabledata.list`
   rows come back as positional arrays, not named objects), then
   `BigQuery.Tabledata.list` with a `pageToken` loop, zipping each row's
   values against the schema's field names into plain objects. Nobody
   in this repo calls `Tabledata.list` yet, so this pagination loop is
   new code, but it's small and self-contained.
3. `buildReportPayload(config, rows)` — **pure**: no GAS globals, plain
   array of row objects in, plain JSON out. Computes each KPI
   (`sum`/`avg`/`count`/`count_distinct`, applies `format`) and each
   chart's `groupBy` aggregation, entirely in JS (never in SQL, never in
   the browser at render time).
4. `renderReportHtml(payload, config)` — **pure**: string-template HTML
   with the payload embedded inline as JSON, a small vanilla-JS bar
   chart renderer (SVG `<rect>`s built from a template string, no
   `<canvas>`, no charting lib), and the fixed design tokens below. No
   external font, no CDN, no build step — the file works standalone.
5. `resolveDriveWriteTarget`/`writeDriveText` (`move.js`, unchanged —
   already content/mimetype-agnostic, already reused for the JSON
   run-manifest) write the HTML string with `MimeType.HTML`.

Steps 3 and 4 take plain data in and plain strings/objects out — no
Drive, no BigQuery, no GAS service calls inside them. That separation
is what makes them unit-testable in Node without touching a live
resource (§7), and it's the same "keep the pure computation apart from
the I/O" shape `model`'s macro parser already has relative to
`model.js`'s BigQuery execution code.

Design tokens for step 4 (fixed, no per-report customization): still
true — nothing here becomes a per-report config knob — but as of the
design-system revision this means exactly *two* fixed, systemic token
sets (light default + dark), switched by one report-agnostic toggle
baked into every generated file, not a per-report style choice. Colors
follow Google's own Material palette (Workspace/Cloud Console grays, the
`rgba(60,64,67,…)` elevation-shadow tint, Google's actual light/dark
accent blue and red) rather than an invented brand:

```css
:root {
  --paper: #F8F9FA; --surface: #FFFFFF; --paper-line: #DADCE0; --ink: #202124; --ink-soft: #5F6368;
  --teal: #1A73E8; --teal-soft: #E8F0FE; --coral: #EA4335;
  --shadow-sm: 0 1px 2px 0 rgba(60,64,67,.30), 0 2px 6px 2px rgba(60,64,67,.15);
  --shadow: 0 1px 3px 0 rgba(60,64,67,.30), 0 4px 8px 3px rgba(60,64,67,.15);
  --radius: 8px; --radius-sm: 4px;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
  --sans: Roboto, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
}
/* dark: @media(prefers-color-scheme: dark) unless data-theme="light",
   and unconditionally under [data-theme="dark"] */
--paper: #202124; --surface: #292A2D; --paper-line: #3C4043; --ink: #E8EAED; --ink-soft: #9AA0A6;
--teal: #8AB4F8; --teal-soft: #29344A; --coral: #F28B82;
--shadow-sm: 0 1px 2px 0 rgba(0,0,0,.45), 0 2px 6px 2px rgba(0,0,0,.3);
--shadow: 0 1px 3px 0 rgba(0,0,0,.5), 0 4px 8px 3px rgba(0,0,0,.35);
```

Numbers render in `--mono` with `font-variant-numeric: tabular-nums`;
labels render in uppercase `--mono` with slightly open letter-spacing.
KPI/chart/table/modal/board-node surfaces are cards now (`--surface`
background, `--radius`, `--shadow-sm`/`--shadow`), not hairline-separated
flat sections — the rest of the chart/table markup is unchanged, since
every rule already reads these custom properties and re-themes through
the cascade with no per-block dark-mode code. A discreet toggle button
(top-right corner, inline-SVG sun/moon icons) switches between the two
token sets: defaults to `prefers-color-scheme`, an explicit click sets
`documentElement.dataset.theme` and persists it via `localStorage`
(wrapped in try/catch — the report's usual `file://` delivery can throw).

Return shape from `publishExecutor` matches the existing per-node run
result convention (`status`, and on success whatever identifies the
written artifact — e.g. the Drive file id, mirroring `move`'s
`.loadResult`) so `cli()`'s aggregate run report stays uniform across
kinds.

## 7. Testing

**Layer 1 (Node, TDD-first)** — everything with no GAS global in its
signature: `validatePublishConfig` (ref-in-`dependsOn` check, required
KPI/chart fields), `buildReportPayload` (KPI math including
`count_distinct`, groupBy aggregation, `format` application) and
`renderReportHtml` (asserts the rendered string contains expected
computed values and well-formed markup) all get a fixture-driven
`test/*.test.js` written first, red, then green — same discipline the
repo's other discovery/ordering/aggregation logic already gets.
`resolveRefLocation`'s extraction out of `model.js` is a refactor of
already-tested logic; the existing `model` test suite must keep passing
unchanged, and one new test exercises calling it directly for a
move-with-bigquery-target ref (the path `model`'s own tests may not
already cover from `publish`'s call site).

**Layer 2 (`notsobigtests`, human-run)** — `fetchTableRows` and the
Drive write are real I/O, untestable headless. Per this repo's existing
"write the fixture before the `src/` change" rule for connector-facing
work, the `notsobigtests` fixture (a `publish` node reading a small
real BigQuery table, describing the expected `cli('run --select
salesPublish')` result and what the written `.html` file should
contain) gets written before `fetchTableRows`/the Drive-write code, not
after.

## 8. Docs and build impact

- `src/publish.js` added to `build.sh`'s `MODULES` manifest.
- `docs/publish.md` new, following `docs/move.md`/`docs/model.md`'s
  existing structure (intro, `##` per concern, `###` per sub-feature,
  each ending in a worked example).
- `src/publish.md` new, tracked code-internals notes for whoever changes
  the module next (the `resolveRefLocation` extraction and why it lives
  where it does belongs here).
- README gets a short link to `docs/publish.md`, matching the existing
  per-topic link pattern.
- `model.md`/`model.js`'s dev notes get a one-line addition documenting
  that `resolveRefLocation` is now shared with `publish.js`, so a future
  reader of `model.js` doesn't mistake it for model-only logic.

## Future direction (not designed here)

`filters`, `expandable`/`detail` drill-down, a `table` block, per-block
`source` override (letting one KPI/chart import from a different
`ref()` than the report's default), `linkTo` cross-file navigation with
query-string filter propagation, `layout: 'board'` with a `relatesTo`-driven
tree auto-layout, and client-side CSV export are all real, all present
in the original inspiration doc, and all deliberately out of scope
here. Each gets its own brainstorming pass once v1 is running for
real — several of these (board layout in particular) are exactly the
kind of decision better made after seeing v1's actual output than
speculated now.
