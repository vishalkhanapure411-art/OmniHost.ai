import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  PageHeader,
  PermissionDenied,
  SectionHeader,
} from "~/components/ui";
import type { ImportIssue, ImportReport } from "~/domain/import";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";
import { importLandingLabel, sentenceParams } from "~/i18n/labels";
import { commitImportFn, dryRunImportFn, importScreenAccessFn } from "~/server-fns";

/**
 * The bulk-import screen (§16, §23.2).
 *
 * Three states, never collapsed: no file yet, a dry run's report, a committed report. The
 * screen holds no rule of its own — the file's text goes to the server, the server validates
 * it against the same domain functions a hand edit calls, and the screen renders the answer
 * it was handed. Wording comes from the catalog, including every row's reason, so a rejected
 * line reads in the operator's own language and names its own column.
 *
 * **And a fourth state, resolved before any of them: refused.** The loader asks the server for
 * the import capability on the same guard the dry run and the commit use, so a caller who does
 * not hold it is answered with the capability's name and never sees the picker. This screen
 * holds two writes and no read, so without that question there was nothing to fail and the
 * picker rendered for everyone — a set of controls whose every press the API refuses. Nav,
 * screen and domain now say the same thing about the same caller.
 *
 * The report is a table and not a summary because the promise of the dry run is that you can
 * see *every* row before you commit, and a count would hide the one row an operator has to
 * fix.
 */
export const Route = createFileRoute("/_shell/mdm/import")({
  staticData: { titleKey: "nav.route./mdm/import" },
  loader: async () => importScreenAccessFn(),
  component: ImportScreen,
});

function ImportScreen() {
  const { t, locale } = useI18n();
  const access = Route.useLoaderData();
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [refusal, setRefusal] = useState<{ message: string; permission: string | null } | null>(
    null
  );
  const [busy, setBusy] = useState<"dry_run" | "commit" | null>(null);

  // The server's answer about the screen itself, read the way the vendor and site masters read
  // theirs: a refusal names the capability the server refused on, in its own words, and a
  // failure that is not a refusal stays an error rather than being disguised as one.
  if (!access.ok) {
    if (access.status === 403) {
      return (
        <div className="p-4">
          <Card>
            <PermissionDenied
              title={t("mdm.import.denied.title" as MessageKey)}
              description={t("mdm.import.denied.description" as MessageKey, {
                permission: access.permission ?? "mdm.article.import",
              })}
              requiredPermission={access.permission ?? "mdm.article.import"}
            />
            <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
              {access.message}
            </p>
          </Card>
        </div>
      );
    }
    return (
      <div className="p-4">
        <ErrorState
          title={t("error.title")}
          description={t("error.description")}
          detail={access.message}
        />
      </div>
    );
  }

  const run = async (phase: "dry_run" | "commit") => {
    if (!fileName) return;
    setBusy(phase);
    setRefusal(null);
    try {
      const fn = phase === "commit" ? commitImportFn : dryRunImportFn;
      const result = await fn({ data: { entity: "article", fileName, content } });
      if (result.ok) {
        setReport(result.report);
      } else {
        setRefusal({ message: result.message, permission: result.permission ?? null });
      }
    } finally {
      setBusy(null);
    }
  };

  const issues = (list: ImportIssue[]) =>
    list.map((entry, index) => (
      <span key={`${entry.code}-${index}`} className="block text-xs text-fg-muted">
        {entry.column && entry.column !== "file"
          ? `${entry.column}: `
          : `${t("mdm.import.issue.rowLevel" as MessageKey)}: `}
        {/* A report line names a field and the state the record lands in; both are catalog
            words, not the machine names the plan evaluated (`caloriesKcal`, `pending_review`). */}
        {t(entry.code as MessageKey, sentenceParams(t, locale, entry.params))}
      </span>
    ));

  return (
    <div className="space-y-6">
      <PageHeader title={t("mdm.import.title")} description={t("mdm.import.subtitle")} />

      {refusal ? (
        <Card>
          <CardHeader title={t("mdm.import.refused.title" as MessageKey)} />
          <div className="space-y-2 p-4">
            <p className="text-sm text-fg-muted">
              {t("mdm.import.refused.body" as MessageKey, {
                permission: refusal.permission ?? "mdm.article.import",
              })}
            </p>
            <p className="font-mono text-xs text-fg-muted">{refusal.message}</p>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("mdm.import.file.label" as MessageKey)} />
        <div className="space-y-3 p-4">
          <p className="text-xs text-fg-muted">{t("mdm.import.file.hint" as MessageKey)}</p>
          <p className="text-xs text-fg-muted">{t("mdm.import.prices.hint" as MessageKey)}</p>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label={t("mdm.import.file.choose" as MessageKey)}
            className="block text-sm"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setFileName(file.name);
              setContent(await file.text());
              setReport(null);
            }}
          />
          <p className="text-sm text-fg-muted">
            {fileName ?? t("mdm.import.file.none" as MessageKey)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={!fileName || busy !== null} onClick={() => run("dry_run")}>
              {busy === "dry_run" ? t("common.loading" as MessageKey) : t("mdm.import.action.dryRun" as MessageKey)}
            </Button>
            <Button
              variant="primary"
              disabled={!fileName || busy !== null || !report || report.phase !== "dry_run"}
              onClick={() => run("commit")}
            >
              {busy === "commit" ? t("common.loading" as MessageKey) : t("mdm.import.action.commit" as MessageKey)}
            </Button>
          </div>
          <p className="text-xs text-fg-muted">{t("mdm.import.note.partial" as MessageKey)}</p>
        </div>
      </Card>

      {report ? (
        <Card>
          <CardHeader
            title={
              report.phase === "commit"
                ? t("mdm.import.report.commit.title" as MessageKey)
                : t("mdm.import.report.dryRun.title" as MessageKey)
            }
          />
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={report.status === "failed" ? "danger" : report.applied ? "ok" : "info"}>
                {report.applied
                  ? t("mdm.import.report.committed" as MessageKey)
                  : t("mdm.import.report.notCommitted" as MessageKey)}
              </Badge>
              <span className="text-fg-muted">
                {t("mdm.import.counts.seen" as MessageKey, { count: report.counts.seen })}
              </span>
              <span className="text-fg-muted">
                {t("mdm.import.counts.created" as MessageKey, { count: report.counts.created })}
              </span>
              <span className="text-fg-muted">
                {t("mdm.import.counts.updated" as MessageKey, { count: report.counts.updated })}
              </span>
              <span className="text-fg-muted">
                {t("mdm.import.counts.unchanged" as MessageKey, { count: report.counts.unchanged })}
              </span>
              <span className="text-fg-muted">
                {t("mdm.import.counts.rejected" as MessageKey, { count: report.counts.rejected })}
              </span>
              <span className="text-fg-muted">
                {t("mdm.import.counts.warned" as MessageKey, { count: report.counts.warned })}
              </span>
            </div>
            <p className="font-mono text-xs text-fg-muted">
              {t("mdm.import.report.batch" as MessageKey)}: {report.batchId}
            </p>

            {report.fileError ? (
              <p className="text-sm text-danger-fg">
                {t("mdm.import.report.refusedFile" as MessageKey)}{" "}
                {t(report.fileError.code as MessageKey, report.fileError.params)}
              </p>
            ) : null}

            {report.columnWarnings.length > 0 ? (
              <div>
                <SectionHeader title={t("mdm.import.report.columnWarnings.title" as MessageKey)} />
                <div className="space-y-1">{issues(report.columnWarnings)}</div>
              </div>
            ) : null}

            {report.rows.length === 0 ? (
              <EmptyState
                title={t("mdm.import.empty.title" as MessageKey)}
                description={t("mdm.import.report.rowsEmpty" as MessageKey)}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-start text-xs uppercase text-fg-muted">
                      <th className="p-2 text-start">{t("mdm.import.column.line" as MessageKey)}</th>
                      <th className="p-2 text-start">{t("mdm.import.column.code" as MessageKey)}</th>
                      <th className="p-2 text-start">{t("mdm.import.column.outcome" as MessageKey)}</th>
                      <th className="p-2 text-start">{t("mdm.import.column.landing" as MessageKey)}</th>
                      <th className="p-2 text-start">{t("mdm.import.column.changed" as MessageKey)}</th>
                      <th className="p-2 text-start">{t("mdm.import.column.issues" as MessageKey)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={row.lineNumber} className="border-t border-border">
                        <td className="p-2 font-mono text-xs">{row.lineNumber}</td>
                        <td className="p-2 font-mono text-xs">{row.code ?? "—"}</td>
                        <td className="p-2">
                          <Badge
                            tone={
                              row.outcome === "rejected"
                                ? "danger"
                                : row.outcome === "created"
                                  ? "ok"
                                  : row.outcome === "updated"
                                    ? "accent"
                                    : "neutral"
                            }
                          >
                            {t(`mdm.import.outcome.${row.outcome}` as MessageKey)}
                          </Badge>
                        </td>
                        <td className="p-2 text-xs">
                          {row.landing ? importLandingLabel(t, row.landing) : "—"}
                        </td>
                        <td className="p-2 text-xs">{row.changed.join(", ") || "—"}</td>
                        <td className="p-2">{issues(row.issues)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-fg-muted">
              {t("common.timezone.label" as MessageKey)} · {locale}
            </p>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
