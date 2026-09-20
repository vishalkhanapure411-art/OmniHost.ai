import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { DEMO_ACCOUNTS, demoCredentialsVisible } from "~/domain/demo-data";
import { Badge, Button, Card, CardHeader, Field, Note, TextInput } from "~/components/ui";

/**
 * Native sign-in — the only authentication this phase implements.
 *
 * The form posts to /api/session, which sets an HttpOnly cookie and nothing else. No
 * role, scope or chain is ever sent from here: the server resolves all of that from the
 * credential, which is what makes role switching testable rather than forgeable.
 */
export const Route = createFileRoute("/login")({
  component: LoginScreen,
});

function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@omnihost.ai");
  const [password, setPassword] = useState("OmniHost!Admin#2026");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDemo] = useState(() => demoCredentialsVisible());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) {
        setError(body.message ?? "Sign-in failed.");
        return;
      }
      await router.navigate({ to: "/approvals" });
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-6 px-6 py-10 lg:flex-row lg:items-start">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader title="Sign in" subtitle="Native username and password (Phase 0a)." />
          <form
            className="flex flex-col gap-3 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="Email">
              <TextInput
                value={email}
                onChange={setEmail}
                type="email"
                autoComplete="username"
                placeholder="you@chain.example"
              />
            </Field>
            <Field label="Password">
              <TextInput value={password} onChange={setPassword} type="password" autoComplete="current-password" />
            </Field>
            {error ? <Note tone="danger">{error}</Note> : null}
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-2xs text-fg-subtle">
              SSO is not part of this phase: authentication is configurable per chain by AppConfig, and
              the spec keeps role and permission resolution identical either way.
            </p>
          </form>
        </Card>
      </div>

      <div className="w-full max-w-xl">
        <Card>
          <CardHeader
            title="Seeded demo accounts"
            subtitle="Phase 0a demo data. Role switching is real — each account resolves a different tool registry server-side."
          />
          <div className="p-4">
            {showDemo ? (
              <>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Password</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DEMO_ACCOUNTS.map((account) => (
                      <tr key={account.email}>
                        <td>
                          <button
                            type="button"
                            className="font-mono text-xs text-accent hover:underline"
                            onClick={() => {
                              setEmail(account.email);
                              setPassword(account.password);
                            }}
                          >
                            {account.email}
                          </button>
                          <span className="mt-0.5 block max-w-sm text-2xs text-fg-muted">
                            {account.blurb}
                          </span>
                        </td>
                        <td className="font-mono text-2xs text-fg-muted">{account.password}</td>
                        <td>
                          {account.assignments.map((assignment) => (
                            <Badge key={assignment.roleCode} tone="neutral">
                              {assignment.roleCode}
                            </Badge>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3">
                  <Note tone="warn">
                    Throwaway credentials for a pre-launch platform with no customer data. Delete
                    src/domain/demo-data.ts and its use in scripts/db.ts before any real chain is
                    onboarded, or set <code className="font-mono">OMNIHOST_HIDE_DEMO_CREDENTIALS=1</code>{" "}
                    to hide this panel.
                  </Note>
                </div>
              </>
            ) : (
              <Note tone="info">
                Demo credentials are hidden on this deployment. Ask the platform team for access.
              </Note>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
