# OmniHost.ai — screen pattern spec (Phase 0)

Every later role module reuses these patterns. Each entry says what the pattern is for,
the rules that make it work for an operator who sits in it for hours, and where the live
example lives. Tokens are in `src/styles/tokens.css`; components in `src/components/`;
worked examples at `/design`.

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
