# docs.js — private notes

> Working notes, not user documentation. docs/cli.md's `cli('docs')`
> section is the public reference for what the doc site shows; this file
> is about the code's internals and the rules you have to keep if you
> change it.

## What this module owns

Turning an already-discovered node list into one project doc site: a
plain-object payload (`buildDocsPayload`/`buildDocsDetail`), an HTML
string built from it (`renderDocsHtml`/`renderDocsNodeSection`/
`renderDocsDetailHtml`/`DOCS_CSS`), and the Drive write
(`runDocsCommand`). Same reasoning as `publish.js` being its own
module rather than folded into `cli.js`: one file, one responsibility
(turning a node list into a doc site), kept separate from `cli.js`'s own
job of discovering/ordering/running nodes. `cli.js`'s `docs` branch is
three lines — parse the flag, call `runDocsCommand`, log the result —
the same shallow-wrapper shape every other command's dispatch already
has.

`docs` reads only fields a node's own config already carries — no new
description/column-doc fields, no new node kind. If a future version
wants richer detail (a hand-written description per node, say), that's a
new declarative field on the existing kinds, not a reason to touch this
module's shape.

## Reuses `compileModel()`, never re-resolves `{{ ref() }}` itself

`buildDocsDetail`'s `model` branch calls `compileModel()` — the exact
function `cli('compile')` already calls — to get the SQL it displays.
Re-implementing `{{ ref() }}`/`{{ var() }}`/macro substitution here would
be a second copy of `model.js`'s templating logic that could drift out of
sync with the real one; a doc site showing SQL that doesn't match what
`cli('compile')` (or an actual `cli('run')`) would produce is worse than
not showing SQL at all.

A model's `{{ ref() }}`/`{{ var() }}` failing to resolve is already caught
at discovery time (`model.js`'s `expandModelNodes()` sets
`node.discoveryError`, and `node.config` is left as the discovery-time
placeholder `{ name: name }`) — `buildDocsPayload` checks
`node.discoveryError` before ever calling `buildDocsDetail`, so a
kind-specific branch never reads `materialized`/`projectId`/`source`/
`target` off that placeholder. The `try/catch` around `compileModel()`
inside `buildDocsDetail` is defense-in-depth for the rarer case a model
that *passed* discovery still throws when `compileModel()` itself runs
(`compiledSqlError`) — the same "`compileModelSql()` re-validates at run
time too" posture `model.md` already documents elsewhere, not a case with
its own dedicated fixture here.

## The positioning-vs-real-edges split

`renderDocsHtml` sets two client-side globals, both consumed by
`publish.js`'s `BOARD_LAYOUT_CLIENT_JS` (reused verbatim, same build
closure — see `CLAUDE.md`'s "One file to install, three files to
author"):

- `window.__BOARD_NODES__` — `{id, relatesTo}[]`, position-only.
  `relatesTo` here is `dependsOn[0]`, a synthetic single-parent link.
  `BOARD_LAYOUT_CLIENT_JS` needs exactly one parent per node to feed
  `d3.stratify()`/`d3.tree()` — a node's real dependencies can be a
  multi-parent DAG, but the tree layout algorithm only needs *a*
  reasonable position for each box, not the graph it's positioned to
  reflect.
- `window.__BOARD_EDGES__` — `{from, to}[]`, the real edges actually
  drawn: every `dependsOn` pair, not just the first. A node with two
  dependencies gets two edges pointing at it on screen, even though only
  one of them drove where its box landed.

This split exists because `publish.js`'s own board layout (`relatesTo`
on a chart/table) is genuinely single-parent by design — a chart's
`relatesTo` is one id, full stop — so `BOARD_LAYOUT_CLIENT_JS` originally
had no concept of "position from one thing, draw edges from a different,
richer thing." `docs` needed exactly that (a node's `dependsOn` can name
several nodes), so `BOARD_LAYOUT_CLIENT_JS` gained `window.__BOARD_EDGES__`
as a second, optional input rather than growing a `docs`-only parallel
copy of the whole layout script. See `src/publish.md`'s own note on
this for the other side of the reuse.

**Why this is safe for `publish()`'s own board output.** The edge-drawing
line falls back to the pre-existing `relatesTo`-only computation whenever
`window.__BOARD_EDGES__` is absent (`window.__BOARD_EDGES__ || blocks
.filter(...).map(...)`, `src/publish.js`), and `publish()`'s own emitted
script never sets that global — only `docs.js` does. So a `publish()`
report's generated HTML is byte-identical to before this change; the new
global is dead code from `publish()`'s point of view, not a
behind-the-scenes change to its output.

## Sidebar + detail drawer replaced the inline detail dump

Each board node used to have `renderDocsDetailHtml`'s output dumped
straight into its box in the graph itself — cramped, and unreadable once
metric-card-sized nodes (see `src/publish.md`'s "Board layout") replaced
the old fixed 520x340 boxes. `renderDocsHtml` now renders a
`.docs-sidebar` alongside the graph: a search input plus one
`.docs-kind-group` per kind (`Object.keys(DOCS_KIND_TOKEN)`, so a new
kind picks up its own group for free — no hand-maintained kind list to
keep in sync), each with a `(count)` and one `.docs-node-row` per node,
colored by the same `DOCS_KIND_TOKEN` var a node's kind-bar already
uses. A node's detail no longer lives in the graph at all — clicking
either a sidebar row or the node itself slides in `#docs-drawer`
(`position: fixed`, right edge of the viewport) showing that node's name
and detail HTML, dismissed by its own close button, Escape, or a click
outside the drawer/graph (mirrors `publish.js`'s expand-overlay dismissal
— see `src/publish.md`).

This is additive, not a rework: `buildDocsPayload`/`buildDocsDetail` are
untouched, still just building the same plain-object payload they always
did. `renderDocsHtml` embeds that detail as one new global,
`window.__DOCS_DETAIL_BY_NAME__` (`{ [node.name]: { html: ... } }`), which
`DOCS_DRAWER_CLIENT_JS` reads by name when a row/node is clicked — the
drawer is a client-side view onto data the server already had, not a new
per-node fetch.

## The `__test` back door

`buildDocsPayload`/`discoverNodesForTest`/`renderDocsHtml` are pure
functions with no `cli()`-level command of their own to call them through
in a Node test — `discoverNodesForTest` in particular just wraps
`discoverNodes()`, which `cli()` itself calls internally but never
exposes. `build.sh` appends a small `__test` object to the built
`NotSoBigData` return value (see its footer-writing step) exposing these
three functions directly, purely so `test/docs.test.js` has something to
call. It is never invoked by `cli()` itself and is not part of the
documented public API — `cli()` stays the library's one public
entrypoint; `__test` is a Layer-1 test seam, the same category of thing
as `test/harness.js`'s Node `vm` shim, not a second surface for a
consumer to build on. Don't reach for it to add user-facing behavior, and
don't be surprised it isn't mentioned in `docs/cli.md` — it's
deliberately absent from there.
