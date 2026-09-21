import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  SearchInput,
  Select,
  TableSkeleton,
  Toggle,
} from "~/components/ui";
import { TimestampValue } from "~/components/values";
import type { ArticleListItem } from "~/domain/mdm";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";
import { listArticlesFn } from "~/server-fns";
/**
 * Articles — the dense list (§7.5), the first Phase 1 screen.
 *
 * The row is the unit of work for a Master Data Head: code, name, category, the market's
 * diet mark, tax class, status, how many outlets sell it, and **whether the record is
 * complete for the markets the chain trades in**. That last column is the one the spec
 * insists on: the profile, not the person, decides what "complete" means, so a chain
 * trading in a market whose rules differ sees that difference here rather than at go-live.
 *
 * Four states, because these are the ones that break lists:
 *   * **loading** — a skeleton with the same row rhythm as the table;
 *   * **empty in scope** — a chain with no articles at all;
 *   * **filtered to nothing** — a different sentence, because the fix is different;
 *   * **refused** — the server's own message, never re-worded here.
 *
 * A row opens the record at `/mdm/articles/:code` — the whole row, because a link that
 * only covers its own text inside a wide cell reads as a dead cell to a pointer (review
 * S7). One focusable link per row is kept, so the tab order does not contain the same
 * destination twice.
 *
 * The compliance column prints what the API reports and nothing more: `not configured`
 * when the market's profile states no requirements (§17's stated state), `not checked`
 * when it requires a field this build cannot look at, and only then `Complete` or
 * `N missing` (review S2).
 *
 * SCOPE, stated on the screen rather than only in the pull request: the record screen covers identity, selling (the audited price
 * and availability writes, which are the two things this slab may change), compliance,
 * allergens, nutrition, versions and the ERP-maintained section. Maker-checker, recipe/BOM
 * and everything that *creates* a version are the next slab, so the record is read-only
 * outside those two writes. The outlet filter is also API-only for now: the list read does
 * not carry per-row outlet codes, and a filter that silently ignored itself would be worse
 * than its absence.
 */
export const Route = createFileRoute("/_shell/mdm/articles/")({
  staticData: { titleKey: "nav.route./mdm/articles" },
  loader: async () => listArticlesFn(),
  pendingComponent: ArticlesPending,
  component: ArticlesScreen,
});

const STATUS_LABEL: Record<string, MessageKey> = {
  draft: "mdm.article.status.draft",
  pending_review: "mdm.article.status.pending_review",
  active: "mdm.article.status.active",
  seasonal: "mdm.article.status.seasonal",
  discontinued: "mdm.article.status.discontinued",
};
const TYPE_LABEL: Record<string, MessageKey> = {
  food: "mdm.article.type.food",
  beverage: "mdm.article.type.beverage",
  retail: "mdm.article.type.retail",
  service: "mdm.article.type.service",
};
const DIET_LABEL: Record<string, MessageKey> = {
  veg: "mdm.article.diet.veg",
  non_veg: "mdm.article.diet.non_veg",
  egg: "mdm.article.diet.egg",
  vegan: "mdm.article.diet.vegan",
  none: "mdm.article.diet.none",
};

function ArticlesPending() {
  const { t } = useI18n();
  return (
    <div className="p-4">
      <TableSkeleton rows={10} columns={6} label={t("state.loading.title")} />
    </div>
  );
}

function ArticlesScreen() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [incompleteOnly, setIncompleteOnly] = useState(false);

  if (!result.ok) {
    return (
      <div className="p-4">
        <ErrorState
          title={t("mdm.articles.denied.title")}
          description={t("mdm.articles.denied.description")}
          detail={result.message}
        />
      </div>
    );
  }

  const articles = result.items;
  const needle = query.trim().toLowerCase();
  // What the market's profile states, as the API reports it. With no required field
  // configured there is nothing to be "complete" against, and a compliance column that
  // printed "Complete" for that said the opposite of what the record itself said (§17,
  // review S2). The cell now distinguishes the three real states.
  const profileStatesRequirements = result.requiredFields.length > 0;
  const filtered = articles.filter((article) => {
    if (status && article.status !== status) return false;
    if (category && article.categoryCode !== category) return false;
    if (incompleteOnly && article.complianceMissing === 0) return false;
    if (needle) {
      // Code, name and short name: the three the placeholder promises and the same three
      // the API's `?q=` matches (the domain searches `short_name` too).
      const haystack = `${article.code} ${article.name} ${article.shortName ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const clearFilters = () => {
    setQuery("");
    setStatus("");
    setCategory("");
    setIncompleteOnly(false);
  };

  /** Nothing to be incomplete against — the toggle is a control that cannot mean anything. */
  const incompleteFilterUnavailable = !profileStatesRequirements;

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card>
        <CardHeader title={t("mdm.articles.title")} subtitle={t("mdm.articles.subtitle")} />
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t("mdm.articles.search.placeholder")}
            label={t("mdm.articles.search.label")}
          />
          <Select
            value={status}
            onChange={setStatus}
            ariaLabel={t("mdm.articles.filter.status")}
            emptyLabel={t("mdm.articles.filter.all")}
            // Driven by what the API returns: every state of the lifecycle, in lifecycle
            // order, with how many articles are in it. A state the seed does not use is
            // now visible and empty rather than missing from the filter (review S4).
            options={result.options.statuses.map((option) => ({
              value: option.code,
              label: `${t(STATUS_LABEL[option.code] ?? "mdm.article.status.active")} (${String(option.count)})`,
            }))}
          />
          <Select
            value={category}
            onChange={setCategory}
            ariaLabel={t("mdm.articles.filter.category")}
            emptyLabel={t("mdm.articles.filter.all")}
            options={result.options.categories.map((option) => ({
              value: option.code,
              label: option.name,
            }))}
          />
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Toggle
                checked={incompleteOnly}
                onChange={setIncompleteOnly}
                disabled={incompleteFilterUnavailable}
                label={t("mdm.articles.filter.incomplete")}
              />
              <span className="text-xs text-fg">{t("mdm.articles.filter.incomplete")}</span>
            </div>
            {incompleteFilterUnavailable ? (
              <span className="max-w-prose text-2xs text-fg-subtle">
                {t("mdm.articles.filter.incompleteUnavailable", {
                  jurisdiction: result.jurisdiction,
                })}
              </span>
            ) : null}
          </div>
        </div>

        {filtered.length === 0 && articles.length > 0 ? (
          <div className="p-4">
            <EmptyState
              compact
              title={t("mdm.articles.noResults.title")}
              description={t("mdm.articles.noResults.description", {
                total: String(articles.length),
              })}
              action={
                <Button size="sm" onClick={clearFilters}>
                  {t("action.clearFilters")}
                </Button>
              }
            />
          </div>
        ) : articles.length === 0 ? (
          <div className="p-4">
            <EmptyState
              compact
              title={t("mdm.articles.empty.title")}
              description={t("mdm.articles.empty.description")}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            {/* `.data-table` carries the density contract, the sticky head and the row
                hover state, so the row behaves like every other list in the console. */}
            <table className="data-table">
              <caption className="sr-only">{t("mdm.articles.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("mdm.articles.column.code")}</th>
                  <th scope="col">{t("mdm.articles.column.name")}</th>
                  <th scope="col">{t("mdm.articles.column.category")}</th>
                  <th scope="col">{t("mdm.articles.column.type")}</th>
                  <th scope="col">{t("mdm.articles.column.diet")}</th>
                  <th scope="col">{t("mdm.articles.column.taxClass")}</th>
                  <th scope="col">{t("mdm.articles.column.status")}</th>
                  <th scope="col" className="numeric">
                    {t("mdm.articles.column.outlets")}
                  </th>
                  <th scope="col">{t("mdm.articles.column.compliance")}</th>
                  <th scope="col" className="numeric">
                    {t("mdm.articles.column.allergens")}
                  </th>
                  <th scope="col">{t("mdm.articles.column.lastChange")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((article) => (
                  <tr
                    key={article.id}
                    data-clickable="true"
                    // The whole row opens the record. The code link alone was a 25×27px
                    // target inside a wide cell, so a pointer click on the cell looked
                    // dead (review S7). One tab stop per row is kept: the link is the only
                    // focusable thing here, and this handler is only the pointer's way in.
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("a")) return;
                      if (typeof window !== "undefined" && window.getSelection()?.toString()) {
                        return;
                      }
                      void router.navigate({
                        to: "/mdm/articles/$articleCode",
                        params: { articleCode: article.code },
                      });
                    }}
                  >
                    <td className="font-mono text-xs">
                      <Link
                        to="/mdm/articles/$articleCode"
                        params={{ articleCode: article.code }}
                        // Fills the whole cell, so the pointer target matches the cell the
                        // review measured, and `whitespace-nowrap` stops `ART-1001`
                        // breaking into `ART-` / `1001` at Cozy density.
                        className="block whitespace-nowrap underline decoration-dotted underline-offset-2"
                      >
                        {article.code}
                      </Link>
                    </td>
                    <td>
                      <span className="block">{article.name}</span>
                      {article.untranslated ? (
                        <span className="text-xs text-fg-muted">
                          {t("mdm.articles.untranslated", { locale: article.nameLocale })}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-fg-muted">{article.categoryName}</td>
                    <td className="text-fg-muted">
                      {t(TYPE_LABEL[article.articleType] ?? "mdm.article.type.food")}
                    </td>
                    <td className="text-fg-muted">
                      {t(DIET_LABEL[article.dietaryMark ?? "none"] ?? "mdm.article.diet.none")}
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs">
                      {article.taxClassCode ?? "—"}
                      {article.taxClassJurisdiction ? (
                        <span className="ms-2 text-fg-muted">{article.taxClassJurisdiction}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap">
                      {t(STATUS_LABEL[article.status] ?? "mdm.article.status.active")}
                      <span className="ms-2 text-xs text-fg-muted">v{String(article.version)}</span>
                    </td>
                    <td className="numeric">{String(article.outletCount)}</td>
                    <td>
                      <ComplianceCell
                        article={article}
                        profileStatesRequirements={profileStatesRequirements}
                      />
                    </td>
                    <td className="numeric">{String(article.allergenCount)}</td>
                    <td className="whitespace-nowrap text-fg-muted">
                      <TimestampValue value={article.lastChange} mode="dateTime" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
          {t("mdm.articles.count", {
            shown: String(filtered.length),
            total: String(result.total),
          })}
        </p>
        {result.hasMore ? (
          <p className="border-t border-border px-4 py-2 text-xs text-warn">
            {t("mdm.articles.truncated", {
              shown: String(articles.length),
              total: String(result.total),
            })}
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader title={t("mdm.articles.column.compliance")} subtitle={t("mdm.articles.scope.note")} />
        <ul className="flex flex-col gap-2 p-4 text-xs text-fg-muted">
          <li>
            {profileStatesRequirements
              ? t("mdm.articles.compliance.checked", {
                  jurisdiction: result.jurisdiction,
                  fields: result.requiredFields.join(", "),
                })
              : t("mdm.articles.compliance.noneConfigured", { jurisdiction: result.jurisdiction })}
          </li>
          <li>{t("mdm.articles.openRecord")}</li>
        </ul>
      </Card>
    </div>
  );
}

/**
 * The compliance cell: what the API actually reports, and nothing more.
 *
 * Three states, one of which used to be mislabelled as "Complete": a market whose profile
 * states no requirements produces `complianceChecked: 0` with `complianceMissing: 0` for
 * every row, which is "not configured", not "met" (§17: a stated state, not a silent
 * pass). A profile that requires a field this build has no check for is "not checked"
 * rather than assumed satisfied.
 */
function ComplianceCell({
  article,
  profileStatesRequirements,
}: {
  article: ArticleListItem;
  profileStatesRequirements: boolean;
}) {
  const { t } = useI18n();
  if (!profileStatesRequirements) {
    return (
      <span title={t("mdm.articles.compliance.notConfiguredTitle")}>
        <Badge tone="neutral" shape={false}>
          {t("mdm.articles.compliance.notConfigured")}
        </Badge>
      </span>
    );
  }
  if (article.complianceChecked === 0) {
    return (
      <span title={t("mdm.articles.compliance.uncheckedTitle")}>
        <Badge tone="neutral" shape={false}>
          {t("mdm.articles.compliance.unchecked")}
        </Badge>
      </span>
    );
  }
  if (article.complianceMissing === 0) {
    return <Badge tone="ok">{t("mdm.articles.compliance.ok")}</Badge>;
  }
  return (
    <Badge tone="warn">
      {t("mdm.articles.compliance.missing", { count: String(article.complianceMissing) })}
    </Badge>
  );
}
