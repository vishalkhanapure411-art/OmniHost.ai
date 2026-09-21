import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
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
 * A row opens the record at `/mdm/articles/:code`. SCOPE, stated on the screen rather than
 * only in the pull request: the record screen covers identity, selling (the audited price
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
  const filtered = articles.filter((article) => {
    if (status && article.status !== status) return false;
    if (category && article.categoryCode !== category) return false;
    if (incompleteOnly && article.complianceMissing === 0) return false;
    if (needle) {
      const haystack = `${article.code} ${article.name} ${article.categoryName}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const filteredToNothing = filtered.length === 0 && articles.length > 0;

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
            options={result.options.statuses.map((code) => ({
              value: code,
              label: t(STATUS_LABEL[code] ?? "mdm.article.status.active"),
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
          <Toggle
            checked={incompleteOnly}
            onChange={setIncompleteOnly}
            label={t("mdm.articles.filter.incomplete")}
          />
        </div>

        {filteredToNothing ? (
          <div className="p-4">
            <EmptyState
              compact
              title={t("mdm.articles.noResults.title")}
              description={t("mdm.articles.noResults.description", {
                total: String(articles.length),
              })}
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setStatus("");
                    setCategory("");
                    setIncompleteOnly(false);
                  }}
                >
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
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-start text-xs uppercase tracking-wide text-fg-muted">
                  <th className="px-3 py-2 text-start font-medium">{t("mdm.articles.column.code")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("mdm.articles.column.name")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("mdm.articles.column.category")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("mdm.articles.column.type")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("mdm.articles.column.diet")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("mdm.articles.column.taxClass")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("mdm.articles.column.status")}</th>
                  <th className="px-3 py-2 text-end font-medium">{t("mdm.articles.column.outlets")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("mdm.articles.column.compliance")}</th>
                  <th className="px-3 py-2 text-end font-medium">{t("mdm.articles.column.allergens")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((article) => (
                  <tr key={article.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        to="/mdm/articles/$articleCode"
                        params={{ articleCode: article.code }}
                        className="underline decoration-dotted underline-offset-2"
                      >
                        {article.code}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        to="/mdm/articles/$articleCode"
                        params={{ articleCode: article.code }}
                        className="block"
                      >
                        {article.name}
                      </Link>
                      {article.untranslated ? (
                        <span className="text-xs text-fg-muted">
                          {t("mdm.articles.untranslated", { locale: article.nameLocale })}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">{article.categoryName}</td>
                    <td className="px-3 py-2 text-fg-muted">
                      {t(TYPE_LABEL[article.articleType] ?? "mdm.article.type.food")}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">
                      {t(DIET_LABEL[article.dietaryMark ?? "none"] ?? "mdm.article.diet.none")}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {article.taxClassCode ?? "—"}
                      {article.taxClassJurisdiction ? (
                        <span className="ms-2 text-fg-muted">{article.taxClassJurisdiction}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {t(STATUS_LABEL[article.status] ?? "mdm.article.status.active")}
                      <span className="ms-2 text-xs text-fg-muted">v{String(article.version)}</span>
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums">{String(article.outletCount)}</td>
                    <td className="px-3 py-2">
                      {article.complianceMissing === 0 ? (
                        <span>{t("mdm.articles.compliance.ok")}</span>
                      ) : (
                        <span className="text-fg-muted">
                          {t("mdm.articles.compliance.missing", {
                            count: String(article.complianceMissing),
                          })}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums">{String(article.allergenCount)}</td>
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
      </Card>

      <Card>
        <CardHeader title={t("mdm.articles.column.compliance")} subtitle={t("mdm.articles.scope.note")} />
        <ul className="flex flex-col gap-2 p-4 text-xs text-fg-muted">
          <li>
            {t("mdm.articles.compliance.checked", {
              jurisdiction: result.jurisdiction,
              fields: result.requiredFields.join(", "),
            })}
          </li>
        </ul>
      </Card>
    </div>
  );
}
