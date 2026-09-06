# `publish` charts — D3 render engine (Phase 1) — design

Phase 1 of a two-phase initiative. This spec covers **only** swapping
`charts[]`'s render engine from hand-rolled SVG to D3 and widening the
type catalog (`bar`/`line`/`pie`, plus a `series` option on `bar` for
grouped/stacked). It deliberately does **not** cover cross-chart
interactivity (one chart reacting to another's click/selection within
the same file) — that is Phase 2, a separate spec, built on top of
whatever this phase ships. It also supersedes the originally-scoped
`filters`/`linkTo` bundle from
`docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s "Future
direction": those two turned out to overlap heavily with Phase 2's
cross-chart interactivity (a filter dropdown and a chart-click
selection are both "some interaction reconfigures multiple blocks at
once"), so they get redesigned as part of Phase 2 rather than shipped
standalone first. See "Relationship to filters/linkTo" below.

## 1. Purpose and non-goals

`charts[]` today supports exactly one chart type (`bar`), rendered as
hand-authored SVG (`renderBarChartSvg`) at generation time — static
markup, no JS required to see it, no external dependency. This phase
replaces that render path with D3 (loaded from a pinned-version CDN
URL) so more chart types (`line`, `pie`/donut, grouped/stacked `bar`)
are cheap to add — D3's `d3-shape` module already ships `arc()`,
`pie()`, `stack()`, and `line()` generators built for exactly these
shapes, so nothing beyond a config-to-D3-call translation is needed
per type.

**This is a deliberate, permanent break from `publish`'s original "no
CDN, works offline forever" promise** (stated in
`docs/publish.md`, this repo's README, and the v1 design spec's non-
goals). The decision, made explicitly during brainstorming: every
`publish` report, not just ones using new chart types, now requires
internet access **at the moment a human opens the generated `.html`
file** in order to see any chart. Generation itself (Apps
Script/BigQuery, `cli('run')`, including unattended scheduled runs)
is unaffected — it never touches the CDN; only the *viewer's browser*,
later, fetches D3. KPIs and `tables[]` are untouched by this and keep
rendering with zero external dependency.

Non-goals for this phase:
- Cross-chart interactivity / linked selection (Phase 2).
- `filters[]` / `linkTo` as originally scoped (folded into Phase 2 —
  see below).
- `scatter` and any chart type needing per-point interactivity (zoom,
  brushing, tooltips over many points) — flagged during brainstorming
  as the point where a charting library actually starts paying for
  itself beyond what this phase needs; deferred to whenever Phase 2 or
  a later phase has a concrete driver for it.
- Per-report opt-out of the CDN dependency (a `renderer: 'inline'` vs
  `'cdn'` flag was considered and explicitly rejected in favor of one
  render path for every report — see brainstorming notes).

### Relationship to filters/linkTo

The original v1 spec deferred `filters` (a dropdown that recomputes
KPIs/charts/tables together) and `linkTo` (a chart bar linking to
another published file, propagating the clicked value via query
string) as their own future items. Brainstorming this D3 phase
surfaced that "click on chart A, chart B reacts" (Phase 2's
cross-chart interactivity) and "pick a value in a dropdown, everything
reacts" (`filters`) are the same underlying mechanism — a shared
selection/filter state that every block re-renders against — just
triggered two different ways (a click vs. a dropdown). Building
`filters`/`linkTo` now, ahead of Phase 2, risked two competing
implementations of that mechanism. They are not abandoned — they will
be re-scoped as part of Phase 2's design once this phase's D3
foundation exists to build the shared state/re-render mechanism on top
of.

## 2. Schema

```ts
charts?: {
  id: string;
  type: 'bar' | 'line' | 'pie';
  title: string;
  groupBy: string;                                  // x-axis / category dimension
  metric: { agg: 'sum' | 'avg' | 'count' | 'count_distinct'; field?: string };

  series?: string;      // 'bar' only — 2nd dimension, enables grouped/stacked
  stacking?: 'grouped' | 'stacked';  // only meaningful with series; default 'grouped'

  donut?: boolean;      // 'pie' only; default false
}[];
```

- `bar` without `series` is unchanged behavior from today (same
  `groupBy`/`metric`), only the render engine changes.
- `bar` with `series` groups by **two** dimensions (`groupBy` = x-axis
  category, `series` = the stacked/grouped-by dimension) instead of
  one. `stacking` picks the visual (side-by-side bars per group vs.
  stacked segments); meaningless without `series`.
- `line` reuses the exact same `groupBy`/`metric` aggregation as
  plain `bar` — the only difference is result ordering (see §4).
- `pie` reuses the exact same `groupBy`/`metric` aggregation as plain
  `bar` too; `donut: true` only changes the arc's inner radius at
  render time, not the computed data.
- `metric.agg` already accepts `count_distinct` today (`computeAggregate`
  handles it generically for every caller, `charts[]` included) — no
  schema change needed there, just noting it's available for the new
  types too.

Worked example:

```javascript
var salesPublish = {
  kind: 'publish',
  dependsOn: ['dailyRevenueModel'],
  source: { type: 'ref', ref: 'dailyRevenueModel' },
  target: { type: 'drive', folderId: props.REPORTS_FOLDER, fileName: 'sales.html', upsertByName: true },
  charts: [
    { id: 'by_category', type: 'pie', title: 'Share by category',
      groupBy: 'category_name', metric: { agg: 'sum', field: 'revenue' }, donut: true },
    { id: 'trend', type: 'line', title: 'Revenue by day',
      groupBy: 'order_date', metric: { agg: 'sum', field: 'revenue' } },
    { id: 'by_category_and_channel', type: 'bar', title: 'Revenue by category and channel',
      groupBy: 'category_name', series: 'channel', stacking: 'stacked',
      metric: { agg: 'sum', field: 'revenue' } }
  ]
};
```

## 3. Library choice and loading

**D3**, loaded once from a version-pinned CDN URL
(`https://cdnjs.cloudflare.com/ajax/libs/d3/<exact-version>/d3.min.js`
— the exact version is picked and pinned at implementation time, never
a floating tag like `d3.v7.min.js`). Rationale, from brainstorming
(also weighed and rejected: Chart.js, p5.js/canvas, a declarative
grammar library, a hybrid opt-in CDN flag):

- `d3-shape`'s `arc()`/`pie()`/`stack()`/`line()` generators natively
  cover all three types this phase needs (including grouped/stacked
  bar) without a second library.
- D3 renders SVG/DOM elements, so the existing `REPORT_CSS` design
  system (paper/ink/teal tokens, `.chart-bar`/`.chart-label` classes)
  carries over largely unchanged. Chart.js renders to `<canvas>`
  (pixels) — matching the same look would mean re-implementing styling
  as JS config per chart instead of reusing existing CSS.
- D3 selections/data-joins are the direct substrate Phase 2's
  cross-chart interactivity needs. Chart.js can be driven into a
  similar shape (recompute + `.update()`) but not as natively; p5.js
  has no data-binding or chart primitives at all — wrong category of
  tool for either phase.

**Never pin a floating major-version tag or an "unpkg latest" URL** —
same reasoning `CLAUDE.md` already documents for `notsobigjaffle`
pinning to a commit SHA rather than a `release/*` branch name: a file
reopened a year later must load the exact same D3 behavior it loaded
the day it was generated, not whatever the tag currently resolves to.

The `<script src="...">` tag is emitted in `<head>` only when
`payload.charts.length > 0` — same "zero added dependency when the
feature isn't used" rule `tables[]`'s pagination/CSV-export JS already
follows.

## 4. Payload computation (`buildReportPayload`)

No change to `kpis`/`tables[]` computation. For `charts[]`:

- Base case (no `series`): unchanged `groupRowsBy` + `computeAggregate`
  per group, same as today.
- `type === 'line'`: after aggregating, sort the resulting array
  ascending by `groupValue` — numeric-aware (`Number(a) - Number(b)`
  when both parse as numbers, else lexicographic string compare, which
  also sorts ISO-format date strings correctly). `bar`/`pie` keep
  today's "first-seen order", unchanged.
- `series` present: aggregate over **both** dimensions and pre-fill a
  **dense** matrix — every `(groupBy value × series value)`
  combination present in the output, zero where the source data has no
  matching rows — computed server-side so the client-side D3 stacking
  code never has to special-case a missing combination. Exact JSON
  shape (a list of group rows each carrying a per-series-key value
  map, plus the ordered list of series keys) is an implementation
  detail decided in the plan, not fixed here.

This step stays **pure** (no GAS globals), exactly like today — same
property that makes it unit-testable in Node without a browser (§7).

## 5. Render architecture

`renderReportHtml` changes per chart from emitting a finished `<svg>`
string to emitting an empty mount point:

```html
<section class="chart" data-chart-id="by_category">
  <h2>Share by category</h2>
  <div class="chart-canvas" id="chart-by_category"></div>
</section>
```

A new `CHART_CLIENT_JS` constant (same authoring pattern as the
existing `TABLE_CLIENT_JS`: an array of literal JS-source strings,
`.join('\n')`'d into the page) runs on `DOMContentLoaded`, reads
`payload.charts` back off `window.__PUBLISH_PAYLOAD__` (already
embedded, unchanged mechanism), and for each chart:

1. If `typeof d3 === 'undefined'` (CDN unreachable, or a corporate
   network stripped the script tag): replace `.chart-canvas`'s content
   with a plain `<ul>` of `label: formatted value` pairs, built with
   `createElement`/`textContent` only (same anti-`innerHTML`-on-
   payload-data rule `TABLE_CLIENT_JS` already follows). Not the
   chart, but the numbers stay visible instead of a blank area with no
   explanation.
2. Otherwise, dispatch on `chart.type` to one small draw function —
   `drawBarChart`/`drawLineChart`/`drawPieChart` (the `series`/
   `stacking` case is handled inside `drawBarChart`, not a fourth
   function, since it's still fundamentally a bar chart) — each using
   the relevant `d3-shape`/`d3-scale` generators to build SVG elements
   inside the mount point.

KPI cards are unaffected — they stay server-rendered static HTML text,
no chart engine involved.

## 6. Validation

`validatePublishConfig`'s existing chart-type check
(`chart.type !== 'bar'` → throw) widens to the new enum:

- `type` must be one of `'bar' | 'line' | 'pie'` (anything else throws,
  same "unexpected enum value throws" convention `resolveMaterialized`
  in `model.js` already sets).
- `series`/`stacking` present on a non-`'bar'` chart → throw (config
  error, not silently ignored).
- `donut` present on a non-`'pie'` chart → throw, same reasoning.
- `stacking`, if present, must be `'grouped'` or `'stacked'` — same
  enum-throw convention.

## 7. Docs and build impact

- `docs/publish.md`: the `charts[]` section rewritten for the new
  schema/types; the standalone-offline claim in the file's intro
  paragraph and "What's not here yet" no longer holds **for any**
  report with a non-empty `charts[]` — must say so plainly, not bury
  it in a footnote.
- `README.md`: the `publish` bullet's "no CDN, no build step" phrasing
  needs the same correction.
- `docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s non-goal
  language ("no CDN... likely ever without a specific driver") is now
  superseded by this spec for `charts[]` specifically — leave that
  file as historical record (specs aren't edited after the fact per
  this repo's convention), but `docs/publish.md` is the live doc that
  must reflect current reality.
- `src/publish.md`: new dev-notes section on why D3 was chosen over
  Chart.js/p5.js/a declarative grammar (condensed version of §3's
  rationale), and why payload computation stays pure/server-side in
  this phase (no client-side aggregation yet — that's Phase 2).
- No new file added to `build.sh`'s `MODULES` manifest — this is all
  within the existing `src/publish.js`.

## 8. Testing

**Layer 1 (Node):**
- `buildReportPayload`'s new pure logic — `line`'s numeric-aware sort,
  and the dense zero-filled matrix for `series` — gets real
  fixture-driven `assert` tests, same as existing KPI/chart aggregation
  tests. This is genuinely testable without a browser.
- `validatePublishConfig`'s new enum/cross-field checks (§6) each get a
  failing-config fixture + test, same pattern every existing
  `publish` validation check already follows.
- `renderReportHtml`'s output can only be regex-checked for the right
  static pieces (the pinned D3 `<script src>`, one `.chart-canvas` div
  per chart, the `CHART_CLIENT_JS` dispatch code, the `typeof d3 ===
  'undefined'` fallback branch) — same ceiling `TABLE_CLIENT_JS`
  already has; D3 actually drawing anything can't be proven without a
  real browser.

**Layer 2 (`notsobigtests`, human-run):** a fixture publishing one
chart of each new type (`line`, `pie` with `donut: true`, `bar` with
`series`/`stacking: 'stacked'`) against a small hand-computable
dataset. The test asserts the generated file has the right containers/
payload; a `testLog` note asks a human to open it in a real browser and
confirm all four chart types render correctly and match the expected
aggregates — same "click Next"/"click Export CSV" precedent already
established for things a GAS test can't drive itself. Also worth one
manual check with the D3 CDN URL blocked (e.g. via browser dev tools'
request-blocking) to confirm the `typeof d3 === 'undefined'` fallback
list actually appears instead of a blank chart area.

## Future direction (not designed here)

Phase 2 (cross-chart interactivity / linked selection within one file,
subsuming what `filters`/`linkTo` were originally going to be),
`scatter` and any other chart type needing per-point interactivity,
`expandable`/`detail` drill-down, per-block `source` override, and
`layout: 'board'` remain future work — each still gets its own
brainstorming pass, per this repo's established convention.
