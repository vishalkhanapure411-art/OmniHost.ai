import "@tanstack/react-start/server-only";

import { createHash, randomUUID } from "node:crypto";

import { poolQueryable, withTransaction, type Queryable } from "~/db";
import { guard, writeAudit } from "~/server/audit";
import { isHttpError, ValidationError } from "~/server/errors";
import {
  createArticle,
  planArticleWrite,
  updateArticle,
  updateArticlePrice,
  type ArticleWriteInput,
  type ArticleWritePlan,
} from "~/domain/mdm";
import type { Principal } from "~/server/session";

/**
 * The bulk-import pipeline (§16, §23.2, §23.3, §23.6).
 *
 * A chain's real master data arrives as a spreadsheet export, not as five hundred hand-typed
 * records. This module is the way in, and it is built around four rules:
 *
 *   1. **A dry run and a commit run the same rules.** The dry run plans each row with
 *      `planArticleWrite` — the same resolution and lifecycle logic the write path calls —
 *      and the commit applies the row through `createArticle` / `updateArticle` /
 *      `updateArticlePrice`. The commit's report is built from what those functions *returned*,
 *      never from the plan, so a plan can be pessimistic but never flattering.
 *   2. **A commit is one transaction, or none of it happens.** Every row's writes join the
 *      commit's own transaction (`meta.tx`), so a failure at row 400 rolls rows 1–399 back.
 *      There is no half-imported chain.
 *   3. **Re-running the same file is safe, and says so.** A row whose content and prices
 *      already match comes back `unchanged`, and writes nothing at all — no record change, no
 *      per-row audit row (§23.3 layer 2). The second run of a file reports `unchanged` for
 *      every row it created the first time.
 *   4. **Nothing is a second implementation of a rule.** Money is `amount + ISO 4217 code`
 *      inside one cell and never a bare number; a date is ISO 8601 or it is refused; an
 *      effective-dated price keeps its own validity window through the same function a hand
 *      edit uses.
 *
 * ## The file format (decisions, since the spec fixes the behaviour rather than the bytes)
 *
 * * **CSV, RFC 4180** — comma separated, quoting with `"`, doubled quotes inside a quoted
 *   field, CRLF or LF, optional UTF-8 BOM. No XLSX in this slab: an export from Excel or
 *   Sheets to CSV is one menu item, and a binary parser is a dependency and a class of bug
 *   that buys nothing yet. Flagged as the first follow-up if a chain insists.
 * * **One row per article**, with the header naming every column. Per-outlet prices live in
 *   one `prices` cell as `outlet=amount CUR; outlet=amount CUR` rather than as
 *   `price.<outlet>` columns, because a chain's outlet list is not known when the template is
 *   written and a dynamic column set makes an unknown-outlet error a *column* error instead
 *   of a row error with a line number.
 * * **A missing required column is a file-level refusal** — the whole file, reported once,
 *   naming the columns. A required column that is present but empty on a row is a row error
 *   for that row. The two are different mistakes and get different reports.
 * * **An unknown column is a warning attached to the report**, never an error: it is the
 *   "we have no home for this field" information row (§23.6 `unmappedErpField`), and it is how
 *   a chain finds out which of its own fields we cannot yet hold.
 * * **Dates are `YYYY-MM-DD` and nothing else.** An ambiguous local format that parses
 *   differently on two machines is worse than a refusal, and the refusal names the format.
 * * **Codes are matched case-insensitively and stored as given** — the code is the chain's,
 *   not ours, and silently upcasing it would break the promise §16 item 1 makes about the
 *   business key.
 *
 * ## Deliberate deviation, flagged for the lead
 *
 * §17 lists `partially valid (commit the valid rows)` as a stated state of the import screen.
 * This slab commits **all rows or none**: a file with any invalid row is refused, with every
 * bad line named, and nothing is written. That is the brief's own requirement ("either applies
 * the whole file or nothing — no half-imported chain"), and it is the easier failure to
 * reason about, but it is stricter than §17 and the difference is a decision rather than an
 * oversight. The partial-commit path, if wanted, is one flag on `commitImport`: keep the plan
 * per row and skip the rejected ones instead of refusing the file.
 */

// ---------------------------------------------------------------------------
// The report — one shape, both phases, resolved through the catalogs
// ---------------------------------------------------------------------------
/**
 * Prose never crosses this boundary: a row issue is a **message code plus its parameters**,
 * and the screen resolves it with `t()`. That is what keeps the report in the operator's
 * language (all four locales) and out of the server's, and it is why the same issue renders
 * on the dry-run screen, in the audit batch row and in a support reply.
 */
export interface ImportIssue {
  /** The column the operator must look at, or `file` for a whole-file problem. */
  column: string;
  /** A message-catalog key. */
  code: string;
  severity: "error" | "warning";
  params: Record<string, string | number>;
}

export type ImportRowOutcome = "created" | "updated" | "unchanged" | "rejected";

export interface ImportRowReport {
  lineNumber: number;
  code: string | null;
  outcome: ImportRowOutcome;
  /** The record this row wrote, when it wrote one. */
  entityId: string | null;
  /** The lifecycle state the record holds (or would hold) — §6. */
  landing: string | null;
  /** Field-level names of what changed, so "what did this row do" is not a summary. */
  changed: string[];
  issues: ImportIssue[];
}

export interface ImportCounts {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  warned: number;
}

export interface ImportReport {
  batchId: string;
  entity: string;
  phase: "dry_run" | "commit";
  fileName: string;
  fileHash: string;
  columns: string[];
  status: "succeeded" | "succeeded_with_issues" | "failed";
  /** Set when the whole file was refused; every row is then absent from `rows`. */
  fileError: ImportIssue | null;
  /** Columns the platform has no home for — the information row of §23.6. */
  columnWarnings: ImportIssue[];
  counts: ImportCounts;
  rows: ImportRowReport[];
  /** True only for a commit that actually applied every row. */
  applied: boolean;
}

export interface ImportRequest {
  entity: "article";
  fileName: string;
  /** The file's text, as uploaded. The browser reads it so the server never parses a stream. */
  content: string;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
export interface CsvTable {
  header: string[];
  rows: { lineNumber: number; cells: string[] }[];
  /** An unterminated quote: the file is not CSV we can read, and guessing is worse. */
  malformed: boolean;
}

/**
 * RFC 4180, written out rather than pulled in: quoted fields, doubled quotes, CRLF, BOM. No
 * dependency, no surprise about how it treats a stray quote, and the one behaviour a chain's
 * export depends on is visible here.
 */
export function parseCsv(text: string): CsvTable {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const header: string[] = [];
  const rows: { lineNumber: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let lineNumber = 1;
  let recordStart = 1;
  let malformed = false;
  let sawAny = false;

  const endField = () => {
    cells.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    sawAny = true;
    if (header.length === 0) {
      for (const cell of cells) header.push(cell.trim());
    } else if (cells.some((cell) => cell.trim() !== "") || cells.length > 1) {
      rows.push({ lineNumber: recordStart, cells });
    }
    cells = [];
    // `lineNumber` has already advanced past the newline that ended this record, so it is
    // the number of the line the *next* record starts on. Adding one here named every row
    // one line below where the operator sees it — the row on line 2 of the file was
    // reported as line 3. A record that spans several lines (a quoted value containing a
    // newline) still lands right: the inner newlines advanced `lineNumber` with it.
    recordStart = lineNumber;
  };

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") lineNumber += 1;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      endField();
      continue;
    }
    if (char === "\r") {
      if (body[index + 1] === "\n") index += 1;
      lineNumber += 1;
      endRecord();
      continue;
    }
    if (char === "\n") {
      lineNumber += 1;
      endRecord();
      continue;
    }
    field += char;
  }
  if (quoted) malformed = true;
  if (field !== "" || cells.length > 0) endRecord();
  else if (!sawAny && header.length === 0) malformed = true;

  return { header, rows, malformed };
}

// ---------------------------------------------------------------------------
// Column definitions — the seam the next entity type plugs into
// ---------------------------------------------------------------------------
type ColumnKind = "text" | "code" | "enum" | "number" | "date" | "money-list" | "code-list";

interface ColumnSpec {
  name: string;
  kind: ColumnKind;
  required?: boolean;
  enumValues?: string[];
  /** Accepted aliases, so a chain's own header spelling does not become an error. */
  aliases?: string[];
}

/**
 * The article template.
 *
 * The `nutrient.<code>` columns are dynamic on purpose: the nutrient reference is data
 * (§13.1), so a market that requires a nutrient we have never heard of is a row of reference
 * data plus a column, not a release. A `nutrient.` column whose code is not in the reference
 * is a row error naming the code — the same answer §22.6 gives for an unmapped ERP code.
 */
export const ARTICLE_COLUMNS: ColumnSpec[] = [
  { name: "code", kind: "code", required: true },
  { name: "name", kind: "text", required: true },
  { name: "shortName", kind: "text" },
  { name: "category", kind: "code", required: true },
  { name: "articleType", kind: "enum", required: true, enumValues: ["food", "beverage", "retail", "service"] },
  { name: "dietaryMark", kind: "enum", enumValues: ["veg", "non_veg", "egg", "vegan", "none"] },
  { name: "taxClass", kind: "code" },
  { name: "hsnSac", kind: "text" },
  { name: "baseUom", kind: "code", required: true },
  { name: "servingQty", kind: "number" },
  { name: "servingUom", kind: "code" },
  { name: "caloriesKcal", kind: "number" },
  { name: "channels", kind: "code-list" },
  { name: "allergens", kind: "code-list" },
  { name: "mayContain", kind: "code-list" },
  { name: "nutritionBasis", kind: "enum", enumValues: ["per_serving", "per_100g", "per_100ml"] },
  { name: "prices", kind: "money-list", required: true },
  { name: "priceEffectiveFrom", kind: "date" },
  { name: "externalRef", kind: "text" },
  { name: "sourceSystem", kind: "text" },
];

const NUTRIENT_PREFIX = "nutrient.";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

function normaliseHeader(value: string): string {
  return value.trim().toLowerCase();
}

function issue(
  column: string,
  code: string,
  params: Record<string, string | number> = {},
  severity: "error" | "warning" = "error"
): ImportIssue {
  return { column, code, severity, params };
}

/** Every match of a column name, so a file with two `code` columns is caught rather than
 * silently using the first. */
function columnIndex(header: string[], names: string[]): number[] {
  const wanted = names.map(normaliseHeader);
  const found: number[] = [];
  header.forEach((cell, index) => {
    if (wanted.includes(normaliseHeader(cell))) found.push(index);
  });
  return found;
}

export interface ParsedFile {
  table: CsvTable;
  /** Column name (as written in the file) → index. */
  index: Record<string, number>;
  columns: string[];
  fileError: ImportIssue | null;
  columnWarnings: ImportIssue[];
  /** Dynamic nutrient columns present, by nutrient code. */
  nutrientColumns: { code: string; index: number }[];
}

/**
 * Header validation: everything that can be decided before a data row is looked at, so a
 * wrong file is refused once instead of four hundred times (§17).
 */
export function readFile(content: string): ParsedFile {
  const table = parseCsv(content);
  const columns = table.header.map((cell) => cell.trim()).filter((cell) => cell !== "");
  if (table.malformed) {
    return {
      table,
      index: {},
      columns,
      fileError: issue("file", "mdm.import.error.unreadable", {}, "error"),
      columnWarnings: [],
      nutrientColumns: [],
    };
  }
  if (columns.length === 0 || table.rows.length === 0) {
    return {
      table,
      index: {},
      columns,
      fileError: issue("file", "mdm.import.error.empty", {}, "error"),
      columnWarnings: [],
      nutrientColumns: [],
    };
  }

  const index: Record<string, number> = {};
  const columnWarnings: ImportIssue[] = [];
  const nutrientColumns: { code: string; index: number }[] = [];
  const known = new Set<string>([
    ...ARTICLE_COLUMNS.map((spec) => normaliseHeader(spec.name)),
    ...ARTICLE_COLUMNS.flatMap((spec) => (spec.aliases ?? []).map(normaliseHeader)),
  ]);

  table.header.forEach((cell, position) => {
    const key = normaliseHeader(cell);
    if (key === "") return;
    if (known.has(key)) {
      index[key] = position;
      return;
    }
    if (key.startsWith(NUTRIENT_PREFIX)) {
      const code = cell.trim().slice(NUTRIENT_PREFIX.length);
      nutrientColumns.push({ code, index: position });
      return;
    }
    // §23.6 `unmappedErpField`: an information row, never a conflict. The living list of
    // fields a chain holds that our model has no home for yet.
    columnWarnings.push(
      issue(cell.trim(), "mdm.import.warning.unmappedColumn", { column: cell.trim() }, "warning")
    );
  });

  const missing: string[] = [];
  for (const spec of ARTICLE_COLUMNS) {
    if (!spec.required) continue;
    if (columnIndex(table.header, [spec.name, ...(spec.aliases ?? [])]).length === 0) {
      missing.push(spec.name);
    }
  }
  for (const spec of ARTICLE_COLUMNS) {
    const hits = columnIndex(table.header, [spec.name, ...(spec.aliases ?? [])]);
    if (hits.length > 1) {
      return {
        table,
        index,
        columns,
        fileError: issue("file", "mdm.import.error.duplicateColumn", { column: spec.name }, "error"),
        columnWarnings,
        nutrientColumns,
      };
    }
  }
  if (missing.length > 0) {
    return {
      table,
      index,
      columns,
      fileError: issue(
        "file",
        "mdm.import.error.missingColumns",
        { columns: missing.join(", ") },
        "error"
      ),
      columnWarnings,
      nutrientColumns,
    };
  }

  return { table, index, columns, fileError: null, columnWarnings, nutrientColumns };
}

// ---------------------------------------------------------------------------
// Row → input, with the column named on every refusal
// ---------------------------------------------------------------------------
export interface ParsedRow {
  input: ArticleWriteInput | null;
  issues: ImportIssue[];
  code: string | null;
}

function cellAt(cells: string[], position: number | undefined): string {
  if (position === undefined) return "";
  return (cells[position] ?? "").trim();
}

/** `amount CUR`, never a bare number (§8.4, §16 item 3). */
export function parseMoneyList(
  raw: string,
  column: string,
  issues: ImportIssue[]
): { outletCode: string; amount: number; currencyCode: string }[] {
  const result: { outletCode: string; amount: number; currencyCode: string }[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(";")) {
    const entry = part.trim();
    if (entry === "") continue;
    const equals = entry.indexOf("=");
    if (equals <= 0 || equals === entry.length - 1) {
      issues.push(issue(column, "validation.priceFormat", { value: entry }, "error"));
      continue;
    }
    const outletCode = entry.slice(0, equals).trim();
    const money = entry.slice(equals + 1).trim();
    const tokens = money.split(/\s+/).filter((token) => token !== "");
    if (tokens.length < 2) {
      // The bare-number case, refused by name: a price without a currency is a price in a
      // currency somebody guessed.
      issues.push(issue(column, "validation.money.currencyMissing", { value: money }, "error"));
      continue;
    }
    if (tokens.length > 2) {
      issues.push(issue(column, "validation.money.format", { value: money }, "error"));
      continue;
    }
    const amount = Number(tokens[0].replace(/,/g, ""));
    const currencyCode = tokens[1].toUpperCase();
    if (!Number.isFinite(amount) || amount < 0) {
      issues.push(issue(column, "validation.number.invalid", { value: tokens[0] }, "error"));
      continue;
    }
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      issues.push(issue(column, "validation.money.currencyFormat", { value: tokens[1] }, "error"));
      continue;
    }
    const key = outletCode.toLowerCase();
    if (seen.has(key)) {
      issues.push(issue(column, "validation.duplicateOutlet", { outlet: outletCode }, "error"));
      continue;
    }
    seen.add(key);
    result.push({ outletCode, amount, currencyCode });
  }
  if (result.length === 0 && !issues.some((entry) => entry.column === column)) {
    issues.push(issue(column, "validation.required", { field: column }, "error"));
  }
  return result;
}

/** `outletCode=amount CUR; …` and every date in the file are parsed here, once. */
export function parseArticleRow(
  parsed: ParsedFile,
  cells: string[]
): ParsedRow {
  const issues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const value = (name: string): string => cellAt(cells, parsed.index[normaliseHeader(name)]);
  const has = (name: string): boolean => parsed.index[normaliseHeader(name)] !== undefined;

  const code = value("code");
  if (code === "") issues.push(issue("code", "validation.required", { field: "code" }));
  else if (!CODE_PATTERN.test(code)) {
    issues.push(issue("code", "validation.code.format", { value: code }));
  }

  const name = value("name");
  if (name === "") issues.push(issue("name", "validation.required", { field: "name" }));

  const categoryCode = value("category");
  if (categoryCode === "") issues.push(issue("category", "validation.required", { field: "category" }));

  const articleTypeRaw = value("articleType").toLowerCase();
  const articleTypeSpec = ARTICLE_COLUMNS.find((spec) => spec.name === "articleType");
  if (articleTypeRaw === "") {
    issues.push(issue("articleType", "validation.required", { field: "articleType" }));
  } else if (!(articleTypeSpec?.enumValues ?? []).includes(articleTypeRaw)) {
    issues.push(
      issue("articleType", "validation.invalidEnum", {
        value: value("articleType"),
        values: (articleTypeSpec?.enumValues ?? []).join(", "),
      })
    );
  }

  const dietaryRaw = value("dietaryMark").toLowerCase();
  const dietarySpec = ARTICLE_COLUMNS.find((spec) => spec.name === "dietaryMark");
  if (dietaryRaw !== "" && !(dietarySpec?.enumValues ?? []).includes(dietaryRaw)) {
    issues.push(
      issue("dietaryMark", "validation.invalidEnum", {
        value: value("dietaryMark"),
        values: (dietarySpec?.enumValues ?? []).join(", "),
      })
    );
  }

  const baseUom = value("baseUom");
  if (baseUom === "") issues.push(issue("baseUom", "validation.required", { field: "baseUom" }));

  const readNumber = (column: string): number | null => {
    const raw = value(column);
    if (raw === "") return null;
    const parsedNumber = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(parsedNumber)) {
      issues.push(issue(column, "validation.number.invalid", { value: raw }));
      return null;
    }
    return parsedNumber;
  };
  const servingQty = readNumber("servingQty");
  const caloriesKcal = readNumber("caloriesKcal");

  // An explicit ISO date or nothing (§16 item 3: a default is fine, a silent one is not).
  let priceEffectiveFrom: string | null = null;
  const effectiveRaw = value("priceEffectiveFrom");
  if (effectiveRaw !== "") {
    if (!ISO_DATE.test(effectiveRaw) || Number.isNaN(Date.parse(`${effectiveRaw}T00:00:00Z`))) {
      issues.push(
        issue("priceEffectiveFrom", "validation.date.format", { value: effectiveRaw, format: "YYYY-MM-DD" })
      );
    } else {
      priceEffectiveFrom = effectiveRaw;
    }
  }

  const priceColumnIndex = parsed.index[normaliseHeader("prices")];
  const prices = parseMoneyList(cellAt(cells, priceColumnIndex), "prices", issues);

  const codeList = (column: string): string[] =>
    value(column)
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");

  // A column that is present but empty is a *statement*: "declared none" (§7.1). A column the
  // file does not carry at all is a gap, and a market that requires it says so below.
  const allergens = has("allergens")
    ? [
        ...codeList("allergens").map((entry) => ({ code: entry, mayContain: false })),
        ...codeList("mayContain").map((entry) => ({ code: entry, mayContain: true })),
      ]
    : undefined;

  const basisRaw = value("nutritionBasis").toLowerCase();
  let basis = basisRaw;
  if (basisRaw === "") {
    basis = "per_serving";
  } else if (!["per_serving", "per_100g", "per_100ml"].includes(basisRaw)) {
    issues.push(
      issue("nutritionBasis", "validation.invalidEnum", {
        value: value("nutritionBasis"),
        values: "per_serving, per_100g, per_100ml",
      })
    );
  }
  const nutrients: { code: string; value: number; basis: string }[] = [];
  for (const column of parsed.nutrientColumns) {
    const raw = cellAt(cells, column.index);
    if (raw === "") continue;
    const parsedNumber = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(parsedNumber)) {
      issues.push(issue(`nutrient.${column.code}`, "validation.number.invalid", { value: raw }));
      continue;
    }
    nutrients.push({ code: column.code, value: parsedNumber, basis });
  }
  if (nutrients.length > 0 && basisRaw === "") {
    warnings.push(
      issue(
        "nutritionBasis",
        "validation.defaulted",
        { field: "nutritionBasis", value: basis },
        "warning"
      )
    );
  }

  if (issues.length > 0) return { input: null, issues: [...issues, ...warnings], code: code || null };

  const input: ArticleWriteInput = {
    code,
    name,
    shortName: value("shortName") || null,
    categoryCode,
    articleType: articleTypeRaw as ArticleWriteInput["articleType"],
    dietaryMark: (dietaryRaw || null) as ArticleWriteInput["dietaryMark"],
    taxClassCode: value("taxClass") || null,
    hsnSacCode: value("hsnSac") || null,
    baseUomCode: baseUom,
    servingSizeQty: servingQty,
    servingSizeUomCode: value("servingUom") || null,
    caloriesKcal,
    channels: has("channels") ? codeList("channels") : undefined,
    allergens,
    nutrients: parsed.nutrientColumns.length > 0 ? nutrients : undefined,
    prices: prices.map((price) => ({ ...price, effectiveFrom: priceEffectiveFrom })),
    externalRef: value("externalRef") || null,
    sourceSystem: value("sourceSystem") || null,
  };
  if (!priceEffectiveFrom) {
    warnings.push(
      issue(
        "priceEffectiveFrom",
        "validation.defaulted",
        { field: "priceEffectiveFrom", value: new Date().toISOString().slice(0, 10) },
        "warning"
      )
    );
  }
  return { input, issues: warnings, code };
}

// ---------------------------------------------------------------------------
// The batch record — what the operator saw, and what was applied
// ---------------------------------------------------------------------------
interface BatchSeed {
  id: string;
  chainId: string;
  actorUserId: string | null;
  entity: string;
  phase: "dry_run" | "commit";
  fileName: string;
  fileBytes: number;
  fileHash: string;
  columns: string[];
  counts: ImportCounts;
  status: "succeeded" | "succeeded_with_issues" | "failed";
  fileError: ImportIssue | null;
}

async function insertBatch(tx: Queryable, seed: BatchSeed): Promise<void> {
  await tx.query(
    `insert into import_batch (id, chain_id, entity, mode, phase, file_name, file_bytes, file_hash,
                               columns, counts, status, file_error_code, file_error_params,
                               actor_user_id, finished_at)
     values ($1, $2, $3, 'manual_csv', $4, $5, $6, $7, $8::text[], $9::jsonb, $10, $11, $12::jsonb,
             $13, now())`,
    [
      seed.id,
      seed.chainId,
      seed.entity,
      seed.phase,
      seed.fileName,
      seed.fileBytes,
      seed.fileHash,
      seed.columns,
      JSON.stringify(seed.counts),
      seed.status,
      seed.fileError?.code ?? null,
      seed.fileError ? JSON.stringify(seed.fileError.params) : null,
      seed.actorUserId,
    ]
  );
}

async function insertRows(tx: Queryable, batchId: string, chainId: string, rows: ImportRowReport[]): Promise<void> {
  for (const row of rows) {
    await tx.query(
      `insert into import_row (batch_id, chain_id, line_number, row_key, outcome, entity_id, issues)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        batchId,
        chainId,
        row.lineNumber,
        row.code,
        row.outcome,
        row.entityId,
        JSON.stringify(row.issues),
      ]
    );
  }
}

/**
 * The batch's own audit row (§5: "the batch itself is audited once with row counts").
 *
 * It carries the file name, the row counts and what changed, and it is written with
 * `source: import` and the batch's own id — which is what makes "what did that import do"
 * one query over `audit_log` and not a search through a screen. Per-row changes carry the
 * same `batch_id`, so the pairs stay joined.
 */
async function writeBatchAudit(
  tx: Queryable,
  principal: Principal,
  seed: BatchSeed,
  outcome: "success" | "error",
  reason: string | null
): Promise<void> {
  await writeAudit(tx, {
    principal,
    action: "mdm.article.import",
    entityType: "import_batch",
    entityId: seed.id,
    chainId: seed.chainId,
    beforeState: null,
    afterState: {
      phase: seed.phase,
      file: seed.fileName,
      hash: seed.fileHash,
      counts: seed.counts,
      status: seed.status,
    },
    outcome,
    reason,
    source: "import",
    batchId: seed.id,
  });
}

function countRows(rows: ImportRowReport[], seen: number): ImportCounts {
  return {
    seen,
    created: rows.filter((row) => row.outcome === "created").length,
    updated: rows.filter((row) => row.outcome === "updated").length,
    unchanged: rows.filter((row) => row.outcome === "unchanged").length,
    rejected: rows.filter((row) => row.outcome === "rejected").length,
    warned: rows.filter((row) => row.issues.some((entry) => entry.severity === "warning")).length,
  };
}

/**
 * The batch's own status. `failed` is the whole file being refused; `succeeded_with_issues`
 * covers both kinds of issue — rows that carried a warning, and columns the platform has no
 * home for. The two are counted separately (a column notice is not a row) but they are the
 * same answer to "did this file go in entirely cleanly".
 */
function statusFor(
  counts: ImportCounts,
  refused: boolean,
  fileWarnings = false
): BatchSeed["status"] {
  if (refused) return "failed";
  if (counts.rejected > 0 || counts.warned > 0 || fileWarnings) return "succeeded_with_issues";
  return "succeeded";
}

/** The capability gap, as a report row that names the capability (§3 rule 2). */
function capabilityIssues(plan: ArticleWritePlan): ImportIssue[] {
  return plan.missingCapabilities.map((permission) =>
    issue("code", "mdm.import.error.capability", { permission }, "error")
  );
}

/** Everything the plan implies, said out loud rather than left for the operator to infer. */
function planWarnings(plan: ArticleWritePlan): ImportIssue[] {
  const warnings: ImportIssue[] = [];
  for (const field of plan.gaps) {
    // §6: a record missing a field its market requires cannot reach `active`. That is the
    // compliance gate working — a warning here, and the landing state carries the consequence.
    warnings.push(
      issue("code", "validation.requiredForJurisdiction", { field, state: plan.landing }, "warning")
    );
  }
  for (const field of plan.defaulted) {
    warnings.push(issue(field, "validation.defaulted", { field, value: "—" }, "warning"));
  }
  if (plan.existing && plan.outcome === "updated" && plan.contentChanged.length > 0) {
    warnings.push(
      issue("code", "mdm.import.warning.updatesExisting", { fields: plan.contentChanged.join(", ") }, "warning")
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// The screen's own door
// ---------------------------------------------------------------------------
/**
 * The capability the *screen* needs, resolved on the server before the screen renders — the
 * same way the vendor and site master screens do it, through their loaders.
 *
 * The bulk import screen offers two writes and no read, so there was nothing for its loader to
 * ask for and it rendered its file picker to every caller, including one whose every button the
 * API refuses with 403 on this exact capability. A control that cannot work misstates the
 * caller's authority, and not saying it is the screen's job.
 *
 * It is the same `guard` call — same capability, same chain scope — that the dry run and the
 * commit make, so the screen cannot drift from the domain: nobody reaches the picker who could
 * not also run the import, and the refusal is recorded in `audit_log` with its reason, because
 * `guard` writes a row for a denial. An allowed call writes nothing: opening a screen is not an
 * act on master data and does not belong in the trail as one.
 */
export async function importScreenAccess(principal: Principal): Promise<void> {
  await guard({
    principal,
    action: "mdm.article.import",
    entityType: "import_batch",
    chainId: principal.chainId ?? null,
    target: "the bulk import screen",
    source: "screen",
    intent: "open the bulk import screen",
  });
}
// ---------------------------------------------------------------------------
// Phase 1 — the dry run
// ---------------------------------------------------------------------------
/**
 * Validates the file and reports what it would do. **Writes no master data at all**: the
 * only rows it creates are its own batch and report rows, so the report survives the session
 * and "what did you see before you committed" is answerable later.
 */
export async function dryRunImport(principal: Principal, request: ImportRequest): Promise<ImportReport> {
  const content = request.content ?? "";
  const fileHash = createHash("sha256").update(content).digest("hex");
  const parsed = readFile(content);
  const chainId = principal.chainId ?? null;

  await guard({
    principal,
    action: "mdm.article.import",
    entityType: "import_batch",
    chainId,
    target: `file ${request.fileName}`,
    source: "import",
  });

  const rows: ImportRowReport[] = [];
  if (parsed.fileError) {
    return storeReport(principal, {
      entity: request.entity,
      phase: "dry_run",
      fileName: request.fileName,
      content,
      fileHash,
      columns: parsed.columns,
      fileError: parsed.fileError,
      columnWarnings: parsed.columnWarnings,
      rows,
      applied: false,
      seen: parsed.table.rows.length,
    });
  }

  const db = poolQueryable();
  const seen = new Set<string>();
  for (const record of parsed.table.rows) {
    const report = await planRow(db, principal, chainId, parsed, record, seen);
    rows.push(report);
  }

  return storeReport(principal, {
    entity: request.entity,
    phase: "dry_run",
    fileName: request.fileName,
    content,
    fileHash,
    columns: parsed.columns,
    fileError: null,
    columnWarnings: parsed.columnWarnings,
    rows,
    applied: false,
    seen: parsed.table.rows.length,
  });
}

/** One row, planned and nothing else. Shared by the dry run and the commit's pre-flight. */
async function planRow(
  tx: Queryable,
  principal: Principal,
  chainId: string | null,
  parsed: ParsedFile,
  record: { lineNumber: number; cells: string[] },
  seen: Set<string>
): Promise<ImportRowReport> {
  const parsedRow = parseArticleRow(parsed, record.cells);
  const issues = [...parsedRow.issues];
  if (!parsedRow.input) {
    return {
      lineNumber: record.lineNumber,
      code: parsedRow.code,
      outcome: "rejected",
      entityId: null,
      landing: null,
      changed: [],
      issues,
    };
  }
  if (!chainId) {
    issues.push(issue("file", "mdm.import.error.noChain", {}, "error"));
    return {
      lineNumber: record.lineNumber,
      code: parsedRow.code,
      outcome: "rejected",
      entityId: null,
      landing: null,
      changed: [],
      issues,
    };
  }

  const key = parsedRow.input.code.trim().toLowerCase();
  if (seen.has(key)) {
    // Two rows, one business key: the file contradicts itself, and §16 item 1 makes the code
    // the identity, so this is an error rather than "last one wins".
    issues.push(issue("code", "validation.duplicateCode", { code: parsedRow.input.code }, "error"));
    return {
      lineNumber: record.lineNumber,
      code: parsedRow.input.code,
      outcome: "rejected",
      entityId: null,
      landing: null,
      changed: [],
      issues,
    };
  }
  seen.add(key);

  let plan: ArticleWritePlan;
  try {
    plan = await planArticleWrite(tx, principal, chainId, parsedRow.input);
  } catch (error) {
    return {
      lineNumber: record.lineNumber,
      code: parsedRow.input.code,
      outcome: "rejected",
      entityId: null,
      landing: null,
      changed: [],
      issues: [...issues, ...issuesFrom(error)],
    };
  }

  const refusals = capabilityIssues(plan);
  // A version under review is frozen, and the write path refuses an edit of it. Planned
  // here as the same refusal rather than discovered at commit time: a commit that throws on
  // row 400 rejects the whole file, so a dry run that called this row `updated` would have
  // promised an import that cannot run.
  const locked: ImportIssue[] = plan.lockedUnderReview
    ? [issue("status", "validation.articleVersionLocked", {}, "error")]
    : [];
  // A version waiting for a decision refuses a content row too (slab 3c-2), and for a
  // different reason: the open version was cloned from the one this row edits, so the edit
  // would leave the proposal carrying content it was never cloned with. The commit raises
  // exactly this code, so the dry run has to say it as well — a plan that called the row
  // `updated` was promising an import whose every row would be refused.
  const openIssue: ImportIssue[] = plan.articleOpen
    ? [
        issue("status", "validation.review.articleOpen", { version: plan.openVersion ?? 0 }, "error"),
      ]
    : [];
  issues.push(...locked, ...openIssue, ...planWarnings(plan));
  if (refusals.length > 0 || locked.length > 0 || openIssue.length > 0) {
    return {
      lineNumber: record.lineNumber,
      code: parsedRow.input.code,
      outcome: "rejected",
      entityId: null,
      landing: plan.existingStatus,
      changed: [],
      issues: [...issues, ...refusals],
    };
  }

  return {
    lineNumber: record.lineNumber,
    code: parsedRow.input.code,
    outcome: plan.outcome,
    entityId: null,
    // What the record holds (an existing one) or what a create would land as — never the
    // landing state of a create quoted at an existing record.
    landing: plan.existing ? plan.existingStatus : plan.landing,
    changed: [...plan.contentChanged, ...plan.priceChanges.map((change) => `price:${change.outletCode}`)],
    issues,
  };
}

/**
 * A thrown domain error, as a report row.
 *
 * A coded `ValidationError` names its message and its column; anything else (a permission
 * denial, a unique-constraint race) is reported with the capability or the server's own
 * answer rather than a guessed one — the rule the screens already follow.
 */
function issuesFrom(error: unknown): ImportIssue[] {
  if (isHttpError(error)) {
    const details = error.details ?? {};
    const code = typeof details.code === "string" ? details.code : null;
    if (code) {
      const params = (details.params ?? {}) as Record<string, string | number>;
      return [issue(typeof details.column === "string" ? details.column : "code", code, params)];
    }
    if (typeof details.action === "string") {
      return [
        issue("code", "mdm.import.error.capability", { permission: details.action }, "error"),
      ];
    }
    return [issue("code", "mdm.import.error.refused", { message: error.message }, "error")];
  }
  return [issue("code", "mdm.import.error.failed", {}, "error")];
}

/** Stores the report and returns it. The batch row is the report's home. */
async function storeReport(
  principal: Principal,
  input: {
    entity: string;
    phase: "dry_run" | "commit";
    fileName: string;
    content: string;
    fileHash: string;
    columns: string[];
    fileError: ImportIssue | null;
    columnWarnings: ImportIssue[];
    rows: ImportRowReport[];
    applied: boolean;
    /** Rows present in the file, which is not the same as rows planned when the file itself
     *  was refused before any row was looked at. */
    seen: number;
  }
): Promise<ImportReport> {
  const chainId = principal.chainId ?? null;
  const batchId = randomUUID();
  // `warned` counts **rows** that carried a warning, and nothing else: it is read next to
  // `seen` / `created` / `updated` and the screen renders it as "{count} with warnings", so
  // folding the file-level column notice into it made the row arithmetic incoherent (one
  // unmapped column turned three warned rows into four). The column notice gets its own
  // section on the screen and its own influence on the status.
  const counts: ImportCounts = countRows(input.rows, input.seen);
  const fileWarnings = input.columnWarnings.length > 0;
  const seed: BatchSeed | null = chainId
    ? {
        id: batchId,
        chainId,
        actorUserId: principal.userId,
        entity: input.entity,
        phase: input.phase,
        fileName: input.fileName,
        fileBytes: Buffer.byteLength(input.content, "utf8"),
        fileHash: input.fileHash,
        columns: input.columns,
        counts,
        status: statusFor(counts, Boolean(input.fileError), fileWarnings),
        fileError: input.fileError,
      }
    : null;

  if (seed) {
    await withTransaction(async (tx) => {
      await insertBatch(tx, seed);
      await insertRows(tx, seed.id, seed.chainId, input.rows);
      await writeBatchAudit(
        tx,
        principal,
        seed,
        input.fileError ? "error" : "success",
        input.fileError ? input.fileError.code : null
      );
    });
  }

  return {
    batchId,
    entity: input.entity,
    phase: input.phase,
    fileName: input.fileName,
    fileHash: input.fileHash,
    columns: input.columns,
    status: statusFor(counts, Boolean(input.fileError), fileWarnings),
    fileError: input.fileError,
    columnWarnings: input.columnWarnings,
    counts,
    rows: input.rows,
    applied: input.applied && !input.fileError,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — the commit
// ---------------------------------------------------------------------------
/**
 * Applies the file. **All of it or none of it**: every row's writes join one transaction, and
 * a single failure rolls the file back. A file with any invalid row is refused before
 * anything is written (see the deviation note at the top).
 *
 * The per-row audit rows are written inside that transaction by the same domain functions a
 * hand edit calls, each carrying the batch id and `source: import`; the batch's own row is
 * written after it commits, because a refused commit must still leave a trace.
 */
export async function commitImport(principal: Principal, request: ImportRequest): Promise<ImportReport> {
  const content = request.content ?? "";
  const fileHash = createHash("sha256").update(content).digest("hex");
  const parsed = readFile(content);
  const chainId = principal.chainId ?? null;

  await guard({
    principal,
    action: "mdm.article.import",
    entityType: "import_batch",
    chainId,
    target: `file ${request.fileName}`,
    source: "import",
  });

  // Pre-flight: the same plan the dry run produces, so a commit cannot be the first time a
  // row is looked at.
  const rows: ImportRowReport[] = [];
  if (!parsed.fileError && chainId) {
    const db = poolQueryable();
    const seen = new Set<string>();
    for (const record of parsed.table.rows) {
      rows.push(await planRow(db, principal, chainId, parsed, record, seen));
    }
  }

  const blocking = parsed.fileError
    ? parsed.fileError
    : rows.some((row) => row.issues.some((entry) => entry.severity === "error"))
      ? issue("file", "mdm.import.error.fileHasErrors", {}, "error")
      : null;

  if (blocking) {
    // Nothing is written — and the refusal is recorded, with the same row report the dry run
    // would have shown, so the operator can fix the file and re-run.
    return storeReport(principal, {
      entity: request.entity,
      phase: "commit",
      fileName: request.fileName,
      content,
      fileHash,
      columns: parsed.columns,
      fileError: blocking,
      columnWarnings: parsed.columnWarnings,
      rows,
      applied: false,
      seen: parsed.table.rows.length,
    });
  }

  const batchId = randomUUID();
  const applied: ImportRowReport[] = [];
  const state: { failure: ImportIssue[] | null } = { failure: null };

  try {
    await withTransaction(async (tx) => {
      for (const record of parsed.table.rows) {
        const parsedRow = parseArticleRow(parsed, record.cells);
        if (!parsedRow.input) {
          // Unreachable after pre-flight; kept so a plan/commit disagreement is loud.
          throw new ValidationError("a row that failed pre-flight reached the commit");
        }
        try {
          applied.push(
            await applyRow(tx, principal, chainId as string, parsedRow, record.lineNumber, batchId)
          );
        } catch (error) {
          // The row's line number travels with the failure so the report can name it, even
          // though the transaction is about to take the whole file down.
          state.failure = issuesFrom(error);
          throw error;
        }
      }
      const counts = countRows(applied, parsed.table.rows.length);
      const seed: BatchSeed = {
        id: batchId,
        chainId: chainId as string,
        actorUserId: principal.userId,
        entity: request.entity,
        phase: "commit",
        fileName: request.fileName,
        fileBytes: Buffer.byteLength(content, "utf8"),
        fileHash,
        columns: parsed.columns,
        counts,
        status: statusFor(counts, false, parsed.columnWarnings.length > 0),
        fileError: null,
      };
      // The batch row and its audit row commit *with* the data they describe: a batch that
      // claims to have applied rows that rolled back would be worse than no batch row.
      await insertBatch(tx, seed);
      await insertRows(tx, batchId, chainId as string, applied);
      await writeBatchAudit(tx, principal, seed, "success", null);
    });
  } catch (error) {
    const fileError =
      state.failure?.[0] ?? issue("file", "mdm.import.error.failed", {}, "error");
    const seed: BatchSeed = {
      id: randomUUID(),
      chainId: chainId as string,
      actorUserId: principal.userId,
      entity: request.entity,
      phase: "commit",
      fileName: request.fileName,
      fileBytes: Buffer.byteLength(content, "utf8"),
      fileHash,
      columns: parsed.columns,
      counts: { seen: parsed.table.rows.length, created: 0, updated: 0, unchanged: 0, rejected: parsed.table.rows.length, warned: 0 },
      status: "failed",
      fileError,
    };
    await withTransaction(async (tx) => {
      await insertBatch(tx, seed);
      await insertRows(
        tx,
        seed.id,
        seed.chainId,
        applied.map((row) => ({ ...row, outcome: "rejected" as ImportRowOutcome }))
      );
      await writeBatchAudit(tx, principal, seed, "error", fileError.code);
    });
    // A rolled-back file leaves nothing behind but its own report: no half-imported chain.
    return {
      batchId: seed.id,
      entity: request.entity,
      phase: "commit",
      fileName: request.fileName,
      fileHash,
      columns: parsed.columns,
      status: "failed",
      fileError,
      columnWarnings: parsed.columnWarnings,
      counts: seed.counts,
      rows: applied.map((row) => ({ ...row, outcome: "rejected" as ImportRowOutcome })),
      applied: false,
    };
  }

  const counts = countRows(applied, parsed.table.rows.length);
  return {
    batchId,
    entity: request.entity,
    phase: "commit",
    fileName: request.fileName,
    fileHash,
    columns: parsed.columns,
    status: statusFor(counts, false, parsed.columnWarnings.length > 0),
    fileError: null,
    columnWarnings: parsed.columnWarnings,
    counts,
    rows: applied,
    applied: true,
  };
}

/**
 * One row, applied — through the domain functions and nothing else.
 *
 * A record that already matches comes back `unchanged` having written nothing, which is the
 * idempotency §23.3 asks for: feeding the same file twice produces a second report of
 * `unchanged` rows, zero new records and no second audit row for a record that did not change.
 */
async function applyRow(
  tx: Queryable,
  principal: Principal,
  chainId: string,
  parsedRow: ParsedRow,
  lineNumber: number,
  batchId: string
): Promise<ImportRowReport> {
  const input = parsedRow.input as ArticleWriteInput;
  const meta = { source: "import" as const, batchId, tx };
  const plan = await planArticleWrite(tx, principal, chainId, input);
  const changed: string[] = [];
  let outcome: ImportRowOutcome = "unchanged";
  let entityId: string | null = plan.existingId;
  // The landing state the *write* produced, not the one the plan predicted. The plan's
  // answer is what the dry run showed; this is what the commit did, and the two are only
  // the same because both call `landingStatus` — see `createArticle`. Echoing the plan
  // here would have made the two reports agree by construction and proven nothing.
  //
  // An existing record is never described by a create's landing state: it already holds one,
  // and `landingStatus` is a statement about a record being born. This reports that state,
  // and the writes below replace it with what they actually wrote. A row that writes nothing
  // therefore reports nothing that "landed" — an existing record's own status, which is a
  // fact, rather than a prediction about it.
  let landing: string | null = plan.existing ? plan.existingStatus : null;

  if (!plan.existing) {
    const created = await createArticle(principal, input, meta);
    entityId = created.id;
    outcome = "created";
    landing = created.status;
    changed.push("article", "version", "prices");
  } else {
    if (plan.contentChanged.length > 0) {
      const updated = await updateArticle(principal, input, meta);
      entityId = updated.id;
      landing = updated.status;
      changed.push(...updated.changed);
      if (updated.outcome === "updated") outcome = "updated";
    }
    // Prices last, and only where the file's value differs from the open window: re-running
    // the same file must not close and reopen a window that has not changed (§23.3).
    for (const price of plan.priceChanges) {
      const result = await updateArticlePrice(
        principal,
        {
          code: input.code,
          outletCode: price.outletCode,
          amount: price.amount,
          currencyCode: price.currencyCode,
          effectiveFrom: price.effectiveFrom,
        },
        meta
      );
      if (outcome === "unchanged") outcome = "updated";
      changed.push(`price:${result.outletCode}`);
    }
  }

  return {
    lineNumber,
    code: input.code,
    outcome,
    entityId,
    landing,
    changed,
    // The warnings the plan produced travel with the row into the committed report, exactly
    // as the dry run showed them. Without this the commit report said `succeeded` and listed
    // nothing while the dry run of the same file had said "this row updates an existing
    // record" / "this value was defaulted" — two reports of the same file disagreeing.
    issues: planWarnings(plan),
  };
}
