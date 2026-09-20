import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { DensityProvider } from "~/components/density";
import { Button, Card, CardHeader, ErrorState } from "~/components/ui";
import { I18nProvider, standaloneLocalePayload, useI18n } from "~/i18n";
import { getDisplayPrefsFn } from "~/server-fns";
import appCss from "~/styles/app.css?url";

/**
 * The root route.
 *
 * It resolves display preferences **on the server** before anything paints — interface
 * locale, text direction, display timezone and row density — and publishes them through
 * two providers: `I18nProvider` for strings and formatters, `DensityProvider` for row
 * height. Both `lang` and `dir` are set on the `<html>` element from that resolution,
 * so an RTL locale is mirrored from the first paint rather than corrected after
 * hydration, and no component has to ask "which way round am I".
 *
 * The preferences live in a cookie read by the request that renders this route (see
 * `src/server/locale.ts`), which is what makes the whole thing SSR-deterministic:
 * server and client resolve the same value, so nothing mismatches on hydration.
 */
export const Route = createRootRoute({
  loader: async () => getDisplayPrefsFn(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "OmniHost.ai" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: NotFound,
  errorComponent: RootError,
  component: RootComponent,
});

function RootComponent() {
  const payload = Route.useLoaderData();
  return (
    <RootDocument locale={payload.locale} direction={payload.direction}>
      <I18nProvider payload={payload}>
        <DensityProvider initial={payload.density}>
          <Outlet />
        </DensityProvider>
      </I18nProvider>
    </RootDocument>
  );
}

function RootDocument({
  children,
  locale,
  direction,
}: {
  children: ReactNode;
  locale: string;
  direction: "ltr" | "rtl";
}) {
  return (
    <html lang={locale} dir={direction}>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/** Translated and token-styled, because a 404 is a screen like any other. */
function NotFound() {
  const { t } = useI18n();
  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
      <Card>
        <CardHeader title={t("error.notFound.title")} subtitle={t("error.notFound.description")} />
        <div className="p-4">
          <Link
            to="/"
            className="btn btn-primary"
          >
            {t("action.back")}
          </Link>
        </div>
      </Card>
    </div>
  );
}

/**
 * The boundary that renders outside the providers can still be reached (a failure in
 * the root loader itself), so this one carries its own minimal English copy rather than
 * throwing a second error by calling `t()` without a provider.
 */
function RootError({ error, reset }: { error: Error; reset: () => void }) {
  const payload = standaloneLocalePayload();
  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
      <I18nProvider payload={payload}>
        <Card>
          <ErrorState
            title="That did not load"
            description="The console could not render this route. Nothing was changed."
            detail={error.message}
            action={
              <Button variant="primary" onClick={reset}>
                Try again
              </Button>
            }
          />
        </Card>
      </I18nProvider>
    </div>
  );
}
