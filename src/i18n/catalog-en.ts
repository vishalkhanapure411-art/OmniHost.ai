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
  "common.actions": "Actions",
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

  // ── AppConfig: per-chain authentication and delegated settings ───────────────
  "nav.route./chains/$chainId/settings": "Chain configuration",
  "nav.route./chains/$chainId/settings.description":
    "Authentication, SSO and the settings this chain may set within the platform's bounds.",

  "config.eyebrow": "App layer · AppConfig",
  "config.titleFallback": "Chain configuration",
  "config.description":
    "Delegated configuration for one chain: authentication, and the settings the App layer has declared overridable. Every write is permission-checked server-side and audit-logged with before and after state.",
  "config.readOnly":
    "You can read this chain's configuration but not change it: your resolved registry has chain.auth.read and chain.settings.read, and not the tools that write.",
  "config.notFound.title": "Chain not available",
  "config.notFound.description":
    "This chain is not inside your delegated scope, so its configuration is not readable from your session.",

  "config.auth.title": "Authentication & SSO",
  "config.auth.subtitle":
    "Configured per chain, exactly as the capability table sets it: AppAdmin, or AppConfig under a delegated grant.",
  "config.auth.notConfigured": "No configuration stored — this chain is on native login with the platform defaults.",
  "config.auth.configured": "Configuration stored {when} by {who}.",
  "config.auth.mode.label": "Sign-in method",
  "config.auth.mode.native": "Native username / password",
  "config.auth.mode.sso": "SSO (SAML / OIDC)",
  "config.auth.mode.hint":
    "Login method never changes what a role can do — role and permission resolution is identical either way.",
  "config.auth.protocol.label": "Protocol",
  "config.auth.protocol.saml": "SAML 2.0",
  "config.auth.protocol.oidc": "OpenID Connect",
  "config.auth.idpName.label": "Identity provider name",
  "config.auth.idpName.placeholder": "e.g. Okta — Saffron Table staff",
  "config.auth.entityId.label": "Issuer / entity ID",
  "config.auth.entityId.hint": "The OIDC issuer URL, or the SAML entityID asserted by the provider.",
  "config.auth.authorizeUrl.label": "Authorise endpoint",
  "config.auth.metadataUrl.label": "Metadata URL",
  "config.auth.metadataUrl.hint": "Optional. Used to pick up signing keys and endpoint changes.",
  "config.auth.clientId.label": "Client ID",
  "config.auth.secretRef.label": "Client secret reference",
  "config.auth.secretRef.hint":
    "A pointer into the platform secret store — the secret itself is never stored here, the same rule card data follows.",
  "config.auth.jit.label": "Provision users on first sign-in",
  "config.auth.domains.label": "Allowed email domains",
  "config.auth.domains.hint": "Comma-separated. An empty list accepts any domain the provider asserts.",
  "config.auth.defaultRole.label": "Default role for provisioned users",
  "config.auth.defaultRole.none": "No role until an admin assigns one",
  "config.auth.defaultRole.hint": "A chain-side role. Validated server-side against the role registry.",
  "config.auth.ttl.label": "Session lifetime (minutes)",
  "config.auth.ttl.hint": "Whole minutes, 15 to 4320.",
  "config.auth.enforce.label": "Require SSO for everyone at this chain",
  "config.auth.enforce.hint": "Only possible while SSO is the sign-in method.",
  "config.auth.notes.label": "Notes",
  "config.auth.tier.blocked": "SSO needs the {tier} tier; this chain is on {current}.",
  "config.auth.feature.off":
    "The sso feature is switched off for this chain. Enable it in Feature toggles first — the server refuses this write otherwise.",
  "config.auth.submit": "Review and save authentication",
  "config.auth.saving": "Saving…",
  "config.auth.review.title": "Save this authentication configuration?",
  "config.auth.review.body":
    "This is what every identity at this chain signs in against, and it is recorded against your name with the state before and after.",
  "config.auth.review.cta": "Save configuration",
  "config.auth.saved": "Authentication configuration saved.",
  "config.auth.denied.title": "Changing authentication is a delegated action",
  "config.auth.denied.description":
    "Your resolved registry does not include auth.sso.configure for this chain, so this form is shown read-only. The server would refuse the write with a 403 and record the attempt.",

  "config.settings.title": "Delegated chain settings",
  "config.settings.subtitle":
    "The App layer publishes each setting with its bounds and decides who may set it. A value outside the bounds is refused by the server, not by this form.",
  "config.settings.column.setting": "Setting",
  "config.settings.column.module": "Module",
  "config.settings.column.delegation": "Who may set it",
  "config.settings.column.bounds": "Bounds",
  "config.settings.column.value": "Value",
  "config.settings.column.lastChange": "Last change",
  "config.settings.delegation.none": "App layer only",
  "config.settings.delegation.chain_head": "Chain admin",
  "config.settings.delegation.site_head": "Site head",
  "config.settings.fixed": "Fixed by policy",
  "config.settings.unset": "Default",
  "config.settings.inherit": "Following the App-layer default",
  "config.settings.bounds.between": "{min} to {max}",
  "config.settings.bounds.min": "{min} or more",
  "config.settings.bounds.max": "{max} or fewer",
  "config.settings.bounds.none": "Any value",
  "config.settings.bounds.options": "One of: {options}",
  "config.settings.edit": "Change value",
  "config.settings.review.title": "Set {setting}?",
  "config.settings.review.body":
    "Checked against the bounds the App layer published, inside the same transaction that records the change.",
  "config.settings.review.before": "Current",
  "config.settings.review.after": "New value",
  "config.settings.review.cta": "Set value",
  "config.settings.saved": "{setting} set to {value}.",
  "config.settings.refused": "The server refused that value.",
  "config.settings.resettoDefault": "Clear the stored value and follow the default",
  "config.settings.notDelegatable":
    "The App layer has kept this setting to itself, so it cannot be changed from this chain.",
  "config.settings.wrongScope":
    "This setting is delegated to the {scope}, not to your scope, so the server will refuse a change from your session.",

  "config.locale.title": "Site language defaults",
  "config.locale.subtitle":
    "The site hop of the resolution order: user preference → site → chain → platform. A site with no value falls through to the chain's default.",
  "config.locale.column.site": "Site",
  "config.locale.column.locale": "Default language",
  "config.locale.column.timezone": "Timezone",
  "config.locale.column.status": "Status",
  "config.locale.inherit": "Follow the chain",
  "config.locale.pseudo": "layout test only",
  "config.locale.edit": "Change language",
  "config.locale.review.title": "Set the default language for {site}?",
  "config.locale.review.body":
    "Everyone at this site who has not chosen a language of their own will see the console in this one. Stored on the site record with its own audit row.",
  "config.locale.review.cta": "Set language",
  "config.locale.saved": "{site} now defaults to {locale}.",
  "config.locale.unset": "cleared",
  "config.locale.denied":
    "Your resolved registry does not include site.locale.update, so this column is read-only for you.",

  "settings.purchase.approval_threshold.label": "Approval threshold for purchase orders",
  "settings.purchase.approval_threshold.help":
    "Spec: a Central Head approves above a threshold for their function. In the chain's own currency.",
  "settings.culinary.waste_writeoff_ra_threshold.label": "Waste write-off needing Revenue Assurance co-sign",
  "settings.culinary.waste_writeoff_ra_threshold.help":
    "Spec: above a site-configured value a waste write-off needs Revenue Assurance co-sign.",
  "settings.notifications.sla_escalation.label": "Ticket SLA escalation",
  "settings.notifications.sla_escalation.help":
    "Spec: breaching a ticket's SLA escalates one level. Off leaves breaches visible but not escalated.",
  "settings.notifications.sla_escalation.option.off": "Off",
  "settings.notifications.sla_escalation.option.one_level": "Escalate one level",
  "settings.guest.prep_time_sla_minutes.label": "Guest order prep-time SLA",
  "settings.guest.prep_time_sla_minutes.help":
    "Spec: the prep-time SLA countdown is set for that site; a breach flags the ticket and the Operations dashboard.",
  "settings.store.stockout_reset_minutes.label": "Stock-out reset window",
  "settings.store.stockout_reset_minutes.help":
    "Spec: the stock-out reset policy is a site-level configuration override.",
  "settings.payments.service_charge_percent.label": "Service charge",
  "settings.payments.service_charge_percent.help":
    "Spec: the service-charge default is a site-level configuration override.",
  "settings.unit.minutes": "minutes",
  "settings.unit.percent": "%",
  "settings.unit.currency": "chain currency",

  // ── AppSupport: ticket queue and time-boxed chain access ────────────────────
  "nav.route./support": "Support queue",
  "nav.route./support.description": "Escalated tickets and the access you hold to a chain.",
  "nav.route./support.access": "Support access",
  "nav.route./support.access.description": "Time-boxed access into a chain's account, and who asked for it.",

  "support.eyebrow": "App layer · AppSupport",
  "support.title": "Support queue",
  "support.description":
    "Tickets the chatbot or the platform escalated: low-confidence intent, unsupported requests, and system-raised events. Acting on a ticket that names a chain needs reach into that chain, checked server-side on every call.",
  "support.queue.empty.title": "The queue is clear",
  "support.queue.empty.description": "No escalated ticket is waiting. An empty queue here is the honest state.",
  "support.filter.status.label": "Status",
  "support.filter.all": "All",
  "support.column.reference": "Ticket",
  "support.column.subject": "Subject",
  "support.column.severity": "Severity",
  "support.column.status": "Status",
  "support.column.chain": "Chain",
  "support.column.assigned": "Assigned",
  "support.column.due": "First response due",
  "support.column.source": "Raised by",
  "support.count.open": "{count} open",
  "support.count.overdue": "{count} overdue",
  "support.count.resolved": "{count} resolved",
  "support.status.new": "New",
  "support.status.triaged": "Triaged",
  "support.status.assigned": "Assigned",
  "support.status.waiting": "Waiting on the chain",
  "support.status.resolved": "Resolved",
  "support.status.closed": "Closed",
  "support.status.cancelled": "Cancelled",
  "support.overdue": "Past its first-response clock",
  "support.onTime": "Within SLA",
  "support.source.chatbot": "Chatbot escalation",
  "support.source.screen": "Logged by an operator",
  "support.source.system": "Raised by the system",
  "support.detail.eyebrow": "Ticket",
  "support.detail.summary": "What came in",
  "support.detail.raisedBy": "Raised by {who}",
  "support.detail.noChain":
    "This ticket has no chain context, so no chain grant is needed to act on it.",
  "support.detail.chainScoped":
    "This ticket names a chain. Acting on it requires delegated, time-boxed reach into that chain.",
  "support.detail.unreachable.title": "Outside your delegated scope",
  "support.detail.unreachable.description":
    "Your grants do not name this ticket's chain, so the server refuses every action on it. Request time-boxed access and an AppAdmin decides — asking grants nothing by itself.",
  "support.detail.sla.title": "SLA clocks",
  "support.detail.sla.response": "First response due",
  "support.detail.sla.resolve": "Resolution due",
  "support.detail.assignment.title": "Assignment",
  "support.detail.assignment.subtitle": "Assignment is recorded with its own audit row.",
  "support.detail.assignment.label": "Assigned to",
  "support.detail.assignment.unassigned": "Unassigned — in the queue",
  "support.detail.assignment.take": "Take this ticket",
  "support.detail.assignment.release": "Return to the queue",
  "support.detail.assignment.saved": "Assignment updated.",
  "support.detail.resolve.title": "Resolve this ticket",
  "support.detail.resolve.subtitle":
    "Closure by the raising role is a chain-side step and ships with the chain-side ticket modules; resolving here records the operator's fix and its note.",
  "support.detail.resolve.note.label": "Resolution note",
  "support.detail.resolve.note.hint": "At least 10 characters. Recorded in the audit trail with the status change.",
  "support.detail.resolve.submit": "Review and resolve",
  "support.detail.resolve.cta": "Resolve ticket",
  "support.detail.resolve.saved": "{reference} resolved.",
  "support.detail.resolve.already": "A ticket in this state cannot be resolved.",
  "support.detail.resolved": "Resolved {when}",
  "support.detail.resolutionNote": "Resolution note",
  "support.detail.escalation.pending":
    "Escalation on SLA breach is not implemented: a scheduler is needed and the ticket modules arrive in Phase 4.",
  "support.detail.access.title": "Working inside the chain",
  "support.detail.access.subtitle":
    "Opening a chain under a time-boxed grant records the use, so the chain's audit trail shows which support sessions touched its account.",
  "support.detail.access.open": "Open under support access",
  "support.detail.access.opened": "Support session recorded for {chain}. The grant expires {when}.",
  "support.detail.access.noGrant":
    "No live time-boxed grant covers this chain, so there is nothing to open. Request access below.",
  "support.detail.access.request": "Request time-boxed access",
  "support.detail.noSelection.title": "No ticket selected",
  "support.detail.noSelection.description": "Choose a ticket from the queue to see its detail and the actions available.",

  "support.access.eyebrow": "App layer · AppSupport",
  "support.access.title": "Time-boxed chain access",
  "support.access.description":
    "Support access to a chain's account is scoped to that chain, expires by itself, and is visible to the chain — who at OmniHost.ai touched their data, and why.",
  "support.access.grants.title": "Access you hold now",
  "support.access.grants.empty":
    "You hold no live chain-scoped grant. Request one below: asking is not having, and an approved request creates a grant with an expiry.",
  "support.access.grants.line": "{chain} — expires {when}",
  "support.access.requests.title": "Requests",
  "support.access.requests.empty": "No access request has been raised in your scope.",
  "support.access.request.title": "Request access to a chain",
  "support.access.request.subtitle":
    "Your request lands with AppAdmin, who holds scope.grant.manage. Nothing is granted until they approve it.",
  "support.access.request.chain.label": "Chain",
  "support.access.request.chain.placeholder": "Choose a chain",
  "support.access.request.reason.label": "Why you need access",
  "support.access.request.reason.hint":
    "At least 10 characters. Copied onto the grant, because the chain can read it.",
  "support.access.request.hours.label": "How long for (hours)",
  "support.access.request.hours.hint": "Whole hours, 1 to 720. The grant stops working when the window closes.",
  "support.access.request.submit": "Submit request",
  "support.access.request.saved": "Request raised for {chain}. It stays pending until AppAdmin decides.",
  "support.access.column.requester": "Requested by",
  "support.access.column.chain": "Chain",
  "support.access.column.reason": "Reason",
  "support.access.column.hours": "Requested",
  "support.access.column.status": "Status",
  "support.access.column.decidedBy": "Decided by",
  "support.access.column.grant": "Grant expires",
  "support.access.status.pending": "Pending",
  "support.access.status.approved": "Approved",
  "support.access.status.denied": "Refused",
  "support.access.status.withdrawn": "Withdrawn",
  "support.access.status.expired": "Expired",
  "support.access.decide.approve": "Approve",
  "support.access.decide.deny": "Refuse",
  "support.access.decide.title": "Approve time-boxed access for {who}?",
  "support.access.decide.body":
    "This creates a scope grant that expires on its own and is visible to the chain, carrying only the support access tool and read access.",
  "support.access.decide.note.label": "Decision note",
  "support.access.decide.cta": "Approve access",
  "support.access.decide.denyCta": "Refuse request",
  "support.access.decide.saved": "Decision recorded.",
  "support.access.decidedAt": "Decided {when} by {who}",
  "support.access.awaitingDecision": "Waiting on AppAdmin",
  "support.access.notDecider":
    "Approving or refusing is AppAdmin's: the capability table gives scope.grant.manage to AppAdmin alone.",
  "support.access.ticket": "For ticket {reference}",
  "support.access.noTicket": "Not tied to a ticket",

  // ── AppConfig console: chain configuration (auth/SSO, delegated settings, site locale) ──
  "chains.settings.link": "Chain configuration",
  "chains.settings.eyebrow": "App-layer configuration",
  "chains.settings.titleFallback": "Chain configuration",
  "chains.settings.description":
    "How this chain's people sign in, and the settings the App layer delegates to the chain.",
  "chains.settings.boundary.title": "Who owns what",
  "chains.settings.boundary.body":
    "The App layer publishes every setting with fixed bounds and decides whether a chain may change it. What the App layer fixes is shown read-only with the reason — a control that is simply missing would never tell you why the value is not yours to move.",
  "chains.settings.boundary.delegated": "Delegated to the chain",
  "chains.settings.boundary.appLayer": "App layer only",
  "chains.settings.settings.title": "Delegated chain settings",
  "chains.settings.settings.description":
    "Published by the App layer with hard bounds, and set here inside them.",
  "chains.settings.column.setting": "Setting",
  "chains.settings.column.module": "Module",
  "chains.settings.column.scope": "Applies to",
  "chains.settings.column.value": "Value in force",
  "chains.settings.column.owner": "Who may change it",
  "chains.settings.column.updated": "Last changed",
  "chains.settings.scope.chain": "Chain",
  "chains.settings.scope.site": "Site",
  "chains.settings.owner.appOnly": "App layer only",
  "chains.settings.owner.chain": "The chain (delegated)",
  "chains.settings.owner.regulator": "Fixed by the regulator",
  "chains.settings.source.default": "Default",
  "chains.settings.source.stored": "Set for this chain",
  "chains.settings.updated.never": "Never changed — running on the default",
  "chains.settings.updated.by": "{who} · {when}",
  "chains.settings.bounds": "Allowed: {min} to {max}",
  "chains.settings.value.unset": "No value set",
  "chains.settings.edit.title": "Set {setting}",
  "chains.settings.edit.cta": "Save value",
  "chains.settings.edit.saved": "Setting saved and audit-logged.",
  "chains.settings.edit.readOnly":
    "Read-only for your role, and shown so you can see the value in force.",
  "chains.settings.auth.title": "Authentication & SSO",
  "chains.settings.auth.description":
    "How everyone at this chain signs in. No secret value is stored here: the client secret is a reference into the platform secret store.",
  "chains.settings.auth.mode.label": "Sign-in mode",
  "chains.settings.auth.mode.native": "Native login",
  "chains.settings.auth.mode.sso": "Single sign-on",
  "chains.settings.auth.protocol.label": "Protocol",
  "chains.settings.auth.protocol.saml": "SAML 2.0",
  "chains.settings.auth.protocol.oidc": "OpenID Connect",
  "chains.settings.auth.idpName.label": "Identity provider name",
  "chains.settings.auth.entityId.label": "IdP entity ID",
  "chains.settings.auth.authorizeUrl.label": "Authorize URL",
  "chains.settings.auth.metadataUrl.label": "Metadata URL",
  "chains.settings.auth.clientId.label": "Client ID",
  "chains.settings.auth.secretRef.label": "Client secret reference",
  "chains.settings.auth.secretRef.hint":
    "A pointer into the platform secret store, for example vault://chains/saffron-table/idp — never the secret itself.",
  "chains.settings.auth.jit.label": "Provision users on first sign-in",
  "chains.settings.auth.jit.hint":
    "A first-time single sign-on identity is created with the default role below, never with App-layer capability.",
  "chains.settings.auth.domains.label": "Allowed email domains",
  "chains.settings.auth.domains.hint":
    "Comma-separated. An identity arriving from any other domain is refused.",
  "chains.settings.auth.defaultRole.label": "Default role for provisioned users",
  "chains.settings.auth.ttl.label": "Session lifetime",
  "chains.settings.auth.ttl.hint": "Whole minutes, 15 to 4320.",
  "chains.settings.auth.enforce.label": "Refuse native sign-in",
  "chains.settings.auth.enforce.hint": "Only meaningful while single sign-on is on.",
  "chains.settings.auth.notes.label": "Notes",
  "chains.settings.auth.notConfigured": "Nothing stored yet — the platform defaults apply.",
  "chains.settings.auth.fixedTier":
    "Single sign-on is a {tier}-and-above capability and the App layer sets that minimum: the licence tier is not raised from this screen.",
  "chains.settings.auth.fixedFeature.on":
    "The App layer has the SSO feature enabled for this chain.",
  "chains.settings.auth.fixedFeature.off":
    "The App layer has the SSO feature disabled for this chain, so single sign-on cannot be switched on here.",
  "chains.settings.auth.updated": "Last changed {when} by {who}",
  "chains.settings.auth.confirmTitle": "Change how this chain signs in?",
  "chains.settings.auth.confirmBody":
    "Everyone at {chain} signs in through this configuration. It is written with its audit row in the same transaction.",
  "chains.settings.auth.confirmCta": "Save authentication",
  "chains.settings.auth.saved": "Authentication configuration saved.",
  "chains.settings.locale.title": "Site language",
  "chains.settings.locale.description":
    "Language resolves user → site → chain → platform. A site's language is the chain's own decision; this list is what the build can render.",
  "chains.settings.locale.column.site": "Site",
  "chains.settings.locale.column.timezone": "Timezone",
  "chains.settings.locale.column.locale": "Language",
  "chains.settings.locale.inherited": "Follows the chain default",
  "chains.settings.locale.fixed":
    "The chain side sets its own language — that capability belongs to its Heads, not to the App layer.",
  "chains.settings.locale.action": "Set language",
  "chains.settings.locale.saved": "Site language saved.",
  "chains.settings.denied.auth.title": "This chain's authentication is not yours to read",
  "chains.settings.denied.auth.body":
    "Reading or changing a chain's sign-in configuration needs the capability below, delegated for this chain. Ask for the delegation rather than inferring what is configured.",
  "chains.settings.denied.settings.title": "This chain's settings are not yours to read",
  "chains.settings.denied.settings.body":
    "A chain's delegated settings are readable by an operator holding the capability below for this chain.",
  "chains.settings.validation.entityId": "An IdP entity ID is required when single sign-on is on.",
  "chains.settings.validation.protocol": "Choose SAML or OpenID Connect when single sign-on is on.",
  "chains.settings.validation.url": "Enter an absolute https URL — plain HTTP would leak assertions.",
  "chains.settings.validation.clientId": "A client ID is required when single sign-on is on.",
  "chains.settings.validation.domains": "\"{domain}\" is not an email domain.",
  "chains.settings.validation.secretRef": "Name a place in the secret store, not a secret value.",
  "chains.settings.validation.ttl": "Session lifetime must be a whole number of minutes, 15 to 4320.",
  "chains.settings.validation.number": "Enter a number.",
  "chains.settings.validation.range": "Enter a value between {min} and {max}.",
  "chains.settings.status.configured": "Configured",
  "chains.settings.status.platformDefaults": "Platform defaults",
} as const;

export type MessageKey = keyof typeof enIN;
