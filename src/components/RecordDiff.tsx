import { useState, type ReactNode } from "react";

import { Badge, Banner, Button, ErrorState, TableSkeleton, type BadgeTone } from "~/components/ui";
import { MoneyValue, QuantityValue, TimestampValue } from "~/components/values";
import type {
  ArticleVersionReview,
  DiffGroup,
  DiffKind,
  DiffRow,
  DiffValue,
  RequiredArticleFieldRef,
} from "~/domain/mdm-approvals";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";
import {
  allergenLabel,
  allergenSourceLabel,
  basisLabel,
  channelLabel,
  containmentLabel,
  dietLabel,
  nutrientLabel,
} from "~/i18n/domain-labels";
import { complianceFieldLabel, marketName } from "~/i18n/labels";

/**
 * `RecordDiff` — what a maker-checker decision actually changes.
 *
 * The pattern document names this component (`pattern-spec.md:204`, `:444`, `:537`) and it
 * did not exist. It exists now, in the shape that document asks for: **the changed fields
 * only, the field, the two values, and the jurisdiction rule that made it matter**
 * (`phase-1-mdm-spec.md:249`, `pattern-spec.md:443-446`).
 *
 * **It is not `BeforeAfter` and it shares no code with it (D8).** `BeforeAfter`
 * (`~/components/values`) renders the audit ledger: two JSON strings side by side, raw
 * database column names, `String(value)` for every cell, and the unchanged rows kept on
 * purpose because in a ledger their absence would be its own claim. An approver is not
 * auditing, an approver is deciding, and the ledger's rendering would hand them forty rows
 * that say "same" around the two that matter. That component's own defects are queued as
 * their own pass and are not touched here.
 *
 * **Presentational, and fed only typed values.** It fetches nothing, parses nothing and
 * composes no sentence's *data*: the rows arrive ordered and typed from
 * `getArticleVersionReview` (D6/D9), the money delta is computed in the domain in exact
 * decimal arithmetic (D12), and this file's whole job is to turn identifiers into words
 * through explicit maps and the console's typed value components. That is what keeps
 * DECISIONS rules 1–5 true by construction rather than by review.
 *
 * **Five change kinds, never colour alone (D15).** Every row carries a visible text badge,
 * an `sr-only` word after the changed value, and a tint as reinforcement only. The tint is
 * never the signal — a reader who cannot see it still gets the word twice.
 *
 * Three things it deliberately does **not** do: it does not show a status row (status is
 * lifecycle, not content — D19); it does not show unchanged fields until asked, because the
 * clone copies almost every field and a changed one hides well among forty identical ones
 * (D3); and it does not render an empty comparison as "no change" when the read failed —
 * "we could not compare" and "we compared and found nothing" are different sentences (§4
 * S3 vs S5).
 */

// ── The explicit maps. A code with no entry falls back to the code itself. ──────

/** A diff field's own name, in the vocabulary the domain already uses. */
const FIELD_LABEL: Record<DiffRow["field"], MessageKey> = {
  name: "mdm.article.field.name",
  shortName: "mdm.article.field.shortName",
  description: "mdm.article.field.description",
  ingredientDeclaration: "mdm.article.compliance.field.ingredientDeclaration",
  dietaryMark: "mdm.article.field.diet",
  taxClass: "mdm.article.field.taxClass",
  hsnSacCode: "mdm.article.field.hsnSac",
  servingSize: "mdm.article.field.servingSize",
  caloriesKcal: "mdm.article.field.calories",
  channels: "mdm.article.field.channels",
  effectiveFrom: "mdm.article.field.effectiveFrom",
  currency: "mdm.article.field.currency",
  allergen: "mdm.article.compliance.field.allergens",
  nutrient: "mdm.article.compliance.field.nutrition",
  price: "mdm.article.field.price",
  jurisdiction: "mdm.article.field.taxJurisdiction",
};

/**
 * The five kinds, one word each — enumerated, never `t(\`…kind.${kind}\`)` (DECISIONS
 * rule 2). `absent` reads "Missing", the same word the blockers banner above already uses,
 * so the banner and the row cannot read as two different verdicts (D14).
 */
const KIND_LABEL: Record<DiffKind, MessageKey> = {
  changed: "approval.diff.kind.changed",
  added: "approval.diff.kind.added",
  removed: "approval.diff.kind.removed",
  absent: "approval.diff.kind.absent",
  unchanged: "approval.diff.kind.unchanged",
};

/** The same five words for assistive tech, where `absent` must also say *why*. */
const KIND_A11Y_LABEL: Record<DiffKind, MessageKey> = {
  changed: "approval.diff.a11y.changed",
  added: "approval.diff.a11y.added",
  removed: "approval.diff.a11y.removed",
  absent: "approval.diff.a11y.absent",
  unchanged: "approval.diff.kind.unchanged",
};

const KIND_TONE: Record<DiffKind, BadgeTone> = {
  changed: "warn",
  added: "info",
  removed: "danger",
  absent: "danger",
  unchanged: "neutral",
};

/** The tint is reinforcement — the badge and the `sr-only` word carry the kind (D15). */
const KIND_TINT: Record<DiffKind, string> = {
  changed: "bg-warn-soft",
  added: "bg-warn-soft",
  removed: "bg-warn-soft",
  absent: "bg-danger-soft",
  unchanged: "",
};

const GROUP_LABEL: Record<DiffGroup, MessageKey> = {
  required: "approval.diff.group.required",
  price: "approval.diff.group.price",
  content: "approval.diff.group.content",
  classification: "approval.diff.group.classification",
};

/** The tier order the server assigned, so the screen groups in that order and no other (D9). */
const GROUP_ORDER: DiffGroup[] = ["required", "price", "content", "classification"];

/**
 * The second fact a child row carries — an allergen's declaration vs its source, a
 * nutrient's value vs its basis. Resolved through this map and never a key built from the
 * `subfield` value; a subfield this map does not carry shows its own name rather than
 * another field's label.
 */
const SUBFIELD_LABEL: Record<string, MessageKey> = {
  containment: "approval.diff.subfield.containment",
  source: "approval.diff.subfield.source",
  value: "approval.diff.subfield.value",
  basis: "approval.diff.subfield.basis",
  taxClass: "approval.diff.subfield.taxClass",
  hsnSacCode: "approval.diff.subfield.hsnSacCode",
  caloriesKcal: "approval.diff.subfield.caloriesKcal",
  servingSizeQty: "approval.diff.subfield.servingSizeQty",
  nutritionBasis: "approval.diff.subfield.nutritionBasis",
};

/**
 * The value classes, and the enum map each one resolves through.
 *
 * An `enum` is never rendered raw and never through `t(\`x.${value}\`)`: the field decides
 * the vocabulary, and an unmapped member shows its own code (rule 1). `subfield` refines
 * it, because one field can carry two enums of different vocabularies — an allergen's
 * containment and its source.
 */
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

function enumWord(t: Translate, field: DiffRow["field"], subfield: string | undefined, value: string): string {
  if (field === "dietaryMark") return dietLabel(t, value);
  if (field === "allergen") {
    return subfield === "source" ? allergenSourceLabel(t, value) : containmentLabel(t, value);
  }
  if (field === "nutrient" || field === "jurisdiction") return basisLabel(t, value);
  return value;
}

export interface RecordDiffProps {
  /**
   * The comparison read for this decision, exactly as `getArticleVersionReview` returned
   * it. `null` when there is nothing to render — the dialog then says which of the two
   * reasons it is (in flight, or unreadable) rather than showing an empty table.
   */
  review: ArticleVersionReview | null;
  /** Why `review` is null. Never rendered as an empty diff (§4 S3 vs S5). */
  status?: "loading" | "unreadable";
  /** §4 S5's retry. Omitted by a call site that has nothing to retry. */
  onRetry?: () => void;
  /**
   * The versions the loading line names, when the caller knows them before the read
   * returns. Omitted rather than guessed: the line then says "Loading…" instead of
   * "Comparing version with version ".
   */
  onSaleVersion?: number | null;
  proposedVersion?: number | null;
  className?: string;
}

export function RecordDiff({
  review,
  status = "loading",
  onRetry,
  onSaleVersion: onSaleHint = null,
  proposedVersion: proposedHint = null,
  className = "",
}: RecordDiffProps) {
  const { t, format, locale } = useI18n();
  const [showUnchanged, setShowUnchanged] = useState(false);

  if (!review) {
    if (status === "unreadable") {
      // S5: not "nothing changed" — "we could not read it". The two must never read the
      // same, or an approver decides on a comparison that was never made.
      return (
        <div className={className}>
          <ErrorState
            title={t("approval.diff.unavailable.title")}
            description={t("approval.diff.unavailable.body")}
            action={
              onRetry ? (
                <Button variant="secondary" onClick={onRetry}>
                  {t("action.retry")}
                </Button>
              ) : undefined
            }
          />
        </div>
      );
    }
    // S4: the diff's own place and height, with a single polite status line. The decision
    // buttons are disabled by the caller while this is on screen — deciding a diff you
    // have not read is the failure this view exists to prevent.
    return (
      <div className={className}>
        <p role="status" aria-live="polite" className="text-2xs text-fg-muted">
          {onSaleHint !== null && proposedHint !== null
            ? t("approval.diff.loading", { onSale: String(onSaleHint), proposed: String(proposedHint) })
            : t("common.loading")}
        </p>
        <TableSkeleton rows={4} columns={4} label={t("common.loading")} />
      </div>
    );
  }

  const onSaleVersion = review.base?.version ?? null;
  const proposedVersion = review.version;
  const changedRows = review.diff.filter((row) => row.kind !== "unchanged");
  const unchangedRows = review.diff.filter((row) => row.kind === "unchanged");
  const priceChanges = changedRows.filter((row) => row.group === "price").length;
  const summary = {
    changed: changedRows.length,
    prices: priceChanges,
    required: review.diffCounts.absent,
  };

  return (
    <section className={`flex flex-col gap-3 ${className}`} aria-labelledby="record-diff-title">
      <header className="flex flex-col gap-1">
        <h4 id="record-diff-title" className="text-sm font-semibold text-fg">
          {t("approval.diff.title")}
        </h4>
        {onSaleVersion !== null ? (
          <p className="text-xs text-fg-muted">
            {t("approval.diff.subtitle", {
              onSale: String(onSaleVersion),
              proposed: String(proposedVersion),
            })}
          </p>
        ) : null}
        {/* §4 S9/D4: the base's approval as one context line, because the diff has no status
            row — status is lifecycle, and the approver is deciding a replacement, not a state. */}
        {review.base ? (
          <p className="text-2xs text-fg-subtle">
            {review.base.approvedAt
              ? t("approval.diff.base.approvedBy", {
                  version: String(review.base.version),
                  who: review.base.approvedBy ?? t("common.unknown"),
                  // {when} is an ISO instant from the read and a person reads a date and a
                  // time in their own zone — never the instant string.
                  when: format.dateTime(review.base.approvedAt),
                })
              : t("approval.diff.base.neverApproved", { version: String(review.base.version) })}
          </p>
        ) : null}
      </header>

      {review.baseMoved ? <BaseMovedBlock review={review} /> : null}

      {!review.baseMoved && !review.base ? <FirstVersionBlock review={review} /> : null}

      {!review.baseMoved && review.base ? (
        <>
          {/* D19: what the approval *does*, in one line, where the window arithmetic is
              otherwise invisible — the base's prices end the day before the new ones start. */}
          {review.isProposal ? (
            <p className="rounded-md border border-border bg-surface-sunken px-3 py-1.5 text-2xs text-fg-muted">
              {t("approval.diff.supersedes", {
                proposed: String(proposedVersion),
                onSale: String(onSaleVersion ?? ""),
              })}
            </p>
          ) : null}

          <p className="text-2xs text-fg-subtle">
            {summary.changed + summary.prices + summary.required === 0
              ? t("approval.diff.summary.noChanges")
              : t("approval.diff.summary", {
                  changed: String(summary.changed),
                  prices: String(summary.prices),
                  required: String(summary.required),
                })}
          </p>

          {/* ONE live region, not one per row: a twelve-row diff announced row by row is
              twelve interruptions (spec §8.1). */}
          <p role="status" aria-live="polite" className="sr-only">
            {t("approval.diff.a11y.summary", {
              changed: String(summary.changed),
              prices: String(summary.prices),
              required: String(summary.required),
            })}
          </p>

          {summary.changed + summary.prices + summary.required === 0 ? (
            <div className="rounded-md border border-border bg-surface-sunken px-3 py-2">
              <p className="text-xs font-medium text-fg">
                {t("approval.diff.empty.title", {
                  onSale: String(onSaleVersion ?? ""),
                  proposed: String(proposedVersion),
                })}
              </p>
              <p className="mt-0.5 text-2xs text-fg-muted">
                {t("approval.diff.empty.body", {
                  onSale: String(onSaleVersion ?? ""),
                  proposed: String(proposedVersion),
                })}
              </p>
            </div>
          ) : null}

          <DiffTable
            changedRows={changedRows}
            unchangedRows={unchangedRows}
            onSaleVersion={onSaleVersion}
            proposedVersion={proposedVersion}
            locale={locale}
            expanded={showUnchanged}
            onToggle={() => {
              setShowUnchanged((open) => !open);
            }}
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * §4 S6 — `supersedes_version_id` is set but is no longer the version on sale.
 *
 * The diff is deliberately **not** drawn here. Comparing against the version the proposal
 * was written against would show a change nobody is deciding, and comparing against
 * today's sellable version would show a change the proposal never saw. The sentence names
 * both versions and points at the refusal the click would meet — the same condition the
 * approve branch asserts (`validation.review.baseMoved`), so the screen and the server
 * cannot disagree.
 */
function BaseMovedBlock({ review }: { review: ArticleVersionReview }) {
  const { t } = useI18n();
  return (
    <Banner tone="danger" title={t("approval.diff.baseMoved.title")}>
      <p>
        {t("approval.diff.baseMoved.body", {
          proposed: String(review.version),
          code: review.code,
          writtenAgainst: String(review.base?.version ?? ""),
          onSale: String(review.sellable?.version ?? ""),
        })}
      </p>
    </Banner>
  );
}

/**
 * §4 S1 / D20 — a first version has no base, so there is no diff to draw.
 *
 * Showing nothing here would make approving a brand-new record a rubber stamp, which is
 * exactly the failure this work exists to remove. So it shows the two things a decision
 * needs instead: the market-required fields, each with the market whose law requires it,
 * and — where this read carries the value — the value itself. A required field the
 * proposal does not carry is marked `Missing` from the same gap set the approval refuses
 * on (D14); a required field this read has no value for is left unvalued rather than
 * guessed at, because the gap set already answers whether it is present.
 */
function FirstVersionBlock({ review }: { review: ArticleVersionReview }) {
  const { t, format, locale } = useI18n();
  const gapFields = new Set(review.complianceGaps.map((gap) => gap.field));

  const value = (field: string): ReactNode | null => {
    switch (field) {
      case "name":
        return review.name;
      case "dietaryMark":
        return review.dietaryMark ? dietLabel(t, review.dietaryMark) : null;
      case "taxClass":
        return review.taxClassCode;
      case "hsnSacCode":
        return review.hsnSacCode;
      case "servingSize":
        return review.servingSizeQty !== null && review.servingSizeUomCode
          ? format.quantity(review.servingSizeQty, review.servingSizeUomCode)
          : null;
      case "caloriesKcal":
        return review.caloriesKcal !== null ? format.quantity(review.caloriesKcal, "kcal") : null;
      case "allergens":
        return review.allergens.length > 0
          ? format.list(review.allergens.map((row) => allergenLabel(t, row.code)))
          : null;
      default:
        // `nutrition` and any field a later profile adds: this read carries no value for it,
        // so the row names the requirement and the gap set says whether it is met.
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2">
      <p className="text-xs font-semibold text-fg">
        {t("approval.diff.firstVersion.title", { version: String(review.version) })}
      </p>
      <p className="text-2xs text-fg-muted">{t("approval.diff.firstVersion.body")}</p>
      {review.requiredFields.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {review.requiredFields.map((requirement: RequiredArticleFieldRef) => (
            <li key={`${requirement.field}:${requirement.jurisdiction}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs">
              <span className="font-medium text-fg">{complianceFieldLabel(t, requirement.field)}</span>
              <span className="text-fg-muted">
                {requirement.legalRef
                  ? t("approval.diff.why.requiredLegalRef", {
                      // {jurisdiction} is a market code; a person reads a market's name.
                      jurisdiction: marketName(locale, requirement.declaredFor || requirement.jurisdiction),
                      legalRef: requirement.legalRef,
                    })
                  : t("approval.diff.why.required", {
                      jurisdiction: marketName(locale, requirement.declaredFor || requirement.jurisdiction),
                    })}
              </span>
              {gapFields.has(requirement.field) ? (
                <Badge tone="danger">{t("approval.diff.kind.absent")}</Badge>
              ) : value(requirement.field) !== null ? (
                <span className="text-fg">{value(requirement.field)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {review.prices.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {review.prices.map((price) => (
            <li key={price.outletCode} className="flex items-baseline justify-between gap-3 text-2xs">
              {/* The read names the outlet by code only in this state — the comparison that
                  would carry its name does not exist for a first version. A code in mono is
                  an identifier position, not prose (owner, 28 Sept 2026). */}
              <code className="font-mono text-fg-muted">{price.outletCode}</code>
              <MoneyValue money={{ amount: price.amount, currency: price.currencyCode }} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The comparison itself: the changed rows in full, the unchanged remainder behind a count. */
function DiffTable({
  changedRows,
  unchangedRows,
  onSaleVersion,
  proposedVersion,
  locale,
  expanded,
  onToggle,
}: {
  changedRows: DiffRow[];
  unchangedRows: DiffRow[];
  onSaleVersion: number | null;
  proposedVersion: number;
  locale: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, format } = useI18n();
  const hasUnchanged = unchangedRows.length > 0;
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    rows: changedRows.filter((row) => row.group === group),
  })).filter((entry) => entry.rows.length > 0);

  const rowsFor = (rows: DiffRow[]) => (
    <DiffRows rows={rows} locale={locale} />
  );

  return (
    <>
      {hasUnchanged ? (
        /*
         * The unchanged disclosure: a real `<button>` with `aria-expanded` and
         * `aria-controls`, not a `<summary>` styled to look like one. It is the diff's only
         * tab stop — nothing inside the table is focusable, because the diff is read, not
         * operated (spec §8.2).
         */
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls="record-diff-unchanged"
          className="self-start rounded-sm border border-border px-2 py-1 text-2xs font-medium text-fg-muted hover:bg-surface-muted"
        >
          {expanded ? t("approval.diff.unchanged.hide") : t("approval.diff.unchanged.show")}
          {" · "}
          {t("approval.diff.unchanged.label", { count: format.integer(unchangedRows.length) })}
        </button>
      ) : null}

      <div className="hidden max-h-[40vh] overflow-y-auto rounded-md border border-border md:block">
        <table className="data-table w-full text-xs">
          <caption className="sr-only">
            {t("approval.diff.a11y.caption", {
              onSale: String(onSaleVersion ?? ""),
              proposed: String(proposedVersion),
            })}
          </caption>
          <thead>
            <tr className="text-2xs tracking-wide text-fg-subtle uppercase">
              <th scope="col" className="px-3 py-1.5 text-start font-semibold">
                {t("approval.diff.column.field")}
              </th>
              <th scope="col" className="px-3 py-1.5 text-start font-semibold">
                {t("approval.diff.column.selling", { onSale: String(onSaleVersion ?? "") })}
              </th>
              <th scope="col" className="px-3 py-1.5 text-start font-semibold">
                {t("approval.diff.column.proposed", { proposed: String(proposedVersion) })}
              </th>
              <th scope="col" className="px-3 py-1.5 text-start font-semibold">
                {t("approval.diff.column.why")}
              </th>
            </tr>
          </thead>
          {grouped.map((entry) => (
            <tbody key={entry.group}>
              <tr className="border-t border-border bg-surface-sunken">
                <th scope="colgroup" colSpan={4} className="px-3 py-1 text-start text-2xs font-semibold text-fg-muted">
                  {t(GROUP_LABEL[entry.group])}
                </th>
              </tr>
              {rowsFor(entry.rows)}
            </tbody>
          ))}
          {expanded && hasUnchanged ? (
            <tbody id="record-diff-unchanged">
              {rowsFor(unchangedRows)}
            </tbody>
          ) : null}
        </table>
      </div>

      {/*
       * Below `md` the same rows as stacked cards. A four-column table inside a phone-width
       * dialog becomes four-word-wide columns, and a horizontally scrolling one hides the
       * *after* column — the one the approval is about. Both renderings come from the one
       * `DiffRow[]` array, so they cannot drift.
       */}
      <ul className="flex flex-col gap-2 md:hidden">
        {[...changedRows, ...(expanded ? unchangedRows : [])].map((row) => (
          <li key={row.id} className={`rounded-md border border-border px-3 py-2 ${KIND_TINT[row.kind]}`}>
            <p className="text-xs font-medium text-fg">{rowSubject(t, locale, row)}</p>
            <p className="text-2xs text-fg-subtle">
              {t(FIELD_LABEL[row.field])}
              {row.subfield ? ` · ${subfieldWord(t, row.subfield)}` : ""}
            </p>
            <dl className="mt-1 flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-2xs text-fg-subtle">
                  {t("approval.diff.column.selling", { onSale: String(onSaleVersion ?? "") })}
                </dt>
                <dd className="text-end">
                  <DiffCell row={row} value={row.before} />
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-2xs text-fg-subtle">
                  {t("approval.diff.column.proposed", { proposed: String(proposedVersion) })}
                </dt>
                <dd className="text-end">
                  <DiffCell row={row} value={row.after} />
                  <span className="sr-only">{t(KIND_A11Y_LABEL[row.kind])}</span>
                </dd>
              </div>
            </dl>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-muted">
              <Badge tone={KIND_TONE[row.kind]}>{t(KIND_LABEL[row.kind])}</Badge>
              {row.delta ? <span>{priceDeltaSentence(t, format, row.delta)}</span> : null}
            </p>
            {whySentences(t, locale, row).map((sentence) => (
              <p key={sentence} className="mt-1 text-2xs text-fg-muted">
                {sentence}
              </p>
            ))}
          </li>
        ))}
      </ul>

      {expanded && hasUnchanged ? (
        <p role="status" aria-live="polite" className="sr-only">
          {t("approval.diff.a11y.unchangedExpanded", {
            count: format.integer(unchangedRows.length),
          })}
        </p>
      ) : null}
    </>
  );
}

function DiffRows({ rows, locale }: { rows: DiffRow[]; locale: string }) {
  return (
    <>
      {rows.map((row) => (
        <DiffRowView key={row.id} row={row} locale={locale} />
      ))}
    </>
  );
}

/** One row: the field as a row header, both values typed, and why it matters. */
function DiffRowView({ row, locale }: { row: DiffRow; locale: string }) {
  const { t, format } = useI18n();
  const fieldWord = t(FIELD_LABEL[row.field]);
  const subject = rowSubject(t, locale, row);

  return (
    <tr className={KIND_TINT[row.kind] || undefined}>
      {/* `<th scope="row">`, not `<td>`: this is what makes a screen reader announce
          "Koramangala Restaurant, price, on sale today ₹380.00, if approved ₹425.00" as one
          row instead of reading four unlabelled cells. */}
      <th scope="row" className="px-3 py-1.5 align-top text-start font-normal">
        <span className="block text-xs font-medium text-fg">{subject}</span>
        <span className="block text-2xs text-fg-subtle">
          {row.qualifier || row.subfield
            ? `${fieldWord}${row.subfield ? ` · ${subfieldWord(t, row.subfield)}` : ""}`
            : fieldWord}
        </span>
        <span className="mt-1 inline-block">
          <Badge tone={KIND_TONE[row.kind]}>{t(KIND_LABEL[row.kind])}</Badge>
        </span>
      </th>
      <td className="px-3 py-1.5 align-top">
        <DiffCell row={row} value={row.before} />
      </td>
      <td className="px-3 py-1.5 align-top">
        <DiffCell row={row} value={row.after} />
        {/* The kind, announced as well as seen (D15 / spec §8.1). */}
        <span className="sr-only">{t(KIND_A11Y_LABEL[row.kind])}</span>
        {row.delta ? (
          <span className="mt-0.5 block text-2xs text-fg-muted">
            {priceDeltaSentence(t, format, row.delta)}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-1.5 align-top text-2xs text-fg-muted">
        {whySentences(t, locale, row).map((sentence) => (
          <span key={sentence} className="block">
            {sentence}
          </span>
        ))}
      </td>
    </tr>
  );
}

/**
 * The row's subject in words: the outlet, the allergen, the nutrient, the channel, the
 * market — or the field's own name when the field is the subject.
 *
 * Never a bare code where a label exists (rule 5), and never two codes joined (rule 4).
 */
function rowSubject(
  t: Translate,
  locale: string,
  row: DiffRow
): string {
  const q = row.qualifier;
  if (q?.outletCode) return q.outletName ?? q.outletCode;
  if (q?.allergenCode) return allergenLabel(t, q.allergenCode);
  if (q?.nutrientCode) return nutrientLabel(t, q.nutrientCode);
  if (q?.channel) return channelLabel(t, q.channel);
  if (q?.jurisdictionCode) return marketName(locale, q.jurisdictionCode);
  return t(FIELD_LABEL[row.field]);
}

function subfieldWord(t: Translate, subfield: string): string {
  const key = SUBFIELD_LABEL[subfield];
  return key ? t(key) : subfield;
}

/** One side of a row, through the console's typed value components — never `String(value)`. */
function DiffCell({ row, value }: { row: DiffRow; value: DiffValue }) {
  const { t } = useI18n();
  switch (value.kind) {
    case "none":
      // Absent is not empty: "nothing has been declared", not the em dash `common.none`
      // uses, which cannot tell absent from an empty declaration (D13).
      return <span className="text-2xs text-fg-subtle">{t("approval.diff.notDeclared")}</span>;
    case "text":
      return <span className="text-xs text-fg">{value.text}</span>;
    case "code":
      // A business code is shown as itself: `996331` and `GST5-REST` are identifiers an
      // operator matches against their own systems, and translating them is a bug.
      return <code className="font-mono text-2xs text-fg">{value.code}</code>;
    case "enum":
      return <span className="text-xs text-fg">{enumWord(t, row.field, row.subfield, value.value)}</span>;
    case "money":
      return <MoneyValue money={{ amount: value.amount, currency: value.currencyCode }} />;
    case "quantity":
      return <QuantityValue value={value.value} uom={value.uomCode} />;
    case "date":
      // D16: the same path the Versions card uses. The date-only timezone defect is queued
      // as its own pass; this view does not introduce a second rendering of a date.
      return <TimestampValue value={value.date} mode="date" />;
    case "dateTime":
      return <TimestampValue value={value.at} mode="dateTime" />;
    case "boolean":
      // A word, never `true`. The one boolean a row carries today is a channel flag, and
      // the row's own subject names the channel.
      return (
        <span className="text-xs text-fg">
          {value.value ? t("approval.diff.channel.published") : t("approval.diff.channel.notPublished")}
        </span>
      );
    default:
      // Exhaustive by type; reachable only if a serialised payload carries a shape this
      // build does not know. It says so in words rather than rendering an object.
      return <span className="text-2xs text-fg-subtle">{t("common.unknown")}</span>;
  }
}

/**
 * The money delta, in exact figures the server computed (D12).
 *
 * `{amount}` is an **amount with its ISO currency code** — never a bare number. `{percent}`
 * is a ratio rendered by `Intl`, so it prints `11.84%` in the reader's own locale. A row
 * whose two sides are in different currencies carries **no delta at all** (D11), and a row
 * whose base amount was zero carries a delta with a null percentage: rather than print a
 * percentage that does not exist, that case shows the signed amount alone and claims
 * nothing.
 */
function priceDeltaSentence(
  t: Translate,
  format: ReturnType<typeof useI18n>["format"],
  delta: { amount: number; currencyCode: string; percent: number | null }
): ReactNode {
  const amount = format.money({ amount: Math.abs(delta.amount), currency: delta.currencyCode }, { display: "code" });
  const key: MessageKey = delta.amount < 0 ? "approval.diff.price.lower" : "approval.diff.price.higher";
  if (delta.percent === null) {
    return <MoneyValue money={{ amount: delta.amount, currency: delta.currencyCode }} signed />;
  }
  // Two decimals, not `Intl`'s zero-decimal default. The read computes the ratio in exact
  // decimal arithmetic (D12) and the screen must not round it into a different claim: a rise
  // of 45.00 on 380.00 is 11.84%, and "12% higher" is a figure the server never returned.
  // The two decimals also match how money prints in this console (`INR 45.00`, `₹380.00`).
  const sentence = t(key, {
    amount,
    percent: format.percent(Math.abs(delta.percent) / 100, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  });
  return sentence;
}

/**
 * *Why it matters* — the market that requires the field, and the two transitions the
 * catalogue words for a reader rather than a machine.
 *
 * Every placeholder here takes a **word, not a token**: `{jurisdiction}` through
 * `marketName` ("India", never `IN-KA`), `{before}`/`{after}` for a declaration through
 * the containment labels ("Contains" / "May contain", never `contains` / `mayContain`),
 * for a basis through the nutrition-basis labels, and `{outlet}` as a name plus its site
 * code rather than two bare codes.
 */
function whySentences(t: Translate, locale: string, row: DiffRow): string[] {
  const sentences: string[] = [];

  if (row.why?.requiredIn) {
    const market = marketName(locale, row.why.requiredIn.declaredFor || row.why.requiredIn.jurisdiction);
    sentences.push(
      row.why.requiredIn.legalRef
        ? t("approval.diff.why.requiredLegalRef", { jurisdiction: market, legalRef: row.why.requiredIn.legalRef })
        : t("approval.diff.why.required", { jurisdiction: market })
    );
  }

  // A declaration that moved between containment and may-contain: the highest-risk change
  // on this screen, and the one an approver must not read as a changed word.
  if (row.field === "allergen" && !row.subfield && row.before.kind === "enum" && row.after.kind === "enum") {
    const before = containmentLabel(t, row.before.value);
    const after = containmentLabel(t, row.after.value);
    if (row.before.value === "mayContain" && row.after.value === "contains") {
      sentences.push(t("approval.diff.allergen.containmentRaised", { before, after }));
    } else if (row.before.value === "contains" && row.after.value === "mayContain") {
      sentences.push(t("approval.diff.allergen.containmentLowered", { before, after }));
    }
  }

  // A basis that moved: the two numbers are measurements of different things, and the
  // sentence says so instead of letting an approver subtract one from the other.
  if (row.qualifier?.basisBefore && row.qualifier.basisAfter) {
    sentences.push(
      t("approval.diff.nutrient.basisChanged", {
        before: basisLabel(t, row.qualifier.basisBefore),
        after: basisLabel(t, row.qualifier.basisAfter),
      })
    );
  }

  if (row.field === "price" && !row.subfield) {
    const outlet = outletRef(t, row);
    if (row.kind === "added") sentences.push(t("approval.diff.price.addedFor", { outlet }));
    if (row.kind === "removed") sentences.push(t("approval.diff.price.removedFor", { outlet }));
  }

  // A currency change: both ISO codes are visible and no percentage is offered, because a
  // percentage across two currencies is not a number with a meaning (D11). A currency code
  // is the subject here, so it stays the code.
  if (row.field === "currency" && row.before.kind === "code" && row.after.kind === "code") {
    sentences.push(
      t("approval.diff.price.currencyChanged", { before: row.before.code, after: row.after.code })
    );
  }

  return sentences;
}

/**
 * `{outlet}` — a name plus its site code, never two bare codes.
 *
 * `mdm.approvals` hands over the outlet's name and its site's code in the row's qualifier
 * precisely so a sentence can name what it is about. When a name is missing from the read
 * the outlet's own code stands in for it, visibly our gap; the site code is dropped rather
 * than printed alone, because "· saffron-koramangala" after nothing reads as a typo.
 */
function outletRef(t: Translate, row: DiffRow): string {
  const outlet = row.qualifier?.outletName ?? row.qualifier?.outletCode ?? "";
  const site = row.qualifier?.siteCode;
  return site ? t("approval.diff.outlet", { outlet, site }) : outlet;
}
