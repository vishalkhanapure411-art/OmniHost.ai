# The Chains record's five tabs — measured, palette B (10 Oct 2026)

**Status: measurement record, not a spec.** It closes one specific evidence gap named in the
PR #39 hand-over: the exemplar proved the browse list, the record's *default* tab, the
Settings screen's *default* pane and the onboard form, and left **Features, Sites & outlets,
History, and Settings' other two panes rendered for nobody's measurement** — the tabs the
owner will click first. Every number below comes from one run of the audit walker against the
workbench on 10 Oct 2026 (`generatedAt 2026-10-10T14:27:49Z`). Every screenshot in this set
is from that run, so a picture and its row always belong together.

## Method

| | |
|---|---|
| Instrument | `/home/team/shared/ux-audit/walk-audit.ts --only chains` (Bun, drives Chrome over CDP) |
| Subjects | 9 screens × 3 viewports = **27 measurements** |
| Viewports | 1440×900, 1280×800, 1024×768 (viewport height matters: the record panel's fold is its own) |
| Density | `omnihost.density=cozy` (the middle class; compact/roomy are not measured here) |
| Identity | `admin@omnihost.ai` (AppAdmin) — it **holds `chain.audit.read`**, so the History tab is *enabled*; the walk does not measure the disabled-with-reason state |
| Record | Coastal Catch Kitchens, `c6c76ca9-59d7-4e59-9ac8-e8f6fa23760e` — the first row of `/chains` |
| Writes | none. The walk reads; it signs in through `/api/session` and touches no data |

How each tab was reached — this is the part that decides whether a measurement exists at all:

* **Overview, Features, Sites & outlets, History** are real routes, so each was loaded at the
  URL its own tab navigates to (`/chains/{id}`, `/features`, `/sites`, `/history`). The tab bar
  is the same component on all four, so a URL is the tab.
* **Settings has three panes behind one URL**, held in component state, not the route. Each was
  reached by **activating its tab in the page** and the walk **verified the activation**
  (`aria-selected="true"` on the pane's own button, re-clicked until it took, because a click
  before hydration silently does nothing). The transcript records `tab=selected` for those rows;
  a pane that had not activated would have been recorded as unmeasured rather than shot anyway.

### Instrument changes made in this session

The first version of this walk could not have measured these tabs, and would have reported two
of them as *clean* when it had not looked:

1. **`screensFor("chains")` now lists every tab and sub-tab** (Overview, Features, Sites,
   History, Settings × sign-in / delegated / site-language, plus list and onboard).
2. **Tables are every `<table>`, not only `table.data-table`.** The Settings panes render plain
   `<table class="w-full border-collapse text-sm">`; the old selector found *no table* there, so
   "table overflow: none" was an absence of looking. The delegated-settings grid and the
   site-language table are measured here for the first time.
3. **Horizontal overflow is measured at all.** The scroller detector tested `overflowY` only, so
   a block cut off to the right — the exact defect of PR #36 — was invisible unless its table
   happened to be a `.data-table`. Both axes are now tested, and a separate `clipped` metric
   reports content hidden with **no scroll affordance** (overflow `hidden`/`clip` with content
   wider than the box), which is the defect class a scrollable panel is not.

## The numbers (27 rows, all measured)

`docPages` = page scroll in viewport-heights (1.00 = the page itself does not scroll).
`panel` = the tab panel's own scroll in panel-heights. `tables` = every table, with
`hidden` = columns the fit rule dropped and `ovf` = horizontal overflow in px of the table's
box. `clipped` = elements with content cut and no scrollbar (see finding 4).
`below` = interactive controls below the first fold *of the panel*.

| screen (screenshot `chains-b/<screen>-<w>x<h>.png`) | w | reached by | docPages | panel | tables (cols · hidden · ovf px) | clipped | below-fold |
|---|---|---|---|---|---|---|---|
| `chains-list` | 1440 | route | 1.00 | 1.00 | 8 cols · 0 hidden · 0px | 5 (all .sr-only) | 0/13 |
| `chains-list` | 1280 | route | 1.00 | 1.00 | 8 cols · 0 hidden · 0px | 5 (all .sr-only) | 0/13 |
| `chains-list` | 1024 | route | 1.00 | 1.00 | 8 cols · 0 hidden · 0px | 5 (all .sr-only) | 0/13 |
| `chains-overview` | 1440 | route | 1.00 | 1.00 | no table | 1 (all .sr-only) | 0/9 |
| `chains-overview` | 1280 | route | 1.00 | 1.00 | no table | 1 (all .sr-only) | 0/9 |
| `chains-overview` | 1024 | route | 1.00 | 1.00 | no table | 1 (all .sr-only) | 0/9 |
| `chains-features` | 1440 | route | 1.00 | 1.71 | 5 cols · 0 hidden · 0px | 2 (all .sr-only) | 7/24 |
| `chains-features` | 1280 | route | 1.00 | 1.97 | 5 cols · 0 hidden · 0px | 2 (all .sr-only) | 9/24 |
| `chains-features` | 1024 | route | 1.00 | 2.27 | 5 cols · 0 hidden · 0px | 2 (all .sr-only) | 10/24 |
| `chains-sites` | 1440 | route | 1.00 | 1.00 | 4 cols · 0 hidden · 0px | 2 (all .sr-only) | 0/6 |
| `chains-sites` | 1280 | route | 1.00 | 1.00 | 4 cols · 0 hidden · 0px | 2 (all .sr-only) | 0/6 |
| `chains-sites` | 1024 | route | 1.00 | 1.00 | 4 cols · 0 hidden · 0px | 2 (all .sr-only) | 0/6 |
| `chains-history` | 1440 | route | 1.00 | 1.00 | 7 cols · 0 hidden · 0px | 3 (all .sr-only) | 0/15 |
| `chains-history` | 1280 | route | 1.00 | 1.00 | 7 cols · 0 hidden · 0px | 3 (all .sr-only) | 0/15 |
| `chains-history` | 1024 | route | 1.00 | 1.00 | 7 cols · 0 hidden · 0px | 3 (all .sr-only) | 0/15 |
| `chains-settings-signin` | 1440 | route | 1.00 | 1.00 | no table | 1 (all .sr-only) | 0/14 |
| `chains-settings-signin` | 1280 | route | 1.00 | 1.00 | no table | 1 (all .sr-only) | 0/14 |
| `chains-settings-signin` | 1024 | route | 1.00 | 1.00 | no table | 1 (all .sr-only) | 0/14 |
| `chains-settings-delegated` | 1440 | selected | 1.00 | 1.09 | 7 cols · 0 hidden · 0px | 1 (all .sr-only) | 1/15 |
| `chains-settings-delegated` | 1280 | selected | 1.00 | 1.30 | 7 cols · 0 hidden · 0px | 1 (all .sr-only) | 2/15 |
| `chains-settings-delegated` | 1024 | selected | 1.00 | 1.64 | 7 cols · 0 hidden · 0px | 1 (all .sr-only) | 3/15 |
| `chains-settings-locale` | 1440 | selected | 1.00 | 1.00 | 4 cols · 0 hidden · 0px | 1 (all .sr-only) | 0/10 |
| `chains-settings-locale` | 1280 | selected | 1.00 | 1.00 | 4 cols · 0 hidden · 0px | 1 (all .sr-only) | 0/10 |
| `chains-settings-locale` | 1024 | selected | 1.00 | 1.00 | 4 cols · 0 hidden · 0px | 1 (all .sr-only) | 0/10 |
| `chains-onboard` | 1440 | route | 1.00 | 1.00 | no table | 1 (all .sr-only) | 0/8 |
| `chains-onboard` | 1280 | route | 1.00 | 1.00 | no table | 1 (all .sr-only) | 0/8 |
| `chains-onboard` | 1024 | route | 1.00 | 1.00 | no table | 1 (all .sr-only) | 0/8 |

Raw data: `/home/team/shared/ux-audit/chains-b-raw.json` (this run), transcript
`/home/team/shared/ux-audit/chains-tabs-run.log`, screenshots
`/home/team/shared/screenshots/chains-b/` (named `<screen>-<w>x<h>.png`, i.e. one file per row).

## Which tab is measured, and which is not

| Record tab | Measured? | Note |
|---|---|---|
| Overview (default) | **yes**, 3 widths | route |
| Features | **yes**, 3 widths | route |
| Sites & outlets | **yes**, 3 widths | route |
| History | **yes**, 3 widths | route; enabled for this identity |
| Settings → Sign-in / SSO (default) | **yes**, 3 widths | route |
| Settings → Delegated settings | **yes**, 3 widths | pane activated, `tab=selected` |
| Settings → Site language | **yes**, 3 widths | pane activated, `tab=selected` |

**Nothing is "not measured" for the reason of being unreachable**: no tab is disabled for this
identity, and no pane failed to activate. What is *not* measured is named below, and it is a
different list — widths the brief did not ask for, other identities, and interactive states.

## What the numbers say

1. **No page scroll, on any tab, at any width.** `docPages = 1.00` in all 27 rows. The record's
   header and tab bar stay pinned while the panel scrolls, which is the intended shape: the
   subject of the page (`Coastal Catch Kitchens`, its tier, its status) and its navigation never
   leave the screen.
2. **No horizontal clipping anywhere — and nothing was hidden to get there.** Every table in
   every row reports `ovf = 0` and `clipped-right = 0`, and **`hidden = 0`**: at 1024 the fit
   rule did not have to drop a single column. So the narrowest width measured shows the same
   columns as the widest, including the plain settings tables that were never measured before.
3. **Two panels scroll vertically, both by design.** Features (1.71 / 1.97 / **2.27** panel
   heights at 1440 / 1280 / 1024) and Settings → Delegated settings (1.09 / 1.30 / **1.64**).
   The scroller is the tab panel (`div.min-h-0.flex-1.overflow-y-auto`), so the content is
   reachable and the header stays put. The cost is the same at every width: on Features at 1024,
   **10 of 24 controls** are below the panel's first fold (the enable toggles); on Delegated
   settings, **3** "Change value" buttons. 18 features × ~72px is simply taller than a 625px
   panel — this is a dense grid behaving as a dense grid, not a defect, but it is the one
   number in this record an operator would feel.
4. **`clipped` = 0 blocks.** The metric fires only on `.sr-only` elements — the
   screen-reader-only pattern, which is a 1px box by construction: `label.sr-only "Interface
   language"` (+115px) on all nine screens, one `caption.sr-only` per table, `span.sr-only
   "STATE CHANGES"` on History. **No tab label is cut** (`isTabLabel` false on every row), and
   no visible text is ellipsis-truncated. Stated plainly because the raw count reads alarming
   and means the opposite.
5. **Raw identifiers that are deliberately on screen.** Features shows 16 feature codes
   (`executive_dashboards`, `native_login`, …) in mono under the human name; Delegated settings
   shows 6 setting keys (`approval_threshold`, `prep_time_sla_minutes`, …); History shows the
   entity type `chain_feature` and the role code `APP_ADMIN`. These are the *label-adjacent
   code* pattern, not leaks — but they are the same text class the MDM prep flags, so they are
   named here instead of left implicit. Nothing was found in the `uuid`, `i18n_key`,
   `iso_timestamp`, `undefined/null/NaN`, JSON-blob, SQL or stack-trace classes on any row.

## Not measured — and why a later session should care

* **Widths below 1024.** The fit rule's `data-hide-below` thresholds (32rem/40rem/48rem) are far
  below 1024, so at these widths nothing drops and therefore *nothing about the drop behaviour is
  proved*. A 768/640 pass is the one that would exercise it — and would prove whether the columns
  that disappear are the ones an operator needs.
* **The record as another identity.** `AppConfig` and `AppSupport` see fewer panes and the
  History tab disabled-with-reason. That state is drawn, not measured.
* **Interactive states:** the chevron row-expansion on the browse list, the History row drawer,
  the Settings panes' "Change value" dialogs and validation refusals. The brief for this session
  fixed the browse row's click/chevron decision, so nothing about it was changed *or* re-measured.
* **Density classes** compact and roomy; only cozy was walked.

## Reproduce

```bash
cd /home/team/shared/ux-audit
bun walk-audit.ts --only chains \
  --shots /home/team/shared/screenshots/chains-b \
  --out   /home/team/shared/ux-audit/chains-b-raw.json \
  --texts /home/team/shared/ux-audit/texts
```

The walk signs itself in (`admin@omnihost.ai`), reads the first chain's id from the browse list
by clicking its row, and writes one screenshot plus one JSON row per screen per viewport. It
writes nothing to the database. Two older runs are kept beside this one for traceability —
`chains-b-raw-1420Z-four-screen.json` (the four-screen run the PR #39 hand-over cited) and
`chains-b-raw-1426Z-instrument-v2.json` (the same nine screens before the `clipped` and
table-selector fixes) — so a reader can see what the fixes changed rather than take it on trust.
