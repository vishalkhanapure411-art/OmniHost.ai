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
| `/home/team/shared/DECISIONS.md` — *ERP integration — OWNER DIRECTION (Sept 2026)* — and the business plan's ERP bullet | **Part II** (`§20`–`§26`): model for ERP parity rather than an F&B subset, everything externally keyed, codes mapped rather than re-typed, sync auditable and idempotent, master direction an explicit decision per field group, and the integration itself behind an adapter so the ERP is configuration, not a rewrite |
| SAP Help Portal and Microsoft Learn, listed **with their verification state** in `§20.0` | **Part II** (`§20`–`§21`): the ERP-side field set per entity. `§20.0` states exactly which sources were verified and which were not, and `§26.3` lists the gaps. Nothing in Part II states or implies a partnership with, or certification by, either vendor |

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

**Part II (§20–§26) adds its own codes in this same shape** — `mdm.erp.*`,
`mdm.<master>.export`, and the App-layer vendor-reference code. They are listed once, in
`§24.5`, which is their authority; they are not restated here.

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
| `mdm.erp.*` and its sub-namespaces | added by **Part II** — listed in full in `§25.6`, which is their authority; nothing here is duplicated there |

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
   **Status: target behaviour, not yet enforced — slab 2 deviates knowingly.** Until the
   maker–checker review screens are built (they are out of scope for slab 2), a price change
   closes the open window and opens a new one **inside the current version**: no `draft` N+1
   appears, nothing has to be approved before the new price sells, and the new price is live
   from its effective date. The effective-dated row discipline still holds — `article_price`
   keeps the closed and the opened row, and the audit trail records both — so a historical
   bill stays reproducible, but the version guarantee above is not what the operator gets
   today. When the review screens land, the switch is a change inside
   `updateArticlePrice` and nothing else: the closing/opening logic is already isolated
   there. *(Recorded Sept 2026 — designer, from the `SPEC-GAP` note the engineer left on that
   function; verified on the record screen that a saved price takes effect without a new
   version appearing.)*
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

**Part II (§20–§26) adds its own acceptance list — `§26.5` — and weakens nothing
above.** Where the two meet: `§21` adds fields, `§22` adds identity and ownership,
`§23` adds the audit rows a sync writes, and every mutation named in Part II is still one
`requirePermission()` call in front of one `auditedMutation()` in one transaction.

---

# Part II — ERP parity and the ERP integration design (added Sept 2026)

Owner direction (binding, `DECISIONS.md` → *ERP integration — OWNER DIRECTION*):
article management must account for **all the fields MS Dynamics and SAP use**, because the
full system is to be integrated with them. Parts I (`§1`–`§19`) stand; this part does not
restate them, it extends them. Where a rule here changes a rule in Part I, it says so and
says why. **No assumption is made anywhere below that the pilot runs a particular ERP, and no
partnership, endorsement or certification relationship with SAP or Microsoft is stated or
implied.** The two vendors appear here as *sources for a field list* and as *adapter
implementations we must be able to write*, nothing more.

## 20. Field-parity catalogue — what an ERP holds, what we hold, and who owns it

### 20.0 Method, sources and how to read the verification column

**Method.** For each entity an ERP integration touches (article, raw material, vendor, UOM,
tax class, site/outlet) the catalogue lists: the ERP-side field, the view/table it lives in,
the field in our model (existing per Part I, newly proposed in §21, or deliberately not
carried), whether it is required for us, and **who is intended to own it**. Ownership is the
point of the exercise: *a field with two masters corrupts silently* (`DECISIONS.md`).

**Ownership vocabulary used in every table of §20** (the codes are printed in the UI as a
`ProvenanceChip`, §25):

| code | meaning | what the API does |
|---|---|---|
| `ERP` | the ERP is the master; we mirror | writes to it are refused with a keyed reason unless the chain sets `erp.master.override` for that field group (§24.4); the value arrives by import |
| `OH` | OmniHost is the master | we hold the value and offer it on export; an inbound ERP value for it is recorded as a proposal, never applied silently |
| `ERP+OH@site` | ERP owns the chain-level value, we own a site/outlet-scoped override | the record holds both, and the sub-grid marks the inherited rows (§15 of the pattern spec) |
| `split` | both sides legitimately hold it, at different scope or granularity | **not a default** — only where the catalogue says so, with the split named in the row |
| `—` | deliberately not carried | not stored; if the ERP sends it we record it as `unmappedErpField` in the run report rather than dropping it silently (§23.6) |

**Sources, and what was actually verified.**

| code | source | verification state |
|---|---|---|
| `SAP-BP` | SAP Help Portal — *Data Model for Master Data Governance for Material* (Master Data Governance for Material, SAP ERP/S/4HANA) — `help.sap.com/docs/SAP_ERP/63539d3a21d944dfbb594cb945aa76d0/2a500de376504b4386a04d1085a52f22.html` | **page title and URL confirmed** against the SAP Help Portal search index; page body **not** retrieved headlessly |
| `SAP-BP-BD` | SAP Help Portal — *Create Material (Non-Stock Material) Master Data — Basic Data* and *Create Material (Service Product) Master Data — Basic Data* (SAP S/4HANA Best Practices) | **page title and URL confirmed**; body not retrieved |
| `SAP-BP-ALT` | SAP Help Portal — *Data Structure for Alternative Units of Measure (unima2)* (SAP ERP) | **page title and URL confirmed**; body not retrieved |
| `SAP-MM` | SAP Help Portal — the standard **material master** topics: Basic Data 1/2, Purchasing, MRP 1–4, Storage, Accounting 1/2, Quality Management, Sales, Plant Data / Storage Location Data, Classification, Warehouse Management (LO-MD-MM and the S/4HANA *Master Data → Material Master* tree) | **⚠ not retrieved in this session.** `help.sap.com` renders client-side; the page bodies could not be fetched by an automated client. The field names in the SAP column are from the standard material master views as documented in SAP Help and are **to be confirmed** against the chain's own system before the schema is frozen |
| `SAP-B1` | SAP Business One item master (SAP Help Portal, Business One *Items*) | **⚠ not retrieved.** To confirm; Business One matters only if the pilot runs it |
| `MS-PIM` | Microsoft Learn — *Product information overview* (`dynamics365/supply-chain/pim/product-information`) | **fetched and read**: product master vs distinct product vs product variant, product dimensions, released products |
| `MS-PD` | Microsoft Learn — *Product dimensions* (`…/pim/product-dimensions`) | **fetched and read** |
| `MS-CPM` | Microsoft Learn — *Create a product master* (`…/pim/tasks/create-product-master`) | **fetched and read**: product number, product dimensions, storage dimension group, tracking dimension group, batch and serial handling |
| `MS-UOM` | Microsoft Learn — *Manage units of measure* (`…/pim/tasks/manage-unit-measure`) | **fetched and read**: unit and unit conversion |
| `MS-BC-ITEM` | Microsoft Learn — *Create item cards for goods or services* (Business Central) | **fetched and read** |
| `MS-BC-UOM` | Microsoft Learn — *Set up item units of measure* (Business Central) | **fetched and read**: base UOM, item units of measure, unit-of-measure conversions |
| `MS-⚠` | any Microsoft field below not found in the pages above | marked **⚠ needs confirmation** in the row |

**Two consequences the lead should read before the rest of §20:**

1. **The Microsoft column is source-backed; the SAP column is largely not.** I could not pull
   SAP Help page bodies with an automated client, so rows whose only source is `SAP-MM` or
   `SAP-B1` are honest reconstructions of the standard material master views, not quotations.
   §26.7 lists what must be confirmed and by whom. **Do not let the schema freeze on the
   strength of the SAP column alone.**
2. **A few SAP fields are intentionally *not* modelled even at parity**, because they are
   configuration of the ERP's own processes rather than attributes of the item (for example
   SAP's plant-level MRP controller person, or F&O's item-level default order type when the
   chain sets it per warehouse). Each is marked `—` with the reason in the row, and a run
   report that encounters one says so (`unmappedErpField`) instead of dropping it.

### 20.1 Article (the sellable item)

Our article (`§7.1`) is a **sellable, compliance-bearing menu item**. An ERP calls the same
row a *material* / *product* / *item*, usually a *finished good* or a *trading good* with
sales views maintained. The two are the same row for a chain that sells what it buys
(a bottled drink) and **different rows** for a chain that sells a recipe. The catalogue says
which fields we take from the ERP and which stay ours.

| ERP field (view / table) | source | our field | req. | owner | notes |
|---|---|---|---|---|---|
| Material number / Item number / No. | SAP-MM ⚠ · MS-PIM ✔ | `code` (`§7.1`) **or** `external_key` | yes | `split` | **The one row that must be decided per chain.** If the chain already has material numbers, `code` = the ERP's number and there is one identity; if not, our `code` stays ours and the ERP number is an external key (§22). The mapping is a chain-level setting, not a per-record choice |
| Material type (MTART) | SAP-MM ⚠ | `materialType` **(new, §21.1)** | yes | `ERP` | ERP enforces its own type→view set; we mirror the code and use it for hidden-when-irrelevant (§25) |
| Material group (MATKL) / Item group | SAP-MM ⚠ · MS-PIM ✔ (`Item group`) | `materialGroup` **(new)** on top of our `category` | no | `split` | our `category` is the menu/menu-grouping tree the chain's operators use; the ERP's material group is the *reporting/procurement* tree. **Both exist**; neither replaces the other. Mapping table in §22.3 |
| Industry sector | SAP-MM ⚠ | — | — | — | the ERP's own classification for its field selection; not an attribute of a dish |
| Base unit of measure / Inventory unit | SAP-MM ⚠ · MS-UOM ✔ | `baseUom` (`§7.1`) | yes | `split` | must resolve through the code map (§22.3) or the row imports with `unknownErpCode` |
| Product type (Item / Service) / Product subtype | MS-PIM ✔ | `articleType` (`§7.1`) | yes | `ERP` | our enum (`food`/`beverage`/`retail`/`service`) is finer; the mapping is many-to-one and lives in config |
| Product dimensions: Configuration, Size, Style, Color | MS-PIM ✔, MS-PD ✔ | — (as *variants*: `variantOf` + `variantAxes` **new**) | no | `split` | a menu item with a size choice is a **variant set** in both systems; our `§7.1` has no variant model. Proposed: `variantOf` self-reference plus `variantAxes` (an ordered set of axis code + value), and a per-variant override of price only |
| Product lifecycle state / Engineering change / deletion flag | MS-PIM ✔ · SAP-MM ⚠ | `erpLifecycleState` + `erpBlocked` **(new)** | no | `ERP` | the ERP's lifecycle is not our lifecycle: our `status` (`§7.1`) drives selling, the ERP's drives posting. Both are shown, neither is folded into the other (§22.5) |
| Gross weight, Net weight, Tare weight, Gross depth/height/width, Gross volume | MS-PIM ✔ (F&O physical dimensions on the released product) · SAP-MM ⚠ | `netWeight`, `grossWeight`, `volume`, `dimensions` (L×W×H) **(new, §21.1)** | no | `split` | the ERP's figure is the *logistics* figure at the ERP's unit; ours is the *culinary* figure the recipe uses (30 g of cheese). Same field name, different meaning — the row states which unit each side holds and does not silently overwrite ours |
| Storage dimension group (Site, Warehouse, Location, Batch…) / Tracking dimension group (Batch, Serial…) | MS-PIM ✔, MS-CPM ✔ | `batchManagement`, `serialProfile` **(new)** | no | `ERP` | these groups are how the ERP decides which dimensions exist; we mirror the *effective* flags (batch required/optional/none, serial required) rather than the group's name, because a group name means nothing outside that ERP |
| Storage conditions | SAP-MM ⚠ | `storageCondition` **(new)** | no | `split` | the ERP's code list is per-installation; ours is the culinary enum already in `§8.1` (`storageType`). The mapping is data |
| Temperature condition (unregulated / chilled / frozen) | SAP-MM ⚠ | `temperatureCondition` **(new)** | no | `split` | complements `storageTempMinC`/`MaxC` (`§8.1`), which stay ours |
| Minimum remaining shelf life, Total shelf life | SAP-MM ⚠ | `minRemainingShelfLifeDays`, `totalShelfLifeDays` **(new)** | no | `ERP` | different from our `shelfLifeDays` (`§8.1`): the ERP's *total* figure is from production, ours from receipt. Both are kept and the UI says which is which |
| Shelf life period / Shelf advice period (F&O item) | MS-⚠ | `shelfLifeDays`, `shelfAdviceDays` | no | `split` | F&O's shelf-life periods were not found on the pages I read — flagged `MS-⚠` |
| Tax classification (MWST / TATY), Tax group, Tax jurisdiction code | SAP-MM ⚠ | `taxClass` (`§7.1`) + `erpTaxClassification` **(new)** | yes | `split` | our `taxClass` is the jurisdiction-shaped model in `§11`; the ERP's tax classification is a code we *carry*, not a model we adopt (§22.3) |
| Country of origin, Region of origin, Customs tariff number / HS code, Preference status, Export control | SAP-MM ⚠ · MS-PIM ✔ (F&O foreign-trade fields on the released product) | `countryOfOrigin`, `customsTariffNumber` (HS), `exportControlClass` **(new)** | no | `split` | **our `hsnSacCode` (`§7.1`) is not the same field** — HSN/SAC is India's GST nomenclature, the customs tariff number is the importing market's. Both are held; `§7.4`'s jurisdiction rule governs the Indian one |
| Manufacturer, Manufacturer part number, Manufacturer item number | SAP-MM ⚠ · MS-BC-ITEM ✔ (`Manufacturer Code`, item reference) | `manufacturerName`, `manufacturerPartNumber` **(new)** | no | `ERP` | often the only way a regional chain and its vendor describe the same tin |
| Revision level / Engineering change level, ECN | SAP-MM ⚠ | `revisionLevel`, `changeNoticeRef` **(new)** | no | `ERP` | the ERP changes a recipe or specification under a revision; the value is what a dispute is resolved against |
| ABC indicator, Criticality | SAP-MM ⚠ | — | — | — | ERP planning classification; our equivalent is purchase value banding, which is computed (Phase 3), not stored per article |
| Net price, Standard price, Moving average price, Valuation class, Price control | SAP-MM ⚠ · MS-⚠ | `standardCost`/`valuationClass`/`priceControl` **(new, §21.1)** | no | `ERP` | **at article level this is a *cost*, not the guest price.** Per-outlet selling price (`§7.1` `prices`) stays `OH`: the ERP does not know a chain's per-outlet menu price, and pretending it does would let a cost sync change what a guest is charged |
| Sales unit, Sales price unit | SAP-MM ⚠ · MS-⚠ | `servingSize`/`baseUom` | no | `OH` | a menu portion is ours; an ERP sales unit is a packaging unit |
| Brand, Division, Sales organisation / Distribution channel (sales views) | SAP-MM ⚠ | — | — | — | multi-company ERP structure, not F&B menu structure |
| BOM / Production BOM / Recipe reference | SAP-BP ⚠ | `recipe` (`§7.1`, Phase 2) | no | `OH` | **the recipe stays ours.** A chain's ERP may hold a production BOM for a manufactured good; the culinary recipe, its versions and its costing (Phase 2) are the product's own model, and the two are linked by reference, never merged |

**The article row, stated plainly:** identity, UOM, material type/group, weights and
dimensions, storage/life, batch/serial, valuation, tax classification, customs, manufacturer
and revision come from the ERP where one exists; **menu name, category, per-outlet price,
compliance fields (dietary mark, allergens, nutrition, serving size), channel flags, our
lifecycle and the recipe stay ours**, because an ERP has no opinion about an FSSAI
declaration or a per-outlet menu price.

### 20.2 Raw material (the purchased component)

Our raw material (`§8.1`) is closer to an ERP item than the article is: for most chains this
record *is* a purchased material, and this is where the owner's parity direction bites hardest.

| ERP field (view / table) | source | our field | req. | owner | notes |
|---|---|---|---|---|---|
| Material number / Item number | SAP-MM ⚠ · MS-PIM ✔ | `code` or `external_key` (§20.1) | yes | `split` | same rule as the article, same chain-level setting |
| Material type, Material group | SAP-MM ⚠ | `materialType`, `materialGroup` **(new)** | yes | `ERP` | the material group is what a purchase analysis is grouped by; our `category` stays for reporting our way |
| Base unit of measure | SAP-MM ⚠ · MS-UOM ✔ | `baseUom` | yes | `split` | |
| Alternative units of measure + conversion factors (e.g. order unit, ISO unit, unit of issue) | SAP-BP-ALT ⚠ · MS-UOM ✔ | `alternativeUoms[] { uom, numerator, denominator, baseQtyEquivalent, category, eanUpc? }` **(new, §21.2)** | no | `split` | **this is the field set our `§10.2` conversion rows already model**, so the ERP's alternative UOMs *import into* our conversion table rather than living beside it. The ERP's own UOM *category* (order/issue/stockkeeping) is carried as an attribute so an export can rebuild its view |
| EAN/UPC, GTIN | SAP-MM ⚠ · MS-⚠ | `barcodes[] { scheme, value, uom }` **(new)** | no | `split` | a chain's POS and its ERP disagree about which code is "the" barcode; we hold a set, marked primary |
| Purchase order unit, order unit ↔ base conversion, order rounding value, minimum order quantity, minimum/maximum delivery quantity, over/under-delivery tolerance, planned delivery time, GR processing time | SAP-MM ⚠ | `purchasingDefaults { orderUom, orderToBaseFactor, roundingValue, minOrderQty, overDeliveryPct, underDeliveryPct, plannedDeliveryDays, grProcessingDays }` **(new, §21.2)** | no | `split` | Phase 3 (indent → PO) reads these. `moq` already exists on the vendor item (`§8.1`); the record-level value is the default and the vendor item overrides it, stated in the UI |
| Purchasing group, Purchasing value key | SAP-MM ⚠ | — | — | — | a *person/team* and an ERP reminder profile. Not an attribute of a tin of tomatoes; the planner mapping belongs to Phase 3 |
| MRP type, MRP controller, Reorder point, Safety stock, Lot size, Planned delivery time, MRP group, Strategy group, Consumption mode, Scheduling margin key | SAP-MM ⚠ | `reorderPoint`, `safetyStock` **(new)**; the rest `—` | no | `split` for the two, `—` for the rest | the parameters a *store* acts on are carried; the ERP's planning *algorithm* configuration is not. F&O's equivalent is coverage group + item coverage (MS-⚠) |
| Lot control / Batch management (required, optional, none), Serial number profile, Shelf-life check, QM inspection setup, Certificate requirement, Quality-management authorisation group | SAP-MM ⚠ · MS-CPM ✔ (tracking dimension group) | `batchManagement`, `serialProfile`, `inspectionFlags {}` **(new, §21.2)** | no | `ERP` | these flags decide whether Phase 3's GRN can post without a batch, so they are *behavioural* and must arrive with the record, not be re-typed |
| Storage conditions, Temperature condition, Storage bin / Storage location, Warehouse number, Maximum storage period, Storage unit type | SAP-MM ⚠ | `storageType`, `storageCondition`, `temperatureCondition`, `storageBin` **(new)** | no | `split` | `storageType`/`storageTempMinC`/`MaxC` already exist (`§8.1`) and stay the operational values; the ERP's codes are carried alongside |
| Total shelf life, Minimum remaining shelf life, Shelf life days | SAP-MM ⚠ | `shelfLifeDays` (`§8.1`), `totalShelfLifeDays`, `minRemainingShelfLifeDays` **(new)** | no | `split` | see §20.1 |
| Gross weight, Net weight, Volume, Dimensions, Weight unit, Volume unit | SAP-MM ⚠ · MS-PIM ✔ | same as §20.1 **(new)** | no | `split` | a logistics figure for freight, a culinary figure for a recipe |
| Valuation class, Price control (standard/moving average), Standard price, Moving average price, Valuation currency, Valuation area (plant) | SAP-MM ⚠ · MS-⚠ | `valuationClass`, `priceControl`, `standardPrice`, `movingAveragePrice` **(new, §21.2)** + existing `standardCost` | no | `ERP` | `§8.1`'s `standardCost` + `costSource` stays the *operational* cost with its own effective dating; the ERP's valuation price is carried as the ERP's figure. **They are reconciled, not merged**: a variance between the two is a report (§23.6), never an automatic rewrite of our cost |
| Tax classification, Tax group, Tax jurisdiction | SAP-MM ⚠ | `taxClass` + `erpTaxClassification` | yes | `split` | as §20.1 |
| Country of origin, Customs tariff number / HS code, Preference status, Export/import control | SAP-MM ⚠ · MS-⚠ | `countryOfOrigin`, `customsTariffNumber`, `exportControlClass` **(new)** | no | `split` | |
| Manufacturer, Manufacturer part number, Vendor account (source of supply) | SAP-MM ⚠ · MS-BC-ITEM ✔ | `manufacturerName`, `manufacturerPartNumber`, `vendors[]` (`§8.1`) | no | `split` | the vendor *list* stays ours (approved vendors are an MDM decision); the ERP's source list is a proposal |
| Revision level, Change number | SAP-MM ⚠ | `revisionLevel`, `changeNoticeRef` **(new)** | no | `ERP` | |
| Deletion flag / Deletion indicator / Blocking | SAP-MM ⚠ | `erpBlocked` + reason **(new)** | no | `ERP` | **never mapped onto our `status`.** An ERP deletion flag does not deactivate a raw material in OmniHost: a recipe using it would silently become uncosted. It raises a *review item* (`erpBlockedUpstream`, §23.6) instead |
| ABC indicator, Hazardous material number, Transport/ADR data | SAP-MM ⚠ | `—` / `hazardClass`, `transportNotes` **(new, optional)** | no | `split` | hazard and transport data is owner-mentioned in `DECISIONS.md`; carried as optional fields with a jurisdiction profile able to require them (§14) |

### 20.3 Vendor

Our vendor (`§9.1`) is a *chain's trading partner for purchase*. An ERP calls it a business
partner with a supplier role (SAP) or a vendor master (Dynamics/Business Central), and the
overlap is large — which makes ownership the whole question.

| ERP field | source | our field | req. | owner | notes |
|---|---|---|---|---|---|
| Vendor account number / Supplier number (LIFNR) / Vendor No. | SAP-MM ⚠ · MS-⚠ | `code` or `external_key` | yes | `split` | same rule as the article; a chain almost always already has supplier numbers, so **the recommended default for vendor is `code` = ERP account** and our own code only where the chain has no ERP |
| Business partner / Supplier name, Search term, Trading name | SAP-MM ⚠ · MS-BC-ITEM ✔ (vendor card) | `legalName`, `tradeName` | yes | `split` | the legal invoicing name must match the ERP's; the trade name the kitchen uses stays ours |
| Company code / Legal entity, Country/region, Address | SAP-MM ⚠ · MS-⚠ | `address` (`§9.1`) | yes | `split` | the ERP's *company-code-anchored* address (a partner can have many) vs our single invoicing address. Where a chain's ERP holds several, the import reports them and MDM picks the invoicing one |
| Tax registration: VAT registration number, tax number, GSTIN-style registration, country-specific | SAP-MM ⚠ | `taxRegistrations[]` (`§9.1`) | yes where the regime requires | `ERP` | **the ERP is the master of the registration numbers**; our verification state (`verifiedAt`/`verifiedBy`) stays ours — an ERP does not verify a certificate |
| Currency, Payment terms, Payment method, Incoterms, Credit limit, Dunning/interest | SAP-MM ⚠ | `billingCurrency`, `paymentTerms`, `creditLimit` (`§9.1`) | yes | `ERP` | financial terms are commercially owned by the ERP; a change here is a financial change in our audit trail too, attributed to the integration |
| Bank details: bank account, IBAN/SWIFT, bank key, alternative payee | SAP-MM ⚠ | `remittance` (`§9.1`) | no | `ERP` | **carried, masked, and never our master** (`mdm.vendor.bank.view` is already a separate audited read). We do not accept an ERP bank change as an instruction to pay — the record says who holds it |
| Purchasing organisation / Purchasing group, Order currency, Terms of payment (purchasing view) | SAP-MM ⚠ | `—` (per-vendor `paymentTerms` only) | no | — | purchasing-organisation structure is the ERP's; only relevant if we later do multi-company POs |
| Vendor type / Vendor group / Vendor classification | SAP-MM ⚠ | `vendorType` (`§9.1`) | yes | `split` | our enum (`manufacturer`/`distributor`/…) is operational; the ERP's group is a code we map to it (§22.3) |
| Blocked / Blocking indicator, Deletion flag | SAP-MM ⚠ | `status` mapping | no | `ERP`→review | **a block is not a suspension**: an ERP block raises a review item (`erpBlockedUpstream`) so a human decides between `suspended` and `inactive`, because our suspension flags open POs and that is a business decision |
| Withholding tax type/code, tax jurisdiction code | SAP-MM ⚠ · MS-⚠ | `taxRegistrations` + `erpTaxClassification` **(new)** | no | `ERP` | |
| Country/region of origin (vendor), DUNS / registration ids | SAP-MM ⚠ | `—` | no | — | not needed for F&B procurement at this depth |
| Vendor evaluation / scorecard fields | SAP-MM ⚠ | — (Phase 3 scorecards are computed from our own transactions) | no | `OH` | an ERP's scorecard derives from the ERP's postings; ours must derive from ours, or the two numbers will disagree and both will be "right" |

### 20.4 UOM and conversion

| ERP field | source | our field | req. | owner | notes |
|---|---|---|---|---|---|
| Unit of measure code, ISO/UN code (e.g. *International Standard Code*) | SAP-MM ⚠ · MS-BC-UOM ✔ | `code` (`§10.1`) | yes | `split` | **Business Central's unit-of-measure record carries an international standard code**, and our `§10.1` already prefers UN/CEFACT-recognised codes — so the code map is often the identity function. That is a happy accident we should exploit, not a design guarantee |
| Unit of measure text/description | MS-BC-UOM ✔ | `labelKey` (catalog) | yes | `OH` | the label is translated from a catalog key; the ERP's text is *data* and is shown as the ERP's own description, never as our label |
| Decimal places / rounding precision / quantity rounding | SAP-MM ⚠ · MS-UOM ✔ (`Manage units of measure`, conversions) | `precision`, `rounding` (`§10.1`) | yes | `OH` | **ours stays the master**: precision is a domain rule (`0.5 kg` must not become `0.500 kg`) and a locale must not change it |
| Base unit of measure of the unit record / numerator-denominator conversion factor (alternate unit of measure) | SAP-BP-ALT ⚠ · MS-UOM ✔ | `factor` + `factorNumerator`/`factorDenominator` (`§10.2`) | yes | `split` | imported as conversion rows; **we keep the jurisdiction dimension the ERP does not have** (a cup is 240 ml or 250 ml by market, §10.2) and a conversion that is jurisdiction-ambiguous on import raises `ambiguousConversion` (Phase 2's vocabulary, §23.6) |
| Unit of measure group (Business One / BC item UoM groups) | SAP-B1 ⚠ · MS-BC-UOM ✔ | — | — | `—` | a *grouping of units for one item* is what our per-item `alternativeUoms` already expresses; carrying the group name too would be a second way to say the same thing |
| Conversion to a dimension the ERP does not distinguish | — | `dimension` (`§10.1`) | yes | `OH` | the ERP will happily convert kg↔L if its config says so; we refuse a cross-dimension conversion outright (§10.1) |

### 20.5 Tax class

| ERP field | source | our field | req. | owner | notes |
|---|---|---|---|---|---|
| Tax classification 1–9 (MWST), tax type (TATY), tax jurisdiction code | SAP-MM ⚠ | `taxClass` (`§11.1`) + `erpTaxClassification` **(new)** | yes | `split` | the ERP's tax classification is a single code per category; our `taxClass` carries regime, supply type, components and effective windows (§11.1). We carry the ERP's code for round-tripping and **do not** collapse our model into it |
| Item sales tax group, Sales tax group, Item VAT group | MS-⚠ | `taxClass` | yes | `split` | the F&O pair (item group × tax group) is exactly what our `taxClass` + `jurisdiction` expresses; the mapping is data |
| VAT product posting group / VAT business posting group (Business Central) | MS-BC-ITEM ✔ (`VAT Prod. Posting Group` on the item card) | `taxClass` | yes | `split` | same reasoning |
| Tax rate, percentage, validity period | SAP-MM ⚠ · MS-⚠ | `tax_rate` (`§11.1`) | yes | `split` | **rates are per jurisdiction and effective-dated in our model** (§11.2: never edited in place). An ERP sends a rate with *its* validity window; an importing rate that overlaps an existing window raises `validation.effectiveWindowOverlap` and is refused into the report rather than overwriting history |
| Tax registration scheme on the chain's own entity | SAP-MM ⚠ | chain record (Phase 0, not re-specified) | — | `ERP` | the chain's own registrations are the ERP's business |

### 20.6 Site and outlet

| ERP field | source | our field | req. | owner | notes |
|---|---|---|---|---|---|
| Plant / Plant code, Storage location, Warehouse, Operational site, Site | SAP-MM ⚠ · MS-⚠ | `site.code` + `external_key` **(new)**; outlet stays ours | yes | `split` | **the ERP's plant is not our site, and the difference matters.** One F&B site can map to several plants (a bar and a kitchen), and several ERP sites can be one trading site. The mapping table (§22.3) is many-to-many with a stated direction, not an assumed one |
| Address, country/region, time zone, calendar | SAP-MM ⚠ | `address`, `jurisdiction`, `timezone` (`§12.1`) | yes | `split` | jurisdiction and timezone stay **ours** (they drive compliance, tax and rendering); the ERP's are imported as *proposals* with the mismatch reported, because a silent change of a site's jurisdiction changes what the menu must declare |
| Currency (company code / plant currency) | SAP-MM ⚠ | `currency` (`§12.1`) | yes | `split` | our `currency` is the trading currency; the ERP's is the company-code currency. Where they differ, the row is flagged (§23.6 `currencyScopeMismatch`) rather than overwritten |
| Sales organisation, Distribution channel, Division | SAP-MM ⚠ | — | — | `—` | ERP commercial structure |
| Purchasing organisation, Receiving storage location | SAP-MM ⚠ | outlet `kind` (`§12.2`) + `—` | no | `OH` | our outlets are *service* surfaces; a receiving location is a store concept (Phase 3) |
| Language / locale of the plant | SAP-MM ⚠ | `locale` (`§12.1`) | no | `split` | **our locale resolution order wins** (`DECISIONS.md`: user → site → chain → platform); an ERP language is not a source of truth for our interface language, and is not imported |
| Business partner / customer role for the site (if the ERP bills the site) | MS-⚠ | — | — | `—` | out of scope until the ERP owns guest invoicing, which it does not in this product |

---

## 21. The record changes — the fields an ERP holds that we do not

Everything in this section is **additive**. No Part I field changes type, meaning or
required-ness, and no master gains a shadow record. The types are the ones defined at `§7.1`
(`code`, `money`, `qty`, `pct`, `text`, `ref`, `jsonb`, `date`, `instant`), extended by two:

- `qtyUom` = `{ qty numeric(18,6), uom ref uom }` — **a quantity never travels without its
  unit**, in storage as well as on screen.
- `measureUnit` = `{ value numeric(18,6), uomCode code, dimension enum }` — for a value whose
  dimension matters (weight, volume, length) but whose display unit is a preference
  (the same rule `§8.1` already applies to storage temperature in Celsius).

Each row below states **required** as: `yes` (the record is unusable without it), `if ERP`
(the integration refuses to import the record without it — a chain with no ERP never sees
it), `no`. `jurisdiction-dependent` follows `§14`: a market's profile may make an optional
field required, and the interface renders the rule rather than containing it.

### 21.1 Article — additions

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `materialType` | `code` + `labelKey` (mapped) | if ERP | no | the ERP's material/item type. Drives *our* hidden-when-irrelevant rules (§25.2) and is the field a chain's own reports are grouped by |
| `materialGroup` | `ref erp_code_map` (list `material_group`) | no | no | the ERP's reporting group; kept **beside** our `category`, never in place of it. Both are selectable in the list filter, labelled so an operator can tell them apart |
| `variantOf` / `variantAxes` | `ref article` self · ordered set `{ axisCode, valueCode }` | no | no | a size/style/colour family. A variant carries its own price and availability and **inherits everything else**; an inherited value is marked `inherited` and is not editable on the variant (the §15 sub-grid rule, applied vertically) |
| `erpLifecycleState` | `code` + `labelKey` | no | no | the ERP's lifecycle state, shown read-only beside our `status` — never merged into it (§22.5) |
| `erpBlocked` | boolean + `erpBlockedReason` (text) | no | no | the ERP's block/deletion flag, mirrored. **It never changes our `status`**: it raises a review item |
| `netWeight` / `grossWeight` / `tareWeight` | `measureUnit` | no | no | logistics figures at the ERP's unit. Distinct from a recipe's component weight, which is Phase 2 data |
| `volume` | `measureUnit`, dimension `volume` | no | no | |
| `dimensions` | `{ length, width, height }` of `measureUnit` | no | no | for a packaged/trading article; empty for a plated dish |
| `storageCondition` | `code` + `labelKey` (mapped list) | no | no | the ERP's storage condition code |
| `temperatureCondition` | enum `unregulated`/`ambient`/`chilled`/`frozen`/`deep_frozen` | no | no | complements `storageType` (`§8.1`) |
| `shelfLifeDays` / `totalShelfLifeDays` / `minRemainingShelfLifeDays` | integer | no | no | three different figures with three different meanings; the UI labels each and never sums them |
| `batchManagement` | enum `none`/`optional`/`required` | no | no | *behavioural*: Phase 3's GRN refuses to post a batch-controlled item without a batch |
| `serialProfile` | `code` + `labelKey`, nullable | no | no | as above, for serialised items |
| `inspectionFlags` | `{ receiptInspectionRequired: boolean, certificateRequired: boolean, shelfLifeCheck: boolean, authorisationGroup: code? }` | no | no | the ERP's QM setup, mirrored. Phase 4 (QA) is where it becomes a workflow; here it is a promise the record makes |
| `valuationClass` | `code` + `labelKey` | no | **yes** | valuation is per (ERP) company code / plant — our jurisdiction-shaped rule set can mark it required in a market where the chart of accounts is mandated |
| `priceControl` | enum `standard`/`moving_average` | no | no | which of the two prices below the ERP actually uses — the field that makes the next two readable |
| `standardPrice` / `movingAveragePrice` | `money` | no | no | the ERP's valuation prices. **Not our `standardCost`**: it is the ERP's figure, read-only here, and a divergence is a report (§23.6) |
| `erpTaxClassification` | `{ taxClassificationCode, taxGroup, taxJurisdictionCode }` | no | **yes** | codes carried for round-tripping; our `taxClass` remains the model that computes a bill |
| `countryOfOrigin` | ISO 3166-1 alpha-2 | no | **yes** | the customs origin; a market may require it on the menu or the label. **Not** `hsnSacCode` |
| `customsTariffNumber` | `text` | no | **yes** | the importing market's tariff/HS heading |
| `exportControlClass` | `code`, nullable | no | **yes** | only where a market mandates it |
| `manufacturerName` / `manufacturerPartNumber` | `text` | no | no | per-locale content where the manufacturer is a chain's own brand |
| `revisionLevel` / `changeNoticeRef` | `text` / `ref erp_change_notice`, nullable | no | no | engineering-change level |
| `barcodes` | ordered set `{ scheme enum gtin/ean/upc/internal, value text, uom ref uom, primary boolean }` | no | no | a set, one primary. A single `barcode` column would have to be migrated the first time a second packaging level appears |
| `erpAdmin` | `{ system, primaryKey, sourceVersion, lastSyncAt, mirrorHash }` | no | no | the mirror bookkeeping (§22.2), rendered as the `ProvenanceChip` and never as an editable field |

### 21.2 Raw material — additions

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `materialType` / `materialGroup` | as §21.1 | if ERP | no | |
| `alternativeUoms` | rows `{ uom ref uom, numerator numeric(24,12), denominator numeric(24,12), baseQtyEquivalent qty, category enum order/issue/stockkeeping/price, eanUpc? text, validFrom date }` | no | no | **imports into `§10.2`'s conversion model** — one conversion table in the system, not two. The `category` is carried so an export can rebuild the ERP's view of which unit is the order unit |
| `purchasingDefaults` | `{ orderUom, orderToBaseFactor, roundingValue qty, minOrderQty qty, overDeliveryPct pct, underDeliveryPct pct, plannedDeliveryDays integer, grProcessingDays integer }` | no | no | Phase 3 reads them; the vendor item's own `moq`/`leadTimeDays` (`§8.1`) override and the UI says which won |
| `reorderPoint` / `safetyStock` | `qtyUom` | no | no | a *value* Phase 3 acts on. The ERP's planning algorithm configuration is not carried (§20.2) |
| `valuationClass` / `priceControl` / `standardPrice` / `movingAveragePrice` | as §21.1 | no | **yes** | `standardCost` + `costSource` (`§8.1`) stay ours; these are the ERP's |
| `batchManagement` / `serialProfile` | as §21.1 | no | no | **behavioural** |
| `inspectionFlags` | as §21.1 | no | no | |
| `storageCondition` / `temperatureCondition` / `storageBin` | as §21.1 + `storageBin` `code` nullable | no | no | `storageType` + `storageTempMinC`/`MaxC` (`§8.1`) are the operational values and stay |
| `totalShelfLifeDays` / `minRemainingShelfLifeDays` | integer | no | no | beside the existing `shelfLifeDays` + `shelfLifeBasis` |
| `netWeight` / `grossWeight` / `volume` / `dimensions` | as §21.1 | no | no | |
| `erpTaxClassification`, `countryOfOrigin`, `customsTariffNumber`, `exportControlClass` | as §21.1 | no | **yes** | |
| `manufacturerName` / `manufacturerPartNumber` | as §21.1 | no | no | |
| `hazardClass` / `transportNotes` | `code` + `labelKey` / `text` | no | **yes** | owner-mentioned (hazard and transport data); a market's profile can require them, and they are **never** shown to a guest surface |
| `revisionLevel` / `changeNoticeRef` | as §21.1 | no | no | |
| `erpBlocked` | boolean + reason | no | no | mirrors the ERP's block; never our `status` |
| `barcodes` | as §21.1 | no | no | |
| `erpAdmin` | as §21.1 | no | no | |

### 21.3 Vendor — additions

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `erpAccountGroup` | `code` + `labelKey` (mapped) | no | no | the ERP's vendor account group, mapped to our `vendorType` in config; both are shown, ours is editable |
| `erpTaxClassification` | `{ taxClassification, withholdingTaxType, withholdingTaxCode, taxJurisdictionCode }` | no | **yes** | |
| `erpBlocked` / `erpDeletionFlag` | boolean + `erpBlockedReason` | no | no | raises `erpBlockedUpstream`, never a silent suspension |
| `incoterms` | `code` + `location`, nullable | no | **yes** | a market's customs paperwork needs it |
| `legalEntityScope` | set of `code` | no | no | which (ERP) company codes this vendor is extended to. Empty means "not yet extended", stated as such rather than as "all" |
| `erpAdmin` | as §21.1 | no | no | |

`remittance`, `paymentTerms`, `billingCurrency` and `creditLimit` (`§9.1`) **do not change
shape** — they gain a provenance marker when the ERP is their master (§25).

### 21.4 UOM — additions

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `erpCode` | `ref erp_code_map` (list `uom`) | no | no | the ERP's unit code for this unit; the mapping table is the authority, this is the denormalised display (§22.2) |
| `unitCategory` | enum `order`/`issue`/`stockkeeping`/`price`/`none` | no | no | the ERP's category, carried so an export can rebuild its view (per material where the ERP varies it — hence also on `alternativeUoms`) |
| `erpAdmin` | as §21.1 | no | no | |

`precision`, `rounding`, `dimension`, `baseUnitOfDimension` are **ours and stay ours** (§20.4).

### 21.5 Tax class — additions

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `erpTaxCode` / `erpTaxGroup` / `erpTaxJurisdictionCode` | `ref erp_code_map` (list `tax_class`) | no | **yes** | the ERP's codes for this class. The map is many-to-many-capable because one ERP tax code can correspond to several of our classes (a class per supply type) |
| `erpAdmin` | as §21.1 | no | no | |
| `tax_rate` | *(unchanged)* | — | — | an imported ERP rate becomes a **new effective-dated row**, never an in-place edit; an overlapping window is refused into the report (§11.2 holds) |

### 21.6 Site and outlet — additions

| field (key) | type | required | jurisdiction-dependent | notes |
|---|---|---|---|---|
| `erpOrgUnits` | rows `{ system, orgUnitType enum company_code/plant/storage_location/warehouse/sales_org/channel, erpCode, primary boolean }` | no | no | **the many-to-many site↔plant map lives here**, not as a single `plant` column. A site with a bar and a kitchen maps to two plants and says which one is primary |
| `erpTaxJurisdictionCode` | `code`, nullable | no | **yes** | the ERP's tax jurisdiction for the site, carried; our `jurisdiction` (`§12.1`) still drives compliance and is never overwritten by an import |
| `erpCompanyCode` | `code`, nullable | no | no | |
| `erpAdmin` | as §21.1 | no | no | |
| outlet | *(unchanged)* | — | — | an outlet stays a service surface (`§12.2`); it gains only the ERP marker when a value came from an import, and the `erpOrgUnits` rows a site holds can point at an outlet-level scope where the chain's ERP is outlet-granular |

### 21.7 What is deliberately *not* changed by Part II

1. **Licence tier stays on the chain record** (owner-locked). Nothing in §20–§26 puts a tier,
   an ERP, or an integration entitlement on a site, an outlet or a master record. Whether ERP
   integration is a **Gold/Platinum capability** is a commercial question for the owner (§26.6
   is my recommendation, not a decision).
2. **`status`, `version`, `prices`, `compliance`, `allergens`, `nutrition`, `recipe` are
   untouched.** No ERP field maps onto them.
3. **`externalRef` + `sourceSystem`** (`§12.1`, `§16` item 2) are **superseded by the
   `external_key` set** (§22.2) but not removed: they remain the *display* of the primary
   external key, so existing screens, imports and audit rows keep working and there is still
   exactly one place a key is stored.
4. **No `erp_*` JSONB blob on the master record.** Every ERP field that matters is a named
   column with a type. A blob would make the ownership rule (§22.4) unenforceable and the
   parity catalogue unverifiable, which is the whole point of the exercise.

---

## 22. Identity and mapping — one internal id, many external keys, mapped code lists

### 22.1 Internal identity

- Every master record keeps its **stable internal id** (`uuid`, never shown, used by the
  audit log and by referential integrity across versions) and its **business `code`**
  (`§7.1`: chain-unique, immutable once approved, the key a URL, an import, a chatbot
  reference and an audit row use).
- **A record is never identified by an ERP key alone.** If a chain's ERP renumbers a material
  (it happens after a migration or a company-code carve-out), the record must survive: the
  external key is a row that can be re-pointed, the internal id is not.
- **`code` may *be* the ERP's number** where the chain decides so (§20.1): a chain-level
  setting, `erp.identity.mode: erp_number | omnihost_number`, recorded per entity. The two
  modes are both supported and both audited; there is no third, implicit mode.

### 22.2 External keys — the `external_key` table

```
external_key
  id              uuid
  chain_id        uuid        (tenant column on every table — unchanged rule)
  entity_type     enum article|raw_material|vendor|uom|tax_class|site|outlet|
                       article_category|raw_material_category|erp_change_notice
  entity_id       uuid        (the internal id; a FK per entity_type, enforced in the API)
  system          ref erp_system   (which connected system — a chain may run two)
  key_type        enum material_number|item_number|vendor_account|unit_code|
                       tax_group|tax_classification|plant|storage_location|warehouse|
                       sales_org|vendor_item_number|manufacturer_part_number|
                       external_guid|external_code
  value           text        (as the ERP holds it: leading zeros preserved, string-typed)
  is_primary      boolean     (one primary per (entity, system))
  first_seen_at   instant
  last_seen_at    instant
  status          enum active|retired
  unique (chain_id, system, key_type, value)
  unique (chain_id, entity_type, entity_id, system, key_type) where is_primary
```

Rules that make it usable:

1. **Keys are strings, compared trimmed and case-sensitively.** `0000123456` is not
   `123456`, and a leading zero lost by a spreadsheet import is a support ticket we do not
   want to have. Case-sensitivity is stated because two ERP keys differing only by case exist.
2. **`is_primary` is display and matching priority, not identity.** Old keys stay as
   `active` rows so a historical payload still resolves; a re-pointed key is `retired` with a
   link to the new one, never deleted.
3. **A key is scoped to `(chain, system)`.** Two chains that run the same ERP and the same
   material numbers are not confused, because the chain is in the unique index.
4. **The record shows the key it was last matched on** — `ProvenanceChip` = system code +
   key type + value + last sync instant (§25.3).
5. **Writes are audited like any other change** (`external_key.link` / `.unlink` /
   `.repoint`, `entityType: external_key`), because a wrong link is how a sync corrupts two
   records at once.

### 22.3 Code maps — our code lists and the ERP's

```
erp_system
  id, chain_id, code                     -- e.g. 'D365FO', 'S4H', 'BC', 'B1'
  vendor            enum sap_s4hana|sap_business_one|dynamics_finance_ops|
                         dynamics_business_central|generic_csv|rest_odata|rest_custom
  display_name      per-locale content
  endpoint          url, nullable        -- for api/odata modes
  auth_secret_ref   text, nullable        -- the NAME of a secret; never the secret
  exchange_mode     enum realtime_api|scheduled_delta|file_drop|manual_csv
  direction_default enum inbound|outbound|bidirectional|none
  field_mapping_set ref erp_mapping_set
  status            enum active|paused|error|not_configured
  last_run_at, last_run_status

erp_code_map
  id, chain_id, system
  code_list         enum uom|tax_class|material_group|category|article_type|
                         vendor_group|plant|warehouse|currency|country|unit_category|
                         lifecycle_state|reason_code
  our_code          code, nullable        -- null = the ERP code has no counterpart yet
  erp_code          code, nullable        -- null = our code has no ERP counterpart yet
  valid_from, valid_to date
  note_key          catalog key (why this mapping exists, e.g. a market-specific unit)
  unique (chain_id, system, code_list, our_code) where valid_to is null
  unique (chain_id, system, code_list, erp_code) where valid_to is null
```

**The rule when a code exists on one side only** — this is the rule the whole mapping layer
exists for, and it has four parts:

| situation | what happens | what a human sees |
|---|---|---|
| ERP code, no mapping, inbound | the **field** does not apply; the raw ERP code is recorded as a row in `erp_unmapped_code` (chain · ERP system · entity · code list · ERP code · affected field · seen at) so nothing is lost; the record imports | `unknownErpCode` (§23.5) naming the code list, the code and the affected fields, with *Map it* (`mdm.erp.code_map.update`) · *Create our code* (`mdm.uom.create` / `mdm.tax_class.create`, permission-dependent) · *Ignore for now* (recorded) |
| ERP code, no mapping, outbound | the **record's export** is refused for that field, never guessed and never sent blank | `missingCodeMapping` in the export report, with the count of records it blocks and a link to *Map it* |
| our code, no ERP code, inbound | our record keeps its value; the ERP simply has nothing to say | nothing (this is normal — our `category` tree has no ERP counterpart by design) |
| our code, no ERP code, outbound | the field is omitted from the payload and listed in the report as `notExported` with the reason | `notExported` rows in the export report, grouped by field, **not** a per-record wall of text |

Two hard rules on top:

- **Nothing is auto-created from an ERP code.** A UOM, a tax class or a category appears in
  our model only through the create permission that owns it (`mdm.uom.create`,
  `mdm.tax_class.create`, …). An integration that can invent master data can invent a wrong
  one, and a wrong UOM silently mis-costs every recipe that uses it.
- **A mapping is never edited in place.** `valid_from`/`valid_to` supersede the old row, for
  the same reason a tax rate does (§11.2): a re-costed recipe must be explainable against the
  mapping that was in force when it was costed.
- **An unmapped code is a row, not a blob on the record.** The raw code lives in
  `erp_unmapped_code`, keyed by chain, ERP system, entity type, entity id and code list, with
  the field it affected and when it was seen — not in an `erp_*` map on the master record,
  which decision **D1** forbids for the same reason this section exists: a blob on a record
  cannot be made enforceable, its field set cannot be verified, and ownership stops being
  declarable. Rows also make the *same* code findable across every record it touched, which is
  what turns "someone must map a code" into one task rather than fifty.
  *(Corrected Sept 2026 — designer. This section said "stored in the record's
  `erpAdmin.unmapped` map" until slab 1 landed as rows:
  `erp_unmapped_code` in `db/migrations/0007_mdm_reference.sql`.)*

Mapping lists that exist in both systems and are **not** code-mapped, by design:
`currency` (ISO 4217 is the shared code — no map needed), `country` (ISO 3166-1), and the UOM
codes where Business Central's international standard code already agrees with `§10.1`'s
UN/CEFACT preference (§20.4). The map table carries a `null`-tolerant row for these so a chain
can still record an exception without a schema change.

### 22.4 Field ownership — declared per entity and field group, enforced server-side

```
erp_field_ownership
  id, chain_id, system
  entity            enum article|raw_material|vendor|uom|tax_class|site|outlet
  field_group       enum identity|classification|units|dimensions|storage|shelflife|
                         batch_serial|quality|purchasing|valuation|tax|origin_customs|
                         manufacturer|revision|lifecycle|terms|bank|contact|address|org_unit|
                         price_compliance_culinary   -- the ones that are always ours
  field             text, nullable     -- null = the whole group
  owner             enum erp|omnihost|erp_with_site_override|split
  inbound_action    enum apply|propose|ignore
  outbound_action   enum send|skip
  override_allowed  boolean            -- may a human edit an ERP-owned value here?
  note_key          catalog key        -- the "why", shown in the UI (§25.3)
```

- **The default set ships as configuration, not as code** (a seeded mapping set per vendor
  kind, §24.2), and a chain's own deviations are rows. A chain that runs one ERP and wants
  everything ERP-mastered says so once.
- **The server enforces ownership on every write path.** A write to a field whose ownership is
  `erp` and `override_allowed: false` is refused with `erp.ownership.refused` naming the
  field, the group and the system — *not* merely hidden in the UI. Where
  `override_allowed: true`, the write is accepted, audited with `provenance: local_override`,
  and **the next inbound payload does not silently revert it**: the run produces
  `localOverrideStands` in the report and the ERP's differing value is held for review. That
  single behaviour is what stops an integration from becoming a machine that erases
  operators' work.
- **`price_compliance_culinary`** is a field group that is always `omnihost` and is not
  configurable: per-outlet price, compliance fields, allergens, nutrition, serving size and
  the recipe. A configuration screen that let a chain hand those to an ERP would be a
  foot-gun, so the group is absent from the chooseable list and the screen says why.

### 22.5 Identity resolution on import (the matching ladder)

Matching is deterministic and stated in the run report per row:

1. **`external_key` match** on `(chain, system, key_type, value)` → the row is that record.
2. **`code` match** on the chain's business code, case-insensitive and trimmed.
3. **Soft-key candidate match** — the master's own de-dup keys (`§8.2` for raw materials;
   tax registration for vendors), with the *names* shown side by side.
4. **No match → create as new**, landing at the master's lifecycle rule: `pending_review`
   where the chain is approval-gated (`§6`), directly `active` on a basic-lists tier — with
   the whole run audited either way.

A soft-key match **never auto-merges**. It produces a `possibleDuplicate` row with *merge* ·
*keep both* · *not a duplicate* and the decision is recorded (`vendor.duplicateReviewed`
extends to every master here). Name similarity is a hint, never an identity (§8.2 already
says so for raw materials; this is the same rule for imported rows).

**ERP lifecycle vs our lifecycle.** Two states, two meanings, never merged:

| | drives | who owns | how it moves |
|---|---|---|---|
| our `status` (`§6`, `§7.1`) | what the product does — sellable, purchaseable, selectable | OmniHost permissions | the lifecycle transitions in `§6`, permission-gated and audited |
| `erpLifecycleState` / `erpBlocked` | what the ERP posts | the ERP | arrives by import; raises a review item when it implies a state we might want to mirror |

An ERP block therefore produces a **review item, not a state change** (`erpBlockedUpstream`,
§23.6). The alternative — an inbound payload deactivating a raw material that twenty recipes
use — is exactly the failure the "one vocabulary, one decision" rule exists to prevent.

### 22.6 Money, quantity and unit identity

- **Money is always `{ amount, currency }`** (`§8.4`). An ERP price arrives with the ERP's
  currency; it is stored with it, and a total across currencies is refused or grouped, never
  summed. An ERP field that carries an amount with no currency (an ISO/valuation price in the
  company code's currency) imports with the currency **named by the mapping**, and a mapping
  with no currency declared is a configuration error the connection screen refuses to activate.
- **A quantity never travels without a UOM.** `qtyUom` in storage, mono code on screen,
  `QuantityValue` to render. An inbound quantity whose unit has no map is `unknownErpCode`,
  not a bare number.
- **Rounding follows the currency's ISO 4217 exponent and the UOM's `precision`** (`§10.1`,
  `§8.4`). An inbound value with more decimals than the target `precision` is rounded **and
  reported** (`unitPrecisionLoss`), never silently truncated into a cost.

---

## 23. The sync design (spec level)

### 23.1 The three flows, and the four exchange modes

| flow | direction | what it does | our master |
|---|---|---|---|
| **Inbound (import)** | ERP → OmniHost | creates/updates masters from a payload; never deletes | the ERP, for the fields §22.4 says so |
| **Outbound (export)** | OmniHost → ERP | sends the values only we hold (site-level overrides, our categories, our article content) plus the fields the chain declared `outbound_action: send` | ours |
| **Reconciliation** | both | a periodic read-only compare: records on one side only, and values that differ on a `split`-owned field | neither — it reports, a human decides |

`erp_system.exchange_mode` selects the transport, and **the domain code never knows which one
is in use**:

| mode | transport | first-sync behaviour | notes |
|---|---|---|---|
| `realtime_api` | OData/REST pull (F&O, S/4) or push | full pull, then delta by changed-on | needs credentials and outbound network from our side |
| `scheduled_delta` | a scheduled pull of a delta window (changed-since) | full pull once, then a window with overlap | **the recommended default**: overlap makes a missed run self-healing |
| `file_drop` | a CSV/XLSX in a chain-owned location or upload | operator-uploaded full file, then deltas | the only mode that works with a chain whose ERP has no exposed API; reuses `§13`'s import surface |
| `manual_csv` | operator upload through the existing import screen | same as `file_drop` | this is what runs today, without an adapter at all, and it must keep working for ever |

### 23.2 The run: one batch, many rows, one report

```
sync_run
  id, chain_id, system
  kind            enum inbound|outbound|reconcile
  mode            enum realtime_api|scheduled_delta|file_drop|manual_csv
  entity          enum article|raw_material|vendor|uom|tax_class|site|outlet|code_map|all
  trigger         enum schedule|event|manual|retry|single_record
  started_at, finished_at, duration_ms
  watermark_from, watermark_to        -- the delta window this run covered
  counts          { seen, applied, unchanged, proposed, duplicate, stale_ignored,
                    error, unknown_erp_code, missing_code_mapping, unmapped_erp_field, skipped }
  payload_ref     text (file name / page cursor / odata skiptoken chain)
  status          enum running|succeeded|succeeded_with_issues|failed|aborted
  actor           the identity that triggered it (user, or system:<system code>)
```

- **One run is chunked but is one batch**: a chunked import is a single `sync_run` with one
  batch audit row and per-row audit rows, exactly as `§13` already does for CSV imports — the
  same batch id appears on every audit row so "what did that 02:00 job change" is one query.
- **A run never spans entities in one report unless it must**: an `all` run produces a report
  per entity, because "1,240 errors" with no way to tell 20 tax classes from 1,220 articles
  is not a report.
- **`succeeded_with_issues` is a real state**, and the screen shows it as such: rows applied,
  some fields held back. A run that says "success" while quietly holding 300 fields is worse
  than a failure.

### 23.3 Idempotency — re-running a payload must never duplicate or double-apply

Three layers, and all three are needed:

1. **A payload identity per row**: `source_event_id` if the ERP provides one, otherwise
   `payload_hash` = a stable hash of the row's *normalised* values (field set sorted, units
   normalised, whitespace collapsed). `sync_applied_event`
   (`unique (chain_id, system, entity, source_event_id)`, and
   `unique (chain_id, system, entity, payload_hash)` where no event id exists) records what
   has been applied.
2. **Apply-once semantics on the record**: `erpAdmin.sourceVersion` + `mirrorHash`. A payload
   whose `mirrorHash` equals the record's current mirror hash is **`unchanged`** — no write,
   no audit row beyond the run's own (the per-row audit row is *not* written for a no-op, so
   the audit log stays readable).
3. **Unique constraints on external keys and codes** (§22.2, §22.3) so a duplicate delivery
   that gets past the first two layers hits a database refusal in the same transaction and is
   reported as `duplicate`, not applied.

**The acceptance property for the engineer:** feeding the same payload twice, in the same run
or in two runs an hour apart, must produce the second run's report as all `unchanged` /
`duplicate`, with **zero** new rows, **zero** changed values and no second audit row for a
record that did not change. That is a test, not an aspiration.

### 23.4 Deltas, out-of-order delivery and deletion

- **Every inbound row carries a `source_version`** — the ERP's change number, change date-time
  or a monotonically increasing revision. Comparison is per record:
  - `source_version` **newer** than the record's → apply.
  - **equal** → apply-once says `unchanged`; nothing happens.
  - **older** → `stale_ignored`: the value is *not* applied, and the run report carries the
    row with the record, the payload's version, the record's version and the differing
    fields. A stale payload is information, not noise: it usually means two ERPs, a
    mis-set clock or a replay.
- **No global ordering is assumed.** ERPs deliver per document, per entity and per user; a
  batch of 4,000 materials arrives in whatever order the source system emitted. Correctness
  therefore lives in the per-record version comparison and the unique constraints, never in
  "rows arrive in order".
- **A delta window overlaps by a configured amount** (default: the previous run's
  `watermark_from`), so a run that fails or is skipped does not create a permanent hole.
  Re-processing an overlap is safe precisely because of §23.3.
- **Deletion and blocking:**
  - An ERP **deletion flag / block** → a review item (`erpBlockedUpstream`), never a
    deactivation (§22.5).
  - An ERP row that has **disappeared** from a full extract → *nothing happens on its own*.
    It appears as `onlyInErp = false` in the **reconciliation** report (§23.8) with a count,
    and a human decides between deactivation (with a reason, `§14` of the pattern spec) and a
    stale extract. **No import path in this product can delete or deactivate a master
    record**, and there is no `delete` action anywhere for one (`§19`'s DoD restated).
- **Closed-period / effective-dated values**: an inbound cost or tax rate that would land
  inside an already-closed effective window is **refused into the report**
  (`validation.effectiveWindowOverlap`) rather than rewriting history. Our COGS history is
  ours (§8.2, §11.2).

### 23.5 What is audited, and in which transaction

Extends `§5`; nothing here weakens it.

- **Every applied row writes its audit row in the same transaction as the write**, through the
  same `auditedMutation()`. A field the ERP owns is attributed to a **non-human actor**:
  `actorKind: system`, `actor: system:<erp_system.code>` — so "who changed this cost" can
  answer *the integration, at 02:04, in run 8f21*, and never "nobody".
- The audit row for an ERP-applied change carries, in addition to `§5`'s fields:
  `source: erp_sync`, `batchId` (the run), `sourceEventId` / `payloadHash`, `sourceVersion`,
  `provenance: erp_mirror | local_override`, and `system: <erp_system.code>`. `before`/`after`
  remain the changed fields only.
- **One batch-level audit row per run** with the counts and the watermark — the row a support
  query starts from.
- **Held-back and refused changes are audited too**: a `stale_ignored`, an `unknownErpCode`, a
  `missingCodeMapping`, an `erpOwnership.refused` or an `override_allowed` divergence each
  write an audit row against the record (or the run, where there is no single record). A
  refusal that leaves no trace is indistinguishable from a bug.
- **A read of a financial ERP field is not specially audited** (unlike `mdm.vendor.bank.view`):
  the bank-details rule exists because remittance data is sensitive, and an ERP valuation
  price is not. Stated so the engineer does not add a second, inconsistent reveal pattern.
- **Outbound runs are audited as runs plus per-record change rows** — what we sent, to whom,
  when, and which fields. Never the payload's full text beyond the fields sent.

### 23.6 The error and conflict report a human actually reads — one vocabulary, not two

**The shape is Phase 2's, not a new one.** Every row of the ERP report is the same four-part
row as the costing grid's `ConflictPanel` (`phase-2-culinary-grids-spec.md` §6):
**what** · **where** (the entity, its code, and the field or line) · **what it blocks** ·
**what can be done about it, by *this* viewer**. The same severity vocabulary, the same
affordance rule (*every row offers an action to every role that can see it, even if that
action is "ask"*), and the same rule that **a conflict never hides a row and never blocks
editing** — here, that a held-back *field* never hides the *record*.

The reconciliation is explicit, so the two specs share names where they mean the same thing
and differ only where the meaning genuinely differs:

| ERP report kind | blocking? | same vocabulary as | why |
|---|---|---|---|
| `unknownErpCode` | blocks the affected **fields** only | new — no Phase 2 equivalent | an unmapped ERP code is an integration concern, not a costing one |
| `missingCodeMapping` (outbound) | blocks the **record's export** | new | as above |
| `possibleDuplicate` | blocks nothing; blocks *approval* where the chain is approval-gated | `mdm.duplicateReviewed` (`§9.2`) | the same decision, reached from the other direction |
| `erpBlockedUpstream` | blocks nothing; it is a review item | new | an ERP block is not a lifecycle transition (§22.5) |
| `stalePayloadIgnored` | applies nothing | new | informational, and deliberately visible |
| `localOverrideStands` | applies nothing further | `mdm.deactivate.blocked` in *shape* (a named refusal to overwrite) | our operator's value survives; the ERP's value is held for review |
| `unitPrecisionLoss` | blocks nothing; the rounded value is shown | new | the number a person must be able to check |
| `currencyScopeMismatch` | blocks nothing | Phase 2 `currencyMismatch` | same words, same meaning: two currencies that must not be summed |
| `unconvertibleUnit` | blocks the affected **costing** downstream | **Phase 2 `unconvertibleUnit` — reused verbatim** | an ERP unit with no path to our base is the same conflict Phase 2 already renders |
| `dimensionMismatch` | blocks the affected costing | **Phase 2 `dimensionMismatch` — reused verbatim** | ditto |
| `ambiguousConversion` | blocks the affected costing until pinned | **Phase 2 `ambiguousConversion` — reused verbatim** | a jurisdiction-ambiguous conversion imported with a payload binds to nothing until decided |
| `missingTaxClass` | blocks the article's `active` state | **Phase 2 `missingTaxClass` — reused verbatim** | an imported article whose ERP tax code has no mapping has no tax class |
| `unmappedErpField` | blocks nothing | new — **an information row, not a conflict** | the field exists in the ERP and our model has no home for it; this is the living list of parity gaps and the input to the next schema decision |
| `valuationVariance` | blocks nothing | new | our `standardCost` and the ERP's valuation price differ beyond a tolerated band; a report, never an automatic rewrite of our cost |
| `selfApprovalRefused` etc. | — | **unchanged** — every existing audit refusal keeps its vocabulary | |

Presentation rules (the same four states, never collapsed, `pattern spec §2`):

- **A run report is grouped by kind, then by field, then by record**, with counts at every
  level, so "300 rows" opens as "1 field, 3 kinds, 300 records" rather than a 300-row wall.
- **The unfixable is separated from the fixable.** Rows a viewer can act on come first,
  ordered by what they block; rows needing another role carry the *ask* affordance
  (`support.ticket.raise`) so the report never dead-ends.
- **The report is downloadable and re-importable as a mapping fixture**: the `unknownErpCode`
  rows export as the *stub* of a `erp_code_map` file the chain can fill in and upload, which
  turns a nightly error into a one-time fix.
- **Empty state is honest and specific**: a run with nothing to do says so
  (`mdm.erp.run.empty`), rather than showing an empty table.
- `succeeded_with_issues` has its own banner word, tone and shape, never the success colour.

### 23.7 Failure, retry and the connection's own states

- **Retry**: transport failures retry with exponential backoff inside the run (bounded), then
  the run fails as a whole and is retried *from its watermark* — safe because of §23.3.
  Partial application is never retried blind: the run's count block is the record of what
  already applied.
- **A dead-letter set** holds the rows that failed validation after the run finished, so they
  can be inspected, fixed as data (a code map, a UOM) and replayed through
  `trigger: retry` against the same run.
- **`erp_system.status`** is real state: `not_configured` · `active` · `paused` (a human
  stopped it, and the reason is on the record) · `error` (the last run failed; the screen
  names the failure and offers *retry* and *pause*). A paused connection does not silently
  accumulate; the screen states how long it has been paused and what has not been received.
- **Nothing about the connection is edited in place without a trace**: endpoint, direction,
  mapping set and ownership rows are all audited mutations (§24.2).

### 23.8 The reconciliation report (the one that catches silent drift)

Read-only, scheduled, and the only place a `split`-owned disagreement surfaces as a *number*:

| section | what it counts | what a human does |
|---|---|---|
| records only in the ERP, never imported | by entity, with the reason (unmapped code, blocked, out of the extract's scope) | decide: map a code, widen the extract, or accept |
| records only in OmniHost, never in the ERP | by entity (usually ours: chain-created articles, site-level entries) | confirm the ownership rule covers it, or schedule an export |
| `split`-owned fields with differing values | field, record, both values, and which side's value is in force | pick a master for that field group, or record why both are right |
| our cost vs the ERP's valuation | per raw material, the band, the currency, the date | `valuationVariance` review |
| code-map gaps | per code list, the count inbound-blocked and outbound-blocked | fix the map once |

The report **never writes**. It is the honest counterpart to a sync that is allowed to apply.

---

## 24. The adapter boundary — what is configuration and what is code

Same shape as the payment provider abstraction (`DECISIONS.md`): **domain code calls our
interface; the interface has one implementation per system; the specific system is
configuration.** A chain running Dynamics and a chain running SAP are both supported by the
same build.

### 24.1 The boundary rule

- **No ERP SDK, vendor client library or vendor URL appears in domain code.** Article, raw
  material, vendor, UOM, tax and site services know nothing about OData, BAPIs, dataverse or
  Business Central APIs.
- **The domain owns the envelope, the adapter owns the payload.** The adapter converts a
  vendor's payload into our normalised envelope; the domain validates, applies and audits.
  A vendor's field names appear in *configuration rows*, never in a domain function signature.
- **One interface, several implementations**: `RealtimeApiAdapter` (OData/REST, vendor-shaped
  per implementation), `DeltaFileAdapter` (CSV/XLSX drop), `ManualUploadAdapter` (today's
  import screen — the same interface, which is what keeps the manual path first-class forever).
- **Failure is normalised before it reaches the domain**: an adapter turns a vendor's error
  into one of our transport outcomes (`unreachable` · `auth_failed` · `throttled` ·
  `malformed_payload` · `schema_changed` · `partial_page`). A vendor's own error text is
  attached as `detail` and shown verbatim — the UI never re-words a domain error (`§11` of the
  pattern spec).

### 24.2 What is configuration (stored as rows, editable by permission, audited)

| what | where | who may change | audit action |
|---|---|---|---|
| which system, which vendor kind, display name | `erp_system` | `mdm.erp.connection.configure` (MDM Head; App layer for the vendor catalogue) | `mdm.erp.connection.update` |
| endpoint, exchange mode, schedule, chunk size, retry policy | `erp_system` | `mdm.erp.connection.configure` | as above |
| credential *reference* (secret name), never the secret | `erp_system.auth_secret_ref` | `mdm.erp.connection.configure`; the value itself is an App-layer secret | as above |
| field mappings: our field ← the ERP's field, per entity and group | `erp_field_mapping` | `mdm.erp.mapping.update` | `mdm.erp.mapping.update` |
| transforms (`direct` · `unit_convert` · `code_map` · `date_parse` · `money_currency` · `quantity_uom` · `boolean_flag` · `concat` · `split`) | `erp_field_mapping.transform` | as above | as above |
| code maps (UOM, tax class, material group, category, plant, …) | `erp_code_map` (§22.3) | `mdm.erp.code_map.update` | as above |
| ownership per entity/field group, override allowance, inbound/outbound actions | `erp_field_ownership` (§22.4) | `mdm.erp.ownership.update` (MDM Head — this is the *master direction* decision, so it is the highest-privilege integration code) | `mdm.erp.ownership.update` |
| direction per entity (in / out / both / none) | `erp_field_ownership` + `erp_system.direction_default` | as above | as above |
| run trigger, watermark, pause/resume | `sync_run`, `erp_system.status` | `mdm.erp.sync.run`, `mdm.erp.connection.pause` | `mdm.erp.sync.run` |

### 24.3 What is code (a change to it is a release, not a setting)

- The adapter interface and its implementations.
- The normalised envelope and its validation.
- The transforms listed above (the *choice* is configuration; the transform itself is code).
- Matching (§22.5), idempotency (§23.3), version comparison (§23.4) and the audit emission —
  the safety machinery must not be re-implementable per vendor, or one implementation will do
  it slightly differently and that is how double-application happens.
- The report renderer and the conflict vocabulary (§23.6).
- The mapping-set **defaults** per vendor kind: they ship as seeded configuration data
  (§26.7) so a new chain is not started from an empty screen, but the *shape* of a mapping set
  is code.

### 24.4 The adapter interface as this spec expects it

```
interface ErpAdapter {
  describe(): { vendorKind, supports: { pull, push, delta, webhook, ack,
                       perRecordVersion, sourceEventId, tombstones }, limits }
  verifyConnection(): { ok, detailKey, latencyMs }
  pull(req: { entity, watermarkFrom, watermarkTo, pageCursor? }):
        { rows: NormalisedRow[], nextCursor?, tombstones?: string[] }
  push(req: { entity, records: OutboundRecord[] }): { accepted: string[], rejected: Rejection[] }
  ack?(refs: string[]): void
}
```

- `describe()` is what makes "do not assume a single vendor" real: the run planner reads
  `supports` and chooses pull-vs-file, per-record versions, event ids and cursor paging
  accordingly. A vendor without per-record versions produces a **warning at configuration
  time** (`erp.versions.unavailable`), not a silent degradation — it means stale payloads
  cannot be detected, only deduplicated.
- `NormalisedRow` carries **raw values plus the code list each value belongs to**, so an
  unmapped code is detectable before it reaches the domain (§22.3's rule).
- `push()` rejects per record; **a rejection never rolls back an accepted record's audit
  row**, and the export report names both sets (§23.6).

### 24.5 Permissions this part adds

Shape matches the registry exactly (`code, module, name, description, action_kind, layer,
requires_site_scope, check_function, financial_or_stock, implemented_in`).

| code | kind | layer | site scope | fin./stock | name / why |
|---|---|---|---|---|---|
| `mdm.erp.view` | query | tenant | no | no | See connections, mappings, runs and reports (read-only) |
| `mdm.erp.connection.configure` | mutation | tenant | no | no | Create/edit an ERP connection (endpoint, mode, schedule). **Never the secret value** |
| `mdm.erp.connection.pause` | mutation | tenant | no | no | Pause/resume a connection, with a reason |
| `mdm.erp.mapping.update` | mutation | tenant | no | no | Change a field mapping or a transform |
| `mdm.erp.code_map.update` | mutation | tenant | no | no | Change a code mapping (UOM, tax class, material group, category, plant…) |
| `mdm.erp.ownership.update` | mutation | tenant | no | **yes** | Declare who masters which field group. Financial because it decides whether an ERP can change a cost or a price |
| `mdm.erp.sync.run` | mutation | tenant | no | **yes** | Trigger a run (any direction) or replay a dead-letter row |
| `mdm.erp.run.abort` | mutation | tenant | no | **yes** | Abort an in-flight run — a stock- or money-affecting stop, so it is its own code |
| `mdm.erp.reconcile.view` | query | tenant | no | no | Read the reconciliation report |
| `mdm.erp.export` | mutation | tenant | no | **yes** | Send records to the ERP (the outbound direction) |
| `mdm.erp.vendor.reference.update` | mutation | **app** | no | no | Curate the platform's *default* mapping sets and vendor-kind catalogue (AppConfig, delegated) — a chain does not invent a vendor's field names |
| `mdm.<master>.export` | mutation | tenant | no | **yes** where the master carries cost/price | Outbound for one master, so export is not one all-or-nothing capability |

Role assignments follow `§3`'s pattern: `CENTRAL_MDM_TEAM` holds `mdm.erp.view`,
`mdm.erp.sync.run`, `mdm.erp.mapping.update`, `mdm.erp.code_map.update` (they prepare);
`CENTRAL_MDM_HEAD` adds `mdm.erp.connection.configure`, `mdm.erp.ownership.update`,
`mdm.erp.export`, `mdm.erp.run.abort`; **no other tenant role holds any `mdm.erp.*` mutation**,
and the App layer holds only the vendor-reference code. Every one of these is enforced by
`requirePermission()` and written by `auditedMutation()`, and a chatbot path reaches the same
function under the same check.

### 24.6 Proving there is no single-vendor assumption

The acceptance list for the boundary (this is what a reviewer should test):

1. Two `erp_system` rows on two chains, different `vendor` values, **zero** code branches on
   the vendor anywhere outside the adapter and the seeded mapping sets.
2. Every field name in the system appears in `erp_field_mapping` rows, not in a domain file.
3. Adding a third vendor kind requires: one adapter implementation, one seeded mapping set,
   and no change to the domain, the audit contract, the report or the ownership model.
4. A chain with **no** ERP configured sees no ERP section, no empty ERP form, and no ERP
   route — only the existing manual import (`§13`).
5. Nothing in the product, the copy, the docs or the marketing states or implies a
   partnership, endorsement or certification with SAP or Microsoft. Product copy names the configured
   system (chain data) and otherwise says the chain's ERP — it never makes a vendor-brand
   claim.

### 24.7 Honest limits, stated so nobody promises past them

- **Reading from an ERP is buildable; writing back is the risky direction.** SAP and Dynamics
  installs are heavily customised per customer (Z-fields, extensions, validation exits,
  numbering, release strategies). An outbound write can be *accepted* by the API and rejected
  by the chain's own business logic. So: **inbound first**, outbound limited at first to the
  field groups the chain declares, with every rejection surfaced (`§23.6`), and no automatic
  retry of a rejected business rule.
- **`unmappedErpField` is a permanent, healthy state.** There will always be ERP fields we do
  not model. The catalogue in §20 is a *parity* target for the fields that change behaviour,
  not an aspiration to store an ERP.
- **We are not a certified connector.** Nothing here claims SAP-certified or Microsoft
  certified integration. If a chain requires certification, that is a commercial and legal
  matter for the owner and the lead, not something this spec can decide.

---

## 25. How this stays usable on screen — the article form must not become an ERP

### 25.1 The rule

An article open on a screen must still be **one record, four things to read**. Adding ~35
fields for ERP parity must not add a single visible field to the common path. Therefore:

1. **Sections, not a longer form.** The record's section order (`§10` of the pattern spec)
   gains exactly **one** new section, *ERP-maintained*, always **last, collapsed, and never
   empty when it holds a value**. Nothing is added to the *Identity*, *Jurisdiction &
   compliance* or *Classification* sections.
2. **One collapsed section, with a count.** The section header reads
   `mdm.erp.section.title` + `mdm.erp.section.count` (`{count}` fields maintained by
   `<system>`) + the system's display name, so an operator can see *that* the ERP maintains
   24 fields without opening it. The count is the only thing about the section visible when
   it is closed — that is the whole design.
3. **Hidden when irrelevant, by material type and by flags** (§25.2) — a dish has no
   dimensions, a plated item has no batch control, and neither should be an empty input the
   operator wonders about.
4. **Hidden when there is no ERP.** With no `erp_system` configured, the section does not
   exist at all. The honest empty state lives on the ERP connection screen, not on every
   article (`mdm.erp.notConfigured` appears where a chain would go looking for it).
5. **Never a second way to edit the same value.** If the ERP owns it, the field appears once,
   read-only, with provenance — not as a read-only copy plus an editable local one.

### 25.2 Hidden-when-irrelevant (the rule table, data-driven)

| field group | visible when | hidden otherwise | why |
|---|---|---|---|
| dimensions, weight, volume | `articleType` ∈ `retail` **or** any dimension has a value | for `food`/`beverage`/`service` with no value | a plated dish has no box |
| batch / serial / lot control | `materialType` allows stock management **or** `trackStock` | for a service/immaterial type | a batch-controlled cocktail is a fiction |
| quality inspection flags | the material is purchased (has ≥ 1 vendor) | otherwise | inspection happens at receipt |
| purchasing defaults | the material is purchased | otherwise | an article is not indented |
| valuation fields | `priceControl` is set **or** the ERP sent a price | otherwise | an unvalued record shows an honest empty state in the section, not 4 empty money fields |
| customs / origin / export control | `countryOfOrigin` is set, **or** the jurisdiction profile requires any of them | otherwise | a domestic market that does not require origin does not need the panel |
| hazard / transport | `hazardClass` is set, **or** the profile requires it | otherwise, **and never on a guest surface** | statutory, not decorative |
| manufacturer / part number | a manufacturer is set, or the article is `retail` | otherwise | |
| revision / change notice | `revisionLevel` is set | otherwise | most F&B items are never revised |
| alternative UOMs | more than one unit exists for the material | otherwise | with one unit, the conversion grid is noise |
| barcodes | a barcode exists, or the chain has a POS/barcode setting on | otherwise | |
| site↔plant map | the site is on a chain with an ERP | otherwise | |

The rule table is **data** (`erp_visibility_rule` rows), not a component's `if` ladder, because
the second ERP will need a different one.

### 25.3 The visual marker for a field the ERP manages

Pattern spec **§19** specifies it; this is what the masters use. Summary of the contract:

- **Read-only, and never a disabled input.** A disabled `<input>` is skipped by screen
  readers, announces nothing, and is indistinguishable from a broken one. An ERP-owned field
  renders as a `DescriptionList` value (or a read-only cell in a grid, `aria-readonly="true"`
  and `tabindex="-1"` per pattern spec §11) with a **`ProvenanceChip`** beside it.
- The chip states, in words and a shape: **the system** (its display name, chain-owned), the
  **key type and value** the record was matched on, and the **last sync instant** through
  `TimestampValue` (relative, with the absolute instant in the `title`, in the viewer's
  timezone). Tone and shape come from the existing five status families — no new colour.
- **"Why" is always reachable**: the chip opens a small popover that names the field group,
  the ownership row in force (`owner`, `override_allowed`, `inbound_action`), and a catalogued
  note (`mdm.erp.ownership.note.*`). A read-only field that cannot explain itself is the
  thing operators route around — by emailing someone, which is worse than an editable field.
- **A change made by the ERP is visible as a change**: the field shows a `mdm.erp.changedBySystem`
  marker for the session with a `RecordDiff` (before → after, instant, run id), reusing the
  version-diff pane. Operators need to be able to answer "it was 480 yesterday" without a DBA.
- **A local override is possible only where `override_allowed`**, and the affordance appears
  with the reason it exists plus a required note. Once overridden, the field carries
  `local_override` and the next inbound divergence raises `localOverrideStands` (§23.6)
  rather than reverting the operator's work.
- **A refusal names itself.** A write refused for ownership returns `erp.ownership.refused`
  with the field, the group and the system; the screen shows the server's message as `detail`
  and offers the honest alternative (*ask MDM* → a ticket, `support.ticket.raise`).
- **RTL and expansion**: the chip sits at the logical inline-end using `margin-inline-start`;
  it wraps rather than truncating (a German system name plus a key plus a date is three lines
  in a narrow column and must be allowed to be); the instant is formatted per locale; the
  numeric values keep `numeric` + tabular figures and logical alignment.
- **Keyboard**: the chip is one tab stop per field group, not per field (a 24-field section
  must not become 24 stops); `Enter` opens the popover, `Escape` closes it and restores focus.

### 25.4 Routes

| route | what it is | permission |
|---|---|---|
| `/mdm/erp` | connections, mapping sets, ownership, status | `mdm.erp.view` |
| `/mdm/erp/$system` | one connection: endpoint, mode, schedule, capabilities, health | `mdm.erp.view` |
| `/mdm/erp/$system/field-mapping` | the field mapping grid (§11 of the pattern spec) | `mdm.erp.mapping.update` |
| `/mdm/erp/$system/code-map` | the code map grid, one tab per code list | `mdm.erp.code_map.update` |
| `/mdm/erp/$system/ownership` | field-group ownership, the *master direction* surface | `mdm.erp.ownership.update` |
| `/mdm/erp/runs`, `/mdm/erp/runs/$runId` | the run list and **the report** (§23.6) | `mdm.erp.view` |
| `/mdm/erp/reconcile` | the reconciliation report | `mdm.erp.reconcile.view` |

Tier: whether these appear at all is `§26.6`'s open commercial question; the entitlement
mechanism is the existing `feature` table and the chain record's tier — **not** a new gate,
and never a per-site one.

### 25.5 Counts and states (never a silent screen)

- The MDM landing card set (`§15`) gains one card only when an ERP is configured:
  *runs with issues*, with the count, linking to the filtered run list.
- Every section of the ERP connection screen has its four states (`pattern spec §2`) —
  notably `not configured` (honest, with the one action that fixes it), `paused` (with since
  when) and `error` (with the failure named and *retry* offered).
- The record's ERP section, when empty but present, renders `mdm.erp.section.empty` and links
  to the connection screen — never a blank panel.

### 25.6 Catalog namespaces this part adds

| namespace | holds |
|---|---|
| `mdm.erp.*` | connection fields, run/report wording, the section and chip labels, ownership group names, state wording |
| `mdm.erp.ownership.note.*` | the per-field-group "why" notes rendered in the chip popover |
| `mdm.erp.run.outcome.*` | the outcome labels of §23.2's counts and §23.6's kinds |
| `mdm.erp.conflict.*` | one key per report kind in §23.6, plus `.{detail}` sub-keys for parameters |
| `erp.ownership.refused`, `erp.versions.unavailable`, `erp.mapping.*` | validation and configuration refusals |
| `pattern.erpOwnedField.*` | the `/design` gallery entry for pattern spec §19 |

Rules unchanged from `§4`: codes are never translated; a system's display name is chain data;
a mapping's note is a catalog key; the market name in a chip comes from `Intl.DisplayNames`.

---

## 26. Decisions for the owner, separated from ours

### 26.1 Owner decisions (blocking, or shaping, the Schema)

| # | decision | why it must be the owner's, not ours | what it changes | my recommendation, if asked |
|---|---|---|---|---|
| O1 | **Which ERP does the pilot chain run — MS Dynamics 365 Finance & Operations, Dynamics 365 Business Central, SAP S/4HANA, or SAP Business One?** | it is the chain's system, and the chain's answer decides which column of §20 is the one we implement first | the first adapter, the seeded mapping set, the field-parity confirmation list | start with whichever the pilot runs; the *model* is unchanged either way |
| O2 | **Which side is the system of record, per field group?** (the `erp_field_ownership` rows of §22.4) | a field with two masters corrupts silently; the business meaning of "who owns the cost" is not a design choice | whether an ERP can change a cost, a price, a tax class or a vendor's terms in our system | **ERP masters identity, classification, units, dimensions, storage/life, batch/serial, quality flags, valuation, ERP tax codes, customs, manufacturer, revision. OmniHost masters per-outlet price, menu content, compliance, allergens/nutrition, categories, the recipe, site-level overrides and every approval.** i.e. `price_compliance_culinary` is ours, unconditionally |
| O3 | **Real-time API, scheduled delta, or file exchange at first?** | it depends on what the chain's IT will expose, and on the network we do not control | transport, credentials, who is on call when it fails | **scheduled delta with an overlap window**, file fallback; real-time only for the masters that genuinely need it (none, in Phase 1) |
| O4 | **Is ERP integration a Phase 1 deliverable, or does it follow once the masters exist?** | it is a scope and cost decision the owner is paying for | whether Phase 1 ships an adapter or only the ERP-shaped model, the ownership rules and the manual import | **the model, the ownership mechanism, the mapping tables and the manual path in Phase 1; adapters after the masters exist and the pilot's ERP is named.** A live adapter built before the field set is confirmed would be rebuilt |
| O5 | **Is the ERP's external key the record's `code`, or a separate key?** (per entity — §20.1's identity rule) | it changes what every operator types, pastes and reads for ever; reversing it later is a data migration across every table, URL and audit row | `erp.identity.mode` per chain and entity | **vendor and site: use the ERP's number as `code`. Article and raw material: keep our `code`, hold the ERP number as the primary external key** — a chain's menu codes and its ERP material numbers genuinely diverge, and our codes are what appear on screens and in chat |
| O6 | **Is ERP integration a paid-tier capability?** | it is commercial | the `feature` table row and the tier matrix (`§15`) | **Gold/Platinum (integration is depth, not existence), with the ERP-shaped model and the manual import on every tier** — otherwise a Silver chain that has an ERP cannot load its own data |
| O7 | **Who signs off the field-ownership matrix before it is seeded?** | it is a contract between the chain's finance/procurement systems of record and ours; getting it wrong is the silent-corruption case | go-live of the first adapter | the chain's own finance lead plus our MDM Head, with the matrix as the one-page artefact |

### 26.2 Our decisions (recorded, not asked — change them if you disagree)

| # | decision | reasoning |
|---|---|---|
| D1 | ERP fields are **named columns**, never a JSONB blob on the record | a blob makes the ownership rule unenforceable and §20 unverifiable |
| D2 | `external_key` is a table with many keys per record, per system | a chain may run two systems; a renumbered material must not orphan history |
| D3 | External keys are **strings**, trimmed, case-sensitive — leading zeros preserved | a lost leading zero is a real support class |
| D4 | Code maps are **effective-dated rows**, never in-place edits | a re-costed recipe must be explainable against the mapping then in force |
| D5 | Nothing is **auto-created** from an ERP code | an integration that invents master data invents a wrong UOM |
| D6 | An ERP block/deletion flag **never changes our `status`** | an inbound payload must not deactivate a raw material twenty recipes use |
| D7 | An operator's local override **survives** the next inbound payload, and the divergence is reported | otherwise the integration erases work, and operators route around it |
| D8 | One conflict vocabulary: **Phase 2's four-part row and reused names** where the meaning is the same | two vocabularies is how the same problem gets two fixes and one is wrong |
| D9 | A no-op produces **no per-record audit row**; the run's counts record it | an audit log where 90% of rows say "nothing happened" is an audit log nobody reads |
| D10 | Sync correctness rests on **unique constraints and per-record versions**, never on ordering | ERPs deliver in whatever order they emit |
| D11 | The manual CSV path **is an adapter**, and stays first-class for ever | the owner may never buy an integration, and the product must still load their data |
| D12 | ERP-owned fields render as **read-only values with provenance**, never disabled inputs | a11y, and the "why" is what keeps operators from routing around the field |
| D13 | The article form gains **one collapsed section** and no new visible field on the common path | the article form must not become an ERP |
| D14 | Tier stays on the **chain record**; nothing here adds a per-site gate | owner-locked, restated because the ERP work is where it would creep in |
| D15 | Every ERP-applied change is audited **in-transaction** with a system actor | "nobody changed it" must be impossible |

### 26.3 What must be confirmed before the schema freezes

1. **The SAP column of §20** — the material master view field lists marked `SAP-MM` ⚠ and
   `SAP-B1` ⚠ were **not** verified against SAP Help page bodies in this session. Confirming
   them needs either a licensed SAP system, an SAP Help session in a browser, or the chain's
   own material master field list. Confidence: the field *groups* are right; individual
   field names within them are to be checked. **This is the single largest verification gap
   in this document.**
2. **The Microsoft column** is source-backed for the groups cited in §20.0; the individually
   marked `MS-⚠` rows (F&O shelf-life periods, physical-dimension field names, F&O tax-group
   pairing) still need one pass over the product's own form.
3. **`variantOf`/`variantAxes` (§21.1)** is proposed, not specified: it changes the article's
   identity model (a variant is a record that inherits). It needs a design pass before the
   engineer builds it, and it interacts with per-outlet price and availability.
4. **The `erp_field_ownership` defaults** are my recommendation (O2). They are configuration,
   so they can change after seeding — but they must be right at the pilot's go-live.
5. **Whether the ERP's numbering is the `code`** (O5) must be answered per entity per chain.

### 26.4 Open items this part creates for the lead

1. **Adapter sequencing.** §26.1 O4 recommends the model now and the adapter later. If the
   owner wants an adapter in Phase 1, the engineer needs a named ERP (O1) and a sandbox or
   sample payloads; without either, an adapter is guesswork.
2. **A `sync` service boundary.** The adapter, the run planner and the report are a
   *component* with its own permissions, routes and tests. The lead should decide whether this
   is a workstream inside Phase 1's build or a small Phase 1.5 before Phase 2 — my view: the
   **model and the manual path ride inside Phase 1**, the **adapter is Phase 1.5**.
3. **The §18 items still open** (pilot data, market sequence, temperature-unit preference, code
   generation) all get *harder* under ERP parity: code generation especially, because O5
   decides whether codes are ours at all. Code generation (`§18` item 8) should be answered
   together with O5.
4. **Effort honesty.** The record changes in §21 are roughly **35 new columns plus two new
   tables and four mapping tables** across six masters, plus a visibility-rule table. That is
   a real Phase 1 increment; the lead should size it against the build queue rather than treat
   this document as free.

### 26.5 Definition-of-done additions (extends `§19`)

- A record with an ERP-shaped payload can be imported, exported and re-imported without
  duplication: the **same payload twice is all `unchanged`/`duplicate`** and no second audit
  row exists for an unchanged record.
- No import, export or reconciliation path can **delete or deactivate** a master record.
- A write to an ERP-owned field with `override_allowed: false` is **refused server-side**,
  with `erp.ownership.refused` naming the field, the group and the system — proved by a
  negative test, not by a hidden control.
- An `unknownErpCode` blocks the **field** and never the **record**, and the raw code is
  recoverable from the record afterwards.
- Every ERP-applied change carries `actorKind: system`, the run id and the source version.
- Two `erp_system` rows with different `vendor` values work on the same build with **no
  vendor branch in domain code**; a third vendor needs one adapter and one mapping set.
- The article form shows **no** ERP field outside the single collapsed *ERP-maintained*
  section, and that section does not exist when no ERP is configured.
- No user-visible string literal in any new surface: every label, state, chip, report row and
  refusal resolves through the namespaces in §25.6.
- `ar-XB` mirrors the chip, the section and every report row without horizontal scroll;
  `en-XA` does not truncate the chip, a mapping row or a column header.
- Money is always `{ amount, currency }`, a quantity is never bare, and no screen, report or
  export sums across currencies.
