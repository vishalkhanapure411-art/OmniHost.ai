# OmniHost.ai — Phase 1 master data (MDM) specification

**Status:** design specification for the Phase 1 build. Written for the engineer
implementing it, and reviewable by the lead and the owner. No application code here; the
patterns it relies on are in `docs/design/pattern-spec.md` §10–§18 and the tokens/components
are the existing ones in `src/styles/tokens.css` and `src/components/`.

**Sources this spec is derived from**

| source | what it settles here |
|---|---|
| `Documentation/Product Requirement Document/` (the PRD) | what each master contains (`Raw material master (MDM-owned)`, `Menu/Article Lifecycle & FSSAI-Compliant Display`), who owns it (`MDM is the one function with no site presence`), the article state machine, the mandatory allergen set, the tier table (`MDM governance: Basic master lists / Full approval-gated golden record`) |
| `/home/team/shared/DECISIONS.md` | Postgres, Razorpay behind an abstraction, pilot chain as a modelling reference only, tier **per chain**, international exposure in scope, the localisation non-negotiables |
| the Phase 0 code on `main` | the permission registry's shape (`permission` table + `requirePermission()`), the audit contract (`auditedMutation`), the message catalog, `site.locale`, `chain.tax_jurisdiction`, the seeded demo chains |
| `/home/team/shared/prd.txt` | the extracted text of the PRD, quoted where the wording matters |

**The owner has not supplied the pilot chain's real master data yet.** This spec is
therefore driven by the PRD's entity definitions and by the shape of the seeded demo data
(chain `saffron-table` — "Saffron Table Hospitality" — with sites `koramangala` and
`indiranagar`, and a second chain `coastal-catch`). §16 says what makes real data loadable
later without a redesign; nothing here is shaped around the demo values.

---

## 1. The model in one page

- **A golden record is chain-scoped.** Every MDM table carries `chain_id`, like every other
  tenant table. MDM has no site presence (PRD, role matrix), because its job is one
  chain-wide record: *"MDM Team validates and de-duplicates before it's usable anywhere in
  the chain"*. Site-varying things hang off a record as a sub-grid (per-outlet price, site
  par level), never as a second record with a different meaning.
- **MDM is a gate, not a form.** Two roles, deliberately different people:
  `CENTRAL_MDM_TEAM` executes and validates; `CENTRAL_MDM_HEAD` approves and owns the field
  definitions. Other functions *propose*: Purchase proposes a vendor, Culinary proposes a
  raw material and an article. The proposal path and the approval path are separate
  permissions (§3).
- **Records are versioned where the PRD says history matters.** An article and a recipe
  version; a tax rate row is effective-dated rather than edited; a vendor and a raw
  material keep a full audit trail and close-and-reopen rather than rewriting. *"Price or
  recipe changes create a new version rather than overwriting the old one, so a historical
  order keeps the figures it was actually sold under — required for accurate COGS."*
- **Required fields are per jurisdiction, and the jurisdiction profile is data.** FSSAI
  menu display is the first profile (`IN` / `IN-KA`), not a rule in code. A field the
  Indian profile requires is `optional` or `forbidden` elsewhere, and the interface says
  which (§15 of the pattern spec, §14 here).
- **Licence tier is on the chain record, never on a site** (owner-locked, Sept 2026).
  Nothing in this spec puts a tier on a site, an outlet or a master record. MDM's tier
  consequence is one feature flag, `mdm_approval_gated` (`feature` table, `min_tier: gold`):
  Silver gets **basic master lists** (the records, versioned and audited, single-level
  costing), Gold/Platinum get the **approval-gated golden record** (review workflow,
  de-duplication, full compliance matrix). A site record *displays* its chain's tier as a
  read-only value with a link to the chain — that display is not an editable field.
- **Every mutation is permission-checked server-side and audited in-transaction**, whether
  it arrived from a screen, a picker, an import or the chatbot. The chatbot is built later
  on the identical domain functions; designing the codes now is what makes that possible.
  A hidden control is never the control.

---

## 2. What is in Phase 1 and what is not

**In scope (this spec):** article (with the compliance fields), raw material, vendor, UOM
and UOM conversion, tax classes and rates per jurisdiction, site and outlet masters, the
allergen and nutrition reference data, the jurisdiction profile that says which fields a
market requires, and the import path that loads them.

**Deliberately out of scope, with the reason:**

| left out | why, and where it lands |
|---|---|
| recipe / BOM records and the costing maths | Phase 2 (Culinary). The *surfaces* it needs are specified now in `docs/design/phase-2-culinary-grids-spec.md`, because they inform the grid pattern (§11) and because Phase 1's article carries a recipe reference that Phase 2 fills. |
| per-site par levels, stock on hand, reorder points as *transactions* | Phase 3 (Store). Phase 1 holds `par_level` as a value on the raw material's site sub-grid so AI indenting has somewhere to read from; nothing posts to a ledger here. |
| vendor scorecards, price history analytics, GRN-based cost refresh | Phase 3 (Purchase/Store). Phase 1 records a standard cost and its source and date; the refresh is Phase 3's. |
| marketing content, offers, loyalty | Phase 4/6 and an open owner question (loyalty). |
| staff, shift and attendance masters | Phase 5 (Operations/Site Head). The staff record is a role+site assignment, not MDM data. |
| customer/guest records | never — guest ordering is Phase 6 and holds no chain-wide golden record. |
| a screen for the jurisdiction profile itself | the profile is loaded and reviewed in a read-only admin view (`/mdm/reference/jurisdictions`), with editing gated to the App layer (`mdm.jurisdiction.rule.update`). Chains select a jurisdiction; they do not write a market's legal requirements. |

---

## 3. Permissions: the registry additions

The existing registry (`permission` table, seeded in `db/seed.sql`) already carries the MDM
function's coarse codes generated from the function×suffix grid: **`mdm.view`,
`mdm.execute`, `mdm.propose`, `mdm.approve.threshold`, `mdm.policy.configure`**. They stay.
What Phase 1 adds is the **entity-level** set the screens, the picker and the chatbot
actually call, because "may execute MDM work" is not an answer to "may this person change a
vendor's bank details".

```sql
-- Phase 1 additions — shape matches the existing registry exactly:
-- code, module, name, description, action_kind, layer, requires_site_scope,
-- check_function, financial_or_stock, implemented_in
```

| code | kind | layer | site scope | fin./stock | name / why it exists |
|---|---|---|---|---|---|
| `mdm.article.view` | query | tenant | no | no | View an article record and its versions |
| `mdm.article.search` | query | tenant | no | no | Search articles (the picker's and the chatbot's read) |
| `mdm.article.propose` | mutation | tenant | no | no | Submit a new/changed article for review (Culinary's path) |
| `mdm.article.create` | mutation | tenant | no | no | Create an article directly (MDM Team) |
| `mdm.article.update` | mutation | tenant | no | no | Edit an article draft (non-financial fields) |
| `mdm.article.price.update` | mutation | tenant | no | **yes** | Change per-outlet price — financial, so confirm-before-commit and threshold approval |
| `mdm.article.approve` | mutation | tenant | no | no | Approve a version to `active` (MDM Head) |
| `mdm.article.deactivate` | mutation | tenant | no | no | Deactivate with a reason (pattern spec §14) |
| `mdm.article.reactivate` | mutation | tenant | no | no | Reactivate, separately audited |
| `mdm.article.import` | mutation | tenant | no | no | Bulk import articles |
| `mdm.raw_material.view` / `.search` | query | tenant | no | no | as above, raw materials |
| `mdm.raw_material.propose` | mutation | tenant | no | no | Culinary proposes a new raw material |
| `mdm.raw_material.create` / `.update` | mutation | tenant | no | no | MDM Team maintains the record |
| `mdm.raw_material.cost.update` | mutation | tenant | no | **yes** | Standard cost — financial, effective-dated, threshold approval |
| `mdm.raw_material.approve` | mutation | tenant | no | no | Approve (MDM Head) |
| `mdm.raw_material.deactivate` / `.reactivate` | mutation | tenant | no | no | §14 of the pattern spec |
| `mdm.raw_material.import` | mutation | tenant | no | no | Bulk import |
| `mdm.vendor.view` / `.search` | query | tenant | no | no | Vendor record / search |
| `mdm.vendor.propose` | mutation | tenant | no | no | Purchase proposes a vendor |
| `mdm.vendor.create` / `.update` | mutation | tenant | no | no | MDM Team maintains the record |
| `mdm.vendor.bank.view` | query | tenant | no | **yes** | Reveal remittance details — a separate, audited read |
| `mdm.vendor.bank.update` | mutation | tenant | no | **yes** | Change remittance details — never merged into a general update |
| `mdm.vendor.terms.update` | mutation | tenant | no | **yes** | Payment terms and billing currency |
| `mdm.vendor.approve` | mutation | tenant | no | no | Approve a vendor as usable on POs (MDM Head) |
| `mdm.vendor.suspend` / `.reactivate` | mutation | tenant | no | no | Suspend (no new POs) / reinstate — distinct from deactivate |
| `mdm.vendor.deactivate` | mutation | tenant | no | no | Deactivate with a reason |
| `mdm.vendor.import` | mutation | tenant | no | no | Bulk import |
| `mdm.uom.view` / `.search` | query | tenant | no | no | UOM reference and conversions |
| `mdm.uom.create` / `.update` | mutation | tenant | no | no | Add/rename a chain UOM (code and precision) |
| `mdm.uom.conversion.update` | mutation | tenant | no | no | Define/change a conversion factor — affects every cost, so it is its own code and its own audit row |
| `mdm.uom.import` | mutation | tenant | no | no | Bulk import a conversion table |
| `mdm.tax_class.view` | query | tenant | no | no | Tax classes and rate history |
| `mdm.tax_class.create` / `.update` | mutation | tenant | no | **yes** | Create/edit a class — a rate change is financial |
| `mdm.tax_class.rate.update` | mutation | tenant | no | **yes** | Open a new effective-dated rate row (never an in-place edit) |
| `mdm.tax_class.approve` | mutation | tenant | no | no | MDM Head approval of a rate change |
| `mdm.tax_class.deactivate` | mutation | tenant | no | no | Deactivate (blocked while referenced) |
| `mdm.site.view` / `.create` / `.update` | query/mutation | tenant | no | no | Site master (the site record is a chain-level golden record) |
| `mdm.site.deactivate` | mutation | tenant | no | no | Site closure is `status: closed`, never a delete |
| `mdm.site.import` | mutation | tenant | no | no | Bulk import sites and their outlets |
| `mdm.outlet.view` | query | tenant | no | no | Outlet master |
| `mdm.outlet.create` / `.update` | mutation | tenant | no | no | Outlet master (MDM Team; Site Head may *propose*) |
| `mdm.outlet.propose` | mutation | tenant | **yes** | no | A Site Head proposes an outlet change at their own site |
| `mdm.allergen.view` | query | tenant | no | no | Allergen reference + which are mandatory here |
| `mdm.allergen.chain.update` | mutation | tenant | no | no | A chain-only allergen (a proprietary blend) |
| `mdm.nutrient.view` | query | tenant | no | no | Nutrient reference |
| `mdm.nutrient.chain.update` | mutation | tenant | no | no | Chain-only nutrient declaration rows |
| `mdm.allergen.reference.update` | mutation | **app** | no | no | Curate the platform allergen set (AppAdmin / delegated AppConfig) |
| `mdm.nutrient.reference.update` | mutation | **app** | no | no | Curate the platform nutrient set |
| `mdm.jurisdiction.rule.update` | mutation | **app** | no | no | Curate a jurisdiction profile (which fields a market requires) |
| `mdm.approve.self` | — | — | — | — | *not a permission*: no one holds it. It is the name of the refusal reason when an author tries to approve their own version (§16 of the pattern spec) |

**How the coarse and fine codes combine (state this in the tests):**

1. The MDM section of the nav is offered from `mdm.view`. Opening a master record needs the
   entity `view` (`mdm.article.view`). A role holding only `mdm.view` sees the section and an
   empty-state that names the missing permission — the honest empty state from §2.
2. A write needs the entity code. A role holding `mdm.execute` but no entity code cannot
   write anything: `requirePermission()` refuses with
   `your roles (...) do not hold mdm.vendor.create`. That negative case is the test that
   proves the fine codes are real and not decoration.
3. A financial master change (`*.cost.update`, `*.price.update`, `*.rate.update`,
   `vendor.bank.*`, `vendor.terms.update`) additionally requires `mdm.approve.threshold`
   when the change exceeds the chain's configured threshold — the existing
   `chain_setting` machinery, not a new setting.
4. `layer: 'app'` codes are platform capabilities: a chain's own MDM Head cannot rewrite the
   allergen reference or a jurisdiction profile (extends the existing app/tenant rule in
   `authorise()`).

**Who holds what, by role** (seeded through `role_permission` for the two MDM roles and
through the proposal codes for the others; `scope_grant` remains the delegation mechanism):

| role | holds |
|---|---|
| `CENTRAL_MDM_TEAM` | every `mdm.*.view`/`.search`, `create`, `update`, `propose`, `import`, `deactivate`, `reactivate`, `bank.view`, plus `mdm.article.price.update`, `mdm.raw_material.cost.update`, `mdm.tax_class.rate.update`, `mdm.uom.conversion.update` (they prepare the change) |
| `CENTRAL_MDM_HEAD` | everything the Team holds **plus** every `*.approve`, `mdm.approve.threshold`, `vendor.bank.update`, `vendor.terms.update`, `mdm.jurisdiction.*` never (app layer) |
| `CENTRAL_CULINARY_TEAM` / `SITE_CULINARY_TEAM` | `mdm.article.view`/`.search`/`.propose`, `mdm.raw_material.view`/`.search`/`.propose`, `mdm.allergen.view`, `mdm.nutrient.view`, `mdm.uom.view` |
| `CENTRAL_CULINARY_HEAD` | the above plus `mdm.article.propose` for chain-wide variants and `mdm.raw_material.propose` at head-office level |
| `CENTRAL_PURCHASE_TEAM` / `SITE_PURCHASE_TEAM` | `mdm.vendor.view`/`.search`/`.propose`, `mdm.raw_material.view`, `mdm.uom.view`, `mdm.tax_class.view` |
| `CENTRAL_PURCHASE_HEAD` | the above plus `mdm.vendor.propose` |
| `SITE_HEAD` | `mdm.site.view`, `mdm.outlet.view`/`.propose`, `mdm.article.view`, `mdm.vendor.view` — a site head reads the golden record and proposes outlet changes; they never approve one |
| every other tenant role | the `*.view` codes for the masters their function reads (Culinary reads article + raw material; Store reads raw material + UOM; Marketing reads article + allergen), through the same `role_permission` upsert pattern the existing seed uses (`p.code like '%.view'` style) |

Delegated access into a chain's MDM data by `APP_SUPPORT`/`APP_CONFIG` stays what Phase 0
built: time-boxed, chain-scoped, expiring on its own, and audited on every read of a
financial field.

---

## 4. Message-catalog key namespaces

Every label, column header, badge, empty state, validation message and error in these
screens resolves through `t()`. New namespaces added by Phase 1 (existing `action.*`,
`common.*`, `validation.*`, `state.*`, `severity.*`, `pattern.*`, `a11y.*` are reused, never
duplicated):

| namespace | holds |
|---|---|
| `mdm.article.*` | field labels, list column headers, section titles, lifecycle state labels, compliance matrix headings, per-outlet price pane |
| `mdm.rawMaterial.*` | as above for raw materials, plus storage types, shelf-life bases |
| `mdm.vendor.*` | vendor fields, tax-registration schemes, document kinds, suspension reasons |
| `mdm.uom.*` | dimension names, system names, precision/rounding labels, conversion-rule wording |
| `mdm.taxClass.*` | regime names, rate components, supply types, effective-window wording, inclusive/exclusive |
| `mdm.site.*` / `mdm.outlet.*` | site and outlet fields, outlet kinds, service modes, opening-hours editor |
| `mdm.allergen.*` / `mdm.nutrient.*` | allergen labels (keyed by allergen **code**), nutrient labels, basis labels, display-mark labels |
| `mdm.jurisdiction.*` | requirement wording (`required in {jurisdiction}`), the compliance matrix cells, the profile changelog |
| `mdm.picker.*` | picker hints, result counts, include-inactive, create-new affordance |
| `mdm.import.*` | step names, outcome labels (`new`/`update`/`duplicate`/`error`), template wording, report headings |
| `mdm.grid.*` | dirty-state wording, blocked-line wording, partial-totals wording, leave-with-unsaved-draft |
| `mdm.deactivate.*` | reason codes (values are data, labels are keys), effective-moment wording, blocked-dependency wording |
| `mdm.record.*` | the record-level action bar, save state, review/submit wording |
| `validation.*` (extended) | `validation.unknownReference`, `validation.jurisdiction.required`, `validation.unitNotConvertible`, `validation.duplicateCode`, `validation.effectiveWindowOverlap`, `validation.requiredForJurisdiction` |
| `pattern.*` (extended) | one entry per new pattern in the `/design` gallery: `pattern.mdmRecord.title`, `pattern.mdmGrid.title`, `pattern.picker.title`, `pattern.importMapping.title`, `pattern.complianceMatrix.title`, `pattern.costGrid.title`, `pattern.recipeTree.title` — the gallery is the acceptance surface for these patterns |

Rules that come with the namespaces:

- **Allergen, nutrient, UOM, status, reason and permission codes are never translated.** The
  label is `t()`-resolved from the code — `mdm.allergen.label.{code}`,
  `mdm.uom.label.{code}` — because the code is what the API, the invoice and the ledger
  carry and a localised code in a reconciliation column is worse than useless.
- Market names come from `Intl.DisplayNames` on the jurisdiction's country code, not from a
  catalog key: a catalog will not have the market that gets onboarded next quarter.
- Record *content* (an article name, a vendor's trade name) is chain data stored per locale
  (§7.1 `name` rows, and pattern spec §18), not a catalog key.

---

## 5. The audit contract these screens use

Every mutation specified below is one call to the existing `auditedMutation()`, committing
the write and its audit row in the same transaction, with `requirePermission()` in front of
it. The screen's wording is derived from the same response, so a screen path and a chatbot
path produce byte-identical audit rows.

```
audit_log row (shape follows Phase 0's):
  action        mdm.vendor.create | mdm.article.price.update | … (the permission code)
  entityType    article | raw_material | vendor | uom | tax_class | site | outlet | import_batch
  entityId      the record's stable id
  entityCode    the business code (ART-1042, VEN-0087) — present so a support query can be
                answered from the log alone
  chainId       always (the tenant)
  siteId        only where the action was site-affected (outlet proposal, site sub-grid edit)
  source        screen | chatbot | import | picker
  intent        the chatbot intent, when source = chatbot
  before/after  the changed fields only, never the whole record
  jurisdiction  for a jurisdiction-scoped change, so the market is in the log
  batchId       for an import row; the batch itself is audited once with row counts
  effectiveFrom for effective-dated changes (cost, tax rate)
```

- **A read of a financial field is audited too**: `mdm.vendor.bank.view` writes an audit row
  with `action: mdm.vendor.bank.view`. Remittance details are rendered masked
  (`•••• 4821`) and revealed one at a time, with the reveal event recorded — the same
  reasoning the AppSupport time-box already applies to a chain's data.
- **Denied attempts are audited** (Phase 0 already does this through `PermissionDenied`);
  Phase 1 adds the entity-level denial reasons to the existing vocabulary, so "who tried to
  change a tax rate" is answerable.
- **A versioned change audits the version, not the row**: `before.versionId` →
  `after.versionId`, so the audit log can never imply an in-place overwrite that did not
  happen.

---

## 6. The shared record lifecycle

Four states recur across the masters. Each master maps onto them (§7–§13 say which states
a master actually uses, and where its rules differ).

| state | meaning | who can be in it |
|---|---|---|
| `draft` | exists, incomplete, not usable anywhere | the author, and anyone with the entity `view` |
| `pending_review` | submitted, waiting on a named approver | immutable to the author (edits create a new draft revision, they do not mutate what is under review) |
| `active` | usable: selectable in a picker, sellable, purchaseable, applied to orders | — |
| `inactive` / `suspended` / `closed` | not usable for new work, still resolves for history, carries a reason | reactivation is a separate permission |

Transitions and their gates (identical shape for every master):

| transition | gate | preconditions the server enforces |
|---|---|---|
| create → `draft` | `mdm.<master>.create` **or** `.propose` | code unique in the chain (case-insensitive, trimmed); jurisdiction set or inherited |
| `draft` → `pending_review` | `.propose` or `.update` + `.approve` | all required fields present **for every jurisdiction the chain trades in**; de-dup keys clean |
| `pending_review` → `active` | `*.approve` | approver ≠ author (`mdm.approve.self`); compliance matrix complete; threshold approval when the change is financial and above the configured value |
| `pending_review` → `draft` | `*.approve` (send back) | a reason is required and is shown to the author in their inbox |
| `active` → `inactive` | `*.deactivate` | the dependency check passes, or names what would be orphaned (§14 of the pattern spec) |
| `inactive` → `active` | `*.reactivate` | the record still satisfies today's rules — reactivating a record whose jurisdiction now requires a field it lacks is refused, naming the field |

An approval gate is a **chain-configurable switch**: where the chain holds
`mdm_approval_gated` (Gold), `draft` → `active` requires approval. On Silver (basic master
lists) the same transition is allowed for a holder of `*.approve`, which is the MDM Head —
so Silver is faster, not ungoverned, and the audit trail is identical either way. The switch
is per chain, following the tier rule; there is no per-site switch, because there is no
per-site tier.

---

## 7. Article (the sellable item, versioned, compliance-bearing)

PRD anchor: *"An article (a sellable menu item) carries name, category, veg/non-veg flag,
tax class, per-outlet price, a linked recipe, allergen tags, calorie value and serving size,
plus images. Price or recipe changes create a new version rather than overwriting the old
one"*, with the state machine `Draft → PendingReview → Active → Seasonal → Discontinued`.

### 7.1 Fields

Types used throughout this document: `code` = short uppercase business key (mono, unique per
chain, immutable once approved), `money` = `{ amount numeric(18,4), currency char(3) }`,
`qty` = `numeric(18,6)`, `pct` = `numeric(7,4)` (per cent, not a fraction), `text` = `text`,
`ref` = foreign key, `jsonb` = typed at the API edge (never `unknown` in a server function —
Phase 0's gotcha), `date`/`instant` as named.

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `code` | code | yes | no | business key, unique per chain; what a URL, a label and an import use |
| `name` | per-locale content | yes (default locale) | no | a locale tab set; fallback to the chain's default locale with an `untranslated` marker |
| `shortName` | per-locale content | no | no | POS/KDS line width is a fixed column; a short name is a courtesy, never a truncation |
| `description` | per-locale content | no | no | guest-facing copy; in guest ordering this is content, so it is not a catalog key |
| `category` | ref `article_category` | yes | no | chain-defined tree; category drives menu grouping and reporting |
| `articleType` | enum `food`/`beverage`/`retail`/`service` | yes | no | decides which compliance fields can even apply |
| `dietaryMark` | enum `veg`/`non_veg`/`egg`/`vegan`/`none` | **yes in IN** | **yes** | FSSAI's veg/non-veg symbol. The *mark* is per jurisdiction (§14); the flag itself is a product attribute, so an EU chain may still want it while its profile does not require it |
| `taxClass` | ref `tax_class` | yes | **yes** | must resolve in the article's jurisdiction; an article sold in two jurisdictions holds one per jurisdiction (§7.4) |
| `hsnSacCode` | text | **yes in IN** | **yes** | GST needs HSN (goods) / SAC (services). A type-agnostic text field would be wrong in every other market, so it lives under the jurisdiction's rule set with its validator |
| `baseUom` | ref `uom` | yes | no | the UOM the guest buys (`pc`, `glass`, `portion`) |
| `servingSize` | qty + UOM | **yes in IN** | **yes** | FSSAI requires the calorie figure *"alongside the serving size"* |
| `caloriesKcal` | numeric(9,2) | **yes in IN** | **yes** | per serving, derived from the recipe where a recipe exists (§17 marks it derived) |
| `allergens` | set of ref `allergen` + `mayContain` flag per entry | **yes in IN** (declared, possibly empty-set) | **yes** | the *mandatory set* is a jurisdiction profile (§13); declaring "none" is a positive statement and is stored as such, never as an empty list |
| `nutrition` | rows of ref `nutrient` + value + basis | no (on-request in IN) | **yes** | the PRD's *"Detailed nutrition … only needs to be available on request"*; the EU profile requires per-100 g on the label, so the same table serves both |
| `ingredientDeclaration` | per-locale text | no | **yes** | a jurisdiction may require it in the nutrition panel rather than the menu |
| `images` | ref `asset` (ordered) | no | no | one is the primary; alt text is per-locale content |
| `recipe` | ref `recipe` + version pin | no (Phase 2) | no | the reference exists in Phase 1 so Phase 2 fills it; absent means the article is costed manually |
| `prices` | per-outlet rows `{ outletId, money, effectiveFrom }` | yes (at least the outlets it is sold at) | **yes** | price currency is the outlet's site currency; a price change is a *financial* action (`mdm.article.price.update`) |
| `availability` | per-outlet enum `available`/`seasonal`/`unavailable` | yes | no | the `Seasonal` state in the PRD's diagram is the aggregate of these; stock-out (Phase 3) is a different, transactional state |
| `channelFlags` | set `pos`/`tab`/`kiosk`/`app`/`cds`/`aggregator` | no | no | exports to an aggregator carry the same compliance fields (PRD) |
| `status` | enum `draft`/`pending_review`/`active`/`seasonal`/`discontinued` | yes | no | `seasonal` replaces *"Marked unavailable"*; `discontinued` is terminal and is a state, not a delete |
| `version` | integer + `versionOf` + `effectiveFrom` | yes | no | see 7.3 |
| `compliance` | derived: matrix over jurisdictions (§14) | yes | **yes** | not a stored list of booleans — computed from the profile, so a new market's rules apply to old records without a data migration |

### 7.2 Create / edit / review flow

1. **Culinary Team** (or MDM Team) opens `/mdm/articles/new`, or duplicates an existing
   article as a new version; both write a `draft`.
2. Draft editing is a single record form (pattern spec §10) with the cost/compliance panels
   live: the compliance matrix (§14) updates as fields are filled, and an incomplete
   jurisdiction is visible from the first keystroke rather than at submission.
3. **Submit for review** (`mdm.article.propose`) → `pending_review`, routed to the MDM Head's
   inbox and chatbot (maker–checker; it never routes back to the author).
4. **MDM Head** reviews on the record itself: read-only fields + `RecordDiff` against the
   previous version + the compliance matrix + the allergen set derived from the recipe
   (Phase 2) versus declared. `Approve` → `active`; `Send back` → `draft` with a required
   reason.
5. **Price change on an existing active article is not an edit** — it creates version N+1 in
   `draft` while version N stays `active` and sellable, so there is never a window where an
   article has no sellable version. Approving N+1 sets N to `superseded` and pins the
   effective date. This is the PRD's rule and it is the reason the version table exists.
6. **Marking unavailable** (the PRD's `Seasonal`) is a per-outlet availability change, not a
   new version: it takes effect immediately, is audited, and can be reversed. Phase 3's
   automatic stock-out blocks reuse the same surface with `source: system`.
7. **Discontinue** sets the terminal state with a reason; the record stays resolvable on
   historical orders. There is no delete.

### 7.3 Versioning rules

- A version is immutable once `active` or `superseded`. Editing an active article starts a
  new draft version; the API refuses an in-place update with
  `validation.versionImmutable`, naming the route to take.
- Version identity is `(article_id, version)`. `versionOf` links back; `effectiveFrom` is
  the selling date claimed, and the approver's `approvedAt` is recorded separately — the
  difference between "meant to start" and "actually approved" is what an audit asks.
- An order line stores `articleVersionId`, so a historical bill and its COGS keep the
  figures they were sold under (the PRD's requirement, restated as a data rule).
- Rollback = approve an earlier version's clone as N+1. Nothing is ever rewritten.

### 7.4 Per-jurisdiction behaviour

- An article is chain-wide; a **jurisdiction sub-grid** holds the fields that vary
  (`taxClass`, `hsnSacCode`, `caloriesKcal`, `servingSize`, allergen requirement, nutrition
  basis) with one row per jurisdiction in the chain's profile set. A row that does not
  override shows `inherited` (an explicit word).
- The compliance gate is per jurisdiction: the article cannot reach `active` while a market
  the chain trades in shows `missing`, and the refusal names the field and the market
  (`validation.requiredForJurisdiction`, `{field}`, `{jurisdiction}`).
- A single-market chain sees one row and no ceremony — the presentation must not turn a
  one-market operator into a matrix-reading exercise. The sub-grid is hidden when the set
  has one member and the field's rule is shown inline instead.

### 7.5 Screens

**List** `/mdm/articles` — columns: code (mono) · name (+ locale/`untranslated` marker) ·
category · tax class + jurisdiction · **compliance** (a per-jurisdiction readiness summary:
`ok` / `missing 2`) · allergens declared? · status badge · version · last change. Filters:
status, category, tax class, jurisdiction, "incomplete compliance", sold-at-outlet.

**Detail** `/mdm/articles/ART-1042` — panels: *Identity* · *Selling* (per-outlet price grid,
availability) · *Compliance* (the jurisdiction matrix, the allergen set, the nutrition table,
the display marks preview) · *Recipe* (Phase 2 placeholder with an honest empty state) ·
*Versions* · *Audit*. The sticky action bar (pattern spec §10) shows the current version,
what is dirty, and Submit/Approve when the viewer holds it.

---

## 8. Raw material

PRD anchor: *"Raw material master (MDM-owned): name, unit of measure, category, shelf life,
storage type, approved vendor(s) and standard cost — the base figures every recipe costs
against."*

### 8.1 Fields

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `code` | code | yes | no | unique per chain |
| `name` | per-locale content | yes | no | the invoice and the kitchen use this; both locales matter where floor staff and HQ differ |
| `category` | ref `raw_material_category` | yes | no | drives reporting grouping |
| `baseUom` | ref `uom` | yes | no | **the canonical unit for stock and recipes** — one per material, and every other unit converts to it |
| `packUom` / `packQty` | ref `uom` + qty | no | no | how it is bought (a 25 kg sack); a vendor item may differ per vendor, so this is a default |
| `standardCost` | `money` + `effectiveFrom` + `source` | yes | **yes** | currency is the cost currency — the vendor's or the chain's base, recorded explicitly (§8.4) |
| `costSource` | enum `vendor_item`/`quote`/`manual`/`last_grn` | yes | no | `last_grn` is Phase 3; in Phase 1 it is offered but empty, and the field says which source the number came from |
| `trimYieldPct` | pct | no | no | default prep loss for this material; a recipe line may override it |
| `shelfLifeDays` + `shelfLifeBasis` | integer + enum `ambient`/`chilled`/`frozen`/`dry` | no | no | *"shelf life, storage type"* |
| `storageType` | enum `ambient`/`chilled`/`frozen`/`deep_frozen`/`dry`/`bar` | yes | no | drives the store's zones and the CDS/KDS availability rules in Phase 3 |
| `storageTempMinC` / `storageTempMaxC` | numeric(5,2) | no | no | **stored in Celsius as canon**; the *display* unit (°C/°F) is a chain/locale preference, because a UK site reads °F for a chiller and the same record must not change value when a screen does |
| `allergens` | set of ref `allergen`, each with `declared`/`derived` | **yes in IN** (declared, possibly empty-set) | **yes** | a component's allergens roll up into an article's; a derived entry is read-only with a link to its source, so nobody can "fix" a roll-up by hand |
| `nutritionPer100` | rows of ref `nutrient` + value + basis | no | **yes** | *"Detailed nutrition … available on request"*; per-100 g is the EU basis and a useful basis everywhere |
| `organicDeclaration` | per-locale text | no | **yes** | *"organic-ingredient information"* is on-request in India and label-mandatory in the EU |
| `vendors` | rows `{ vendorId, vendorItemCode, vendorUom, vendorPackQty, lastPrice, leadTimeDays, moq, preferred }` | no | **yes** | *"approved vendor(s)"* — a sub-grid; `lastPrice` is money + its own currency and date, and it never silently becomes the standard cost |
| `parLevels` | rows `{ siteId, qty, unit }` | no | no | Phase 1 stores the value so Phase 3's indenting has an input; nothing posts from here |
| `trackStock` | boolean | yes | no | whether the ledger tracks it (Phase 3 reads it) |
| `status` | shared lifecycle (§6) | yes | no | `active` means usable in recipes and purchaseable |

### 8.2 Flow

Culinary Team proposes (`mdm.raw_material.propose`) → MDM Team validates (dedup on
`name` + `baseUom` + `packUom`, plus a name-similarity warning that is a warning and not a
block, because "Tomato" and "Tomato (local)" are legitimately two records) → `active`.
Standard cost and the vendor set are edited by MDM Team and, where the change is financial,
approved by the MDM Head against the chain's threshold. A cost change is effective-dated:
the previous cost row is closed, a new row opens, and the audit row records both — the same
discipline as a tax rate, for the same reason (COGS history must stay reproducible).

### 8.3 Screens

**List** `/mdm/raw-materials` — code · name · category · base UOM · standard cost (money with
its code) + cost date · storage type · allergens · vendors (count) · status.

**Detail** — *Identity* · *Units & packing* (base UOM, pack, the conversion row that makes
them comparable, with the conversion's jurisdiction rule shown) · *Cost* (the effective-dated
cost rows, source, currency; a `stale` marker past a configured age) · *Storage & shelf life*
· *Allergens & nutrition* (declared, plus derived-from-article usage) · *Vendors* (picker
sub-grid) · *Used by* (articles whose recipe references it — the reverse index that makes
deactivation a decision instead of a guess) · *Versions/audit*.

### 8.4 Currency: the honest rule

- Every money field is `{ amount, currency }`. There is **no** chain-wide "assumed currency".
- A chain trading in one currency sees amounts in that currency only. A chain with sites in
  more than one currency holds costs per currency (a euro-zone vendor's price is EUR, an
  Indian vendor's is INR) and the costing grid **groups totals by currency** rather than
  converting silently. Converting for display is a Phase 3+ feature that needs a dated FX
  reference row and a stated rate; until that exists, a sum across currencies is refused
  with `culinary.conflict.currencyMismatch` (`docs/design/phase-2-culinary-grids-spec.md`,
  conflicts).
- Rounding follows the currency's ISO 4217 minor-unit exponent (JPY 0, INR 2, KWD 3) — a
  hardcoded 2 is a bug in two of the three.

---

## 9. Vendor

PRD anchor: MDM validates and de-duplicates *"a new vendor"* proposed by Purchase; PO
approval compares value against a threshold, so vendor terms and currency are financial
attributes of the record.

### 9.1 Fields

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `code` | code | yes | no | unique per chain |
| `legalName` | text | yes | no | the invoicing party; never translated |
| `tradeName` | per-locale content | no | no | the name the kitchen uses |
| `vendorType` | enum `manufacturer`/`distributor`/`wholesaler`/`importer`/`service`/`logistics` | yes | no | drives default lead-time and MOQ expectations |
| `status` | enum `proposed`/`active`/`suspended`/`inactive` | yes | no | `suspended` = no new POs, open POs flagged; `inactive` = deactivation with a reason |
| `contacts` | rows `{ kind, name, email, phone, locale?, preferred }` | yes (one ordering contact) | no | `locale` is the contact's language for generated documents; email validated by format and by the domain's own rule |
| `address` | structured `{ line1, line2, locality, region, postalCode, countryCode }` | yes | **yes** | structured, because an invoice address must be printable per market; a single free-text blob cannot be validated or printed |
| `taxRegistrations` | rows `{ jurisdiction, schemeCode, value, verifiedAt, verifiedBy }` | **yes where the regime requires it** | **yes** | **this is the international design point**: India needs one GSTIN, the UAE a TRN, Germany a USt-IdNr./Steuernummer, and a chain may hold a vendor registered in two. A single `gstin` column would have to be migrated the first time a non-India chain is onboarded — so the scheme is a reference row (`tax_registration_scheme`) and the value hangs off it, with its own verification date |
| `billingCurrency` | char(3) | yes | **yes** | a vendor bills in one currency; a chain with vendors in two currencies holds two vendor records only if they are two legal entities, otherwise one record with two vendor-item currencies |
| `paymentTerms` | enum `net_days` + days, `eom`, `cod`, `prepaid` + `creditLimit` (money) | yes | no | financial (`mdm.vendor.terms.update`) |
| `remittance` | `{ method, bankName, accountName, accountNumberMasked, ifscOrSwift, iban?, upiId? }` | no | **yes** | **masked in every read**; the full value requires `mdm.vendor.bank.view`, which is audited per reveal; the field set is jurisdiction-shaped (IFSC for India, IBAN/SWIFT elsewhere) |
| `documents` | rows `{ kind, reference, issuedOn, expiresOn, assetId }` | no | **yes** | e.g. FSSAI licence, GST certificate, insurance. An expiry is surfaced on the list (`expiring in {days}`, tone + word) — a compliance date that lapses silently is the failure this field prevents |
| `categories` | set `raw_material_category` | no | no | what Purchase may order from them; an empty set means "not yet classified", shown as such rather than as "no limit" |
| `leadTimeDays` / `moq` | integer / qty | no | no | PO suggestions read them (Phase 3) |
| `duplicateOf` | ref `vendor` | no | no | set when MDM merges a duplicate; the merged record is deactivated with reason `merged` and links forward, so an old PO still resolves |

### 9.2 Flow

1. **Purchase Team proposes** a vendor: the propose form is a reduced field set (identity,
   tax registration, contact, categories); the record lands `proposed`, visible only to
   Purchase and MDM.
2. **De-duplication is a required step, not a warning**: the record shows a panel of
   candidate matches (same tax registration value → strong; similar legal name → weak) with
   counts. The approver either merges or records why they did not
   (`vendor.duplicateReviewed`), because "we looked and it is a different entity" is the
   decision that matters six months later.
3. **MDM Head approves** → `active`, and only then is the vendor selectable on a PO
   (the picker excludes `proposed`; the exclusion is stated in the empty state).
4. **Suspend / reinstate** are separate actions with separate reasons; a suspension flags
   open POs rather than altering them, because Purchase owns those.
5. **Deactivate** requires the dependency check (open POs, approved vendor items on active
   raw materials) and a reason.

### 9.3 Screens

**List** `/mdm/vendors` — code · trade/legal name · type · tax registration (scheme + masked
value per jurisdiction) · billing currency · terms · documents expiring soon · status ·
last change. Filters: status, jurisdiction (from tax registrations), category, expiring
documents, currency.

**Detail** — *Identity* · *Legal & tax* (registration rows per jurisdiction, each with its
verification state) · *Contacts* · *Commercial* (currency, terms, credit limit) ·
*Remittance* (masked, reveal audited) · *Documents* (with expiry) · *Categories* ·
*Duplicate review* · *Purchase history* (Phase 3 empty state, honest) · *Audit*.

**Accessibility of a masked value**: the reveal is a button per field with an explicit
label (`mdm.vendor.reveal`, "Show account number"), it announces the reveal (`aria-live`),
and it auto-re-masks on blur of the panel — a value that stays on screen indefinitely is one
that ends up in a screenshot.

---

## 10. UOM and unit conversion (never assume Indian units)

PRD anchor: the raw material carries *"unit of measure"*; the constraint from the owner's
decisions is explicit — *"UOM conversion must not assume Indian units"*.

### 10.1 UOM reference

| field (key) | type | notes |
|---|---|---|
| `code` | code | **the code is the contract**: it is what the ledger, the invoice and a vendor's price list use. Prefer UN/CEFACT-recognised codes (`KG`, `G`, `L`, `ML`, `PC`, `DZ`, `BX`, `PK`, `TBSP`, `TSP`, `CUP`, `OZ`, `LB`, `GAL`, `QT`, `BT`, `CS`, `CAN`, `BAG`) |
| `dimension` | enum `mass`/`volume`/`count`/`length`/`time`/`energy`/`other` | conversions only exist within a dimension; a cross-dimension conversion is refused rather than approximated |
| `system` | enum `metric`/`imperial`/`count`/`none` | for grouping and for a market's expected defaults |
| `labelKey` | catalog key | `mdm.uom.label.{code}` — the label is translated, the code never is |
| `precision` | integer | **how many decimals are meaningful** (`pc` 0, `kg` 3, `L` 3). This is a *domain* rule: a locale must not change `0.5 kg` into `0.500 kg`, and a UOM with 0 decimals must refuse `1.5 pc` |
| `rounding` | enum `half_up`/`half_even`/`floor`/`ceiling` | how a converted quantity is rounded to `precision`; also used for cost rounding |
| `baseUnitOfDimension` | boolean | true for `G`, `ML`, `PC`, `MM` — the canonical unit conversions are computed through, so the conversion graph stays a star rather than a mesh |
| `scope` | enum `platform`/`chain` | platform rows are the curated set; a chain may add its own (`CASE`, `THALI`) with `scope: chain` |
| `status` | shared lifecycle | an unused chain UOM can be deactivated with a reason; a platform UOM cannot be removed |

### 10.2 Conversion rows — the jurisdiction dimension

| field (key) | type | notes |
|---|---|---|
| `fromUom`, `toUom` | ref `uom` | same dimension — enforced |
| `factor` | numeric(24,12) + `factorNumerator`/`factorDenominator` (optional) | stored as an exact decimal and optionally as an exact rational, because `1 lb = 453.59237 g` is exact and a float would drift over a thousand recipe multiplications |
| `jurisdiction` | ISO code, **nullable** | **null = universal; a value = this market's rule.** This is the field that makes the model international: a `CUP` is 240 ml in the US customary system and 250 ml in the metric one, and `LB`/`OZ` are only meaningful in markets that use them. One code, two conversions, resolved by the market in which the recipe is costed |
| `effectiveFrom` / `effectiveTo` | date | a conversion is not edited in place once a cost has been computed with it; the old row closes and a new one opens (the same discipline as cost and tax) |
| `source` | text | e.g. `UN/CEFACT`, `chain standard`, `weighed` — where the factor came from, because a costing dispute ends with this question |
| `status` | shared lifecycle | |

Resolution order when costing a line: **chain row for the site's jurisdiction → platform row
for the site's jurisdiction → chain row with null jurisdiction (universal) → platform
universal row**. The winner is always reported (`ConversionDisclosure`, pattern spec §11):
from → to, factor, the row that won and its jurisdiction. When two non-universal rows both
match (ambiguous profile), the cell shows a *conflict* and the recipe pins the rule it used,
so the cost stays reproducible.

### 10.3 Flow and screens

MDM Team maintains UOMs and conversions; `mdm.uom.conversion.update` is its own permission
because one number changes every cost in the chain. The list `/mdm/uom` switches between two
views via a `SegmentedControl`: **Units** (code · dimension · system · precision · rounding ·
scope · used-by count) and **Conversions** (from · to · factor · jurisdiction · effective
window · source · status). A grid (§11 of the pattern spec) carries the conversion view; bulk
import handles the long tail. A conversion that would create a cycle or an inconsistent
duplicate is refused with a named reason, and a *unused* conversion is shown as unused rather
than deleted.

---

## 11. Tax classes and rates, per jurisdiction

PRD anchor: the article carries a *"tax class"*; the chain carries *"tax jurisdiction"*; the
owner's direction is that *"Tax is per jurisdiction (GST first; VAT/others later)"*. So the
model must be a regime-agnostic one where GST is the first set of rows, not the shape of the
table.

### 11.1 Model

| table | key fields | why |
|---|---|---|
| `tax_regime` | `code` (`IN_GST`, `AE_VAT`, `EU_VAT`, `GB_VAT`, `US_SALES_TAX`, `NONE`), `labelKey`, `jurisdiction`, `level` (`national`/`subnational`/`local`), `inclusiveDefault`, `priceDisplayConvention`, `status`, `effectiveFrom` | a regime is a *market's* system, curated at the app layer; GST is the first row in it |
| `tax_class` | `code`, `name` (per-locale content), `regime`, `jurisdiction`, `rateBasis` (`ad_valorem`/`specific`), `inclusive` (boolean), `rounding`, `status` | what an article or a vendor item points at. **`inclusive` matters**: an Indian menu price is normally tax-inclusive, so menu display and the itemised bill edge the tax out of the price; in the US the shelf price is exclusive and the tax is added. A single boolean with a per-regime default covers both without special-casing India |
| `tax_rate` | `taxClass`, `supplyType`, `rate` (pct), `effectiveFrom`, `effectiveTo`, `components[]` | the effective-dated rate. `supplyType` ∈ `intra_state`/`inter_state`/`export`/`zero_rated`/`exempt` — because GST's rate is not one number: an intra-state sale is CGST+SGST and an inter-state one is IGST, and the same shape serves a US state/local split and an EU reduced/normal/zero rate |
| `tax_rate_component` | `labelKey`, `rate`, `level` (`central`/`state`/`local`) | so `5%` can honestly render as *`5% GST (CGST 2.5% + SGST 2.5%)`* on the bill and in the record |
| `tax_registration_scheme` | `jurisdiction`, `schemeCode` (`GSTIN`, `TRN`, `VAT_NO`, `UST_ID`, `EIN`), `labelKey`, `pattern`, `appliesTo` (`vendor`/`article`/`customer`), `status` | used by vendors (§9) and, where a market requires it, by a chain's own registration on the chain record (Phase 0 territory; not re-specified here) |

### 11.2 Rules

- **A rate is never edited in place.** Changing a rate closes the current row
  (`effectiveTo = the day before the new row's effectiveFrom`) and opens a new one. The
  dialog states that history is preserved; the audit row records the closed and the new
  window. This is what keeps a historical bill's tax reproducible, exactly as an article
  version keeps its price.
- **Overlapping effective windows for the same `(taxClass, supplyType)` are refused**
  (`validation.effectiveWindowOverlap`) — the server cannot guess which rate applied.
- **A missing combination is visible and actionable, never blank**: a cell for
  `(class, supplyType)` with no rate row reads `not configured` with a tone and a link, and
  an article cannot be `active` while its jurisdiction + supply type resolves to nothing.
- **Deactivation is blocked while referenced** by an active article or a vendor item, with
  the count and a link (§14 of the pattern spec).
- **A rate for a jurisdiction the chain does not trade in is allowed but flagged**
  (`not used by this chain`), because preparing for a market before opening a site in it is
  normal.
- **Financial and approval-gated**: `mdm.tax_class.rate.update` has
  `financial_or_stock: true`, and a change above the chain's configured threshold needs
  `mdm.approve.threshold` (MDM Head). A rate change reaches every price and every cost in
  the chain; it is not a field edit.
- **Money is not involved** here — a rate is a percentage, so a rate carries no currency.
  The *amounts* that the rate applies to always carry their currency code.

### 11.3 Screens

**List** `/mdm/tax-classes` — code · name · regime · jurisdiction · rate (rendered with its
components, e.g. `5% (2.5 + 2.5)`) · effective window · included/excluded · used by
(articles) · status. Filters: regime, jurisdiction, supply type, effective-on date (the
"what applies on this date" filter is the one operators actually use).

**Detail** — *Identity* · *Rate timeline* (a genuinely visual surface: the effective windows
as a horizontal band per supply type, with the current window highlighted, each band
selectable to read its components — the same data as the grid, read as history rather than
as a form) · *Supply types matrix* (rows = supply type, columns = rate/components/effective
window) · *Used by* · *Audit*. The timeline is presentation only: every value it shows is
editable through the grid, and nothing can be changed by dragging a band — a drag that
silently rewrites a tax window is exactly the kind of affordance this product must not have.

---

## 12. Site and outlet masters

PRD anchor: *"Each site record holds its outlets, assigned license tier, tax jurisdiction,
operating hours and the configuration overrides that recur through this spec"*.
**Conflict resolved, and the lead should note it:** the PRD's phrase "assigned license tier"
on the site record contradicts the owner's locked decision that *"Licence tier is per chain,
not per site"*. The plan and `DECISIONS.md` win. The site record therefore **displays** the
chain's tier as a read-only value with a link to the chain record; it has no tier column and
no tier field, and no per-site feature gating exists anywhere. This is the deviation the
lead asked to be flagged.

### 12.1 Site fields

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `code` | code | yes | no | unique per chain; what an import, a URL and a chatbot intent ("Site 12") resolve to |
| `name` | text | yes | no | a place name — chain data, not a catalog key |
| `jurisdiction` | ref `jurisdiction` | yes | — | drives tax regime, currency, timezone and locale defaults, and the article compliance gate |
| `timezone` | IANA zone | yes | — | *"site-level timezone"*; defaults from the jurisdiction, overridable with a recorded reason |
| `currency` | char(3) | yes | — | the site's trading currency. A chain with two currencies is legitimate; every site-local amount carries this code |
| `locale` | locale code, nullable | no | — | the site hop of the language resolution order. **Written through the existing `site.locale.update` permission — no new code**; the master screen shows it and links to the existing write path (reuse, not a parallel route) |
| `address` | structured `{ line1, line2, locality, region, postalCode, countryCode }` | yes | **yes** | structured for the same reason a vendor's is: it has to print on a compliant invoice |
| `serviceModes` | set `dine_in`/`takeaway`/`delivery`/`room_service`/`drive_thru` | yes | no | `room_service` is offered even though room-folio *posting* is deferred; the mode and the payment method are different things |
| `operatingHours` | rows `{ outletId?, dayOfWeek, opensAt, closesAt, closed, note? }` | yes | no | per outlet where outlets differ; the site holds the pattern, an outlet overrides it. Rendered in the site's zone with the zone named |
| `outlets` | children (12.2) | yes (≥ 1) | no | |
| `terminals` | count by kind (Phase 2/3) | no | no | a placeholder field with an honest empty state until terminals exist; the master must not pretend to know hardware it cannot see |
| `status` | enum `onboarding`/`active`/`suspended`/`closed` + reason | yes | no | `closed` is the terminal state; **there is no delete** (§14 of the pattern spec) |
| `chainTier` | **read-only**, derived from the chain | — | no | displayed with a link to `/chains/$chainId`; never writable here |
| `externalRef` | text + `sourceSystem` | no | no | the chain's own site id from whatever system they migrated off |

### 12.2 Outlet fields

`code` · `name` · `kind` (`restaurant`/`bar`/`qsr`/`kiosk`/`cloud_kitchen`/`hotel_outlet`/
`banquet`/`room_service`) · `site` (ref) · `operatingHoursOverride` · `serviceModes` ·
`terminals` · `status` + reason · `externalRef`. An outlet never carries a jurisdiction or a
currency: it belongs to a site, and a jurisdiction on an outlet would create a second source
of truth for tax.

### 12.3 Flows

1. **New site (Central MDM only)**: a wizard — Identity → Jurisdiction → *Derived defaults*
   (currency, timezone, locale proposed from the jurisdiction, each overridable **with a
   reason that lands in the audit row**) → Outlets → Locales → Confirm. The confirm dialog
   restates the chain and the tier being inherited (a tier that appears on a site record is
   the one thing this dialog must get right, per the locked decision).
2. **New outlet**: `mdm.outlet.create` (MDM Team) or `mdm.outlet.propose` (Site Head,
   site-scoped — `requires_site_scope: true`, so a Central identity cannot use the
   proposal path and a site head cannot propose at another site).
3. **Operating values are not master data.** The values the PRD lists as configurable per
   site (prep-time SLA, stock-out reset policy, service-charge default, approval thresholds)
   are written through the **existing delegated setting mechanism** —
   `chain.setting.update` against an App-published definition with site scope (migration
   `0006_chain_setting_site_scope.sql`), because the App layer owns what is overridable and
   the bounds. The site master screen *shows* the resolved values in a read-only
   *Configuration* panel with a link to the settings screen, so an operator finds them from
   either direction and there is exactly one write path. **The engineer should not add a
   second settings mechanism to the site record.**
4. **Closure**: `mdm.site.deactivate` sets `status: closed` with a reason, refuses while the
   site has open transactional state (Phase 3: open POs, unresolved RA items), and leaves the
   site resolvable on every historical record. Reopening is a separate audited action.

### 12.4 Screens

**List** `/mdm/sites` — code · name · jurisdiction (chip) · timezone · currency · outlets
(count by kind) · locale (or `inherited`) · status · last change. Site rows group by chain
under a chain filter, and the chain's tier appears once in the section header (not repeated
on every row — a per-row tier would suggest a per-site tier).

**Detail** — *Identity* · *Address* · *Trading* (currency, timezone, service modes,
operating hours with the zone named) · *Outlets* (a pane with inline add, using the picker
pattern for nothing — outlets are created, not selected) · *Language* (the site's default
locale and the resolved effective locale, with the existing write path linked) ·
*Configuration* (read-only resolved settings) · *Compliance* (which jurisdiction profile
applies, and which articles are currently incomplete *for this site's market*) · *Audit*.

---

## 13. Allergen and nutrition reference data

PRD anchor: the mandatory allergen set to tag per dish is *"cereals containing gluten,
crustaceans, eggs, fish, peanuts, soybeans, milk, tree nuts, and sulphites at 10mg/kg or
more"*, with *"detailed nutrition and organic-ingredient information … available on request"*.
Those nine are **rows under the `IN` jurisdiction profile**, not a constant in the code:
the same model has to carry a market that mandates a different set, a market that mandates
none, and a chain's own proprietary blend.

### 13.1 Allergen reference

| field (key) | type | notes |
|---|---|---|
| `code` | code | stable, lowercase snake (`cereals_gluten`, `crustaceans`, `eggs`, `fish`, `peanuts`, `soybeans`, `milk`, `tree_nuts`, `sulphites`, `sesame`, `celery`, `mustard`, `lupin`, `molluscs`) — the union across markets, so a market's set is a query rather than a migration |
| `labelKey` | catalog key | `mdm.allergen.label.{code}`; the label is translated, the code is not |
| `searchAliases` | per-locale string list | how a kitchen actually types it ("gluten", "maida", "nut") — search must match the alias, because the picker is where a wrong allergen gets in |
| `scope` | `platform`/`chain` | a chain-only entry is allowed and is flagged as chain-specific wherever it appears, so it can never look like a statutory allergen |
| `status` | shared lifecycle | platform rows are never removed; a superseded one is deactivated with a reason |
| `effectiveFrom` | date | a market's set changes with its law; the row is dated so an old declaration can be read against the rules of its day |

### 13.2 Jurisdiction mappings (the part that makes it legal, not decorative)

- `jurisdiction_allergen { jurisdiction, allergen, requirement: mandatory | informational |
  not_required, displayOrder, symbolKey }` — a market's set, its order (display order is
  mandated in some markets, so it is data, not a `sort` in a component), and the mark to use.
- `jurisdiction_display_mark { jurisdiction, kind, shapeCode, assetKey, labelKey }` — India's
  veg/non-veg marks are one market's convention; the *preview* on the article form renders the
  mark that the **selling site's** market expects, so an operator in another market cannot
  be shown a green dot that means nothing there. Nothing about a mark is hardcoded in a
  component.
- `nutrient { code, labelKey, unit, defaultBasis, precision, scope }` with
  `jurisdiction_nutrient { jurisdiction, nutrient, basis, requirement }` — the basis is the
  real difference: **per 100 g / per 100 ml** (label-style) versus **per serving**
  (menu-style, which is what India's menu rule needs alongside the serving size). One
  nutrient reference, two bases, per-market requirement.
- The third shape is deliberately included so the model is not two similar regimes: a market
  that mandates a calorie disclosure for large chains but **no** allergen set (a plausible
  `US`-style profile) is expressible as rows, and the compliance matrix then has no allergen
  column at all — the matrix is generated from the profile, so it shrinks as well as grows.

### 13.3 Flow, permissions and states

- The platform set and the jurisdiction mappings are curated at the **app layer**
  (`mdm.allergen.reference.update`, `mdm.nutrient.reference.update`,
  `mdm.jurisdiction.rule.update`) — a chain selects a market; it does not write that
  market's law.
- A chain adds its own allergens or nutrients (`mdm.allergen.chain.update`,
  `mdm.nutrient.chain.update`) and sees its own additions mixed in with a `chain` badge.
- **Changing a profile is versioned and never silent**: a new rule row carries
  `effectiveFrom` and a note; the system then produces an **exception list** of records that
  became non-compliant (article × market × missing field), routed to MDM and Culinary as a
  queue item. It does **not** deactivate articles, block selling, or edit records — a
  reference-data change must not be able to stop a restaurant trading unattended. The
  exception list has its own empty state ("nothing became non-compliant") and its own count
  in the master list's compliance column, so the change is visible without being destructive.
- States: allergens unseeded for a jurisdiction (`the profile for {jurisdiction} has no
  allergen requirement configured`) · a profile with no rows at all (treated as
  `not_required` everywhere, stated explicitly, never as "compliant by accident") ·
  denied (`mdm.allergen.reference.update` is an app capability, and the refusal says so) ·
  error (the profile edit is one transaction; a partially applied profile is impossible).

---

## 14. Jurisdiction profiles — how a market's requirements are expressed

| table | key fields | purpose |
|---|---|---|
| `jurisdiction` | `code` (`IN`, `IN-KA`, `AE`, `DE`, `GB`, `US`…), `countryCode`, `subdivisionCode?`, `defaultCurrency`, `defaultTimeZone`, `defaultLocale`, `defaultTaxRegime`, `status` | the market. The *name* comes from `Intl.DisplayNames`, not the catalog |
| `jurisdiction_field_rule` | `jurisdiction`, `entity`, `field`, `requirement` (`required`/`recommended`/`forbidden`/`optional`), `validator`, `effectiveFrom`, `noteKey`, `legalRef`, `profileVersion` | which fields a market requires, and why — `legalRef` is a text field for the citation, so a reviewer can audit the profile rather than trust it |
| `jurisdiction_display_rule` | `jurisdiction`, `surface` (`menu`/`cds`/`app`/`label`), `field`, `presentation` | what must appear *where* (calorie next to the item on the menu versus in a nutrition panel on request) |

**How the chain's set of traded jurisdictions is derived:** the chain's
`tax_jurisdiction` (Phase 0 column) plus the distinct jurisdictions across its sites. That
set drives every compliance matrix, every per-jurisdiction sub-grid and every jurisdiction
filter. There is no separate list to maintain.

**Presentation** is pattern spec §15 and is not repeated here. Two product rules that belong
to the model rather than the layout:

1. **A profile is versioned, effective-dated and app-owned.** A change inserts rows with a
   new `effectiveFrom`; nothing is edited in place; the profile's changelog is readable in
   `/mdm/reference/jurisdictions`.
2. **The profile gates going `active`, never trading.** An article that became incomplete can
   be approved to `active` **only** by an explicit, audited override
   (`mdm.article.approve` with `complianceOverride: true` and a required reason), which is
   the honest answer to "the law changed last night and we must still serve lunch". The
   override is on the exception list forever.

**What is real and what is a placeholder, stated plainly:** the `IN` profile's content comes
from the PRD's FSSAI research. Every other profile is a *shape*, not a claim — seeding `DE`
or `AE` requires the owner's market sequence and legal review, and this spec deliberately
does not invent another market's law. The lead should treat that as an open item, not as a
design gap.

---

## 15. Routes, navigation and tier gating

| route | master | permission to enter | notes |
|---|---|---|---|
| `/mdm` | section landing | `mdm.view` | the four cards an operator needs: masters with incomplete compliance, imports in flight, records awaiting review, recent deactivations |
| `/mdm/articles`, `/mdm/articles/$articleCode` | article | `mdm.article.view` | |
| `/mdm/raw-materials`, `/mdm/raw-materials/$code` | raw material | `mdm.raw_material.view` | |
| `/mdm/vendors`, `/mdm/vendors/$code` | vendor | `mdm.vendor.view` | |
| `/mdm/uom` (`?view=units|conversions`) | UOM | `mdm.uom.view` | |
| `/mdm/tax-classes`, `/mdm/tax-classes/$code` | tax | `mdm.tax_class.view` | |
| `/mdm/sites`, `/mdm/sites/$code` | site | `mdm.site.view` | |
| `/mdm/reference/allergens`, `/mdm/reference/nutrients`, `/mdm/reference/jurisdictions` | reference | `mdm.allergen.view` / `mdm.nutrient.view` | jurisdiction profiles are read-only here for a tenant; the app layer edits them |
| `/mdm/import`, `/mdm/import/$batchId` | import | `mdm.<master>.import` | the batch is a record: file, template, counts, outcome, link to the error report |
| `/mdm/review` | review queue | the entity `*.approve` of the record | this is the same inbox surface as `/approvals`, filtered to MDM; not a second queue implementation |

**Nav behaviour.** The *Master data* section appears for any holder of `mdm.view`; each child
appears only if the caller holds that entity's `view`, and the section's empty state names
what is missing (the §2 rule: an empty scope is the permission model working, and the copy
says so). The nav is built from the same `authorise()` result the server enforces, so the
interface cannot drift from the policy.

**Tier gating** (tier is a property of the **chain**; there is no per-site gate):

| capability | Silver | Gold | Platinum |
|---|---|---|---|
| master lists, versioning, audit, import, deactivate-with-reason | yes | yes | yes |
| approval-gated golden record (`mdm_approval_gated`), review queue, de-duplication review, compliance matrix with per-market exceptions | — | yes | yes |
| recipe/BOM (Phase 2) with 3-tier BOM (`recipe_full_bom`) and the costing grids | single-level only | yes | yes |
| AI costing / indenting / PO suggestions (`ai_recipe_costing`, `ai_indenting`, `ai_po_suggestions`) | — | — | yes |

Where a capability is off for the chain's tier, the screen does not pretend: the action is
absent **and** the section states why in one line with the tier named
(`mdm.tierNote`, `{capability}`, `{tier}`) — never a disabled button with no explanation.
Every action on a master is gated by permission *and* by feature; the permission is the
authority, the feature is the product's depth, and the server enforces both.

---

## 16. Loading the pilot chain's real data without a redesign

The owner has not supplied the menu and master data yet, so this is the property that
matters most: the spec must be loadable later rather than rebuildable later.

1. **The business code is the key everywhere** — URLs, imports, chatbot references,
   audit rows. It is chain-unique, immutable once approved, never reused after
   deactivation, and the import's de-dup key. A record's internal uuid never appears in a
   screen or a chat.
2. **Every record carries `externalRef` + `sourceSystem`** so a chain's existing ERP or
   legacy id maps through instead of being guessed at. Re-importing the same extract is
   idempotent (batch + row key), and an update is an update, not a duplicate.
3. **Nothing assumes India, rupees, kilograms or one language.** Jurisdiction, currency,
   UOM dimension, timezone and locale are explicit on every record that needs them; the
   defaults are derived from the jurisdiction and *recorded as derived* so a wrong default is
   visible instead of invisible.
4. **Reference data is importable first, in this order** (each step validates against the
   previous, so a broken CSV is found at its own step): jurisdictions → tax regimes/classes
   → UOMs + conversions → categories → allergens/nutrients → vendors → raw materials →
   sites/outlets → articles. Recipes follow in Phase 2.
5. **Import templates are chain data**, so the pilot chain's first vendor price list
   becomes a reusable mapping for its second and third.
6. **The seeded demo data is placeholder**: `saffron-table`, `koramangala`, `indiranagar`
   and `coastal-catch` are shape, not content. Real data replaces them by import, and the
   demo rows are removed by deactivation with reason `demo_data` rather than by a delete the
   audit log cannot explain. The pilot-chain modelling reference (`DECISIONS.md #3`) is not
   named in any screen, copy or export.
7. **Scale is assumed, not hoped for**: list endpoints paginate; grids virtualise above 200
   lines; imports chunk; the de-dup check is indexed on `(chain_id, code)` and on the
   soft keys used by the duplicate panels.

---

## 17. Empty, error and denied states, master by master

Four states, never collapsed (pattern spec §2). The master-specific ones:

| master | empty in scope | filtered to nothing | error | refused |
|---|---|---|---|---|
| article | "No articles yet in {chain}. Culinary creates one, or import a menu." | names the filter, offers to clear it, states how many rows it hid | the server's own message as `detail` + retry | `PermissionDenied` naming `mdm.article.<action>` and why |
| raw material | "No raw materials. Culinary proposes one; MDM validates it." | as above | as above | as above |
| vendor | "No vendors. Purchase proposes one; MDM approves it before a PO can use it." | as above | as above | as above |
| UOM | "No chain UOMs yet — the platform set is already available." and for conversions: "No conversions defined for {jurisdiction}." | as above | a cycle or a cross-dimension conversion is refused with its reason and both codes | as above |
| tax class | "No tax classes for {jurisdiction}." | as above | overlapping effective windows refused | as above |
| site / outlet | "No sites yet. Onboard the first one." | as above | a duplicated code, or a site with no outlet, refused with the reason | as above |
| allergen / nutrient reference | "The {jurisdiction} profile has no requirements configured — every field is treated as optional. Configure the profile." (a real, stated state — not a silent pass) | as above | a profile edit is one transaction; a partial profile is impossible | app-layer only: "curating a market's requirements is a platform capability" |
| import | "No imports yet." | — | unreadable file · all rows invalid · template expired · partially valid (`commit the valid rows`) | names `mdm.<master>.import` |
| deactivate dialog | — | — | blocked by a dependency, naming the count and a link | names the missing permission |
| compliance matrix | a market with no rules: stated explicitly as "no requirements configured" | — | — | — |

---

## 18. Open questions and decisions the lead must take

1. **The pilot chain's real master data** — still the owner's open ask, and still the
   fastest route to a demo F&B operators recognise. §16 is written so this lands by import.
2. **Market sequence** (owner's open question) — which jurisdictions to seed *after* `IN`.
   Until it is answered, this spec ships **one real profile** and a shape for the rest.
3. **Legal review before the compliance gate blocks an article.** The profile's content is
   legal material; the design should not be the thing that certifies it. The audited override
   (§14) is the pressure valve, and the lead should confirm it is acceptable that the
   override exists at all.
4. **Silver and versioning.** I have specified versioning, audit and deactivate-with-reason
   as table stakes at every tier (they are data-integrity rules), with only the
   *approval-gated* workflow gated to Gold. That is a commercial statement, not a technical
   one — the lead should confirm it against the tier story before the build encodes it.
5. **Chain-only allergens and nutrients.** Allowed and badged in this spec (a proprietary
   blend is real). The alternative — platform-only reference data — is simpler and forces
   chains into a bad approximation. Proposal: keep them; flag if the tier story should not
   include it.
6. **Localised record content: how many locales are required?** Currently the chain's
   default locale is required and others are optional with an `untranslated` marker. If a
   chain must print a second language on its menu, that becomes a required-per-locale rule —
   a jurisdiction profile entry, not a new mechanism.
7. **Temperature unit preference** (°C/°F) — I stored Celsius as canon and made display a
   preference. Needs an owner answer on whether a site may choose differently from its chain.
8. **Code generation.** Proposal: chain-supplied codes with a suggested pattern per master
   (`ART-…`, `RM-…`, `VEN-…`), because an imported chain already has codes and a generated
   one breaks their world. Confirm.
9. **The PRD's "assigned license tier" on the site record** — flagged in §12; the locked
   decision wins in this spec, and the PRD should be read as superseded there.
10. **Where the jurisdiction profiles live** — app layer today. A per-chain override of a
    *statutory* requirement would be a footgun; confirm no chain is expected to hold its own
    legal profile.

---

## 19. Definition of done for the Phase 1 build

The engineer can treat this as the acceptance list:

- Every mutation in §§7–13 exists as a registered permission code with the layer, scope and
  `financial_or_stock` flags of §3, enforced by `requirePermission()` and written with
  `auditedMutation()` in the same transaction.
- Negative permission tests pass: holding `mdm.execute` without an entity code cannot write;
  a site-scoped caller cannot use a Central-only code; an app-layer code is refused to a
  tenant identity; a proposer cannot approve their own version.
- An article cannot reach `active` with a market's required field missing; the refusal names
  the field and the market; the audited override is the only way past it and it appears on
  the exception list.
- A price, cost or tax-rate change creates a version or an effective-dated row; no in-place
  overwrite is possible through any path, including import and the picker.
- No master record can be deleted through any surface; deactivation requires a reason and is
  blocked by a live dependency with a named count.
- No user-visible string literal in the new screens: every label, header, badge, state and
  error resolves through the namespaces in §4, verified by the same check Phase 0 uses.
- `ar-XB` mirrors every new layout without a horizontal scrollbar at `compact`; `en-XA`
  (and a real German/Arabic string if one exists) does not truncate a column header, a button
  or a cell value.
- Every money value renders amount + ISO code; a mixed-currency total is refused or grouped,
  never summed; a quantity renders its UOM code.
- The licence tier is read from the **chain** only, appears read-only on a site record, and
  no site-, outlet- or record-level tier exists in the schema or the UI.
- The `/design` gallery carries one live example of each new pattern (§4's `pattern.*` keys),
  so the patterns are reviewable without reading this file.
