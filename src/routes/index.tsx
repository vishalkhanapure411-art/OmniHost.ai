import { Link, createFileRoute, redirect } from "@tanstack/react-router";

import { LanguageSwitcher } from "~/components/AppShell";
import { ArrowRight, Chat } from "~/components/icons";
import { Card, CardHeader } from "~/components/ui";
import { useI18n } from "~/i18n";
import { getSession } from "~/server-fns";

/**
 * The front door. A signed-in operator goes straight to their inbox; everyone else gets
 * the one-screen explanation of what this is and how to get in.
 */
export const Route = createFileRoute("/")({
  loader: async () => {
    const session = await getSession();
    if (session.principal) throw redirect({ to: "/approvals" });
    return { signedIn: false };
  },
  component: LandingScreen,
});

const CARDS: { titleKey: string; bodyKey: string }[] = [
  { titleKey: "landing.card.layers.title", bodyKey: "landing.card.layers.body" },
  { titleKey: "landing.card.permissions.title", bodyKey: "landing.card.permissions.body" },
  { titleKey: "landing.card.audit.title", bodyKey: "landing.card.audit.body" },
  { titleKey: "landing.card.i18n.title", bodyKey: "landing.card.i18n.body" },
];

function LandingScreen() {
  const { t } = useI18n();
  return (
    <div className="shell-content">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-10">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-2xs font-semibold tracking-wider text-fg-subtle uppercase">
              {t("landing.eyebrow", { phase: t("app.phase") })}
            </p>
            <h1 className="text-xl font-semibold text-fg">{t("landing.title")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-fg-muted">{t("landing.body")}</p>
          </div>
          <LanguageSwitcher />
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <Link to="/login" className="btn btn-primary">
            {t("landing.cta")}
            <span aria-hidden="true">
              <ArrowRight size={14} />
            </span>
          </Link>
          <span className="text-xs text-fg-muted">{t("landing.hint")}</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {CARDS.map((card) => (
            <Card key={card.titleKey} as="article">
              <CardHeader title={t(card.titleKey as never)} />
              <p className="p-4 text-xs text-fg-muted">{t(card.bodyKey as never)}</p>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader title={t("design.chat.title")} subtitle={t("pattern.chatcard.disclosure")} />
          <p className="flex items-center gap-2 p-4 text-xs text-fg-muted">
            <span className="text-accent" aria-hidden="true">
              <Chat size={16} />
            </span>
            {t("design.chat.body")}
          </p>
        </Card>

        <p className="text-2xs text-fg-subtle">{t("landing.notBuilt")}</p>
      </div>
    </div>
  );
}
