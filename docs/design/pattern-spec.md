# OmniHost.ai — screen pattern spec (Phase 0 core, Phase 1 master-data additions)

Every later role module reuses these patterns. Each entry says what the pattern is for,
the rules that make it work for an operator who sits in it for hours, and where the live
example lives. Tokens are in `src/styles/tokens.css`; components in `src/components/`;
worked examples at `/design`.

Sections 1–9 are the Phase 0 platform patterns. Sections 10–18 are the Phase 1 additions
(master data, dense editable grids, import, per-jurisdiction fields) and the surfaces
Phase 2 needs — written into the same system, and paired with
`docs/design/phase-1-mdm-spec.md` (the masters themselves) and
`docs/design/phase-2-culinary-grids-spec.md` (the recipe/BOM costing surfaces). Where a
section here says "extends §n", §n stays in force; nothing below supersedes a Phase 0 rule.

**Non-negotiables across every pattern**

1. No user-visible string literal in a component. Copy comes from the catalog via `t()`
   (`src/i18n/catalog-en.ts`, `catalog-other.ts`).
2. Money is `{ amount, currency }` and formatted by `MoneyValue` / `MoneyCell`. Never a
   bare number, never an assumed rupee.
3. Timestamps render in the viewer's timezone via `TimestampValue`; the full instant and
   zone are in the element's `title`.
4. Direction-agnostic layout: CSS logical properties only (`ms/me`, `ps/pe`, `border-inline`,
   `text-start/end`). Reading-direction icons carry `icon-directional`; object icons
   (lock, clock, store) never flip.
5. Status is never colour alone: a tone plus a shape/icon and a text label.
6. Focus is always visible (`--focus-ring`), and every action is reachable by keyboard.

---

## 1. Master–detail list (chains, articles, vendors, POs)

`MasterDetail` + `ListToolbar` + `DataTable`. Live: `/chains`, `/audit`.

- Master pane: `ListToolbar` (filter, actions, a live row count) above the table. The
  count is always visible — an operator must never wonder whether a filter hid rows.
- Selection is addressable: the selected row is a route param (`/chains/$chainId`), so a
  link to a record is shareable and the back button behaves.
- The selected row is marked three ways: background tint, an inline-start bar, and
  `aria-selected` on the row — legible in greyscale and to a screen reader.
- Panes scroll independently; the table header sticks.
- Row height is the density setting (compact 28px / cozy 34px / roomy 42px), persisted
  per user, resolved server-side so the first paint matches.

## 2. Empty, loading, error, refused — four distinct states

Never collapse these into one. Live: `/chains` (empty + filtered-to-nothing are different
sentences), `/design` (all four side by side).

- **Loading**: skeleton rows with the same rhythm as the loaded table (`TableSkeleton`).
- **Empty in scope**: what the list is, and what fills it. For a delegated operator, an
  empty list is the permission model working, and the copy says so.
- **Filtered to nothing**: names the filter and offers to clear it.
- **Error**: the server's own message as `detail`, plus retry. The UI never re-words or
  invents a domain error.
- **Refused**: `PermissionDenied`, which names the missing permission code and the reason.

## 3. Approval queue row

`ApprovalQueueList` + `ApprovalStateBadge` + `SeverityBadge`. Live: `/design`, and `/approvals`
(the real route, whose honest state in Phase 0 is an empty inbox).

One row answers, without a click: what is being decided, which chain and site, who raised
it and in what role, which role may decide it, the value at stake, and the deadline.
- Overdue is a state (`overdue`), not a colour: red plus the word plus the clock icon.
- The decision affordances are the only primary buttons on the row; a decision opens a
  confirm dialog that restates the object and the consequence.
- The queue is the same whether the item arrived from a screen or the chatbot; the source
  badge says which, and an item entering from the chatbot is routed to the approver's own
  inbox rather than the requester's.

## 4. Ledger / variance table

`DataTable` with `numeric: true` columns and `MoneyCell`. Live: `/design`.

- Figures use tabular lining numerals (`.num`), so digits do not shift between rows.
- Numeric columns are right-aligned to the decimal: the integer and fraction parts are
  separate spans (`.money-frac`) with the fraction fixed-width, so 9.50 and 1,204.75 line
  up on the point.
- Signs are explicit: a leading `+`/`−` and a tone, never by colour alone.
- Columns sort by the underlying number, not the rendered string, and the current sort is
  announced with `aria-sort`.
- Totals live in a `tfoot`, right-aligned under their column.

## 5. Confirm-before-commit (dialogs)

`Dialog` + `ConfirmSummary`. Live: `/chains/$chainId` (tier change), `/chains/onboard`.

- Used for anything that changes what other people can do: licence tier, feature toggles,
  approvals, refunds, write-offs.
- The dialog restates the object, the current value and the new value — the user confirms
  a fact, not a button label.
- Focus moves into the dialog, is trapped, and returns to the trigger on close; Escape
  cancels. The commit button carries the loading state, so a slow write cannot be
  double-submitted.
- Writes go through the same permission-checked, audit-logged domain function the API and
  the chatbot use, and the screen re-reads the record afterwards. No optimistic UI on a
  financial or permission path.

## 6. Forms and inline validation

`Field` + `TextInput`/`Select`/`Textarea`/`Toggle`/`SegmentedControl` + `ValidationSummary`.
Live: `/chains/onboard`, `/design`.

- Submit is never disabled by a validation error. Pressing it reveals the errors, focuses
  the summary and announces how many fields are wrong. A disabled button cannot say why.
- Errors are tied to their control with `aria-describedby` + `aria-invalid`; the message
  sits under the field and the field keeps its label and hint.
- The summary links to each field; the submit button references the summary.
- Validation is expressed as data (message key + parameters), so the same rule reads
  correctly in every language and the domain stays the source of truth for the rule.

## 7. Multi-line entry (indent, PO, GRN, transfers)

`DataTable`-shaped grid with editable rows, `QuantityValue` + `MoneyValue`. Live: `/design`.

- One row per line; quantity and rate cells are numeric and right-aligned; the line total
  is computed and displayed, not typed.
- UOM is a mono code beside the quantity — `12 kg`, never `12`.
- The running total is pinned in a `tfoot` row that stays visible as lines are added.
- Line-level problems are reported on the line (with its index in the message), and the
  same problems also appear in the form-level summary.

## 8. Chatbot confirmation card

`ChatCard` + `ChatCardSample`. Live: `/design`.

- The card shows the resolved **intent** as a chip, so a mis-resolved intent is visible
  before it is committed rather than after.
- It restates the fields it is about to write and holds Approve / Edit / Cancel. The
  chatbot can propose; only the user's confirm commits.
- It names the permission it is acting under, and says that the action is audited and
  attributed to the user — the spec's guardrail, made visible in the UI.
- The committed state confirms with the same wording as the screen path, because it is the
  same domain call and the same audit row.

## 9. Localisation in screens

- Resolution order: **user preference → site default → chain default → platform default**,
  resolved on the server per request and shown in `/design`.
- The language switcher and the density switch live in the shell header, both cookie-backed.
- Partial translations are normal and are reported (coverage %) rather than hidden.
- A pseudo-locale (`ar-XB`, mirrored RTL) and an expansion pseudo-locale (`en-XA`, +40%
  length) exist to catch RTL and truncation bugs before a real translation does.
- Codes are not translated: `silver`, `platinum`, role codes, permission codes, UOM codes
  and ISO currency codes stay as stored values; only their labels come from the catalog.

---

# Phase 1 additions — master data and the visual costing surfaces

Sections 1–9 above are the platform patterns and still apply unchanged. What follows
extends them for Phase 1 (master data) and the surfaces Phase 2 needs. It is the same
design system: the same tokens (`src/styles/tokens.css`), the same component kit
(`src/components/`), the same four states, the same localisation rules. Nothing here
introduces a second system, a second token set or a second table.

**New non-namespaced tokens this section needs** (all in `tokens.css`, so a density
change or a theme still has one home):

| token | why it exists |
|---|---|
| `--density-grid-cell-px` | editable cells need their own inline padding; a text input inside `--density-cell-px` is unreadably tight at `compact` |
| `--row-marker-width` | the inline-start bar that marks a selected/edited/blocked row is currently a literal `3px` inside `.data-table`; the grid needs the same bar at row and line level |
| `--indent-step` | tree/depth indentation (recipe tiers, exploded BOM, a nested grid under a semi-finished good) |

No new colour tokens. Dirty, stale, blocked, inherited and derived states are drawn from
the existing five status families plus `--color-fg-subtle`; if a state can only be told
apart by adding a colour, it is not designed yet.

## 10. Master-data record: list and detail (extends §1)

`MasterDetail` + `ListToolbar` + `DataTable` for the list; `DetailHeader` +
`DescriptionList` + a sticky action bar for the record. Targets: `/chains/$chainId` is
the reference implementation; `/mdm/articles`, `/mdm/raw-materials`, `/mdm/vendors`,
`/mdm/uom`, `/mdm/tax-classes`, `/mdm/sites`, `/mdm/reference/*` follow it.

- **The record is addressed by its business code, not its uuid**: `/mdm/articles/ART-1042`.
  A link an operator pastes into a chat is the same link a chatbot card carries, and it
  survives a re-import (codes are the import key). A uuid only ever appears in an audit row.
- **List columns are the four things a reviewer needs, in this order**: code (mono,
  `<CodeLabel>`), name, the master's own decisive attribute (tax class; base UOM; vendor
  tax registration; rate + jurisdiction; jurisdiction), status badge, and last change
  (relative via `TimestampValue` with the instant in the `title`, the actor in the row's
  expandable meta — never a second table for it).
- **Counts are always visible** (extends §1): `ListToolbar` shows the in-scope count, and
  when a filter is on, both counts — `common.showing` (`{shown} of {total}`). A filter that
  hides an incomplete record must say that it hid it.
- **Status is the record's lifecycle, not a colour**: `draft` · `pending_review` ·
  `active` · `inactive` · `suspended` (vendor) · `seasonal`/`discontinued` (article). Each
  is a `.badge-*` tone **plus** a `StatusShape` glyph **plus** the catalogued label —
  legible in greyscale and to a screen reader (non-negotiable 5).
- **Detail reads first, then edits.** The record opens read-only; `Edit` (permission-gated,
  `action.edit`) switches the whole form to edit mode in place. There is no separate
  "edit page", so a link to the record is a link to the record in either mode.
- **The sticky action bar** sits at the foot of the record (inline-start: what is dirty;
  inline-end: the actions). It always answers three questions: *what will this save do*,
  *what is blocking it*, *who has to approve it*. Copy is catalogued
  (`mdm.record.saveState.*`), never a bare "Save".
- **Panels are ordered by how often they are read, not by how the table is shaped**:
  Identity → Jurisdiction & compliance → Classification → Related records → Versions →
  Audit. An empty panel is an honest empty state (§2), not a missing section.
- **Versions are a list, not a history log**: `VersionList` (version no, status, effective
  window, who changed it, what changed in one phrase) with `RecordDiff` opening read-only.
  A superseded version is never editable and never hidden — the PRD's rule that a
  historical order keeps the figures it was sold under is only enforceable if the operator
  can see them.
- **Related records are panes, not tabs that lose state**: a pane holds a small
  `DataTable` of links (approved vendors; outlets; per-outlet prices; site par levels) with
  an inline add row that opens §12's picker. Adding to a pane edits the record's draft, so
  it dirties the record like any field and commits with the same Save.
- Pane and grid headers stick; panes scroll independently (extends §1).

## 11. Dense editable grid (extends §7)

`EditableGrid` — the same `.data-table` density contract, one row per line, but cells are
editable. Used by: indent/PO/GRN lines (Phase 3), per-outlet price rows, UOM conversion
rows, tax rate rows, import mapping rows, and every recipe/BOM grid in §19.

**Structure.** A real `<table>` for row/column semantics, marked up as
`role="grid"` with `aria-rowcount`; each row `role="row"`; editable cells
`role="gridcell"`; derived/computed cells `aria-readonly="true"` **and**
`tabindex="-1"` so the keyboard flow never stops on a value the operator cannot change.
One cell is the *active cell* at a time (roving `tabindex`); the active cell is inside the
row that is the *working line*.

**Keyboard model.** This screen is used at speed for hours; every one of these is a
requirement, not a nicety.

| key | behaviour |
|---|---|
| `Arrow` up/down/start/end | move the active cell; in RTL, `Start`/`End` follow reading direction (CSS `start`, not `left`) |
| `Tab` / `Shift+Tab` | next/previous **editable** cell in reading order; from the last editable cell of the last line, `Tab` creates a new line and lands on its first cell — so tabbing never leaves the grid for the Save button by accident |
| `Enter` | commit the cell and move down one row; `Shift+Enter` moves up (the spreadsheet habit; operators arrive with it) |
| `F2`, or any printable character | opens the cell editor, content selected |
| `Escape` | in a cell: revert the cell to its last committed value and stay on the cell. In the grid: nothing else (there is no "discard everything" key — see dirty state) |
| `Alt+ArrowDown` | opens the cell's picker (references) or its option list (enums) without typing |
| `Alt+ArrowUp/Down` on a row header | reorders the line |
| `Alt+Insert` / `Alt+Backspace` | insert a line below / remove the working line (removal asks nothing; it is a draft change, and the Save is the commit point) |
| `Ctrl/Cmd+S` | same as the Save button — a shortcut, never the only path |
| `Delete` | clears a text cell's content; it is **never** a row delete |
| `PageUp`/`PageDown` | 10 rows |
| paste (`Ctrl/Cmd+V`) | a TSV block from a spreadsheet fills from the active cell outward; pasted values go through the same validation as typed ones |

Screen readers get `aria-rowindex`/`aria-colindex` on movable cells, and every keyboard
action above that changes structure is also a visible button in the row's overflow menu.

**Dirty state.** Editing writes to a client draft. Nothing autosaves on a grid that can
affect money, stock or a golden record.

- Per-cell: a `dirty` marker — an inline-start bar (`.row-marker`, `--row-marker-width`)
  plus a small shape (`Dot`) at the cell's inline-end, **plus** the row's own marker, plus
  the sticky bar's wording (`mdm.grid.dirty.one` / `.other`, `{count}` inserted). Never a
  colour alone.
- Per-row: an `edited` badge on the row header; a row whose committed value differs from
  the server's at save time returns a conflict (§11.5) rather than a silent overwrite.
- Per-grid: the sticky footer says `{count} unsaved changes`; leaving the route with a
  dirty draft raises a confirm dialog that restates what would be lost (`mdm.grid.dirty.leave`).
  A browser-level `beforeunload` guard covers hard navigation.

**Inline validation.**
- Timing: a field validates on blur and on change *after its first blur* (so a half-typed
  value is not shouted at); cross-field rules validate on commit of either side; the whole
  grid validates on Save.
- An invalid cell is `aria-invalid="true"` + `.control-invalid` + a message tied by
  `aria-describedby` (extends §6). The message is a **key plus parameters**
  (`validation.*`, `mdm.grid.error.*`), so the same rule reads correctly in Hindi, German
  and Arabic, and the server stays the source of truth for the rule.
- The grid carries its own summary: the sticky bar names the count and a link that moves
  the active cell to the first error (`validation.summary.*`). Save is **never disabled**
  by a validation error — pressing it reveals them (extends §6).
- A value that passes the client and fails the server shows the server's own message
  verbatim as `detail` (§2); the UI never re-words a domain error.

**Save semantics.**
- One grid = one mutation = one audit row per record (before/after diff), committed
  in-transaction with the write. `source` records `screen` / `chatbot` / `import`, `intent`
  records the chatbot intent when there was one.
- Save posts the **whole draft**, not per-cell. The response re-reads the record and the
  grid re-renders from the server's copy. No optimistic UI on a financial, stock-affecting
  or golden-record path (§5).
- While saving: the grid is read-only and the Save button carries the spinner, so a slow
  write cannot be double-submitted.
- Per-line server errors come back keyed — `{ lineIndex, field, messageKey, params }` — and
  are mapped back onto the cells. A 20-line PO must not fail as one sentence.
- Partial accept is explicit: `commit valid lines, keep the other {count} in the report`.
  A line is never dropped silently.

**Blocked lines.** A line whose component cannot be costed, converted or resolved is
marked `blocked` (tone + shape + word) with its reason on the line and a link to the fix.
Blocked lines are excluded from the running footer total, and the footer **says** so
(`mdm.grid.totalsPartial`, `{costed} of {total}`) — a total that quietly omits a line is
the worst failure this screen can have.

**Totals.** Pinned `tfoot` (extends §7), rendered from the server's computation, per
currency where lines carry more than one: a mixed-currency grid groups totals by ISO code
under a labelled sub-row and **never** sums across currencies.

**RTL, density, expansion.**
- Every offset uses logical properties (`ms/me`, `ps/pe`, `border-inline`,
  `inset-inline-start`); the row's marker bar flips with it. `text-align: start` in text
  cells, `end` in numeric cells (`.numeric`).
- Numeric cells are `numeric` + tabular figures; money and quantities go through
  `MoneyValue`/`QuantityValue`. A unit is a mono code beside the quantity (`12 kg`).
- Row height comes from `--density-*`; the cell input uses `min-height: var(--control-height)`
  so a control at `compact` is still a target.
- Column widths are `min-content`–`max-content`; a header wraps to two lines rather than
  truncating, because "Wastage %" in German is not "Wastage %". Truncation is allowed only
  with a `title`, and never on a label the operator must act on.
- Above 200 lines the grid virtualises; the scroll container keeps the sticky header and
  footer, and `aria-rowcount` reports the real count so a screen reader is not lied to.

## 12. Related-record picker (a reference, not a text field)

`RecordPicker` (`role="combobox"` + a `role="listbox"` popup, one active descendant).

- Type-ahead searches the **server**, scoped to the chain and to the record's jurisdiction;
  results are debounced, ordered by code match first then name, and the query text is
  highlighted. Search matches on code, name, and the disambiguating field.
- A result row shows: mono code, name, and the one thing that tells two similar records
  apart (status, base UOM, jurisdiction, tax registration). Without that third item an
  operator cannot pick between two "Paneer" entries, which is how duplicate golden records
  get created in the first place.
- Keyboard: `Alt+ArrowDown` opens without typing; `Arrow` moves, `Enter` selects, `Escape`
  closes and restores the previous value, `Home`/`End` jump. The popup announces its result
  count as `status` (`mdm.picker.resultCount`).
- **A typed value that was never picked is an error** (`validation.unknownReference`), not a
  silent create. Creation from the picker exists only where the caller holds the create
  permission; it opens the create flow and returns with the new record selected, and it is
  audited as a create with `source: "picker"`.
- **Inactive records still resolve for display** on historical lines (marked `inactive`),
  but cannot be newly selected: search excludes inactive by default with an explicit
  `mdm.picker.includeInactive` toggle that says how many it added.
- Multi-select is a chip list; each chip has a keyboard-reachable remove button and the
  chip's own error state when it becomes invalid (e.g. a vendor suspended after selection).
- The same search is a registered **query** action per master (`mdm.<master>.search`), so a
  chatbot slot-fill can offer three candidates as chips (extends §8). The picker and the
  chatbot call one function.

## 13. Bulk import and CSV column mapping

Nobody types a golden record twice. Import is a first-class surface, not a script, because
the chain's real data arrives as a spreadsheet — and the owner has not supplied it yet, so
this is the path the pilot data will actually take.

- **Four steps, all reviewable, all reversible up to the commit**: Upload → Map columns →
  Validate (dry run) → Commit. The stepper is a route segment per step (`?step=map`), so a
  half-finished import can be linked and resumed.
- **The mapping is named and reused**: `ImportTemplate` per master per chain (the same
  vendor sends the same price list monthly). Mapping auto-suggests from header text and
  labels each guess as a suggestion the operator confirms, so a wrong guess is visible
  before 4,000 rows are committed.
- **Jurisdiction-required fields are shown as required for the import's target
  jurisdiction** (§15), not for India, and the mapping step refuses to proceed while a
  required target is unmapped — with the reason and the jurisdiction named.
- **Validate is a server dry run** against the identical domain rules, returning per row:
  row number, key (code), outcome (`new` / `update` / `duplicate` / `error`), and a keyed
  reason. Counts by outcome sit above the table. Duplicates are matched on the de-dup keys
  and are offered **merge or skip, never auto-merged**.
- **Commit is chunked and audited as one event plus per row**: a batch id on every audit
  row, the file name and the template on the batch, and a downloadable error report keyed
  by row and column. `source: "import"`.
- **States**: no file · unreadable/undecodable file · all rows invalid · partially valid
  (`commit valid rows`) · denied (`mdm.<master>.import`, naming the missing permission) ·
  expired template. Each is its own sentence (§2), and the error report is reachable from
  the failure state so the failure is actionable.
- Import never bypasses the approval gate: imported records land at `pending_review` where
  the master is approval-gated (§16), and a Silver chain that holds only the basic lists
  gets the same import landing directly (tier is a chain property — see §15 note).

## 14. Deactivate, with a reason — never delete

There is no delete affordance for a golden record anywhere in the console, and the API has
no delete action. Historical orders, COGS and versioned articles must keep resolving a
record that someone has stopped using.

- `Deactivate` (a governed action, `mdm.<master>.deactivate`) opens `Dialog` +
  `ConfirmSummary` (§5) and requires **a reason code** (`mdm.deactivate.reason.*`, reference
  data — not free text, so it is reportable) plus an optional note, and an effective moment
  (now / end of business day / a date, rendered locale-aware).
- The dialog restates what breaks: what the record is used by (active articles, open POs,
  per-outlet prices — counts, not "related items"), and what remains resolvable afterwards.
- **A dependency that would be orphaned refuses deactivation** with a named error
  (`mdm.deactivate.blocked` + the count + a link), because resolving what should happen to
  four active articles is the operator's decision, not the software's.
- Effects: excluded from new selection in every picker; still resolves on historical rows
  and versions; the list hides inactive rows **by default and says how many it hid** — a
  hidden row is never a silent disappearance.
- Reactivation is a separate permission and a separate audit row. Suspension (vendor,
  site) is a separate state with its own reason and its own effect (no new POs; open POs
  flagged), so "temporarily stopped" and "no longer used" never share a word.
- Audit row: action, entity, `before.status`/`after.status`, reason code, note, effective
  moment, actor, `source`.

## 15. Per-jurisdiction fields: one record, several markets

The chain record carries the tax jurisdiction; a chain trading in more than one market has
sites in more than one jurisdiction, and the golden record is chain-wide. So a
jurisdiction-varying field is *a field with a jurisdiction dimension*, presented — never
hidden, never duplicated into a second record.

- **The jurisdiction is data.** `jurisdiction` (ISO 3166-1 alpha-2 + optional subdivision,
  `IN-KA`) → `jurisdiction_field_rule` (field, requirement `required` | `recommended` |
  `forbidden`, validator, effective-from, and the citation/label that explains it). The
  interface renders rules; it does not contain them. FSSAI's mandatory fields are the first
  profile, not a hardcoded rule.
- **The jurisdiction chip** in the record header shows the mono code (`CodeLabel`) plus the
  market name from `Intl.DisplayNames` — the name is CLDR data, not a catalog key, because
  a catalog will not have the jurisdiction that gets onboarded next week.
- **Field-level marking**: a field whose requirement varies carries a suffix badge —
  `required in IN-KA` / `optional here` — with the rule's explanation in the hint and, when
  more than one jurisdiction is in scope, in the field's disclosure. The badge is tone +
  shape + words; a bare red border would be invisible in greyscale and to a screen reader.
- **Where a field varies by market, the field holds a small per-jurisdiction grid** (§11):
  one row per jurisdiction in the chain's profile set, columns for the value and its
  jurisdiction, and an explicit **`inherited`** marker on rows that take the chain-level
  value. An empty cell means "not applicable", and those are different words on purpose.
- **Compliance is a matrix, not a sentence**: for an article, a panel of
  jurisdiction × required-display-field cells (`ok` / `missing` / `not applicable`), each
  linking to the field. This is the explanation for the gate; the gate itself is
  server-side: an article cannot reach `active` while a jurisdiction the chain trades in
  has a missing required field, and the refusal names the field and the jurisdiction.
- **Cross-market completeness is evaluated per jurisdiction** — never "the chain is
  compliant". A read-only `compliance` summary on the list row says which markets are
  incomplete, so a reviewer can filter to them.
- **Money inside a jurisdiction grid is amount + ISO code per cell.** A column of mixed
  currencies is legitimate; a total across currencies is not, and the grid refuses to
  render one (it groups totals by currency instead).
- **Nothing about tax rates is overwritten.** A rate change closes the old row's effective
  window and inserts a new one; the dialog says that history is preserved, and the audit
  row records both the closed and the new window. Historical orders keep the rate they were
  sold under, exactly as a historical order keeps its article version.

## 16. Maker–checker on a master record (extends §3 and §5)

MDM is a gate, not a form: a proposer (Purchase proposes a vendor, Culinary a raw material)
and an approver (MDM Head) are different people in different roles, and the same pattern
serves Gold-tier approval-gated masters.

- Actions: `submit for review` → `approve` / `send back`, each a permission-gated mutation
  with its own audit row. The transition is refusable server-side with a keyed reason
  (incomplete in a traded jurisdiction; self-approval; unresolved duplicate).
- **The review surface is the record, read-only, with a diff**, not the form again: a
  `RecordDiff` pane (field, before, after, and the jurisdiction rule that made it matter),
  the compliance matrix (§15), and the two decisions. The approver answers "what changes
  and what is still missing", which is the only question they have.
- **Self-approval is refused by the server** (`mdm.approve.self`) and the refusal is
  audited. A hidden Approve button on one's own record is not the control.
- An approval request routes to the approver's own inbox and chatbot as an actionable item
  (§3, maker–checker), never back to the proposer, and carries the source badge.
- Every transition restates **what becomes usable when this is approved** — a vendor
  becoming selectable on POs, an article becoming sellable — because that is the
  consequence being authorised.

## 17. Chatbot parity for every pattern above

Every mutation specified in this file has a registered action code (see
`docs/design/phase-1-mdm-spec.md`), so the chatbot reaches the same capability through the
same domain function and the same permission check — a screen is the fallback and the audit
surface, not the only door.

- Reads are `query` codes (`mdm.<master>.search`, `mdm.<master>.view`); writes are
  `mutation` codes. The registry decides what a session may offer, so "the chatbot only
  shows what the role holds" is enforced by the same table the buttons read.
- Small structures render inline as a structured card (`ChatCard`, §8): a recipe of ≤ 4
  lines, a single price row, one tax rate. Above that the card offers `open in the grid`
  and carries the link — the PRD's own rule for the recipe builder.
- Anything financial, stock-affecting or golden-record-changing shows a confirm summary and
  waits (§8). Cost overrides and deactivations are confirm-only, never slot-filled.
- A low-confidence or unsupported request opens a ticket and says so (`support.*`), rather
  than guessing a field value.

## 18. Localisation in master data (extends §9)

- No user-visible string literal, including in the new surfaces: grid headers, import
  outcomes, dirty/blocked/stale markers, picker results, compliance cells, conflict reasons,
  and the copy generator for a tax rate all resolve through `t()`.
- **Business codes are never translated and never localised as text**: UOM codes (`kg`,
  `pc`), allergen codes, status codes, reason codes, permission codes, role codes, country
  and currency codes. Their *labels* come from the catalog; the code is what the API, the
  invoice and the ledger use.
- **Record content that is content** (an article name, a raw material name, a vendor's
  trade name, an ingredient declaration) is chain data, not a catalog entry: stored per
  locale with the chain's default locale required and other locales optional, edited on a
  locale tab set, and falling back to the default locale with a visible `untranslated`
  marker rather than an empty field.
- **Numbers and money**: `MoneyValue`/`QuantityValue` only; amounts are amount + ISO code;
  decimals are a *domain* rule (a UOM's precision, a currency's minor-unit exponent per ISO
  4217 — JPY has none, KWD has three), not a locale rule. A locale changes the grouping and
  the separator, never the number of meaningful decimals.
- **Dates and effective windows** go through `TimestampValue`/locale-aware date formatting;
  an effective window is rendered in the viewer's zone with the zone stated, because a tax
  rate that starts "today" in two zones is a real argument.
- **Layout survives expansion**: grid headers wrap, buttons grow, no fixed-width control
  holds a translated label, and the `en-XA` expansion pseudo-locale plus the `ar-XB` mirror
  are the acceptance test for every new surface in this file.

---

## 19. ERP-owned field and the ERP-maintained section (new — added Sept 2026)

This pattern is what keeps the ERP-parity fields (`docs/design/phase-1-mdm-spec.md` §20–§25)
out of the operator's way. It introduces **no new token, no new colour and no new component
family**: it is `DescriptionList` + `StatusShape` + `TimestampValue` + a chip, plus the
existing disclosure and validation rules. The `/design` gallery entry is
`pattern.erpOwnedField.*` (title, hint, the three states, the popover), so the pattern is
reviewable without reading a spec.

### 19.1 The field: read-only value + provenance chip

Used wherever a value is maintained by a connected system: `mdm.article.*`,
`mdm.raw_material.*`, `mdm.vendor.*`, `mdm.uom.*`, `mdm.tax_class.*`, `mdm.site.*`.

**Markup and behaviour**

- **Never a disabled input.** An ERP-owned field is a `DescriptionList` row (or a grid cell
  with `aria-readonly="true"` and `tabindex="-1"`, §11) whose value sits in the same column as
  every other value, so the record still scans as one grid of values. A disabled `<input>` is
  skipped by some screen readers, announces nothing, takes no focus and cannot be copied —
  three failure modes for one control.
- **The chip is beside the value, at the logical inline-end** (`margin-inline-start`),
  never a badge prefixed to the label: the label must read the same whether the value is ours
  or theirs.
- The chip carries: the system's **display name** (chain data, not a catalog key), the
  **key type + value** the record was matched on (mono, `<CodeLabel>`), and the **last sync
  instant** via `TimestampValue` (relative with the absolute instant in `title`, viewer's
  timezone). Tone and shape come from the existing five status families plus one glyph
  (`StatusShape`); **no new colour**.
- **One tab stop per field group**, not per field: the chip is a button
  (`aria-haspopup="dialog"`), `Enter`/`Space` opens the provenance popover, `Escape` closes
  and returns focus to the chip. A 24-field section must not become 24 keyboard stops.
- **The popover answers "why"** in four lines: the field group, the ownership in force
  (`owner`, `override_allowed`, `inbound_action`) as words, a catalogued note
  (`mdm.erp.ownership.note.*`), and a link to the connection's mapping for that field
  (permission-gated; a viewer without it sees the words and no link, never a dead link).
- **A change made by the system is visible as a change**: for the session the value carries a
  `mdm.erp.changedBySystem` marker and opens `RecordDiff` (before → after, instant, run id) — the
  existing version-diff pane, reused.
- **A local override exists only where `override_allowed`**: the affordance appears with the
  reason it exists, requires a note, and the chip switches to `local_override`. The next
  inbound divergence raises `localOverrideStands` in the run report instead of reverting the
  operator's work.
- **A refusal names itself**: a server refusal (`erp.ownership.refused`) renders as the
  server's own message as `detail` alongside the field (§6), plus the honest alternative —
  *ask MDM* (`support.ticket.raise`, pattern §12's parity rule) — so a role that cannot edit
  can still act.

**RTL, expansion, density**

- The chip uses `margin-inline-start`; in RTL it sits at the inline-end of the mirrored
  layout. The `mdm.erp.changedBySystem` marker is a **shape**, not a directional arrow, so nothing
  flips incorrectly.
- The chip wraps and grows; it is never truncated to one line (a German system name + a key +
  a date is three lines in a narrow column, and that is correct). The field's label wraps
  rather than truncating when the chip takes width.
- Values keep `numeric` + tabular figures, `MoneyValue` / `QuantityValue` unchanged, with the
  currency code or UOM code always present.
- Row height still comes from `--density-*`; the chip's own height is
  `var(--control-height)`-bounded so a `compact` row does not grow, and at `compact` the chip
  reduces to its shape + system initial with the full content in the popover and the
  accessible name.

### 19.2 The section: *ERP-maintained*, collapsed, counted, conditional

- **Always the last section of a record, collapsed by default**, its header carrying
  `mdm.erp.section.title`, the count (`mdm.erp.section.count`, `{count}` fields, `{system}`),
  and a chevron that flips with direction. The count is the only ERP fact visible while
  closed.
- **The section exists only when a system is configured and the record has at least one
  ERP-maintained value or an available mapping.** With no ERP: no section anywhere on the
  record, and the honest empty state lives on the connection screen
  (`mdm.erp.notConfigured`), where a chain would go looking for it.
- **Inside the section, fields are grouped by the §22.4 field groups** (identity,
  classification, units, dimensions, storage, shelf life, batch/serial, quality, purchasing,
  valuation, tax, origin/customs, manufacturer, revision, lifecycle), each group a
  `DescriptionList` with the same chip contract. Groups with no value are **absent**, not
  shown empty.
- **Hidden-when-irrelevant is data** (`erp_visibility_rule` rows, phase-1 spec §25.2), so a
  second ERP's different realities are configuration, not a component's `if` ladder.
- Disclosure state is per record and per session, not persisted, and the record's
  leave-with-unsaved-draft guard (§11) is unaffected: **nothing inside this section is
  editable** unless an override is allowed, and an override dirties the record like any field
  and commits with the same Save and the same audit row.

### 19.3 Chatbot parity

- "Why can't I change the tax class?" → the chatbot reads the same ownership row the chip
  popover reads and answers with the group, the owner and the system — from the domain
  response, not from prose the model invented.
- "What did the ERP change overnight?" → the run report's own query action (`mdm.erp.view`),
  answering with counts by kind and the first three affected records, with a link to the
  report for the rest.
- The chatbot **may never** apply a held-back ERP change, unlink an external key, edit a code
  map, or override an ERP-maintained value without the same confirm card a screen path needs
  (§8) and the same permission.
