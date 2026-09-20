import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { LanguageSwitcher } from "~/components/AppShell";
import { DEMO_ACCOUNTS, demoCredentialsVisible } from "~/domain/demo-data";
import { Badge, Banner, Button, Card, CardHeader, Field, PageHeader, TextInput } from "~/components/ui";
import { useI18n } from "~/i18n";

/**
 * Native sign-in — the only authentication this phase implements.
 *
 * The form posts to /api/session, which sets an HttpOnly cookie and nothing else. No
 * role, scope or chain is ever sent from here: the server resolves all of that from the
 * credential, which is what makes role switching testable rather than forgeable.
 *
 * This screen is deliberately the first one translated and the one carrying the language
 * switcher, because it is the screen a new user sees before anything is explained: if
 * the interface language is wrong here, it is wrong everywhere, and nobody has yet been
 * told where to change it. It resolves through the same order as the rest of the
 * console — cookie, then the account's own `user.locale`, then the platform default.
 */
export const Route = createFileRoute("/login")({
  component: LoginScreen,
});

function LoginScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("admin@omnihost.ai");
  const [password, setPassword] = useState("OmniHost!Admin#2026");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDemo] = useState(() => demoCredentialsVisible());

  async function submit() {
    if (!email.trim() || !password) {
      setFieldError(t("login.error.required"));
      return;
    }
    setFieldError(null);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) {
        // The server's message is shown as it arrives. The sign-in path deliberately
        // returns the same message for an unknown address and a wrong password, and the
        // UI must not "helpfully" distinguish them.
        setError(body.message ?? t("login.error.invalid"));
        return;
      }
      await router.invalidate();
      await router.navigate({ to: "/approvals" });
    } catch {
      setError(t("login.error.unreachable"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell-content">
      <PageHeader
        eyebrow={t("login.eyebrow")}
        title={t("app.name")}
        description={t("login.subtitle")}
        actions={<LanguageSwitcher />}
      />

      <div className="mx-auto grid max-w-5xl gap-4 p-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
        <Card>
          <CardHeader title={t("login.title")} subtitle={t("login.sso.note")} />
          <form
            className="flex flex-col gap-3 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field id="login-email" label={t("login.email.label")} error={fieldError} required>
              <TextInput
                value={email}
                onChange={setEmail}
                type="email"
                autoComplete="username"
                placeholder={t("login.email.placeholder")}
                autoFocus
              />
            </Field>
            <Field id="login-password" label={t("login.password.label")}>
              <TextInput value={password} onChange={setPassword} type="password" autoComplete="current-password" />
            </Field>
            {error ? (
              <Banner tone="danger" title={t("error.title")}>
                {error}
              </Banner>
            ) : null}
            <Button variant="primary" type="submit" loading={busy} fullWidth>
              {busy ? t("action.signingIn") : t("action.signIn")}
            </Button>
          </form>
        </Card>

        <Card>
          <CardHeader title={t("login.demo.title")} subtitle={t("login.demo.subtitle")} />
          <div className="p-4">
            {showDemo ? (
              <>
                <table className="data-table">
                  <caption className="sr-only">{t("login.demo.title")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("login.demo.column.account")}</th>
                      <th scope="col">{t("login.demo.column.password")}</th>
                      <th scope="col">{t("login.demo.column.role")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DEMO_ACCOUNTS.map((account) => (
                      <tr key={account.email}>
                        <td>
                          <button
                            type="button"
                            className="font-mono text-xs text-accent hover:underline"
                            title={t("login.demo.use")}
                            onClick={() => {
                              setEmail(account.email);
                              setPassword(account.password);
                            }}
                          >
                            {account.email}
                          </button>
                          <span className="mt-0.5 block max-w-sm text-2xs text-fg-muted">{account.blurb}</span>
                        </td>
                        <td>
                          <code className="font-mono text-2xs text-fg-muted">{account.password}</code>
                        </td>
                        <td>
                          {account.assignments.map((assignment) => (
                            <Badge key={assignment.roleCode} tone="neutral" shape={false} mono>
                              {assignment.roleCode}
                            </Badge>
                          ))}
                          {account.grants.length > 0 ? <Badge tone="warn">{t("login.demo.column.role")}</Badge> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3">
                  <Banner tone="warn">{t("login.demo.warning")}</Banner>
                </div>
              </>
            ) : (
              <Banner tone="info">{t("login.demo.hidden")}</Banner>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
