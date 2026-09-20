import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { ApprovalQueueSample, type ApprovalRowView } from "~/components/ApprovalQueue";
import { ChatCardSample } from "~/components/ChatCard";
import { DataTable, type Column } from "~/components/DataTable";
import { DensitySwitch, densityClassFor, useDensity } from "~/components/density";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  ConfirmSummary,
  DescriptionList,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  PermissionDenied,
  SearchInput,
  SegmentedControl,
  Select,
  TableSkeleton,
  TextInput,
  Textarea,
  Toggle,
  ValidationSummary,
} from "~/components/ui";
import {
  ApprovalStateBadge,
  CategoryBadge,
  ChainStatusBadge,
  OutcomeBadge,
  SeverityBadge,
  SourceBadge,
  TierBadge,
} from "~/components/status";
import { MoneyCell, MoneyValue, QuantityValue, TimestampValue } from "~/components/values";
import { AlertTriangle, Chat, Check, Globe, InfoCircle, Layers, Lock, Store, XCircle } from "~/components/icons";
import { LOCALES, catalogCoverage } from "~/i18n/locales";
import { useI18n } from "~/i18n";
import type { Money } from "~/i18n/format";

/**
 * The design system gallery — an internal reference page, not a tenant screen.
 *
 * It exists for two reasons. First, it is the contract: the engineer building the next
 * module (MDM, Culinary, Purchase) can see every component in every state and copy the
 * call rather than guess it. Second, it is the review surface: tokens, density, the
 * locale-resolution order and the RTL layout can all be inspected here without a chain
 * of navigation.
 *
 * It carries **no tenant data** — every row below is a hand-written sample. Nothing here
 * calls a domain API, and nothing here is a screen the owner's users will see.
 */
export const Route = createFileRoute("/_shell/design")({
  staticData: { titleKey: "nav.route./design" },
  component: DesignGallery,
});

function DesignGallery() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader eyebrow={t("design.eyebrow")} title={t("design.title")} description={t("design.description")} />
      <div className="flex flex-col gap-4 p-4">
        <LocaleSection />
        <TokenSection />
        <TypographySection />
        <DensitySection />
        <BadgeSection />
        <TableSection />
        <FormSection />
        <DialogSection />
        <FeedbackSection />
        <MoneySection />
        <ChatSection />
        <PatternSection />
      </div>
    </>
  );
}

function Section({
  title,
  body,
  children,
  id,
}: {
  title: string;
  body?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <Card as="section">
      <CardHeader id={id} title={title} subtitle={body} />
      <div className="flex flex-col gap-3 p-4">{children}</div>
    </Card>
  );
}

// ── Localisation ───────────────────────────────────────────────────────────────

function LocaleSection() {
  const { t, locale, direction, timeZone, timeZoneSource, source, coverage, hints } = useI18n();
  const hops: { key: string; label: string; value: string | null; winner: boolean }[] = [
    {
      key: "user",
      label: t("design.i18n.hop.user"),
      value: hints.userPreference,
      winner: source === "user",
    },
    { key: "site", label: t("design.i18n.hop.site"), value: hints.siteDefault, winner: source === "site" },
    { key: "chain", label: t("design.i18n.hop.chain"), value: hints.chainDefault, winner: source === "chain" },
    {
      key: "platform",
      label: t("design.i18n.hop.platform"),
      value: hints.platformDefault,
      winner: source === "platform",
    },
  ];

  return (
    <Section title={t("design.i18n.title")} body={t("design.i18n.body")} id="locale">
      <table className="data-table">
        <caption className="sr-only">{t("design.i18n.title")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("design.i18n.hop.user")}</th>
            <th scope="col">{t("common.language.label")}</th>
            <th scope="col">{t("common.language.coverage", { translated: "", total: "" })}</th>
          </tr>
        </thead>
        <tbody>
          {hops.map((hop) => (
            <tr key={hop.key} data-selected={hop.winner ? "true" : "false"}>
              <td>{hop.label}</td>
              <td className="font-mono text-xs">{hop.value ?? t("design.i18n.hop.notSet")}</td>
              <td>
                {hop.winner ? <Badge tone="ok">{t("design.i18n.hop.winner")}</Badge> : <span className="text-fg-subtle">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center gap-2">
        <DensitySwitch />
        <Badge tone="neutral">{direction === "rtl" ? t("design.i18n.rtl") : t("design.i18n.ltr")}</Badge>
        <Badge tone="neutral">
          {timeZone} · {t("common.timezone.label")} · {timeZoneSource}
        </Badge>
        <Badge tone={locale.startsWith("en") && coverage.percent === 100 ? "ok" : "warn"}>
          {t("common.language.coverage", { translated: coverage.translated, total: coverage.total })}
        </Badge>
      </div>

      <DescriptionList
        columns={2}
        items={[
          {
            label: t("common.language.label"),
            value: (
              <span className="flex items-center gap-1.5">
                <Globe size={13} />
                {LOCALES.map((definition) => definition.label === locale ? definition.englishLabel : null)}
                <code className="font-mono text-xs">{locale}</code>
              </span>
            ),
          },
          {
            label: t("shell.direction"),
            value: direction === "rtl" ? t("shell.direction.rtl") : t("shell.direction.ltr"),
          },
        ]}
      />

      <div className="flex flex-col gap-1 text-xs text-fg-muted">
        <p>{t("design.i18n.rtlBody")}</p>
        <p>{t("design.i18n.expansion")}</p>
      </div>

      <table className="data-table">
        <caption className="sr-only">{t("common.language.label")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("common.language.label")}</th>
            <th scope="col">{t("shell.direction")}</th>
            <th scope="col" className="numeric">
              {t("common.language.coverage", { translated: "", total: "" })}
            </th>
          </tr>
        </thead>
        <tbody>
          {LOCALES.map((definition) => {
            const itemCoverage = catalogCoverage(definition.catalog);
            return (
              <tr key={definition.code} data-selected={definition.code === locale ? "true" : "false"}>
                <td>
                  <span className="block text-fg">{definition.label}</span>
                  <span className="block text-2xs text-fg-subtle">{definition.englishLabel}</span>
                </td>
                <td>
                  <Badge tone={definition.direction === "rtl" ? "accent" : "neutral"} shape={false}>
                    {definition.direction}
                  </Badge>
                  {definition.pseudo ? <Badge tone="warn">{t("common.language.preview")}</Badge> : null}
                </td>
                <td className="numeric">
                  <MoneyValueFreeNumber value={itemCoverage.percent} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

/** Percent as a bare number, using the formatter so it follows the locale's digits. */
function MoneyValueFreeNumber({ value }: { value: number }) {
  const { format } = useI18n();
  return <span className="num">{format.integer(value)}%</span>;
}

// ── Tokens ─────────────────────────────────────────────────────────────────────

const SWATCHES: { token: string; note: string }[] = [
  { token: "--color-canvas", note: "page background" },
  { token: "--color-surface", note: "cards, tables" },
  { token: "--color-surface-muted", note: "row hover" },
  { token: "--color-surface-sunken", note: "wells, skeletons" },
  { token: "--color-border", note: "dividers" },
  { token: "--color-border-strong", note: "control outlines" },
];

const STATUS_SWATCHES = ["accent", "ok", "warn", "danger", "info"];

function TokenSection() {
  const { t } = useI18n();
  return (
    <Section title={t("design.tokens.title")} body={t("design.tokens.body")} id="tokens">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {SWATCHES.map((swatch) => (
          <div key={swatch.token} className="flex items-center gap-2 rounded-md border border-border p-2">
            <span className="h-8 w-8 shrink-0 rounded-md border border-border" style={{ background: `var(${swatch.token})` }} />
            <span className="min-w-0">
              <code className="block truncate font-mono text-2xs text-fg">{swatch.token}</code>
              <span className="block text-2xs text-fg-subtle">{swatch.note}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {[
          { label: "elevation / shadow-card", className: "shadow-card" },
          { label: "elevation / shadow-pop", className: "shadow-pop" },
          { label: "elevation / shadow-dialog", className: "shadow-dialog" },
        ].map((item) => (
          <div key={item.label} className={`rounded-lg border border-border bg-surface p-3 text-2xs text-fg-muted ${item.className}`}>
            <code className="font-mono">{item.label}</code>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {["silver", "gold", "platinum"].map((tier) => (
          <TierBadge key={tier} tier={tier as "silver" | "gold" | "platinum"} />
        ))}
        {STATUS_SWATCHES.map((tone) => (
          <Badge key={tone} tone={tone as "accent" | "ok" | "warn" | "danger" | "info"}>
            {tone}
          </Badge>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-2xs text-fg-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-4 w-4 rounded-sm border border-border-strong" style={{ borderRadius: "var(--radius-sm)" }} />
          radius-sm
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-4 w-4 border border-border-strong" style={{ borderRadius: "var(--radius-md)" }} />
          radius-md
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-4 w-4 border border-border-strong" style={{ borderRadius: "var(--radius-lg)" }} />
          radius-lg
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-4 w-4 bg-accent-soft outline outline-2 outline-accent" />
          focus ring · width 2px, offset 1px
        </span>
      </div>
    </Section>
  );
}

function TypographySection() {
  const { t, format } = useI18n();
  return (
    <Section title={t("design.typography.title")} body={t("design.typography.body")} id="typography">
      <div className="flex flex-col gap-1">
        <p className="text-xl font-semibold text-fg">text-xl · 22px · page title</p>
        <p className="text-lg font-semibold text-fg">text-lg · 17px · dialog title</p>
        <p className="text-base text-fg">text-base · 14px · body copy in the console</p>
        <p className="text-sm text-fg">text-sm · 13px · table cell, control, nav</p>
        <p className="text-xs text-fg-muted">text-xs · 12px · hint, validation, meta</p>
        <p className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">text-2xs · 11px · column header</p>
      </div>
      <table className="data-table">
        <caption className="sr-only">{t("design.typography.title")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("pattern.ledger.column.item")}</th>
            <th scope="col" className="numeric">
              {t("pattern.ledger.column.bookQty")}
            </th>
            <th scope="col" className="numeric">
              {t("pattern.ledger.column.value")}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>tabular-nums off</td>
            <td className="numeric" style={{ fontVariantNumeric: "normal" }}>
              1,111.11
            </td>
            <td className="numeric" style={{ fontVariantNumeric: "normal" }}>
              9,999.99
            </td>
          </tr>
          <tr>
            <td>tabular-nums on (.num)</td>
            <td className="numeric">{format.decimal(1111.11)}</td>
            <td className="numeric">{format.decimal(9999.99)}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-2xs text-fg-subtle">
        {t("design.typography.body")} · {format.dateTime(new Date())}
      </p>
    </Section>
  );
}

// ── Density ────────────────────────────────────────────────────────────────────

const DENSITY_SAMPLE = ["INV-1042", "INV-1043", "INV-1044"];

function DensitySection() {
  const { t } = useI18n();
  const { density } = useDensity();
  return (
    <Section title={t("design.density.title")} body={t("design.density.body")} id="density">
      <div className="flex flex-wrap items-center gap-2">
        <DensitySwitch />
        <span className="text-2xs text-fg-subtle">
          active: <code className="font-mono">{density}</code>
        </span>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {(["compact", "cozy", "roomy"] as const).map((preset) => (
          <div key={preset} className={`rounded-md border border-border ${densityClassFor(preset)}`}>
            <p className="border-b border-border px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
              {preset}
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t("pattern.ledger.column.item")}</th>
                  <th scope="col" className="numeric">
                    {t("pattern.ledger.column.value")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {DENSITY_SAMPLE.map((row) => (
                  <tr key={row}>
                    <td>{row}</td>
                    <td className="numeric">12,400.00</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Badges ─────────────────────────────────────────────────────────────────────

function BadgeSection() {
  const { t } = useI18n();
  return (
    <Section title={t("design.badges.title")} body={t("design.badges.body")} id="badges">
      <div className="flex flex-wrap items-center gap-2">
        <TierBadge tier="silver" />
        <TierBadge tier="gold" />
        <TierBadge tier="platinum" />
        <ChainStatusBadge status="active" />
        <ChainStatusBadge status="suspended" />
        <ChainStatusBadge status="pending" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity="low" />
        <SeverityBadge severity="medium" />
        <SeverityBadge severity="high" />
        <SeverityBadge severity="critical" />
        <OutcomeBadge outcome="success" />
        <OutcomeBadge outcome="denied" />
        <OutcomeBadge outcome="error" />
        <ApprovalStateBadge state="open" />
        <ApprovalStateBadge state="in_review" />
        <ApprovalStateBadge state="closed" />
        <ApprovalStateBadge state="overdue" />
        <SourceBadge source="screen" />
        <SourceBadge source="chatbot" />
        <SourceBadge source="api" />
        <CategoryBadge category="purchase" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span className="flex items-center gap-1">
          <Check size={13} /> success
        </span>
        <span className="flex items-center gap-1">
          <AlertTriangle size={13} /> warning
        </span>
        <span className="flex items-center gap-1">
          <XCircle size={13} /> refused
        </span>
        <span className="flex items-center gap-1">
          <InfoCircle size={13} /> information
        </span>
        <span className="flex items-center gap-1">
          <Lock size={13} /> restricted
        </span>
        <span className="flex items-center gap-1">
          <Store size={13} /> site
        </span>
        <span className="flex items-center gap-1">
          <Layers size={13} /> chain
        </span>
      </div>
    </Section>
  );
}

// ── Table ──────────────────────────────────────────────────────────────────────

interface LedgerRow {
  id: string;
  item: string;
  uom: string;
  book: number;
  counted: number;
  value: Money;
}

const LEDGER: LedgerRow[] = [
  { id: "1", item: "Tomato", uom: "kg", book: 120, counted: 114.5, value: { amount: -2310, currency: "INR" } },
  { id: "2", item: "Paneer", uom: "kg", book: 40, counted: 40, value: { amount: 0, currency: "INR" } },
  { id: "3", item: "Basmati rice", uom: "kg", book: 250, counted: 262.75, value: { amount: 5740.5, currency: "INR" } },
  { id: "4", item: "Cooking oil", uom: "L", book: 90, counted: 84, value: { amount: -4560, currency: "INR" } },
];

function TableSection() {
  const { t } = useI18n();
  const columns: Column<LedgerRow>[] = [
    { key: "item", header: t("pattern.ledger.column.item"), sortValue: (row) => row.item, render: (row) => row.item },
    {
      key: "book",
      header: t("pattern.ledger.column.bookQty"),
      numeric: true,
      sortValue: (row) => row.book,
      render: (row) => <QuantityValue value={row.book} uom={row.uom} />,
    },
    {
      key: "counted",
      header: t("pattern.ledger.column.countQty"),
      numeric: true,
      sortValue: (row) => row.counted,
      render: (row) => <QuantityValue value={row.counted} uom={row.uom} />,
    },
    {
      key: "variance",
      header: t("pattern.ledger.column.variance"),
      numeric: true,
      sortValue: (row) => row.counted - row.book,
      render: (row) => {
        const variance = row.counted - row.book;
        return (
          <span className="inline-flex items-center justify-end gap-1">
            <QuantityValue value={variance} uom={row.uom} />
            {variance === 0 ? <Badge tone="neutral">0</Badge> : variance > 0 ? <Badge tone="ok">+</Badge> : <Badge tone="danger">−</Badge>}
          </span>
        );
      },
    },
    {
      key: "value",
      header: t("pattern.ledger.column.value"),
      numeric: true,
      sortValue: (row) => row.value.amount,
      render: (row) => (
        <MoneyCell money={row.value} signed tone={row.value.amount === 0 ? "default" : row.value.amount > 0 ? "ok" : "danger"} />
      ),
    },
  ];

  return (
    <Section title={t("design.tables.title")} body={t("design.tables.body")} id="tables">
      <div className="rounded-md border border-border">
        <DataTable<LedgerRow>
          caption={t("design.tables.title")}
          columns={columns}
          rows={LEDGER}
          getRowId={(row) => row.id}
          defaultSortKey="variance"
          defaultSortDirection="asc"
          footer={<span>{t("pattern.ledger.body")}</span>}
        />
      </div>
    </Section>
  );
}

// ── Forms ──────────────────────────────────────────────────────────────────────

function FormSection() {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"self" | "franchise">("self");
  const [flag, setFlag] = useState(true);
  const [query, setQuery] = useState("");
  const [attempted, setAttempted] = useState(false);

  const error = !name.trim()
    ? t("validation.required", { field: t("chains.onboard.name.label") })
    : name.trim().length < 3
      ? t("validation.tooShort", { field: t("chains.onboard.name.label"), min: 3 })
      : null;

  return (
    <Section title={t("design.forms.title")} body={t("design.forms.body")} id="forms">
      {attempted && error ? (
        <ValidationSummary id="gallery-summary" title={t("validation.summary.one")} items={[error]} />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="gallery-name" label={t("chains.onboard.name.label")} error={attempted ? error : null} hint={t("chains.onboard.name.hint")} required>
          <TextInput value={name} onChange={setName} placeholder={t("chains.onboard.name.placeholder")} />
        </Field>
        <Field id="gallery-code" label={t("chains.onboard.code.label")} hint={t("chains.onboard.code.hint")} aside={t("common.optional")}>
          <TextInput value="" onChange={() => undefined} placeholder={t("chains.onboard.code.placeholder")} />
        </Field>
        <Field id="gallery-mode" label={t("chains.onboard.section.identity")}>
          <Select<"self" | "franchise">
            id="gallery-mode"
            ariaLabel={t("chains.onboard.section.identity")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "self", label: t("chains.status.active") },
              { value: "franchise", label: t("chains.status.pending") },
            ]}
          />
        </Field>
        <Field id="gallery-locked" label={t("chains.column.tier")} aside={t("common.readOnly")}>
          <TextInput value="platinum" onChange={() => undefined} disabled />
        </Field>
      </div>
      <Field id="gallery-notes" label={t("pattern.multiline.title")} hint={t("common.optional")}>
        <Textarea value={notes} onChange={setNotes} placeholder={t("pattern.multiline.body")} />
      </Field>
      <div className="flex flex-wrap items-center gap-4">
        <SegmentedControl<"self" | "franchise">
          ariaLabel={t("chains.onboard.section.identity")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "self", label: t("chains.status.active") },
            { value: "franchise", label: t("chains.status.pending") },
          ]}
        />
        <span className="flex items-center gap-2 text-xs text-fg-muted">
          <Toggle label={t("chains.detail.features.alwaysOn")} checked={flag} onChange={setFlag} />
          {t("chains.detail.features.alwaysOn")}
        </span>
      </div>
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={t("audit.filter.search.placeholder")}
        label={t("action.search")}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          aria-describedby={attempted && error ? "gallery-summary" : undefined}
          onClick={() => {
            setAttempted(true);
          }}
        >
          {t("action.confirm")}
        </Button>
        <Button variant="secondary">{t("action.cancel")}</Button>
        <Button variant="ghost">{t("action.dismiss")}</Button>
        <Button variant="danger">{t("action.apply")}</Button>
        <Button variant="primary" loading>
          {t("action.save")}
        </Button>
      </div>
    </Section>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────────

function DialogSection() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [committed, setCommitted] = useState(false);
  return (
    <Section title={t("design.dialogs.title")} body={t("design.dialogs.body")} id="dialogs">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => { setOpen(true); }}>
          {t("action.confirm")}
        </Button>
        {committed ? <Badge tone="ok">{t("audit.outcome.success")}</Badge> : null}
      </div>
      <Dialog
        open={open}
        onClose={() => { setOpen(false); }}
        title={t("chains.detail.tier.confirmTitle", { tier: t("chains.tier.platinum") })}
        description={t("chains.detail.tier.confirmBody", { tier: t("chains.tier.platinum") })}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setOpen(false); }}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setCommitted(true);
                setOpen(false);
              }}
            >
              {t("chains.detail.tier.confirmCta")}
            </Button>
          </>
        }
      >
        <ConfirmSummary
          items={[
            { label: t("chains.column.tier"), value: <TierBadge tier="gold" /> },
            { label: t("chains.detail.features.column.minTier"), value: <TierBadge tier="platinum" /> },
          ]}
        />
      </Dialog>
    </Section>
  );
}

// ── Feedback states ────────────────────────────────────────────────────────────

function FeedbackSection() {
  const { t } = useI18n();
  return (
    <Section title={t("design.feedback.title")} body={t("design.feedback.body")} id="feedback">
      <div className="flex flex-col gap-2">
        <Banner tone="info" title={t("audit.eyebrow")}>
          {t("shell.grants.description")}
        </Banner>
        <Banner tone="warn" title={t("shell.grants.title.one")}>
          {t("shell.grants.line", { reason: "Support ticket #1042", by: "AppAdmin", when: "" })}
        </Banner>
        <Banner tone="ok" title={t("audit.outcome.success")}>
          {t("chains.onboard.success", { name: "Saffron Table", tier: t("chains.tier.gold") })}
        </Banner>
        <Banner tone="danger" title={t("error.title")}>
          {t("error.description")}
        </Banner>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-border">
          <p className="border-b border-border px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
            {t("state.loading.title")}
          </p>
          <TableSkeleton rows={4} columns={3} label={t("state.loading.title")} />
        </div>
        <div className="rounded-md border border-border">
          <EmptyState icon={<Store size={20} />} title={t("approvals.empty.title")} description={t("approvals.empty.description")} />
        </div>
        <div className="rounded-md border border-border">
          <ErrorState
            title={t("error.title")}
            description={t("error.description")}
            detail={'chain code "saffron-table" is already taken'}
            action={<Button variant="secondary">{t("action.retry")}</Button>}
          />
        </div>
        <div className="rounded-md border border-border">
          <PermissionDenied
            title={t("error.forbidden.title")}
            description={t("chains.onboard.denied.description")}
            requiredPermission="chain.onboard"
          />
        </div>
      </div>
    </Section>
  );
}

// ── Money ──────────────────────────────────────────────────────────────────────

const AMOUNTS: { label: string; money: Money }[] = [
  { label: "India · GST chain", money: { amount: 1234567.5, currency: "INR" } },
  { label: "UAE · VAT chain", money: { amount: 84320.25, currency: "AED" } },
  { label: "Germany · VAT chain", money: { amount: 128400.4, currency: "EUR" } },
  { label: "United Kingdom", money: { amount: 98765.43, currency: "GBP" } },
  { label: "United States", money: { amount: 45210, currency: "USD" } },
  { label: "Credit note", money: { amount: -2310.75, currency: "INR" } },
];

function MoneySection() {
  const { t } = useI18n();
  return (
    <Section title={t("design.money.title")} body={t("design.money.body")} id="money">
      <table className="data-table">
        <caption className="sr-only">{t("design.money.title")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("pattern.ledger.column.item")}</th>
            <th scope="col" className="numeric">
              {t("pattern.ledger.column.value")}
            </th>
            <th scope="col">{t("audit.column.entity")}</th>
          </tr>
        </thead>
        <tbody>
          {AMOUNTS.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="numeric">
                <MoneyCell money={row.money} signed tone={row.money.amount < 0 ? "danger" : "default"} />
              </td>
              <td className="text-fg-muted">
                <code className="font-mono text-2xs">{row.money.currency}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-fg-muted">
        {t("a11y.moneyAmount", { amount: "1,234.50", currency: "INR" })} — {t("a11y.decimalsHint")}
      </p>
    </Section>
  );
}

// ── Chatbot ────────────────────────────────────────────────────────────────────

function ChatSection() {
  const { t, format } = useI18n();
  const due = new Date(Date.now() + 86400000 * 2).toISOString();
  return (
    <Section title={t("design.chat.title")} body={t("design.chat.body")} id="chat">
      <div className="flex flex-col gap-3">
        <ChatCardSample dateLabel={format.date(due)} />
        <div className="flex items-start gap-2 text-xs text-fg-muted">
          <span className="text-accent" aria-hidden="true">
            <Chat size={14} />
          </span>
          {t("pattern.chatcard.committed")}
        </div>
        <TimestampValue value={due} mode="weekday" className="text-xs text-fg-muted" />
      </div>
    </Section>
  );
}

// ── Patterns ───────────────────────────────────────────────────────────────────

const SAMPLE_APPROVALS: ApprovalRowView[] = [
  {
    id: "sample-1",
    title: "Stock receipt GRN-2044 for 12 lines",
    summary: "Received against PO-2044. Two lines short-delivered; the store team flagged the variance.",
    chainName: "Saffron Table",
    siteName: "Koramangala",
    category: "store",
    severity: "high",
    state: "open",
    dueAt: new Date(Date.now() + 3600 * 1000 * 6).toISOString(),
    raisedBy: "Store Team",
    raisedByRole: "SITE_STORE_TEAM",
    assignedRole: "SITE_REVENUE_ASSURANCE_TEAM",
    value: { amount: 184320.5, currency: "INR" },
  },
  {
    id: "sample-2",
    title: "Waste write-off: 4.5 kg paneer",
    summary: "Chiller failure overnight. Photograph attached by the closing shift.",
    chainName: "Saffron Table",
    siteName: "Indiranagar",
    category: "culinary",
    severity: "medium",
    state: "open",
    dueAt: new Date(Date.now() - 3600 * 1000 * 3).toISOString(),
    raisedBy: "Culinary Team",
    raisedByRole: "SITE_CULINARY_TEAM",
    assignedRole: "SITE_HEAD",
    value: { amount: 2340, currency: "INR" },
  },
  {
    id: "sample-3",
    title: "Purchase order PO-2110 above threshold",
    summary: null,
    chainName: "Coastal Catch",
    siteName: null,
    category: "purchase",
    severity: "low",
    state: "in_review",
    dueAt: null,
    raisedBy: "Purchase Team",
    raisedByRole: "CENTRAL_PURCHASE_TEAM",
    assignedRole: "CENTRAL_PURCHASE_HEAD",
    value: { amount: 96450, currency: "INR" },
  },
];

const MULTILINE_ROWS = [
  { id: "m1", item: "Tomato", qty: 20, uom: "kg", rate: { amount: 42.5, currency: "INR" } },
  { id: "m2", item: "Paneer", qty: 8, uom: "kg", rate: { amount: 380, currency: "INR" } },
  { id: "m3", item: "Basmati rice", qty: 25, uom: "kg", rate: { amount: 96, currency: "INR" } },
];

function PatternSection() {
  const { t } = useI18n();
  const total = MULTILINE_ROWS.reduce((sum, row) => sum + row.qty * row.rate.amount, 0);
  return (
    <>
      <Section title={t("pattern.masterdata.title")} body={t("pattern.masterdata.body")} id="pattern-masterdata">
        <DescriptionList
          columns={3}
          items={[
            { label: t("a11y.masterPane"), value: t("action.search") + " · " + t("common.filter") },
            { label: t("a11y.detailPane"), value: t("chains.detail.eyebrow") },
            { label: "URL", value: <code className="font-mono text-xs">/chains/&lt;id&gt;</code> },
          ]}
        />
      </Section>

      <Section title={t("pattern.approval.title")} body={t("pattern.approval.body")} id="pattern-approvals">
        <ApprovalQueueSample items={SAMPLE_APPROVALS} />
      </Section>

      <Section title={t("pattern.multiline.title")} body={t("pattern.multiline.body")} id="pattern-multiline">
        <table className="data-table">
          <caption className="sr-only">{t("pattern.multiline.title")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("pattern.ledger.column.item")}</th>
              <th scope="col" className="numeric">
                {t("pattern.ledger.column.countQty")}
              </th>
              <th scope="col">UOM</th>
              <th scope="col" className="numeric">
                {t("design.money.title")}
              </th>
              <th scope="col" className="numeric">
                {t("pattern.ledger.column.value")}
              </th>
            </tr>
          </thead>
          <tbody>
            {MULTILINE_ROWS.map((row) => (
              <tr key={row.id}>
                <td>{row.item}</td>
                <td className="numeric">
                  <QuantityValue value={row.qty} uom={row.uom} />
                </td>
                <td>
                  <code className="font-mono text-2xs text-fg-muted">{row.uom}</code>
                </td>
                <td className="numeric">
                  <MoneyValue money={row.rate} showCode={false} />
                </td>
                <td className="numeric">
                  <MoneyValue money={{ amount: row.qty * row.rate.amount, currency: row.rate.currency }} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="text-end text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
                {t("pattern.ledger.total")}
              </td>
              <td className="numeric font-semibold">
                <MoneyValue money={{ amount: total, currency: "INR" }} />
              </td>
            </tr>
          </tfoot>
        </table>
      </Section>
    </>
  );
}
