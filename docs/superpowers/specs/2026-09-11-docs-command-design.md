# `cli('docs')` — a dbt-`docs`-style project doc site, reusing `publish`'s board

Adds one new `cli()` command, `docs`, that describes the whole discovered
project (every node's kind, `dependsOn`, and whatever each kind already
exposes) as one self-contained `.html` file written to Drive — the same
shape dbt's `docs generate` produces, minus a `serve` step (there is no
local server story in Apps Script; the file is just opened from Drive).
No new node `kind`, no new declarative metadata (no `description`/column-doc
fields) — v1 documents only what `cli()` can already see.

## 1. Command surface

`COMMANDS` (`src/cli.js:125`) gains `'docs'`:

```js
var COMMANDS = ['run', 'list', 'compile', 'debug', 'sources', 'docs', 'hello', 'help'];
```

One optional flag, `--folder-id <id>` (or `--folder-id=<id>`, same dual
syntax every flag already accepts). `parseCommand` (`src/cli.js:160`)
gains it in the flag whitelist (line 185) alongside `--select`/
`--exclude`/`--target`/`--full-refresh`, and — mirroring how
`--full-refresh` is restricted to `run`/`compile` (lines 193-195) —
`--folder-id` is rejected on every command except `docs`. No
`--select`/`--exclude`: `docs` always documents the full project, the
same way `dbt docs generate` has no partial-project mode. `parsed` gains
`folderId: null`, set at most once, same "can only be specified once"
guard `--target` already has (lines 205-207).

## 2. Where `docs` sits in `cli()`'s dispatch

`cli()` (`src/cli.js:1453`) already has three early-exit commands before
`discoverNodes()` (`help`, `hello`, `sources`) and one that diverges after
selection but before ordering (`debug`). `docs` needs the *full* DAG
(`dependsOn`, so `discoverNodes()` + `assertDependenciesExist()` both
run — unlike `sources`, which needs neither), but nothing selection/
ordering/target-overlay-related applies to it (it has no `--select`, and
describing "the project" shouldn't shift because of a `--target`
override meant for `run`). So it diverges right after the existing
empty-check + `assertDependenciesExist(discovered.nodes)` call, before
`applyTargetOverlay`/`applyFullRefresh`/`applySelection`:

```js
var discovered = discoverNodes();
if (!discovered.nodes.length) { throw new Error(...); }
assertDependenciesExist(discovered.nodes);
if (parsed.command === 'docs') {
  return runDocsCommand(discovered.nodes, parsed.folderId);
}
applyTargetOverlay(discovered.nodes, parsed.target);
...
```

This also means `docs` sees the `model` registry already expanded into
real nodes (`expandModelNodes()`'s work happens inside `discoverNodes()`)
for free, same as `list`/`run`.

## 3. Payload — reusing what each kind already computes, dry only

New `src/docs.js`, `buildDocsPayload(nodes)`:

```js
function buildDocsPayload(nodes) {
  return nodes.map(function (node) {
    return { name: node.name, kind: node.kind, dependsOn: node.dependsOn || [], detail: buildDocsDetail(node) };
  });
}
```

`buildDocsDetail(node)` branches on `node.kind`, every branch reading
fields the node's own config already carries — no new resource I/O:

- **`move`**: `{ sourceType: node.config.source.type, targetType: node.config.target.type }`.
- **`model`**: `{ materialized, projectId, dataset, tests: (node.config.tests || []).map(t => t.name || t.type), compiledSql }`.
  `compiledSql` reuses `COMPILERS.model` (`src/cli.js:42-44`, i.e.
  `compileModel(node.config)`, `src/model.js:2101`) — the exact function
  `cli('compile')` already calls, so `{{ ref() }}`/macro resolution is
  never reimplemented. Wrapped in try/catch: a model whose SQL fails to
  compile reports `{ compiledSqlError: error.message }` instead of
  aborting `docs` for every other node — matching this library's
  standing rule (`CLAUDE.md`: "`cli()` returns a structured report
  rather than throwing").
- **`publish`**: `{ layoutType: (node.config.layout || {}).type || 'linear', charts: node.config.charts.map(pick id/title/type), tables: node.config.tables.map(pick id/title/mode) }` —
  structure only, no BigQuery fetch (that would break `docs`'s "touches
  no live resource except the final Drive write" property).

This whole step is pure and synchronous, so it's Layer-1-testable in Node
exactly like `compileModel` already is.

## 4. Rendering — reusing `publish.js`'s design system, one additive change to the board script

`src/docs.js`'s `renderDocsHtml(payload)` calls straight into pieces
already declared in `src/publish.js` — same build closure
(`CLAUDE.md`'s "modules share one closure"), no export needed: `REPORT_CSS`
(`src/publish.js:771`), `BOARD_CSS` (`:834`), `THEME_TOGGLE_HTML`/
`THEME_TOGGLE_JS` (`:1593`/`:1570`), `BOARD_LAYOUT_CLIENT_JS` (`:1439`),
`BOARD_CLIENT_JS` (`:1525`), and the D3 `<script>` tag
(`D3_CDN_URL`/`D3_CDN_INTEGRITY`, `:29`/`:39`).

**The wrinkle:** `BOARD_LAYOUT_CLIENT_JS` positions nodes with
`d3.stratify()`/`d3.tree()`, which requires a tree (one parent per node,
via each block's `relatesTo`) — but a node's real `dependsOn` is a
general DAG (a model can depend on several upstreams). Positioning and
edge-drawing are already two independent steps in that script (`:1444-1461`
builds the tree and sets `style.left`/`style.top`; `:1462` builds `edges`
separately and `:1473-1483` draws them from live element offsets) — so
the fix is to keep tree-based positioning for layout purposes only, and
supply the *real* multi-parent edges as data, not derive them from the
same single-parent field. Two additive, backward-compatible one-line
changes:

```js
// :1441-1442, was:
'  var payload = window.__PUBLISH_PAYLOAD__;',
'  var blocks = payload.charts.concat(payload.tables);',
// becomes:
'  var blocks = window.__BOARD_NODES__;',
```

```js
// :1462, was:
'  var edges = blocks.filter(function (b) { return b.relatesTo; }).map(function (b) { return { from: b.relatesTo, to: b.id }; });',
// becomes:
'  var edges = window.__BOARD_EDGES__ || blocks.filter(function (b) { return b.relatesTo; }).map(function (b) { return { from: b.relatesTo, to: b.id }; });',
```

`renderReportHtml` (`src/publish.js:1622`) gains one additive line,
emitted whenever `isBoardLayout` (right next to where it already emits
`window.__PUBLISH_PAYLOAD__`): `window.__BOARD_NODES__ =
window.__PUBLISH_PAYLOAD__.charts.concat(window.__PUBLISH_PAYLOAD__.tables).map(function (b) { return { id: b.id, relatesTo: b.relatesTo }; });`.
`window.__PUBLISH_PAYLOAD__` itself is untouched — `CHART_CLIENT_JS`/
`TABLE_CLIENT_JS`/filter scripts still read the full payload for their
own rendering, only the layout script's data source changes name.
`window.__BOARD_EDGES__` is never set by `publish`, so its board output
is byte-for-byte unchanged (the `||` fallback keeps the exact same
`relatesTo`-derived edges it draws today) — the risk to `publish`'s
existing, already-Layer-2-verified board is limited to this rename, not
a behavior change.

`renderDocsHtml` sets both globals itself, built server-side from real
data:

```js
window.__BOARD_NODES__ = [ /* one { id, relatesTo } per node; relatesTo = dependsOn[0] || null — positioning only */ ];
window.__BOARD_EDGES__ = [ /* one { from, to } per real dependsOn entry — every dependency, not just the first */ ];
```

Each board box shows the node's name + a kind badge; clicking it expands
`detail` inline in the box, reusing `.board-node`'s existing resize/
overflow CSS (`src/publish.js:838`) — no modal, since unlike `publish`'s
`detail` drilldown there's no separate row-level dataset to open.

## 5. Write target

Reuses `resolveDriveWriteTarget`/`writeDriveText` (`src/move.js:824`/
`:837`), the same primitive `writeManifestFile` (`src/cli.js:891`)
already crosses the `move`/`cli` module boundary for. `resolveManifestFolderId`
(`src/cli.js:783`) is renamed to `resolveDefaultDriveFolderId` — a pure
rename, both existing call sites in `writeManifestFile` updated — since
its behavior ("given folderId, use it; otherwise use the script's own
parent Drive folder, or Drive root") is no longer manifest-specific once
`docs` calls it too:

```js
function runDocsCommand(nodes, folderId) {
  var payload = buildDocsPayload(nodes);
  var html = renderDocsHtml(payload);
  var target = { folderId: folderId || resolveDefaultDriveFolderId(null), fileName: 'notsobigdata-docs.html', upsertByName: true };
  var fileId = resolveDriveWriteTarget(target);
  fileId = writeDriveText(fileId, target, html, MimeType.HTML);
  Logger.log('cli("docs") written to ' + fileId);
  return { ok: true, command: 'docs', fileId: fileId, nodes: payload };
}
```

`fileName` is fixed (`'notsobigdata-docs.html'`) with `upsertByName: true`
(`src/move.js:800-812`'s existing find-or-create-by-name path) — every
`cli('docs')` overwrites the same file, the same "regenerate in place"
behavior `dbt docs generate` has for its `index.html`. No per-project
naming, matching this spec's "fixed filename" decision.

## 6. Testing

**Layer 1 (`test/docs.test.js`, Node, headless):**
- `buildDocsPayload` fixtures: a `move` node's `sourceType`/`targetType`
  round-trip, a `model` node's `compiledSql` matches what
  `cli('compile --select <name>')` already returns for the same fixture,
  a `model` with intentionally-broken SQL produces `compiledSqlError`
  instead of throwing, a `publish` node's `charts`/`tables` are
  structure-only (no rows).
- `renderDocsHtml` fixture: emitted HTML contains one `.board-node` per
  node and a `window.__BOARD_EDGES__` entry per real `dependsOn` pair
  (including a node with two upstreams, to prove multi-parent edges
  survive — something `publish`'s own `relatesTo`-only board can't
  exercise).
- `publish` regression fixture: an existing board-layout `renderReportHtml`
  fixture's output is byte-for-byte unchanged except for the one new
  `window.__BOARD_NODES__ = ...` line — guards the §4 rename against
  silently changing `publish`'s shipped behavior.

**Layer 2 (`notsobigtests`, human-run):** a fixture project with a small
multi-parent DAG (a model depending on two upstream `move` nodes) runs
`cli('docs')`, and a human verifies: the file lands in the resolved
folder (default, and again with `--folder-id`), dark-mode toggle works,
pan/zoom works, and — the part Layer 1 can't see — the two real edges
into the multi-parent node render correctly even though only one of them
is the tree's positioning edge.

## 7. Docs impact

- New `docs/cli.md` section for `docs` (no config keys — just the
  `--folder-id` flag and the fixed output filename), linked from
  README's command list.
- New `src/docs.md`, same tier as `src/publish.md`/`src/move.md`: the
  positioning-vs-real-edges split (§4) is exactly the kind of "internal
  rationale worth preserving for whoever touches this next" `CLAUDE.md`'s
  documentation section calls out.
- `src/publish.md` gets a short note on `window.__BOARD_NODES__`/
  `window.__BOARD_EDGES__` existing as a second, generic entry point into
  the board layout script, so a future change to `BOARD_LAYOUT_CLIENT_JS`
  doesn't assume `publish` is its only caller.

## What this doesn't change

No new node `kind` (`EXECUTORS` is untouched), no new declarative
metadata on `move`/`model`/`publish` configs, no change to `publish`'s
own schema, validation, chart/table/filter/detail-drilldown behavior, or
its board's visual output for any existing report. `run`/`list`/
`compile`/`debug`/`sources`/`hello`/`help` are all unaffected by `docs`
joining `COMMANDS`.
