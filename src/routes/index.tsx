import { Link, createFileRoute, redirect } from "@tanstack/react-router";

import { Card, CardHeader } from "~/components/ui";
import { getSession } from "~/server-fns";

/**
 * The front door. A signed-in operator goes straight to their inbox; everyone else
 * gets the one-screen explanation of what this is and how to get in.
 */
export const Route = createFileRoute("/")({
  loader: async () => {
    const session = await getSession();
    if (session.principal) throw redirect({ to: "/approvals" });
    return { signedIn: false };
  },
  component: LandingScreen,
});

const FYI = [
  {
    title: "Three layers, one model",
    body: "App (our own operators), Central (a chain's head office) and Site (one outlet) are in the schema, not in a screen. Every business table carries its chain, and site-scoped tables carry their site.",
  },
  {
    title: "Permissions resolved server-side",
    body: "A session resolves to a set of tool codes from the role assignments and delegated grants on record. The UI is built from that set; the server enforces it. A hidden button is a courtesy, never a control.",
  },
  {
    title: "Every mutation is audit-logged",
    body: "One helper writes who, role, chain, site, action, before state, after state and timestamp — in the same transaction as the change, so nothing lands unlogged.",
  },
  {
    title: "Phase 0a scope",
    body: "Migrations and seed, RBAC, the audit log, the app shell, and one working vertical slice: AppAdmin onboarding a chain, setting its tier and switching its features.",
  },
];

function LandingScreen() {
  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center gap-5 px-6 py-12">
      <header>
        <p className="text-2xs font-semibold tracking-wider text-fg-subtle uppercase">
          OmniHost.ai · Phase 0a
        </p>
        <h1 className="text-xl font-semibold text-fg">
          The platform foundation, with one vertical slice wired end to end
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          An AI-chatbot-first operations platform for multi-outlet hotel, restaurant, bar and QSR
          chains. This build is the layer every later role module plugs into — the tenant model,
          server-side RBAC, the audit trail and the app shell.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Link
            to="/login"
            className="inline-flex items-center rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Sign in
          </Link>
          <span className="text-xs text-fg-muted">
            Seeded demo accounts are listed on the sign-in screen.
          </span>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {FYI.map((item) => (
          <Card key={item.title}>
            <CardHeader title={item.title} />
            <p className="p-4 text-xs text-fg-muted">{item.body}</p>
          </Card>
        ))}
      </div>

      <p className="text-2xs text-fg-subtle">
        Not yet built, by design: the chatbot gateway, POS/KDS/CDS, orders, payments, FSSAI menu
        fields, the mobile app and deployment automation. Those are later phases.
      </p>
    </div>
  );
}
