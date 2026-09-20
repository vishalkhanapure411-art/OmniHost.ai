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
  locale: string;
  /** What this account is for, shown on the sign-in screen. */
  blurb: string;
  assignments: {
    roleCode: string;
    chainCode?: string;
    siteCode?: string;
  }[];
  grants: {
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
  taxJurisdiction: string;
  outlets: { name: string; code: string; kind: string }[];
}[] = [
  {
    chainCode: "saffron-table",
    name: "Saffron Table — Koramangala",
    code: "saffron-koramangala",
    timezone: "Asia/Kolkata",
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
    taxJurisdiction: "IN-KA",
    outlets: [{ name: "Indiranagar QSR", code: "indiranagar-qsr", kind: "qsr" }],
  },
  {
    chainCode: "coastal-catch",
    name: "Coastal Catch — Bandra",
    code: "coastal-bandra",
    timezone: "Asia/Kolkata",
    taxJurisdiction: "IN-MH",
    outlets: [{ name: "Bandra Restaurant", code: "bandra-restaurant", kind: "restaurant" }],
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
      "AppConfig — holds a delegated slice: chain tier and feature toggles for Saffron Table only, expiring in 90 days.",
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
      "AppSupport — holds a time-boxed, chain-scoped support grant for Saffron Table (7 days). Cannot onboard a chain or touch its tier or toggles.",
    assignments: [{ roleCode: "APP_SUPPORT" }],
    grants: [
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
    locale: "en-IN",
    blurb:
      "Site Head — owns one outlet: site-level approval for every function, and the only chain-side role here that reads the audit trail.",
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
