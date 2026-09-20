/**
 * The source message catalog — English (India), the first market.
 *
 * Rules this file encodes (owner direction, DECISIONS.md "International exposure &
 * localisation"):
 *   * Every user-visible string in the console is addressed by a stable message ID.
 *     No component contains a literal a user can read.
 *   * IDs are namespaced by area (`chains.list.column.tier`) so a translator, a
 *     reviewer or a grep can find a string without reading the component.
 *   * Placeholders are `{name}` and are substituted by `t()`. Values are inserted as
 *     text, never as markup.
 *   * A count is never interpolated into a noun phrase. Use `tCount("key", n)`, which
 *     resolves `key.one` / `key.other` — plural rules belong to the catalog (and to
 *     ICU when this moves to a real TMS), not to the component.
 *   * Domain codes are NOT translated here. `silver`, `platinum`, `denied`, a
 *     permission code or a role code are identifiers the spec, the audit log and the
 *     API use; they get a display label (`chains.tier.silver`) and the raw code stays
 *     visible next to it where an operator needs to quote it.
 *
 * This object is the type source: adding a key here is what makes it available to
 * `t()`, and every other catalog is typed against it, so a translation cannot invent
 * a key that English does not have.
 */
export const enIN = {
  // ── Platform ─────────────────────────────────────────────────────────────────
  "app.name": "OmniHost.ai",
  "app.tagline": "Operations console",
  "app.skipToContent": "Skip to main content",
  "app.phase": "Phase 0 · platform foundation",

  // ── Generic actions ──────────────────────────────────────────────────────────
  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.close": "Close",
  "action.confirm": "Confirm",
  "action.retry": "Try again",
  "action.refresh": "Refresh",
  "action.search": "Search",
  "action.clear": "Clear",
  "action.clearFilters": "Clear filters",
  "action.signOut": "Sign out",
  "action.signIn": "Sign in",
  "action.signingIn": "Signing in…",
  "action.review": "Review",
  "action.back": "Back",
  "action.edit": "Edit",
  "action.apply": "Apply",
  "action.dismiss": "Dismiss",
  "action.open": "Open",
  "action.copy": "Copy",
  "action.copied": "Copied",

  // ── Generic labels ───────────────────────────────────────────────────────────
  "common.none": "—",
  "common.unknown": "Unknown",
  "common.required": "Required",
  "common.optional": "Optional",
  "common.readOnly": "Read-only",
  "common.loading": "Loading…",
  "common.search.placeholder": "Search",
  "common.filter": "Filter",
  "common.density.label": "Row density",
  "common.density.compact": "Compact",
  "common.density.cozy": "Cozy",
  "common.density.roomy": "Roomy",
  "common.language.label": "Language",
  "common.language.aria": "Interface language",
  "common.language.preview": "Preview",
  "common.language.coverage": "{translated} of {total} messages translated",
  "common.language.pseudoWarning":
    "Pseudo-locale for layout testing — not a real language.",
  "common.timezone.label": "Times shown in",
  "common.currency.label": "Default currency",
  "common.count.one": "{count} item",
  "common.count.other": "{count} items",
  "common.showing": "Showing {shown} of {total}",
  "common.zone": "Zone",

  // ── Validation ───────────────────────────────────────────────────────────────
  "validation.required": "{field} is required.",
  "validation.tooShort": "{field} must be at least {min} characters.",
  "validation.tooLong": "{field} must be {max} characters or fewer.",
  "validation.pattern": "{field} may use lowercase letters, digits and hyphens only.",
  "validation.taken": "{field} “{value}” is already in use.",
  "validation.summary.one": "Fix 1 field before continuing.",
  "validation.summary.other": "Fix {count} fields before continuing.",

  // ── Errors and empty/denied states ───────────────────────────────────────────
  "error.title": "That did not load",
  "error.description":
    "The server refused or failed on this request. Nothing was changed. The attempt is recorded in the audit log.",
  "error.network.description": "The server could not be reached from this browser.",
  "error.forbidden.title": "Not permitted",
  "error.forbidden.needs": "Requires {permission}, which your resolved registry does not include.",
  "error.forbidden.description":
    "Permissions are decided server-side from your role assignments and delegated grants. This screen is hidden rather than forbidden — the server would refuse the call either way.",
  "error.notFound.title": "Not found",
  "error.notFound.description":
    "No record with that identifier in your scope. It may have been deleted, or it may belong to another chain.",
  "state.empty.title": "Nothing here yet",
  "state.empty.description": "There is nothing to show in this scope.",
  "state.loading.title": "Loading",
  "state.noResults.title": "No match",
  "state.noResults.description": "No row matches “{query}”. Clear the filter to see all {total}.",

  // ── Navigation (keyed by route, so the registry stays in the domain layer) ───
  "nav.section.aria": "Console navigation",
  "nav.route./approvals": "Approvals & tasks",
  "nav.route./approvals.description": "Maker-checker items routed to your roles.",
  "nav.route./chains": "Chains",
  "nav.route./chains.description": "Onboard chains, set licence tier, switch features.",
  "nav.route./audit": "Audit trail",
  "nav.route./audit.description": "Who did what, with before and after state.",
  "nav.route./design": "Design system",
  "nav.route./design.description": "Tokens, components and patterns under review.",
  "nav.group.appLayer": "App layer",
  "nav.group.platform": "Platform",
  "nav.more": "More",

  // ── Shell ────────────────────────────────────────────────────────────────────
  "shell.scope.app": "App layer",
  "shell.scope.central": "Central (head office)",
  "shell.scope.site": "Site",
  "shell.scope.label": "Scope",
  "shell.roles.none": "No role assigned",
  "shell.chain.label": "Chain",
  "shell.site.label": "Site",
  "shell.permissions.title": "Resolved permissions",
  "shell.permissions.count.one": "{count} tool resolved server-side",
  "shell.permissions.count.other": "{count} tools resolved server-side",
  "shell.permissions.show": "Show registry",
  "shell.permissions.hide": "Hide registry",
  "shell.grants.title.one": "Operating under 1 delegated grant",
  "shell.grants.title.other": "Operating under {count} delegated grants",
  "shell.grants.description":
    "Access you hold by grant rather than by role. Scoped to the permissions named here, and time-boxed where the spec requires it.",
  "shell.grants.line": "{reason} · granted by {by} · expires {when}",
  "shell.grants.noExpiry": "no expiry set",
  "shell.session.expires": "Session expires {when}",
  "shell.localeSource.user": "your preference",
  "shell.localeSource.site": "this site's default",
  "shell.localeSource.chain": "this chain's default",
  "shell.localeSource.platform": "the platform default",
  "shell.direction": "Text direction",
  "shell.direction.ltr": "Left to right",
  "shell.direction.rtl": "Right to left",

  // ── Sign in ──────────────────────────────────────────────────────────────────
  "login.eyebrow": "OmniHost.ai · Secure sign-in",
  "login.title": "Sign in",
  "login.subtitle": "Native username and password. Single sign-on is configured per chain by AppConfig.",
  "login.email.label": "Email",
  "login.email.placeholder": "you@chain.example",
  "login.password.label": "Password",
  "login.error.required": "Enter your email and password.",
  "login.error.invalid": "Email or password is incorrect.",
  "login.error.disabled": "This account is disabled.",
  "login.error.unreachable": "The server could not be reached.",
  "login.sso.note":
    "Role and permission resolution is identical whether you sign in here or through your chain's identity provider.",
  "login.demo.title": "Seeded demo accounts",
  "login.demo.subtitle":
    "Demo data. Role switching is real: each account resolves a different tool registry server-side.",
  "login.demo.column.account": "Account",
  "login.demo.column.password": "Password",
  "login.demo.column.role": "Role",
  "login.demo.use": "Use this account",
  "login.demo.hidden": "Demo credentials are hidden on this deployment.",
  "login.demo.warning":
    "Throwaway credentials for a pre-launch platform holding no customer data. They must be removed before any real chain is onboarded.",

  // ── Front door (signed out) ──────────────────────────────────────────────────
  "landing.eyebrow": "OmniHost.ai · {phase}",
  "landing.title": "The platform foundation, with one vertical slice wired end to end",
  "landing.body":
    "An AI-chatbot-first operations platform for multi-outlet hotel, restaurant, bar and QSR chains. This build is the layer every later role module plugs into: the tenant model, server-side RBAC, the audit trail, an internationalised app shell and the AppAdmin slice.",
  "landing.cta": "Sign in",
  "landing.hint": "The seeded demo accounts are listed on the sign-in screen.",
  "landing.card.layers.title": "Three layers, one model",
  "landing.card.layers.body":
    "App (our operators), Central (a chain's head office) and Site (one outlet) are modelled in the schema, not in a screen. Every business row carries its chain, and site-scoped rows carry their site.",
  "landing.card.permissions.title": "Permissions resolved server-side",
  "landing.card.permissions.body":
    "A session resolves to tool codes from the role assignments and delegated grants on record. The interface is built from that set; the server enforces it. A hidden button is a courtesy, never a control.",
  "landing.card.audit.title": "Every mutation is audit-logged",
  "landing.card.audit.body":
    "One helper writes actor, role, chain, site, action, before state, after state and timestamp in the same transaction as the change, so nothing lands unlogged — including refused attempts.",
  "landing.card.i18n.title": "Built India-first, designed for rollout",
  "landing.card.i18n.body":
    "Every label, message and empty state comes from a message catalog; currency is an amount plus an ISO code; timestamps render in the viewer's zone; the layout mirrors for right-to-left locales.",
  "landing.notBuilt":
    "Not built yet, by design: the chatbot gateway, POS/KDS/CDS, orders, payments, FSSAI menu fields, the mobile app and deployment automation. Those are later phases.",

  // ── Chains (AppAdmin) ────────────────────────────────────────────────────────
  "chains.eyebrow": "App layer · Licensing",
  "chains.title": "Chains",
  "chains.description":
    "Onboard a tenant, set its licence tier and switch its features. Licence tier is per chain — every site in a chain runs the same tier.",

  "chains.list.title": "Chains in your scope",
  "chains.list.empty.title": "No chain inside your scope",
  "chains.list.empty.description":
    "A delegated AppConfig or AppSupport operator sees only the chains a grant names, so an empty list here is the permission model working as designed.",
  "chains.column.chain": "Chain",
  "chains.column.tier": "Tier",
  "chains.column.jurisdiction": "Jurisdiction",
  "chains.column.status": "Status",
  "chains.column.sites": "Sites",
  "chains.column.features": "Features on",
  "chains.column.onboarded": "Onboarded",

  "chains.tier.silver": "Silver",
  "chains.tier.gold": "Gold",
  "chains.tier.platinum": "Platinum",
  "chains.tier.help":
    "Tiers gate module depth and AI variants, never which roles exist.",
  "chains.status.active": "Active",
  "chains.status.suspended": "Suspended",
  "chains.status.pending": "Pending",
  "chains.features.enabledOf": "{enabled} of {total}",

  "chains.onboard.eyebrow": "App layer · AppAdmin only",
  "chains.onboard.title": "Onboard a chain",
  "chains.onboard.description":
    "Creates the tenant, its licence tier and one feature row per registry feature in a single audited transaction.",
  "chains.onboard.section.identity": "Tenant identity",
  "chains.onboard.section.licence": "Licence and compliance",
  "chains.onboard.section.features": "Initial feature set",
  "chains.onboard.name.label": "Chain name",
  "chains.onboard.name.placeholder": "e.g. Saffron Table Hospitality",
  "chains.onboard.name.hint": "The trading name your sites will see.",
  "chains.onboard.code.label": "Chain code",
  "chains.onboard.code.placeholder": "saffron-table",
  "chains.onboard.code.hint": "Lowercase slug, unique across the platform. Derived from the name if left blank.",
  "chains.onboard.jurisdiction.label": "Tax jurisdiction",
  "chains.onboard.jurisdiction.hint": "ISO region, optionally with a subdivision (IN-KA). Drives GST/VAT and menu-display rules.",
  "chains.onboard.tier.label": "Licence tier",
  "chains.onboard.features.hint": "Anything left at registry default. A feature above the chain's tier cannot be switched on.",
  "chains.onboard.features.needsTier": "Needs {tier}",
  "chains.onboard.features.alwaysOn": "Always on",
  "chains.onboard.submit": "Review and onboard",
  "chains.onboard.submitting": "Onboarding…",
  "chains.onboard.denied.title": "Onboarding is AppAdmin's",
  "chains.onboard.denied.description":
    "Your resolved registry has chain.list and chain.read but not chain.onboard, so this form is shown read-only. Submitting it would be refused by the server with a 403, and the refusal would be written to the audit log.",
  "chains.onboard.review.title": "Onboard this chain?",
  "chains.onboard.review.body":
    "This creates a tenant and writes one audit entry with the full feature set as the after-state. Confirm to proceed.",
  "chains.onboard.review.confirm": "Onboard chain",
  "chains.onboard.success": "{name} onboarded on the {tier} tier.",

  "chains.detail.eyebrow": "App layer · Chain configuration",
  "chains.detail.titleFallback": "Chain",
  "chains.detail.description":
    "Licence tier, feature toggles and sites. Every change is permission-checked server-side and written to the audit log with before and after state.",
  "chains.detail.tier.title": "Licence tier",
  "chains.detail.tier.subtitle": "Set per chain, never per site — every site in the chain runs the same tier.",
  "chains.detail.tier.confirmTitle": "Change licence tier to {tier}?",
  "chains.detail.tier.confirmBody":
    "Tier gates module depth and whether an AI-assisted variant is available. Features above {tier} switch off, and every site in the chain is affected. This is recorded against your name.",
  "chains.detail.tier.confirmCta": "Change tier",
  "chains.detail.tier.sitesAffected.one": "Affects 1 site.",
  "chains.detail.tier.sitesAffected.other": "Affects {count} sites.",
  "chains.detail.features.title": "Feature toggles",
  "chains.detail.features.subtitle.one": "{enabled} of 1 feature switched on.",
  "chains.detail.features.subtitle.other": "{enabled} of {total} features switched on.",
  "chains.detail.features.blocked": "Needs the {tier} tier; this chain is on {current}.",
  "chains.detail.features.availableFrom": "Available from {tier}.",
  "chains.detail.features.toggleLabel": "Enable {feature}",
  "chains.detail.features.alwaysOn": "always on",
  "chains.detail.features.column.feature": "Feature",
  "chains.detail.features.column.module": "Module",
  "chains.detail.features.column.minTier": "From tier",
  "chains.detail.features.column.lastChange": "Last change",
  "chains.detail.features.column.enabled": "Enabled",
  "chains.detail.sites.title": "Sites & outlets",
  "chains.detail.sites.subtitle": "Where this chain operates today, with each site's own timezone.",
  "chains.detail.sites.empty.title": "No sites yet",
  "chains.detail.sites.empty.description":
    "Site and outlet management arrives with its own phase; this chain was onboarded without one.",
  "chains.detail.sites.column.site": "Site",
  "chains.detail.sites.column.timezone": "Timezone",
  "chains.detail.sites.column.outlets": "Outlets",
  "chains.detail.sites.column.status": "Status",
  "chains.detail.outletKind.restaurant": "Restaurant",
  "chains.detail.outletKind.bar": "Bar",
  "chains.detail.outletKind.qsr": "QSR",
  "chains.detail.outletKind.cafe": "Café",
  "chains.detail.outletKind.hotel": "Hotel F&B",
  "chains.detail.notFound.title": "Chain not available",
  "chains.detail.notFound.description":
    "This chain is not inside your resolved scope. A delegated grant names the chains you may reach, so a link pasted in from someone else's session will land here.",

  // ── Approvals & tasks ────────────────────────────────────────────────────────
  "approvals.eyebrow": "Shared inbox",
  "approvals.title": "Approvals & tasks",
  "approvals.description":
    "Items routed to a role you hold. Maker-checker actions land with the approver, never back with the requester.",
  "approvals.queue.title": "Waiting on you",
  "approvals.queue.assignedTo": "Assigned to {role}",
  "approvals.queue.unassigned": "Unassigned",
  "approvals.queue.due": "Due {when}",
  "approvals.queue.raisedBy": "Raised by {who}, {role}",
  "approvals.queue.overdue": "Overdue",
  "approvals.empty.title": "Nothing waiting on you",
  "approvals.empty.description":
    "No maker-checker item is routed to your roles yet. Receiving approvals, waste write-offs and refund sign-offs start raising items when their modules ship — an empty inbox here is the honest state, not a broken screen.",
  "approvals.how.title": "How this inbox works",
  "approvals.how.subtitle": "Built from the spec's maker-checker rule, not from a screen design.",
  "approvals.how.paragraph1":
    "Every item is an approval_task row carrying its chain, its site, the role that raised it and the role that must decide. The query filters on the roles you hold and on your resolved tenant scope, so an item can never appear to someone it was not routed to.",
  "approvals.how.paragraph2":
    "An SLA breach escalates one level — Team to Head, Head to Site Head or Operations — and closure requires the raising role or their Head to verify the fix, per the spec's ticketing rules.",
  "approvals.how.footer": "Signed in as {name} with {roles} — that is what this queue is filtered to.",
  "approvals.column.item": "Item",
  "approvals.column.chain": "Chain",
  "approvals.column.category": "Category",
  "approvals.column.assignedRole": "Decided by",
  "approvals.column.due": "Due",

  "severity.low": "Low",
  "severity.medium": "Medium",
  "severity.high": "High",
  "severity.critical": "Critical",

  // ── Audit trail ──────────────────────────────────────────────────────────────
  "audit.eyebrow": "Controls · Transparency",
  "audit.title": "Audit trail",
  "audit.description":
    "Who, which role, which chain and site, what action, and the state before and after — written by one shared helper for every mutation, refused attempts included.",
  "audit.list.title": "Most recent",
  "audit.list.count.one": "1 entry",
  "audit.list.count.other": "{count} entries",
  "audit.column.when": "When",
  "audit.column.actor": "Actor",
  "audit.column.action": "Action",
  "audit.column.entity": "Entity",
  "audit.column.outcome": "Outcome",
  "audit.column.source": "Source",
  "audit.column.stateChange": "State change",
  "audit.outcome.success": "Succeeded",
  "audit.outcome.denied": "Refused",
  "audit.outcome.error": "Failed",
  "audit.source.screen": "Screen",
  "audit.source.chatbot": "Chatbot",
  "audit.source.api": "API",
  "audit.before": "Before",
  "audit.after": "After",
  "audit.noChange": "no stored change",
  "audit.intent": "Chatbot intent: {intent}",
  "audit.detail.title": "State changes",
  "audit.detail.eyebrow": "Before / after",
  "audit.detail.empty.description": "Once a mutation runs, its before and after state appears here.",
  "audit.empty.title": "Nothing recorded yet",
  "audit.empty.description": "No audited action is visible to your scope yet.",
  "audit.filter.search.placeholder": "Filter by action, actor or entity",
  "audit.filter.outcome.label": "Outcome",
  "audit.filter.all": "All",
  "audit.platform": "Platform-wide",

  // ── Design system gallery ────────────────────────────────────────────────────
  "design.eyebrow": "Design system · Under review",
  "design.title": "Tokens, components and patterns",
  "design.description":
    "Every visual decision in the console comes from tokens.css; every string from a catalog. This page is the reference the next module is built against, and the surface the owner reviews.",

  "design.tokens.title": "Colour and elevation tokens",
  "design.tokens.body":
    "Semantic names only. A screen never names a colour, a radius or a row height — it uses a token, so a chain's theme or a dark surface is a change in one file.",
  "design.typography.title": "Type ramp and figures",
  "design.typography.body":
    "One ramp, dense-data first. Numeric columns use tabular figures and align to the decimal so a column of money scans vertically.",
  "design.density.title": "Row density",
  "design.density.body":
    "Three densities from one token set. A site back-office tablet and a HQ console read the same table at different heights.",
  "design.badges.title": "Status, tier, severity and outcome badges",
  "design.badges.body":
    "Colour is never the only signal: every status carries a shape or an icon and a text label, so it survives colour blindness, a photocopier and a monochrome screen.",
  "design.tables.title": "Data table",
  "design.tables.body":
    "Sortable headers with aria-sort, keyboard row focus, a selected-row state, right-aligned numeric columns and an honest empty state.",
  "design.forms.title": "Form fields and inline validation",
  "design.forms.body":
    "Errors are tied to their field with aria-describedby and aria-invalid, summarised above the form, and never replaced by colour alone. Submit is never disabled by a validation error — the message is.",
  "design.dialogs.title": "Confirm before commit",
  "design.dialogs.body":
    "Anything financial, stock-affecting or permission-widening shows a summary and waits for an explicit confirm. The confirm dialog names the record and the consequence.",
  "design.feedback.title": "Banners, loading, empty and denied states",
  "design.feedback.body":
    "Four states every screen owes the operator: what it is doing, what is empty, what failed, and what you are not allowed to do.",
  "design.money.title": "Money and numbers",
  "design.money.body":
    "Currency is an amount plus an ISO code, never a bare number and never an assumed rupee. The code is always visible or one focus away, and the fraction is set in its own span so decimals line up.",
  "design.chat.title": "Chatbot cards",
  "design.chat.body":
    "The chatbot is the primary interface; these cards land in its thread and call the identical domain APIs under the identical server-side permission check. Same tokens, same audit trail.",
  "design.i18n.title": "Locale resolution",
  "design.i18n.body":
    "User preference → site default → chain default → platform default. The hop that won is shown, because “why is this screen in this language” is a support question.",
  "design.i18n.hop.user": "User preference",
  "design.i18n.hop.site": "Site default",
  "design.i18n.hop.chain": "Chain default",
  "design.i18n.hop.platform": "Platform default",
  "design.i18n.hop.notSet": "not set",
  "design.i18n.hop.winner": "in use",
  "design.i18n.direction": "Direction",
  "design.i18n.rtl": "Right-to-left",
  "design.i18n.ltr": "Left-to-right",
  "design.i18n.rtlBody":
    "Logical properties only: no left/right paddings, no text-align: left, arrows and chevrons flip, objects such as a bin icon do not. Toggle the language to the RTL pseudo-locale to see the whole shell mirror.",
  "design.i18n.expansion":
    "The pseudo-locales are generated from the English catalog: one mirrors to right-to-left, one pads every string by 40% so a truncated label or a fixed-width button shows up now rather than at translation time.",

  "design.section.tokens": "Tokens",
  "design.section.components": "Components",
  "design.section.patterns": "Patterns",
  "design.section.i18n": "Localisation",

  "pattern.ledger.title": "Ledger / variance table",
  "pattern.ledger.body":
    "The shape Purchase, Store and Revenue Assurance reuse. A quantity column is a number with its UOM code; a money column is an amount with its currency; a variance column is signed, coloured and labelled.",
  "pattern.ledger.column.item": "Item",
  "pattern.ledger.column.bookQty": "Book qty",
  "pattern.ledger.column.countQty": "Counted",
  "pattern.ledger.column.variance": "Variance",
  "pattern.ledger.column.value": "Value",
  "pattern.ledger.total": "Total",
  "pattern.ledger.varianceOf": "{value} over tolerance",
  "pattern.masterdata.title": "Master-data list",
  "pattern.masterdata.body":
    "The shape MDM, Culinary and Purchase reuse: filter on the left, dense list in the middle, one row's detail on the right, selection addressable in the URL.",
  "pattern.approval.title": "Approval queue row",
  "pattern.approval.body":
    "One row per maker-checker item: what it is, which chain and site, who raised it and under which role, what it is worth, when it breaches SLA, and the two decisions available.",
  "pattern.chatcard.title": "Chatbot confirmation card",
  "pattern.chatcard.body":
    "The same confirmation the screens use, rendered in the chat thread. It names the action, shows the fields that will be written, and refuses to commit until confirmed.",
  "pattern.chatcard.action": "Raise indent",
  "pattern.chatcard.summary": "20 kg tomatoes for Site 12, needed by {date}.",
  "pattern.chatcard.confirm": "Raise indent",
  "pattern.chatcard.edit": "Edit values",
  "pattern.chatcard.cancel": "Cancel",
  "pattern.chatcard.queued": "Awaiting your confirmation",
  "pattern.chatcard.committed": "Indent #IN-2044 raised and routed to the Purchase Head",
  "pattern.chatcard.disclosure":
    "Permission checked server-side against the same tool registry the screens use.",

  "pattern.multiline.title": "Multi-line entry",
  "pattern.multiline.body":
    "The shape a PO, GRN or roster needs: a header of context, repeating rows with their own validation, a running total, and one commit for the whole document.",

  "a11y.sortedAscending": "sorted ascending",
  "a11y.sortedDescending": "sorted descending",
  "a11y.sortBy": "Sort by {column}",
  "a11y.queue": "Approval queue",
  "a11y.masterPane": "List",
  "a11y.detailPane": "Detail",
  "a11y.status": "Status: {status}",
  "a11y.moneyAmount": "{amount} {currency}",
  "a11y.decimalsHint": "Amounts are shown with their currency code.",
} as const;

export type MessageKey = keyof typeof enIN;
