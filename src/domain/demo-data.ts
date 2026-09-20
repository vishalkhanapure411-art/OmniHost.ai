/**
 * Phase 0a demo data.
 *
 * Kept in src/ (not scripts/) so the sign-in screen can list the seeded accounts and
 * the shell can name the demo chains without duplicating them. This file holds plain
 * data and no database access, so it is safe to import from a component.
 *
 * These are throwaway credentials for a pre-launch platform with no real customer
 * data. Set OMNIHOST_HIDE_DEMO_CREDENTIALS=1 to stop the sign-in screen from showing
 * them, and delete this file (and its use in scripts/db.ts) before any real chain is
 * onboarded.
 */

export interface DemoAccount {
  email: string;
  displayName: string;
  password: string;
  /** NULL = no personal preference: the site hop of the resolution order decides. */
  locale: string | null;
  /** What this account is for, shown on the sign-in screen. */
  blurb: string;
  assignments: {
    roleCode: string;
    chainCode?: string;
    siteCode?: string;
  }[];
  grants: {
    /** Omitted = a platform-wide delegation (no chain data implied by it). */
    chainCode?: string;
    reason: string;
    expiresInDays: number;
    permissions: string[];
  }[];
}

export const DEMO_CHAINS: {
  name: string;
  code: string;
  licenceTier: "silver" | "gold" | "platinum";
  taxJurisdiction: string;
  features: Record<string, boolean>;
}[] = [
  {
    name: "Saffron Table Hospitality",
    code: "saffron-table",
    licenceTier: "gold",
    taxJurisdiction: "IN-KA",
    // Gold and up: SSO configurable, CDS included, full recipe BOM. Platinum-only
    // capabilities stay off, which is what makes the tier rule visible on screen.
    features: {
      sso: true,
      cds: true,
      recipe_full_bom: true,
      operations_dashboards: true,
      site_content_authoring: true,
    },
  },
  {
    name: "Coastal Catch Kitchens",
    code: "coastal-catch",
    licenceTier: "silver",
    taxJurisdiction: "IN-MH",
    features: {},
  },
];

export const DEMO_SITES: {
  chainCode: string;
  name: string;
  code: string;
  timezone: string;
  /**
   * The site's own language default (site.locale, migration 0005). Deliberately not
   * all the same: a chain's outlets routinely run in different languages, and a demo
   * where they do not is a demo of the wrong product.
   */
  locale: string | null;
  taxJurisdiction: string;
  outlets: { name: string; code: string; kind: string }[];
}[] = [
  {
    chainCode: "saffron-table",
    name: "Saffron Table — Koramangala",
    code: "saffron-koramangala",
    timezone: "Asia/Kolkata",
    // Hindi first: the outlet's floor team reads Hindi. The seeded Site Head carries no
    // personal preference, so this column is what decides their language — which is the
    // only way the site hop is ever observable.
    locale: "hi-IN",
    taxJurisdiction: "IN-KA",
    outlets: [
      { name: "Koramangala Restaurant", code: "koramangala-restaurant", kind: "restaurant" },
      { name: "Koramangala Terrace Bar", code: "koramangala-bar", kind: "bar" },
    ],
  },
  {
    chainCode: "saffron-table",
    name: "Saffron Table — Indiranagar",
    code: "saffron-indiranagar",
    timezone: "Asia/Kolkata",
    locale: "en-IN",
    taxJurisdiction: "IN-KA",
    outlets: [{ name: "Indiranagar QSR", code: "indiranagar-qsr", kind: "qsr" }],
  },
  {
    chainCode: "coastal-catch",
    name: "Coastal Catch — Bandra",
    code: "coastal-bandra",
    timezone: "Asia/Kolkata",
    // NULL on purpose: a site whose language has not been decided falls through to the
    // chain default, which is the behaviour this column replaced as an interim hack.
    locale: null,
    taxJurisdiction: "IN-MH",
    outlets: [{ name: "Bandra Restaurant", code: "bandra-restaurant", kind: "restaurant" }],
  },
];

/**
 * Demo support tickets — the AppSupport queue.
 *
 * Three shapes, because the queue has to behave differently for each: a chatbot
 * escalation inside a chain the seeded support operator has access to, one inside a
 * chain they do not (the negative case: the chain scope check is what stops it), and a
 * platform-level escalation with no chain at all.
 */
export const DEMO_SUPPORT_TICKETS: {
  reference: string;
  chainCode?: string;
  siteCode?: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  source: "chatbot" | "screen" | "system";
  subject: string;
  detail: string;
  status: "new" | "triaged" | "assigned" | "waiting" | "resolved" | "closed" | "cancelled";
  /** Free text: the raiser is a conversation, not a person. */
  raisedByLabel: string;
  assignedToEmail?: string;
  /** Hours from now, so a re-seed always produces a live SLA clock. */
  responseDueInHours: number;
  resolveDueInHours: number;
}[] = [
  {
    reference: "TCK-1042",
    chainCode: "saffron-table",
    siteCode: "saffron-koramangala",
    category: "support",
    severity: "high",
    source: "chatbot",
    subject: "CDS shows yesterday's price for two dessert articles",
    detail:
      "Raised from the chatbot after a low-confidence intent at Site 12. The Customer Display System served a stale price for two dessert lines through the lunch service.",
    status: "assigned",
    raisedByLabel: "Chatbot escalation (confidence below threshold)",
    assignedToEmail: "support@omnihost.ai",
    responseDueInHours: -2,
    resolveDueInHours: 20,
  },
  {
    reference: "TCK-1043",
    chainCode: "saffron-table",
    category: "support",
    severity: "medium",
    source: "chatbot",
    subject: "Unsupported request: \"export last quarter's vendor spend to Excel\"",
    detail:
      "The chatbot has no tool for vendor-spend export. Recorded so the missing tool is a product decision rather than a dead end for the operator.",
    status: "triaged",
    raisedByLabel: "Chatbot escalation (unsupported request)",
    responseDueInHours: 6,
    resolveDueInHours: 72,
  },
  {
    reference: "TCK-1044",
    chainCode: "coastal-catch",
    category: "support",
    severity: "critical",
    source: "system",
    subject: "Three failed sign-in attempts followed by a lockout at Bandra",
    detail:
      "Raised by the system on repeated failed native sign-ins. Deliberately outside the seeded support operator's delegated chain scope: opening it requires a grant for Coastal Catch, which is the check working as designed.",
    status: "new",
    raisedByLabel: "System (auth anomaly)",
    responseDueInHours: 1,
    resolveDueInHours: 8,
  },
  {
    reference: "TCK-1045",
    category: "support",
    severity: "low",
    source: "screen",
    subject: "Request: per-site language default in the console",
    detail:
      "Operator feedback logged against the platform rather than against one chain, so the ticket has no chain context at all.",
    status: "waiting",
    raisedByLabel: "Operator feedback",
    responseDueInHours: -30,
    resolveDueInHours: 200,
  },
];

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: "admin@omnihost.ai",
    displayName: "Priya Raman",
    password: "OmniHost!Admin#2026",
    locale: "en-IN",
    blurb: "AppAdmin — configures anything on the platform; the only account that can onboard a chain.",
    assignments: [{ roleCode: "APP_ADMIN" }],
    grants: [],
  },
  {
    email: "config@omnihost.ai",
    displayName: "Arun Nair",
    password: "OmniHost!Config#2026",
    locale: "en-IN",
    blurb:
      "AppConfig — holds a delegated slice for Saffron Table only, expiring in 90 days: tier, feature toggles, SSO/auth configuration, the chain's delegated settings and its sites' language defaults.",
    assignments: [{ roleCode: "APP_CONFIG" }],
    grants: [
      {
        chainCode: "saffron-table",
        reason: "Onboarding and configuration support for Saffron Table Hospitality.",
        expiresInDays: 90,
        permissions: [
          "chain.list",
          "chain.read",
          "chain.tier.update",
          "chain.feature.update",
          "auth.sso.configure",
          "chain.auth.read",
          "chain.settings.read",
          "chain.setting.define",
          "chain.setting.update",
          "site.locale.update",
          "chain.audit.read",
        ],
      },
    ],
  },
  {
    email: "support@omnihost.ai",
    displayName: "Meera Iyer",
    password: "OmniHost!Support#2026",
    locale: "en-IN",
    blurb:
      "AppSupport — the ticket queue by platform-wide delegation, plus one time-boxed, chain-scoped support grant for Saffron Table (7 days). Cannot configure a chain or change its tier.",
    assignments: [{ roleCode: "APP_SUPPORT" }],
    grants: [
      {
        // Platform-wide, and deliberately narrow: working the queue is not access into
        // any chain's data. Every chain-scoped action still needs the grant below.
        reason: "AppSupport ticket queue (no chain data implied).",
        expiresInDays: 365,
        permissions: [
          "support.ticket.read",
          "support.ticket.assign",
          "support.ticket.resolve",
          "support.access.request",
        ],
      },
      {
        chainCode: "saffron-table",
        reason: "Ticket #1042 — investigating a reported CDS content problem at Saffron Table.",
        expiresInDays: 7,
        permissions: ["chain.list", "chain.read", "support.chain_access.timeboxed"],
      },
    ],
  },
  {
    email: "purchase.head@saffron.example",
    displayName: "Rahul Deshpande",
    password: "Saffron!Purchase#2026",
    locale: "en-IN",
    blurb:
      "Central Purchase Head — configures purchase policy and approves above the threshold, chain-wide. No App-layer capability.",
    assignments: [{ roleCode: "CENTRAL_PURCHASE_HEAD", chainCode: "saffron-table" }],
    grants: [],
  },
  {
    email: "site.head@saffron.example",
    displayName: "Anita Kulkarni",
    password: "Saffron!SiteHead#2026",
    // No personal language preference on purpose: Koramangala's site default (hi-IN)
    // is what decides this account's language. That is the site hop, made observable.
    locale: null,
    blurb:
      "Site Head — owns one outlet: site-level approval for every function, the only chain-side role here that reads the audit trail, and no language preference set (their outlet's site default applies).",
    assignments: [
      { roleCode: "SITE_HEAD", chainCode: "saffron-table", siteCode: "saffron-koramangala" },
    ],
    grants: [],
  },
];

/** Whether the sign-in screen may list the seeded accounts. */
export function demoCredentialsVisible(): boolean {
  return process.env.OMNIHOST_HIDE_DEMO_CREDENTIALS !== "1";
}
