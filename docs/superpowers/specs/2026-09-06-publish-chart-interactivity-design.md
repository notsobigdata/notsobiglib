# `publish` charts — cross-chart interactivity (Phase 2) — design

Phase 2 of the two-phase D3 chart engine initiative started in
`docs/superpowers/specs/2026-09-06-publish-d3-charts-design.md` (Phase 1:
D3 render engine, `bar`/`line`/`pie`, grouped/stacked bar — shipped and
merged). This spec covers **only** client-side, visual, opt-in
highlighting between charts on the same generated report — clicking a
bar/slice/point in one chart dims everything on the page that doesn't
match, in every other chart that opted into the same linking key.

It also finally resolves the `filters`/`linkTo` items deferred twice now
(first in `docs/superpowers/specs/2026-09-05-publish-kind-design.md`'s
"Future direction", then explicitly folded into "Phase 2" by the Phase 1
spec's "Relationship to filters/linkTo" section): this phase does **not**
build a dropdown filter UI or cross-file navigation. It builds the
narrower, purely-visual mechanism the brainstorming for this spec settled
on instead. A future `filters[]` (a dropdown that recomputes KPIs/charts/
tables against the underlying rows) and `linkTo` (cross-file navigation)
remain separate future work, not renamed pieces of this spec — see
"Future direction" below for why they're now cleanly separable from this
phase instead of overlapping with it the way Phase 1 worried they might.

## 1. Purpose and non-goals

Today (post-Phase-1), every chart on a `publish` report renders and
behaves independently — clicking one does nothing to any other. The
user's original ambition when choosing D3 (`docs/superpowers/specs/
2026-09-06-publish-d3-charts-design.md`, "alto nível de interatividade
entre charts dentro de um mesmo html") was for charts on the same report
to visually connect: selecting a category in one chart should make that
same category jump out everywhere else it appears.

This phase adds exactly that, and nothing past it:

- Clicking a bar/slice/point in a chart that declares a linking key
  selects a value.
- Every other chart that declares a **matching** linking key dims every
  element that doesn't match the selection, leaving matching elements at
  full opacity — including in the very chart that was clicked.
- Clicking the same element again clears the selection (everything
  returns to full opacity).

Explicitly **not** in scope for this phase:
- **No recomputation.** KPI values, chart totals, and table rows never
  change when a selection is made — only opacity. This was a deliberate
  choice (see brainstorming: "apenas destacar (highlight)" over "cross-
  filter completo") specifically to avoid needing raw rows in the
  client-side payload or a client-side re-aggregation engine — both real
  scope jumps this phase doesn't need.
- **KPIs and `tables[]` never participate.** They are not dimmed, not
  filtered, not referenced by the selection mechanism at all. Purely a
  chart-to-chart mechanism, per the same brainstorming decision.
- **No `filters[]` dropdown UI.** A future phase may build one on top of
  this mechanism's `currentSelection` concept, but this phase ships no
  dropdown, no query-string state, no `linkTo` cross-file navigation.
- **No default/implicit linking.** A chart that declares neither
  `linkKey` nor `seriesLinkKey` never highlights and is never
  highlighted by another chart's selection — opt-in only, no "same
  `groupBy` field name" inference. Two charts sharing a field name by
  coincidence (e.g. both happen to group by `category_name`) do **not**
  auto-link; the report author must declare the same `linkKey` string on
  both.
- **No cross-key inference or validation that two `linkKey`s "mean the
  same thing".** `linkKey`/`seriesLinkKey` are opaque strings compared
  for equality only. If two unrelated charts are accidentally given the
  same `linkKey`, they will highlight each other on any value that
  happens to match as a string — this is a known, undetectable-by-the-
  library consequence of the opt-in design, not a bug (see §6).

## 2. Schema

```ts
charts?: {
  // ...all Phase 1 fields unchanged (id, type, title, groupBy, metric,
  // series, stacking, donut)...

  linkKey?: string;        // any chart type. The "logical dimension name"
                           // this chart's groupBy represents. Two charts
                           // sharing the same linkKey string are treated
                           // as "the same dimension" for highlighting,
                           // regardless of their actual BigQuery field
                           // names.

  seriesLinkKey?: string;  // 'bar' + 'series' only. Same idea, for the
                           // series dimension of a grouped/stacked bar.
}[];
```

- Both fields are optional strings. Neither has a default — a chart with
  neither field is inert with respect to this feature: it never adds
  click handlers, never highlights, never gets highlighted.
- `seriesLinkKey` present on a chart that is not `type: 'bar'` with
  `series` set → throws at validation time, same "unexpected/misplaced
  field throws" convention `series`/`stacking`/`donut` already
  established in Phase 1's `validatePublishConfig`.
- `linkKey` has no such restriction — every chart type's `groupBy`
  dimension can participate.

Worked example — three charts sharing `category`, one stacked chart also
linking on `order_id` as its series dimension, one chart left
unlinked:

```javascript
charts: [
  { id: 'by_category', type: 'bar', title: 'Revenue by category',
    groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkKey: 'category' },
  { id: 'share', type: 'pie', title: 'Share by category', donut: true,
    groupBy: 'category', metric: { agg: 'sum', field: 'revenue' },
    linkKey: 'category' },
  { id: 'by_category_order', type: 'bar', title: 'By category and order',
    groupBy: 'category', series: 'order_id', stacking: 'stacked',
    metric: { agg: 'sum', field: 'revenue' },
    linkKey: 'category', seriesLinkKey: 'order_id' },
  { id: 'trend', type: 'line', title: 'Revenue by day',
    groupBy: 'order_date', metric: { agg: 'sum', field: 'revenue' } }
  // no linkKey - "trend" never reacts to, or triggers, a selection
]
```

## 3. Selection model and matching (client-side only)

One page-level selection state, `currentSelection` — either `null` or a
plain object mapping linking-key name to the selected value, e.g.
`{ category: "Beverages" }` (a plain click) or
`{ category: "Beverages", order_id: "42" }` (a stacked-segment click,
carrying both dimensions at once — a combined AND selection, not two
independent ones, per the brainstorming decision).

**Selecting:** clicking an interactive element (belongs to a chart with
`linkKey` and/or `seriesLinkKey`) replaces `currentSelection` with the
key/value pair(s) that element represents:
- Plain bar/pie/line element → `{ [chart.linkKey]: d.groupValue }` (only
  if `chart.linkKey` is set; if not, the element isn't interactive at
  all and gets no click handler).
- Grouped/stacked bar segment → `{ [chart.linkKey]: d.groupValue,
  [chart.seriesLinkKey]: d.seriesKey }`, using whichever of the two keys
  the chart actually declared (a stacked chart could in principle
  declare only one of the two, in which case only that one key is set).

**Clearing:** clicking the currently-selected element again sets
`currentSelection` back to `null`. This is a strict identity check
against the exact key/value pairs just computed for that element, not
"clicking anywhere" — clicking a *different* element (even in the same
chart) replaces the selection rather than clearing it.

**Applying:** after every change to `currentSelection`, `applyHighlight()`
walks every chart that declared at least one of `linkKey`/`seriesLinkKey`
and, for each of its already-rendered elements, computes that element's
own key/value pair(s) the same way a click on it would. An element is
"matching" when **every one of the chart's own declared keys** that is
also present in `currentSelection` agrees in value:

- A chart declaring only `linkKey` checks just that key. If
  `currentSelection.category === "Beverages"`, its "Beverages" elements
  get full opacity, everything else on that chart dims — the selection's
  `order_id` entry (if present) is irrelevant to this chart, since it
  never declared `seriesLinkKey`.
- A chart declaring both `linkKey` and `seriesLinkKey` requires **both**
  to match for full opacity — a stacked chart only lights up the exact
  (category, order_id) segment, not every segment belonging to
  "Beverages".
- A chart with none of its declared keys present in `currentSelection`
  (including every chart when `currentSelection` is `null`, and every
  chart with neither key declared at all) is left untouched — full
  opacity, no dimming, no click handlers if it declared no keys at all.

Dimming is `.style("opacity", <dimmed|1>)` on the already-drawn D3
elements — no re-render, no new data-join, nothing recomputed. Cheap
enough to run on every click with no debouncing needed at any realistic
chart size.

## 4. Render and wiring

No change to `renderReportHtml`'s chart mount markup (still an empty
`<div class="chart-canvas">` per chart — see Phase 1 spec §5).
`buildChartPayload` gains a pure passthrough: `linkKey`/`seriesLinkKey`,
when present on `chart`, are copied verbatim onto the chart's payload
object. No new aggregation, no change to existing payload shapes beyond
these two optional new fields — payload computation stays as pure as
Phase 1 left it.

In `CHART_CLIENT_JS`:
- `drawBarChart`/`drawLineChart`/`drawPieChart` each gain, only when
  `chart.linkKey || chart.seriesLinkKey` is truthy: `cursor: pointer`
  styling and a `.on("click", ...)` handler on the chart's data-bound
  elements, wired to the selection logic in §3. A chart declaring
  neither field gets zero added listeners and zero added styling —
  pixel-identical to Phase 1's output.
- A new small selection module (module-level `currentSelection` plus
  `applyHighlight()`) is added once, shared by every chart's click
  handler and run once more on initial page load (a no-op when
  `currentSelection` starts `null`, but keeps the "run once after every
  state change" invariant simple rather than special-casing the first
  render).
- The `typeof d3 === 'undefined'` fallback path (`renderChartFallback`,
  the plain `<ul>`) is untouched — there are no chart elements to attach
  a click handler to in that path, so it stays exactly as static as
  Phase 1 left it.

KPI cards and `tables[]` rendering are completely untouched by this
phase — no new markup, no new JS reads their sections.

## 5. Validation

`validatePublishConfig`'s chart loop gains one new check, following the
existing `series`/`stacking`/`donut` pattern:

- `seriesLinkKey` present when `chart.type !== 'bar'` or `chart.series`
  is not set → throw (`publish(): chart "<id>" has "seriesLinkKey",
  which only "bar" charts with "series" support.`).
- `linkKey` has no cross-field restriction — valid on every chart type,
  no throw case beyond "must be a string if present" (not itself
  enforced beyond JS's normal type coercion, same posture every other
  string config field in this file already has — e.g. `chart.title`).

## 6. Known limitation (documented, not guarded against)

`linkKey`/`seriesLinkKey` are opaque strings compared only for equality.
The library cannot know whether two charts declaring the same `linkKey`
actually represent the same real-world dimension — if a report author
gives two unrelated charts the same `linkKey` by mistake (e.g. one
grouping by `category` and another by an unrelated field that happens to
share some string values), clicking one will highlight coincidentally-
matching values in the other with no error, since there is nothing
inherently wrong from the library's point of view. `docs/publish.md`
documents this as "linkKey values must actually mean the same thing —
the library can't check this for you," the same posture already taken
for the grouped/stacked bar "no legend" gap in Phase 1.

## 7. Docs and build impact

- `docs/publish.md`: `charts[]` section gains a `linkKey`/
  `seriesLinkKey` subsection with the worked example from §2, plus the
  known-limitation note from §6. "What's not here yet" updates to name
  this phase as shipped and `filters[]`/`linkTo` as the remaining future
  work (see §8).
- `src/publish.md`: dev-notes addition on the selection/matching model
  (§3) — specifically why matching is "chart's own declared keys only",
  not the selection's full key set, since that's the one piece of logic
  future maintainers are likeliest to get backwards.
- No `README.md` change needed — the "charts need internet to view"
  correction already landed in Phase 1; this phase adds no new
  offline-behavior change.
- No new file added to `build.sh`'s `MODULES` manifest — stays within
  the existing `src/publish.js`.

## 8. Testing

**Layer 1 (Node):**
- `buildChartPayload` passthrough test: a chart config with
  `linkKey`/`seriesLinkKey` produces a payload carrying both fields
  unchanged; a chart config with neither produces a payload with neither
  key present (not `undefined`-valued — genuinely absent, so
  `renderReportHtml`'s "does this chart need a click handler" check has
  a clean truthy check to make).
- `validatePublishConfig`: new failing-config fixture + test for
  `seriesLinkKey` on a non-bar or non-series chart (§5), mirroring the
  existing `chartSeriesOnNonBarPublish`-style fixtures.
- `renderReportHtml`/`CHART_CLIENT_JS`: regex-checked for the click-
  handler/highlight-dispatch code being present in the emitted script
  exactly once per report (not once per interactive chart — it's one
  shared module), and for the "must declare a key to get pointer cursor
  and a click handler" logic being present as source — same ceiling
  every existing `CHART_CLIENT_JS` test already accepts (real click
  behavior can't be proven without a browser).

**Layer 2 (`notsobigtests`, human-run):** a fixture with the four charts
from §2's worked example (three linked on `category`, one linked
additionally on `order_id` as its series, one left unlinked). `testLog`
asks a human to, in a real browser: click a bar/slice on any
`category`-linked chart and confirm the other `category`-linked charts
dim to the matching value while the unlinked `trend` chart is
unaffected; click a segment on the stacked chart and confirm only the
exact (category, order_id) pair lights up elsewhere — other segments
that share the `category` but not the `order_id` stay dimmed; click the
same element again and confirm everything returns to full opacity.

## Future direction (not designed here)

`filters[]` (a dropdown or similar control that recomputes KPIs/charts/
tables against the underlying rows, not just dims already-rendered
elements) and `linkTo` (cross-file navigation with query-string filter
propagation) remain future work, each still needing its own
brainstorming pass. This phase's `currentSelection` concept and its
"chart declares the keys it understands" pattern are reusable
groundwork for a future `filters[]` (a dropdown could simply set
`currentSelection` the same way a click does), but that reuse is not
designed or committed to here. `scatter` and any chart type needing
per-point interactivity beyond click-to-select (zoom, brushing,
tooltips over many points), `expandable`/`detail` drill-down, per-block
`source` override, and `layout: 'board'` all remain out of scope, per
the same "still needs its own brainstorming pass" convention the Phase 1
spec already applied to each of these.
