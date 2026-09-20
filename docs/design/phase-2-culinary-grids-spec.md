# OmniHost.ai — Phase 2 visual surfaces: the 3-tier recipe editor and the BOM costing grid

**Status:** design specification. Written in Phase 1 because these two screens decide what
the *grid* pattern has to be (`docs/design/pattern-spec.md` §11) and because Phase 1's
article carries the recipe reference they fill. Phase 2 (Culinary) implements it.

**Why these screens get their own spec.** Every other master in Phase 1 is a form, and a form
is the right answer. A recipe is not: it is a *structure* (a finished good drawing on a
semi-finished good drawing on raw materials), a *calculation* (quantity × unit cost, adjusted
for prep loss, divided by portions), and a *provenance problem* (every cost has a source, a
date and a currency, and half of them are supplied by someone other than the person reading
the number). An ordinary form fails here in three specific ways, and this document exists to
avoid all three:

1. it hides the structure, so nobody can see that a sauce is costed three levels down;
2. it shows a total without saying which lines are missing from it;
3. it lets a unit be typed that cannot be converted, and then silently costs the line as zero.

**PRD anchors used throughout**

- *"Recipe management is a three-tier bill of materials: raw materials combine into an
  optional semi-finished good (a batch-prepared base or sauce), and finished goods — the
  sellable articles — draw on either directly."*
- *"Every recipe line carries a quantity and an expected yield/wastage percentage (trimming,
  cooking loss), so the theoretical cost of a finished good is the sum of its components'
  standard cost, adjusted for wastage."*
- *"A recipe version locks to the article version it costs, so re-costing history stays
  accurate even after the recipe changes."*
- *"Recipe builder (fallback grid screen) — for multi-level recipes with several semi-finished
  goods, used when the structure is too deep for chat."* and the simplified chatbot path for a
  single-level recipe.
- Tier table: *"Recipe & article management — Manual, single-level (Silver) / Full 3-tier BOM +
  versioning + AI costing suggestions (Gold)"*, with `recipe_full_bom` and `ai_recipe_costing`
  already in the `feature` registry.

---

## 1. The model in one page

| table | key fields | notes |
|---|---|---|
| `recipe` | `id`, `chainId`, `code`, `name` (per-locale content), `kind` (`finished_good`/`semi_finished`), `outputsArticleId?` (FG) or `outputsRawMaterialId?` (SFG), `status`, `version`, `versionOf`, `effectiveFrom` | a recipe belongs to an **article** (finished good) or produces a **raw material** (semi-finished good, because an SFG is held in stock under a raw-material record — one place where stock lives, not two) |
| `recipe_version` | `version`, `status` (`draft`/`pending_review`/`active`/`superseded`), `articleVersionId?` (the pin the PRD requires), `yieldQty` + `yieldUom` (batch output), `portionSize` + `portionUom`, `portionCount` (derived), `costedAt` (the cost snapshot instant), `costedByVersion` (component cost versions used), `approvedBy`, `approvedAt` | the unit of work: **a recipe version is edited, reviewed and approved as a whole** |
| `recipe_line` | `id`, `versionId`, `lineNo`, `componentKind` (`raw_material`/`semi_finished`), `rawMaterialId?`, `recipeId?`, `netQty` + `uom`, `wastagePct`, `wastageBasis` (`on_net`/`on_gross`), `lossNote`, `sortOrder` | one line = one component at one level |
| `recipe_cost_line` (derived, materialised) | `versionId`, `lineId`, `baseQty`, `baseUom`, `unitCost` (money), `unitCostSource`, `unitCostAsOf`, `grossQty`, `lineCost` (money), `currency`, `conversionRuleId?` | written when a version is costed; **never hand-edited** — it is what makes a past cost reproducible |
| `uom_conversion` | (§10 of the Phase 1 MDM spec) | the conversion graph the grid resolves through, per jurisdiction |
| `raw_material_cost` | `rawMaterialId`, `amount` (money), `effectiveFrom`, `source`, `vendorId?` | the effective-dated standard cost the grid reads; a *stale* one is shown as stale, not silently used |

**Two semantics that must be data, not a developer's assumption:**

- **`wastageBasis`.** The PRD says cost is *"adjusted for wastage"* without saying which way.
  This spec stores both: `netQty` is what the dish needs; `grossQty` is what must be issued.
  With `on_net`, `grossQty = netQty / (1 − wastagePct/100)` — the trimming-loss reading, and
  the default, because a 20 % trim on a tomato means you buy 1.25 kg for 1 kg net. With
  `on_gross`, `grossQty = netQty × (1 + wastagePct/100)`. The basis is stored per line and
  shown in the grid as the formula it applied (`×1.25` / `+20%`), because two sites arguing
  about a 4 % cost difference will otherwise be arguing about this.
- **Depth.** Three tiers exactly, as the PRD defines: **raw material → semi-finished good →
  finished good**. A recipe of `kind: semi_finished` may contain raw materials only; a
  `finished_good` recipe may contain raw materials and semi-finished goods. A deeper nesting
  is **refused at the line** (`culinary.conflict.depthExceeded`) with the two ways out named:
  flatten the intermediate batch, or model it as a semi-finished good. Depth is never silently
  truncated, and the refusal says which component caused it.

---

## 2. Screen layout

One route per recipe, addressed by code: `/culinary/recipes/REC-0031`, with the article path
`/mdm/articles/ART-1042` linking into the recipe that costs it (and the recipe linking back).
The screen is the same record shell as any master (pattern spec §10): header, sticky action
bar, panels. What differs is the body.

```text
┌ REC-0031  Paneer Tikka Masala · v4 · draft ────────────── [ Silver/Gold tier note ] ┐
│ costs article ART-1042 (v7) · yields 2.400 kg · 6 portions · currency INR           │
├───────────────┬─────────────────────────────────────────────────────────────────────┤
│ VIEW  Grid │ Tree        § conflicts 2 lines uncosted — see the panel below        │
├───────────────┴─────────────────────────────────────────────────────────────────────┤
│ ConflictPanel: missing price (line 6) · unconvertible unit (line 3)  [Fix] / [Ask] │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ EditableGrid                                                                        │
│  # │ component            │ tier │ net qty │ UOM │ → base   │ waste │ gross │ unit   │
│    │                      │      │         │     │ (derived)│       │(derived)│ cost  │
│  1 │ RM-0042 tomato        │ RM   │  1.500  │ kg  │ 1,500 g  │ 12% ▸ │ 1.705 │ 62.00 │
│  2 │ RM-0110 cream         │ RM   │  0.200  │ L   │   200 ml │  0%   │ 0.200 │ 210.00│
│  3 │ RM-0198 kasuri methi  │ RM   │  0.010  │ ✽  │  uncosted│  —    │  —    │  —    │
│  4 │ SFG-0007 tikka base   │ SFG  │  0.400  │ kg  │   400 g  │  0%   │ 0.400 │ 148.30│
│  …  │                      │      │         │     │          │       │       │       │
│  + add component  (Tab from the last cell adds a line)                              │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ CostSummary: batch INR 1,284.60 · per portion INR 214.10 · 2 of 6 lines costed  ▲   │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ Tree (the other view)                                                                │
│  ▾ ART-1042 Paneer Tikka Masala                 INR 214.10 / portion   ████ 100%    │
│    ├ RM-0042 tomato                    1.705 kg issue    INR  105.71    ██   8.2%   │
│    ├ ▾ SFG-0007 tikka base (REC-0018)  0.400 kg          INR   59.32    █   4.6%   │
│    │   ├ RM-0031 onion                 0.900 kg          INR   22.50                 │
│    │   └ RM-0044 yoghurt               0.500 kg          INR   36.82                 │
│    └ …                                                                               │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Two views, one draft.** `Grid` is the editable flat list of the *selected* recipe's lines.
  `Tree` is the structure: any node shows its own cost and its share of the finished good, and
  a semi-finished node expands in place to a nested grid — rendered by the same `EditableGrid`
  component, one instance per open node. Switching views keeps the active line and the scroll
  anchor, so `Alt+1` / `Alt+2` is a toggle, not a context loss.
- **The Tree is the genuinely visual surface** and the reason the PRD keeps a screen path at
  all: depth, contribution and structure are things a table of numbers cannot show. The
  contribution bar grows from the **start** edge (`--indent-step`, logical padding) so it
  mirrors in RTL, and it is never the only encoding of its value — the percentage is a
  tabular number beside it.
- **The nested grid is not a second editor**: a semi-finished node's lines are the *same*
  `recipe_line` rows of the semi-finished recipe, so editing them here edits REC-0018, and the
  header of the nested grid says so with a link (`editing REC-0018 v2, used by 4 recipes`).
  Editing another recipe's version from inside this screen is a permission of its own
  (`culinary.recipe.update` on that recipe, chain-scoped) — the nesting does not launder it.
- **Tier note.** Silver (`recipe_full_bom` off) gets a `finished_good` recipe with raw
  materials only: the SFG rows are absent, the Tree view collapses to a flat list with an
  honest one-line explanation of what Gold adds (`culinary.tierNote`). The screen is not
  removed or disabled; the depth is.

---

## 3. Grid interaction model (extends pattern spec §11)

Everything in pattern spec §11 applies — roving tabindex, `role="grid"`, derived cells
`aria-readonly` and skipped by `Tab`, `Tab` from the last cell creating a line, `Enter`/`F2`/
`Escape`, TSV paste, dirty markers, one Save as one mutation, per-line keyed server errors.
What is *additional* on a recipe grid:

| key | behaviour |
|---|---|
| type in the **component** cell | opens the reference search (type-ahead) — the same `RecordPicker` as everywhere else, searching raw materials *and* semi-finished goods, grouped by kind, excluding inactive records, and blocked from offering a component that would exceed the depth rule |
| `Alt+ArrowDown` on the component cell | opens the picker without typing; results show code · name · base UOM · **latest standard cost and its date** — a component whose cost is stale is marked in the list, because choosing it is the moment that matters |
| `Alt+E` on a semi-finished line | toggles **explode** (read-only, flattened raw materials multiplied through the tree). The exploded rows are visibly read-only (`aria-readonly`, dashed rule, a `derived` badge) and are excluded from the editable grid's Save — exploding is an inspection, never an edit surface |
| `Alt+N` on the component cell | creates the component in this line's position, only if the caller holds the create permission for that master; opens the create flow and returns with the new record selected (pattern spec §12's rule) |
| `Alt+ArrowUp/Down` | reorders the line (`sortOrder`); costs do not change, but the order is part of the version's content and is audited with the version |
| `Alt+W` | toggles the `wastageBasis` of the working line between `on_net` and `on_gross`, showing how the gross quantity moved |
| `Alt+C` | opens the *Cost basis* disclosure of the working line (pattern spec §11's `ConversionDisclosure` plus the cost provenance: source, vendor, date, currency, pinning) |

**Duplicate components.** The same raw material twice in one recipe is a **warning**, not an
error (two additions of the same thing in different stages is legitimate, and blocking it
would teach operators to invent a fake second material). The row carries a `duplicate` badge
with an offer to merge, and merging is refused unless the two lines' UOMs convert —
otherwise it is a conflict, not a merge.

**Paste and import.** A recipe can be pasted from a spreadsheet (component code, quantity,
UOM, waste %), and a whole recipe can be imported through the same import surface as any
master (Phase 1 MDM spec §13), because a chain migrating from another system will have its
recipes in a file. Import validation runs the same rules: unknown component codes, units that
cannot convert, depth violations and cycles all come back as keyed per-row errors.

**Scale.** Recipes run to tens of lines, not thousands; the grid still virtualises above 200
rows so the same component is honest at both ends. The Tree view lazily expands: a large
finished good with 12 semi-finished components does not cost 12 nested grids on open — each
node is costed on demand from the materialised `recipe_cost_line` rows, so a collapsed tree is
cheap and an expanded node is exact.

---

## 4. Cost roll-up: what is shown, and what a total is allowed to mean

**The maths, stated once, because operators check it:**

```
per line:   baseQty    = convert(netQty, fromUom → component base UOM, jurisdiction rule)
            grossQty   = wastageBasis == on_net    ? baseQty / (1 − wastagePct/100)
                                                   : baseQty × (1 + wastagePct/100)
            lineCost   = grossQty × unitCost(component, effective at costedAt)
semi-finished: unitCost(SFG) = batchCost(SFG recipe version) / yieldQty(SFG)
batch:      recipeCost = Σ lineCost           (per currency)
per portion: portionCost = recipeCost / portionCount,  portionCount = yieldQty / portionSize
share:      lineShare  = lineCost / recipeCost
```

Each of these is displayed, not just computed: gross quantity, line cost, share, batch total
and per-portion cost are all columns or summary figures, because a chef disputes a number, not
a formula.

**`CostSummary` — the sticky footer.** Everything in it is server-computed (pattern spec §11),
and it carries five things beyond the total:

| shown | why |
|---|---|
| batch cost, **per currency**, grouped when components are in more than one currency | a mixed-currency total is refused (`culinary.conflict.currencyMismatch`), never summed |
| per-portion cost (with the portion size and UOM) — the number a menu price is set from | this is the number the whole screen exists to produce |
| **completeness**: `{costed} of {total} lines costed` with a link to the first uncosted line | a total that silently omits lines is the failure mode this spec exists to prevent. When every line is costed it says so explicitly, so "no warning" is not mistaken for "complete" |
| cost basis: `as of {timestamp}` (locale-aware, in the viewer's zone), the version that was pinned, and who approved it | a cost without a date is a rumour |
| **drift**: the pinned cost at approval versus the cost of the same version at today's standard costs, with the difference and its sign | the PRD's variance is Phase 3's theoretical-vs-actual; this is the cheaper, earlier one — "the recipe you approved now costs 6 % more" — and it is what makes a stale cost visible before a margin does. It is labelled as a *standard-cost drift*, explicitly not the COGS variance, so nobody confuses the two |

**Rounding and currency.** Amounts are stored unrounded and displayed at the currency's ISO
4217 minor-unit exponent (JPY 0, INR 2, KWD 3) — never a hardcoded 2 — using the UOM/currency
rounding rule; a total is the rounded sum of unrounded lines, and where the two differ by a
minor unit the grid shows the sum of rounded lines as well, because that is the figure that
will appear on an invoice. `MoneyValue` renders amount + code everywhere; the code is in the
cell or in the column header, and a mixed-currency column repeats it per cell.

**Staleness.** A `unitCost` older than the chain's configured age (a `chain_setting`, not a
constant) is marked `stale` — tone, shape and the word, with the age and a link to refresh.
Stale lines still cost (an operator needs a number today) and they are counted in
`CostSummary` (`2 lines use a cost older than 90 days`), so the decision to refresh is
informed and never automatic.

---

## 5. Unit conversion, as shown on this screen

- **A `converted quantity` column** (`→ base`) is always present and always derived: it is the
  line's net quantity expressed in the component's base UOM, rendered with the UOM code
  (`1,500 g`). This single column removes the most common costing argument, which is whether
  the number the operator typed is in kilograms or grams.
- **`ConversionDisclosure`** (a popover on the cell, keyboard-reachable via `Alt+C`, and the
  same content in the cell's `title`): `from → to`, the factor, the exact row that resolved it
  (platform/chain, universal/market-specific), the jurisdiction it applied, and the effective
  window of that rule. A costing dispute is settled by this disclosure or not at all.
- **Ambiguity is a conflict, not a guess.** Where two non-universal conversion rules match the
  site's jurisdiction (a `CUP` defined differently in two markets the chain reaches), the cell
  shows `ambiguous` and the disclosure asks which rule applies. Choosing one **pins** the rule
  to the line (`conversionRuleId`), so the version's cost stays reproducible, and the pin is
  audited. The grid never picks the first match silently.
- **Cross-dimension conversion is refused** (`culinary.conflict.dimensionMismatch`): a line
  whose UOM has a different dimension from the component's base UOM (a mass component
  measured in `ml`) is uncosted with both codes named and the two ways out: change the UOM, or
  define a conversion if the dimension is actually right. Guessing here is how a costing
  becomes fiction.
- **Display precision is a domain rule**: a `pc` component refuses `1.5`, a `kg` component
  keeps three decimals. Locale affects grouping and the decimal separator, never the number of
  meaningful decimals (Phase 1 MDM spec §10.1).

---

## 6. Conflicts: the surface that makes this screen honest

One `ConflictPanel` directly under the view switch, plus a marker on every affected line. Each
conflict row states four things, in this order: **what** · **where** (line number, field) ·
**what it blocks** · **what can be done about it, by *this* viewer**.

| kind | where it comes from | what it blocks | affordances (permission) |
|---|---|---|---|
| `missingPrice` | the component has no effective standard cost at the version's `costedAt` | the line is uncosted; the article cannot be `active` on recipe-derived cost | *Add a quoted price* (`mdm.raw_material.cost.update`, financial, threshold approval when above the configured value, reason required) · *Link a vendor item price* (`mdm.raw_material.update`) · *Ask Purchase* (raised as a ticket to the Purchase Team, `support.*` — available to everyone, which is the honest path for a role that cannot write a cost) |
| `unconvertibleUnit` | no conversion path between the line UOM and the component base UOM | the line is uncosted | *Change the UOM* (`culinary.recipe.update`) · *Define the conversion* (`mdm.uom.conversion.update`) · *Ask MDM* (ticket) |
| `ambiguousConversion` | two market rules match | the line is uncosted until pinned | *Pin the rule* (`culinary.recipe.update`) with the two rules shown side by side |
| `dimensionMismatch` | UOM dimension differs from the component's base | the line is uncosted | as `unconvertibleUnit` |
| `missingAllergen` | a component (leaf) has no allergen declaration, so the derived allergen set of the finished good is incomplete | **the article cannot go `active`** (FSSAI's rule, per the jurisdiction profile) | *Declare it now* (`mdm.raw_material.update`) or `mdm.raw_material.propose`) with the allergen picker inline · *Ask MDM/Culinary* (ticket). The derived set is then recomputed and the panel row disappears |
| `missingTaxClass` | the article this recipe costs has no tax class in a traded jurisdiction | the article cannot go `active`; the per-portion cost is still shown | *Set the tax class* — a link into the article's compliance matrix, because that is where the rule lives |
| `depthExceeded` | a semi-finished component contains a semi-finished component | the line and everything under it | *Flatten* · *Remodel as a semi-finished good* (documented in §1) |
| `cycle` | a recipe references itself through a chain of components | the whole version: saving is refused | *Open the cycle* — the panel names every node in the loop with links, so the operator can see which link to break |
| `currencyMismatch` | component costs in more than one currency | a single batch total | *Show totals per currency* is the automatic behaviour; *convert explicitly* is Phase 3+ (needs a dated FX row) and is not offered before it exists |
| `duplicateComponent` | the same component on two lines | nothing (a warning) | *Merge lines* (refused if the UOMs do not convert) · *Keep both* with a note |
| `staleCost` | the cost basis is older than the configured age | nothing | *Refresh from vendor item* (`mdm.raw_material.cost.update`) · *Keep and note* |
| `articleVersionUnpinned` | the recipe is not yet pinned to an article version (the PRD's rule) | approval to `active` | *Pin to the current article version* (`culinary.recipe.approve` at approval time; the pin is recorded, not guessed) |

**Rules that make the panel trustworthy:**

1. **A conflict never hides a line and never blocks editing** — only costing, submission or
   approval. The operator can always finish their typing; what they cannot do is get a
   *false* total or push a version forward that is not costed.
2. **Every conflict has at least one affordance available to every role that can see the
   screen.** *Ask* (a ticket to the role that owns the field) is that affordance. A role that
   cannot fix it must still be able to act, or the honest alternative is to lie about
   completeness — which is the failure this whole panel exists to prevent. Each *ask* records
   who asked, what for, and links back to the exact line.
3. **Uncosted is a state, not a zero.** The line shows `uncosted` with the reason; it never
   contributes `0.00`, because a zero is indistinguishable from a genuinely free component.
4. **The count is in the header and in `CostSummary`**, so a reviewer sees the state before
   reading a single number, and the same count appears on the recipe list row and on the
   article's compliance view.
5. **A resolved conflict leaves a trace**: the panel row collapses to `resolved by <actor>
   <timestamp>` for the session, and the audit log has the underlying change.

---

## 7. Reachability by chatbot (designed now, built with the gateway)

Nothing on this screen is screen-only. Every mutation is a registered action, so the chatbot
reaches the same domain function, under the same server-side permission check, and produces
the same audit row.

| capability | action code | example intent (PRD's own wording where it exists) | how it renders in chat |
|---|---|---|---|
| read a recipe's cost | `culinary.recipe.view` (query) | "What does the paneer tikka masala cost per portion?" | a text answer with the money amount + currency, the portions, the cost basis date, and one line saying how many lines were uncosted |
| list components | `culinary.recipe.view` | "What's in the tikka base?" | ≤ 4 lines inline; more offers *open in the grid* with the link |
| create a simple recipe (slot-filling) | `culinary.recipe.create` | *"add a recipe for grilled sandwich: bread 2pc, cheese 30g, butter 10g"* — the PRD's simplified path | slot-fill component → quantity → UOM, one at a time, then a **confirm card** (pattern spec §8) restating the lines and the resulting per-portion cost before it commits |
| change a quantity or waste % | `culinary.recipe.update` | "Make the cream 250 ml in REC-0031" | confirm card showing `before → after`, the new line cost, **the changed per-portion cost**, and the conflict count after the change |
| add a component at depth | `culinary.recipe.update` | "Add 400 g tikka base to REC-0031" | if the addition would exceed the depth rule, the bot refuses with the reason and the two ways out rather than proposing it |
| check before costing | `culinary.recipe.cost.check` (query) | "Is the tikka recipe fully costed?" | the conflict list as text: kind, line, what it blocks |
| submit / approve | `culinary.recipe.submit`, `culinary.recipe.approve` | "Send REC-0031 for approval" | maker–checker: the card routes to the Culinary Head's own inbox, never the author's (PRD guardrail) |
| override a cost | `mdm.raw_material.cost.update` (financial) | "Cost the kasuri methi at 480 a kilo for this recipe" | **confirm-only**: a card that restates the amount + currency, the effective date, the source (`manual`), the reason, that it is audited and attributed, and the threshold approval it needs. Never slot-filled, never silent |
| ask for a fix | `support.ticket.raise` | "Ask MDM to define the cup conversion" | opens the ticket with the line attached |

**What the chatbot may never do**: commit an uncosted recipe, approve its own author's
version, pick a conversion rule silently, drop a conflict from a summary it reports, or state
a batch total that omits uncosted lines without saying so. A summary the model produces from
unstructured text is not the source of these numbers — the card is built from the same domain
response the screen renders (Phase 0's rule, restated).

---

## 8. Accessibility, RTL and expansion on these particular screens

- **Every figure is text.** Contribution bars, depth rails and conflict markers are decoration
  over a real number that is present, tabular (`num`), and read in the right order. Nothing
  here relies on a chart being seen.
- **The Tree is navigable by keyboard as a tree** (`role="tree"`/`treeitem` with
  `aria-expanded`, `aria-level`), with `Arrow` navigation independent of the grid: `Alt+1/2`
  switches view, and switching back restores the grid's active cell.
- **RTL**: depth padding is `padding-inline-start: calc(var(--indent-step) * level)`; the
  contribution bar grows from the start edge; the `→` in the conversion column is a
  direction-neutral glyph and the column header carries the meaning, so no icon flips
  incorrectly; `MoneyValue`'s bidi isolation keeps a negative line cost reading correctly
  inside an Arabic paragraph.
- **Expansion**: `Alt+N`, `Alt+E`, `Alt+C`, `Alt+W` and the column headers are all translated
  strings — headers wrap to two lines, the *component* column takes the extra width and never
  truncates a name, and the keys are shown in a help popover from the catalog
  (`culinary.keys.*`) rather than baked into on-screen text that would overflow in German.
- **Announcements**: adding, removing, reordering or exploding a line announces the change and
  the new conflict count via `aria-live="polite"`; a conflict that appears as a result of an
  edit is announced, because a change in the total with no explanation is the worst kind of
  silent update.
- **Reduced motion**: expanding a tree node and recosting animates nothing mutably; totals
  update without a transition under `prefers-reduced-motion`.

---

## 9. Audit for these surfaces

One audit row per mutation, as everywhere, plus the fields that make a costing reviewable:

- `culinary.recipe.update` → `before`/`after` are the **line diff** (added/removed/changed
  lines with their component codes), not the whole recipe; `source` is `screen` or `chatbot`
  (or `import`), `intent` is recorded for a chat-driven change.
- `culinary.recipe.submit` / `.approve` → the version, the pinned `articleVersionId`, the
  approver, and the cost snapshot (`costedAt`, batch total, per-portion cost, per currency)
  **as it was at approval**. The number a menu price was set from must be recoverable years
  later.
- `mdm.raw_material.cost.update` → effective-dated close-and-open (Phase 1 MDM spec §8.2) with
  the reason, so a manual cost can always be told apart from a vendor price.
- `culinary.conflict.resolve` → when a conflict is resolved by pinning a conversion rule or
  choosing an override, the resolution itself is audited with the rule that was pinned.
- The **compliance override** (Phase 1 MDM spec §14, the audited way to activate an article
  with a missing required field) is attributed to the person who took it and sits on the MDM
  exception list; the recipe screen shows it as a banner rather than pretending the article is
  clean.

---

## 10. Permissions this spec proposes for Phase 2

Same registry shape as Phase 1 (code, module, name, description, action_kind, layer,
requires_site_scope, check_function, financial_or_stock, implemented_in).

| code | kind | scope | notes |
|---|---|---|---|
| `culinary.recipe.view` | query | tenant | read a recipe, its structure and its cost |
| `culinary.recipe.search` | query | tenant | the picker and chatbot read |
| `culinary.recipe.create` | mutation | tenant | including the chatbot's slot-filled simple recipe |
| `culinary.recipe.update` | mutation | tenant | lines, quantities, waste, order, pins |
| `culinary.recipe.propose` | mutation | tenant, **site-scoped where a site variant is raised** | a Site Culinary Team proposal still needs central sign-off (PRD) |
| `culinary.recipe.submit` | mutation | tenant | draft → pending review |
| `culinary.recipe.approve` | mutation | tenant | Culinary Head only; self-approval refused (`mdm.approve.self`) |
| `culinary.recipe.cost.check` | query | tenant | the conflict list — its own code so a reviewer without write access can still be given the check |
| `culinary.recipe.deactivate` | mutation | tenant | a recipe version is superseded, never deleted; deactivation carries a reason |
| `culinary.cost.override` | mutation | tenant, **financial** | writing a manual cost from inside the recipe screen; carries a reason and lands on the price-change audit trail. Where the change is above the configured threshold it additionally needs `mdm.approve.threshold` |

Role mapping: `CENTRAL_CULINARY_TEAM` and `SITE_CULINARY_TEAM` hold create/update/propose/
submit/view/check (a site team's proposals are site-scoped, per the PRD's dotted-line model);
`CENTRAL_CULINARY_HEAD` adds `approve`; MDM holds the cost and UOM codes that the conflict
affordances call, which is why the panel's *Fix* buttons resolve per viewer rather than
existing for everyone.

---

## 11. States on this screen

| state | what it looks like |
|---|---|
| loading | the grid skeleton with the real column rhythm, plus the summary in a `skeleton` block — never a spinner over an empty page |
| empty (no recipes in scope) | "No recipes yet. Culinary drafts a recipe against an article." — and for a Silver chain, one line naming what Gold adds |
| empty (recipe with no lines) | an honest empty grid with the add-line affordance focused |
| filtered / not-applicable | a `finished_good` recipe with all lines inactive: the lines stay visible, marked `inactive`, with the conflict count and the reason |
| error | the server's own message as `detail`, with retry; a cycle is a named error, not a generic failure |
| refused | `PermissionDenied` naming `culinary.recipe.approve` (or the cost code) and the reason, with the *ask* affordance available because that is the action a refused operator actually has |
| tier-limited | the tier line, naming `recipe_full_bom` and the tier, with no disabled ghost buttons |
| offline / stale read | the mobile app's read of a recipe is a cache with a timestamp; the grid is not editable offline for a *costed* version, because a cost that changed on the server must not be saved back over (Phase 6's mobile surface, stated here so the domain function's contract is not designed around a browser) |

---

## 12. Definition of done for the Phase 2 build

- A `finished_good` recipe can hold raw materials and semi-finished goods; a
  `semi_finished` one can hold raw materials; a deeper structure is refused with the reason
  and the two ways out, and never silently truncated.
- The costing maths in §4 is implemented once, in the domain, and the grid renders its
  output; the screen computes no total of its own.
- `CostSummary` always states completeness (`{costed} of {total}`), the cost basis timestamp,
  the currency (grouped when mixed) and the drift against the pinned approval cost. There is
  no code path that renders a total without those.
- An uncosted line is never rendered as `0.00`, in the grid, the tree, an export or a chatbot
  answer.
- Every conflict in §6 is detectable, keyed, attributed to a line, and has at least one
  affordance for every role that can view the screen.
- Conversion resolution follows the documented order (chain → platform, market-specific
  before universal), reports the winning rule in a disclosure, and refuses to guess when two
  rules match.
- The version pins to an article version and to a cost basis at approval, and both are
  recoverable from the audit log after the fact.
- The chatbot's simplified recipe path produces a confirm card with the resulting per-portion
  cost, commits through `culinary.recipe.create`, and cannot bypass a conflict that blocks
  approval.
- `ar-XB` mirrors the tree, the bars and the summary; `en-XA` does not truncate a header or a
  component name; no money value renders without its ISO code; no user-visible string literal
  exists in either screen.

---

## 13. Open questions for the lead and the owner

1. **Wastage basis default** — this spec defaults to `on_net` (trimming loss). Confirm with
   the pilot chain's culinary lead, since it shifts every cost in one direction.
2. **Semi-finished goods as raw materials.** I have modelled an SFG as a raw-material record
   that a recipe produces, so stock lives in one place. The alternative (a separate SFG entity)
   gives a cleaner name and a second stock model. Proposal: keep one stock model; flag it if
   the store ledger expects otherwise in Phase 3.
3. **Standard-cost drift threshold and stale age** — proposed as `chain_setting` definitions
   (default 90 days). Needs an owner figure for the first chain, and it is not a constant.
4. **Cost override breadth** — whether `culinary.cost.override` should exist at all, or whether
   every manual cost must go through MDM. Proposal: keep it, financial, with a reason and a
   threshold approval, because a live quote at 6 pm on a Friday is real and the alternative is
   an operator costing with yesterday's price.
5. **Portion size vs portion count** — I derive portions from `yieldQty / portionSize`, with
   both stored. If a chain plates by portion count rather than by weight, the stored fields
   should be `portionCount` and a derived size; confirm with the pilot chain.
6. **Menu price context on the costing screen.** Showing the article's selling price next to
   its portion cost (a margin figure) is trivially useful and commercially sensitive. Proposal:
   show it to the Culinary Head and MDM Head, not to every site team member, gated by a
   permission rather than by a `if` in the component.
